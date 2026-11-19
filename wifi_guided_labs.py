"""Five assessed Infra Sim labs, ordered from home networking to a small campus."""

from wifi_cabling import EQUIPMENT
from wifi_scenarios import _starter
from wifi_small_sites import Plan
from wifi_starter_labs import at, choice, path, target, task, tool


def question(prompt, *options):
    """The first authored choice is correct. Public choices are rotated per question."""
    return dict(prompt=prompt, options=[dict(text=text, explanation=explanation) for text, explanation in options])


QUESTIONS = (
    (
        question("Why connect the ISP handoff to WAN instead of one of the LAN ports?",
                 ("WAN is the router’s boundary to the provider.", "WAN connects the provider to the router’s Internet routing and NAT path."),
                 ("WAN provides power to the provider.", "WAN carries data. This residential router supplies no PoE on any port."),
                 ("A LAN port always blocks Internet traffic.", "LAN ports connect local devices. The dedicated WAN port establishes the provider side.")),
        question("Why choose a central router location in this home?",
                 ("Shorter radio paths usually improve coverage.", "Distance and walls weaken radio signals, so a central location reduces difficult paths."),
                 ("A central router gives every client the same IP.", "DHCP assigns distinct addresses. Router placement affects radio paths, not address uniqueness."),
                 ("Wi-Fi can pass through every wall without loss.", "Walls absorb some radio energy, and their material changes the loss.")),
        question("The desktop has no usable IPv4 address. Which setting should you inspect?",
                 ("Its path to the router and the DHCP scope.", "A connected client needs a working path to a DHCP server and an available address."),
                 ("The label color on the desktop.", "Labels help identify devices but do not allocate IP addresses."),
                 ("The camera coverage toggle.", "Camera visibility does not affect DHCP or the desktop link.")),
        question("Why might you cable the TV while keeping the phone wireless?",
                 ("Ethernet gives the fixed TV a consistent link and leaves radio capacity for mobile devices.", "A fixed device can use a cable while the phone keeps the mobility of Wi-Fi."),
                 ("A TV requires PoE from the residential router.", "The TV uses local power. This router does not provide PoE."),
                 ("Wi-Fi clients cannot use the Internet.", "Associated wireless clients can use the router’s Internet path too.")),
        question("Why test both a local ping and an Internet ping?",
                 ("They test different parts of the network path.", "A local reply verifies the LAN. An Internet reply also depends on the router, WAN, and provider."),
                 ("A local reply proves the provider works.", "Local traffic can succeed while the WAN cable is disconnected."),
                 ("The two tests always follow the same cables.", "Internet traffic continues beyond the router to the ISP handoff.")),
    ),
    (
        question("Why install a patch panel above the switch?",
                 ("It separates permanent building runs from changeable front patch leads.", "The rear terminals hold building cable. Front leads let you change switch connections."),
                 ("A patch panel assigns IP addresses.", "A patch panel is passive. DHCP runs on the router."),
                 ("Every port on a patch panel is connected together.", "Each front port connects only to its matching rear termination.")),
        question("Why use fiber for the router-to-switch uplink in this rack?",
                 ("It provides a suitable high-speed data path between SFP ports.", "Compatible SFP ports carry the fiber uplink. The AP still needs an Ethernet PoE path."),
                 ("Fiber supplies PoE to every AP.", "Fiber carries light. It supplies no PoE."),
                 ("Fiber removes the need for a router.", "The router still provides DHCP, firewall, and Internet routing.")),
        question("An AP is cabled but shows no coverage. What should you check first?",
                 ("The front patch lead and the PoE switch port.", "The AP needs a complete circuit from the building run through the panel to a powered switch port."),
                 ("Whether every port on the panel has a cable.", "Only the AP’s matching circuit needs to be complete."),
                 ("Whether the diagram grid is visible.", "The grid is a drawing aid and does not provide network power.")),
        question("Why give the office an explicit gateway and subnet?",
                 ("Clients need consistent local addressing and a route out of the LAN.", "The DHCP scope supplies addresses and the default gateway used for remote destinations."),
                 ("The subnet changes the length of the Ethernet cable.", "Addressing does not change physical cable length."),
                 ("The gateway must match the last client’s address.", "The gateway has its own address, distinct from client addresses.")),
        question("Why check the UPS estimate after installing the gear?",
                 ("The load determines how long backup power can support the rack.", "A larger equipment load reduces the estimated runtime of the installed UPS capacity."),
                 ("UPS runtime is always the same for every rack.", "Runtime depends on equipment load and battery capacity."),
                 ("An extra UPS increases Internet speed.", "A UPS adds backup power, not link bandwidth.")),
    ),
    (
        question("Why use a dedicated student VLAN?",
                 ("It creates a separate traffic segment for student devices.", "VLAN membership separates the student segment while allowing shared switching hardware."),
                 ("Creating the VLAN automatically puts every student port into it.", "The VLAN defines a segment. You must also configure client ports and shared uplinks to carry it."),
                 ("It makes every student device use the gateway address.", "Clients keep distinct addresses. The gateway address belongs to the router.")),
        question("Why must the uplink carry the student VLAN tag?",
                 ("The shared uplink needs to identify student traffic.", "A tagged uplink can carry the student VLAN alongside the untagged LAN."),
                 ("Only the AP needs VLAN settings; the switch uplink can stay untagged.", "The switch uplink must permit the student tag so traffic can continue to the router."),
                 ("One access VLAN carries every segment over the uplink.", "An access VLAN classifies untagged traffic. Multiple segments on a shared uplink need the appropriate tagged membership.")),
        question("Why put classroom desktop ports in the student access VLAN?",
                 ("Ordinary desktop traffic enters the intended segment without requiring desktop tagging.", "The access VLAN classifies untagged traffic from each desktop."),
                 ("Every desktop must be an uplink trunk.", "A normal client port can use one access VLAN. Uplinks carry multiple VLANs when needed."),
                 ("The SSID name automatically assigns wired desktop ports.", "SSID settings apply to wireless traffic. Wired access ports need their own VLAN configuration.")),
        question("Why enable a print service VM on the classroom server?",
                 ("It gives the print service its own network endpoint on the selected VLAN.", "The VM shares the server’s physical NIC while using its own address and VLAN."),
                 ("It creates a new physical Ethernet socket.", "A VM uses a virtual endpoint through the host NIC."),
                 ("It gives the VM the same IP address as its host.", "The VM has an independent endpoint and needs a distinct IP address to avoid an address conflict.")),
        question("A student can reach the router but not the print service. What is a useful next check?",
                 ("The VM’s VLAN, address, and the server port’s VLAN membership.", "The server path and VM configuration must carry the student VLAN and provide a reachable address."),
                 ("Move every device back to the untagged LAN.", "That could remove the intended separation. Inspect the student VLAN path and VM configuration first."),
                 ("Increase the AP’s radio power to repair the wired server path.", "Radio power affects wireless reception. It does not change the server’s switch-port VLAN.")),
    ),
    (
        question("Why separate guest Wi-Fi from staff and camera traffic?",
                 ("Guests need Internet service without access to internal devices.", "A guest VLAN and routing rules can allow Internet access while restricting internal destinations."),
                 ("More bandwidth lets guests and staff safely share one unrestricted LAN.", "Throughput does not restrict which internal devices a guest can reach. Segmentation and access rules provide that control."),
                 ("SSID names alone block internal traffic.", "An SSID name identifies the wireless network. VLANs and firewall rules enforce the intended separation.")),
        question("Why use different non-overlapping channels on nearby APs?",
                 ("It reduces interference where their coverage overlaps.", "Separate channels reduce competition between the AP radios in the overlap area."),
                 ("It makes both APs advertise different IP subnets automatically.", "Channel choice affects radio use. VLAN and DHCP settings determine addressing."),
                 ("The widest channel on the same frequency prevents competition.", "Wider channels occupy more spectrum. Overlapping radios can still interfere, so plan channels and widths together.")),
        question("Why set the same guest limit on both APs?",
                 ("A roaming client should receive the same policy from either AP.", "Per-client SSID limits apply on each AP, so both need the intended value."),
                 ("One AP’s setting automatically configures all APs.", "The per-client limit is stored separately on each AP."),
                 ("This limit reserves 20 Mb/s of the provider link for all guests combined.", "This setting caps each client on that AP. It is not an aggregate reservation for the entire Internet link.")),
        question("Why deny Guest VLAN 20 access to the untagged LAN while leaving Internet traffic allowed?",
                 ("The rule protects internal devices without blocking the guest Internet path.", "The rule matches the internal destination VLAN. Internet traffic has a different destination."),
                 ("It must also block every Internet destination.", "A rule matching the internal VLAN can leave the Internet path available."),
                 ("Creating Guest VLAN 20 alone already blocks every routed internal connection.", "A separate VLAN separates local traffic, but the router’s access rules still control traffic routed between VLANs.")),
        question("Why test the guest phone against both google.com and a staff desktop?",
                 ("One test checks allowed service and the other checks isolation.", "A successful Internet test and a denied staff-device test verify both sides of the policy."),
                 ("Any failed ping means the whole network is broken.", "A firewall denial can be the intended result."),
                 ("Pinging the guest gateway alone proves staff devices are protected.", "The gateway test checks local access. Test an internal staff destination to verify the isolation rule.")),
    ),
    (
        question("Why give the second wing its own rack and switch?",
                 ("Local access equipment keeps room drops practical and provides a clear distribution point.", "A wing rack groups local drops and connects them to the main network over a backbone."),
                 ("A second rack automatically becomes a second Internet provider.", "A rack is a mounting location. The provider still connects at the handoff."),
                 ("Every room must connect directly to the WAN port.", "Room devices use LAN access ports, not the provider-facing WAN port.")),
        question("Why use fiber between the two racks?",
                 ("It makes a suitable backbone across the building span.", "Fiber supports the backbone without the 90 m copper building-run constraint."),
                 ("It powers the remote switch through PoE.", "The remote switch needs local or UPS power. Fiber supplies no PoE."),
                 ("It replaces VLAN tagging on the backbone.", "The fiber link still needs the correct VLAN membership on its switch ports.")),
        question("Why carry matching VLANs at both ends of the backbone?",
                 ("Traffic needs a permitted path through both switch ports.", "A missing VLAN at either end interrupts that segment even when the fiber is connected."),
                 ("Only the near switch’s tags matter.", "Both endpoints participate in the path."),
                 ("Matching SSID names lets the backbone stay untagged.", "SSID names identify wireless networks. The switch backbone still needs the correct VLAN membership.")),
        question("Why test services from a device in the remote wing?",
                 ("It verifies the backbone and service path beyond the main rack.", "A local main-rack test does not exercise the remote switch or backbone."),
                 ("Remote-wing clients never need DHCP.", "Remote clients still need an address and a valid path to the router."),
                 ("A drawn fiber line proves every VLAN and service works.", "The line verifies a physical connection. VLAN configuration and client tests verify the intended traffic path.")),
        question("Why review both rack power and the final inventory?",
                 ("They expose power requirements and missing equipment before handover.", "The inventory and UPS estimates document the completed design and its backup-power needs."),
                 ("The inventory automatically installs missing patch leads.", "A report records the design. It does not create connections."),
                 ("Enough switch ports guarantee enough PoE and UPS runtime.", "Port count, PoE budget, and UPS runtime are separate limits. Review the connected loads as well as available ports.")),
    ),
)


