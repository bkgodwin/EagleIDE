"""Built-in content for EagleIDE's removable network simulator module.

The catalog is source-controlled while student work and class assignments live in
``network_data``.  Keeping these constants separate from the Flask application
makes the simulator straightforward to disable or remove without touching IDE
execution code.
"""

from __future__ import annotations

import copy


DEVICE_PORTS = {
    "pc": ("LAN1",),
    "laptop": ("LAN1",),
    "phone": (),
    "server": ("LAN1", "LAN2", "LAN3", "LAN4"),
    "switch": tuple(f"Eth{index}" for index in range(1, 9)),
    "l3switch": tuple(f"Eth{index}" for index in range(1, 9)),
    "router": ("WAN", "LAN1", "LAN2", "LAN3", "LAN4"),
    "firewall": ("WAN", "LAN", "DMZ", "OPT1"),
    "wap": ("LAN1",),
    "cloud": ("WAN1", "WAN2", "WAN3", "WAN4"),
}

# Learning-level physical port capabilities. Combo ports deliberately support
# more than one medium so students can compare copper, fiber, and serial links
# without introducing vendor-specific expansion modules.
PORT_CAPABILITIES = {
    "pc": {"LAN1": ("ethernet",)},
    "laptop": {"LAN1": ("ethernet",)},
    "phone": {},
    "server": {
        "LAN1": ("ethernet",), "LAN2": ("ethernet",),
        "LAN3": ("ethernet", "fiber"), "LAN4": ("ethernet", "fiber"),
    },
    "switch": {
        **{f"Eth{index}": ("ethernet",) for index in range(1, 7)},
        "Eth7": ("ethernet", "fiber"), "Eth8": ("ethernet", "fiber"),
    },
    "l3switch": {
        **{f"Eth{index}": ("ethernet",) for index in range(1, 7)},
        "Eth7": ("ethernet", "fiber"), "Eth8": ("ethernet", "fiber"),
    },
    "router": {
        "WAN": ("ethernet", "fiber", "serial"),
        "LAN1": ("ethernet",), "LAN2": ("ethernet",),
        "LAN3": ("ethernet", "fiber"), "LAN4": ("ethernet", "serial"),
    },
    "firewall": {
        "WAN": ("ethernet", "fiber"), "LAN": ("ethernet",),
        "DMZ": ("ethernet",), "OPT1": ("ethernet", "fiber"),
    },
    "wap": {"LAN1": ("ethernet",)},
    "cloud": {
        "WAN1": ("ethernet", "fiber"), "WAN2": ("ethernet", "fiber"),
        "WAN3": ("fiber", "serial"), "WAN4": ("fiber", "serial"),
    },
}


COMMAND_REFERENCE = [
    {"command": "help", "description": "List commands available on the selected device."},
    {"command": "ip addr", "description": "Show configured IP address, mask, and interface state."},
    {"command": "ip set <address> <mask>", "description": "Set the selected device's IPv4 address and subnet mask."},
    {"command": "dhcp request", "description": "Broadcast DHCP Discover and request an automatic address lease."},
    {"command": "dhcp release", "description": "Release the selected device's simulated DHCP lease."},
    {"command": "show dhcp", "description": "Show the selected client's lease or a router's DHCP server options."},
    {"command": "show ports", "description": "Show physical ports, link state, speed, and the connected peer."},
    {"command": "wan dhcp", "description": "Set a router WAN port to DHCP and request an ISP lease."},
    {"command": "show wan", "description": "Show a router's external addressing, DNS, and NAT state."},
    {"command": "nslookup <domain>", "description": "Resolve a name through the configured hierarchical DNS servers."},
    {"command": "http get <domain>", "description": "Resolve a domain, connect to its web server, and simulate an HTTP request."},
    {"command": "gateway set <address>", "description": "Set the selected device's default gateway."},
    {"command": "ip route", "description": "Show the local routing table."},
    {"command": "route add <network>/<prefix> via <gateway>", "description": "Add a generic static route."},
    {"command": "ping <address>", "description": "Send simulated ICMP echo packets."},
    {"command": "traceroute <address>", "description": "Show the simulated path to a destination."},
    {"command": "arp", "description": "Show addresses learned during this simulation session."},
    {"command": "show interfaces", "description": "Show device interfaces and link state."},
    {"command": "show mac-table", "description": "Show a switch's learned device table."},
    {"command": "show vlans", "description": "Show VLANs and access/trunk configuration."},
    {"command": "show acl", "description": "Show ordered routed-traffic ACL rules on a router or Layer 3 switch."},
    {"command": "vlan set <id>", "description": "Set the selected endpoint or switch access VLAN."},
    {"command": "show routes", "description": "Show routes on a router or firewall."},
    {"command": "show firewall", "description": "Show simulated firewall and port rules."},
    {"command": "show stp", "description": "Show forwarding, blocking, and loop-risk port states."},
    {"command": "show ip route", "description": "Show connected, static, RIP, and OSPF routes."},
    {"command": "router protocol <static|rip|ospf>", "description": "Select the routing protocol on a router or Layer 3 switch."},
    {"command": "show ipv6", "description": "Show IPv6 mode, address, prefix, and default gateway."},
    {"command": "ipv6 set <address> [prefix]", "description": "Configure a manual IPv6 address."},
    {"command": "ping6 <address>", "description": "Send a simulated ICMPv6 echo request."},
    {"command": "show sessions", "description": "Show stateful firewall and PAT session entries."},
    {"command": "configure terminal", "description": "Enter device configuration context."},
    {"command": "interface <port>", "description": "From configuration context, select a physical interface; use shutdown/no shutdown, speed, or ip address."},
    {"command": "show ids", "description": "Show alerts produced by safe cyber traffic scenarios."},
    {"command": "capture start | stop | clear", "description": "Control seeded background traffic and the packet capture buffer."},
    {"command": "scan <address>", "description": "Run a simulated TCP service scan against a device."},
    {"command": "inspect last", "description": "Open the most recent simulated packet trace."},
    {"command": "clear", "description": "Clear the CLI output."},
]


PORT_REFERENCE = [
    {"port": "20", "transport": "TCP", "service": "FTP data", "description": "File Transfer Protocol data channel."},
    {"port": "21", "transport": "TCP", "service": "FTP control", "description": "File Transfer Protocol commands and session control."},
    {"port": "22", "transport": "TCP", "service": "SSH", "description": "Encrypted remote shell, administration, and secure file transfer."},
    {"port": "23", "transport": "TCP", "service": "Telnet", "description": "Unencrypted remote terminal service; normally replaced by SSH."},
    {"port": "25", "transport": "TCP", "service": "SMTP", "description": "Server-to-server email transfer."},
    {"port": "53", "transport": "TCP/UDP", "service": "DNS", "description": "Domain name queries; TCP is also used for larger replies and zone transfers."},
    {"port": "67", "transport": "UDP", "service": "DHCP server", "description": "Receives client requests and sends address offers."},
    {"port": "68", "transport": "UDP", "service": "DHCP client", "description": "Receives DHCP offers and acknowledgments."},
    {"port": "69", "transport": "UDP", "service": "TFTP", "description": "Simple file transfer commonly used for device boot and configuration files."},
    {"port": "80", "transport": "TCP", "service": "HTTP", "description": "Unencrypted web traffic."},
    {"port": "110", "transport": "TCP", "service": "POP3", "description": "Downloads email from a mailbox server."},
    {"port": "123", "transport": "UDP", "service": "NTP", "description": "Network time synchronization."},
    {"port": "143", "transport": "TCP", "service": "IMAP", "description": "Reads and manages email while it remains on the server."},
    {"port": "161", "transport": "UDP", "service": "SNMP", "description": "Queries and manages network devices."},
    {"port": "162", "transport": "UDP", "service": "SNMP trap", "description": "Receives unsolicited network-device alerts."},
    {"port": "389", "transport": "TCP/UDP", "service": "LDAP", "description": "Directory and identity lookups."},
    {"port": "443", "transport": "TCP", "service": "HTTPS", "description": "TLS-encrypted web traffic."},
    {"port": "445", "transport": "TCP", "service": "SMB", "description": "Windows file and printer sharing."},
    {"port": "514", "transport": "UDP", "service": "Syslog", "description": "Common destination for network and system log messages."},
    {"port": "587", "transport": "TCP", "service": "SMTP submission", "description": "Authenticated email submission from clients."},
    {"port": "636", "transport": "TCP", "service": "LDAPS", "description": "LDAP protected by TLS."},
    {"port": "993", "transport": "TCP", "service": "IMAPS", "description": "IMAP protected by TLS."},
    {"port": "995", "transport": "TCP", "service": "POP3S", "description": "POP3 protected by TLS."},
    {"port": "1433", "transport": "TCP", "service": "Microsoft SQL Server", "description": "Default Microsoft SQL Server database connection."},
    {"port": "3306", "transport": "TCP", "service": "MySQL", "description": "Default MySQL database connection."},
    {"port": "3389", "transport": "TCP/UDP", "service": "RDP", "description": "Microsoft Remote Desktop."},
    {"port": "5432", "transport": "TCP", "service": "PostgreSQL", "description": "Default PostgreSQL database connection."},
    {"port": "5900", "transport": "TCP", "service": "VNC", "description": "Remote graphical desktop control."},
    {"port": "8080", "transport": "TCP", "service": "Alternate HTTP", "description": "Common alternate port for web apps, proxies, and development servers."},
]


