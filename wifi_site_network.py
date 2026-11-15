"""Validation for Infra Sim SSIDs, switch VLANs, and router settings."""

import ipaddress
import re

from wifi_cabling import _ports


NETWORK_LIMITS = {"ssids": 64, "vlans": 64, "firewall_rules": 64}
DEFAULT_SSID = {"id": "default", "name": "Default", "band": "both", "vlan": 0}
DEFAULT_DHCP = {"gateway": "192.168.0.1/24", "dns": "1.1.1.1", "fallback_dns": "8.8.8.8"}
MANAGED_SWITCHES = {"core_switch", "distribution_switch"}
PREFIX = re.compile(r"0|[1-9][0-9]?")


def _list(value, limit, field):
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError(f"Use up to {limit} {field}")
    return value


def _records(value, field):
    for record in _list(value, NETWORK_LIMITS[field], field.replace("_", " ")):
        if not isinstance(record, dict):
            raise ValueError(f"Invalid {field.replace('_', ' ')} entry")
        yield record


def _ip(value):
    if not isinstance(value, str):
        raise ValueError("Enter an IPv4 address")
    return ipaddress.IPv4Address(value.strip())


def _cidr(value, default_prefix):
    if not isinstance(value, str):
        raise ValueError("Enter an IPv4 address or CIDR")
    addr, sep, prefix = value.strip().partition("/")
    if sep and (not PREFIX.fullmatch(prefix) or int(prefix) > 32):
        raise ValueError("Enter an IPv4 prefix from /0 to /32")
    return ipaddress.IPv4Interface(f"{_ip(addr)}/{prefix if sep else default_prefix}")


def _host_in_pool(ip, gateway):
    network = gateway.network
    return ip in network and ip not in (gateway.ip, network.network_address, network.broadcast_address)


def _usable_lan(gateway):
    network = gateway.network
    # Keep the whole scope in IPv4 unicast space, outside the loopback block.
    first, last = int(network.network_address), int(network.broadcast_address)
    return (
        network.prefixlen <= 30
        and gateway.ip not in (network.network_address, network.broadcast_address)
        and (1 << 24) <= first <= last < (224 << 24)
        and (last < (127 << 24) or first >= (128 << 24))
    )


def validate_network(raw, plan, *, label, safe_id):
    vlans = []
    vlan_ids = {0}  # VLAN 0 represents the untagged LAN.

    def vlan(value, allowed):
        if type(value) is not int or value not in allowed:
            raise ValueError("Select a defined VLAN")
        return value

    for entry in _records(raw.get("vlans", []), "vlans"):
        vid = entry.get("id")
        if type(vid) is not int or not 1 <= vid <= 4094 or vid in vlan_ids:
            raise ValueError("Use a unique VLAN ID from 1 to 4094")
        vlans.append({"id": vid, "name": label(entry.get("name", ""), 60, f"VLAN {vid}")})
        vlan_ids.add(vid)

    ssids, ssid_ids, names = [], set(), set()
    for entry in _records(raw.get("ssids", [DEFAULT_SSID]), "ssids"):
        ssid_id = safe_id(entry["id"]) if isinstance(entry.get("id"), str) else None
        name = label(entry.get("name", ""), 32)
        band = entry.get("band")
        if not ssid_id or ssid_id in ssid_ids or not name or name in names or band not in ("2.4", "5", "both"):
            raise ValueError("Use a unique SSID name and select its band")
        ssids.append({"id": ssid_id, "name": name, "band": band, "vlan": vlan(entry.get("vlan"), vlan_ids)})
        ssid_ids.add(ssid_id)
        names.add(name)
    default = [ssids[0]["id"]] if ssids else []
    for item, ap in zip(raw["access_points"], plan["access_points"]):
        enabled = _list(item.get("ssid_ids", default), 4, "SSIDs on each AP")
        if any(not isinstance(sid, str) or sid not in ssid_ids for sid in enabled) or len(set(enabled)) != len(enabled):
            raise ValueError("Select distinct, shared SSIDs for each AP")
        ap["ssid_ids"] = list(enabled)

    gateways = {}
    for item, device in zip(raw.get("equipment", []), plan["equipment"]):
        kind = device["kind"]
        if kind == "router":
            dhcp = item.get("dhcp", DEFAULT_DHCP)
            if not isinstance(dhcp, dict):
                raise ValueError("Invalid DHCP settings")
            gateway = _cidr(dhcp.get("gateway"), 24)
            if "/" not in dhcp["gateway"] or not _usable_lan(gateway):
                raise ValueError("Use a usable gateway address with a unicast subnet and room for clients")
            gateways[device["id"]] = gateway
            device["dhcp"] = {
                "gateway": str(gateway), "dns": str(_ip(dhcp.get("dns"))),
                "fallback_dns": str(_ip(dhcp.get("fallback_dns"))),
            }
            rules = []
            for rule in _records(item.get("firewall", []), "firewall_rules"):
                action = rule.get("action")
                if action not in ("allow", "deny"):
                    raise ValueError("Choose a firewall action")
                clean = {"action": action}
                for side in ("source", "destination"):
                    vid, address = rule.get(f"{side}_vlan"), rule.get(f"{side}_ip", "")
                    clean[f"{side}_vlan"] = None if vid is None else vlan(vid, vlan_ids)
                    if address == "":
                        clean[f"{side}_ip"] = ""
                    else:
                        cidr = _cidr(address, 32)
                        clean[f"{side}_ip"] = str(cidr.ip if cidr.network.prefixlen == 32 else cidr.network)
                rules.append(clean)
            device["firewall"] = rules
        elif kind in MANAGED_SWITCHES:
            entries = item.get("port_vlans", {})
            ports = _ports(device)
            if not isinstance(entries, dict) or any(port not in ports for port in entries):
                raise ValueError("Select a switch port")
            device["port_vlans"] = {}
            for port, members in entries.items():
                values = [vlan(value, vlan_ids) for value in _list(members, len(vlan_ids), "VLANs per port")]
                if len(set(values)) != len(values):
                    raise ValueError("Select distinct VLANs for each port")
                device["port_vlans"][port] = values
        elif kind == "phone":
            choice = item.get("ssid_id", "")
            if not isinstance(choice, str) or (choice and choice not in ssid_ids):
                raise ValueError("Select a shared SSID for the phone")
            device["ssid_id"] = choice

    occupied = set()
    for item, device in zip(raw.get("equipment", []), plan["equipment"]):
        reservation = item.get("reservation")
        if device["kind"] not in ("desktop", "phone") or reservation is None:
            continue
        router = reservation.get("router_id") if isinstance(reservation, dict) else None
        gateway = gateways.get(router) if isinstance(router, str) else None
        if gateway is None:
            raise ValueError("A static reservation requires its DHCP router")
        ip = _ip(reservation.get("ip"))
        if not _host_in_pool(ip, gateway) or (router, ip) in occupied:
            raise ValueError("Use a unique usable IP address in the router's pool")
        occupied.add((router, ip))
        device["reservation"] = {"router_id": router, "ip": str(ip)}

    return {"ssids": ssids, "vlans": vlans}
