# EagleIDE Network Simulator Guide

The Network Simulator is an optional EagleIDE app for learning network fundamentals and introductory cybersecurity. It runs entirely in the browser: packets, scans, services, and CLI commands are simulations and never send traffic to real devices.

## Access and saving

- An administrator enables or disables the app in **Settings → Network Sim**. An administrator can open a private preview even while the global switch is off.
- A teacher enables access separately for each class in **Teacher Dashboard → Network Sim**. Assigning a lab automatically enables that class, but the administrator's global switch still controls student access.
- A signed-in student may open the simulator when any joined class has access. Assigned labs appear at the top of the network library.
- Guests may use examples, build from scratch, test, import, and export when the global switch is enabled. Guests cannot save networks or lab progress.
- Signed-in users can save up to 40 personal networks. A topology supports up to 100 devices and 200 links.

## Start a network

Open **Network Sim** in the top bar, then choose one of these paths:

1. **New Network** opens an empty canvas.
2. **Example topologies** opens a writable copy of a complete network. Fourteen examples cover a LAN, routed subnets, DHCP, Layer 2 and Layer 3 switching, VLAN ACLs, hierarchical DNS/HTTP, redundant fiber with RSTP, RIP/OSPF, IPv6 dual stack, PAT and port forwarding, wireless channels/roaming, and a safe cyber traffic-analysis range. Each example includes guided objectives.
3. **Assigned labs** resumes the student's saved copy and automatic objective grading.
4. **Saved networks** resumes a signed-in user's private topology.
5. **Import JSON** opens a topology exported from this simulator.

Use **Export** to keep a portable JSON copy. Export is available to guests and signed-in users.

## Build on desktop or iPad

- Tap a device in the left library to place it near the center of the visible canvas.
- Drag a device to reposition it. Pointer Events make the same interaction work with a mouse, trackpad, stylus, or finger.
- Select **Cable** and tap the first device. A small menu opens at the tap location; choose an available source port. Tap the second device and choose its destination port. Occupied, disabled, and nonexistent ports cannot be selected.
- Select a device and use the right Configuration pane. Finite settings use touch-friendly menus. Subnet masks, VLANs, SSIDs, domains, routes, and service ports update from the current topology. IPv4 addresses, gateways, DNS addresses, and DHCP pool boundaries remain direct-entry fields so the browser never opens an excessively long address menu.
- Use **Reset … settings** at the bottom of any selected device to restore that device's default configuration. Its name, position, and physical cables are preserved so a mistaken configuration can be retried quickly.
- Drag the divider beside Configuration to resize the right pane. Drag the horizontal divider above Network Tools to expose more canvas or more packet/CLI output. The sizes persist in that browser; the dividers also support arrow keys and double-click reset.
- Use **Delete** to remove the selected device and its attached links.
- Use **Undo**, **Redo**, zoom controls, or **Fit** as needed.
- Choose Ethernet, fiber, or serial before selecting **Cable**. Only compatible, available ports appear. Parallel links between the same switches are supported when each cable uses separate ports.
- **Select+** provides touch-friendly multi-selection; Ctrl/Command-click also works. Duplicate, Align H/V, Grid, Layout, and PNG export help organize larger classroom topologies.
- At narrower iPad widths, the device library becomes a horizontal touch strip and the inspector moves below the canvas.

## Device types

| Device | Main simulated capabilities |
|---|---|
| PC | One `LAN1` port; automatic DHCP or manual IPv4, mask, gateway, DNS, access VLAN, CLI, packet tools |
| Laptop | One `LAN1` port; wired settings plus SSID/password and automatic or manual addressing |
| Phone | Wireless client settings, automatic or manual IPv4, gateway, DNS, and VLAN |
| Server | Four independently addressed `LAN1`–`LAN4` ports; shared default gateway/DNS, HTTP/HTTPS/DNS/SSH services, DNS records, and forwarding |
| Layer 2 Switch | Eight `Eth1`–`Eth8` ports; VLANs, access/trunk ports, MAC learning, parallel uplinks, and RSTP; it does not route between VLANs |
| Layer 3 Switch | The same switching features plus SVIs, inter-VLAN routing, static/RIP/OSPF routes, and routed ACLs |
| Router | One `WAN` and four LAN ports; static/RIP/OSPF routing, PAT/NAT, port forwarding, ISP addressing, DHCP, and routed ACLs |
| Firewall | `WAN`, `LAN`, `DMZ`, and `OPT1`; interfaces, routes, ordered rules, stateful sessions, and port forwarding |
| Wireless AP | One `LAN1` uplink; SSID/security, 2.4/5 GHz band, channel, coverage range, roaming, and RSTP |
| Cloud | Four provider ports and configurable ISP DHCP service for router WAN interfaces |