ACRONYM_REFERENCE = [
    {"term": "ACL", "meaning": "Access Control List", "description": "Ordered permit and deny rules that filter network traffic."},
    {"term": "ARP", "meaning": "Address Resolution Protocol", "description": "Maps an IPv4 address to a local network interface's MAC address."},
    {"term": "CIDR", "meaning": "Classless Inter-Domain Routing", "description": "Represents a network with an address and prefix length, such as 192.168.1.0/24."},
    {"term": "CLI", "meaning": "Command-Line Interface", "description": "A text interface used to inspect and configure a device."},
    {"term": "DHCP", "meaning": "Dynamic Host Configuration Protocol", "description": "Automatically assigns addresses, masks, gateways, DNS servers, and lease times."},
    {"term": "DNS", "meaning": "Domain Name System", "description": "Resolves human-readable domain names to IP addresses and other records."},
    {"term": "FTP", "meaning": "File Transfer Protocol", "description": "A legacy protocol for transferring files using separate control and data connections."},
    {"term": "HTTP", "meaning": "Hypertext Transfer Protocol", "description": "Application protocol used to request and deliver web resources."},
    {"term": "HTTPS", "meaning": "Hypertext Transfer Protocol Secure", "description": "HTTP protected by TLS encryption and server authentication."},
    {"term": "ICMP", "meaning": "Internet Control Message Protocol", "description": "Carries network status and diagnostic messages used by tools such as ping."},
    {"term": "IP", "meaning": "Internet Protocol", "description": "Provides logical addressing and packet delivery across interconnected networks."},
    {"term": "ISP", "meaning": "Internet Service Provider", "description": "An organization that connects customers or networks to the internet."},
    {"term": "LAN", "meaning": "Local Area Network", "description": "A network covering a limited area such as a classroom, office, or building."},
    {"term": "MAC", "meaning": "Media Access Control", "description": "The data-link layer identifier used to deliver frames on a local network."},
    {"term": "NAT", "meaning": "Network Address Translation", "description": "Rewrites addresses, commonly allowing private clients to share a public address."},
    {"term": "NDP", "meaning": "Neighbor Discovery Protocol", "description": "IPv6 protocol for neighbor address resolution, router discovery, and reachability."},
    {"term": "NIC", "meaning": "Network Interface Controller", "description": "The hardware or virtual interface that connects a device to a network."},
    {"term": "NTP", "meaning": "Network Time Protocol", "description": "Synchronizes clocks between networked systems."},
    {"term": "OSI", "meaning": "Open Systems Interconnection", "description": "A seven-layer conceptual model for understanding network communication."},
    {"term": "OSPF", "meaning": "Open Shortest Path First", "description": "A link-state interior routing protocol that calculates lowest-cost paths."},
    {"term": "PAT", "meaning": "Port Address Translation", "description": "Lets many private sessions share one public IP by translating source ports."},
    {"term": "RDP", "meaning": "Remote Desktop Protocol", "description": "Microsoft protocol for remotely viewing and controlling a graphical desktop."},
    {"term": "RIP", "meaning": "Routing Information Protocol", "description": "A distance-vector routing protocol that uses hop count as its metric."},
    {"term": "SSID", "meaning": "Service Set Identifier", "description": "The human-readable name advertised by a Wi-Fi network."},
    {"term": "SSH", "meaning": "Secure Shell", "description": "Encrypted protocol for remote command-line access and secure tunneling."},
    {"term": "STP/RSTP", "meaning": "(Rapid) Spanning Tree Protocol", "description": "Prevents Layer 2 loops by placing redundant switch links into a blocking state."},
    {"term": "TCP", "meaning": "Transmission Control Protocol", "description": "Connection-oriented transport with ordered, reliable delivery."},
    {"term": "TLS", "meaning": "Transport Layer Security", "description": "Encrypts application traffic and authenticates endpoints with certificates."},
    {"term": "TTL", "meaning": "Time To Live", "description": "Limits packet hops or controls how long cached DNS data remains valid."},
    {"term": "UDP", "meaning": "User Datagram Protocol", "description": "Connectionless transport with low overhead and no delivery guarantee."},
    {"term": "VLAN", "meaning": "Virtual Local Area Network", "description": "Logically separates Layer 2 broadcast domains on shared switching hardware."},
    {"term": "WAN", "meaning": "Wide Area Network", "description": "A network spanning large geographic areas or linking multiple LANs."},
    {"term": "WAP", "meaning": "Wireless Access Point", "description": "Bridges authenticated Wi-Fi clients onto a wired network."},
    {"term": "WPA2/WPA3", "meaning": "Wi-Fi Protected Access", "description": "Modern security standards for authenticating and encrypting wireless traffic."},
]


def _device(device_id, device_type, name, x, y, **config):
    defaults = {
        "ip": "",
        "mask": "255.255.255.0",
        "gateway": "",
        "vlan": 1,
        "enabled": True,
        "addressing_mode": "dhcp" if config.get("dhcp") else "static",
    }
    defaults.update(config)
    return {"id": device_id, "type": device_type, "name": name, "x": x, "y": y, "config": defaults}


def _link(link_id, source, target, source_port="eth0", target_port="eth0", kind="ethernet", **options):
    return {
        "id": link_id,
        "source": source,
        "target": target,
        "source_port": source_port,
        "target_port": target_port,
        "kind": kind,
        **options,
    }


def _topology(topology_id, title, description, devices, links, category="Examples"):
    return {
        "schema_version": 2,
        "id": topology_id,
        "title": title,
        "description": description,
        "category": category,
        "devices": devices,
        "links": links,
        "metadata": {"builtin": True, "simulation": {"seed": 1337, "profile": "classroom", "speed": 1}},
    }


