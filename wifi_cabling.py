"""Physical links and wall penetrations for the Wi-Fi site planner."""

import math
import re


PASS_CAPACITY = 10
PASS_SPACING = 6.096  # 20 feet, in meters.
CROSSING_TOLERANCE = 0.075
EPSILON = 0.0002
COPPER_LIMIT = 90
RACK_UNITS = 16
MAX_RACKS = 32
UPS = {"capacity_wh": 216, "max_w": 1000, "half_load_minutes": 8}
PATCH_LENGTH = 1
CABLING_LIMITS = {"equipment": 256, "pass_throughs": 320, "cables": 512,
                  "bends": 40, "total_bends": 6000}


def _group(prefix, count, media="ethernet", *, speed=None, poe=False, wan=False):
    return {"prefix": prefix, "count": count, "media": media, "speed": speed or (10000 if media == "fiber" else 1000),
            "poe": poe, "wan": wan}


EQUIPMENT = {
    "router": {"name": "Router", "rack_units": 1, "draw_w": 45, "groups": [
        _group("ETH", 4), _group("SFP", 2, "fiber"), _group("WAN", 2, wan=True),
        _group("WAN-SFP", 2, "fiber", wan=True),
    ]},
    "core_switch": {"name": "48-port Core Switch", "poe_budget": 500, "rack_units": 1, "draw_w": 70,
                    "groups": [_group("ETH", 48, poe=True), _group("SFP", 4, "fiber")]},
    "distribution_switch": {"name": "24-port Switch", "poe_budget": 200, "rack_units": 1, "draw_w": 38,
                            "groups": [_group("ETH", 24, poe=True), _group("SFP", 2, "fiber")]},
    "rack": {"name": "Equipment Rack", "groups": []},
    "patch_panel": {"name": "24-port Patch Panel", "rack_units": 1, "groups": [_group("FRONT", 24), _group("BACK", 24)]},
    "ups": {"name": "UPS Unit", "rack_units": 2, "groups": []},
    "server": {"name": "Rack Server", "rack_units": 2, "draw_w": 180, "groups": [_group("ETH", 1)]},
    "access_switch": {"name": "8-port Access Switch", "groups": [_group("ETH", 8)]},
    "keystone": {"name": "Keystone Jack", "wall_mount": True,
                 "groups": [_group("BACK", 0), _group("FRONT", 0)]},
    "demarc": {"name": "ISP Demarcation", "wall_mount": True, "groups": []},
    "access_point": {"name": "Access Point", "poe_draw": 20, "groups": [_group("ETH", 1)]},
    "desktop": {"name": "Desktop", "groups": [_group("ETH", 1)]},
    "phone": {"name": "Mobile Phone", "groups": []},
    "poe_camera": {"name": "PoE Camera", "poe_draw": 12, "mount": "ceiling", "groups": [_group("ETH", 1)]},
    "voip_phone": {"name": "VoIP Phone", "poe_draw": 7, "groups": [_group("ETH", 1)]},
    "pos_terminal": {"name": "POS Terminal", "groups": [_group("ETH", 1)]},
    "copy_machine": {"name": "Copy Machine", "groups": [_group("ETH", 1)]},
}

CLIENT_KINDS = {"server", "desktop", "phone", "poe_camera", "voip_phone", "pos_terminal", "copy_machine"}

ISPS = {
    "alderline": {"name": "Alderline Fiber", "media": "fiber", "speed": 10000, "rtt_ms": 18},
    "granite": {"name": "Granite Metro Networks", "media": "fiber", "speed": 2500, "rtt_ms": 24},
    "meadowlink": {"name": "MeadowLink Broadband", "media": "ethernet", "speed": 1000, "rtt_ms": 30},
    "coppercreek": {"name": "Copper Creek Internet", "media": "ethernet", "speed": 300, "rtt_ms": 38},
    "cindersky": {"name": "CinderSky Satellite", "media": "ethernet", "speed": 75, "rtt_ms": 580},
}