Wireless clients associate with the nearest enabled in-range WAP whose SSID, password, and selected band match. The dotted association moves as a client roams and disappears when power, range, band, SSID, or credentials break the link. Diagnostics warns when nearby APs overlap on the same channel.

## Layer 2, Layer 3, and ACL behavior

A **Layer 2 Switch** learns and forwards within VLANs. Configure each endpoint-facing port as an access port, or identify a trunk port and its allowed VLANs. It cannot be used as a default gateway and does not accept routed ACLs.

A **Layer 3 Switch** adds switch virtual interfaces (SVIs). An SVI such as `VLAN20` provides the gateway address for that VLAN when IP routing is enabled. Its ordered ACL rules can match protocol, source/destination CIDR, optional destination port, interface, and direction. For inter-VLAN policy, attach the ACL inbound or outbound to an SVI; physical `Eth` interfaces remain available for port-oriented policy demonstrations. Routers use the same ordered ACL editor on their physical LAN/WAN interfaces. An optional implicit deny blocks routed traffic not matched by an earlier permit rule.

This is realistic at the learning level: routers and multilayer switches enforce Layer 3/4 policy, while an ordinary Layer 2 switch does not route between VLANs. ACL commands stay vendor-neutral. Stateful firewalls permit tracked return traffic, routers show PAT sessions, and port-forward rules map an external protocol/port to an internal address/port. IPv6 ACLs and control-plane ACLs remain outside the current teaching scope.

## Physical ports and link state

Each device has a finite physical-port inventory. A port can carry only one cable and advertises supported media. Copper-only client ports reject fiber and serial; combo uplinks accept their listed media. Ports support 1.544 Mbps through 40 Gbps and each link negotiates to the slower endpoint. Link width reflects speed; copper, fiber, serial, and Wi-Fi use distinct line styles. Cable settings include label, latency, loss, MTU, and serial clock rate.

Parallel switch links are drawn with separate offsets. RSTP chooses a deterministic forwarding tree using bridge priority and link preference. A redundant path is marked **STP BLOCKING** and automatically becomes usable when the forwarding path goes down. If STP is disabled across a cycle, the links flash red and Diagnostics reports broadcast-storm risk.

Old schema-version-1 topologies migrate to version 2 when opened. Migration adds safe defaults without deleting existing devices/configuration. A topology that physically exceeds a device's capacity or assigns incompatible media cannot be saved.

## Diagnostics

The bottom **Diagnostics** tab continuously checks the current topology. It reports duplicate IPv4/IPv6 addresses, unknown gateways, invalid or overlapping DHCP pools, missing DNS targets, down links, missing serial clocks, high loss, RSTP blocking, forwarding loops, isolated dynamic-routing protocols, missing router IDs, incomplete IPv6 configuration, and overlapping wireless channels. Selecting a device-specific result opens that device's configuration.

## Dynamic routing and IPv6

Routers and Layer 3 switches can use **Static only**, **RIP v2**, or **OSPF**. Reachable peers using the same protocol advertise their connected networks. RIP shows hop count; OSPF derives a learning-level cost from link latency. Static routes remain visible alongside learned routes. Use `show ip route` to compare connected (`C`), static (`S`), RIP (`R`), and OSPF (`O`) entries.

Every endpoint and routed device has an IPv6/dual-stack section with Disabled, SLAAC, or Manual mode, address, prefix length, and gateway. ICMPv6 tests validate addressing, distinguish local-prefix delivery from routed delivery, and show simulated NDP in Packet Capture. IPv4 configuration remains active, allowing side-by-side comparison.

## Automatic addressing with DHCP