EXAMPLE_TOPOLOGIES = {
    "simple-lan": _topology(
        "simple-lan",
        "Simple Classroom LAN",
        "Two workstations share a switch and a local web server.",
        [
            _device("pc1", "pc", "Workstation 1", 90, 120, ip="192.168.10.21"),
            _device("pc2", "pc", "Workstation 2", 90, 300, ip="192.168.10.22"),
            _device("sw1", "switch", "Access Switch", 350, 210, vlans=[1]),
            _device("srv1", "server", "Web Server", 620, 210, ip="192.168.10.10", services=["http"]),
        ],
        [_link("l1", "pc1", "sw1", "LAN1", "Eth1"), _link("l2", "pc2", "sw1", "LAN1", "Eth2"), _link("l3", "sw1", "srv1", "Eth3", "LAN1")],
        "Fundamentals",
    ),
    "two-subnet-router": _topology(
        "two-subnet-router",
        "Two Routed Networks",
        "A router connects student and server subnets.",
        [
            _device("pc1", "pc", "Student PC", 70, 180, ip="10.10.1.20", gateway="10.10.1.1"),
            _device("sw1", "switch", "Student Switch", 270, 180),
            _device("r1", "router", "Gateway Router", 470, 180, interfaces=[{"name": "lan1", "ip": "10.10.1.1", "mask": "255.255.255.0"}, {"name": "lan2", "ip": "10.10.2.1", "mask": "255.255.255.0"}]),
            _device("sw2", "switch", "Server Switch", 670, 180),
            _device("srv1", "server", "Application Server", 870, 180, ip="10.10.2.10", gateway="10.10.2.1", services=["http", "dns"]),
        ],
        [_link("l1", "pc1", "sw1", "LAN1", "Eth1"), _link("l2", "sw1", "r1", "Eth2", "LAN1"), _link("l3", "r1", "sw2", "LAN2", "Eth1"), _link("l4", "sw2", "srv1", "Eth2", "LAN1")],
        "Routing",
    ),
    "dhcp-office": _topology(
        "dhcp-office",
        "Small Office DHCP",
        "A router provides DHCP addresses to a small wired office.",
        [
            _device("r1", "router", "Office Router", 500, 100, ip="172.16.5.1", dhcp_enabled=True, dhcp_start="172.16.5.100", dhcp_end="172.16.5.150", dhcp_mask="255.255.255.0", dhcp_gateway="172.16.5.1", dhcp_dns_primary="172.16.5.1", dhcp_dns_secondary="1.1.1.1", dhcp_domain="office.eagle", dhcp_lease_minutes=480, dhcp_vlan=1),
            _device("sw1", "switch", "Office Switch", 500, 270),
            _device("pc1", "pc", "Reception", 180, 420, dhcp=True),
            _device("pc2", "pc", "Instructor", 500, 420, dhcp=True),
            _device("printer1", "server", "Network Printer", 820, 420, ip="172.16.5.25", services=["print"]),
        ],
        [_link("l1", "r1", "sw1", "LAN1", "Eth1"), _link("l2", "sw1", "pc1", "Eth2", "LAN1"), _link("l3", "sw1", "pc2", "Eth3", "LAN1"), _link("l4", "sw1", "printer1", "Eth4", "LAN1")],
        "Addressing",
    ),
    "vlan-classroom": _topology(
        "vlan-classroom",
        "Classroom VLAN Segmentation",
        "A Layer 3 switch routes student and teacher VLANs while an inbound ACL blocks student-to-teacher ICMP.",
        [
            _device("student1", "pc", "Student PC", 100, 120, ip="192.168.20.20", gateway="192.168.20.1", vlan=20),
            _device("teacher1", "laptop", "Teacher Laptop", 100, 340, ip="192.168.30.20", gateway="192.168.30.1", vlan=30),
            _device("sw1", "l3switch", "Layer 3 Core Switch", 420, 230, vlans=[20, 30], port_vlans={"Eth1": 20, "Eth2": 30}, trunk_ports=[], trunk_vlans=[20, 30], ip_routing=True, svis=[{"vlan": 20, "ip": "192.168.20.1", "mask": "255.255.255.0"}, {"vlan": 30, "ip": "192.168.30.1", "mask": "255.255.255.0"}], acl_rules=[{"action": "deny", "protocol": "icmp", "source": "192.168.20.0/24", "destination": "192.168.30.0/24", "port": -1, "interface": "VLAN20", "direction": "in"}], acl_default_deny=False),
        ],
        [_link("l1", "student1", "sw1", "LAN1", "Eth1"), _link("l2", "teacher1", "sw1", "LAN1", "Eth2")],
        "VLANs",
    ),
    "wireless-campus": _topology(
        "wireless-campus",
        "Wireless Classroom",
        "A secured access point connects laptops and phones to a wired server.",
        [
            _device("r1", "router", "Internet Gateway", 720, 100, ip="192.168.40.1"),
            _device("sw1", "switch", "Core Switch", 500, 210),
            _device("wap1", "wap", "Classroom WAP", 280, 210, ip="192.168.40.2", ssid="Eagle-Lab", wifi_password="learn-networking", security="WPA2"),
            _device("laptop1", "laptop", "Student Laptop", 100, 390, ip="192.168.40.31", gateway="192.168.40.1", ssid="Eagle-Lab", wifi_password="learn-networking"),
            _device("phone1", "phone", "Student Phone", 330, 420, ip="192.168.40.32", gateway="192.168.40.1", ssid="Eagle-Lab", wifi_password="learn-networking"),
            _device("srv1", "server", "Learning Server", 760, 340, ip="192.168.40.10", services=["http"]),
        ],
        [_link("l1", "r1", "sw1", "LAN1", "Eth1"), _link("l2", "sw1", "wap1", "Eth2", "LAN1"), _link("l3", "sw1", "srv1", "Eth3", "LAN1")],
        "Wireless",
    ),
    "firewall-dmz": _topology(
        "firewall-dmz",
        "Firewall and DMZ",
        "A firewall permits public web traffic while protecting an internal network.",
        [
            _device("cloud1", "cloud", "Public Network", 70, 220, ip="203.0.113.5", gateway="203.0.113.1"),
            _device("fw1", "firewall", "Edge Firewall", 330, 220, interfaces=[{"name": "outside", "ip": "203.0.113.1"}, {"name": "dmz", "ip": "192.0.2.1"}, {"name": "inside", "ip": "10.0.0.1"}], firewall_rules=[{"action": "allow", "protocol": "tcp", "port": 443}, {"action": "deny", "protocol": "tcp", "port": 22}]),
            _device("web1", "server", "DMZ Web Server", 610, 100, ip="192.0.2.10", gateway="192.0.2.1", services=["https"]),
            _device("pc1", "pc", "Internal Admin", 610, 350, ip="10.0.0.20", gateway="10.0.0.1"),
        ],
        [_link("l1", "cloud1", "fw1", "WAN1", "WAN"), _link("l2", "fw1", "web1", "DMZ", "LAN1"), _link("l3", "fw1", "pc1", "LAN", "LAN1")],
        "Cybersecurity",
    ),
    "incident-response": _topology(
        "incident-response",
        "Packet Investigation",
        "Use packet inspection and scanning tools to examine a suspicious workstation.",
        [
            _device("analyst", "laptop", "Analyst Laptop", 100, 120, ip="10.50.0.20"),
            _device("suspect", "pc", "Suspicious PC", 100, 340, ip="10.50.0.66", services=["ssh", "unknown-4444"]),
            _device("sw1", "switch", "Investigation Switch", 400, 230),
            _device("sensor", "server", "Packet Sensor", 700, 230, ip="10.50.0.5", services=["capture"]),
        ],
        [_link("l1", "analyst", "sw1", "LAN1", "Eth1"), _link("l2", "suspect", "sw1", "LAN1", "Eth2"), _link("l3", "sw1", "sensor", "Eth3", "LAN1")],
        "Cybersecurity",
    ),
    "dns-web-journey": _topology(
        "dns-web-journey",
        "Hierarchical DNS and Web Request",
        "Follow a client through DNS delegation, an authoritative answer, and an HTTP request while the edge router receives an ISP WAN lease.",
        [
            _device("pc1", "pc", "Student PC", 60, 470, ip="10.20.0.20", mask="255.255.255.0", gateway="10.20.0.1", dns_servers=["10.20.0.53"]),
            _device("sw1", "switch", "LAN Switch", 400, 330),
            _device("r1", "router", "Edge Router", 690, 190, ip="10.20.0.1", mask="255.255.255.0", wan_mode="dhcp", nat_enabled=True),
            _device("isp1", "cloud", "ISP Cloud", 850, 50, isp_dhcp_enabled=True, isp_dhcp_start="203.0.113.100", isp_dhcp_end="203.0.113.150", isp_mask="255.255.255.0", isp_gateway="203.0.113.1", isp_dns_primary="198.51.100.53", isp_dns_secondary="198.51.100.54"),
            _device("dns1", "server", "Campus Resolver", 90, 130, ip="10.20.0.53", mask="255.255.255.0", gateway="10.20.0.1", services=["dns"], dns_recursion=True, dns_records=[{"name": "school.test", "type": "NS", "value": "10.20.0.54", "ttl": 600}], dns_forwarders=[]),
            _device("dns2", "server", "School Authoritative DNS", 400, 60, ip="10.20.0.54", mask="255.255.255.0", gateway="10.20.0.1", services=["dns"], dns_recursion=False, dns_records=[{"name": "www.school.test", "type": "A", "value": "10.20.0.80", "ttl": 300}], dns_forwarders=[]),
            _device("web1", "server", "School Web Server", 760, 470, ip="10.20.0.80", mask="255.255.255.0", gateway="10.20.0.1", services=["http"]),
        ],
        [
            _link("l1", "pc1", "sw1", "LAN1", "Eth1"),
            _link("l2", "dns1", "sw1", "LAN1", "Eth2"),
            _link("l3", "dns2", "sw1", "LAN1", "Eth3"),
            _link("l4", "web1", "sw1", "LAN1", "Eth4"),
            _link("l5", "r1", "sw1", "LAN1", "Eth5"),
            _link("l6", "r1", "isp1", "WAN", "WAN1"),
        ],
        "DNS and Web",
    ),
}

