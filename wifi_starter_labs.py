"""Guided Infra Sim practice at Cedar Street Community Studio."""

import math

VERSION = 1
SITE_ID = "starter-labs"
TITLE = "Cedar Street Community Studio"
SHELL = ((0, 0), (14, 0), (14, 10), (0, 10), (0, 0))
WALL = ((8, 0), (8, 10))
RACK, PC, AP1, AP2 = (11, 3), (3, 3), (5, 7), (11, 7)
PASS, PHONE, CAM, ISP = (8, 3), (7, 7), (11, 1.5), (14, 4)


def task(id, label, hint, *focus, ghost=None, event=None):
    return dict(id=id, label=label, hint=hint, focus=focus, ghost=ghost, event=event)


def at(point, label, icon=None):
    return dict(kind="point", at=point, label=label, icon=icon)


def path(*points):
    return dict(kind="path", points=points)


def tool(name):
    return f'[data-wifi-tool="{name}"]'


def equip(id, name, kind, point):
    return task(id, f"Place the {name}.", f"Choose Equipment, select {kind}, then click the ghost.",
                "#wifiEquipmentType", tool("equipment"), ghost=at(point, name, id))


def mount(id, name, u):
    return task(id, f"Install {name} at U{u}.",
                f"Open the rack and choose Install Equipment. Select {name}, set the bottom unit to U{u}, and click Install.",
                '[data-rack-add]', '[data-rack-mode="install"]', ghost=dict(kind="unit", unit=u, label=name))


def run(id, name, port, *points):
    return task(id, f"Wire the {name} to rear port {port}.",
                f"Choose Cable. Start at the {name}, click each marked pass-through, then the rack. Pick patch panel port {port} and Connect. Keep building Ethernet runs within 90 m.",
                "#wifiCableConnect", "#wifiCableToPort", tool("cable"), ghost=path(*points))


def patch(id, a, b, media="Ethernet"):
    kinds = {"panel": "patch_panel", "switch": "distribution_switch", "router": "router", "server": "server"}
    endpoints = [[kinds[device], port] for device, port in (a.split(), b.split())]
    return task(id, f"Patch {a} to {b}.", f"In the rack, choose Cable and set the media to {media}. Click {a}, then {b}.",
                "[data-rack-media]", '[data-rack-mode="cable"]', ghost=dict(kind="rack-link", ends=endpoints))


def lesson(id, title, goal, *tasks):
    return dict(id=id, title=title, goal=goal, tasks=tasks)