New PCs, laptops, and phones start in **Automatic (DHCP)** mode. Servers start in **Manual (Static)** mode. Select a client to switch modes in the Configuration pane:

- **Automatic (DHCP)** makes address, mask, gateway, and DNS read-only because the DHCP server controls them. Connecting the client to a broadcast path with an enabled router DHCP server automatically requests a lease. Use **Request DHCP Lease** to retry or renew immediately and **Release Lease** to clear the current lease without leaving Automatic mode.
- **Manual (Static)** enables the address, mask, gateway, and DNS fields. Switching to Manual preserves the last assigned values as a starting point, but removes the DHCP lease metadata.

On a router, configure each physical LAN interface with its gateway IPv4 address, subnet mask, and VLAN. Then enable **DHCP Server**, select the one LAN interface the scope serves, and configure the pool, DNS options, lease time, and optional domain. The DHCP gateway, mask, and VLAN are derived from that interface so contradictory duplicate settings are not exposed. **Suggest pool** creates a practical range for the selected LAN. DHCP Discover is a Layer 2 broadcast: it must arrive on that physical LAN interface, use the matching VLAN, and cannot cross another router or firewall.

LAN DHCP does not answer through a router's `WAN` port. That distinction is intentional.

## Router WAN and ISP behavior

The router's **Internet / WAN** menu is separate from its LAN addressing:

- **Automatic (ISP DHCP)** requires the physical `WAN` port to connect to a Cloud with ISP DHCP enabled. The router receives an external address, mask, ISP gateway, primary/secondary DNS, and lease time. Request and Release controls are available in the inspector; `wan dhcp` does the same from the CLI.
- **Manual (Static)** enables the external address, mask, gateway, and WAN DNS fields. A valid address still reports no carrier until the physical `WAN` port is connected and enabled.
- **IPv4 NAT** translates outbound LAN client traffic to the router's external address. Outbound paths must leave through the `WAN` port. Disconnecting WAN removes carrier and releases an automatic lease; a manual address is retained but marked offline.

The router no longer has a second generic IPv4 block. LAN gateway addresses live under **LAN interfaces**, external addressing lives under **Internet / WAN**, and static routes are separate. This matches the role of each interface and avoids settings that disagree with one another.

Select a Cloud to configure its ISP pool, mask, gateway, DNS options, and lease duration. This is a safe simulation and does not inspect or modify the computer's real network configuration.

## Hierarchical DNS and HTTP

A server with the DNS service enabled has a structured DNS editor. Add records with a name, type, answer, and TTL:

- `A` maps a domain to a simulated IPv4 address.
- `CNAME` maps an alias to another domain.
- `NS` delegates a domain suffix to another simulated DNS server; enter that server's IPv4 address as the answer.

DNS servers can allow recursive resolution and list ordered fallback/forwarder DNS addresses. Clients also use their configured DNS list in order. Forwarding and delegation loops are detected, resolution depth is bounded, unreachable DNS services fail at the actual network hop, and successful answers use a per-session TTL cache.

Open the **Hierarchical DNS and Web Request** example, choose **DNS + HTTP Request** in Packet Test, and request `www.school.test`. The simulator performs the client query, NS referral, authoritative A answer, TCP port 80 connection, HTTP GET, and HTTP 200 response. If DNS returns an address with no simulated device, or the target does not have HTTP enabled, the process stops at that realistic failure point.

## Test and inspect traffic

Open **Packet Test** below the canvas:

1. Select a source and destination.
2. Select ICMP, ICMPv6, TCP, UDP, DHCP Discover, or DNS + HTTP. TCP/UDP tests may include a port.
3. Select **Send Packet**.

The result reports Delivered or Blocked, explains the decision, lists each simulated hop, and shows link/network/transport information. **Previous** and **Next** move one connection at a time. **Play loop** repeats the entire hop sequence until the same button, now labeled **Stop**, is selected again. A visible packet marker travels from the sending device to the receiving device while the current wired or wireless link is highlighted and a compact action box shows the protocol action, device names, and interface names. If an ACL, VLAN, disabled port, missing route/gateway, firewall rule, or unavailable service stops the packet, the blocked hop changes to red and displays an on-screen explanation. Configuration changes and test activity are also recorded in the bounded Event Log.