EXAMPLE_TOPOLOGIES.update({
    "redundant-stp-campus": _topology(
        "redundant-stp-campus",
        "Redundant Campus with RSTP",
        "Two fiber uplinks provide redundancy while Rapid Spanning Tree blocks one path until it is needed.",
        [
            _device("pc1", "pc", "Student Workstation", 70, 250, ip="10.10.10.20"),
            _device("sw1", "switch", "Access Switch A", 300, 170, stp_enabled=True, stp_priority=24576),
            _device("sw2", "switch", "Access Switch B", 620, 170, stp_enabled=True, stp_priority=32768),
            _device("srv1", "server", "Learning Server", 850, 250, ip="10.10.10.10", services=["http"]),
        ],
        [
            _link("edge-a", "pc1", "sw1", "LAN1", "Eth1"),
            _link("fiber-primary", "sw1", "sw2", "Eth7", "Eth7", "fiber", label="Primary fiber", latency_ms=1),
            _link("fiber-backup", "sw1", "sw2", "Eth8", "Eth8", "fiber", label="Backup fiber", latency_ms=2),
            _link("edge-b", "sw2", "srv1", "Eth1", "LAN1"),
        ],
        "Switching",
    ),
    "dynamic-routing-campus": _topology(
        "dynamic-routing-campus",
        "Three-Site OSPF Campus",
        "Three routers exchange connected networks over serial WAN links using a simplified OSPF model.",
        [
            _device("pc1", "pc", "Main Campus Client", 30, 300, ip="10.1.0.20", gateway="10.1.0.1"),
            _device("r1", "router", "Main Router", 220, 300, interfaces=[{"name": "LAN1", "ip": "10.1.0.1", "mask": "255.255.255.0"}], routing_protocol="ospf", router_id="1.1.1.1"),
            _device("r2", "router", "District Router", 480, 160, interfaces=[], routing_protocol="ospf", router_id="2.2.2.2"),
            _device("r3", "router", "Remote Router", 740, 300, interfaces=[{"name": "LAN1", "ip": "10.3.0.1", "mask": "255.255.255.0"}], routing_protocol="ospf", router_id="3.3.3.3"),
            _device("srv1", "server", "Remote Application", 920, 300, ip="10.3.0.10", gateway="10.3.0.1", services=["http"]),
        ],
        [
            _link("lan-a", "pc1", "r1", "LAN1", "LAN1"),
            _link("wan-a", "r1", "r2", "WAN", "LAN4", "serial", label="Main–District", latency_ms=18, clock_rate=1544000),
            _link("wan-b", "r2", "r3", "WAN", "LAN4", "serial", label="District–Remote", latency_ms=24, clock_rate=1544000),
            _link("lan-b", "r3", "srv1", "LAN1", "LAN1"),
        ],
        "Routing",
    ),
    "dual-stack-school": _topology(
        "dual-stack-school",
        "IPv4 / IPv6 Dual-Stack School",
        "Compare IPv4 and ICMPv6 delivery across the same switched and routed physical topology.",
        [
            _device("pc1", "pc", "Dual-Stack Client", 70, 250, ip="192.168.6.20", gateway="192.168.6.1", ipv6_mode="static", ipv6_address="2001:db8:6::20", ipv6_prefix=64, ipv6_gateway="2001:db8:6::1"),
            _device("r1", "router", "Dual-Stack Router", 450, 250, interfaces=[{"name": "LAN1", "ip": "192.168.6.1", "mask": "255.255.255.0"}, {"name": "LAN2", "ip": "192.168.7.1", "mask": "255.255.255.0"}], ipv6_mode="static", ipv6_address="2001:db8:6::1", ipv6_prefix=64),
            _device("srv1", "server", "IPv6 Web Server", 820, 250, ip="192.168.7.10", gateway="192.168.7.1", ipv6_mode="static", ipv6_address="2001:db8:7::10", ipv6_prefix=64, ipv6_gateway="2001:db8:7::1", services=["http"]),
        ],
        [_link("lan-6", "pc1", "r1", "LAN1", "LAN1"), _link("lan-7", "r1", "srv1", "LAN2", "LAN1")],
        "IPv6",
    ),
    "pat-published-service": _topology(
        "pat-published-service",
        "PAT and Published Web Service",
        "A router shares one WAN address for outbound sessions and forwards TCP 8080 to an internal HTTP server.",
        [
            _device("isp1", "cloud", "ISP", 80, 80, ip="203.0.113.10", gateway="203.0.113.25", services=["http"], isp_dhcp_enabled=True),
            _device("r1", "router", "Edge Router", 380, 180, wan_mode="static", wan_ip="203.0.113.25", wan_mask="255.255.255.0", wan_gateway="203.0.113.1", wan_state="connected", nat_enabled=True, nat_mode="pat", stateful=True, interfaces=[{"name": "LAN1", "ip": "192.168.90.1", "mask": "255.255.255.0"}], port_forwards=[{"protocol": "tcp", "external_port": 8080, "internal_ip": "192.168.90.80", "internal_port": 80}]),
            _device("sw1", "switch", "LAN Switch", 620, 260),
            _device("pc1", "pc", "Staff Client", 830, 130, ip="192.168.90.20", gateway="192.168.90.1"),
            _device("srv1", "server", "Internal Web Server", 830, 390, ip="192.168.90.80", gateway="192.168.90.1", services=["http"]),
        ],
        [_link("wan", "isp1", "r1", "WAN1", "WAN", "fiber"), _link("lan", "r1", "sw1", "LAN1", "Eth1"), _link("staff", "sw1", "pc1", "Eth2", "LAN1"), _link("web", "sw1", "srv1", "Eth3", "LAN1")],
        "Security",
    ),
    "wireless-roaming": _topology(
        "wireless-roaming",
        "Wireless Channels and Roaming",
        "Two access points share an SSID on non-overlapping channels so a laptop associates with the nearest radio.",
        [
            _device("sw1", "switch", "PoE Access Switch", 450, 260),
            _device("ap1", "wap", "West Classroom AP", 220, 130, ssid="Eagle-Campus", wifi_password="learn-networking", security="WPA3", band="dual", channel=1, range=300),
            _device("ap2", "wap", "East Classroom AP", 720, 130, ssid="Eagle-Campus", wifi_password="learn-networking", security="WPA3", band="dual", channel=11, range=300),
            _device("laptop1", "laptop", "Roaming Laptop", 300, 420, ip="10.44.0.20", ssid="Eagle-Campus", wifi_password="learn-networking", wifi_band="auto"),
            _device("srv1", "server", "Wireless Learning Server", 780, 420, ip="10.44.0.10", services=["http"]),
        ],
        [_link("ap-west", "ap1", "sw1", "LAN1", "Eth1"), _link("ap-east", "ap2", "sw1", "LAN1", "Eth2"), _link("server", "sw1", "srv1", "Eth3", "LAN1")],
        "Wireless",
    ),
    "cyber-traffic-analysis": _topology(
        "cyber-traffic-analysis",
        "Cyber Traffic Analysis Range",
        "A safe capture range for comparing normal ARP, DHCP, DNS, and web traffic with labeled attack indicators.",
        [
            _device("analyst", "laptop", "Analyst Workstation", 70, 170, ip="10.77.0.20", gateway="10.77.0.1", dns_servers=["10.77.0.53"]),
            _device("suspect", "pc", "Untrusted Host", 70, 390, ip="10.77.0.66", gateway="10.77.0.1"),
            _device("sw1", "switch", "Monitored Switch", 390, 280),
            _device("r1", "router", "Security Gateway", 700, 120, interfaces=[{"name": "LAN1", "ip": "10.77.0.1", "mask": "255.255.255.0"}], dhcp_enabled=True, dhcp_start="10.77.0.100", dhcp_end="10.77.0.150", dhcp_dns_primary="10.77.0.53"),
            _device("dns1", "server", "DNS and Web Server", 720, 390, ip="10.77.0.53", gateway="10.77.0.1", services=["dns", "http"], dns_records=[{"name": "range.school.test", "type": "A", "value": "10.77.0.53", "ttl": 300}]),
        ],
        [_link("analyst-link", "analyst", "sw1", "LAN1", "Eth1"), _link("suspect-link", "suspect", "sw1", "LAN1", "Eth2"), _link("gateway-link", "sw1", "r1", "Eth3", "LAN1"), _link("server-link", "sw1", "dns1", "Eth4", "LAN1")],
        "Cybersecurity",
    ),
})

EXAMPLE_TOPOLOGIES["dns-web-journey"]["metadata"]["default_domain"] = "www.school.test"

EXAMPLE_OBJECTIVES = {
    "simple-lan": [
        {"id": "update-pc", "label": "Change Workstation 2 to 192.168.10.23/24", "kind": "device_config", "device": "pc2", "values": {"ip": "192.168.10.23", "mask": "255.255.255.0"}},
        {"id": "ping-web", "label": "Send a successful ICMP packet from Workstation 1 to Web Server", "kind": "packet_test", "source": "pc1", "target": "srv1", "protocol": "icmp", "expected": True},
    ],
    "two-subnet-router": [
        {"id": "routed-ping", "label": "Send ICMP from Student PC to Application Server and inspect both router interfaces", "kind": "packet_test", "source": "pc1", "target": "srv1", "protocol": "icmp", "expected": True},
    ],
    "dhcp-office": [
        {"id": "discover", "label": "Send DHCP Discover from Reception and review the four-message exchange", "kind": "packet_test", "source": "pc1", "target": "r1", "protocol": "dhcp", "expected": True},
    ],
    "vlan-classroom": [
        {"id": "student-blocked", "label": "Verify the Student PC ICMP packet is blocked by the Layer 3 switch ACL", "kind": "packet_test", "source": "student1", "target": "teacher1", "protocol": "icmp", "expected": False},
        {"id": "teacher-allowed", "label": "Verify Teacher Laptop can send ICMP to Student PC", "kind": "packet_test", "source": "teacher1", "target": "student1", "protocol": "icmp", "expected": True},
    ],
    "wireless-campus": [
        {"id": "wireless-ping", "label": "Send ICMP from Student Laptop through the WAP to Learning Server", "kind": "packet_test", "source": "laptop1", "target": "srv1", "protocol": "icmp", "expected": True},
    ],
    "firewall-dmz": [
        {"id": "https-allowed", "label": "Send permitted TCP/443 traffic from Public Network to DMZ Web Server", "kind": "packet_test", "source": "cloud1", "target": "web1", "protocol": "tcp", "port": 443, "expected": True},
        {"id": "ssh-blocked", "label": "Send TCP/22 and observe the firewall deny the packet", "kind": "packet_test", "source": "cloud1", "target": "web1", "protocol": "tcp", "port": 22, "expected": False},
    ],
    "incident-response": [
        {"id": "inspect-ssh", "label": "Send TCP/22 from Analyst Laptop to Suspicious PC and inspect every hop", "kind": "packet_test", "source": "analyst", "target": "suspect", "protocol": "tcp", "port": 22, "expected": True},
    ],
    "dns-web-journey": [
        {"id": "dns-http", "label": "Resolve www.school.test and complete the HTTP request", "kind": "packet_test", "source": "pc1", "protocol": "web", "domain": "www.school.test", "expected": True},
    ],
}
EXAMPLE_OBJECTIVES.update({
    "redundant-stp-campus": [
        {"id": "stp-state", "label": "Inspect the redundant fiber links and identify the RSTP-blocking path", "kind": "stp_blocked", "minimum": 1},
        {"id": "failover-test", "label": "Disable the primary fiber ports and send ICMP across the backup path", "kind": "packet_test", "source": "pc1", "target": "srv1", "protocol": "icmp", "expected": True},
    ],
    "dynamic-routing-campus": [
        {"id": "ospf-routes", "label": "Use show ip route on each router to inspect OSPF-learned networks", "kind": "routing_protocol", "device": "r2", "protocol": "ospf"},
        {"id": "routed-test", "label": "Send ICMP from Main Campus Client to Remote Application", "kind": "packet_test", "source": "pc1", "target": "srv1", "protocol": "icmp", "expected": True},
    ],
    "dual-stack-school": [
        {"id": "ipv6-test", "label": "Send ICMPv6 from the client to the IPv6 web server", "kind": "packet_test", "source": "pc1", "target": "srv1", "protocol": "icmp6", "expected": True},
        {"id": "ipv4-test", "label": "Compare the same path using IPv4 ICMP", "kind": "packet_test", "source": "pc1", "target": "srv1", "protocol": "icmp", "expected": True},
    ],
    "pat-published-service": [
        {"id": "pat-session", "label": "Send TCP/80 from Staff Client to ISP and inspect the router PAT session", "kind": "packet_test", "source": "pc1", "target": "isp1", "protocol": "tcp", "port": 80, "expected": True},
        {"id": "port-forward", "label": "Inspect the TCP 8080 → 192.168.90.80:80 port-forward rule", "kind": "port_forward", "device": "r1", "protocol": "tcp", "external_port": 8080, "internal_ip": "192.168.90.80", "internal_port": 80},
    ],
    "wireless-roaming": [
        {"id": "wireless-path", "label": "Send ICMP from Roaming Laptop to the learning server", "kind": "packet_test", "source": "laptop1", "target": "srv1", "protocol": "icmp", "expected": True},
        {"id": "roam", "label": "Move the laptop near the East AP and observe the dotted association move", "kind": "wireless_association", "device": "laptop1", "wap": "ap2"},
    ],
    "cyber-traffic-analysis": [
        {"id": "baseline", "label": "Run the Startup traffic profile and inspect ARP, DHCP, and DNS frames", "kind": "traffic_profile", "profile": "startup"},
        {"id": "attack", "label": "Run ARP spoofing traffic and inspect the IDS alert", "kind": "traffic_profile", "profile": "arp-spoof"},
    ],
})
for _example_id, _objectives in EXAMPLE_OBJECTIVES.items():
    EXAMPLE_TOPOLOGIES[_example_id]["objectives"] = copy.deepcopy(_objectives)