# Representative US hardware budgets in cents, including a populated patch panel.
# Network gear and UPS benchmarks: https://store.ui.com/us/en/
# Server: Dell PowerEdge R760. Copier: Xerox VersaLink B415. POS: Square Terminal.
COST_ITEMS = {
    **{key: {"name": EQUIPMENT[key]["name"], "cents": cents, "unit": "each"}
       for key, cents in {
           "rack": 38000, "router": 37900, "core_switch": 109900, "distribution_switch": 69900,
           "access_switch": 10900, "patch_panel": 17900, "ups": 27900, "server": 298500,
           "keystone": 850, "demarc": 15000, "access_point": 15900, "desktop": 82900,
           "phone": 49900, "poe_camera": 12900, "voip_phone": 9900, "pos_terminal": 33900,
           "copy_machine": 139900,
       }.items()},
    "pass": {"name": "Firestop sleeve and materials", "cents": 4800, "unit": "each"},
    "ethernet": {"name": "Cat6 building cable", "cents": 78, "unit": "m"},
    "fiber": {"name": "Single-mode building fiber", "cents": 165, "unit": "m"},
    "patch_ethernet": {"name": "Ethernet patch cable", "cents": 400, "unit": "m"},
    "patch_fiber": {"name": "Fiber SFP patch cable", "cents": 1100, "unit": "m"},
}

CABLING_CATALOG = {"equipment": EQUIPMENT, "isps": ISPS, "pass_capacity": PASS_CAPACITY, "pass_channels": 8,
                   "rack_units": RACK_UNITS, "max_racks": MAX_RACKS, "ups": UPS, "patch_length": PATCH_LENGTH,
                   "copper_limit": COPPER_LIMIT, "costs": COST_ITEMS, "pass_spacing": PASS_SPACING, "crossing_tolerance": CROSSING_TOLERANCE, "epsilon": EPSILON}


class CablingError(ValueError):
    pass


def _ports(device):
    if device["kind"] == "demarc":
        return {"ISP": ISPS[device["isp"]]}
    return {
        f"{group['prefix']}{i + 1 if group['count'] else ''}": group
        for group in EQUIPMENT[device["kind"]]["groups"]
        for i in range(group["count"] or 1)
    }


class _Wall:
    def __init__(self, wall):
        self.id = wall["id"]
        self.x, self.y = wall["a"]["x"], wall["a"]["y"]
        self.dx, self.dy = wall["b"]["x"] - self.x, wall["b"]["y"] - self.y
        self.length = math.hypot(self.dx, self.dy)
        self.ux, self.uy = self.dx / self.length, self.dy / self.length
        self.left, self.right = sorted((self.x, wall["b"]["x"]))
        self.top, self.bottom = sorted((self.y, wall["b"]["y"]))
        self.concrete = wall["material"] in ("concrete", "reinforced_concrete")

    def point(self, t):
        return self.x + self.dx * t, self.y + self.dy * t

    def crosses(self, points):
        """Yield along-wall intervals where a route switches sides of this finite wall."""
        previous = None
        on_low, on_high = math.inf, -math.inf
        for x, y in points:
            dx, dy = x - self.x, y - self.y
            along = dx * self.ux + dy * self.uy
            side = self.ux * dy - self.uy * dx
            if abs(side) <= EPSILON:
                on_low, on_high = min(on_low, along), max(on_high, along)
                continue
            if previous and (side < 0) != (previous[0] < 0):
                if on_low <= on_high:
                    low, high = on_low, on_high
                else:
                    prior_side, prior_along = previous
                    hit = prior_along + (along - prior_along) * prior_side / (prior_side - side)
                    low = high = hit
                if low <= self.length + EPSILON and high >= -EPSILON:
                    yield max(0, low), min(self.length, high)
            previous = side, along
            on_low, on_high = math.inf, -math.inf