def objective(ident, label, hint, *focus, rule, ghost=None, choices=(), rack=None, point=None):
    item = task(ident, label, hint, *focus, ghost=ghost, choices=choices, rack=rack)
    item["rule"] = rule
    if point:
        item["rack_position"] = point
    return item


def stage(ident, title, goal, tasks, theory):
    return dict(id=ident, title=title, goal=goal, tasks=tasks, theory=theory)


def layout(index, width, height):
    p = Plan()
    d, window = p.door, p.window
    p.horizontal('lab-north', 0, width, 0, *(window(x, 2) for x in range(3, width - 1, 5)))
    p.horizontal('lab-south', 0, width, height, d(width / 2, 2, 'glass'))
    p.vertical('lab-west', 0, 0, height)
    p.vertical('lab-east', width, 0, height)
    names = (('Living & work', 'Bedroom'), ('Office workroom', 'Reception & support'),
             ('Computer classroom', 'Instructor & IT'), ('Staff workroom', 'Guest lounge'),
             ('Main office wing', 'East office wing'))[index - 1]
    divider = width * .65
    p.room(names[0], 0, 0, divider, height, '#e1e9ed')
    p.room(names[1], divider, 0, width, height, '#eee4d5')
    p.vertical('lab-divider', divider, 0, height, d(height * .75, 1.5))
    if index > 1:
        left, right = (width * .55 - 1.5, width * .55 + 1.5) if index == 5 else (divider, width)
        p.room('Main IT closet', left, 0, right, 5.5, '#dce7df')
        p.horizontal('lab-it-front', left, right, 5.5, d((left + right) / 2, 1))
        if index == 5:
            p.vertical('lab-it-left', left, 0, 5.5)
            p.vertical('lab-it-right', right, 0, 5.5)
            p.room('East IT closet', width - 5.5, height - 6, width, height, '#dce7df')
            p.horizontal('lab-east-it-front', width - 5.5, width, height - 6, d(width - 3, 1))
            p.vertical('lab-east-it-side', width - 5.5, height - 6, height)
        else:
            p.place('sofa', width - 3, height - 2.4)
            p.place('table', width - 3, height - 4.5)
        if index == 3:
            p.desk(width - 3, 8)
    p.fill('sidewalk', '#e6ded0', width / 2 - 2, height, width / 2 + 2, height + 2)
    return p