LABS = {
    "lab-01-connected-lan": {
        "id": "lab-01-connected-lan",
        "title": "Lab 1: Connect a Small LAN",
        "level": "Beginner",
        "estimated_minutes": 20,
        "covers": ["Ethernet links", "IPv4 addressing", "Subnet masks", "Ping"],
        "description": "Cable a workstation and server through a switch, assign static addresses, and verify connectivity.",
        "instructions": [
            "Connect the Student PC to the Access Switch.",
            "Connect the Web Server to the Access Switch.",
            "Set the Student PC to 192.168.10.20 with mask 255.255.255.0.",
            "Set the Web Server to 192.168.10.10 with mask 255.255.255.0.",
            "Use ping or the packet tool to verify that the PC can reach the server.",
        ],
        "solution": [
            "Choose Connect, then select Student PC and Access Switch.",
            "Connect Web Server to Access Switch the same way.",
            "Select Student PC and enter 192.168.10.20 / 255.255.255.0 in Config.",
            "Select Web Server and enter 192.168.10.10 / 255.255.255.0.",
            "Select Student PC, open CLI, and run: ping 192.168.10.10.",
        ],
        "objectives": [
            {"id": "pc-link", "label": "Student PC is connected to the switch", "kind": "link", "source": "pc1", "target": "sw1"},
            {"id": "server-link", "label": "Web Server is connected to the switch", "kind": "link", "source": "srv1", "target": "sw1"},
            {"id": "pc-ip", "label": "Student PC uses 192.168.10.20/24", "kind": "device_config", "device": "pc1", "values": {"ip": "192.168.10.20", "mask": "255.255.255.0"}},
            {"id": "server-ip", "label": "Web Server uses 192.168.10.10/24", "kind": "device_config", "device": "srv1", "values": {"ip": "192.168.10.10", "mask": "255.255.255.0"}},
            {"id": "ping", "label": "Student PC can reach the Web Server", "kind": "reachability", "source": "pc1", "target": "srv1", "protocol": "icmp"},
        ],
        "starter_topology": _topology(
            "lab-01-connected-lan", "Connect a Small LAN", "Complete each objective as you build.",
            [_device("pc1", "pc", "Student PC", 100, 170), _device("sw1", "switch", "Access Switch", 390, 170), _device("srv1", "server", "Web Server", 680, 170, services=["http"])], [], "Lab"
        ),
    },
    "lab-02-route-networks": {
        "id": "lab-02-route-networks",
        "title": "Lab 2: Route Between Networks",
        "level": "Beginner",
        "estimated_minutes": 30,
        "covers": ["Default gateways", "Router interfaces", "Multiple IPv4 networks", "Traceroute"],
        "description": "Configure two router interfaces so a client can reach a server on another subnet.",
        "instructions": [
            "Configure Router LAN 1 as 10.10.1.1/24 and LAN 2 as 10.10.2.1/24.",
            "Set the Student PC to 10.10.1.20/24 with gateway 10.10.1.1.",
            "Set the Application Server to 10.10.2.10/24 with gateway 10.10.2.1.",
            "Verify connectivity from the Student PC to the Application Server.",
        ],
        "solution": [
            "Select Gateway Router and add LAN 1 10.10.1.1/24 and LAN 2 10.10.2.1/24 in its interface configuration.",
            "Configure Student PC as 10.10.1.20 / 255.255.255.0 and gateway 10.10.1.1.",
            "Configure Application Server as 10.10.2.10 / 255.255.255.0 and gateway 10.10.2.1.",
            "From Student PC run: traceroute 10.10.2.10, then ping 10.10.2.10.",
        ],
        "objectives": [
            {"id": "router-interfaces", "label": "Router has both LAN interface addresses", "kind": "interfaces", "device": "r1", "addresses": ["10.10.1.1", "10.10.2.1"]},
            {"id": "pc-config", "label": "Student PC address and gateway are correct", "kind": "device_config", "device": "pc1", "values": {"ip": "10.10.1.20", "mask": "255.255.255.0", "gateway": "10.10.1.1"}},
            {"id": "server-config", "label": "Server address and gateway are correct", "kind": "device_config", "device": "srv1", "values": {"ip": "10.10.2.10", "mask": "255.255.255.0", "gateway": "10.10.2.1"}},
            {"id": "routed-ping", "label": "Student PC can reach the Application Server", "kind": "reachability", "source": "pc1", "target": "srv1", "protocol": "icmp"},
        ],
        "starter_topology": _topology(
            "lab-02-route-networks", "Route Between Networks", "Configure the endpoints and router.",
            [_device("pc1", "pc", "Student PC", 70, 200), _device("sw1", "switch", "Student Switch", 260, 200), _device("r1", "router", "Gateway Router", 470, 200, interfaces=[]), _device("sw2", "switch", "Server Switch", 680, 200), _device("srv1", "server", "Application Server", 870, 200, services=["http"])],
            [_link("l1", "pc1", "sw1", "LAN1", "Eth1"), _link("l2", "sw1", "r1", "Eth2", "LAN1"), _link("l3", "r1", "sw2", "LAN2", "Eth1"), _link("l4", "sw2", "srv1", "Eth2", "LAN1")], "Lab"
        ),
    },
    "lab-03-secure-web": {
        "id": "lab-03-secure-web",
        "title": "Lab 3: Secure a Web Service",
        "level": "Beginner",
        "estimated_minutes": 30,
        "covers": ["Server services", "Firewall rules", "TCP ports", "Port scanning", "Packet inspection"],
        "description": "Publish a web service through a firewall while keeping remote administration blocked.",
        "instructions": [
            "Set the Web Server static address to 192.0.2.10/24 with gateway 192.0.2.1.",
            "Enable HTTPS on the Web Server.",
            "Add a firewall rule allowing TCP port 443.",
            "Add a firewall rule denying TCP port 22.",
            "Run a port scan and inspect a successful HTTPS packet from the Test Client.",
        ],
        "solution": [
            "Configure Web Server as 192.0.2.10 / 255.255.255.0 with gateway 192.0.2.1.",
            "In Services, enable HTTPS.",
            "Select Edge Firewall and add Allow / TCP / 443, followed by Deny / TCP / 22.",
            "Select Test Client and run: scan 192.0.2.10.",
            "Use Packet Test with TCP port 443; open Packet Inspector to review the permitted trace.",
        ],
        "objectives": [
            {"id": "server-static", "label": "Web Server has the correct static address", "kind": "device_config", "device": "srv1", "values": {"ip": "192.0.2.10", "mask": "255.255.255.0", "gateway": "192.0.2.1"}},
            {"id": "https-service", "label": "HTTPS service is enabled", "kind": "service", "device": "srv1", "service": "https"},
            {"id": "allow-443", "label": "Firewall allows TCP port 443", "kind": "firewall_rule", "device": "fw1", "action": "allow", "protocol": "tcp", "port": 443},
            {"id": "deny-22", "label": "Firewall denies TCP port 22", "kind": "firewall_rule", "device": "fw1", "action": "deny", "protocol": "tcp", "port": 22},
            {"id": "https-path", "label": "Test Client can reach HTTPS on the Web Server", "kind": "reachability", "source": "client1", "target": "srv1", "protocol": "tcp", "port": 443},
        ],
        "starter_topology": _topology(
            "lab-03-secure-web", "Secure a Web Service", "Configure the server and firewall policy.",
            [_device("client1", "laptop", "Test Client", 80, 210, ip="203.0.113.20", gateway="203.0.113.1"), _device("fw1", "firewall", "Edge Firewall", 400, 210, interfaces=[{"name": "outside", "ip": "203.0.113.1"}, {"name": "dmz", "ip": "192.0.2.1"}], firewall_rules=[]), _device("srv1", "server", "Web Server", 720, 210, services=[])],
            [_link("l1", "client1", "fw1", "LAN1", "WAN"), _link("l2", "fw1", "srv1", "DMZ", "LAN1")], "Lab"
        ),
    },
    "lab-04-dhcp-workstation": {
        "id": "lab-04-dhcp-workstation",
        "title": "Lab 4: Configure a DHCP Network",
        "level": "Beginner",
        "estimated_minutes": 25,
        "covers": ["DHCP scopes", "Dynamic addressing", "Gateway options", "DNS options"],
        "description": "Configure a router DHCP scope and obtain a complete lease on a workstation.",
        "instructions": [
            "Configure the router DHCP pool from 192.168.50.100 through 192.168.50.150.",
            "Use LAN1 as the DHCP interface and enable the DHCP service.",
            "Assign 192.168.50.1 as DNS and 1.1.1.1 as fallback DNS.",
            "Switch the Student PC to Automatic (DHCP) and request a lease.",
            "Ping the router after the lease is assigned.",
        ],
        "solution": [
            "Open Classroom Router and expand DHCP Server.",
            "Select LAN1, enter the pool range, DNS values, and enable DHCP.",
            "Open Student PC, choose Automatic (DHCP), then select Request DHCP Lease.",
            "Confirm the client receives an address, /24 mask, 192.168.50.1 gateway, and both DNS options.",
            "From Student PC run: ping 192.168.50.1.",
        ],
        "objectives": [
            {"id": "dhcp-scope", "label": "Router DHCP scope and DNS options are configured", "kind": "device_config", "device": "r1", "values": {"dhcp_enabled": True, "dhcp_interface": "LAN1", "dhcp_start": "192.168.50.100", "dhcp_end": "192.168.50.150", "dhcp_dns_primary": "192.168.50.1", "dhcp_dns_secondary": "1.1.1.1"}},
            {"id": "client-lease", "label": "Student PC has an active DHCP lease", "kind": "dhcp_bound", "device": "pc1"},
            {"id": "router-reachable", "label": "Student PC can reach the router", "kind": "reachability", "source": "pc1", "target": "r1", "protocol": "icmp"},
        ],
        "starter_topology": _topology(
            "lab-04-dhcp-workstation", "Configure a DHCP Network", "Build a realistic DHCP scope and lease.",
            [
                _device("r1", "router", "Classroom Router", 700, 180, interfaces=[{"name": "LAN1", "ip": "192.168.50.1", "mask": "255.255.255.0", "vlan": 1}], dhcp_interface="LAN1", dhcp_enabled=False),
                _device("sw1", "switch", "Access Switch", 420, 180),
                _device("pc1", "pc", "Student PC", 120, 180),
            ],
            [_link("l1", "r1", "sw1", "LAN1", "Eth1"), _link("l2", "sw1", "pc1", "Eth2", "LAN1")], "Lab"
        ),
    },
    "lab-05-build-vlans": {
        "id": "lab-05-build-vlans",
        "title": "Lab 5: Segment a Managed Switch",
        "level": "Beginner",
        "estimated_minutes": 25,
        "covers": ["VLAN IDs", "Access ports", "Broadcast domains", "Switch configuration"],
        "description": "Create student and faculty VLANs and place two switch ports into the correct broadcast domains.",
        "instructions": [
            "Create VLAN 20 for students and VLAN 30 for faculty on the managed switch.",
            "Assign switch Eth1 to VLAN 20 and Eth2 to VLAN 30.",
            "Set the Student PC access VLAN to 20.",
            "Set the Faculty Laptop access VLAN to 30.",
            "Use the switch CLI command show vlans to verify the configuration.",
        ],
        "solution": [
            "Open Managed Switch and set VLAN IDs to 20, 30.",
            "In Access ports, enter Eth1 = 20 and Eth2 = 30 on separate lines.",
            "Open Student PC and set Access VLAN to 20.",
            "Open Faculty Laptop and set Access VLAN to 30.",
            "Select the switch and run: show vlans.",
        ],
        "objectives": [
            {"id": "switch-vlans", "label": "Switch has VLANs 20 and 30 on the correct ports", "kind": "switch_vlans", "device": "sw1", "vlans": [20, 30], "port_vlans": {"Eth1": 20, "Eth2": 30}},
            {"id": "student-vlan", "label": "Student PC is assigned to VLAN 20", "kind": "device_config", "device": "pc1", "values": {"vlan": 20}},
            {"id": "faculty-vlan", "label": "Faculty Laptop is assigned to VLAN 30", "kind": "device_config", "device": "laptop1", "values": {"vlan": 30}},
        ],
        "starter_topology": _topology(
            "lab-05-build-vlans", "Segment a Managed Switch", "Separate student and faculty devices.",
            [
                _device("pc1", "pc", "Student PC", 100, 110, ip="192.168.20.20"),
                _device("laptop1", "laptop", "Faculty Laptop", 100, 330, ip="192.168.30.20"),
                _device("sw1", "switch", "Managed Switch", 440, 220, vlans=[1], port_vlans={}),
            ],
            [_link("l1", "pc1", "sw1", "LAN1", "Eth1"), _link("l2", "laptop1", "sw1", "LAN1", "Eth2")], "Lab"
        ),
    },
    "lab-06-hierarchical-dns": {
        "id": "lab-06-hierarchical-dns",
        "title": "Lab 6: Build Hierarchical DNS",
        "level": "Intermediate",
        "estimated_minutes": 35,
        "covers": ["DNS clients", "NS delegation", "A records", "Recursive resolution", "HTTP"],
        "description": "Delegate a zone to an authoritative server, resolve a web host, and complete an HTTP request.",
        "instructions": [
            "Configure Student PC to use 10.60.0.53 for DNS.",
            "On Campus Resolver, create an NS record delegating school.test to 10.60.0.54.",
            "On Authoritative DNS, create an A record mapping www.school.test to 10.60.0.80.",
            "Confirm HTTP is enabled on School Web Server.",
            "Use DNS + HTTP Request from Student PC for www.school.test.",
        ],
        "solution": [
            "Set Student PC DNS servers to 10.60.0.53.",
            "On Campus Resolver add: school.test / NS / 10.60.0.54.",
            "On Authoritative DNS add: www.school.test / A / 10.60.0.80.",
            "Enable HTTP in School Web Server services.",
            "In Packet Test choose Student PC, DNS + HTTP Request, enter www.school.test, and run it.",
        ],
        "objectives": [
            {"id": "client-dns", "label": "Student PC uses the campus resolver", "kind": "device_config", "device": "pc1", "values": {"dns_servers": ["10.60.0.53"]}},
            {"id": "delegation", "label": "Campus Resolver delegates school.test", "kind": "dns_record", "device": "dns1", "name": "school.test", "type": "NS", "value": "10.60.0.54"},
            {"id": "host-record", "label": "Authoritative DNS resolves www.school.test", "kind": "dns_record", "device": "dns2", "name": "www.school.test", "type": "A", "value": "10.60.0.80"},
            {"id": "http-service", "label": "HTTP is enabled on the web server", "kind": "service", "device": "web1", "service": "http"},
            {"id": "dns-path", "label": "Student PC can reach the campus DNS service", "kind": "reachability", "source": "pc1", "target": "dns1", "protocol": "udp", "port": 53},
        ],
        "starter_topology": _topology(
            "lab-06-hierarchical-dns", "Build Hierarchical DNS", "Complete a delegated lookup and web request.",
            [
                _device("pc1", "pc", "Student PC", 70, 420, ip="10.60.0.20", gateway="10.60.0.1", dns_servers=[]),
                _device("sw1", "switch", "LAN Switch", 410, 260),
                _device("dns1", "server", "Campus Resolver", 80, 90, ip="10.60.0.53", services=["dns"], dns_recursion=True, dns_records=[]),
                _device("dns2", "server", "Authoritative DNS", 420, 70, ip="10.60.0.54", services=["dns"], dns_recursion=False, dns_records=[]),
                _device("web1", "server", "School Web Server", 760, 420, ip="10.60.0.80", services=[]),
                _device("r1", "router", "Gateway Router", 760, 180, interfaces=[{"name": "LAN1", "ip": "10.60.0.1", "mask": "255.255.255.0", "vlan": 1}]),
            ],
            [
                _link("l1", "pc1", "sw1", "LAN1", "Eth1"), _link("l2", "dns1", "sw1", "LAN1", "Eth2"),
                _link("l3", "dns2", "sw1", "LAN1", "Eth3"), _link("l4", "web1", "sw1", "LAN1", "Eth4"),
                _link("l5", "r1", "sw1", "LAN1", "Eth5"),
            ], "Lab"
        ),
    },
    "lab-07-wan-nat": {
        "id": "lab-07-wan-nat",
        "title": "Lab 7: Bring Up an ISP WAN",
        "level": "Intermediate",
        "estimated_minutes": 25,
        "covers": ["WAN ports", "ISP DHCP", "External IPv4", "NAT", "Carrier state"],
        "description": "Cable a router WAN to an ISP, obtain an external lease, and enable address translation for the LAN.",
        "instructions": [
            "Connect Edge Router WAN to ISP Cloud WAN1.",
            "Set External addressing to Automatic (ISP DHCP) and request a WAN lease.",
            "Confirm the router receives a 203.0.113.x address and ISP gateway.",
            "Enable IPv4 NAT for LAN clients.",
            "Review show wan and show ports in the router CLI.",
        ],
        "solution": [
            "Choose Cable, select Edge Router WAN, then ISP Cloud WAN1.",
            "Open Edge Router and select Automatic (ISP DHCP) under Internet / WAN.",
            "Select Request WAN Lease if a lease was not assigned automatically.",
            "Enable IPv4 NAT for LAN clients.",
            "Run show wan and confirm CONNECTED, the external IP, gateway, DNS, and NAT enabled.",
        ],
        "objectives": [
            {"id": "wan-cable", "label": "Router WAN is connected to ISP WAN1", "kind": "link_ports", "source": "r1", "target": "isp1", "source_port": "WAN", "target_port": "WAN1"},
            {"id": "wan-lease", "label": "Router has an active ISP lease with NAT enabled", "kind": "wan_connected", "device": "r1", "nat_required": True},
        ],
        "starter_topology": _topology(
            "lab-07-wan-nat", "Bring Up an ISP WAN", "Connect the physical WAN and obtain an external address.",
            [
                _device("pc1", "pc", "LAN Client", 80, 360, ip="192.168.70.20", gateway="192.168.70.1"),
                _device("sw1", "switch", "LAN Switch", 370, 360),
                _device("r1", "router", "Edge Router", 650, 300, interfaces=[{"name": "LAN1", "ip": "192.168.70.1", "mask": "255.255.255.0", "vlan": 1}], wan_mode="dhcp", nat_enabled=False),
                _device("isp1", "cloud", "ISP Cloud", 850, 80, isp_dhcp_enabled=True, isp_dhcp_start="203.0.113.100", isp_dhcp_end="203.0.113.150", isp_mask="255.255.255.0", isp_gateway="203.0.113.1", isp_dns_primary="198.51.100.53", isp_dns_secondary="198.51.100.54"),
            ],
            [_link("l1", "pc1", "sw1", "LAN1", "Eth1"), _link("l2", "sw1", "r1", "Eth2", "LAN1")], "Lab"
        ),
    },
    "lab-08-multihomed-server": {
        "id": "lab-08-multihomed-server",
        "title": "Lab 8: Configure a Multi-Homed Server",
        "level": "Intermediate",
        "estimated_minutes": 30,
        "covers": ["Server NICs", "Per-interface IPv4", "Multiple subnets", "Physical paths"],
        "description": "Address two independent server interfaces so clients on separate LANs can reach the correct NIC.",
        "instructions": [
            "Set Application Server LAN1 to 10.80.1.10/24.",
            "Set Application Server LAN2 to 10.80.2.10/24.",
            "Verify Client A reaches the server through LAN1.",
            "Verify Client B reaches the server through LAN2.",
            "Review the exact server ports in the packet hop animation.",
        ],
        "solution": [
            "Open Application Server and find IPv4 Interfaces.",
            "Enter 10.80.1.10 and 255.255.255.0 for LAN1.",
            "Enter 10.80.2.10 and 255.255.255.0 for LAN2.",
            "Send ICMP from Client A to Application Server, then repeat from Client B.",
            "The two packet traces should terminate on different physical server interfaces.",
        ],
        "objectives": [
            {"id": "server-lan1", "label": "Server LAN1 uses 10.80.1.10/24", "kind": "interface_config", "device": "srv1", "interface": "LAN1", "values": {"ip": "10.80.1.10", "mask": "255.255.255.0"}},
            {"id": "server-lan2", "label": "Server LAN2 uses 10.80.2.10/24", "kind": "interface_config", "device": "srv1", "interface": "LAN2", "values": {"ip": "10.80.2.10", "mask": "255.255.255.0"}},
            {"id": "client-a-path", "label": "Client A reaches server LAN1", "kind": "reachability", "source": "pc1", "target": "srv1", "protocol": "icmp"},
            {"id": "client-b-path", "label": "Client B reaches server LAN2", "kind": "reachability", "source": "pc2", "target": "srv1", "protocol": "icmp"},
        ],
        "starter_topology": _topology(
            "lab-08-multihomed-server", "Configure a Multi-Homed Server", "Address each server LAN interface independently.",
            [
                _device("pc1", "pc", "Client A", 70, 100, ip="10.80.1.20"),
                _device("sw1", "switch", "LAN A Switch", 330, 100),
                _device("srv1", "server", "Application Server", 720, 230, services=["http"], server_interfaces={}),
                _device("sw2", "switch", "LAN B Switch", 330, 390),
                _device("pc2", "pc", "Client B", 70, 390, ip="10.80.2.20"),
            ],
            [
                _link("l1", "pc1", "sw1", "LAN1", "Eth1"), _link("l2", "sw1", "srv1", "Eth2", "LAN1"),
                _link("l3", "pc2", "sw2", "LAN1", "Eth1"), _link("l4", "sw2", "srv1", "Eth2", "LAN2"),
            ], "Lab"
        ),
    },
    "lab-09-inter-vlan-acl": {
        "id": "lab-09-inter-vlan-acl",
        "title": "Lab 9: Control Inter-VLAN Traffic",
        "level": "Intermediate",
        "estimated_minutes": 35,
        "covers": ["Layer 3 switching", "SVIs", "Inter-VLAN routing", "Extended ACLs", "Ordered policy"],
        "description": "Use a Layer 3 switch ACL to block student HTTP traffic to a faculty server while leaving ICMP permitted.",
        "instructions": [
            "Review the VLAN 20 and VLAN 30 switch virtual interfaces (SVIs).",
            "Add an inbound deny rule on the VLAN20 SVI for TCP port 80 from 192.168.20.0/24 to 192.168.30.0/24.",
            "Leave unmatched routed traffic permitted.",
            "Verify Student PC HTTP traffic to Faculty Server is blocked.",
            "Verify Student PC ICMP traffic to Faculty Server remains permitted.",
        ],
        "solution": [
            "Open the Layer 3 Core Switch and confirm IP routing is enabled with VLAN20 192.168.20.1 and VLAN30 192.168.30.1.",
            "Under Routed traffic ACLs add Deny / TCP / source 192.168.20.0/24 / destination 192.168.30.0/24 / port 80 / VLAN20 / Inbound.",
            "Keep Implicitly deny unmatched routed traffic turned off so other traffic is permitted.",
            "Send TCP port 80 from Student PC to Faculty Server and observe the red blocked hop at the Layer 3 switch.",
            "Send ICMP between the same devices and confirm delivery.",
        ],
        "objectives": [
            {"id": "svis", "label": "Layer 3 switch has VLAN 20 and VLAN 30 gateway interfaces", "kind": "svis", "device": "sw1", "values": [{"vlan": 20, "ip": "192.168.20.1"}, {"vlan": 30, "ip": "192.168.30.1"}]},
            {"id": "http-acl", "label": "Inbound VLAN20 ACL denies student HTTP to the faculty subnet", "kind": "acl_rule", "device": "sw1", "values": {"action": "deny", "protocol": "tcp", "source": "192.168.20.0/24", "destination": "192.168.30.0/24", "port": 80, "interface": "VLAN20", "direction": "in"}},
            {"id": "http-blocked", "label": "Student HTTP traffic is blocked", "kind": "reachability", "source": "pc1", "target": "srv1", "protocol": "tcp", "port": 80, "expected": False},
            {"id": "icmp-allowed", "label": "Student ICMP traffic remains permitted", "kind": "reachability", "source": "pc1", "target": "srv1", "protocol": "icmp", "expected": True},
        ],
        "starter_topology": _topology(
            "lab-09-inter-vlan-acl", "Control Inter-VLAN Traffic", "Apply a focused extended ACL without blocking unrelated traffic.",
            [
                _device("pc1", "pc", "Student PC", 90, 210, ip="192.168.20.20", gateway="192.168.20.1", vlan=20),
                _device("sw1", "l3switch", "Layer 3 Core Switch", 420, 210, vlans=[20, 30], port_vlans={"Eth1": 20, "Eth2": 30}, ip_routing=True, svis=[{"vlan": 20, "ip": "192.168.20.1", "mask": "255.255.255.0"}, {"vlan": 30, "ip": "192.168.30.1", "mask": "255.255.255.0"}], acl_rules=[], acl_default_deny=False),
                _device("srv1", "server", "Faculty Server", 760, 210, ip="192.168.30.10", gateway="192.168.30.1", vlan=30, services=["http"]),
            ],
            [_link("l1", "pc1", "sw1", "LAN1", "Eth1"), _link("l2", "sw1", "srv1", "Eth2", "LAN1")], "Lab"
        ),
    },
}