LESSONS = (
    lesson("outline", "Draw the studio", "Build a 14 m by 10 m studio with two rooms.",
           task("shell", "Draw the exterior walls.", "Choose Room. Keep Drywall selected and click opposite corners of the ghost rectangle.",
                "#wifiMaterial", tool("room"), ghost=path(*SHELL)),
           task("wall", "Add a concrete partition.", "Choose Wall and set Material to Concrete. Draw between the two ghost endpoints, then press Escape.",
                "#wifiMaterial", tool("wall"), ghost=path(*WALL))),
    lesson("finish", "Finish the floor plan", "Give the workshop and office openings, notes, and furniture.",
           task("door", "Add a door in the partition.", "Choose Door and click the ghost at the partition. An open doorway or a wood door both work.",
                tool("door"), ghost=at((8, 6), "Door")),
           task("window", "Add a workshop window.", "Choose Window and click the ghost on the upper exterior wall.",
                tool("window"), ghost=at((4, 0), "Window")),
           task("note", "Label the Workshop.", "Choose Note, click the ghost, and replace New note with Workshop.",
                tool("label"), ghost=at((3, 8.5), "Workshop")),
           task("desk", "Place a desk symbol.", "Choose Symbols, select Desk, and click the ghost.",
                "#wifiDecorType", tool("decor"), ghost=at((3, 2), "Desk", "desk")),
           task("fill", "Color the workshop floor.", "Choose Paint Bucket and any fill color. Click inside the workshop at the ghost.",
                "#wifiFillColor", tool("paint"), ghost=at((4, 5), "Workshop floor"))),
    lesson("rack", "Install an equipment rack", "Protect the plan and mount the core network gear.",
           task("lock", "Lock the floor plan.", "Click Lock floor plan to protect the walls and finishes while you wire.",
                "#wifiFloorLock"),
           equip("rack", "equipment rack", "Equipment Rack", RACK),
           mount("panel", "24-port Patch Panel", 16), mount("switch", "24-port Switch", 14),
           mount("router", "Router", 12), mount("ups", "UPS Unit", 1)),
    lesson("devices", "Place the first devices", "Place a wired workstation and two ceiling access points.",
           equip("desktop", "desktop", "Desktop", PC),
           equip("ap1", "workshop AP", "Ceiling access point", AP1),
           equip("ap2", "office AP", "Ceiling access point", AP2)),
    lesson("runs", "Run building Ethernet", "Terminate room cables at the back of the patch panel.",
           task("pass", "Add a concrete pass-through.", "Choose Pass-through and click the ghost on the concrete partition.",
                tool("pass"), ghost=at(PASS, "Pass-through", "pass")),
           run("pc-run", "desktop", 1, PC, PASS, RACK), run("ap1-run", "workshop AP", 2, AP1, PASS, RACK),
           run("ap2-run", "office AP", 3, AP2, RACK)),
    lesson("patch", "Patch the rack", "Complete the room circuits and add the router uplink.",
           patch("pc-patch", "panel FRONT1", "switch ETH2"), patch("ap1-patch", "panel FRONT2", "switch ETH3"),
           patch("ap2-patch", "panel FRONT3", "switch ETH4"), patch("uplink", "router SFP1", "switch SFP1", "SFP fiber")),
    lesson("dhcp", "Configure and test the wired network", "Give the workstation a subnet and prove it can reach the router.",
           task("gateway", "Set the gateway to 10.20.30.1/24.", "Select the router in the rack. Open DHCP, set Gateway and prefix to 10.20.30.1/24, and save.",
                "#wifiDhcpGateway", '[data-wifi-config="dhcp"] summary'),
           task("wired", "Ping the router from the desktop.", "Close the rack. Select the desktop, choose the router in Ping target, then Start Ping. Look for a reply.",
                "#wifiPingToggle", ghost=at(PC, "Test from desktop"), event="wired")),
    lesson("vlan", "Set up the guest VLAN", "Carry guest traffic over the switch and router uplink.",
           task("guest", "Create Guest VLAN 20.", "Open the router’s VLANs. Add a VLAN named Guest with ID 20.",
                "#wifiVlanId", '[data-wifi-config="vlans"] summary'),
           task("tagged", "Tag SFP1, ETH3, and ETH4 with VLAN 20.", "In the switch’s Switch ports, check Guest under Additional tagged VLANs on each port. Keep Default as the access VLAN.",
                '[data-wifi-config="ports"] summary')),
    lesson("wifi", "Configure guest Wi-Fi", "Broadcast a guest SSID and separate the AP radio channels.",
           task("ssid", "Broadcast Studio Guest from both APs.", "At the workshop AP add Studio Guest on 5 GHz and VLAN 20. At the office AP select it and enable Broadcast on this AP.",
                "#wifiApSsid", ghost=path(AP1, AP2)),
           task("channels", "Use channels 36 and 149 at 20 MHz.", "Set the workshop AP’s 5 GHz radio to 36 and the office AP’s to 149. Keep both widths at 20 MHz.",
                '[data-wifi-field="radio:5:channel"]', ghost=path(AP1, AP2)),
           equip("phone", "mobile phone", "Mobile Phone", PHONE),
           task("join", "Join Studio Guest on the phone.", "Select the phone and choose Studio Guest in Wi-Fi SSID. Look for an associated AP.",
                "#wifiPhoneSsid", ghost=at(PHONE, "Guest phone"))),
    lesson("survey", "Survey Wi-Fi coverage", "Measure usable signal in the workshop.",
           task("probe", "Check signal near the partition.", "Open View and choose Check Signal. Click the ghost and read the usable dBm and any interference penalty.",
                tool("probe"), ghost=at((7, 5), "Check signal"), event="probe")),
    lesson("camera", "Connect and aim a camera", "Power a camera and check its field of view.",
           equip("camera", "PoE camera", "PoE Camera", CAM),
           run("cam-run", "camera", 4, CAM, RACK), patch("cam-patch", "panel FRONT4", "switch ETH5"),
           task("aim", "Aim across the office.", "Select the camera and set Direction to about 135°, or drag its aim handle along the dashed line. Toggle Camera coverage in View to inspect the cone.",
                '[data-wifi-wire-field="angle"]', ghost=path(CAM, (8, 5)))),
    lesson("services", "Host a network service", "Install a rack server and enable a web VM.",
           mount("server", "Rack Server", 8), patch("server-patch", "server ETH1", "switch ETH6"),
           task("vm", "Enable the Web VM.", "Select the rack server and open Service VMs. Enable Web on Default. Leave IPv4 blank for DHCP.",
                '[data-wifi-service-toggle="web"]', '[data-wifi-config="service-vms"] summary')),
    lesson("handoff", "Connect Internet and verify isolation", "Give guests Internet access and protect the workstation.",
           task("isp", "Place an ISP handoff.", "Choose Equipment and ISP Demarcation. Keep the default fiber provider and click the ghost on the exterior wall.",
                "#wifiEquipmentType", tool("equipment"), ghost=at(ISP, "ISP handoff", "demarc")),
           task("wan", "Connect the handoff to the router.", "Choose Cable. Click the ISP handoff, then the rack. Confirm the offered router WAN port and Connect.",
                "#wifiCableToPort", tool("cable"), ghost=path(ISP, RACK)),
           task("firewall", "Deny Guest access to Default.", "Open the router’s Firewall. Add Deny with Guest as source and Default as destination. Leave both address fields blank.",
                '[data-wifi-config="firewall"] summary'),
           task("internet", "Ping the Internet from the guest phone.", "Select the phone and choose the Internet target. Start Ping and look for a reply.",
                "#wifiPingToggle", ghost=at(PHONE, "Test guest Internet"), event="internet"),
           task("blocked", "Verify that the guest cannot ping the desktop.", "Stop the previous ping. Choose the desktop as the phone’s target, then Start Ping. Look for the firewall denial.",
                "#wifiPingToggle", ghost=at(PHONE, "Test guest isolation"), event="blocked")),
    lesson("export", "Review and deliver the design", "Check the project budget and export the handover sheets.",
           task("bill", "Open the Bill of Materials.", "Review device and cable subtotals. Close the bill before exporting.", "#wifiMaterials", event="bill"),
           task("pdf", "Export a PDF of the design.", "Click Export PDF. Check the plan, coverage, rack, and cost sheets in the download.", "#wifiExportPdf", event="pdf")),
)