For **DHCP Discover**, choose a client and select **Send DHCP Discover**. The destination is the `255.255.255.255` broadcast address. A successful result displays DHCPDISCOVER, DHCPOFFER, DHCPREQUEST, and DHCPACK in order, followed by the assigned address, gateway, DNS servers, and lease time. A failed result identifies why no server offered a lease.

The cybersecurity tools are intentionally safe simulations:

- `ping` and `traceroute` exercise reachability and routing.
- `scan` reports services enabled on a simulated target.
- Firewall rules test allowed and denied ports.
- `inspect last` prints the last packet decision and path.
- The Packet Capture view shows a bounded, filterable frame table and protocol-layer detail.
- Seeded traffic profiles simulate classroom browsing, startup ARP/DHCP/DNS, a busy office, rogue DHCP, ARP spoofing, DNS poisoning, port scans, and SYN floods.
- IDS cards label suspicious indicators and explain why they are notable.

They do not open sockets, scan the school network, or execute operating-system commands.

### Seeded background traffic

Open **Traffic**, choose a profile, seed, and speed, then select **Start traffic** or **Step once**. The same topology, profile, and seed produce the same frame sequence, which makes teacher demonstrations and grading repeatable while still looking varied. Traffic generation runs in a Web Worker and the capture buffer is capped at 2,000 frames. **Stop traffic** pauses the simulation clock. Attack profiles generate only descriptive in-browser frames; they never transmit network traffic.

Open **Packet Capture** to filter by protocol, device, address, or info text. Select a row for Ethernet/network/transport/application details, export the current buffer as CSV, or clear the capture. ARP tables and switch MAC tables learn from captured traffic instead of listing every device in advance.

## Reference tab and generic CLI commands

The bottom **Reference** tab contains the complete CLI command catalog, common TCP/UDP port numbers with their services, and definitions for common networking and cybersecurity acronyms. Select a device, open **CLI**, and use the vendor-neutral learning commands below. The full reference is also available from **Command Reference** on the library page.

| Command | Purpose |
|---|---|
| `help` | List commands |
| `ip addr` | Show the selected device address and state |
| `ip set <address> <mask>` | Set a static IPv4 address and mask |
| `dhcp request` | Switch the client to Automatic and run the DHCP Discover/Offer/Request/Acknowledgment exchange |
| `dhcp release` | Release the current lease while remaining in Automatic mode |
| `show dhcp` | Show a client's lease or a router's DHCP configuration and active leases |
| `show ports` | Show finite physical ports, link state, speed, and connected peer |
| `wan dhcp` | Put a router WAN interface in Automatic mode and request an ISP lease |
| `show wan` | Show external address, gateway, DNS, lease state, and NAT state |
| `nslookup <domain>` | Run a hierarchical DNS lookup through the selected client's DNS configuration |
| `http get <domain>` | Resolve the domain and simulate its TCP/80 and HTTP exchange |
| `gateway set <address>` | Set the default gateway |
| `ip route` / `show routes` | Show routes |
| `route add <network>/<prefix> via <gateway>` | Add a static route |
| `ping <address>` | Test simulated ICMP reachability |
| `traceroute <address>` | Show the simulated hop path |
| `arp` | Show the simulated learned-address table |
| `show interfaces` | Show interface settings and state |
| `show mac-table` | Show devices learned by the selected switch |
| `show vlans` | Show access and trunk VLAN information |
| `vlan set <id>` | Set the selected endpoint's access VLAN |
| `show firewall` | Show firewall rules |
| `show acl` | Show ordered routed-traffic ACLs and the unmatched-traffic policy on a router or Layer 3 switch |
| `show stp` | Show forwarding, blocking, down, and loop-risk ports |
| `show ip route` | Show connected, static, RIP, and OSPF routes |
| `router protocol <static\|rip\|ospf>` | Select a routing protocol |
| `show ipv6` / `ipv6 set …` / `ping6 …` | Inspect, configure, and test IPv6 |
| `show sessions` | Show firewall state and PAT translations |
| `show ids` | Show safe scenario alerts |
| `capture start\|stop\|clear` | Control the background capture |
| `configure terminal` / `interface <port>` | Enter configuration context; interface context supports `shutdown`, `no shutdown`, `speed`, and `ip address` |
| `scan <address>` | Run a simulated common-service scan |
| `inspect last` | Print the last simulated packet result |
| `clear` | Clear CLI output |