_lab10_topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["redundant-stp-campus"])
_lab10_topology.update(id="lab-10-redundant-switching", title="Restore a Loop-Free Redundant LAN", category="Lab")
for _device_item in _lab10_topology["devices"]:
    if _device_item["type"] == "switch":
        _device_item["config"]["stp_enabled"] = False

_lab11_topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["dynamic-routing-campus"])
_lab11_topology.update(id="lab-11-ospf-campus", title="Configure OSPF Between Campuses", category="Lab")
for _device_item in _lab11_topology["devices"]:
    if _device_item["type"] == "router":
        _device_item["config"]["routing_protocol"] = "static"
        _device_item["config"]["router_id"] = ""

_lab12_topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["dual-stack-school"])
_lab12_topology.update(id="lab-12-dual-stack", title="Deploy an IPv6 Dual Stack", category="Lab")
for _device_item in _lab12_topology["devices"]:
    if _device_item["id"] in {"pc1", "srv1"}:
        _device_item["config"].update(ipv6_mode="disabled", ipv6_address="", ipv6_gateway="")

_lab13_topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["pat-published-service"])
_lab13_topology.update(id="lab-13-pat-publishing", title="Publish a Service with PAT", category="Lab")
for _device_item in _lab13_topology["devices"]:
    if _device_item["id"] == "r1":
        _device_item["config"].update(nat_mode="disabled", stateful=False, port_forwards=[])