def validate_cabling(raw, plan, *, number, label, point, safe_id, seen, legacy=False, existing=None):
    walls = {item["id"]: _Wall(item) for item in plan["walls"]}
    concrete = [wall for wall in walls.values() if wall.concrete]
    devices = {item["id"]: {**item, "kind": "access_point"} for item in plan["access_points"]}

    def items(kind):
        values = raw.get(kind, [])
        limit = CABLING_LIMITS[kind]
        if not isinstance(values, list) or len(values) > limit:
            raise CablingError(f"A site supports up to {limit} {kind.replace('_', ' ')}")
        for item in values:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                raise CablingError("Invalid cabling object")
            object_id = safe_id(item["id"])
            if object_id in seen:
                raise CablingError("Floor plan object IDs must be unique")
            seen.add(object_id)
            yield object_id, item

    def anchor(value, *, penetration=False):
        wall_id = value.get("wall_id")
        wall = walls.get(wall_id) if isinstance(wall_id, str) else None
        if wall is None or (penetration and not wall.concrete):
            raise CablingError("Pass-throughs require a concrete wall" if penetration else "Wall-mounted equipment requires a wall")
        return {"wall_id": wall.id, "t": number(value.get("t"), 0, 1, "wall position", precision=10)}

    equipment = []
    prior = {item["id"]: item for item in (existing or {}).get("equipment", [])}
    prior_runs = {item["id"]: item.get("legacy_length", 0) for item in (existing or {}).get("cables", [])}
    for device_id, item in items("equipment"):
        kind = item.get("kind")
        if not isinstance(kind, str) or kind not in EQUIPMENT or kind == "access_point":
            raise CablingError("Unknown equipment type")
        clean = {"id": device_id, "kind": kind, "name": label(item.get("name", ""), 60)}
        rack_id = item.get("rack_id")
        if rack_id is not None:
            unit = item.get("rack_u")
            size = EQUIPMENT[kind].get("rack_units", 0)
            if not isinstance(rack_id, str) or not size or type(unit) is not int or not 1 <= unit <= RACK_UNITS + 1 - size:
                raise CablingError("Choose a rack and a valid mounting position")
            clean.update(rack_id=safe_id(rack_id), rack_u=unit)
        else:
            old = prior.get(device_id, {})
            legacy_kind = kind in {"router", "core_switch", "distribution_switch"} and (
                (legacy and existing is None) or (old.get("kind") == kind and "rack_id" not in old))
            if EQUIPMENT[kind].get("rack_units") and not legacy_kind:
                raise CablingError(f"Install the {EQUIPMENT[kind]['name']} in an equipment rack")
            clean.update(anchor(item) if EQUIPMENT[kind].get("wall_mount") else point(item))
        if kind == "demarc":
            isp = item.get("isp")
            if not isinstance(isp, str) or isp not in ISPS:
                raise CablingError("Select a listed ISP")
            clean["isp"] = isp
        if kind == "poe_camera":
            clean.update(
                angle=number(item.get("angle", 0), 0, 360, "camera direction") % 360,
                field_of_view=number(item.get("field_of_view", 90), 15, 160, "camera field of view"),
                range=number(item.get("range", 10), 1, 50, "camera range"),
            )
        equipment.append(clean)
        devices[device_id] = clean

    rack_slots = {item["id"]: set() for item in equipment if item["kind"] == "rack"}
    if len(rack_slots) > MAX_RACKS:
        raise CablingError(f"A site supports up to {MAX_RACKS} equipment racks")
    for item in equipment:
        if "rack_id" not in item:
            continue
        rack = devices.get(item["rack_id"])
        if rack is None or rack["kind"] != "rack":
            raise CablingError("Choose an existing equipment rack")
        slots = rack_slots[rack["id"]]
        used = set(range(item["rack_u"], item["rack_u"] + EQUIPMENT[item["kind"]]["rack_units"]))
        if slots & used:
            raise CablingError("Equipment cannot overlap in a rack")
        slots.update(used)
        item.update(x=rack["x"], y=rack["y"])

    passages, by_wall = {}, {}
    for pass_id, item in items("pass_throughs"):
        clean = {"id": pass_id, **anchor(item, penetration=True)}
        passages[pass_id] = clean
        by_wall.setdefault(clean["wall_id"], []).append(clean)
    for wall_id, passes in by_wall.items():
        passes.sort(key=lambda passage: passage["t"])
        for left, right in zip(passes, passes[1:]):
            if (right["t"] - left["t"]) * walls[wall_id].length < PASS_SPACING - EPSILON:
                raise CablingError("Pass-throughs on the same wall must be at least 20 feet (6.096 m) apart")

    ports = {device_id: _ports(device) for device_id, device in devices.items()}
    occupied = set()
    usage = {}
    cables = []
    total_bends = 0

    def endpoint(value, media):
        if not isinstance(value, dict):
            raise CablingError("A cable requires two equipment ports")
        device_id, port = value.get("device_id"), value.get("port")
        profile = ports.get(device_id, {}).get(port) if isinstance(device_id, str) and isinstance(port, str) else None
        if not profile or profile["media"] != media:
            raise CablingError("Choose an existing port that supports this cable type")
        key = (device_id, port)
        if key in occupied:
            raise CablingError("Each port can carry only one cable")
        occupied.add(key)
        return {"device_id": device_id, "port": port}, profile

    def location(item):
        if "wall_id" in item:
            return walls[item["wall_id"]].point(item["t"])
        return item["x"], item["y"]

    for cable_id, item in items("cables"):
        media = item.get("media")
        if media not in ("fiber", "ethernet"):
            raise CablingError("Choose Ethernet or fiber")
        name = label(item.get("label", ""), 80)
        color = item.get("color")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise CablingError("Choose a valid cable color")
        source, source_port = endpoint(item.get("source"), media)
        target, target_port = endpoint(item.get("target"), media)
        a, b = devices[source["device_id"]], devices[target["device_id"]]
        if a["id"] == b["id"]:
            raise CablingError("Connect two different devices")
        has_isp = a["kind"] == "demarc" or b["kind"] == "demarc"
        if has_isp and not (source_port.get("wan") or target_port.get("wan")):
            raise CablingError("An ISP demarcation must connect to a router WAN port")
        if not has_isp and (source_port.get("wan") or target_port.get("wan")):
            raise CablingError("Router WAN ports are reserved for ISP demarcations")
        bends = item.get("waypoints")
        if not isinstance(bends, list) or len(bends) > CABLING_LIMITS["bends"]:
            raise CablingError(f"A cable supports up to {CABLING_LIMITS['bends']} bends")
        patch = item.get("rack_patch", False)
        if type(patch) is not bool:
            raise CablingError("Invalid cable routing mode")
        if patch and (not a.get("rack_id") or a["rack_id"] != b.get("rack_id") or bends or has_isp):
            raise CablingError("A rack patch cable requires devices in the same rack")
        if not patch and a.get("rack_id") and a.get("rack_id") == b.get("rack_id"):
            raise CablingError("Use the rack cable tool to connect equipment in the same rack")
        for device, end in ((a, source), (b, target)):
            if device["kind"] == "patch_panel" and not end["port"].startswith("FRONT" if patch else "BACK"):
                raise CablingError("Patch cables use the front; building cables use the rear of a patch panel")
            if device.get("rack_id") and not patch and media == "ethernet" and not has_isp and device["kind"] != "patch_panel":
                raise CablingError("Route building Ethernet through a patch panel")
        clean_cable = {"id": cable_id, "media": media, "label": name, "color": color.lower(),
                       "source": source, "target": target, "waypoints": []}
        if patch:
            cables.append({**clean_cable, "rack_patch": True})
            continue
        total_bends += len(bends)
        if total_bends > CABLING_LIMITS["total_bends"]:
            raise CablingError("This site has reached its total cable bend limit")
        points, waypoints, used_passes = [location(a)], [], set()
        for bend in bends:
            pass_id = bend.get("pass_id") if isinstance(bend, dict) else None
            if isinstance(bend, dict) and "pass_id" in bend:
                if not isinstance(pass_id, str) or pass_id not in passages:
                    raise CablingError("A cable uses a missing pass-through")
                waypoints.append({"pass_id": pass_id})
                points.append(location(passages[pass_id]))
                used_passes.add(pass_id)
            else:
                clean = point(bend)
                waypoints.append(clean)
                points.append(location(clean))
        points.append(location(b))
        length = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
        if media == "ethernet" and length > COPPER_LIMIT + EPSILON:
            previous_limit = prior_runs.get(cable_id, 0)
            if (not legacy or existing is not None) and length > previous_limit + EPSILON:
                raise CablingError("Cable capacity reached (90 m)")
            clean_cable["legacy_length"] = length
        xs, ys = zip(*points)
        left, right, top, bottom = min(xs), max(xs), min(ys), max(ys)
        if math.hypot(right - left, bottom - top) <= EPSILON:
            raise CablingError("A cable route must have a measurable length")
        for wall in concrete:
            if wall.left > right + EPSILON or wall.right < left - EPSILON or wall.top > bottom + EPSILON or wall.bottom < top - EPSILON:
                continue
            for low, high in wall.crosses(points):
                passage = next((p for p in by_wall.get(wall.id, ())
                                if low - CROSSING_TOLERANCE <= p["t"] * wall.length <= high + CROSSING_TOLERANCE), None)
                if passage is None:
                    raise CablingError(f"{name or 'Cable route'} crosses concrete without a pass-through")
                used_passes.add(passage["id"])
        for pass_id in used_passes:
            usage[pass_id] = usage.get(pass_id, 0) + 1
            if usage[pass_id] > PASS_CAPACITY:
                raise CablingError("A concrete pass-through can carry up to 10 cables")
        cables.append({**clean_cable, "waypoints": waypoints})

    return {"equipment": equipment, "pass_throughs": list(passages.values()), "cables": cables}
