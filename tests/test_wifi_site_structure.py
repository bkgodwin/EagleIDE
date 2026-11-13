import base64
import io
import unittest

from PIL import Image

from network_store import NetworkDataError, validate_wifi_site


class WifiStructureTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            "schema_version": 4, "title": "School", "units": "m", "band": "5",
            "walls": [{"id": "wall", "material": "concrete", "a": {"x": 0, "y": 0}, "b": {"x": 0, "y": 20}}],
            "labels": [], "access_points": [],
            "openings": [{"id": "door", "kind": "door", "material": "wood", "wall_id": "wall", "t": 0.5, "width": 1}],
        }

    def test_opening_span_is_validated_and_must_stay_on_its_wall(self):
        self.assertEqual(validate_wifi_site(self.plan)["openings"], self.plan["openings"])
        other = {**self.plan["openings"][0], "id": "window", "kind": "window", "material": "glass"}
        self.plan["openings"].append(other)
        with self.assertRaisesRegex(NetworkDataError, "cannot overlap"):
            validate_wifi_site(self.plan)
        other["t"] = 0
        with self.assertRaisesRegex(NetworkDataError, "fit on its wall"):
            validate_wifi_site(self.plan)
        other["wall_id"] = "missing"
        with self.assertRaisesRegex(NetworkDataError, "require a wall"):
            validate_wifi_site(self.plan)

    def test_background_accepts_only_bounded_jpeg_and_uses_real_dimensions(self):
        buffer = io.BytesIO()
        Image.new("RGB", (24, 12), "white").save(buffer, "JPEG")
        image = base64.b64encode(buffer.getvalue()).decode()
        self.plan["background"] = {"image": image, "x": -5, "y": 2, "width": 20, "pixel_width": 1000}
        self.assertEqual(validate_wifi_site(self.plan)["background"],
                         {"image": image, "x": -5, "y": 2, "width": 20, "pixel_width": 24, "pixel_height": 12})
        self.plan["background"]["image"] = base64.b64encode(b"<svg/>").decode()
        with self.assertRaisesRegex(NetworkDataError, "valid background"):
            validate_wifi_site(self.plan)
