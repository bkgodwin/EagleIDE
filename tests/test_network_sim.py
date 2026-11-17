import copy
from concurrent.futures import ThreadPoolExecutor
import base64
import io
import json
import math
import shutil
import subprocess
import tempfile
import threading
import unittest
from itertools import combinations
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from PIL import Image

from network_content import ACRONYM_REFERENCE, COMMAND_REFERENCE, DEVICE_PORTS, EXAMPLE_TOPOLOGIES, LABS, PORT_REFERENCE
from network_features import register
from network_store import MAX_DEVICES, WIFI_SCHEMA_VERSION, NetworkDataError, NetworkStore, _stp_state, can_reach, can_reach_ipv6, grade_lab, migrate_topology, validate_topology, validate_wifi_site
from wifi_cabling import CABLING_CATALOG, CABLING_LIMITS
from wifi_scenarios import SCENARIOS
from wifi_site_pdf import Canvas


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
    def test_concurrent_infra_saves_isolate_accounts_and_keep_shared_account_revisions(self):
        plan = SCENARIOS["juniper-main-coffee"]["site"]

        def save(index):
            email = f"student-{index // 4}@example.test"
            site_id = f"site-{index}"
            self.store.save_wifi_site(email, site_id, plan, 0)
            return self.store.get_wifi_site(email, site_id)["revision"]

        with ThreadPoolExecutor(max_workers=12) as executor:
            self.assertEqual(list(executor.map(save, range(32))), [1] * 32)
        for index in range(8):
            self.assertEqual(len(self.store.list_wifi_sites(f"student-{index}@example.test")), 4)
        self.assertFalse(self.store.list_wifi_sites("other@example.test"))

    def test_coffee_and_house_scenarios_are_furnished_unwired_starters(self):
        for scenario_id in ("juniper-main-coffee", "maple-lane-house"):
            with self.subTest(scenario=scenario_id):
                scenario = SCENARIOS[scenario_id]
                plan = validate_wifi_site(scenario["site"])
                self.assertTrue(scenario["description"] and scenario["briefing"])
                self.assertTrue(plan["walls"] and plan["labels"] and plan["surfaces"] and plan["decor"])
                self.assertTrue(any(opening["material"] == "none" for opening in plan["openings"]))
                self.assertFalse(plan["equipment"] or plan["access_points"] or plan["cables"])

    def test_house_garage_car_aligns_with_the_overhead_door_and_driveway(self):
        site = SCENARIOS["maple-lane-house"]["site"]
        walls = {wall["id"]: wall for wall in site["walls"]}
        front, east = walls["garage-front"], walls["garage-east"]
        self.assertAlmostEqual(front["b"]["x"] - front["a"]["x"], 6.5)
        self.assertAlmostEqual(east["b"]["y"] - east["a"]["y"], 6.6)
        overhead = next(opening for opening in site["openings"] if opening["wall_id"] == front["id"])
        car = next(item for item in site["decor"] if item["kind"] == "car")
        center = front["a"]["x"] + overhead["t"] * 6.5
        self.assertEqual(car["angle"], 0)
        self.assertLess(abs(car["x"] - center) + 1.85 / 2, overhead["width"] / 2)
        self.assertLess(car["y"] + 4.55 / 2, front["a"]["y"])
        self.assertGreater(car["y"] - 4.55 / 2, east["a"]["y"])
        drive = next(finish for finish in site["surfaces"] if finish["kind"] == "pavement")
        self.assertEqual(min(point["y"] for point in drive["points"]), front["a"]["y"])
        self.assertLess(min(point["x"] for point in drive["points"]), car["x"])
        self.assertLess(car["x"], max(point["x"] for point in drive["points"]))

    def test_high_school_starter_has_scaled_classrooms_courts_and_no_network_gear(self):
        scenario = SCENARIOS["alder-ridge-high-school"]
        site = validate_wifi_site(scenario["site"])
        names = {item["text"] for item in site["labels"]}
        classrooms = {f"Classroom {wing + number}" for wing in (100, 200) for number in range(1, 9)}
        self.assertEqual({name for name in names if name.startswith("Classroom ")}, classrooms)
        self.assertTrue({"Main gym", "Auxiliary gym", "Cafeteria", "Counseling office", "Conference room",
                         "Front office / reception", "Main IT / network room", "West IDF", "East IDF",
                         "Shop IDF", "Athletics IDF", "Wood shop", "Metal shop", "Bus rider pickup",
                         "Car rider pickup"}.issubset(names))
        self.assertTrue(scenario["briefing"])
        self.assertTrue({"Learning courtyard", "Outdoor classrooms", "Visitor parking", "PE practice field",
                         "Cafeteria terrace", "Main entrance plaza", "Covered bus waiting"}.issubset(names))
        for room in (item for item in site["labels"] if item["text"] in classrooms):
            floor = next(finish for finish in site["surfaces"]
                         if finish["kind"] == "floor"
                         and finish["points"][0] == {"x": round(room["x"] - .6, 4),
                                                     "y": round(room["y"] - 1.25, 4)})
            start, _, far, _ = floor["points"]
            self.assertEqual((far["x"] - start["x"], far["y"] - start["y"]), (9.5, 9))
            seats = [item for item in site["decor"] if item["kind"] == "student_table"
                     and start["x"] < item["x"] < far["x"] and start["y"] < item["y"] < far["y"]]
            self.assertEqual(len(seats), 14)
        self.assertEqual(sum(item["kind"] == "basketball_court" for item in site["decor"]), 2)
        self.assertFalse(site["equipment"] or site["access_points"] or site["cables"] or site["pass_throughs"])

    def test_high_school_idfs_are_distributed_and_served_by_real_corridors(self):
        site = SCENARIOS["alder-ridge-high-school"]["site"]
        closets = {label["text"]: label for label in site["labels"] if label["text"].endswith(" IDF")}
        self.assertEqual(set(closets), {"West IDF", "East IDF", "Athletics IDF", "Shop IDF"})
        for first, second in combinations(closets.values(), 2):
            self.assertGreater(math.hypot(first["x"] - second["x"], first["y"] - second["y"]), 40)
        walls = {item["id"]: item for item in site["walls"]}
        for wall_id, expected_center in (
            ("west-support-west", -6.15), ("east-support-west", -6.15),
            ("athletics-support-entries", 152), ("shop-corridor-south", 146),
        ):
            wall = walls[wall_id]
            axis = "x" if wall["a"]["x"] != wall["b"]["x"] else "y"
            with self.subTest(corridor=wall_id):
                centers = [wall["a"][axis] + opening["t"] * (wall["b"][axis] - wall["a"][axis])
                           for opening in site["openings"] if opening["wall_id"] == wall_id]
                self.assertTrue(any(math.isclose(center, expected_center, abs_tol=.001) for center in centers))

    def test_stadium_starter_has_full_bowl_and_unwired_sports_and_service_areas(self):
        scenario = SCENARIOS["harborline-stadium"]
        site = validate_wifi_site(scenario["site"])
        labels = {item["text"] for item in site["labels"]}
        self.assertTrue({"Press box", "Announcer booth", "Public concourse", "West concessions", "East ticket office",
                         "Home team locker room", "Visiting team locker room", "Security operations", "Water & fire services",
                         "Main bowl air handling", "East bowl air handling", "Central chilled-water plant",
                         "Basketball gym", "Strength & cardio gym", "Indoor tennis hall", "Yoga studio",
                         "Aquatics hall / lap pool", "Pool filtration & water treatment", "Fan park & warm-up lawn"}.issubset(labels))
        self.assertTrue(scenario["briefing"])
        self.assertTrue(site["floor_locked"])
        self.assertFalse(any(site[layer] for layer in ("equipment", "access_points", "cables", "pass_throughs")))
        field, = [item for item in site["decor"] if item["kind"] == "football_field"]
        seating = [item for item in site["decor"] if item["kind"] == "stadium_seating"]
        for axis, span in (("x", 65), ("y", 32)):
            with self.subTest(axis=axis):
                self.assertTrue(any(seat[axis] < field[axis] - span for seat in seating))
                self.assertTrue(any(seat[axis] > field[axis] + span for seat in seating))
        self.assertEqual(sum(item["kind"] == "tennis_court" for item in site["decor"]), 2)
        self.assertEqual(sum(item["kind"] == "lap_pool" for item in site["decor"]), 1)
        self.assertGreaterEqual(sum(wall["material"] == "reinforced_concrete" for wall in site["walls"]), 12)

    def test_office_park_starter_contains_the_campus_and_unwired_equipment(self):
        scenario = SCENARIOS["briar-glen-insurance-campus"]
        site = validate_wifi_site(scenario["site"])
        self.assertTrue(site["floor_locked"])
        self.assertEqual(site["units"], "m")
        self.assertEqual(site["cables"], [])
        self.assertEqual(site["access_points"], [])
        walls = {wall["id"]: wall for wall in site["walls"]}
        office_fronts = [walls[f"{key}-south-shell"] for key in "ABCD"]
        for i, front in enumerate(office_fronts):
            self.assertEqual(front["a"]["y"], 34)
            self.assertGreaterEqual(front["b"]["x"] - front["a"]["x"], 60)
            if i:
                self.assertGreaterEqual(front["a"]["x"] - office_fronts[i - 1]["b"]["x"], 16)
        self.assertLess(walls["plant-south"]["a"]["y"], 0)
        self.assertGreater(walls["guard-north"]["a"]["y"], 34)
        labels = [item["text"] for item in site["labels"]]
        self.assertIn("Ballroom · 29 × 19 m", labels)
        self.assertEqual(labels.count("Executive Assistant"), 2)
        self.assertGreaterEqual(sum("IDC" in text for text in labels), 5)
        self.assertGreaterEqual(sum(item["kind"] == "cubicle" for item in site["decor"]), 100)

        equipment = site["equipment"]
        racks = [item for item in equipment if item["kind"] == "rack"]
        self.assertEqual(len(racks), 12)
        self.assertEqual(len({rack["name"] for rack in racks}), 12)
        for rack in racks:
            self.assertTrue(76 < rack["x"] < 105 and 0 < rack["y"] < 14)
            mounted = {item["rack_u"]: item["kind"] for item in equipment if item.get("rack_id") == rack["id"]}
            self.assertEqual(mounted, {1: "ups", 3: "ups", 6: "server", 8: "server", 10: "server",
                                       12: "server", 16: "patch_panel"})
        cameras = [item for item in equipment if item["kind"] == "poe_camera"]
        self.assertEqual({item["name"] for item in cameras}, {"Entry lane", "Exit lane"})
        self.assertTrue(all(147 < item["x"] < 155 and 74 < item["y"] < 77 for item in cameras))
        desktop, = [item for item in equipment if item["kind"] == "desktop"]
        self.assertTrue(148 < desktop["x"] < 154 and 70 < desktop["y"] < 76.2)

    def test_industrial_starter_keeps_logistics_and_detached_buildings_at_scale(self):
        scenario = SCENARIOS["rivermill-fabrication-works"]
        site = validate_wifi_site(scenario["site"])
        self.assertTrue({"Materials warehouse", "Fabrication & welding hall", "CNC machining hall",
                         "Assembly lines", "Main power & electrical", "Main IT / network room",
                         "Warehouse IDF", "Production IDF", "Assembly IDF", "Fleet IDF", "Training IDF",
                         "Outdoor steel stockyard", "Crane & service pad", "Heavy equipment garage",
                         "Training classroom", "Practical training lab"}.issubset(
                             label["text"] for label in site["labels"]))
        self.assertTrue(scenario["briefing"])
        self.assertTrue(site["floor_locked"])
        self.assertFalse(any(site[layer] for layer in ("equipment", "access_points", "cables")))
        walls = {wall["id"]: wall for wall in site["walls"]}
        self.assertEqual(walls["plant-south-shell"]["b"], {"x": 168, "y": 92})
        self.assertGreater(walls["fleet-west-shell"]["a"]["x"] - walls["plant-east-shell"]["a"]["x"], 20)
        self.assertGreater(walls["training-north-shell"]["a"]["y"] - walls["fleet-south-shell"]["a"]["y"], 40)
        dock_centers = [
            round(opening["t"] * 168, 2) for opening in site["openings"]
            if opening["wall_id"] == "plant-north-shell" and opening["material"] == "metal" and opening["width"] == 3.6
        ]
        self.assertEqual(dock_centers, [7.5, 15.5, 23.5, 31.5, 39.5, 47.5, 116, 124, 132, 140, 148, 156, 164])
        mills = [item for item in site["decor"] if item["kind"] == "cnc_mill"]
        self.assertEqual(len(mills), 12)
        self.assertTrue(all(52 < item["x"] < 112 and 52 < item["y"] < 78 for item in mills))
        service_bays = [item for item in site["decor"] if item["kind"] == "service_bay"]
        self.assertEqual(len(service_bays), 4)
        self.assertTrue(all(194 < item["x"] < 241 and -16 < item["y"] < 13 for item in service_bays))
        yard_symbols = {item["kind"] for item in site["decor"]
                        if item["x"] < 0 or (item["x"] > 168 and 27 < item["y"] < 69)}
        self.assertTrue({"mobile_crane", "telehandler", "forklift", "steel_stock"}.issubset(yard_symbols))

    def test_motel_starter_has_inward_entries_and_only_the_requested_endpoints(self):
        site = validate_wifi_site(SCENARIOS["suntrail-motor-lodge"]["site"])
        labels = {item["text"] for item in site["labels"]}
        room_numbers = set(range(101, 144))
        self.assertEqual({int(text) for text in labels if text.isdecimal()}, room_numbers)
        self.assertTrue({"Courtyard pool", "Reception", "Breakfast dining", "Buffet line",
                         "Kitchen", "New wing hall", "Guest parking", "Comms closet"}.issubset(labels))
        walls = {item["id"]: item for item in site["walls"]}
        for bank, material, door_count in (
            ("north-court", "brick", 12), ("east-court", "brick", 6),
            ("south-court", "brick", 5), ("west-court", "brick", 8),
            ("annex-north", "drywall", 6), ("annex-south", "drywall", 6),
        ):
            entry = bank + "-entries"
            with self.subTest(bank=bank):
                self.assertEqual(walls[entry]["material"], material)
                self.assertEqual(sum(item["wall_id"] == entry and item["kind"] == "door"
                                     for item in site["openings"]), door_count)

        self.assertTrue(site["floor_locked"])
        self.assertFalse(any(site[layer] for layer in ("access_points", "cables", "pass_throughs")))
        devices = {item["id"]: item for item in site["equipment"]}
        self.assertEqual(set(devices), {"reception-pos"} | {f"guest-phone-{number}" for number in room_numbers})
        desks = {(item["x"], item["y"]) for item in site["decor"] if item["kind"] == "desk"}
        for number in room_numbers:
            phone = devices[f"guest-phone-{number}"]
            self.assertEqual(phone["kind"], "voip_phone")
            self.assertIn((phone["x"], phone["y"]), desks)
        self.assertEqual(len(desks), len(room_numbers))
        self.assertEqual(sum(item["kind"] == "bed" for item in site["decor"]), 55)
        pos = devices["reception-pos"]
        self.assertEqual(pos["kind"], "pos_terminal")
        self.assertTrue(72.2 < pos["x"] < 84 and 40.8 < pos["y"] < 52.1)

    def test_regional_hospital_starter_has_separate_arrivals_and_unwired_departments(self):
        scenario = SCENARIOS["marshpoint-regional-hospital"]
        site = validate_wifi_site(scenario["site"])
        labels = {item["text"] for item in site["labels"]}
        self.assertTrue({"Emergency department", "Trauma & resuscitation", "Surgical wing", "Acute inpatient ward",
                         "Women’s care", "Pediatric care", "Mental health care", "Morgue", "Cafeteria",
                         "Regional surge triage", "Disaster intake", "Emergency command center", "Disaster supplies",
                         "Diesel power plant", "Ground helipad", "Ambulance bays", "Main lobby & reception",
                         "Main IT / network room", "ED IDF", "Surgery IDF", "Ward IDF", "Family care IDF",
                         "Command IDF"}.issubset(labels))
        self.assertTrue(site["floor_locked"])
        self.assertFalse(any(site[layer] for layer in ("equipment", "access_points", "cables", "pass_throughs")))

        walls = {wall["id"]: wall for wall in site["walls"]}
        self.assertEqual(walls["south-shell"]["b"], {"x": 196, "y": 126})
        pad, = [item for item in site["decor"] if item["kind"] == "helipad"]
        self.assertLess(pad["x"] + 12, walls["west-shell"]["a"]["x"])
        self.assertEqual(pad["y"], 21)
        emergency_entries = [round(item["t"] * 126, 1) for item in site["openings"]
                             if item["wall_id"] == "west-shell" and item["kind"] == "door"]
        self.assertEqual(emergency_entries, [21, 37, 77.7])
        ambulances = [item for item in site["decor"] if item["kind"] == "ambulance"]
        self.assertEqual(len(ambulances), 4)
        self.assertTrue(all(item["x"] < 0 and 27.5 < item["y"] < 48.5 for item in ambulances))
        generators = [item for item in site["decor"] if item["kind"] == "diesel_generator"]
        self.assertEqual(len(generators), 4)
        self.assertTrue(all(158 < item["x"] < 196 and 0 < item["y"] < 23.2 for item in generators))
        self.assertEqual(sum(item["kind"] == "operating_table" for item in site["decor"]), 6)

    def test_infra_campus_example_has_powered_aps_isolated_guests_and_redundant_fiber(self):
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
        self.assertTrue(site["floor_locked"])
        self.assertGreaterEqual(len(site["access_points"]), 16)
        self.assertTrue(all(ap["id"] in ethernet_ends for ap in site["access_points"]))
        self.assertTrue(all(closet in {wall["id"] for wall in site["walls"]}
                            for closet in ("west-idf-top", "east-idf-top", "annex-idf-east", "pavilion-idf-east")))
        athletics = next(item for item in site["equipment"] if item["id"] == "annex-dist")
        self.assertTrue(72 < athletics["x"] < 78.2 and 3 < athletics["y"] < 9.2)
        athletics_door = next(item for item in site["openings"] if item["id"] == "annex-idf-door")
        athletics_wall = next(wall for wall in site["walls"] if wall["id"] == athletics_door["wall_id"])
        self.assertEqual(athletics_wall["a"], {"x": 72, "y": 9.2})
        self.assertEqual(athletics_wall["b"], {"x": 78.2, "y": 9.2})
        self.assertTrue(any(ap["y"] < 0 for ap in site["access_points"]))
        self.assertEqual({item["kind"] for item in site["surfaces"]}, {"floor", "sidewalk", "pavement", "landscape"})
        self.assertTrue({"basketball_court", "welding_cell", "cnc_lathe", "switchgear",
                         "desk", "chair", "tree", "parking_bay"}.issubset(item["kind"] for item in site["decor"]))
        self.assertTrue({"desktop", "phone"}.issubset(item["kind"] for item in site["equipment"]))
        self.assertTrue(all(item["id"] in ethernet_ends for item in site["equipment"] if item["kind"] == "desktop"))
        self.assertTrue(all(item["id"] not in ethernet_ends for item in site["equipment"] if item["kind"] == "phone"))
        wired_clients = {"poe_camera", "voip_phone", "pos_terminal", "copy_machine"}
        self.assertEqual({item["kind"] for item in site["equipment"] if item["id"] in ethernet_ends} & wired_clients,
                         wired_clients)
        cameras = [item for item in site["equipment"] if item["kind"] == "poe_camera"]
        self.assertEqual(len(cameras), 8)
        self.assertTrue(all(item["id"] in ethernet_ends for item in cameras))
        camera = next(item for item in cameras if item["id"] == "camera-reception")
        self.assertEqual((camera["angle"], camera["field_of_view"], camera["range"]), (171, 90, 6))
        with self.assertRaisesRegex(NetworkDataError, "camera field of view"):
            validate_wifi_site({**site, "equipment": [{**item, "field_of_view": 500} if item == camera else item
                                                      for item in site["equipment"]]})
        for ap in site["access_points"]:
            if ap["mount"] == "wall":
                wall = next(wall for wall in site["walls"] if wall["id"] == ap["wall_id"])
                for axis in ("x", "y"):
                    self.assertAlmostEqual(ap[axis], wall["a"][axis] + ap["t"] * (wall["b"][axis] - wall["a"][axis]), places=4)

        check_network = """
          const assert = require('node:assert/strict');
          const { readFileSync } = require('node:fs');
          const { plan, catalog, limits } = JSON.parse(readFileSync(0, 'utf8'));
          const wiring = require('./static/js/wifi-cabling-model');
          const { coverageModel } = require('./static/js/wifi-site-model');
          const { INTERNET, build, ping, reachableServices } = require('./static/js/wifi-site-client-model');
          const paths = input => {
            const cables = wiring.build(input, catalog, limits);
            assert.equal(cables.error, '');
            assert.equal(cables.poweredAps.size, input.access_points.length);
            for (const camera of input.equipment.filter(item => item.kind === 'poe_camera')) {
              assert.ok(cables.poweredDevices.has(camera.id));
            }
            return build(input, cables, coverageModel);
          };
          const network = paths(plan);
          for (const client of network.clients.values()) assert.ok(client.router && client.lease);
          assert.ok(ping(network, 'phone-courtyard', INTERNET, () => 1).rtt > 0);
          assert.match(ping(network, 'phone-courtyard', 'desktop-pavilion', () => 1).reason, /firewall/);
          assert.deepEqual(reachableServices(network, 'phone-courtyard').map(vm => vm.kind), ['web']);
          assert.deepEqual(reachableServices(network, 'desktop-stem').map(vm => vm.kind), ['dns', 'web', 'file']);
          assert.ok(ping(network, 'phone-pavilion', 'desktop-media', () => 1).rtt > 0);
          for (const disconnected of ['east-fiber', 'east-spare']) {
            const cables = plan.cables.filter(cable => cable.id !== disconnected);
            assert.ok(ping(paths({ ...plan, cables }), 'desktop-media', INTERNET, () => 1).rtt > 0);
          }
        """
        subprocess.run(["node", "-e", check_network], cwd=root, timeout=10, check=True, text=True,
                       input=json.dumps({"plan": site, "catalog": CABLING_CATALOG, "limits": CABLING_LIMITS}))

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

    def test_packet_and_infra_access_are_independent_by_class_and_school(self):
        teacher = {"X-Teacher-Token": "teacher-token"}
        student = {"X-User-Token": "student-token"}
        admin = {"X-Admin-Token": "admin-token"}
        settings = "/api/network/teacher/classes/class-1/settings"
        bootstrap = "/api/network/bootstrap"
        packet = "/api/network/examples/simple-lan"
        infra = "/api/network/wifi-starter"
        saved = self.client.put(settings, headers=teacher, json={"access": {"packet": True, "infra": False}})
        self.assertEqual(saved.json["data"]["access"], {"packet": True, "infra": False})
        self.assertEqual(self.client.get(bootstrap, headers=student).json["data"]["modes"], {"packet": True, "infra": False})
        self.assertEqual(self.client.get(packet, headers=student).status_code, 200)
        self.assertEqual(self.client.post(infra, headers=student).status_code, 403)
        saved = self.client.put(settings, headers=teacher, json={"access": {"packet": False, "infra": True}})
        self.assertEqual(saved.json["data"]["access"], {"packet": False, "infra": True})
        self.assertEqual(self.client.get(packet, headers=student).status_code, 403)
        self.assertEqual(self.client.post(infra, headers=student).status_code, 200)
        self.config_state.update(packet_sim_enabled=True, infra_sim_enabled=False)
        self.assertEqual(self.client.get(bootstrap, headers=student).status_code, 403)
        self.assertEqual(self.client.get(packet, headers=teacher).status_code, 200)
        self.assertEqual(self.client.post(infra, headers=teacher).status_code, 403)
        self.assertEqual(self.client.post(infra, headers=admin).status_code, 200)

    def test_guest_starter_checks_are_transient_and_respect_guest_toggle(self):
        url = "/api/network/wifi-starter"
        course = self.client.post(url).json["data"]
        site = course["site"]
        site["walls"] = [
            {"id": str(i), "a": {"x": ax, "y": ay}, "b": {"x": bx, "y": by}, "material": material}
            for i, (ax, ay, bx, by, material) in enumerate([
                (0, 0, 14, 0, "drywall"), (14, 0, 14, 10, "drywall"),
                (14, 10, 0, 10, "drywall"), (0, 10, 0, 0, "drywall"), (8, 0, 8, 10, "concrete"),
            ])
        ]
        payload = {"site": site, "progress": course["progress"]}
        result = self.client.post(url + "/check", json=payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["data"]["progress"]["completed"], 1)
        self.assertTrue(result.cache_control.no_store)
        self.assertEqual(self.client.post(url).json["data"]["progress"]["completed"], 0)
        self.assertEqual(self.client.put(url, json=payload).status_code, 401)
        self.assertFalse(self.store._wifi_path("").exists())
        self.config_state["infra_sim_guest_enabled"] = False
        self.assertEqual(self.client.get("/api/network/bootstrap").json["data"]["modes"], {"packet": True, "infra": False})
        self.assertEqual(self.client.post(url, json=payload).status_code, 403)
        self.assertEqual(self.client.post(url + "/check", json=payload).status_code, 403)
        self.assertEqual(self.client.post("/api/network/wifi-scenarios/maple-lane-house").status_code, 404)
        self.assertEqual(self.client.post(url, headers={"X-Teacher-Token": "teacher-token"}).status_code, 200)

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

    def test_scenario_catalog_orders_starters_by_scope_and_locks_their_floor_plans(self):
        expected = [
            "maple-lane-house", "juniper-main-coffee", "port-adelaide-community-center", "suntrail-motor-lodge",
            "alder-ridge-high-school", "rivermill-fabrication-works", "harborline-stadium",
            "briar-glen-insurance-campus", "marshpoint-regional-hospital",
        ]
        teacher = {"X-Teacher-Token": "teacher-token"}
        catalog = self.client.get("/api/network/bootstrap", headers=teacher).json["data"]["scenarios"]
        self.assertEqual([item["id"] for item in catalog], expected)
        for scenario_id in expected:
            with self.subTest(scenario=scenario_id):
                scenario = self.client.get(f"/api/network/wifi-scenarios/{scenario_id}", headers=teacher)
                self.assertEqual(scenario.status_code, 200)
                self.assertTrue(scenario.json["data"]["site"]["floor_locked"])

    def test_teacher_saves_class_access_and_scenario_changes_together(self):
        scenario_id = "port-adelaide-community-center"
        class_url = "/api/network/teacher/classes/class-1"
        access_url = "/api/network/access"
        teacher = {"X-Teacher-Token": "teacher-token"}
        student = {"X-User-Token": "student-token"}
        changes = {"enabled": True, "scenario_visibility": {scenario_id: False}}
        denied = self.client.get(access_url, headers=student)
        self.assertEqual(denied.status_code, 403)
        self.assertTrue(denied.cache_control.no_store)
        self.assertEqual(self.client.put(class_url + "/settings", headers=student, json=changes).status_code, 401)
        self.assertEqual(self.client.put(class_url.replace("class-1", "class-2") + "/settings",
                                         headers=teacher, json=changes).status_code, 403)
        invalid = {**changes, "scenario_visibility": {scenario_id: "false"}}
        self.assertEqual(self.client.put(class_url + "/settings", headers=teacher, json=invalid).status_code, 400)
        self.assertFalse(self.store.class_access("class-1"))

        saved = self.client.put(class_url + "/settings", headers=teacher, json=changes)
        self.assertEqual(saved.status_code, 200)
        self.assertTrue(saved.json["data"]["enabled"])
        self.assertFalse(saved.json["data"]["scenario_visibility"][scenario_id])
        classroom = self.client.get(class_url, headers=teacher).json["data"]
        self.assertTrue(classroom["enabled"])
        self.assertFalse(next(item for item in classroom["scenarios"] if item["id"] == scenario_id)["visible"])
        allowed = self.client.get(access_url, headers=student)
        self.assertEqual(allowed.json["data"], {"role": "student"})
        self.assertTrue(allowed.cache_control.private and allowed.cache_control.no_store)
        self.assertEqual(self.client.get(f"/api/network/wifi-scenarios/{scenario_id}", headers=student).status_code, 404)

    def test_scenario_visibility_checks_class_ownership_and_student_access(self):
        scenario_id = "port-adelaide-community-center"
        scenario_url = f"/api/network/wifi-scenarios/{scenario_id}"
        settings_url = f"/api/network/teacher/classes/class-1/scenarios/{scenario_id}"
        teacher = {"X-Teacher-Token": "teacher-token"}
        student = {"X-User-Token": "student-token"}
        self.store.set_class_access("class-1", True)
        self.assertEqual(self.client.get(scenario_url).status_code, 200)
        catalog = self.client.get("/api/network/bootstrap", headers=student).get_json()["data"]["scenarios"]
        row = next(item for item in catalog if item["id"] == scenario_id)
        self.assertNotIn("site", row)
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 200)
        self.assertEqual(self.client.put(settings_url, headers=student, json={"visible": False}).status_code, 401)
        self.assertEqual(self.client.put(settings_url.replace("class-1", "class-2"), headers=teacher,
                                         json={"visible": False}).status_code, 403)
        self.assertEqual(self.client.put(settings_url, headers=teacher, json={"visible": "false"}).status_code, 400)
        self.assertEqual(self.client.put(settings_url, headers=teacher, json={"visible": False}).status_code, 200)
        classroom = self.client.get("/api/network/teacher/classes/class-1", headers=teacher).get_json()["data"]
        self.assertFalse(next(item for item in classroom["scenarios"] if item["id"] == scenario_id)["visible"])
        visible = self.client.get("/api/network/bootstrap", headers=student).get_json()["data"]["scenarios"]
        self.assertEqual([row["id"] for row in visible], [key for key in SCENARIOS if key != scenario_id])
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 404)
        self.assertEqual(self.client.get(scenario_url, headers=teacher).status_code, 200)
        self.students["student-token"]["class_ids"].append("class-2")
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 404)
        self.store.set_class_access("class-2", True)
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 200)
        self.store.set_class_access("class-2", False)
        self.assertEqual(self.client.put(settings_url, headers=teacher, json={"visible": True}).status_code, 200)
        self.assertEqual(self.client.get(scenario_url, headers=student).status_code, 200)

    def test_starting_a_scenario_immediately_saves_separate_private_attempts(self):
        scenario_id = "maple-lane-house"
        url = f"/api/network/wifi-scenarios/{scenario_id}"
        student = {"X-User-Token": "student-token"}
        self.store.set_class_access("class-1", True)
        guest = self.client.post(url)
        self.assertEqual(guest.status_code, 200)
        self.assertIn("briefing", guest.json["data"])
        self.assertFalse(self.store._wifi_path("").exists())
        first = self.client.post(url, headers=student)
        second = self.client.post(url, headers=student)
        self.assertEqual((first.status_code, second.status_code), (201, 201))
        a, b = (response.json["data"]["site"] for response in (first, second))
        self.assertNotEqual(a["id"], b["id"])
        self.assertTrue(a["title"].endswith("Attempt 1"))
        self.assertTrue(b["title"].endswith("Attempt 2"))
        self.assertEqual((a["revision"], b["revision"]), (1, 1))
        listing = self.client.get("/api/network/wifi-sites", headers=student).json["data"]
        self.assertEqual([row["id"] for row in listing], [b["id"], a["id"]])
        self.store.set_scenario_visibility("class-1", scenario_id, False)
        self.assertEqual(self.client.post(url, headers=student).status_code, 404)
        project = f"/api/network/wifi-sites/{a['id']}"
        self.assertEqual(self.client.get(project, headers=student).status_code, 200)
        modified = self.client.put(project, headers=student, json={"revision": 1, "site": {**a, "title": "My attempt"}})
        self.assertEqual(modified.json["data"]["revision"], 2)
        self.assertEqual(modified.json["data"]["scenario_id"], scenario_id)
        self.assertEqual(self.client.get(project, headers={"X-Teacher-Token": "teacher-token"}).status_code, 404)

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

    def test_starter_labs_persist_progress_and_authorize_the_roster(self):
        import wifi_starter_labs as starter

        url = "/api/network/wifi-starter"
        student = {"X-User-Token": "student-token"}
        teacher = {"X-Teacher-Token": "teacher-token"}
        guest = self.client.post(url)
        self.assertEqual(guest.status_code, 200)
        self.assertTrue(guest.json["data"]["guest"])
        self.assertEqual(self.client.post(url, headers=student).status_code, 403)
        self.store.set_class_access("class-1", True)
        opened = self.client.post(url, headers=student)
        self.assertEqual(opened.status_code, 200)
        self.assertTrue(opened.cache_control.no_store)
        course = opened.json["data"]
        self.assertEqual(len(course["lessons"]), len(starter.LESSONS))
        self.assertEqual(self.client.post(url, headers=student).json["data"]["site"]["revision"], 1)
        self.assertEqual(self.client.get("/api/network/wifi-sites", headers=student).json["data"], [])

        def wall(id, a, b, material):
            return dict(id=id, a=dict(zip(("x", "y"), a)), b=dict(zip(("x", "y"), b)), material=material)

        site = course["site"]
        site["starter_progress"] = {"completed": len(starter.LESSONS)}
        site["walls"] = [wall(f"wall-{i}", a, b, "drywall") for i, (a, b) in enumerate(zip(starter.SHELL, starter.SHELL[1:]))]
        saved = self.client.put(url, json={"site": site, "revision": 1, "evidence": ["pdf"]}, headers=student)
        self.assertEqual(saved.status_code, 200, saved.json)
        self.assertEqual(saved.json["data"]["progress"]["completed"], 0)
        self.assertEqual(saved.json["data"]["progress"]["checked"], ["shell"])

        site["walls"].append(wall("partition", *starter.WALL, "concrete"))
        payload = {"site": site, "revision": 2}
        saved = self.client.put(url, json=payload, headers=student)
        self.assertEqual(saved.json["data"]["progress"]["completed"], 1)
        self.assertEqual(self.client.put(url, json=payload, headers=student).json, saved.json)
        self.assertEqual(self.client.put(url, json={**payload, "site": {**site, "title": "Conflict"}}, headers=student).status_code, 409)
        resumed = self.client.post(url, headers=student).json["data"]
        self.assertEqual(len(resumed["site"]["walls"]), 5)
        self.assertEqual(resumed["progress"]["completed"], 1)
        roster = self.client.get("/api/network/teacher/classes/class-1", headers=teacher).json["data"]["starter_roster"]
        self.assertEqual(roster[0]["progress"]["completed"], 1)
        self.assertNotIn("site", roster[0])
        self.assertEqual(self.client.get("/api/network/teacher/classes/class-1", headers=student).status_code, 401)

        self.store.set_class_access("class-1", False)
        self.assertEqual(self.client.put(url, json={**payload, "revision": 3}, headers=student).status_code, 403)
        email = self.students["student-token"]["email"]
        self.store.delete_account_wifi(email)
        self.assertEqual(self.store.wifi_starter_progress(email)["completed"], 0)

    def test_starter_lesson_restart_and_course_repeat_preserve_the_right_work(self):
        import wifi_starter_labs as starter

        self.store.set_class_access("class-1", True)
        headers = {"X-User-Token": "student-token"}
        url = "/api/network/wifi-starter"
        course = self.client.post(url, headers=headers).json["data"]

        def wall(id, a, b, material):
            return dict(id=id, a=dict(zip(("x", "y"), a)), b=dict(zip(("x", "y"), b)), material=material)

        site = course["site"]
        site["walls"] = [wall(f"wall-{i}", a, b, "drywall") for i, (a, b) in enumerate(zip(starter.SHELL, starter.SHELL[1:]))]
        site["walls"].append(wall("partition", *starter.WALL, "concrete"))
        result = self.client.put(url, headers=headers, json={"site": site, "revision": 1})
        self.assertEqual(result.json["data"]["progress"]["completed"], 1)
        self.assertTrue(result.json["data"]["progress"]["can_restart"])

        site["openings"] = [{"id": "door", "wall_id": "partition", "kind": "door", "material": "wood", "t": 0.6, "width": 1}]
        partial = {"site": site, "revision": 2}
        result = self.client.put(url, headers=headers, json=partial)
        self.assertEqual(result.json["data"]["progress"]["checked"], ["door"])
        self.assertEqual(self.client.post(url, headers=headers,
                                         json={"reset": "lesson", "revision": 3, "lesson": 0}).status_code, 409)
        restart = {"reset": "lesson", "revision": 3, "lesson": 1}
        restored = self.client.post(url, headers=headers, json=restart)
        self.assertEqual(restored.status_code, 200, restored.json)
        self.assertEqual(restored.json["data"]["site"]["openings"], [])
        self.assertEqual(len(restored.json["data"]["site"]["walls"]), 5)
        self.assertEqual(restored.json["data"]["progress"]["completed"], 1)
        self.assertEqual(self.client.post(url, headers=headers, json=restart).json, restored.json)
        self.assertEqual(self.client.put(url, headers=headers, json={**partial, "revision": 3}).status_code, 409)

        repeat = {"reset": "course", "revision": 4}
        repeated = self.client.post(url, headers=headers, json=repeat)
        self.assertEqual(repeated.status_code, 200, repeated.json)
        reply = repeated.json["data"]
        self.assertEqual(reply["site"]["walls"], [])
        self.assertEqual(reply["progress"]["completed"], 0)
        self.assertEqual(reply["progress"]["best_completed"], 1)
        self.assertEqual(reply["progress"]["attempt"], 2)
        self.assertEqual(self.client.post(url, headers=headers, json=repeat).json, repeated.json)

        saved = self.client.get("/api/network/wifi-sites", headers=headers).json["data"]
        self.assertEqual(len(saved), 1)
        self.assertIn("Starter Labs attempt 1", saved[0]["title"])
        archive = self.client.get(f"/api/network/wifi-sites/{saved[0]['id']}", headers=headers).json["data"]
        self.assertEqual(len(archive["walls"]), 5)
        self.assertFalse(any(key.startswith("starter_") for key in archive))
        roster = self.client.get("/api/network/teacher/classes/class-1", headers={"X-Teacher-Token": "teacher-token"}).json["data"]["starter_roster"]
        self.assertEqual(roster[0]["progress"]["best_completed"], 1)
        with patch.dict("network_store.WIFI_LIMITS", {"saved": 1}):
            full = self.client.post(url, headers=headers, json={"reset": "course", "revision": 5})
        self.assertEqual(full.status_code, 400, full.json)
        self.assertIn("Saved Sites is full", full.json["error"])
        self.assertEqual(self.client.post(url, headers=headers).json["data"], reply)

    def test_wifi_pdf_download_uses_authenticated_author_and_is_not_cached(self):
        self.store.set_class_access('class-1', True)
        self.students['student-token']['name'] = 'Alice Example'
        image = io.BytesIO()
        Image.new('RGB', (180, 100), '#dbe5ec').save(image, 'JPEG')
        url = '/api/network/wifi-export.pdf'
        encoded = base64.b64encode(image.getvalue()).decode()
        payload = {
            'image': encoded, 'coverage_image': encoded, 'title': 'My civic plan', 'units': 'ft',
            'drawing_width': 180, 'date': '2026-11-13', 'author': 'Other person',
            'notes': [{'point': [.1, .1], 'name': 'Reception'}],
            'aps': [{'kind': 'access_point', 'point': [.25, .5], 'name': 'North AP', 'powered': True,
                     'details': ['Staff Wireless (5 GHz)', 'Guest Wireless (2.4 GHz)']}],
            'equipment': [
                {'kind': 'phone', 'point': [.4, .4], 'name': 'Front desk mobile',
                 'details': ['IP 10.18.0.2/24', 'Subnet 10.18.0.0/24', 'SSID Staff Wireless']},
                {'kind': 'poe_camera', 'point': [.65, .6], 'name': 'Entry camera', 'powered': True,
                 'cone': [[.65, .6], [.7, .8], [.8, .65]]},
                {'kind': 'server', 'name': 'Print host', 'mounted': True, 'point': [.5, .5],
                 'services': ['Print · 10.18.0.4 · VLAN 20']},
            ],
            'cables': [{'name': 'Hall ceiling drop', 'media': 'ethernet', 'color': '#224488',
                        'source': 'Lobby switch ETH1', 'target': 'North AP ETH1', 'length': 35.4,
                        'points': [[.15, .45], [.25, .45], [.25, .5]]}],
        }
        sheets = [[]]

        class RecordingCanvas(Canvas):
            def drawString(self, x, y, text, *args, **kwargs):
                sheets[-1].append(text)
                super().drawString(x, y, text, *args, **kwargs)

            def showPage(self):
                super().showPage()
                sheets.append([])
        headers = {'X-User-Token': 'student-token'}
        with patch('wifi_site_pdf.Canvas', RecordingCanvas), self.client.post(url, json=payload, headers=headers) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, 'application/pdf')
            self.assertIn('My civic plan.pdf', response.headers['Content-Disposition'])
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertTrue(response.data.startswith(b'%PDF'))
            self.assertIn(b'/Author (Alice Example)', response.data)
            self.assertNotIn(b'Other person', response.data)
        self.assertEqual(len(sheets[:-1]), 4)
        drawing, wifi, cameras, schedules = (' '.join(sheet) for sheet in sheets[:-1])
        for label in ('Network layout', 'North AP', 'Entry camera', 'Front desk mobile', 'IP 10.18.0.2/24',
                      'Subnet 10.18.0.0/24', 'SSID Staff Wireless', 'W01'):
            self.assertIn(label, drawing)
        for label in ('Wi-Fi coverage', 'North AP', 'Staff Wireless (5 GHz)', 'Guest Wireless (2.4 GHz)'):
            self.assertIn(label, wifi)
        self.assertIn('Camera coverage', cameras)
        self.assertIn('Entry camera', cameras)
        self.assertNotIn('Front desk mobile', wifi + cameras)
        self.assertNotIn('Entry camera', wifi)
        self.assertNotIn('North AP', cameras)
        for sheet in (drawing, wifi, cameras):
            self.assertIn('Reception', sheet)
            self.assertIn(' ft', sheet)
            self.assertNotIn('Cable schedule', sheet)
            self.assertNotIn('Device inventory', sheet)
            self.assertNotIn('Hall ceiling drop', sheet)
        for label in ('Cable schedule', 'Device inventory', 'W01', 'Hall ceiling drop', 'Lobby switch ETH1',
                      'North AP ETH1', '35.4 ft', 'D01', 'Front desk mobile', 'Wireless phone',
                      'IP 10.18.0.2/24', 'D02', 'Entry camera', 'A01', 'North AP', 'Staff Wireless (5 GHz)'):
            self.assertIn(label, schedules)
        self.assertIn('Print · 10.18.0.4 · VLAN 20', schedules)

        sheets[:] = [[]]
        dense = {**payload,
                 'cables': [{**payload['cables'][0], 'name': f'Route {i:03}'} for i in range(48)],
                 'equipment': [{**payload['equipment'][0], 'name': f'Client {i:03}'} for i in range(48)]}
        with patch('wifi_site_pdf.Canvas', RecordingCanvas), self.client.post(url, json=dense, headers=headers) as response:
            self.assertEqual(response.status_code, 200)
        self.assertGreater(len(sheets[:-1]), 4)
        self.assertIn('Route 000', ' '.join(sheets[3]))
        self.assertIn('Client 000', ' '.join(sheets[3]))
        self.assertIn('Route 047', ' '.join(text for page in sheets[4:-1] for text in page))
        self.assertIn('Client 047', ' '.join(text for page in sheets[4:-1] for text in page))
        sheets[:] = [[]]
        rack_report = {**payload, "equipment": [*payload["equipment"], {
            "name": "West IDF", "kind": "rack", "rack_id": "west-idf", "point": [.25, .25],
        }], "racks": [{
            "id": "west-idf", "name": "West IDF", "power": {"watts": 50, "minutes": 104, "overloaded": False},
            "devices": [
                {"id": "panel", "kind": "patch_panel", "name": "Building header", "u": 16,
                 "ports": [{"id": "FRONT1", "connected": True, "destination": "North AP"}]},
                {"id": "switch", "kind": "distribution_switch", "name": "Floor switch", "u": 14,
                 "ports": [{"id": "ETH1", "connected": True}]},
                {"id": "ups", "kind": "ups", "name": "Battery backup", "u": 1, "ports": []},
            ],
            "patches": [{"source": {"device_id": "panel", "port": "FRONT1"},
                         "target": {"device_id": "switch", "port": "ETH1"},
                         "media": "ethernet", "color": "#224488", "label": "Patch to AP"}],
        }], "bill": {"rack": 1, "ethernet": 10, "patch_ethernet": 1}}
        with patch('wifi_site_pdf.Canvas', RecordingCanvas), self.client.post(url, json=rack_report, headers=headers) as response:
            self.assertEqual(response.status_code, 200)
        self.assertEqual(len(sheets[:-1]), 6)
        for sheet in sheets[:3]:
            diagram = ' '.join(sheet)
            for label in ("Rack equipment", "D04  West IDF", "U16 Building header",
                          "U14 Floor switch", "U1-U2 Battery backup"):
                self.assertIn(label, diagram)
        for label in ("Rack elevation", "West IDF", "104 MIN", "FRONT1", "Patch to AP", "North AP"):
            self.assertIn(label, ' '.join(sheets[4]))
        for label in ("Bill of Materials", "32.81 ft", "Estimated total", "$391.80"):
            self.assertIn(label, ' '.join(sheets[5]))
        self.assertEqual(self.client.post(url, json={**payload, 'image': 'invalid'}, headers=headers).status_code, 400)
        bad = {**payload, 'notes': [{'point': [-1, .25], 'name': 'Outside'}]}
        self.assertEqual(self.client.post(url, json=bad, headers=headers).status_code, 400)
        self.store.set_class_access('class-1', False)
        self.assertEqual(self.client.post(url, json=payload, headers=headers).status_code, 403)

    def test_legacy_routed_copper_can_reopen_and_shorten(self):
        email = "legacy-infra@example.test"
        route = {"id": "old-run", "source": {"device_id": "switch", "port": "ETH1"},
                 "target": {"device_id": "ap-1", "port": "ETH1"}, "media": "ethernet",
                 "color": "#225588", "label": "", "waypoints": []}
        legacy = {**self.wifi_plan(), "id": "original", "revision": 3, "updated_at": 1200, "schema_version": 11,
                  "walls": [], "equipment": [{"id": "switch", "kind": "distribution_switch", "x": 0, "y": 0, "name": "Existing"}],
                  "cables": [route]}
        legacy["access_points"][0].update(x=100, y=0)
        self.store._write_json(self.store._wifi_path(email), {"sites": {"original": legacy}}, compact=True)
        opened = self.store.get_wifi_site(email, "original")
        self.assertEqual(opened["cables"][0]["legacy_length"], 100)
        opened["title"] = "Legacy design"
        self.store.save_wifi_site(email, "original", opened, 3)
        opened["access_points"][0]["x"] = 110
        with self.assertRaisesRegex(NetworkDataError, "capacity reached"):
            self.store.save_wifi_site(email, "original", opened, 4)
        opened["access_points"][0]["x"] = 89
        shortened = self.store.save_wifi_site(email, "original", opened, 4)
        self.assertNotIn("legacy_length", shortened["cables"][0])
        with self.assertRaisesRegex(NetworkDataError, "equipment rack"):
            self.store.save_wifi_site("new-project@example.test", "fresh", legacy, 0)

    def test_infra_rack_slots_port_faces_and_copper_limit(self):
        url = "/api/network/wifi-sites/rack-lab"
        headers = {"X-Teacher-Token": "teacher-token"}
        plan = {**self.wifi_plan(), "walls": []}
        plan["access_points"][0].update(x=90, y=0)
        plan["equipment"] = [
            {"id": "rack", "kind": "rack", "name": "West rack", "x": 0, "y": 0},
            {"id": "switch", "kind": "distribution_switch", "name": "Switch", "rack_id": "rack", "rack_u": 14},
            {"id": "panel", "kind": "patch_panel", "name": "Panel", "rack_id": "rack", "rack_u": 16},
            {"id": "ups", "kind": "ups", "name": "Backup", "rack_id": "rack", "rack_u": 1},
        ]
        plan["cables"] = [
            {"id": "run", "source": {"device_id": "ap-1", "port": "ETH1"},
             "target": {"device_id": "panel", "port": "BACK1"}, "media": "ethernet",
             "color": "#225588", "label": "", "waypoints": []},
            {"id": "patch", "source": {"device_id": "switch", "port": "ETH1"},
             "target": {"device_id": "panel", "port": "FRONT1"}, "media": "ethernet",
             "color": "#225588", "label": "", "waypoints": [], "rack_patch": True},
        ]
        saved = self.client.put(url, headers=headers, json={"site": plan, "revision": 0})
        self.assertEqual(saved.status_code, 200, saved.json)
        self.assertTrue(saved.json["data"]["cables"][1]["rack_patch"])
        for collection, index, key, value, error in (
            ("equipment", 2, "rack_u", 14, "overlap"),
            ("equipment", 3, "rack_u", 16, "mounting position"),
            ("cables", 0, "target", {"device_id": "panel", "port": "FRONT2"}, "rear"),
            ("access_points", 0, "x", 90.01, "capacity reached"),
            ("access_points", 0, "radios", {"2.4": {"channel": 6, "width": 20},
                                            "5": {"channel": 165, "width": 80}}, "channel and width"),
        ):
            bad = copy.deepcopy(plan)
            bad[collection][index][key] = value
            with self.subTest(key=key, value=value):
                response = self.client.put(url, headers=headers, json={"site": bad, "revision": 1})
                self.assertEqual(response.status_code, 400, response.json)
                self.assertIn(error, response.json["error"])
        plan["equipment"][1]["rack_u"] = 15
        plan["equipment"][2]["rack_u"] = 13
        moved = self.client.put(url, headers=headers, json={"site": plan, "revision": 1})
        self.assertEqual(moved.status_code, 200, moved.json)
        self.assertEqual([item["rack_u"] for item in moved.json["data"]["equipment"][1:3]], [15, 13])
        self.assertEqual(moved.json["data"]["cables"], saved.json["data"]["cables"])

        plan["equipment"][0]["x"] = 10
        relocated = self.client.put(url, headers=headers, json={"site": plan, "revision": 2})
        self.assertEqual(relocated.status_code, 200, relocated.json)
        self.assertEqual(relocated.json["data"]["equipment"][2]["x"], 10)
        self.assertEqual(relocated.json["data"]["cables"], saved.json["data"]["cables"])

    def test_infra_server_vms_persist_and_validate_addresses_types_and_vlans(self):
        url = "/api/network/wifi-sites/service-lab"
        headers = {"X-Teacher-Token": "teacher-token"}
        plan = self.wifi_plan()
        plan["vlans"] = [{"id": 20, "name": "Services"}]
        plan["equipment"] = [
            {"id": "rack", "kind": "rack", "x": 0, "y": 0},
            {"id": "router", "kind": "router", "rack_id": "rack", "rack_u": 16},
            {"id": "host", "kind": "server", "rack_id": "rack", "rack_u": 12, "services": [
                {"kind": "dns", "vlan": 0},
                {"kind": "web", "vlan": 20, "ip": " 192.168.0.21 "},
            ]},
            {"id": "client", "kind": "desktop", "x": 2, "y": 0,
             "reservation": {"router_id": "router", "ip": "192.168.0.22"}},
        ]
        saved = self.client.put(url, headers=headers, json={"site": plan, "revision": 0})
        self.assertEqual(saved.status_code, 200, saved.json)
        self.assertEqual(self.client.get(url, headers=headers).json["data"]["equipment"][2]["services"], [
            {"kind": "dns", "vlan": 0, "ip": ""},
            {"kind": "web", "vlan": 20, "ip": "192.168.0.21"},
        ])
        for entry, reason in (
            ({"kind": "unknown", "ip": ""}, "catalog"),
            ({"kind": "dns", "ip": ""}, "distinct"),
            ({"vlan": 30}, "defined VLAN"),
            ({"ip": "127.0.0.1"}, "unicast IPv4"),
            ({"ip": "192.168.0.1"}, "unique"),
            ({"ip": "192.168.0.22"}, "unique"),
        ):
            with self.subTest(entry=entry):
                bad = copy.deepcopy(plan)
                bad["equipment"][2]["services"][1].update(entry)
                invalid = self.client.put(url, headers=headers, json={"site": bad, "revision": 1})
                self.assertEqual(invalid.status_code, 400, invalid.json)
                self.assertIn(reason, invalid.json["error"])
        bad = copy.deepcopy(plan)
        bad["equipment"][3]["services"] = [{"kind": "dns", "vlan": 0}]
        invalid = self.client.put(url, headers=headers, json={"site": bad, "revision": 1})
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("rack server", invalid.json["error"])
        old_editor = {**plan, "schema_version": 12}
        old_editor["equipment"][2].pop("services")
        stale = self.client.put(url, headers=headers, json={"site": old_editor, "revision": 1})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(validate_wifi_site(old_editor)["schema_version"], WIFI_SCHEMA_VERSION)
        self.assertNotIn("services", validate_wifi_site(old_editor)["equipment"][2])

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

    def test_infra_project_file_opens_as_a_new_draft_and_compact_save_acknowledges_revision(self):
        path = "/api/network/wifi-project/validate"
        plan = {**self.wifi_plan(), "id": "someone-elses-site", "revision": 14,
                "scenario_id": "maple-lane-house"}
        envelope = {"format": "eagleide-infra-project", "project": plan}
        imported = self.client.post(path, json=envelope)
        self.assertEqual(imported.status_code, 200, imported.json)
        draft = imported.json["data"]
        self.assertFalse({"id", "revision", "scenario_id"} & draft.keys())
        self.assertFalse(self.store._wifi_path("").exists())
        self.assertEqual(self.client.post(path, json={"format": "other", "project": plan}).status_code, 400)
        self.assertEqual(self.client.post(path, data=b"x" * 2_000_001, content_type="application/json").status_code, 413)
        teacher = {"X-Teacher-Token": "teacher-token"}
        url = "/api/network/wifi-sites/imported"
        saved = self.client.put(url + "?summary=1", headers=teacher, json={"site": draft, "revision": 0})
        self.assertEqual(saved.status_code, 200, saved.json)
        self.assertEqual(set(saved.json["data"]), {"id", "revision", "updated_at"})
        self.assertEqual(self.client.get(url, headers=teacher).json["data"]["title"], plan["title"])
        self.assertEqual(self.client.get(url, headers={"X-Admin-Token": "admin-token"}).status_code, 404)
        old = {**self.wifi_plan(), "schema_version": 11, "id": "older", "revision": 1, "updated_at": 10,
               "equipment": [{"id": "loose", "kind": "router", "x": 0, "y": 0}]}
        legacy_file = {"format": envelope["format"], "project": validate_wifi_site(old)}
        self.store._write_json(self.store._wifi_path("teacher@example.com"), {"sites": {"older": old}})
        self.assertEqual(self.client.post(path, headers=teacher, json=legacy_file).status_code, 200)
        self.assertEqual(self.client.post(path, json=legacy_file).status_code, 400)
        self.config_state["network_sim_enabled"] = False
        self.assertEqual(self.client.post(path, json=envelope).status_code, 403)

    def test_infra_account_checks_do_not_read_sites_and_storage_failure_is_recoverable(self):
        headers = {"X-User-Token": "student-token"}
        self.assertEqual(self.client.get("/api/network/access", headers=headers).status_code, 403)
        self.store.set_class_access("class-1", True)
        path = self.store._wifi_path("student@example.com")
        path.parent.mkdir(parents=True)
        corrupt = '{"sites": {"broken": null}}'
        path.write_text(corrupt, encoding="utf-8")
        self.assertEqual(self.client.get("/api/network/access", headers=headers).json["data"], {"role": "student"})
        hub = self.client.get("/api/network/bootstrap", headers=headers)
        self.assertEqual(hub.status_code, 200)
        self.assertFalse(hub.json["data"]["wifi_storage_available"])
        self.assertTrue(hub.json["data"]["practice_labs"])
        self.assertEqual(self.client.get("/api/network/wifi-sites", headers=headers).status_code, 503)
        url = "/api/network/wifi-sites/new"
        self.assertEqual(self.client.put(url, headers=headers, json={"site": self.wifi_plan(), "revision": 0}).status_code, 503)
        self.assertEqual(path.read_text(encoding="utf-8"), corrupt)

        self.store.save_wifi_site("teacher@example.com", "keep", self.wifi_plan(), 0)
        self.store.delete_account_wifi("student@example.com")
        self.assertEqual(self.store.list_wifi_sites("student@example.com"), [])
        self.assertTrue(self.store.get_wifi_site("teacher@example.com", "keep"))
        with patch.object(self.store, "student_modes", side_effect=[
            {"packet": True, "infra": True}, {"packet": True, "infra": False},
        ]):
            revoked = self.client.put(url, headers=headers, json={"site": self.wifi_plan(), "revision": 0})
        self.assertEqual(revoked.status_code, 403)
        self.assertFalse(path.exists())

    def wifi_plan(self):
        return {
            "schema_version": WIFI_SCHEMA_VERSION, "title": "Two rooms",
            "units": "ft", "band": "5",
            "walls": [{"id": "wall-1", "a": {"x": 20, "y": 4}, "b": {"x": 20, "y": 24}, "material": "concrete"}],
            "access_points": [{"id": "ap-1", "x": 11, "y": 14, "mount": "wall", "angle": 90, "name": "Hall AP", "power_db": 0,
                               "radios": {"2.4": {"channel": 1, "width": 20}, "5": {"channel": 36, "width": 20}},
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

    def test_wifi_floor_lock_survives_saves_and_legacy_plans_open_unlocked(self):
        url = "/api/network/wifi-sites/floor-lock"
        headers = {"X-Teacher-Token": "teacher-token"}
        plan = self.wifi_plan()
        legacy = {**plan, "schema_version": WIFI_SCHEMA_VERSION - 1}
        self.assertFalse(validate_wifi_site(legacy)["floor_locked"])
        invalid = self.client.put(url, headers=headers, json={"site": {**plan, "floor_locked": 1}, "revision": 0})
        self.assertEqual(invalid.status_code, 400)
        saved = self.client.put(url, headers=headers, json={"site": {**plan, "floor_locked": True}, "revision": 0})
        self.assertEqual(saved.status_code, 200, saved.json)
        self.assertTrue(self.client.get(url, headers=headers).json["data"]["floor_locked"])
        stale_format = self.client.put(url, headers=headers, json={"site": legacy, "revision": 1})
        self.assertEqual(stale_format.status_code, 409)
        plan["access_points"][0]["name"] = "Moved hall AP"
        saved = self.client.put(url, headers=headers, json={"site": {**plan, "floor_locked": True}, "revision": 1})
        self.assertEqual(saved.status_code, 200, saved.json)
        unlocked = self.client.put(url, headers=headers, json={"site": {**plan, "floor_locked": False}, "revision": 2})
        self.assertEqual(unlocked.status_code, 200, unlocked.json)
        self.assertFalse(self.client.get(url, headers=headers).json["data"]["floor_locked"])

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
            {"id": "router", "kind": "router", "rack_id": "rack", "rack_u": 12, "x": 0, "y": 0, "name": "Router",
             "dhcp": {"gateway": "10.0.0.1/29", "dns": "1.1.1.1", "fallback_dns": "8.8.8.8"},
             "firewall": [{"action": "deny", "source_vlan": 20, "destination_vlan": 0,
                           "source_ip": "", "destination_ip": "10.0.0.4/29"}]},
            {"id": "switch", "kind": "distribution_switch", "rack_id": "rack", "rack_u": 14, "x": 0, "y": 0, "name": "Switch",
             "port_vlans": {"ETH1": [0, 20], "ETH24": []}},
            {"id": "phone", "kind": "phone", "x": 0, "y": 2, "name": "Client", "ssid_id": "guest",
             "reservation": {"router_id": "router", "ip": "10.0.0.2"}},
            {"id": "rack", "kind": "rack", "x": 0, "y": 0, "name": "Rack"},
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