def catalog():
    return [{**{key: item[key] for key in ("id", "title", "goal")}, "task_count": len(item["tasks"])}
            for item in LESSONS]


def blank_site(schema):
    return dict(schema_version=schema, title=TITLE, units="m", band="5",
                walls=[], access_points=[], labels=[], equipment=[], cables=[], pass_throughs=[])


def near(item, point, tolerance=1.05):
    return math.dist((item["x"], item["y"]), point) <= tolerance


def segment(wall, a, b):
    x, y = wall["a"], wall["b"]
    return (near(x, a) and near(y, b)) or (near(x, b) and near(y, a))


class Studio:
    def __init__(self, plan):
        self.plan = plan
        self.walls = {wall["id"]: wall for wall in plan["walls"]}
        self.links = {}
        for cable in plan["cables"]:
            a, b = cable["source"], cable["target"]
            for source, target in ((a, b), (b, a)):
                self.links[source["device_id"], source["port"]] = (target, cable)
        self.rack = self.device("rack", RACK)
        self.router = self.mounted("router", 12)
        self.switch = self.mounted("distribution_switch", 14)
        self.panel = self.mounted("patch_panel", 16)
        self.server = self.mounted("server", 8)
        self.pc = self.device("desktop", PC)
        self.camera = self.device("poe_camera", CAM)
        self.phone = self.device("phone", PHONE)
        self.aps = [next((ap for ap in plan["access_points"] if ap["mount"] == "ceiling" and near(ap, point)), {})
                    for point in (AP1, AP2)]
        self.guest = next((ssid for ssid in plan["ssids"] if ssid["name"].casefold() == "studio guest" and
                           ssid["vlan"] == 20 and ssid["band"] == "5"), {})
        self.isp = next((x for x in plan["equipment"] if x["kind"] == "demarc" and self.on_wall(x, ISP)), {})
        self.crossings = {x["id"] for x in plan["pass_throughs"] if self.on_wall(x, PASS)}

    def device(self, kind, point):
        return next((x for x in self.plan["equipment"] if x["kind"] == kind and near(x, point)), {})

    def mounted(self, kind, u):
        return next((x for x in self.plan["equipment"] if x["kind"] == kind and
                     x.get("rack_id") == self.rack.get("id") and x.get("rack_u") == u), {})

    def on_wall(self, item, point):
        wall = self.walls[item["wall_id"]]
        position = {axis: wall["a"][axis] + (wall["b"][axis] - wall["a"][axis]) * item["t"] for axis in ("x", "y")}
        return near(position, point)

    def connected(self, a, port, b, b_port=None, *, patch=False, through=False):
        peer, cable = self.links.get((a.get("id"), port), ({}, {}))
        return (bool(b) and peer.get("device_id") == b["id"] and
                (b_port is None or peer["port"] == b_port) and bool(cable.get("rack_patch")) == patch and
                (not through or any(bend.get("pass_id") in self.crossings for bend in cable["waypoints"])))

    def rear(self, device, port, through=False):
        return self.connected(device, "ETH1", self.panel, f"BACK{port}", through=through)

    def front(self, port, switch_port):
        return self.connected(self.panel, f"FRONT{port}", self.switch, f"ETH{switch_port}", patch=True)

    def checks(self, lesson_id):
        plan, router, camera = self.plan, self.router, self.camera
        a, b = self.aps
        if lesson_id == "outline":
            return {"shell": all(any(w["material"] == "drywall" and segment(w, x, y) for w in self.walls.values())
                                 for x, y in zip(SHELL, SHELL[1:])),
                    "wall": any(w["material"] == "concrete" and segment(w, *WALL) for w in self.walls.values())}
        if lesson_id == "finish":
            return {"door": any(x["kind"] == "door" and self.on_wall(x, (8, 6)) for x in plan["openings"]),
                    "window": any(x["kind"] == "window" and self.on_wall(x, (4, 0)) for x in plan["openings"]),
                    "note": any(x["text"].casefold() == "workshop" and near(x, (3, 8.5)) for x in plan["labels"]),
                    "desk": any(x["kind"] == "desk" and near(x, (3, 2)) for x in plan["decor"]),
                    "fill": any(x["kind"] == "floor" and min(p["x"] for p in x["points"]) < 2
                                and 7 <= max(p["x"] for p in x["points"]) <= 9 for x in plan["surfaces"])}
        if lesson_id == "rack":
            return {"lock": plan["floor_locked"], "rack": self.rack, "panel": self.panel,
                    "switch": self.switch, "router": router, "ups": self.mounted("ups", 1)}
        if lesson_id == "devices":
            return {"desktop": self.pc, "ap1": a, "ap2": b}
        if lesson_id == "runs":
            return {"pass": self.crossings, "pc-run": self.rear(self.pc, 1, True),
                    "ap1-run": self.rear(a, 2, True), "ap2-run": self.rear(b, 3)}
        if lesson_id == "patch":
            return {"pc-patch": self.front(1, 2), "ap1-patch": self.front(2, 3), "ap2-patch": self.front(3, 4),
                    "uplink": self.connected(router, "SFP1", self.switch, "SFP1", patch=True)}
        if lesson_id == "dhcp":
            return {"gateway": router.get("dhcp", {}).get("gateway") == "10.20.30.1/24"}
        if lesson_id == "vlan":
            return {"guest": any(x["id"] == 20 and x["name"].casefold() == "guest" for x in plan["vlans"]),
                    "tagged": all({0, 20}.issubset(self.switch.get("port_vlans", {}).get(port, ()))
                                  for port in ("SFP1", "ETH3", "ETH4"))}
        if lesson_id == "wifi":
            return {"ssid": self.guest and all(self.guest["id"] in ap.get("ssid_ids", ()) for ap in self.aps),
                    "channels": all(ap.get("radios", {}).get("5") == {"channel": n, "width": 20}
                                    for ap, n in zip(self.aps, (36, 149))),
                    "phone": self.phone, "join": self.guest and self.phone.get("ssid_id") == self.guest["id"]}
        if lesson_id == "camera":
            return {"camera": camera, "cam-run": self.rear(camera, 4), "cam-patch": self.front(4, 5),
                    "aim": 115 <= camera.get("angle", 0) <= 155}
        if lesson_id == "services":
            return {"server": self.server, "server-patch": self.connected(self.server, "ETH1", self.switch, "ETH6", patch=True),
                    "vm": any(vm["kind"] == "web" and vm["vlan"] == 0 for vm in self.server.get("services", ()))}
        if lesson_id == "handoff":
            return {"isp": self.isp, "wan": any(self.connected(self.isp, "ISP", router, port)
                                                for port in ("WAN1", "WAN2", "WAN-SFP1", "WAN-SFP2")),
                    "firewall": any(rule["action"] == "deny" and rule["source_vlan"] == 20 and rule["destination_vlan"] == 0
                                    and not rule["source_ip"] and not rule["destination_ip"] for rule in router.get("firewall", ()))}
        return {}

    def evidence_allowed(self, reported):
        a, b = self.aps
        radio_path = (self.rear(a, 2, True) and self.rear(b, 3) and self.front(2, 3) and self.front(3, 4) and
                      self.connected(self.router, "SFP1", self.switch, "SFP1", patch=True))
        if reported == "wired":
            return (self.rear(self.pc, 1, True) and self.front(1, 2) and
                    self.connected(self.router, "SFP1", self.switch, "SFP1", patch=True))
        if reported == "probe":
            return radio_path
        if reported in ("internet", "blocked"):
            return radio_path and self.guest and self.phone.get("ssid_id") == self.guest["id"]
        return reported in ("bill", "pdf")


def initial_progress():
    return dict(version=VERSION, completed=0, checked=[], events=[])


def summary(progress, updated=None):
    return {key: progress[key] for key in ("version", "completed", "checked")} | {"updated_at": updated}


def grade(site, previous, evidence):
    """Advance at most one lesson per accepted save without undoing completed lessons."""
    completed = previous["completed"]
    if completed == len(LESSONS):
        return previous
    studio = Studio(site)
    lesson = LESSONS[completed]
    allowed = {item["event"] for item in lesson["tasks"] if item["event"]}
    events = {name for name in (set(previous["events"]) | set(evidence)) & allowed if studio.evidence_allowed(name)}
    checks = studio.checks(lesson["id"])
    checked = [item["id"] for item in lesson["tasks"] if checks.get(item["id"]) or item["event"] in events]
    if len(checked) == len(lesson["tasks"]):
        completed += 1
        events.clear()
        checked = [key for key, value in studio.checks(LESSONS[completed]["id"]).items() if value] if completed < len(LESSONS) else []
    return dict(version=VERSION, completed=completed, checked=checked, events=sorted(events))
