"""Guided Infra Sim practice at Cedar Street Community Studio."""

import math

VERSION = 1
SITE_ID = "starter-labs"
TITLE = "Cedar Street Community Studio"
SHELL = ((0, 0), (14, 0), (14, 10), (0, 10), (0, 0))
WALL = ((8, 0), (8, 10))
RACK, PC, AP1, AP2 = (11, 3), (3, 2), (5, 7), (11, 7)
PASS, PHONE, CAM, ISP = (8, 3), (7, 7), (11, 1.5), (14, 4)


def choice(selector, value=None, *, label=None, suffix=None):
    return dict(selector=selector, value=value, label=label, suffix=suffix)


def task(id, label, hint, *focus, ghost=None, event=None, choices=(), rack=None, target=None, theory=None):
    return dict(id=id, label=label, hint=hint, focus=focus, ghost=ghost, event=event,
                choices=choices, rack=rack, target=target, theory=theory)


def target(kind, point):
    return dict(kind=kind, point=point)


def at(point, label, icon=None):
    return dict(kind="point", at=point, label=label, icon=icon)


def path(*points):
    return dict(kind="path", points=points)


def tool(name):
    return f'[data-wifi-tool="{name}"]'


def equip(id, name, kind, point):
    values = {"ap1": "ap-ceiling", "ap2": "ap-ceiling", "camera": "poe_camera"}
    extra = " Click the center of the Workshop desk." if id == "desktop" else " Click the ghost."
    return task(id, f"Place the {name}.", f"Choose Equipment and select {kind}.{extra}",
                "#wifiEquipmentType", tool("equipment"), ghost=at(point, "Desktop on desk" if id == "desktop" else name, id),
                choices=(choice("#wifiEquipmentType", values.get(id, id)),))


def mount(id, name, u):
    profile = {"panel": "patch_panel", "switch": "distribution_switch"}.get(id, id)
    return task(id, f"Install {name} at U{u}.",
                f"Open the rack and choose Install Equipment. Select {name}, set the bottom unit to U{u}, and click Install.",
                '[data-rack-add]', '[data-rack-mode="install"]', ghost=dict(kind="unit", unit=u, label=name),
                choices=(choice("[data-rack-kind]", profile), choice("[data-rack-unit]", str(u))))


def run(id, name, port, *points):
    return task(id, f"Wire the {name} to rear port {port}.",
                f"Choose Cable and Ethernet. Start at the {name}, click the numbered points along the run, then the rack. Pick patch panel port {port} and press Enter or click the checkmark. Keep building Ethernet runs within 90 m.",
                "#wifiCableConnect", "#wifiCableToPort", "#wifiCableMedia", tool("cable"), ghost=path(*points),
                choices=(choice("#wifiCableMedia", "ethernet"), choice("#wifiCableToPort", suffix=f":BACK{port}")))


def patch(id, a, b, media="Ethernet"):
    kinds = {"panel": "patch_panel", "switch": "distribution_switch", "router": "router", "server": "server"}
    endpoints = [[kinds[device], port] for device, port in (a.split(), b.split())]
    return task(id, f"Patch {a} to {b}.", f"In the rack, choose Cable and set the media to {media}. Click {a}, then {b}.",
                "[data-rack-media]", '[data-rack-mode="cable"]', ghost=dict(kind="rack-link", ends=endpoints),
                choices=(choice("[data-rack-media]", "fiber" if media == "SFP fiber" else "ethernet"),))


