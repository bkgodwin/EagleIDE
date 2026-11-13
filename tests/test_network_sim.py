import copy
import base64
import io
import json
import math
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from flask import Flask
from PIL import Image

from network_content import ACRONYM_REFERENCE, COMMAND_REFERENCE, DEVICE_PORTS, EXAMPLE_TOPOLOGIES, LABS, PORT_REFERENCE
from network_features import register
from network_store import MAX_DEVICES, WIFI_SCHEMA_VERSION, NetworkDataError, NetworkStore, _stp_state, can_reach, can_reach_ipv6, grade_lab, migrate_topology, validate_topology, validate_wifi_site
from wifi_scenarios import SCENARIOS


class NetworkStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = NetworkStore(Path(self.temp.name) / "network")

    def tearDown(self):
        self.temp.cleanup()

    def test_builtin_topologies_validate(self):
        for topology in EXAMPLE_TOPOLOGIES.values():
            self.assertEqual(validate_topology(topology)["schema_version"], 2)
        for lab in LABS.values():
            self.assertEqual(validate_topology(lab["starter_topology"])["schema_version"], 2)

    def test_community_center_starter_preserves_scale_and_is_open_for_design(self):
        site = validate_wifi_site(SCENARIOS["port-adelaide-community-center"]["site"])
        gym = next(wall for wall in site["walls"] if wall["id"] == "gym-north")
        self.assertAlmostEqual(math.dist(tuple(gym["a"].values()), tuple(gym["b"].values())), 38.3, places=3)
        self.assertEqual(gym["material"], "concrete")
        self.assertEqual(site["units"], "m")
        self.assertEqual(site["access_points"], [])
        self.assertEqual(site["cables"], [])
        self.assertEqual(site["equipment"], [])
        self.assertGreaterEqual(sum(wall['material'] == 'reinforced_concrete' for wall in site['walls']), 4)
        self.assertTrue({'car', 'tree', 'lamp', 'desk', 'chair'}.issubset(item['kind'] for item in site['decor']))
        self.assertTrue({'floor', 'sidewalk', 'pavement'}.issubset(item['kind'] for item in site['surfaces']))
        self.assertEqual({item["kind"] for item in site["openings"]}, {"door", "window"})
        self.assertTrue({"Gymnasium / events", "Foyer", "Access WC", "Activity room", "Side awning"}
                        .issubset(item["text"] for item in site["labels"]))

    @unittest.skipUnless(shutil.which("node"), "Node.js is required to load the Infra Sim example")
    def test_infra_campus_example_can_be_saved_and_all_aps_are_wired(self):
        root = Path(__file__).resolve().parents[1]
        script = """
          global.window = global;
          require('./static/js/wifi-site-example.js');
          process.stdout.write(JSON.stringify(wifiCampusExample({schema_version: 4, units: 'm', band: '5'})));
        """
        raw = json.loads(subprocess.check_output(["node", "-e", script], cwd=root, timeout=10))
        site = validate_wifi_site(raw)
        ethernet_ends = {cable[end]["device_id"] for cable in site["cables"] if cable["media"] == "ethernet"
                         for end in ("source", "target")}
        self.assertGreaterEqual(len(site["access_points"]), 12)
        self.assertTrue(all(ap["id"] in ethernet_ends for ap in site["access_points"]))
        self.assertTrue(all(closet in {wall["id"] for wall in site["walls"]}
                            for closet in ("west-idf-top", "east-idf-top", "annex-idf-top")))
        self.assertTrue(any(ap["y"] < 0 for ap in site["access_points"]))
        self.assertEqual({item["kind"] for item in site["surfaces"]}, {"floor", "sidewalk", "pavement", "landscape"})
        self.assertTrue({"desk", "chair", "tree", "parking_bay"}.issubset(item["kind"] for item in site["decor"]))
        self.assertTrue({"desktop", "phone"}.issubset(item["kind"] for item in site["equipment"]))
        self.assertTrue(all(item["id"] in ethernet_ends for item in site["equipment"] if item["kind"] == "desktop"))
        self.assertTrue(all(item["id"] not in ethernet_ends for item in site["equipment"] if item["kind"] == "phone"))
        for ap in site["access_points"]:
            if ap["mount"] == "wall":
                wall = next(wall for wall in site["walls"] if wall["id"] == ap["wall_id"])
                for axis in ("x", "y"):
                    self.assertAlmostEqual(ap[axis], wall["a"][axis] + ap["t"] * (wall["b"][axis] - wall["a"][axis]), places=4)

    def test_anchored_ap_follows_edited_wall_and_legacy_position_remains_valid(self):
        plan = {"schema_version": 5, "title": "Anchors", "units": "m", "band": "5",
                "walls": [{"id": "wall", "a": {"x": 2, "y": 7}, "b": {"x": 10, "y": 7}, "material": "drywall"}],
                "access_points": [
                    {"id": "anchored", "name": "", "mount": "wall", "x": 1, "y": 1, "angle": 0, "wall_id": "wall", "t": .5},
                    {"id": "legacy", "name": "", "mount": "wall", "x": 3, "y": 4, "angle": 90},
                ], "labels": []}
        anchored, legacy = validate_wifi_site(plan)["access_points"]
        self.assertEqual((anchored["x"], anchored["y"]), (6, 7))
        self.assertEqual((legacy["x"], legacy["y"]), (3, 4))
        plan["access_points"][0]["wall_id"] = "missing"
        with self.assertRaisesRegex(NetworkDataError, "require a wall"):
            validate_wifi_site(plan)

    def test_v1_migration_and_physical_media_rules(self):
        legacy = copy.deepcopy(EXAMPLE_TOPOLOGIES["simple-lan"])
        legacy["schema_version"] = 1
        migrated = migrate_topology(legacy)
        self.assertEqual(migrated["schema_version"], 2)
        self.assertIn("simulation", migrated["metadata"])
        switch = next(item for item in migrated["devices"] if item["id"] == "sw1")
        self.assertTrue(switch["config"]["stp_enabled"])

        redundant = validate_topology(EXAMPLE_TOPOLOGIES["redundant-stp-campus"])
        parallel = [item for item in redundant["links"] if {item["source"], item["target"]} == {"sw1", "sw2"}]
        self.assertEqual(len(parallel), 2)
        self.assertTrue(all(item["kind"] == "fiber" for item in parallel))
        incompatible = copy.deepcopy(EXAMPLE_TOPOLOGIES["simple-lan"])
        incompatible["schema_version"] = 2
        incompatible["links"][0]["kind"] = "fiber"
        with self.assertRaises(NetworkDataError):
            validate_topology(incompatible)

        future = copy.deepcopy(EXAMPLE_TOPOLOGIES["simple-lan"])
        future["schema_version"] = 99
        with self.assertRaisesRegex(NetworkDataError, "newer"):
            validate_topology(future)

    def test_new_advanced_lab_objectives_grade_server_side(self):
        stp = copy.deepcopy(LABS["lab-10-redundant-switching"]["starter_topology"])
        for device in stp["devices"]:
            if device["id"] == "sw1":
                device["config"].update(stp_enabled=True, stp_priority=24576)
            elif device["id"] == "sw2":
                device["config"]["stp_enabled"] = True
        self.assertTrue(grade_lab("lab-10-redundant-switching", stp)["passed"])

        ospf = copy.deepcopy(LABS["lab-11-ospf-campus"]["starter_topology"])
        self.assertFalse(can_reach(ospf, "pc1", "srv1"))
        ospf_devices = {item["id"]: item for item in ospf["devices"]}
        for router_id, value in (("r1", "1.1.1.1"), ("r2", "2.2.2.2"), ("r3", "3.3.3.3")):
            ospf_devices[router_id]["config"].update(routing_protocol="ospf", router_id=value)
        self.assertTrue(can_reach(ospf, "pc1", "srv1"))
        self.assertTrue(grade_lab("lab-11-ospf-campus", ospf)["passed"])

        ipv6 = copy.deepcopy(LABS["lab-12-dual-stack"]["starter_topology"])
        devices = {item["id"]: item for item in ipv6["devices"]}
        devices["pc1"]["config"].update(ipv6_mode="static", ipv6_address="2001:db8:6::20", ipv6_prefix=64, ipv6_gateway="2001:db8:6::1")
        devices["srv1"]["config"].update(ipv6_mode="static", ipv6_address="2001:db8:7::10", ipv6_prefix=64, ipv6_gateway="2001:db8:7::1")
        self.assertTrue(can_reach_ipv6(validate_topology(ipv6), "pc1", "srv1"))
        self.assertTrue(grade_lab("lab-12-dual-stack", ipv6)["passed"])
        devices["srv1"]["config"]["ipv6_gateway"] = ""
        self.assertFalse(can_reach_ipv6(validate_topology(ipv6), "pc1", "srv1"))

        cyber = copy.deepcopy(LABS["lab-15-traffic-analysis"]["starter_topology"])
        cyber["metadata"]["simulation"]["completed_profiles"] = ["startup", "arp-spoof"]
        self.assertTrue(grade_lab("lab-15-traffic-analysis", cyber)["passed"])

    def test_dhcp_example_and_command_reference_include_full_client_workflow(self):
        topology = EXAMPLE_TOPOLOGIES["dhcp-office"]
        devices = {item["id"]: item for item in topology["devices"]}
        router = devices["r1"]["config"]
        self.assertTrue(router["dhcp_enabled"])
        self.assertEqual(router["dhcp_gateway"], "172.16.5.1")
        self.assertEqual(router["dhcp_dns_primary"], "172.16.5.1")
        self.assertEqual(router["dhcp_dns_secondary"], "1.1.1.1")
        self.assertEqual(devices["pc1"]["config"]["addressing_mode"], "dhcp")
        commands = {item["command"] for item in COMMAND_REFERENCE}
        self.assertTrue({"dhcp request", "dhcp release", "show dhcp", "show ports", "wan dhcp", "nslookup <domain>", "http get <domain>", "show acl"}.issubset(commands))
        self.assertTrue({"22", "53", "67", "68", "80", "443"}.issubset({item["port"] for item in PORT_REFERENCE}))
        self.assertTrue({"ACL", "DHCP", "DNS", "ICMP", "TCP", "UDP", "VLAN", "WAP"}.issubset({item["term"] for item in ACRONYM_REFERENCE}))

    def test_wireless_reachability_requires_a_powered_authenticated_client(self):
        topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["wireless-campus"])
        self.assertTrue(can_reach(topology, "laptop1", "srv1"))
        laptop = next(item for item in topology["devices"] if item["id"] == "laptop1")
        laptop["config"]["wifi_password"] = "wrong-password"
        self.assertFalse(can_reach(topology, "laptop1", "srv1"))
        laptop["config"]["wifi_password"] = "learn-networking"
        laptop["config"]["enabled"] = False
        self.assertFalse(can_reach(topology, "laptop1", "srv1"))

    def test_rejects_oversized_and_dangling_topologies(self):
        raw = copy.deepcopy(EXAMPLE_TOPOLOGIES["simple-lan"])
        raw["devices"] = [copy.deepcopy(raw["devices"][0]) for _ in range(MAX_DEVICES + 1)]
        with self.assertRaises(NetworkDataError):
            validate_topology(raw)
        raw = copy.deepcopy(EXAMPLE_TOPOLOGIES["simple-lan"])
        raw["links"][0]["target"] = "missing"
        with self.assertRaises(NetworkDataError):
            validate_topology(raw)

    def test_physical_ports_are_finite_unique_and_affect_link_state(self):
        raw = copy.deepcopy(EXAMPLE_TOPOLOGIES["simple-lan"])
        validated = validate_topology(raw)
        used = {}
        for link in validated["links"]:
            for device_id, field in ((link["source"], "source_port"), (link["target"], "target_port")):
                self.assertNotIn(link[field], used.setdefault(device_id, set()))
                used[device_id].add(link[field])
        self.assertEqual(DEVICE_PORTS["pc"], ("LAN1",))
        self.assertEqual(len(DEVICE_PORTS["switch"]), 8)
        self.assertEqual(DEVICE_PORTS["switch"], DEVICE_PORTS["l3switch"])
        raw["links"].append({"id": "extra", "source": "pc1", "target": "srv1", "source_port": "LAN1", "target_port": "LAN2", "kind": "ethernet"})
        with self.assertRaisesRegex(NetworkDataError, "more than one cable"):
            validate_topology(raw)

        raw = copy.deepcopy(EXAMPLE_TOPOLOGIES["simple-lan"])
        next(item for item in raw["devices"] if item["id"] == "pc1")["config"]["ports"] = {"LAN1": {"enabled": False}}
        self.assertFalse(can_reach(validate_topology(raw), "pc1", "srv1"))

    def test_stp_does_not_treat_a_router_as_a_layer2_bridge(self):
        topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["redundant-stp-campus"])
        topology["devices"].append({"id": "r1", "type": "router", "name": "Router", "x": 420, "y": 260, "config": {"enabled": True}})
        topology["links"] = [
            {"id": "a-router-left", "source": "sw1", "target": "r1", "source_port": "Eth1", "target_port": "LAN1", "kind": "ethernet"},
            {"id": "b-router-right", "source": "r1", "target": "sw2", "source_port": "LAN2", "target_port": "Eth1", "kind": "ethernet"},
            {"id": "z-switch-link", "source": "sw1", "target": "sw2", "source_port": "Eth7", "target_port": "Eth7", "kind": "fiber"},
        ]
        blocked, loop_risk = _stp_state(validate_topology(topology))
        self.assertEqual(blocked, set())
        self.assertEqual(loop_risk, set())

    def test_dns_web_example_contains_delegation_http_and_wan_dhcp(self):
        topology = validate_topology(EXAMPLE_TOPOLOGIES["dns-web-journey"])
        devices = {item["id"]: item for item in topology["devices"]}
        self.assertEqual(devices["pc1"]["config"]["dns_servers"], ["10.20.0.53"])
        self.assertEqual(devices["dns1"]["config"]["dns_records"][0]["type"], "NS")
        self.assertEqual(devices["dns2"]["config"]["dns_records"][0]["value"], "10.20.0.80")
        self.assertIn("http", devices["web1"]["config"]["services"])
        self.assertEqual(devices["r1"]["config"]["wan_mode"], "dhcp")
        self.assertTrue(devices["isp1"]["config"]["isp_dhcp_enabled"])

    def test_examples_include_guided_tasks_and_layer3_acl_demo(self):
        self.assertTrue(all(item.get("objectives") for item in EXAMPLE_TOPOLOGIES.values()))
        topology = EXAMPLE_TOPOLOGIES["vlan-classroom"]
        switch = next(item for item in topology["devices"] if item["id"] == "sw1")
        self.assertEqual(switch["type"], "l3switch")
        self.assertEqual({item["vlan"] for item in switch["config"]["svis"]}, {20, 30})
        self.assertEqual(switch["config"]["port_vlans"], {"Eth1": 20, "Eth2": 30})
        self.assertEqual(switch["config"]["acl_rules"][0]["interface"], "VLAN20")

    def test_saved_topologies_are_isolated_by_account(self):
        saved = self.store.save_topology("first@example.com", EXAMPLE_TOPOLOGIES["simple-lan"], "mine")
        self.assertEqual(saved["id"], "mine")
        self.assertIsNotNone(self.store.get_topology("first@example.com", "mine"))
        self.assertIsNone(self.store.get_topology("second@example.com", "mine"))

    def test_completed_lab_grades_all_objectives(self):
        topology = copy.deepcopy(LABS["lab-01-connected-lan"]["starter_topology"])
        topology["links"] = [
            {"id": "l1", "source": "pc1", "target": "sw1", "source_port": "LAN1", "target_port": "Eth1", "kind": "ethernet"},
            {"id": "l2", "source": "srv1", "target": "sw1", "source_port": "LAN1", "target_port": "Eth2", "kind": "ethernet"},
        ]
        devices = {item["id"]: item for item in topology["devices"]}
        devices["pc1"]["config"].update(ip="192.168.10.20", mask="255.255.255.0")
        devices["srv1"]["config"].update(ip="192.168.10.10", mask="255.255.255.0")
        result = grade_lab("lab-01-connected-lan", topology)
        self.assertTrue(result["passed"])
        self.assertEqual(result["percent"], 100)

    def test_every_builtin_lab_has_a_reachable_full_solution(self):
        routed = copy.deepcopy(LABS["lab-02-route-networks"]["starter_topology"])
        devices = {item["id"]: item for item in routed["devices"]}
        devices["r1"]["config"]["interfaces"] = [
            {"name": "lan1", "ip": "10.10.1.1", "mask": "255.255.255.0"},
            {"name": "lan2", "ip": "10.10.2.1", "mask": "255.255.255.0"},
        ]
        devices["pc1"]["config"].update(ip="10.10.1.20", mask="255.255.255.0", gateway="10.10.1.1")
        devices["srv1"]["config"].update(ip="10.10.2.10", mask="255.255.255.0", gateway="10.10.2.1")
        self.assertTrue(grade_lab("lab-02-route-networks", routed)["passed"])

        secure = copy.deepcopy(LABS["lab-03-secure-web"]["starter_topology"])
        devices = {item["id"]: item for item in secure["devices"]}
        devices["srv1"]["config"].update(ip="192.0.2.10", mask="255.255.255.0", gateway="192.0.2.1", services=["https"])
        devices["fw1"]["config"]["firewall_rules"] = [
            {"action": "allow", "protocol": "tcp", "port": 443},
            {"action": "deny", "protocol": "tcp", "port": 22},
        ]
        self.assertTrue(grade_lab("lab-03-secure-web", secure)["passed"])
        self.assertFalse(can_reach(secure, "client1", "srv1", "icmp"))
        devices["fw1"]["config"]["firewall_rules"].insert(0, {"action": "allow", "protocol": "icmp", "port": -1})
        self.assertTrue(can_reach(secure, "client1", "srv1", "icmp"))
        devices["fw1"]["config"]["firewall_rules"] = [
            {"action": "deny", "protocol": "tcp", "port": 443},
            {"action": "allow", "protocol": "tcp", "port": 443},
        ]
        self.assertFalse(can_reach(secure, "client1", "srv1", "tcp", 443))
        devices["fw1"]["config"]["firewall_rules"].reverse()
        self.assertTrue(can_reach(secure, "client1", "srv1", "tcp", 443))

        dhcp = copy.deepcopy(LABS["lab-04-dhcp-workstation"]["starter_topology"])
        devices = {item["id"]: item for item in dhcp["devices"]}
        devices["r1"]["config"].update(dhcp_enabled=True, dhcp_interface="LAN1", dhcp_start="192.168.50.100", dhcp_end="192.168.50.150", dhcp_dns_primary="192.168.50.1", dhcp_dns_secondary="1.1.1.1")
        devices["pc1"]["config"].update(addressing_mode="dhcp", dhcp_state="bound", ip="192.168.50.100", mask="255.255.255.0", gateway="192.168.50.1")
        self.assertTrue(grade_lab("lab-04-dhcp-workstation", dhcp)["passed"])

        vlans = copy.deepcopy(LABS["lab-05-build-vlans"]["starter_topology"])
        devices = {item["id"]: item for item in vlans["devices"]}
        devices["sw1"]["config"].update(vlans=[20, 30], port_vlans={"Eth1": 20, "Eth2": 30})
        devices["pc1"]["config"]["vlan"] = 20
        devices["laptop1"]["config"]["vlan"] = 30
        self.assertTrue(grade_lab("lab-05-build-vlans", vlans)["passed"])

        dns = copy.deepcopy(LABS["lab-06-hierarchical-dns"]["starter_topology"])
        devices = {item["id"]: item for item in dns["devices"]}
        devices["pc1"]["config"]["dns_servers"] = ["10.60.0.53"]
        devices["dns1"]["config"]["dns_records"] = [{"name": "school.test", "type": "NS", "value": "10.60.0.54"}]
        devices["dns2"]["config"]["dns_records"] = [{"name": "www.school.test", "type": "A", "value": "10.60.0.80"}]
        devices["web1"]["config"]["services"] = ["http"]
        self.assertTrue(grade_lab("lab-06-hierarchical-dns", dns)["passed"])

        wan = copy.deepcopy(LABS["lab-07-wan-nat"]["starter_topology"])
        devices = {item["id"]: item for item in wan["devices"]}
        wan["links"].append({"id": "wan", "source": "r1", "target": "isp1", "source_port": "WAN", "target_port": "WAN1", "kind": "ethernet"})
        devices["r1"]["config"].update(wan_state="connected", wan_ip="203.0.113.100", nat_enabled=True)
        self.assertTrue(grade_lab("lab-07-wan-nat", wan)["passed"])

        multihomed = copy.deepcopy(LABS["lab-08-multihomed-server"]["starter_topology"])
        devices = {item["id"]: item for item in multihomed["devices"]}
        devices["srv1"]["config"]["server_interfaces"] = {
            "LAN1": {"ip": "10.80.1.10", "mask": "255.255.255.0"},
            "LAN2": {"ip": "10.80.2.10", "mask": "255.255.255.0"},
        }
        self.assertTrue(can_reach(multihomed, "pc1", "srv1"))
        self.assertTrue(can_reach(multihomed, "pc2", "srv1"))
        self.assertTrue(grade_lab("lab-08-multihomed-server", multihomed)["passed"])

        acl = copy.deepcopy(LABS["lab-09-inter-vlan-acl"]["starter_topology"])
        devices = {item["id"]: item for item in acl["devices"]}
        devices["sw1"]["config"]["acl_rules"] = [{
            "action": "deny", "protocol": "tcp", "source": "192.168.20.0/24",
            "destination": "192.168.30.0/24", "port": 80, "interface": "VLAN20", "direction": "in",
        }]
        self.assertFalse(can_reach(acl, "pc1", "srv1", "tcp", 80))
        self.assertTrue(can_reach(acl, "pc1", "srv1", "icmp"))
        self.assertTrue(grade_lab("lab-09-inter-vlan-acl", acl)["passed"])

    def test_concurrent_progress_uses_independent_student_files(self):
        topology = LABS["lab-01-connected-lan"]["starter_topology"]
        errors = []

        def save(index):
            try:
                self.store.save_progress(f"student{index}@example.com", "class-1", "lab-01-connected-lan", topology)
            except Exception as exc:  # pragma: no cover - assertion captures failures
                errors.append(exc)

        threads = [threading.Thread(target=save, args=(index,)) for index in range(60)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(self.store.class_progress("class-1")), 60)
        self.assertEqual(len(list((self.store.progress_dir / "class-1" / "lab-01-connected-lan").glob("*.json"))), 60)


class NetworkRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Flask(__name__)
        self.config_state = {"network_sim_enabled": True}
        self.admin_tokens = {"admin-token"}
        self.teachers = {"teacher-token": {"email": "teacher@example.com", "role": "teacher"}}
        self.students = {"student-token": {"email": "student@example.com", "role": "student", "class_ids": ["class-1"]}}
        self.classes = {
            "class-1": {"id": "class-1", "name": "Networking 1", "teacher_email": "teacher@example.com", "students": ["student@example.com"]},
            "class-2": {"id": "class-2", "name": "Someone Else", "teacher_email": "other@example.com", "students": []},
        }

        register(
            self.app,
            base_dir=Path(self.temp.name) / "network",
            require_admin=lambda req: req.headers.get("X-Admin-Token") in self.admin_tokens,
            require_teacher=lambda req: self.teachers.get(req.headers.get("X-Teacher-Token")),
            require_user=lambda req: self.students.get(req.headers.get("X-User-Token")),
            find_user=lambda email: next((item for item in self.students.values() if item["email"] == email), None),
            get_user_class_ids=lambda user: list((user or {}).get("class_ids", [])),
            find_class=lambda class_id: self.classes.get(class_id),
            config_provider=lambda: dict(self.config_state),
        )
        self.client = self.app.test_client()
        self.store = self.app.extensions["network_store"]

    def tearDown(self):
        self.temp.cleanup()

    def test_guests_can_open_when_enabled_but_cannot_save(self):
        response = self.client.get("/api/network/bootstrap")
        self.assertEqual(response.status_code, 200)
        bootstrap = response.get_json()["data"]
        self.assertFalse(bootstrap["can_save"])
        self.assertEqual(bootstrap["saved_sites"], [])
        self.assertEqual(len(bootstrap["practice_labs"]), len(LABS))
        self.assertEqual(bootstrap["command_reference"], COMMAND_REFERENCE)
        self.assertEqual(bootstrap["port_reference"], PORT_REFERENCE)
        self.assertEqual(bootstrap["acronym_reference"], ACRONYM_REFERENCE)
        response = self.client.put("/api/network/topologies/guest-work", json={"topology": EXAMPLE_TOPOLOGIES["simple-lan"]})
        self.assertEqual(response.status_code, 401)

    def test_practice_labs_are_available_without_assignment_but_do_not_expose_solutions(self):
        lab = "lab-01-connected-lan"
        practice_url = f"/api/network/practice-labs/{lab}"
        headers = {"X-User-Token": "student-token"}
        self.assertEqual(self.client.get(practice_url, headers=headers).status_code, 403)
        self.store.set_class_access("class-1", True)
        practice = self.client.get(practice_url, headers=headers)
        self.assertEqual(practice.status_code, 200)
        self.assertEqual(practice.json["data"]["id"], lab)
        self.assertIn("starter_topology", practice.json["data"])
        self.assertNotIn("solution", practice.json["data"])
        self.assertEqual(self.client.get(f"/api/network/labs/{lab}?class_id=class-1", headers=headers).status_code, 403)
        self.assertEqual(self.client.get(practice_url).status_code, 200)
        self.config_state["network_sim_enabled"] = False
        self.assertEqual(self.client.get(practice_url).status_code, 403)

    def test_scenario_visibility_checks_class_ownership_and_student_access(self):
        scenario_id = "port-adelaide-community-center"
        scenario_url = f"/api/network/wifi-scenarios/{scenario_id}"
        settings_url = f"/api/network/teacher/classes/class-1/scenarios/{scenario_id}"
        teacher = {"X-Teacher-Token": "teacher-token"}
        student = {"X-User-Token": "student-token"}
        self.store.set_class_access("class-1", True)
        self.assertEqual(self.client.get(scenario_url).status_code, 404)
        row = self.client.get("/api/network/bootstrap", headers=student).get_json()["data"]["scenarios"][0]
        self.assertEqual(row["id"], scenario_id)
        self.assertNotIn("site", row)
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 200)
        self.assertEqual(self.client.put(settings_url, headers=student, json={"visible": False}).status_code, 401)
        self.assertEqual(self.client.put(settings_url.replace("class-1", "class-2"), headers=teacher,
                                         json={"visible": False}).status_code, 403)
        self.assertEqual(self.client.put(settings_url, headers=teacher, json={"visible": "false"}).status_code, 400)
        self.assertEqual(self.client.put(settings_url, headers=teacher, json={"visible": False}).status_code, 200)
        classroom = self.client.get("/api/network/teacher/classes/class-1", headers=teacher).get_json()["data"]
        self.assertFalse(classroom["scenarios"][0]["visible"])
        self.assertEqual(self.client.get("/api/network/bootstrap", headers=student).get_json()["data"]["scenarios"], [])
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 404)
        self.assertEqual(self.client.get(scenario_url, headers=teacher).status_code, 200)
        self.students["student-token"]["class_ids"].append("class-2")
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 404)
        self.store.set_class_access("class-2", True)
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 200)
        self.store.set_class_access("class-2", False)
        self.assertEqual(self.client.put(settings_url, headers=teacher, json={"visible": True}).status_code, 200)
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 200)

    def test_saved_scenario_briefing_remains_available_after_teacher_hides_starter(self):
        scenario_id = "port-adelaide-community-center"
        scenario_url = f"/api/network/wifi-scenarios/{scenario_id}"
        site_url = "/api/network/wifi-sites/my-renovation"
        headers = {"X-User-Token": "student-token"}
        self.store.set_class_access("class-1", True)
        scenario = self.client.get(scenario_url, headers=headers).get_json()["data"]
        scenario["site"]["title"] = "My renovation"
        saved = self.client.put(site_url, headers=headers, json={"site": scenario["site"], "revision": 0})
        self.assertEqual(saved.status_code, 200)
        self.store.set_scenario_visibility("class-1", scenario_id, False)
        reopened = self.client.get(site_url, headers=headers).get_json()["data"]
        self.assertEqual(reopened["title"], "My renovation")
        self.assertEqual(reopened["scenario_briefing"], scenario["briefing"])
        self.assertEqual(len(reopened["scenario_briefing"]["traits"]), 4)
        copied = self.client.put(site_url + "-copy", headers=headers, json={"site": reopened, "revision": 0})
        self.assertEqual(copied.get_json()["data"]["scenario_id"], scenario_id)
        # A different student cannot get the briefing by supplying a scenario ID with a personal save.
        self.students["student-two"] = {"email": "two@example.com", "role": "student", "class_ids": ["class-1"]}
        other = {"X-User-Token": "student-two"}
        self.assertEqual(self.client.get(site_url, headers=other).status_code, 404)
        forged = self.client.put(site_url, headers=other, json={"site": scenario["site"], "revision": 0})
        self.assertNotIn("scenario_id", forged.get_json()["data"])

    def test_wifi_pdf_download_uses_authenticated_author_and_is_not_cached(self):
        self.store.set_class_access('class-1', True)
        self.students['student-token']['name'] = 'Alice Example'
        image = io.BytesIO()
        Image.new('RGB', (180, 100), '#dbe5ec').save(image, 'JPEG')
        url = '/api/network/wifi-export.pdf'
        payload = {'image': base64.b64encode(image.getvalue()).decode(), 'title': 'My civic plan',
                   'date': '2026-11-13', 'author': 'Other person'}
        headers = {'X-User-Token': 'student-token'}
        with self.client.post(url, json=payload, headers=headers) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, 'application/pdf')
            self.assertIn('My civic plan.pdf', response.headers['Content-Disposition'])
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertTrue(response.data.startswith(b'%PDF'))
            self.assertIn(b'/Author (Alice Example)', response.data)
            self.assertNotIn(b'Other person', response.data)
        self.assertEqual(self.client.post(url, json={**payload, 'image': 'invalid'}, headers=headers).status_code, 400)
        self.store.set_class_access('class-1', False)
        self.assertEqual(self.client.post(url, json=payload, headers=headers).status_code, 403)

    def test_disabled_blocks_guest_but_admin_can_privately_preview(self):
        self.config_state["network_sim_enabled"] = False
        self.assertEqual(self.client.get("/api/network/bootstrap").status_code, 403)
        response = self.client.get("/api/network/bootstrap", headers={"X-Admin-Token": "admin-token"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["data"]["admin_preview"])

    def test_student_requires_class_access_and_assignment(self):
        headers = {"X-User-Token": "student-token"}
        self.assertEqual(self.client.get("/api/network/bootstrap", headers=headers).status_code, 403)
        self.store.set_class_access("class-1", True)
        self.store.assign_lab("class-1", "lab-01-connected-lan", "teacher@example.com")
        response = self.client.get("/api/network/bootstrap", headers=headers)
        self.assertEqual(response.status_code, 200)
        assigned = response.get_json()["data"]["assigned_labs"]
        self.assertEqual(assigned[0]["class_id"], "class-1")
        lab = self.client.get("/api/network/labs/lab-01-connected-lan?class_id=class-1", headers=headers).get_json()["data"]
        self.assertNotIn("solution", lab)

    def test_teacher_can_assign_and_read_solution_only_for_owned_class(self):
        headers = {"X-Teacher-Token": "teacher-token"}
        response = self.client.put("/api/network/teacher/classes/class-1/labs/lab-01-connected-lan", headers=headers)
        self.assertEqual(response.status_code, 200)
        detail = self.client.get("/api/network/teacher/classes/class-1", headers=headers).get_json()["data"]
        self.assertIn("solution", detail["labs"][0])
        self.assertEqual(detail["labs"][0]["progress"]["roster_count"], 1)
        self.assertEqual(detail["labs"][0]["progress"]["students"][0]["status"], "not_started")
        self.assertEqual(detail["labs"][0]["progress"]["students"][0]["score"], 0)
        self.assertEqual(self.client.get("/api/network/teacher/classes/class-2", headers=headers).status_code, 403)

    def test_progress_is_graded_server_side(self):
        self.store.set_class_access("class-1", True)
        self.store.assign_lab("class-1", "lab-01-connected-lan", "teacher@example.com")
        topology = copy.deepcopy(LABS["lab-01-connected-lan"]["starter_topology"])
        response = self.client.put(
            "/api/network/student/labs/class-1/lab-01-connected-lan",
            headers={"X-User-Token": "student-token"},
            json={"topology": topology, "grade": {"passed": True, "percent": 100}},
        )
        self.assertEqual(response.status_code, 200)
        grade = response.get_json()["data"]["grade"]
        self.assertFalse(grade["passed"])
        self.assertEqual(grade["percent"], 0)
        teacher_data = self.client.get("/api/network/teacher/classes/class-1", headers={"X-Teacher-Token": "teacher-token"}).get_json()["data"]
        student_result = teacher_data["labs"][0]["progress"]["students"][0]
        self.assertEqual(student_result["status"], "in_progress")
        self.assertEqual(student_result["score"], 0)

    def test_personal_save_requires_matching_owner_token(self):
        topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["simple-lan"])
        response = self.client.put("/api/network/topologies/my-lan", headers={"X-Teacher-Token": "teacher-token"}, json={"topology": topology})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/network/topologies/my-lan", headers={"X-Teacher-Token": "teacher-token"}).status_code, 200)
        self.store.set_class_access("class-1", True)
        self.assertEqual(self.client.get("/api/network/topologies/my-lan", headers={"X-User-Token": "student-token"}).status_code, 404)

    def wifi_plan(self):
        return {
            "schema_version": WIFI_SCHEMA_VERSION, "title": "Two rooms",
            "units": "ft", "band": "5",
            "walls": [{"id": "wall-1", "a": {"x": 20, "y": 4}, "b": {"x": 20, "y": 24}, "material": "concrete"}],
            "access_points": [{"id": "ap-1", "x": 11, "y": 14, "mount": "wall", "angle": 90, "name": "Hall AP", "power_db": 0,
                               "ssid_ids": ["default"]}],
            "ssids": [{"id": "default", "name": "Default", "band": "both", "vlan": 0}], "vlans": [],
            "labels": [{"id": "note-1", "x": 25, "y": 7, "text": "Check signal here"}],
            "equipment": [], "pass_throughs": [], "cables": [],
            "openings": [], "background": None,
            "surfaces": [], "decor": [], "background_color": None,
        }

    def test_wifi_site_access_and_account_owned_round_trip(self):
        url = "/api/network/wifi-sites/site-1"
        headers = {"X-User-Token": "student-token"}
        teacher = {"X-Teacher-Token": "teacher-token"}
        plan = self.wifi_plan()
        payload = {"site": plan, "revision": 0}
        self.assertEqual(self.client.put(url, json=payload).status_code, 401)
        self.assertEqual(self.client.put(url, json=payload, headers=headers).status_code, 403)
        self.store.set_class_access("class-1", True)
        saved = self.client.put(url, json=payload, headers=headers)
        self.assertEqual(saved.status_code, 200, saved.json)
        self.assertEqual(saved.json["data"]["revision"], 1)
        opened = self.client.get(url, headers=headers).json["data"]
        self.assertEqual({key: opened[key] for key in plan}, plan)
        self.assertEqual(self.client.get("/api/network/bootstrap", headers=headers).json["data"]["saved_sites"],
                         [{"id": "site-1", "title": plan["title"], "updated_at": opened["updated_at"]}])
        self.assertEqual(self.client.get("/api/network/bootstrap", headers=teacher).json["data"]["saved_sites"], [])
        self.assertEqual(self.client.get(url, headers=teacher).status_code, 404)
        self.assertEqual(self.client.delete(url, headers=teacher).status_code, 404)
        self.assertEqual(self.client.get("/api/network/wifi-sites", headers=teacher).json["data"], [])
        self.assertEqual(self.client.get("/api/network/topologies", headers=headers).json["data"], [])
        self.config_state["network_sim_enabled"] = False
        self.assertEqual(self.client.get(url, headers=headers).status_code, 403)
        self.config_state["network_sim_enabled"] = True
        self.assertEqual(self.client.delete(url, headers=headers).status_code, 200)
        self.assertEqual(self.client.get(url, headers=headers).status_code, 404)

    def test_wifi_site_validates_objects_and_rejects_stale_autosaves(self):
        url = "/api/network/wifi-sites/site-1"
        headers = {"X-Teacher-Token": "teacher-token"}
        plan = self.wifi_plan()
        for group, field, bad in (
            ("walls", "material", []), ("access_points", "angle", float("nan")),
            ("access_points", "x", 1e20), ("access_points", "power_db", 20), ("labels", "id", "../other"),
            ("labels", "id", "ap-1"), ("labels", "text", "\ud800"),
        ):
            invalid = copy.deepcopy(plan)
            invalid[group][0][field] = bad
            with self.subTest(group=group, field=field):
                self.assertEqual(self.client.put(url, headers=headers, json={"site": invalid, "revision": 0}).status_code, 400)
        payload = {"site": plan, "revision": 0}
        self.assertEqual(self.client.put(url, headers=headers, json=payload).status_code, 200)
        self.assertEqual(self.client.put(url, headers=headers, json=payload).json["data"]["revision"], 1)
        updated = {**plan, "title": "Updated in a second tab"}
        self.assertEqual(self.client.put(url, headers=headers, json={"site": updated, "revision": 1}).status_code, 200)
        self.assertEqual(self.client.put(url, headers=headers, json={"site": plan, "revision": 1}).status_code, 409)
        self.assertEqual(self.client.get(url, headers=headers).json["data"]["title"], updated["title"])
        self.assertEqual(self.client.delete(url, headers=headers).status_code, 200)
        self.assertEqual(self.client.put(url, headers=headers, json={"site": plan, "revision": 2}).status_code, 409)

    def test_new_design_layers_round_trip_and_are_protected_from_older_editors(self):
        plan = self.wifi_plan()
        old_editor = {**plan, 'schema_version': 4}
        plan['background_color'] = '#ddeedd'
        plan['decor'] = [{'id': 'tree-1', 'kind': 'tree', 'x': 3, 'y': 5, 'angle': 15}]
        plan['surfaces'] = [{'id': 'walk', 'kind': 'sidewalk', 'color': '#cacaca',
                             'points': [{'x': 0, 'y': 0}, {'x': 2, 'y': 0}, {'x': 0, 'y': 2}], 'holes': []}]
        url = '/api/network/wifi-sites/design-layers'
        headers = {'X-Teacher-Token': 'teacher-token'}
        self.assertEqual(self.client.put(url, headers=headers, json={'site': plan, 'revision': 0}).status_code, 200)
        actual = self.client.get(url, headers=headers).json['data']
        self.assertEqual({key: actual[key] for key in plan}, plan)
        self.assertEqual(self.client.put(url, headers=headers, json={'site': old_editor, 'revision': 1}).status_code, 409)
        plan['surfaces'][0]['color'] = 'url(https://example.test)'
        self.assertEqual(self.client.put(url, headers=headers, json={'site': plan, 'revision': 1}).status_code, 400)

    def test_infra_network_settings_round_trip_and_validate_references(self):
        plan = self.wifi_plan()
        plan["vlans"] = [{"id": 20, "name": "Guest"}]
        plan["ssids"] = [{"id": "guest", "name": "Guest Wi-Fi", "band": "2.4", "vlan": 20}]
        plan["access_points"][0]["ssid_ids"] = ["guest"]
        plan["equipment"] = [
            {"id": "router", "kind": "router", "x": 0, "y": 0, "name": "Router",
             "dhcp": {"gateway": "10.0.0.1/29", "dns": "1.1.1.1", "fallback_dns": "8.8.8.8"},
             "firewall": [{"action": "deny", "source_vlan": 20, "destination_vlan": 0,
                           "source_ip": "", "destination_ip": "10.0.0.4/29"}]},
            {"id": "switch", "kind": "distribution_switch", "x": 0, "y": 1, "name": "Switch",
             "port_vlans": {"ETH1": [0, 20], "ETH24": []}},
            {"id": "phone", "kind": "phone", "x": 0, "y": 2, "name": "Client", "ssid_id": "guest",
             "reservation": {"router_id": "router", "ip": "10.0.0.2"}},
        ]
        headers = {"X-Teacher-Token": "teacher-token"}
        url = "/api/network/wifi-sites/network-settings"
        result = self.client.put(url, headers=headers, json={"site": plan, "revision": 0})
        self.assertEqual(result.status_code, 200, result.json)
        saved = self.client.get(url, headers=headers).json["data"]
        self.assertEqual(saved["equipment"][0]["firewall"][0]["destination_ip"], "10.0.0.0/29")
        plan["equipment"][0]["firewall"][0]["destination_ip"] = "10.0.0.0/29"
        self.assertEqual({key: saved[key] for key in plan}, plan)

        for path, bad in (
            (("access_points", 0, "ssid_ids"), ["guest"] * 5),
            (("ssids", 0, "vlan"), 22),
            (("equipment", 0, "dhcp", "gateway"), "10.0.0.7/29"),
            (("equipment", 0, "firewall", 0, "destination_ip"), "10.0.0.4/"),
            (("equipment", 1, "port_vlans"), {"ETH25": [20]}),
            (("equipment", 2, "reservation", "ip"), "10.0.0.1"),
            (("equipment", 2, "reservation", "router_id"), "switch"),
        ):
            with self.subTest(path=path):
                invalid = copy.deepcopy(plan)
                item = invalid
                for key in path[:-1]:
                    item = item[key]
                item[path[-1]] = bad
                response = self.client.put(url, headers=headers, json={"site": invalid, "revision": 1})
                self.assertEqual(response.status_code, 400, response.json)
        old = {**self.wifi_plan(), "schema_version": 5}
        self.assertEqual(self.client.put(url, headers=headers, json={"site": old, "revision": 1}).status_code, 409)

        plan["ssids"] = []
        plan["access_points"][0]["ssid_ids"] = []
        plan["equipment"][2]["ssid_id"] = ""
        self.assertEqual(self.client.put(url, headers=headers, json={"site": plan, "revision": 1}).status_code, 200)
        self.assertEqual(self.client.get(url, headers=headers).json["data"]["ssids"], [])

    def test_wifi_site_opens_legacy_data_and_saves_large_signed_coordinates(self):
        email = "teacher@example.com"
        headers = {"X-Teacher-Token": "teacher-token"}
        url = "/api/network/wifi-sites/legacy-site"
        original = self.wifi_plan()
        legacy = {**copy.deepcopy(original), "id": "legacy-site", "revision": 7,
                  "updated_at": 1200, "schema_version": 1, "width": 40, "height": 28}
        del legacy["access_points"][0]["power_db"]
        del legacy["access_points"][0]["ssid_ids"]
        del legacy["ssids"]
        del legacy["vlans"]
        self.store._write_json(self.store._wifi_path(email), {"sites": {"legacy-site": legacy}})
        opened = self.client.get(url, headers=headers).json["data"]
        self.assertEqual(opened["revision"], 7)
        self.assertEqual({key: opened[key] for key in original}, original)
        self.assertNotIn("width", opened)
        opened["walls"] = [
            {"id": f"campus-{i}", "a": {"x": -2000, "y": i}, "b": {"x": 3250, "y": i}, "material": "brick"}
            for i in range(1000)
        ]
        opened["access_points"][0].update(x=-1500.125, power_db=6)
        saved = self.client.put(url, headers=headers, json={"site": opened, "revision": 7})
        self.assertEqual(saved.status_code, 200, saved.json)
        reopened = self.client.get(url, headers=headers).json["data"]
        self.assertEqual(reopened["walls"], opened["walls"])
        self.assertEqual(reopened["access_points"], opened["access_points"])
        self.assertEqual(reopened["revision"], 8)

    def test_wifi_v2_site_reopens_without_cabling_and_preserves_access_points(self):
        email = "teacher@example.com"
        plan = self.wifi_plan()
        legacy = {key: value for key, value in plan.items() if key not in ("equipment", "pass_throughs", "cables")}
        legacy.update(id="v2-site", revision=3, updated_at=1200, schema_version=2)
        self.store._write_json(self.store._wifi_path(email), {"sites": {"v2-site": legacy}})
        url = "/api/network/wifi-sites/v2-site"
        headers = {"X-Teacher-Token": "teacher-token"}
        opened = self.client.get(url, headers=headers).json["data"]
        self.assertEqual({key: opened[key] for key in plan}, plan)
        opened["equipment"].append({"id": "switch-1", "kind": "access_switch", "name": "Room switch", "x": 12, "y": 13})
        opened["cables"].append({
            "id": "cable-1", "media": "ethernet", "color": "#0879b3", "label": "Room AP",
            "source": {"device_id": "switch-1", "port": "ETH1"},
            "target": {"device_id": "ap-1", "port": "ETH1"}, "waypoints": [],
        })
        saved = self.client.put(url, headers=headers, json={"site": opened, "revision": 3})
        self.assertEqual(saved.status_code, 200, saved.json)
        self.assertEqual(self.client.get(url, headers=headers).json["data"]["cables"], opened["cables"])
        self.assertEqual(self.client.put(url, headers=headers, json={"site": legacy, "revision": 4}).status_code, 409)

    def test_mutating_routes_reject_non_object_json(self):
        teacher = {"X-Teacher-Token": "teacher-token"}
        self.assertEqual(self.client.put("/api/network/topologies/bad", headers=teacher, json=[]).status_code, 400)
        self.assertEqual(self.client.put("/api/network/teacher/classes/class-1/access", headers=teacher, json=[]).status_code, 400)
        self.store.set_class_access("class-1", True)
        self.store.assign_lab("class-1", "lab-01-connected-lan", "teacher@example.com")
        self.assertEqual(self.client.put("/api/network/student/labs/class-1/lab-01-connected-lan", headers={"X-User-Token": "student-token"}, json=[]).status_code, 400)


if __name__ == "__main__":
    unittest.main()
