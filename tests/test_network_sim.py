import copy
import tempfile
import threading
import unittest
from pathlib import Path

from flask import Flask

from network_content import ACRONYM_REFERENCE, COMMAND_REFERENCE, DEVICE_PORTS, EXAMPLE_TOPOLOGIES, LABS, PORT_REFERENCE
from network_features import register
from network_store import MAX_DEVICES, NetworkDataError, NetworkStore, _stp_state, can_reach, can_reach_ipv6, grade_lab, migrate_topology, validate_topology


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
        self.assertEqual(bootstrap["command_reference"], COMMAND_REFERENCE)
        self.assertEqual(bootstrap["port_reference"], PORT_REFERENCE)
        self.assertEqual(bootstrap["acronym_reference"], ACRONYM_REFERENCE)
        response = self.client.put("/api/network/topologies/guest-work", json={"topology": EXAMPLE_TOPOLOGIES["simple-lan"]})
        self.assertEqual(response.status_code, 401)

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

    def test_mutating_routes_reject_non_object_json(self):
        teacher = {"X-Teacher-Token": "teacher-token"}
        self.assertEqual(self.client.put("/api/network/topologies/bad", headers=teacher, json=[]).status_code, 400)
        self.assertEqual(self.client.put("/api/network/teacher/classes/class-1/access", headers=teacher, json=[]).status_code, 400)
        self.store.set_class_access("class-1", True)
        self.store.assign_lab("class-1", "lab-01-connected-lan", "teacher@example.com")
        self.assertEqual(self.client.put("/api/network/student/labs/class-1/lab-01-connected-lan", headers={"X-User-Token": "student-token"}, json=[]).status_code, 400)


if __name__ == "__main__":
    unittest.main()