THEORY = {
    "outline": "The floor plan is drawn to scale. Wall material matters because concrete blocks more Wi-Fi energy than drywall.",
    "finish": "Labels identify rooms, and fills make their boundaries easier to read. Doors and windows let the simulator model a different radio path through a wall.",
    "rack": "A rack unit, or U, describes chassis height. A UPS supplies backup power to the equipment if mains power fails.",
    "devices": "The desktop needs a wired link. The APs turn their Ethernet connection into wireless service for nearby clients.",
    "runs": "A rear patch-panel port terminates a cable that stays in the building. The front port lets you change the switch connection without rerouting that cable.",
    "patch": "A patch lead completes the circuit from the rear jack to the switch. PoE lets the switch send power and data over one Ethernet cable.",
    "dhcp": "DHCP gives a client an IP address, subnet, and default gateway. A ping sends an echo request and looks for a reply to test that path.",
    "vlan": "A VLAN separates traffic on a shared switch. A tag identifies the VLAN when several networks share one link.",
    "wifi": "The SSID is the Wi-Fi name clients choose. Nearby APs can share an SSID while using separate channels to reduce interference.",
    "survey": "Signal strength in dBm describes received power. Higher values, such as −55 versus −75 dBm, are stronger. Interference can reduce usable signal.",
    "camera": "A PoE camera receives power and data through the same cable. Its viewing cone shows the area it can see before walls obstruct the view.",
    "services": "A virtual machine runs a service on a shared server. The Web VM gets its own network address, so clients can reach that service separately.",
    "handoff": "The ISP demarcation marks the boundary between the building network and the provider. The router forwards Internet traffic across that link.",
    "export": "A bill of materials totals the planned devices, cable lengths, and costs. A handover PDF documents the design for installation and troubleshooting.",
}


def lesson(id, title, goal, *tasks):
    return dict(id=id, title=title, goal=goal, tasks=tasks, theory=THEORY[id])