## Built-in labs

### Lab 1: Connect a Small LAN

Students cable a PC and server through a switch, assign static `/24` addresses, and verify ping reachability. Objectives check both cables, both addresses, and the final path.

### Lab 2: Route Between Networks

Students configure two router interfaces, place a client and server on different subnets, assign both default gateways, and verify routed connectivity.

### Lab 3: Secure a Web Service

Students set a server's static address, enable HTTPS, allow TCP 443, deny TCP 22, scan the server, and inspect a successful packet.

### Lab 4: Configure a DHCP Network

Students bind a DHCP scope to a router LAN interface, set its range and DNS options, and obtain a complete client lease.

### Lab 5: Segment a Managed Switch

Students create student/faculty VLANs and assign the corresponding switch access ports and endpoint VLANs.

### Lab 6: Build Hierarchical DNS

Students configure a client resolver, an NS delegation, an authoritative A record, and HTTP before tracing the complete DNS-to-web exchange.

### Lab 7: Bring Up an ISP WAN

Students cable the correct physical WAN ports, obtain an ISP DHCP lease, and enable IPv4 NAT.

### Lab 8: Configure a Multi-Homed Server

Students address two server NICs on independent subnets and verify that each client reaches the server through the correct physical interface.

### Lab 9: Control Inter-VLAN Traffic

Students use VLAN 20 and VLAN 30 SVIs on a Layer 3 switch, apply an inbound extended ACL to the `VLAN20` SVI, block student HTTP access to the faculty subnet, and confirm unrelated ICMP traffic remains permitted.

### Labs 10–15: Advanced networking and analysis

- **Lab 10** restores a loop-free redundant fiber LAN using RSTP and tests failover.
- **Lab 11** forms a three-router OSPF domain and inspects learned routes and metrics.
- **Lab 12** adds IPv6 to a working IPv4 topology and compares ICMP with ICMPv6/NDP.
- **Lab 13** enables stateful PAT, publishes an internal web service, and inspects sessions.
- **Lab 14** removes wireless co-channel interference and tests nearest-AP roaming.
- **Lab 15** creates a seeded startup baseline, filters ARP/DHCP/DNS, then compares it with a labeled ARP-spoofing scenario.

Each objective updates immediately in the browser and is recalculated by the server whenever progress is saved. Teacher views show class totals plus an expandable roster table with every student's Not started/In progress/Completed state, objective count, score percentage, and last save time. Teachers can also review student instructions and a step-by-step solution. Teachers assign or remove only the built-in lab definitions; teacher-authored labs are not part of this version.

## Teacher workflow

1. Open **Dashboard → Network Sim**.
2. Select one class. Students may belong to multiple classes; access and assignments are stored per selected class.
3. Turn on **Allow this class** or assign a lab (which enables class access automatically).
4. Review each lab's level, expected duration, covered skills, student instructions, expandable solution, and **Student progress** table.
5. Select **Open to Demonstrate** to load a temporary, unsaved teacher copy of the starter topology with the Lab Guide and step-by-step solution available alongside the canvas.
6. Select **Assign Lab**. Select **Remove Assignment** to stop offering it to that class; saved progress remains available in simulator storage.

## Administrator and operations notes

- The global switch is stored as `network_sim_enabled` in EagleIDE configuration.
- All mutable simulator data is under `network_data/`, separate from IDE files, wiki content, and account/class files.
- `network_data/catalog.json` contains only class access and lab assignments.
- Personal networks are isolated into per-account files under `network_data/users/`.
- Lab progress uses per-student atomic files under `network_data/progress/<class>/<lab>/`. Concurrent students therefore do not rewrite a single growing progress file.
- Topology input is validated for JSON size, identifier format, supported types, valid endpoints, unique port use, media compatibility, configuration depth, and item limits before saving. Schema migrations run before validation.
- Turning the global switch off hides/blocks the app but does not delete data. Removing `network_features.py`, `network_store.py`, `network_content.py`, the network JS/CSS files, and their small registration/markup hooks removes the feature without changing IDE runners or wiki storage.