_lab14_topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["wireless-roaming"])
_lab14_topology.update(id="lab-14-wireless-design", title="Plan Wireless Channels and Roaming", category="Lab")
for _device_item in _lab14_topology["devices"]:
    if _device_item["type"] == "wap":
        _device_item["config"]["channel"] = 6
    if _device_item["id"] == "laptop1":
        _device_item["config"].update(ssid="", wifi_password="")

_lab15_topology = copy.deepcopy(EXAMPLE_TOPOLOGIES["cyber-traffic-analysis"])
_lab15_topology.update(id="lab-15-traffic-analysis", title="Analyze Baseline and Suspicious Traffic", category="Lab")
_lab15_topology["metadata"]["simulation"].update(profile="classroom", completed_profiles=[])

LABS.update({
    "lab-10-redundant-switching": {
        "id": "lab-10-redundant-switching", "title": "Lab 10: Restore a Loop-Free Redundant LAN", "level": "Intermediate", "estimated_minutes": 30,
        "covers": ["Parallel links", "Fiber", "RSTP", "Broadcast loops", "Failover"],
        "description": "Enable Rapid Spanning Tree on a redundant switch pair, identify the blocked uplink, and verify failover.",
        "instructions": ["Open Diagnostics and observe the forwarding-loop warning.", "Enable Rapid Spanning Tree on both access switches.", "Set Access Switch A bridge priority to 24576.", "Confirm exactly one redundant fiber path is blocking.", "Disable the forwarding fiber ports and verify the backup link begins forwarding."],
        "solution": ["Select each switch and enable RSTP under Spanning Tree.", "Choose priority 24576 on Access Switch A and leave Switch B at 32768.", "Select each fiber link; one reports FORWARDING and one STP BLOCKING.", "Disable the forwarding link's endpoint ports.", "Send ICMP from Student Workstation to Learning Server across the recovered path."],
        "objectives": [
            {"id": "stp-a", "label": "RSTP is enabled on Access Switch A", "kind": "device_config", "device": "sw1", "values": {"stp_enabled": True, "stp_priority": 24576}},
            {"id": "stp-b", "label": "RSTP is enabled on Access Switch B", "kind": "device_config", "device": "sw2", "values": {"stp_enabled": True}},
            {"id": "stp-block", "label": "RSTP blocks one redundant fiber link", "kind": "stp_blocked", "minimum": 1},
            {"id": "reachable", "label": "The LAN remains reachable", "kind": "reachability", "source": "pc1", "target": "srv1", "protocol": "icmp"},
        ], "starter_topology": _lab10_topology,
    },
    "lab-11-ospf-campus": {
        "id": "lab-11-ospf-campus", "title": "Lab 11: Configure OSPF Between Campuses", "level": "Intermediate", "estimated_minutes": 35,
        "covers": ["Dynamic routing", "OSPF", "Router IDs", "Serial WANs", "Route metrics"],
        "description": "Form a three-router OSPF domain and inspect learned campus routes.",
        "instructions": ["Enable OSPF on all three routers.", "Assign router IDs 1.1.1.1, 2.2.2.2, and 3.3.3.3 from left to right.", "Use show ip route on District Router.", "Inspect the serial clock rates and latency-based OSPF metric.", "Send ICMP from Main Campus Client to Remote Application."],
        "solution": ["Under Dynamic Routing select OSPF on each router.", "Enter each required router ID.", "Select District Router and run show ip route.", "The route table should contain networks learned from both peers.", "Use Packet Test to verify the end-to-end routed path."],
        "objectives": [
            {"id": "ospf-1", "label": "Main Router runs OSPF with router ID 1.1.1.1", "kind": "routing_protocol", "device": "r1", "protocol": "ospf", "router_id": "1.1.1.1"},
            {"id": "ospf-2", "label": "District Router runs OSPF with router ID 2.2.2.2", "kind": "routing_protocol", "device": "r2", "protocol": "ospf", "router_id": "2.2.2.2"},
            {"id": "ospf-3", "label": "Remote Router runs OSPF with router ID 3.3.3.3", "kind": "routing_protocol", "device": "r3", "protocol": "ospf", "router_id": "3.3.3.3"},
            {"id": "campus-path", "label": "Main Campus reaches the remote application", "kind": "reachability", "source": "pc1", "target": "srv1", "protocol": "icmp"},
        ], "starter_topology": _lab11_topology,
    },
    "lab-12-dual-stack": {
        "id": "lab-12-dual-stack", "title": "Lab 12: Deploy an IPv6 Dual Stack", "level": "Intermediate", "estimated_minutes": 30,
        "covers": ["IPv6", "Dual stack", "Prefixes", "Default gateways", "ICMPv6", "NDP"],
        "description": "Add IPv6 to an existing IPv4 network without removing its working IPv4 configuration.",
        "instructions": ["Keep the existing IPv4 addresses unchanged.", "Configure Dual-Stack Client as 2001:db8:6::20/64 with gateway 2001:db8:6::1.", "Configure IPv6 Web Server as 2001:db8:7::10/64 with gateway 2001:db8:7::1.", "Send ICMPv6 between the endpoints.", "Compare the capture with an IPv4 ICMP packet."],
        "solution": ["Open IPv6 / dual stack on the client and choose Manual.", "Enter 2001:db8:6::20, prefix 64, and 2001:db8:6::1.", "Configure the server with 2001:db8:7::10/64 and 2001:db8:7::1.", "Choose ICMPv6 in Packet Test and send the packet.", "Inspect IPv6 and NDP layers in Packet Capture."],
        "objectives": [
            {"id": "ipv6-client", "label": "Client IPv6 address and gateway are configured", "kind": "ipv6_config", "device": "pc1", "address": "2001:db8:6::20", "prefix": 64, "gateway": "2001:db8:6::1"},
            {"id": "ipv6-server", "label": "Server IPv6 address and gateway are configured", "kind": "ipv6_config", "device": "srv1", "address": "2001:db8:7::10", "prefix": 64, "gateway": "2001:db8:7::1"},
            {"id": "ipv6-reach", "label": "ICMPv6 can cross the routed prefixes", "kind": "ipv6_reachability", "source": "pc1", "target": "srv1"},
        ], "starter_topology": _lab12_topology,
    },
    "lab-13-pat-publishing": {
        "id": "lab-13-pat-publishing", "title": "Lab 13: Publish a Service with PAT", "level": "Intermediate", "estimated_minutes": 30,
        "covers": ["Stateful sessions", "PAT", "Port forwarding", "TCP ports", "Web services"],
        "description": "Enable stateful PAT and publish an internal web server on an alternate external port.",
        "instructions": ["Enable stateful tracking on Edge Router.", "Set NAT behavior to PAT / NAT overload.", "Create TCP port forwarding from external 8080 to 192.168.90.80 port 80.", "Send TCP/80 from Staff Client to ISP to create an outbound PAT session.", "Run show sessions and inspect the translated source port."],
        "solution": ["Open Edge Router → NAT / stateful policy.", "Enable stateful tracking and choose PAT.", "Add TCP / 8080 / 192.168.90.80 / 80.", "Send TCP/80 from Staff Client to ISP.", "Select Edge Router and run show sessions."],
        "objectives": [
            {"id": "pat", "label": "Stateful PAT is enabled", "kind": "device_config", "device": "r1", "values": {"stateful": True, "nat_mode": "pat"}},
            {"id": "publish", "label": "TCP 8080 forwards to the internal HTTP server", "kind": "port_forward", "device": "r1", "protocol": "tcp", "external_port": 8080, "internal_ip": "192.168.90.80", "internal_port": 80},
            {"id": "pat-path", "label": "Staff Client reaches the ISP web service through PAT", "kind": "reachability", "source": "pc1", "target": "isp1", "protocol": "tcp", "port": 80},
        ], "starter_topology": _lab13_topology,
    },
    "lab-14-wireless-design": {
        "id": "lab-14-wireless-design", "title": "Lab 14: Plan Wireless Channels and Roaming", "level": "Intermediate", "estimated_minutes": 30,
        "covers": ["Wi-Fi bands", "Channels", "Interference", "Coverage", "Roaming"],
        "description": "Remove co-channel interference and configure a client to roam between two access points sharing an SSID.",
        "instructions": ["Set West Classroom AP to channel 1.", "Set East Classroom AP to channel 11.", "Keep the shared Eagle-Campus SSID and WPA3 security.", "Configure Roaming Laptop with the SSID and password learn-networking.", "Move the laptop between AP coverage areas and watch the dotted association change."],
        "solution": ["Configure the West AP channel as 1 and East AP as 11.", "Leave both APs dual band with SSID Eagle-Campus.", "Set the laptop SSID and password.", "The laptop associates with whichever matching AP is nearest and in range.", "Use Diagnostics to confirm there is no overlapping-channel warning."],
        "objectives": [
            {"id": "west-channel", "label": "West AP uses channel 1", "kind": "device_config", "device": "ap1", "values": {"channel": 1}},
            {"id": "east-channel", "label": "East AP uses channel 11", "kind": "device_config", "device": "ap2", "values": {"channel": 11}},
            {"id": "wireless-client", "label": "Laptop is associated to an Eagle-Campus AP", "kind": "wireless_association", "device": "laptop1"},
            {"id": "wireless-reach", "label": "Laptop reaches the wireless learning server", "kind": "reachability", "source": "laptop1", "target": "srv1", "protocol": "icmp"},
        ], "starter_topology": _lab14_topology,
    },
    "lab-15-traffic-analysis": {
        "id": "lab-15-traffic-analysis", "title": "Lab 15: Analyze Baseline and Suspicious Traffic", "level": "Intermediate", "estimated_minutes": 35,
        "covers": ["Packet capture", "ARP", "DHCP", "DNS", "IDS alerts", "ARP spoofing"],
        "description": "Build a repeatable baseline capture, then compare it with a safely simulated ARP-spoofing scenario.",
        "instructions": ["Open Traffic and keep seed 1337.", "Run Startup traffic and identify ARP, DHCP, and DNS frames.", "Filter Packet Capture by DHCP and inspect protocol layers.", "Switch to ARP spoofing and run at least one step.", "Explain why an unsolicited gateway ARP reply produces an IDS alert."],
        "solution": ["Choose Startup (ARP/DHCP/DNS), seed 1337, and select Step once.", "In Packet Capture filter DHCP; inspect UDP ports 67 and 68.", "Clear the filter and locate the ARP broadcast.", "Choose ARP spoofing and select Step once.", "The red frame and IDS card identify a host falsely claiming the gateway IP."],
        "objectives": [
            {"id": "baseline-profile", "label": "Startup baseline traffic has been generated", "kind": "traffic_profile", "profile": "startup"},
            {"id": "attack-profile", "label": "ARP spoofing traffic has been generated", "kind": "traffic_profile", "profile": "arp-spoof"},
        ], "starter_topology": _lab15_topology,
    },
})

del _lab10_topology, _lab11_topology, _lab12_topology, _lab13_topology, _lab14_topology, _lab15_topology, _device_item


def example_summaries():
    return [
        {
            **{key: copy.deepcopy(item[key]) for key in ("id", "title", "description", "category")},
            "objective_count": len(item.get("objectives", [])),
        }
        for item in EXAMPLE_TOPOLOGIES.values()
    ]


def lab_summary(lab, include_solution=False):
    result = {
        key: copy.deepcopy(lab[key])
        for key in ("id", "title", "level", "estimated_minutes", "covers", "description", "instructions", "objectives")
    }
    if include_solution:
        result["solution"] = copy.deepcopy(lab["solution"])
    return result