LESSONS = (
    lesson("outline", "Draw the studio", "Draw a 14 m by 10 m room with Room, then divide it with Wall.",
           task("shell", "Draw the exterior walls.", "Open Draw and choose Room. Keep Drywall selected and click the two numbered corners in order.",
                "#wifiMaterial", tool("room"), ghost=path(*SHELL), choices=(choice("#wifiMaterial", "drywall"),)),
           task("wall", "Add a concrete partition.", "Open Draw again and choose Wall. Set Material to Concrete, click the two numbered ends, then press Escape.",
                "#wifiMaterial", tool("wall"), ghost=path(*WALL), choices=(choice("#wifiMaterial", "concrete"),))),
    lesson("finish", "Finish the floor plan", "Use Draw and Design to add openings, labels, furniture, and a floor fill.",
           task("door", "Add a door in the partition.", "Choose Door and click the ghost at the partition. An open doorway or a wood door both work.",
                tool("door"), ghost=at((8, 6), "Door")),
           task("window", "Add a workshop window.", "Choose Window and click the ghost on the upper exterior wall.",
                tool("window"), ghost=at((4, 0), "Window")),
           task("note", "Label the Workshop.", "Choose Note, click the ghost, and replace New note with Workshop.",
                tool("label"), ghost=at((3, 8.5), "Workshop")),
           task("office", "Label the Office.", "Choose Draw → Note, click the Office ghost, then replace New note with Office.",
                tool("label"), ghost=at((11, 8.5), "Office")),
           task("desk", "Place a desk symbol.", "Choose Symbols, select Desk, and click the ghost.",
                "#wifiDecorType", tool("decor"), ghost=at(PC, "Workshop desk", "desk"), choices=(choice("#wifiDecorType", "desk"),)),
           task("fill", "Color the Workshop floor.", "Open Design and choose Paint Bucket. Pick a color and click the Workshop ghost on the left side of the partition.",
                "#wifiFillColor", tool("paint"), ghost=at((4, 5), "Workshop floor")),
           task("office-fill", "Color the Office floor.", "Keep Paint Bucket active. Pick another color if you like, then click the Office ghost on the right. Both rooms should now be filled.",
                "#wifiFillColor", tool("paint"), ghost=at((11, 5), "Office floor"))),
    lesson("rack", "Install an equipment rack", "Lock the drawing, then use the rack’s front view to mount the network gear.",
           task("lock", "Lock the floor plan.", "Click Lock floor plan to protect the walls and finishes while you wire.",
                "#wifiFloorLock"),
           equip("rack", "equipment rack", "Equipment Rack", RACK),
           mount("panel", "24-port Patch Panel", 16), mount("switch", "24-port Switch", 14),
           mount("router", "Router", 12), mount("ups", "UPS Unit", 1)),
    lesson("devices", "Place the first devices", "Place a wired workstation and two ceiling access points.",
           equip("desktop", "desktop on the Workshop desk", "Desktop", PC),
           equip("ap1", "workshop AP", "Ceiling access point", AP1),
           equip("ap2", "office AP", "Ceiling access point", AP2)),
    lesson("runs", "Run building Ethernet", "Use Cable on the floor plan to terminate room runs at the back of the patch panel.",
           task("pass", "Add a concrete pass-through.", "Choose Pass-through and click the ghost on the concrete partition.",
                tool("pass"), ghost=at(PASS, "Pass-through", "pass")),
           run("pc-run", "desktop", 1, PC, PASS, RACK), run("ap1-run", "workshop AP", 2, AP1, PASS, RACK),
           run("ap2-run", "office AP", 3, AP2, RACK)),
    lesson("patch", "Patch the rack", "Use Cable inside the rack to connect front ports and add a fiber uplink.",
           patch("pc-patch", "panel FRONT1", "switch ETH2"), patch("ap1-patch", "panel FRONT2", "switch ETH3"),
           patch("ap2-patch", "panel FRONT3", "switch ETH4"), patch("uplink", "router SFP1", "switch SFP1", "SFP fiber")),
    lesson("dhcp", "Configure and test the wired network", "Configure DHCP in the router and test the gateway from the desktop inspector.",
           task("gateway", "Set the gateway to 10.20.30.1/24.", "Select the router in the rack. Open DHCP, set Gateway and prefix to 10.20.30.1/24, and save.",
                "#wifiDhcpGateway", '[data-wifi-config="dhcp"] summary', rack="router"),
           task("wired", "Ping the router from the desktop.", "Close the rack. Select the desktop, choose the router in Ping target, then Start Ping. Look for a reply.",
                "#wifiPingTarget", "#wifiPingToggle", ghost=at(PC, "Test from desktop"), event="wired",
                target=target("desktop", PC), choices=(choice("#wifiPingTarget", label="Router"),))),
    lesson("vlan", "Set up the guest VLAN", "Use tagged switch ports to carry Guest VLAN 20 alongside the default network.",
           task("guest", "Create Guest VLAN 20.", "Open the router’s VLANs. Add a VLAN named Guest with ID 20.",
                "#wifiVlanName", "#wifiVlanId", '[data-wifi-network="save-vlan"]', '[data-wifi-config="vlans"] summary', rack="router"),
           *(task(f"tag-{port}", f"Tag switch {port} with VLAN 20.",
                  f"Select the 24-port switch and open Switch ports. Click {port}, then check Guest under Additional tagged VLANs. Keep Default as the access VLAN.",
                  f'#wifiPort-{port}[aria-pressed="false"]', "#wifiTagged-20", '[data-wifi-config="ports"] summary', rack="distribution_switch")
             for port in ("SFP1", "ETH3", "ETH4"))),
    lesson("wifi", "Configure guest Wi-Fi", "Share one SSID across both APs, choose separate channels, and associate a phone.",
           task("ssid-workshop", "Create and broadcast Studio Guest on the Workshop AP.",
                "Select the AP on the left, then choose Add SSID… in Shared SSID. Type Studio Guest in SSID name, set Radio band to 5 GHz and VLAN ID to 20 · Guest. Click Add SSID.",
                "#wifiSsidName", '[data-wifi-network="save-ssid"]', target=target("access_point", AP1),
                choices=(choice("#wifiApSsid", label="Add SSID…"), choice("#wifiSsidBand", "5"), choice("#wifiSsidVlan", "20")),
                ghost=at(AP1, "Workshop AP", "ap1")),
           task("ssid-office", "Broadcast the same SSID on the Office AP.",
                "Select the AP on the right. Choose Studio Guest in Shared SSID and check Broadcast on this AP. You are enabling the network you already created.",
                "#wifiApSsidEnabled", target=target("access_point", AP2), choices=(choice("#wifiApSsid", label="Studio Guest"),),
                ghost=at(AP2, "Office AP", "ap2")),
           task("channel-workshop", "Set the Workshop AP to 5 GHz channel 36.",
                "Select the Workshop AP on the left. In 5 GHz radio, select channel 36 and a channel width of 20 MHz.",
                target=target("access_point", AP1), ghost=at(AP1, "Workshop AP · 36", "ap1"),
                choices=(choice('[data-wifi-field="radio:5:channel"]', "36"), choice('[data-wifi-field="radio:5:width"]', "20"))),
           task("channel-office", "Set the Office AP to 5 GHz channel 149.",
                "Select the Office AP on the right. In 5 GHz radio, select channel 149 and a channel width of 20 MHz.",
                target=target("access_point", AP2), ghost=at(AP2, "Office AP · 149", "ap2"),
                choices=(choice('[data-wifi-field="radio:5:channel"]', "149"), choice('[data-wifi-field="radio:5:width"]', "20"))),
           equip("phone", "mobile phone", "Mobile Phone", PHONE),
           task("join", "Join Studio Guest on the phone.", "Select the phone and choose Studio Guest in Wi-Fi SSID. Look for an associated AP.",
                "#wifiPhoneSsid", target=target("phone", PHONE), choices=(choice("#wifiPhoneSsid", label="Studio Guest"),),
                ghost=at(PHONE, "Guest phone"))),
    lesson("survey", "Survey Wi-Fi coverage", "Measure usable signal in the workshop.",
           task("probe", "Check signal near the partition.", "In Wi-Fi, enable coverage and choose 5 GHz and Studio Guest. Then open View, choose Check Signal, and click the ghost. Compare usable dBm with the received signal and any interference penalty.",
                "#wifiCoverage:not(:checked)", "#wifiCoverageSsid", "#wifiBand", tool("probe"),
                choices=(choice("#wifiBand", "5"), choice("#wifiCoverageSsid", label="Studio Guest")),
                ghost=at((7, 5), "Check signal"), event="probe")),
    lesson("camera", "Connect and aim a camera", "Complete the camera’s PoE path, then use its aim handle and coverage cone.",
           equip("camera", "PoE camera", "PoE Camera", CAM),
           run("cam-run", "camera", 4, CAM, RACK), patch("cam-patch", "panel FRONT4", "switch ETH5"),
           task("aim", "Aim across the office.", "Select the camera and set Direction to about 135°, or drag its aim handle along the dashed line. Toggle Camera coverage in View to inspect the cone.",
                '[data-wifi-wire-field="angle"]', ghost=path(CAM, (8, 5)))),
    lesson("services", "Host a network service", "Open the server’s Service VMs panel to give the Web VM its own DHCP address.",
           mount("server", "Rack Server", 8), patch("server-patch", "server ETH1", "switch ETH6"),
           task("vm", "Enable the Web VM.", "Select the rack server and open Service VMs. Enable Web on Default. Leave IPv4 blank for DHCP.",
                '[data-wifi-service-toggle="web"]', '[data-wifi-config="service-vms"] summary', rack="server")),
    lesson("handoff", "Connect Internet and verify isolation", "Connect an ISP handoff to WAN, then use two ping tests to verify what the firewall allows.",
           task("isp", "Place an ISP handoff.", "Choose Equipment and ISP Demarcation. Keep the default fiber provider and click the ghost on the exterior wall.",
                "#wifiEquipmentType", tool("equipment"), ghost=at(ISP, "ISP handoff", "demarc"),
                choices=(choice("#wifiEquipmentType", "demarc"), choice("#wifiEquipmentIsp", "alderline"))),
           task("wan", "Connect the handoff to the router.", "Choose Cable and Fiber. Click the ISP handoff, then the rack. Select WAN-SFP1 on the router and press Enter or click the checkmark.",
                "#wifiCableConnect", "#wifiCableToPort", tool("cable"), ghost=path(ISP, RACK),
                choices=(choice("#wifiCableMedia", "fiber"), choice("#wifiCableToPort", suffix=":WAN-SFP1"))),
           task("firewall", "Deny Guest access to Default.", "Select the router and open Firewall. Choose Deny, choose 20 · Guest as Source VLAN and 0 · Untagged LAN as Destination VLAN, then click Add Rule. Leave the two IP fields blank.",
                '[data-wifi-network="save-rule"]', '[data-wifi-config="firewall"] summary', rack="router",
                choices=(choice("#wifiFirewallAction", "deny"), choice("#wifiFirewallSourceVlan", "20"),
                         choice("#wifiFirewallDestinationVlan", "0")),
                theory="A firewall checks rules in order. Matching the guest VLAN and default VLAN blocks traffic between those networks while leaving the Internet path available."),
           task("internet", "Ping the Internet from the guest phone.", "Select the phone and choose the Internet target. Start Ping and look for a reply.",
                "#wifiPingTarget", "#wifiPingToggle", ghost=at(PHONE, "Test guest Internet"), event="internet",
                target=target("phone", PHONE), choices=(choice("#wifiPingTarget", ":internet"),),
                theory="NAT lets clients with private addresses share the router’s public address. In the simulation, amber packets mark the link between the router and the ISP handoff."),
           task("blocked", "Verify that the guest cannot ping the desktop.", "Stop the previous ping. Choose the desktop as the phone’s target, then Start Ping. Look for the firewall denial.",
                "#wifiPingTarget", "#wifiPingToggle", ghost=at(PHONE, "Test guest isolation"), event="blocked",
                target=target("phone", PHONE), choices=(choice("#wifiPingTarget", label="Desktop"),))),
    lesson("export", "Review and deliver the design", "Compare the itemized costs in Bill of Materials and download the network handover PDF.",
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
                    "office": any(x["text"].casefold() == "office" and near(x, (11, 8.5)) for x in plan["labels"]),
                    "desk": any(x["kind"] == "desk" and near(x, PC) for x in plan["decor"]),
                    "fill": any(x["kind"] == "floor" and min(p["x"] for p in x["points"]) < 2
                                and 7 <= max(p["x"] for p in x["points"]) <= 9 for x in plan["surfaces"]),
                    "office-fill": any(x["kind"] == "floor" and max(p["x"] for p in x["points"]) > 12
                                       and 7 <= min(p["x"] for p in x["points"]) <= 9 for x in plan["surfaces"])}
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
                    **{f"tag-{port}": {0, 20}.issubset(self.switch.get("port_vlans", {}).get(port, ()))
                       for port in ("SFP1", "ETH3", "ETH4")}}
        if lesson_id == "wifi":
            return {"ssid-workshop": self.guest and self.guest["id"] in a.get("ssid_ids", ()),
                    "ssid-office": self.guest and self.guest["id"] in b.get("ssid_ids", ()),
                    "channel-workshop": a.get("radios", {}).get("5") == {"channel": 36, "width": 20},
                    "channel-office": b.get("radios", {}).get("5") == {"channel": 149, "width": 20},
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


def summary(site, *, refresh=False):
    progress = site["starter_progress"] if site else initial_progress()
    result = {key: progress[key] for key in ("version", "completed", "checked")}
    if site:
        if refresh and progress["completed"] < len(LESSONS):
            lesson = LESSONS[progress["completed"]]
            studio = Studio(site)
            checks = studio.checks(lesson["id"])
            result["checked"] = [item["id"] for item in lesson["tasks"] if checks.get(item["id"]) or
                                 (item["event"] in progress["events"] and studio.evidence_allowed(item["event"]))]
        result.update(updated_at=site["updated_at"], revision=site["revision"],
                      attempt=site.get("starter_attempt", 1),
                      best_completed=max(site.get("starter_best", 0), progress["completed"]),
                      can_restart=site.get("starter_checkpoint") is not None)
    return result


def checkpoint_progress(site, completed):
    checks = Studio(site).checks(LESSONS[completed]["id"])
    return dict(version=VERSION, completed=completed, checked=[key for key, value in checks.items() if value], events=[])


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


def guest_grade(site, progress, evidence):
    # This state belongs to the caller and is intentionally never stored or reported.
    if not isinstance(progress, dict):
        raise ValueError("Invalid guest progress")
    completed = progress.get("completed")
    if type(completed) is not int or not 0 <= completed <= len(LESSONS):
        raise ValueError("Invalid guest lesson")
    valid = {task["event"] for lesson in LESSONS for task in lesson["tasks"] if task["event"]}
    prior = progress.get("events", [])
    for events in (prior, evidence):
        if not isinstance(events, list) or len(events) > len(valid) or any(
            not isinstance(event, str) or event not in valid for event in events
        ):
            raise ValueError("Invalid guest activity")
    result = grade(site, dict(version=VERSION, completed=completed, checked=[], events=prior), evidence)
    return {**result, "can_restart": result["completed"] < len(LESSONS)}
