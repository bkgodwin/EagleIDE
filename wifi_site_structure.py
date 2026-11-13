"""Validation for floor-plan openings and a bounded raster reference image."""

import base64
import binascii
import io
import math
from functools import lru_cache

from PIL import Image


OPENING_MATERIALS = {"door": ("wood", "glass", "metal"), "window": ("glass", "coated_glass")}
MAX_BACKGROUND_BYTES = 450_000


@lru_cache(maxsize=8)
def _jpeg_dimensions(encoded):
    try:
        data = base64.b64decode(encoded, validate=True)
        if len(data) > MAX_BACKGROUND_BYTES or not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
            raise ValueError("Invalid background image")
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "JPEG" or max(image.size) > 2400 or min(image.size) < 1:
                raise ValueError("Invalid background dimensions")
            image.load()
            return image.size
    except (OSError, ValueError, binascii.Error, Image.DecompressionBombError) as exc:
        raise ValueError("Choose a valid background image within the size limit") from exc


def validate_structure(raw, plan, *, limits, seen, number, point, safe_id):
    walls = {wall["id"]: wall for wall in plan["walls"]}
    openings = raw.get("openings", [])
    if not isinstance(openings, list) or len(openings) > limits["openings"]:
        raise ValueError("Too many doors and windows")
    spans = {}
    result = []
    for item in openings:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise ValueError("Invalid door or window")
        object_id = safe_id(item["id"])
        if object_id in seen:
            raise ValueError("Floor plan object IDs must be unique")
        seen.add(object_id)
        kind, material, wall_id = item.get("kind"), item.get("material"), item.get("wall_id")
        if not isinstance(kind, str) or material not in OPENING_MATERIALS.get(kind, ()):
            raise ValueError("Choose a supported door or window material")
        if not isinstance(wall_id, str) or wall_id not in walls:
            raise ValueError("Doors and windows require a wall")
        wall = walls[wall_id]
        length = math.hypot(wall["b"]["x"] - wall["a"]["x"], wall["b"]["y"] - wall["a"]["y"])
        t = number(item.get("t"), 0, 1, "opening location", precision=10)
        width = number(item.get("width"), 0.3, 8, "opening width")
        start, end = t * length - width / 2, t * length + width / 2
        if start < -0.0001 or end > length + 0.0001:
            raise ValueError("The door or window must fit on its wall")
        spans.setdefault(wall_id, []).append((start, end))
        result.append({"id": object_id, "wall_id": wall_id, "kind": kind, "material": material, "width": width, "t": t})
    for span in spans.values():
        span.sort()
        if any(right[0] < left[1] - 0.0001 for left, right in zip(span, span[1:])):
            raise ValueError("Doors and windows cannot overlap")

    background = raw.get("background")
    if background is not None:
        if not isinstance(background, dict):
            raise ValueError("Invalid background image")
        encoded = background.get("image")
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_BACKGROUND_BYTES + 2) // 3):
            raise ValueError("The background image exceeds the size limit")
        pixel_width, pixel_height = _jpeg_dimensions(encoded)
        background = {**point(background), "width": number(background.get("width"), 0.1, 10000, "background width"),
                      "image": encoded, "pixel_width": pixel_width, "pixel_height": pixel_height}
    return {"openings": result, "background": background}
