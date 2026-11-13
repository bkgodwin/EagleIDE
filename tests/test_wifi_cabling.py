import copy
import unittest

from network_store import NetworkDataError, validate_wifi_site
from wifi_cabling import EQUIPMENT, ISPS, PASS_SPACING


def node(device_id, kind, x, y=10):
    return {"id": device_id, "kind": kind, "name": "", "x": x, "y": y}


def cable(number, source, target, *, media="ethernet", bends=()):
    return {
        "id": f"wire-{number}", "label": f"Cable {number}", "color": "#1357aB", "media": media,
        "source": {"device_id": source[0], "port": source[1]},
        "target": {"device_id": target[0], "port": target[1]},
        "waypoints": list(bends),
    }


class WifiCablingTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            "schema_version": 3, "title": "Campus cabling", "units": "m", "band": "5",
            "walls": [{"id": "wall", "material": "concrete", "a": {"x": 0, "y": 0}, "b": {"x": 0, "y": 30}}],
            "labels": [], "access_points": [],
            "equipment": [node("core", "core_switch", -10), node("dist", "distribution_switch", 10)],
            "pass_throughs": [], "cables": [],
        }

    def test_concrete_blocks_straight_and_corner_crossings_without_a_pass(self):
        for bends in ((), ({"x": 0, "y": 10},), ({"x": 0, "y": 8}, {"x": 0, "y": 12})):
            self.plan["cables"] = [cable(1, ("core", "ETH1"), ("dist", "ETH1"), bends=bends)]
            with self.subTest(bends=bends), self.assertRaisesRegex(NetworkDataError, "crosses concrete"):
                validate_wifi_site(self.plan)
        self.plan["pass_throughs"] = [{"id": "opening", "wall_id": "wall", "t": 1 / 3}]
        self.assertEqual(len(validate_wifi_site(self.plan)["cables"]), 1)
        self.plan["walls"][0]["material"] = "reinforced_concrete"
        self.assertEqual(len(validate_wifi_site(self.plan)["cables"]), 1)
        self.plan["pass_throughs"] = []
        with self.assertRaisesRegex(NetworkDataError, "crosses concrete"):
            validate_wifi_site(self.plan)
        self.plan["walls"][0]["material"] = "glass"
        self.assertEqual(len(validate_wifi_site(self.plan)["cables"]), 1)

    def test_wall_spacing_capacity_and_pass_references(self):
        self.plan["pass_throughs"] = [
            {"id": "first", "wall_id": "wall", "t": 1 / 3},
            {"id": "second", "wall_id": "wall", "t": (10 + PASS_SPACING) / 30},
        ]
        self.plan["cables"] = [cable(i, ("core", f"ETH{i}"), ("dist", f"ETH{i}"), bends=({"pass_id": "first"},))
                               for i in range(1, 11)]
        self.assertEqual(len(validate_wifi_site(self.plan)["cables"]), 10)
        self.plan["pass_throughs"][1]["t"] -= 0.01
        with self.assertRaisesRegex(NetworkDataError, "20 feet"):
            validate_wifi_site(self.plan)
        self.plan["pass_throughs"].pop()
        self.plan["cables"].append(cable(11, ("core", "SFP1"), ("dist", "SFP1"), media="fiber"))
        with self.assertRaisesRegex(NetworkDataError, "up to 10 cables"):
            validate_wifi_site(self.plan)
        self.plan["pass_throughs"].clear()
        with self.assertRaisesRegex(NetworkDataError, "missing pass-through"):
            validate_wifi_site(self.plan)

    def test_wall_jack_terminates_on_concrete_and_does_not_need_a_penetration(self):
        self.plan["equipment"].append({"id": "jack", "kind": "keystone", "name": "A-101", "wall_id": "wall", "t": 1 / 3})
        self.plan["cables"] = [
            cable(1, ("core", "ETH48"), ("jack", "BACK")),
            cable(2, ("jack", "FRONT"), ("dist", "ETH24")),
        ]
        self.assertEqual(len(validate_wifi_site(self.plan)["cables"]), 2)
        self.plan["cables"][1]["source"]["port"] = "BACK"
        with self.assertRaisesRegex(NetworkDataError, "only one cable"):
            validate_wifi_site(self.plan)

    def test_isp_media_router_wan_and_redundancy(self):
        self.plan["equipment"] += [
            node("router", "router", -8, 6), node("edge", "access_switch", -7, 15),
            {"id": "fiber-isp", "kind": "demarc", "name": "", "isp": "granite", "wall_id": "wall", "t": 0.1},
            {"id": "satellite", "kind": "demarc", "name": "", "isp": "cindersky", "wall_id": "wall", "t": 0.9},
        ]
        self.plan["cables"] = [
            cable(1, ("fiber-isp", "ISP"), ("router", "WAN-SFP1"), media="fiber"),
            cable(2, ("satellite", "ISP"), ("router", "WAN1")),
            cable(3, ("router", "SFP1"), ("core", "SFP1"), media="fiber"),
            cable(4, ("core", "ETH1"), ("edge", "ETH8")),
        ]
        self.assertEqual(len(validate_wifi_site(self.plan)["cables"]), 4)
        self.assertEqual(ISPS["cindersky"]["speed"], 75)
        self.assertFalse(EQUIPMENT["access_switch"]["groups"][0]["poe"])
        for port, error in (("ETH1", "router WAN"), ("WAN-SFP2", "supports this cable type")):
            bad = copy.deepcopy(self.plan)
            bad["cables"][1]["target"]["port"] = port
            with self.subTest(port=port), self.assertRaisesRegex(NetworkDataError, error):
                validate_wifi_site(bad)
        self.plan["cables"][3]["target"]["port"] = "ETH9"
        with self.assertRaisesRegex(NetworkDataError, "supports this cable type"):
            validate_wifi_site(self.plan)