def make_lab(index, count, width, height):
    titles = ('Home connections', 'A wired office', 'The classroom network', 'Staff and guest services', 'Connect two office wings')
    descriptions = (
        'Bring a desktop, TV, and phone online through a residential router.',
        'Install and patch a small office rack, configure addressing, and connect an AP.',
        'Connect a computer classroom, separate student traffic, and host a print service.',
        'Add managed guest Wi-Fi, camera power, bandwidth limits, and firewall isolation.',
        'Build a two-rack backbone and verify services across office wings.',
    )
    p = layout(index, width, height)
    roles = {}
    def role(key, kind, x=None, y=None, *, rack=None, u=None):
        roles[key] = dict(kind=kind, point=[x, y]) if rack is None else dict(kind=kind, rack=rack, unit=u)
        return key
    rack_point = [width * .55 if index == 5 else width - 3, 3]
    if index > 1:
        role('rack', 'rack', *rack_point)
    role('router', 'home_router' if index == 1 else 'router', *( [6, 6] if index == 1 else [None, None]),
         **({} if index == 1 else dict(rack='rack', u=12)))
    if index > 1:
        for key, kind, u in (('panel', 'patch_panel', 16), ('switch', 'distribution_switch', 14), ('ups', 'ups', 1)):
            role(key, kind, rack='rack', u=u)
    for i in range(count):
        x, y = 2.5 + (i % 4) * 3, 3 + (i // 4) * 3
        if index == 5:
            local = i % (count // 2)
            x, y = (21.5 if i >= count // 2 else 2.5) + (local % 3) * 3, 3 + (local // 3) * 3
        key = role(f'pc{i + 1}', 'desktop', x, y)
        p.desk(x, y)
        p.equipment.append(dict(id=key, kind='desktop', name=f'Workstation {i + 1}', x=x, y=y))
    ap_points = [[width * .46, height - 3]] + ([[24, 10] if index == 5 else [width - 4, height - 3]] if index >= 4 else [])
    if index > 1:
        for i, point in enumerate(ap_points, 1):
            role(f'ap{i}', 'access_point', *point)
    role('phone', 'phone', 5, height - 2)
    p.equipment.append(dict(id='phone', kind='phone', name='Practice phone', x=5, y=height - 2))
    if index == 1:
        role('tv', 'smart_tv', 10, 3)
        p.place('counter', 10, 3)
        p.equipment.append(dict(id='tv', kind='smart_tv', name='Bedroom TV', x=10, y=3))
        p.place('bed', width - 3, 3.3)
        p.place('sofa', 4.5, height - 2.8)
    if index >= 3:
        role('server', 'server', rack='rack', u=8)
    if index >= 4:
        for i, point in enumerate(([1, 1.2], [width - 1, height - 1]), 1):
            role(f'cam{i}', 'poe_camera', *point)
            p.equipment.append(dict(id=f'cam{i}', kind='poe_camera', name=f'Entry camera {i}', x=point[0], y=point[1],
                                    angle=45 if i == 1 else 225, range=10, field_of_view=75))
    if index == 5:
        remote = [width - 3, height - 4]
        role('remote', 'rack', *remote)
        for key, kind, u in (('remote-panel', 'patch_panel', 16), ('remote-switch', 'distribution_switch', 14), ('remote-ups', 'ups', 1)):
            role(key, kind, rack='remote', u=u)
    role('isp', 'demarc', width, 3)
    site = _starter(titles[index - 1], *p.result())
    tasks = [[] for _ in range(5)]
    def add(phase, key, label, hint, rule, *focus, ghost=None, choices=(), rack=None, rp=None):
        tasks[phase].append(objective(key, label, hint, *focus, rule=rule, ghost=ghost, choices=choices, rack=rack, point=rp))
    def place(phase, key, label, equipment):
        point = roles[key]['point']
        add(phase, key, f'Place {label}.', f'Choose Equipment, select {"Wireless Access Point (Ceiling)" if equipment.startswith("ap-") else EQUIPMENT[equipment]["name"]}, and click the highlighted position.',
            dict(test='device', role=key), '#wifiEquipmentType', tool('equipment'), ghost=at(point, label, 'access_point' if equipment.startswith('ap-') else equipment),
            choices=(choice('#wifiEquipmentType', equipment),))
    def mount(phase, key):
        r = roles[key]
        rp = roles[r['rack']]['point']
        name = EQUIPMENT[r['kind']]['name']
        add(phase, key, f"Install {name} at U{r['unit']}.",
            f"Open the rack at the highlighted position. Click U{r['unit']}, choose Install Equipment in the right panel, select {name}, and click Install.",
            dict(test='device', role=key), '[data-rack-add]', ghost=dict(kind='unit', unit=r['unit']),
            choices=(choice('[data-rack-kind]', r['kind']), choice('[data-rack-unit]', str(r['unit']))), rp=rp)
    def wire(phase, key, a, aport, b, bport, *, patch=False, medium='ethernet'):
        ra, rb = roles[a], roles[b]
        ap = roles[ra['rack']]['point'] if ra.get('rack') else ra['point']
        bp = roles[rb['rack']]['point'] if rb.get('rack') else rb['point']
        focus = ('[data-rack-media]', '[data-rack-mode="cable"]') if patch else ('#wifiCableMedia', '#wifiCableConnect', tool('cable'))
        picks = (choice('[data-rack-media]' if patch else '#wifiCableMedia', medium),)
        if not patch:
            picks += tuple({**choice(selector, suffix=':' + port), 'target': target(role['kind'], point)}
                           for selector, role, point, port in (('#wifiCableFromPort', ra, ap, aport),
                                                               ('#wifiCableToPort', rb, bp, bport)))
        def name(key, role):
            if key.startswith('pc'):
                return 'Workstation ' + key[2:]
            if key.startswith('ap'):
                return 'access point ' + key[2:]
            prefix = 'East wing ' if role.get('rack') == 'remote' else 'main ' if role.get('rack') else ''
            return prefix + EQUIPMENT[role['kind']]['name']
        an, bn = name(a, ra), name(b, rb)
        hint = (f"In the rack, choose Cable and {'SFP fiber' if medium == 'fiber' else 'Ethernet'}. Click {an} {aport}, then {bn} {bport}."
                if patch else f"Choose Cable and {'Fiber' if medium == 'fiber' else 'Ethernet'}. Click {an} (its rack for mounted gear), select source {aport}, then click {bn} (its rack for mounted gear). Select destination {bport} and press Enter or the checkmark.")
        add(phase, key, f'Connect {an} to {bn} · {bport}.', hint,
            dict(test='wire', a=a, aport=aport, b=b, bport=bport, patch=patch, medium=medium), *focus,
            ghost=dict(kind='rack-link', ends=[[ra['kind'], aport], [rb['kind'], bport]]) if patch else path(ap, bp),
            choices=picks, rp=ap if patch else None)
    def config(phase, key, label, hint, rule, focus, role_key):
        r = roles[role_key]
        add(phase, key, label, hint, rule, *focus, rack=r['kind'] if r.get('rack') else None,
            rp=roles[r['rack']]['point'] if r.get('rack') else None, ghost=at(r['point'], role_key) if not r.get('rack') else None)
        if not r.get('rack'):
            tasks[phase][-1]['target'] = target(r['kind'], r['point'])
    if index == 1:
        place(0, 'router', 'the residential router', 'home_router')
    else:
        place(0, 'rack', 'the main equipment rack', 'rack')
        for key in ('panel', 'switch', 'router', 'ups'):
            if key != 'ups' or index != 2:
                mount(0, key)
        if index == 5:
            place(0, 'remote', 'the East wing rack', 'rack')
            for key in ('remote-panel', 'remote-switch', 'remote-ups'):
                mount(0, key)
    gateway = '192.168.10.1/24' if index == 1 else f'10.{index * 10}.0.1/24'
    config(1, 'gateway', f'Set the gateway to {gateway}.',
           f"Select the router{' in the main rack' if index > 1 else ''}. Open DHCP, set Gateway and prefix to {gateway}, and press Tab. Fields save automatically.",
           dict(test='config', role='router', field='dhcp.gateway', value=gateway), ('#wifiDhcpGateway', '[data-wifi-config="dhcp"] summary'), 'router')
    if index > 1:
        wire(1, 'router-uplink', 'router', 'SFP1', 'switch', 'SFP1', patch=True, medium='fiber')
        if index == 5:
            wire(1, 'wing-backbone', 'switch', 'SFP2', 'remote-switch', 'SFP1', medium='fiber')
    for i in range(count):
        pc = f'pc{i + 1}'
        if index == 1:
            wire(1, f'run-{pc}', pc, 'ETH1', 'router', f'ETH{i + 1}')
        else:
            remote = index == 5 and i >= count // 2
            panel, switch = ('remote-panel', 'remote-switch') if remote else ('panel', 'switch')
            port = i - count // 2 + 1 if remote else i + 1
            wire(1, f'run-{pc}', pc, 'ETH1', panel, f'BACK{port}')
            wire(1, f'patch-{pc}', panel, f'FRONT{port}', switch, f'ETH{port}', patch=True)
    for i in range(1, len(ap_points) + 1 if index > 1 else 1):
        key = f'ap{i}'
        place(2, key, f'access point {i}', 'ap-ceiling')
        wire(2, f'run-{key}', key, 'ETH1', 'panel', f'BACK{12 + i}')
        wire(2, f'patch-{key}', 'panel', f'FRONT{12 + i}', 'switch', f'ETH{12 + i}', patch=True)
    vid, ssid_name = (20, 'Classroom') if index == 3 else (20, 'Guest') if index >= 4 else (0, 'Home' if index == 1 else 'Office')
    if vid:
        config(2, 'vlan', f'Create a VLAN called {ssid_name} on VLAN {vid}.',
               f"Select the main router and open VLANs. Enter {ssid_name} as Name and {vid} as VLAN ID, then click Add VLAN.",
               dict(test='vlan', name=ssid_name, vid=vid),
               ('#wifiVlanName', '#wifiVlanId', '[data-wifi-network="save-vlan"]', '[data-wifi-config="vlans"] summary'), 'router')
        switches = ['switch', 'remote-switch'] if index == 5 else ['switch']
        for key in switches:
            ports = (['SFP1', *[f'ETH{i + 1}' for i in range(count)], 'ETH13', 'ETH15'] if index == 3 else
                     ['SFP1', 'ETH13', 'ETH14'] if key == 'switch' else ['SFP1'])
            if index == 5 and key == 'switch':
                ports.append('SFP2')
            for port in ports:
                values = [20] if index == 3 and port.startswith('ETH') and port != 'ETH13' else [0, 20]
                config(2, f'tags-{key}-{port}', f'Set {key} {port} to ' + ('access VLAN 20.' if values == [20] else 'carry tagged VLAN 20.'),
                       f"Open that rack in Select mode and click switch port {port}. " +
                       ("Choose 20 · Classroom in Access VLAN." if values == [20] else f"Keep 0 · Untagged LAN as Access VLAN and check 20 · {ssid_name} under Tagged VLANs on this port."),
                       dict(test='tags', role=key, port=port, values=values),
                       ('#wifiPortAccess', '#wifiTagged-20', '[data-wifi-config="ports"] summary'), key)
                if values == [20]:
                    tasks[2][-1]['choices'] = (choice('#wifiPortAccess', '20'),)
    ssid_roles = ['router'] if index == 1 else [f'ap{i}' for i in range(1, len(ap_points) + 1)]
    for i, key in enumerate(ssid_roles):
        focus = ('#wifiHomeSsid', '#wifiHomeSsidName', '[data-wifi-network="save-home-ssid"]') if index == 1 else (
            '#wifiApSsid', '#wifiSsidName', '[data-wifi-network="save-ssid"]')
        config(2, f'ssid-{key}', f'Broadcast {ssid_name} on {key}.',
               (f"Select the residential router. Open Built-in Wi-Fi, choose Create SSID…, enter {ssid_name}, keep Both bands, and click Create and Broadcast." if index == 1 else
                f"Select {key}. " + (f"Choose Add SSID… in Shared SSID, enter {ssid_name}, select 5 GHz and VLAN {vid}, then click Create and Broadcast." if i == 0 else
                                     f"Choose {ssid_name} in Shared SSID and check Broadcast on this AP.")),
               dict(test='ssid', role=key, name=ssid_name, vid=vid, band='both' if index == 1 else '5'), focus, key)
        tasks[2][-1]['choices'] = ((choice('#wifiHomeSsid', ':add'),) if index == 1 else
                                  (choice('#wifiApSsid', ':add' if i == 0 else None, label=ssid_name),
                                   choice('#wifiSsidBand', '5'), choice('#wifiSsidVlan', str(vid))) if i == 0 else
                                  (choice('#wifiApSsid', label=ssid_name),))
    config(2, 'phone-ssid', f'Join {ssid_name} on the phone.',
           f"Close the rack, select Practice phone, and choose {ssid_name} in Wi-Fi SSID.",
           dict(test='join', role='phone', name=ssid_name), ('#wifiPhoneSsid',), 'phone')
    tasks[2][-1]['choices'] = (choice('#wifiPhoneSsid', label=ssid_name),)
    if index == 1:
        wire(3, 'tv-wire', 'tv', 'ETH1', 'router', 'ETH2')
    elif index == 2:
        mount(3, 'ups')
    if index >= 3:
        mount(3, 'server')
        wire(3, 'server-patch', 'server', 'ETH1', 'switch', 'ETH15', patch=True)
        config(3, 'print-service', 'Enable the Print service VM.',
               f"Select the server in the main rack, open Service VMs, enable Print, and choose VLAN {20 if index == 3 else 0}. Leave IPv4 blank for DHCP and click Save VM.",
               dict(test='service', role='server', kind='print', vid=20 if index == 3 else 0),
               ('[data-wifi-service-toggle="print"]', '[data-wifi-config="service-vms"] summary'), 'server')
    if index >= 4:
        for i in (1, 2):
            wire(3, f'run-cam{i}', f'cam{i}', 'ETH1', 'panel', f'BACK{15 + i}')
            wire(3, f'patch-cam{i}', 'panel', f'FRONT{15 + i}', 'switch', f'ETH{15 + i}', patch=True)
        for i in (1, 2):
            config(3, f'channel-ap{i}', f'Set ap{i} to channel {36 if i == 1 else 149}.',
                   f"Select ap{i}. In the 5 GHz radio set channel {36 if i == 1 else 149} and width 20 MHz.",
                   dict(test='config', role=f'ap{i}', field='radios.5.channel', value=36 if i == 1 else 149),
                   ('[data-wifi-field="radio:5:channel"]',), f'ap{i}')
            tasks[3][-1]['choices'] = (choice('[data-wifi-field="radio:5:width"]', '20'),
                                      choice('[data-wifi-field="radio:5:channel"]', str(36 if i == 1 else 149)))
            config(3, f'limit-ap{i}', f'Limit {ssid_name} clients to 20 Mb/s on ap{i}.',
                   f"Select ap{i}, click {ssid_name} in Wi-Fi networks on this AP, and set Per-client limit on this AP to 20. Press Tab to save.",
                   dict(test='limit', role=f'ap{i}', name=ssid_name, rate=20), ('#wifiSsidLimit',), f'ap{i}')
        config(3, 'guest-firewall', 'Deny Guest VLAN 20 access to the untagged LAN.',
               "In the main router’s Firewall, choose Deny, Source VLAN 20 · Guest, Destination VLAN 0 · Untagged LAN, leave IP fields blank, and click Add Rule.",
               dict(test='firewall', role='router'), ('#wifiFirewallAction', '[data-wifi-network="save-rule"]', '[data-wifi-config="firewall"] summary'), 'router')
        tasks[3][-1]['choices'] = (choice('#wifiFirewallAction', 'deny'), choice('#wifiFirewallSourceVlan', '20'), choice('#wifiFirewallDestinationVlan', '0'))
    place(4, 'isp', 'the ISP handoff', 'demarc')
    tasks[4][-1]['choices'] += (choice('#wifiEquipmentIsp', 'meadowlink' if index == 1 else 'alderline'),)
    wire(4, 'wan', 'isp', 'ISP', 'router', 'WAN1' if index == 1 else 'WAN-SFP1', medium='ethernet' if index == 1 else 'fiber')
    add(4, 'verify-network', 'Verify all workstation paths to the router.',
        "Check every building run and front patch. Every workstation and the phone must have a complete path to the router. Use Select on a client to inspect its address and ping target.",
        dict(test='network', roles=[f'pc{i + 1}' for i in range(count)], vlan=20 if index == 3 else 0), tool('select'))
    add(4, 'verify-ping', 'Ping google.com from the phone.',
        "Select Practice phone, set Ping target to google.com, and click Start Ping. Look for arrived packets and an RTT. A permitted Internet path is required.",
        dict(test='internet'), '#wifiPingTarget', '#wifiPingToggle', ghost=at(roles['phone']['point'], 'Practice phone'),
        choices=(choice('#wifiPingTarget', ':internet'),))
    for phase in tasks:
        for item in phase:
            rule = item['rule']
            if rule['test'] == 'config' and rule['field'] == 'dhcp.gateway':
                item['fields'] = {'#wifiDhcpGateway': rule['value']}
            elif rule['test'] == 'vlan':
                item['fields'] = {'#wifiVlanName': rule['name'], '#wifiVlanId': str(rule['vid'])}
                item['action'] = '[data-wifi-network="save-vlan"]'
            elif rule['test'] == 'ssid':
                item['fields'] = {'#wifiHomeSsidName': rule['name'], '#wifiSsidName': rule['name']}
                item['action'] = '[data-wifi-network="save-home-ssid"]' if index == 1 else '[data-wifi-network="save-ssid"]'
            elif rule['test'] == 'tags':
                item['port'] = rule['port']
                if len(rule['values']) > 1:
                    item['checks'] = {'#wifiTagged-20': True}
            elif rule['test'] == 'service':
                item['choices'] = (choice('[data-wifi-service-vlan]', str(rule['vid'])),)
                item['fields'] = {}
                item['action'] = '[data-wifi-network="save-vm"][data-service="print"]'
            elif rule['test'] == 'firewall':
                item['fields'] = {'#wifiFirewallSourceIp': '', '#wifiFirewallDestinationIp': ''}
                item['action'] = '[data-wifi-network="save-rule"]'
            elif rule['test'] == 'wire' and not rule['patch']:
                item['fields'] = {}
                item['action'] = '#wifiCableConnect'
            elif rule['test'] == 'limit':
                item['ssid_name'] = rule['name']
                item['fields'] = {'#wifiSsidLimit': str(rule['rate'])}
            elif rule['test'] == 'internet':
                item['fields'] = {}
                item['action'] = '#wifiPingToggle'
            if rule['test'] == 'ssid' and rule['role'] == 'ap2':
                item['focus'] = ('#wifiApSsidEnabled',)
                item.pop('action', None)
                item.pop('fields', None)
    tasks[4][-1]['event'] = 'internet'
    tasks[4][-1]['target'] = target('phone', roles['phone']['point'])
    phases = [stage(f'phase-{i}', title, goal, work, theory) for i, (title, goal, work, theory) in enumerate(zip(
        ('Equipment', 'Wired paths', 'Addressing and Wi-Fi', 'Services and policy', 'Verify and submit'),
        ('Install the infrastructure for this site.', 'Complete the wired paths and configure the gateway.',
         'Configure wireless clients and any required traffic segments.', 'Finish the services and policies for this network.',
         'Connect the provider, verify the design, then submit it for grading.'),
        tasks,
        ('Equipment must fit its location and receive appropriate power.',
         'A cable circuit must be complete at both ends. Patch-panel front and rear ports form independent circuits.',
         'DHCP supplies addresses. SSIDs identify wireless networks and VLANs identify traffic segments.',
         'Services, radio plans, and access policy work together to support the intended users.',
         'A complete network needs both local paths and a provider path. Testing checks the result.')))]
    if index == 1:
        phases[1]['theory'] = 'DHCP assigns each client an address and gateway. A LAN cable carries local device traffic to the router.'
        phases[3].update(title='A fixed client', goal='Connect the TV using Ethernet to leave radio capacity for the phone.',
                         theory='Ethernet gives fixed devices a consistent wired path. Mobile devices can keep using Wi-Fi.')
    elif index == 2:
        phases[3].update(title='Backup power', goal='Install the UPS and review its runtime estimate.',
                         theory='A UPS keeps the rack running briefly during a power outage. More equipment load reduces battery runtime.')
    elif index == 3:
        phases[3]['theory'] = 'A service VM provides an independent logical network endpoint through the server’s physical NIC. Its VLAN and switch access port must match.'
    else:
        phases[3]['theory'] = 'Non-overlapping radio channels reduce interference. SSID limits cap each guest’s throughput, while the router firewall restricts routed access to internal VLANs.'
    return dict(id=f'infra-lab-{index:02d}', title=f'Lab {index} · {titles[index - 1]}', description=descriptions[index - 1],
                level='Starter' if index <= 2 else 'Intermediate', site=site, roles=roles, lessons=phases,
                questions=QUESTIONS[index - 1])


LABS = {lab['id']: lab for lab in (make_lab(1, 1, 14, 10), make_lab(2, 2, 18, 12),
                                  make_lab(3, 6, 20, 14), make_lab(4, 8, 24, 14), make_lab(5, 12, 30, 18))}


def summary(lab):
    return {key: lab[key] for key in ('id', 'title', 'description', 'level')}


def lessons(lab):
    return [{**phase, 'tasks': [{key: value for key, value in item.items() if key != 'rule'} for item in phase['tasks']]}
            for phase in lab['lessons']]


def public_question(lab, phase, answer=None):
    q = lab['questions'][phase]
    order = [(phase + i + 1) % len(q['options']) for i in range(len(q['options']))]
    public = dict(id=f'q{phase + 1}', prompt=q['prompt'],
                  options=[dict(id=str(position), text=q['options'][source]['text']) for position, source in enumerate(order)])
    if answer is not None:
        source = order[int(answer)]
        selected = q['options'][source]
        public.update(selected=answer, correct=source == 0, explanation=selected['explanation'])
    return public
