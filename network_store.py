"""Validated persistence and deterministic grading for the network simulator."""

from __future__ import annotations

import copy
import hashlib
import ipaddress
import json
import os
import re
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from network_content import DEVICE_PORTS, LABS, PORT_CAPABILITIES


SCHEMA_VERSION = 2
MAX_DEVICES = 100
MAX_LINKS = 200
MAX_TOPOLOGY_BYTES = 512_000
MAX_SAVED_TOPOLOGIES = 40
DEVICE_TYPES = {"pc", "laptop", "phone", "server", "switch", "l3switch", "router", "firewall", "wap", "cloud"}
LINK_TYPES = {"ethernet", "fiber", "serial"}
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


class NetworkDataError(ValueError):
    pass


def migrate_topology(raw):
    """Return a current-schema copy without mutating saved runtime data in place."""
    if not isinstance(raw, dict):
        raise NetworkDataError("Topology must be an object")
    migrated = copy.deepcopy(raw)
    try:
        version = max(1, int(migrated.get("schema_version", 1) or 1))
    except (TypeError, ValueError):
        version = 1
    if version < 2:
        for device in migrated.get("devices") or []:
            if not isinstance(device, dict):
                continue
            config = device.setdefault("config", {})
            if not isinstance(config, dict):
                continue
            device_type = str(device.get("type") or "").lower()
            config.setdefault("ipv6_mode", "disabled")
            config.setdefault("ipv6_address", "")
            config.setdefault("ipv6_prefix", 64)
            config.setdefault("ipv6_gateway", "")
            if device_type in {"switch", "l3switch", "wap"}:
                config.setdefault("stp_enabled", True)
                config.setdefault("stp_priority", 32768)
            if device_type in {"router", "l3switch"}:
                config.setdefault("routing_protocol", "static")
                config.setdefault("router_id", "")
            if device_type == "firewall":
                config.setdefault("stateful", True)
                config.setdefault("port_forwards", [])
            if device_type == "wap":
                config.setdefault("band", "dual")
                config.setdefault("channel", 6)
                config.setdefault("range", 280)
        if not isinstance(migrated.get("metadata"), dict):
            migrated["metadata"] = {}
        migrated["metadata"].setdefault("simulation", {"seed": 1337, "profile": "classroom", "speed": 1})
    migrated["schema_version"] = SCHEMA_VERSION
    return migrated


def _clean_text(value, limit=160):
    value = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))
    return re.sub(r"\s+", " ", value).strip()[:limit]


def _safe_id(value, fallback=None):
    value = str(value or "").strip()
    if _ID_RE.fullmatch(value):
        return value
    if fallback is not None:
        return fallback
    raise NetworkDataError("Invalid identifier")


def _safe_json_value(value, depth=0):
    if depth > 5:
        raise NetworkDataError("Configuration is nested too deeply")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or abs(value) > 1e12):
            raise NetworkDataError("Invalid numeric configuration")
        return value
    if isinstance(value, str):
        return value[:1000]
    if isinstance(value, list):
        if len(value) > 100:
            raise NetworkDataError("Configuration list is too large")
        return [_safe_json_value(item, depth + 1) for item in value]
    if isinstance(value, dict):
        if len(value) > 100:
            raise NetworkDataError("Configuration object is too large")
        result = {}
        for key, item in value.items():
            clean_key = _clean_text(key, 80)
            if clean_key:
                result[clean_key] = _safe_json_value(item, depth + 1)
        return result
    raise NetworkDataError("Unsupported configuration value")


def validate_topology(raw, *, keep_id=True):
    if not isinstance(raw, dict):
        raise NetworkDataError("Topology must be an object")
    try:
        raw_bytes = len(json.dumps(raw, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise NetworkDataError("Topology is not valid JSON") from exc
    if raw_bytes > MAX_TOPOLOGY_BYTES:
        raise NetworkDataError("Topology is too large")

    try:
        original_version = max(1, int(raw.get("schema_version", 1) or 1))
    except (TypeError, ValueError):
        original_version = 1
    if original_version > SCHEMA_VERSION:
        raise NetworkDataError("Topology schema is newer than this server supports")
    raw = migrate_topology(raw)

    raw_devices = raw.get("devices") or []
    raw_links = raw.get("links") or []
    if not isinstance(raw_devices, list) or len(raw_devices) > MAX_DEVICES:
        raise NetworkDataError(f"A topology may contain at most {MAX_DEVICES} devices")
    if not isinstance(raw_links, list) or len(raw_links) > MAX_LINKS:
        raise NetworkDataError(f"A topology may contain at most {MAX_LINKS} links")

    devices = []
    device_ids = set()
    for index, item in enumerate(raw_devices):
        if not isinstance(item, dict):
            raise NetworkDataError("Each device must be an object")
        device_id = _safe_id(item.get("id"), f"device-{index + 1}")
        if device_id in device_ids:
            raise NetworkDataError("Device identifiers must be unique")
        device_type = str(item.get("type") or "").lower()
        if device_type not in DEVICE_TYPES:
            raise NetworkDataError(f"Unsupported device type: {device_type or 'unknown'}")
        device_ids.add(device_id)
        try:
            x = max(0.0, min(5000.0, float(item.get("x", 100))))
            y = max(0.0, min(5000.0, float(item.get("y", 100))))
        except (TypeError, ValueError) as exc:
            raise NetworkDataError("Device position must be numeric") from exc
        config = _safe_json_value(item.get("config") or {})
        if not isinstance(config, dict):
            raise NetworkDataError("Device configuration must be an object")
        devices.append({
            "id": device_id,
            "type": device_type,
            "name": _clean_text(item.get("name") or device_type.title(), 100),
            "x": round(x, 2),
            "y": round(y, 2),
            "config": config,
        })

    links = []
    link_ids = set()
    used_ports = {device_id: set() for device_id in device_ids}
    device_types = {device["id"]: device["type"] for device in devices}
    for index, item in enumerate(raw_links):
        if not isinstance(item, dict):
            raise NetworkDataError("Each link must be an object")
        link_id = _safe_id(item.get("id"), f"link-{index + 1}")
        source = _safe_id(item.get("source"))
        target = _safe_id(item.get("target"))
        if source not in device_ids or target not in device_ids or source == target:
            raise NetworkDataError("Links must connect two existing devices")
        if link_id in link_ids:
            raise NetworkDataError("Link identifiers must be unique")
        kind = str(item.get("kind") or "ethernet").lower()
        if kind not in LINK_TYPES:
            raise NetworkDataError("Unsupported link type")
        link_ids.add(link_id)
        source_ports = DEVICE_PORTS.get(device_types[source], ())
        target_ports = DEVICE_PORTS.get(device_types[target], ())
        if not source_ports or not target_ports:
            raise NetworkDataError("One of these devices has no compatible physical cable ports")
        requested_source = _clean_text(item.get("source_port"), 40)
        requested_target = _clean_text(item.get("target_port"), 40)
        if original_version >= 2:
            if requested_source not in source_ports or requested_target not in target_ports:
                raise NetworkDataError("Current-schema links must name valid physical ports")
            if requested_source in used_ports[source] or requested_target in used_ports[target]:
                raise NetworkDataError("A physical port cannot be connected to more than one cable")
        source_port = requested_source if requested_source in source_ports and requested_source not in used_ports[source] else next((port for port in source_ports if port not in used_ports[source]), None)
        target_port = requested_target if requested_target in target_ports and requested_target not in used_ports[target] else next((port for port in target_ports if port not in used_ports[target]), None)
        if not source_port or not target_port:
            raise NetworkDataError("A device does not have an available physical port for this link")
        source_media = set(PORT_CAPABILITIES.get(device_types[source], {}).get(source_port, ("ethernet",)))
        target_media = set(PORT_CAPABILITIES.get(device_types[target], {}).get(target_port, ("ethernet",)))
        compatible_media = source_media & target_media
        if kind not in compatible_media:
            if original_version < 2 and "ethernet" in compatible_media:
                kind = "ethernet"
            else:
                raise NetworkDataError(f"{kind.title()} media is not supported by both selected ports")
        used_ports[source].add(source_port)
        used_ports[target].add(target_port)
        links.append({
            "id": link_id,
            "source": source,
            "target": target,
            "source_port": source_port,
            "target_port": target_port,
            "kind": kind,
            "label": _clean_text(item.get("label"), 80),
            "latency_ms": max(0, min(5000, _as_int(item.get("latency_ms"), 1))),
            "loss_percent": round(max(0.0, min(100.0, _as_float(item.get("loss_percent"), 0.0))), 2),
            "mtu": max(576, min(9216, _as_int(item.get("mtu"), 1500))),
            "clock_rate": max(0, min(10_000_000, _as_int(item.get("clock_rate"), 0))),
        })

    topology_id = _safe_id(raw.get("id"), uuid.uuid4().hex) if keep_id else uuid.uuid4().hex
    objectives = _safe_json_value(raw.get("objectives") or [])
    if not isinstance(objectives, list):
        objectives = []
    return {
        "schema_version": SCHEMA_VERSION,
        "id": topology_id,
        "title": _clean_text(raw.get("title") or "Untitled Network", 120),
        "description": _clean_text(raw.get("description"), 500),
        "category": _clean_text(raw.get("category") or "My Networks", 80),
        "devices": devices,
        "links": links,
        "metadata": _safe_json_value(raw.get("metadata") or {}),
        "objectives": objectives[:20],
    }


def _device_map(topology):
    return {item["id"]: item for item in topology.get("devices", [])}


def _wireless_pairs(devices):
    waps = [d for d in devices.values() if d["type"] == "wap" and d.get("config", {}).get("enabled", True)]
    clients = [d for d in devices.values() if d["type"] in {"laptop", "phone"} and d.get("config", {}).get("enabled", True)]
    for client in clients:
        ccfg = client.get("config", {})
        matches = []
        for wap in waps:
            wcfg = wap.get("config", {})
            distance = (float(client.get("x", 0)) - float(wap.get("x", 0))) ** 2 + (float(client.get("y", 0)) - float(wap.get("y", 0))) ** 2
            wanted_band = str(ccfg.get("wifi_band") or "auto")
            wap_band = str(wcfg.get("band") or "dual")
            band_matches = wanted_band == "auto" or wap_band == "dual" or wanted_band == wap_band
            in_range = distance <= max(40, float(wcfg.get("range") or 280)) ** 2
            if ccfg.get("ssid") and ccfg.get("ssid") == wcfg.get("ssid") and ccfg.get("wifi_password", "") == wcfg.get("wifi_password", "") and band_matches and in_range:
                matches.append((distance, wap["id"], wap))
        if matches:
            _distance, _wap_id, wap = min(matches)
            yield client["id"], wap["id"]


def _link_is_up(link, devices):
    source_device = devices.get(link.get("source"), {})
    target_device = devices.get(link.get("target"), {})
    source_port = source_device.get("config", {}).get("ports", {}).get(link.get("source_port"), {})
    target_port = target_device.get("config", {}).get("ports", {}).get(link.get("target_port"), {})
    return (
        source_device.get("config", {}).get("enabled", True)
        and target_device.get("config", {}).get("enabled", True)
        and source_port.get("enabled", True)
        and target_port.get("enabled", True)
    )


def _stp_state(topology, devices=None):
    devices = devices or _device_map(topology)
    parent = {device_id: device_id for device_id in devices}

    def find(device_id):
        root = device_id
        while parent[root] != root:
            root = parent[root]
        while parent[device_id] != device_id:
            next_id = parent[device_id]
            parent[device_id] = root
            device_id = next_id
        return root

    def union(first, second):
        first_root, second_root = find(first), find(second)
        if first_root == second_root:
            return False
        parent[second_root] = first_root
        return True

    def priority(device):
        return _as_int(device.get("config", {}).get("stp_priority"), 32768)

    def speed_mbps(value):
        match = re.search(r"[\d.]+", str(value or ""))
        amount = float(match.group(0)) if match else 1000.0
        return amount * 1000 if "gbps" in str(value or "").lower() else amount

    def link_speed(link):
        endpoint_speeds = []
        for device_id, port_name in ((link["source"], link.get("source_port")), (link["target"], link.get("target_port"))):
            port = devices[device_id].get("config", {}).get("ports", {}).get(port_name, {})
            endpoint_speeds.append(speed_mbps(port.get("speed")))
        return min(endpoint_speeds or [1000.0])

    bridge_types = {"switch", "l3switch", "wap"}
    links = [
        link for link in topology.get("links", [])
        if _link_is_up(link, devices)
        and devices[link["source"]].get("type") in bridge_types
        and devices[link["target"]].get("type") in bridge_types
    ]
    links.sort(key=lambda link: (
        min(priority(devices[link["source"]]), priority(devices[link["target"]])),
        -link_speed(link),
        str(link.get("id") or ""),
    ))
    blocked, loop_risk = set(), set()
    for link in links:
        if union(link["source"], link["target"]):
            continue
        endpoints = (devices[link["source"]], devices[link["target"]])
        stp_enabled = any(device.get("config", {}).get("stp_enabled", True) for device in endpoints)
        if stp_enabled:
            blocked.add(link["id"])
        else:
            loop_risk.add(link["id"])
    return blocked, loop_risk


def _find_path(topology, source, target):
    devices = _device_map(topology)
    if source not in devices or target not in devices:
        return []
    graph = {key: set() for key in devices}
    blocked, _loop_risk = _stp_state(topology, devices)
    for link in topology.get("links", []):
        if _link_is_up(link, devices) and link.get("id") not in blocked and link.get("source") in graph and link.get("target") in graph:
            graph[link["source"]].add(link["target"])
            graph[link["target"]].add(link["source"])
    for first, second in _wireless_pairs(devices):
        graph[first].add(second)
        graph[second].add(first)
    queue = deque([(source, [source])])
    seen = {source}
    while queue:
        node, path = queue.popleft()
        if node == target:
            return path
        for neighbor in sorted(graph.get(node, ())):
            if neighbor not in seen and devices[neighbor].get("config", {}).get("enabled", True):
                seen.add(neighbor)
                queue.append((neighbor, path + [neighbor]))
    return []


def _ipv4(value):
    try:
        return ipaddress.ip_address(str(value or ""))
    except ValueError:
        return None


def _as_int(value, default=-1):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _cidr_matches(address, rule_value):
    value = str(rule_value or "any").strip().lower()
    if value in {"", "any", "0.0.0.0/0"}:
        return True
    try:
        network = ipaddress.ip_network(value if "/" in value else f"{value}/32", strict=False)
        return address in network
    except ValueError:
        return False


def _link_between(topology, first, second):
    return next(
        (
            link
            for link in topology.get("links", [])
            if {link.get("source"), link.get("target")} == {first, second}
        ),
        None,
    )


def _acl_permits(topology, path, device, source_ip, target_ip, protocol, port):
    config = device.get("config", {})
    rules = config.get("acl_rules", [])
    index = path.index(device["id"])
    ingress_link = _link_between(topology, path[index - 1], device["id"]) if index > 0 else None
    egress_link = _link_between(topology, device["id"], path[index + 1]) if index < len(path) - 1 else None
    ingress = str(_port_for_link(ingress_link or {}, device["id"]) or "")
    egress = str(_port_for_link(egress_link or {}, device["id"]) or "")
    devices = _device_map(topology)
    port_vlans = config.get("port_vlans", {}) if isinstance(config.get("port_vlans"), dict) else {}
    source_vlan = _as_int(port_vlans.get(ingress) or devices.get(path[0], {}).get("config", {}).get("vlan") or 1)
    target_vlan = _as_int(port_vlans.get(egress) or devices.get(path[-1], {}).get("config", {}).get("vlan") or 1)
    ingress_interfaces = {ingress.lower()}
    egress_interfaces = {egress.lower()}
    if device.get("type") == "l3switch":
        ingress_interfaces.add(f"vlan{source_vlan}")
        egress_interfaces.add(f"vlan{target_vlan}")
    protocol = str(protocol or "icmp").lower()
    wanted_port = _as_int(port)
    for rule in rules if isinstance(rules, list) else []:
        if not isinstance(rule, dict):
            continue
        rule_protocol = str(rule.get("protocol") or "any").lower()
        if rule_protocol not in {"any", protocol}:
            continue
        rule_port = _as_int(rule.get("port"))
        if rule_port > 0 and rule_port != wanted_port:
            continue
        if not _cidr_matches(source_ip, rule.get("source")) or not _cidr_matches(target_ip, rule.get("destination")):
            continue
        interface = str(rule.get("interface") or "any").lower()
        direction = str(rule.get("direction") or "both").lower()
        interface_matches = interface == "any" or (direction in {"in", "both"} and interface in ingress_interfaces) or (direction in {"out", "both"} and interface in egress_interfaces)
        if not interface_matches:
            continue
        return str(rule.get("action") or "deny").lower() == "allow"
    return not bool(config.get("acl_default_deny"))


def _network_from_config(cfg):
    try:
        return ipaddress.ip_network(f"{cfg.get('ip')}/{cfg.get('mask') or '255.255.255.0'}", strict=False)
    except ValueError:
        return None


def _network(device):
    return _network_from_config(device.get("config", {}))


def _device_knows_route(device, address):
    config = device.get("config", {})
    interfaces = [
        *[item for item in config.get("interfaces", []) if isinstance(item, dict)],
        *[item for item in config.get("svis", []) if isinstance(item, dict)],
        {"ip": config.get("ip"), "mask": config.get("mask")},
        {"ip": config.get("wan_ip"), "mask": config.get("wan_mask")},
    ]
    if any((network := _network_from_config(item)) and address in network for item in interfaces):
        return True
    return any(isinstance(route, dict) and _cidr_matches(address, route.get("network")) for route in config.get("routes", []))


def _port_for_link(link, device_id):
    if link.get("source") == device_id:
        return link.get("source_port")
    if link.get("target") == device_id:
        return link.get("target_port")
    return None


def _endpoint_config(topology, path, device_id):
    """Return the IPv4 configuration used by an endpoint on this physical path."""
    device = _device_map(topology).get(device_id, {})
    config = device.get("config", {})
    if len(path) < 2:
        return config
    neighbor = path[1] if path[0] == device_id else path[-2]
    link = next(
        (
            item
            for item in topology.get("links", [])
            if {item.get("source"), item.get("target")} == {device_id, neighbor}
        ),
        None,
    )
    port = _port_for_link(link or {}, device_id)
    if device.get("type") == "router" and port == "WAN":
        return {**config, "ip": config.get("wan_ip", ""), "mask": config.get("wan_mask") or "255.255.255.0", "gateway": config.get("wan_gateway", "")}
    if device.get("type") in {"router", "firewall"}:
        interface = next((item for item in config.get("interfaces", []) if isinstance(item, dict) and str(item.get("name") or "").upper() == str(port or "").upper()), {})
    elif device.get("type") == "server":
        interface = config.get("server_interfaces", {}).get(port, {}) if port else {}
    else:
        return config
    if not isinstance(interface, dict) or not interface.get("ip"):
        return config
    return {
        **config,
        "ip": interface.get("ip", ""),
        "mask": interface.get("mask") or "255.255.255.0",
    }


def can_reach(topology, source, target, protocol="icmp", port=None):
    devices = _device_map(topology)
    path = _find_path(topology, source, target)
    if not path:
        return False
    source_device = devices[source]
    target_device = devices[target]
    source_config = _endpoint_config(topology, path, source)
    target_config = _endpoint_config(topology, path, target)
    source_ip = _ipv4(source_config.get("ip"))
    target_ip = _ipv4(target_config.get("ip"))
    if not source_ip or not target_ip:
        return False
    source_net = _network_from_config(source_config)
    target_net = _network_from_config(target_config)
    same_network = bool(source_net and target_net and source_ip in target_net and target_ip in source_net)
    middle = [devices[item] for item in path[1:-1]]
    routing_devices = [item for item in middle if item["type"] in {"router", "firewall"} or (item["type"] == "l3switch" and item.get("config", {}).get("ip_routing", True))]
    if not same_network:
        if not routing_devices or not _ipv4(source_config.get("gateway")) or not _ipv4(target_config.get("gateway")):
            return False
        if len(routing_devices) > 1:
            protocols = [str(item.get("config", {}).get("routing_protocol") or "static").lower() for item in routing_devices]
            dynamic_ready = (
                protocols[0] in {"rip", "ospf"}
                and all(protocol == protocols[0] for protocol in protocols)
                and all(
                    item.get("type") not in {"router", "l3switch"} or item.get("config", {}).get("router_id")
                    for item in routing_devices
                )
            )
            static_ready = all(_device_knows_route(item, source_ip) and _device_knows_route(item, target_ip) for item in routing_devices)
            if not dynamic_ready and not static_ready:
                return False
        addresses = []
        for router in routing_devices:
            addresses.extend(str(i.get("ip") or "") for i in router.get("config", {}).get("interfaces", []) if isinstance(i, dict))
            addresses.extend(str(i.get("ip") or "") for i in router.get("config", {}).get("svis", []) if isinstance(i, dict))
            if router.get("config", {}).get("ip"):
                addresses.append(str(router["config"]["ip"]))
            if router.get("config", {}).get("wan_ip"):
                addresses.append(str(router["config"]["wan_ip"]))
        if str(source_config.get("gateway")) not in addresses or str(target_config.get("gateway")) not in addresses:
            return False
        for routed_device in (item for item in routing_devices if item["type"] in {"router", "l3switch"}):
            if not _acl_permits(topology, path, routed_device, source_ip, target_ip, protocol, port):
                return False
    protocol_name = str(protocol).lower()
    wanted = int(port) if protocol_name in {"tcp", "udp"} and port is not None else -1
    for firewall in (item for item in middle if item["type"] == "firewall"):
        rules = firewall.get("config", {}).get("firewall_rules", [])
        matching = next((
            rule for rule in rules
            if isinstance(rule, dict)
            and str(rule.get("protocol", "tcp")).lower() in {"any", protocol_name}
            and (protocol_name not in {"tcp", "udp"} or wanted < 0 or _as_int(rule.get("port")) in {-1, wanted})
        ), None)
        if not matching or str(matching.get("action", "")).lower() != "allow":
            return False
    if protocol_name in {"tcp", "udp"} and port is not None:
        service_names = {80: "http", 443: "https", 22: "ssh", 53: "dns"}
        expected_service = service_names.get(wanted)
        if expected_service and expected_service not in target_device.get("config", {}).get("services", []):
            return False
    return True


def can_reach_ipv6(topology, source, target):
    devices = _device_map(topology)
    path = _find_path(topology, source, target)
    if not path:
        return False
    source_config = devices[source].get("config", {})
    target_config = devices[target].get("config", {})
    try:
        source_interface = ipaddress.ip_interface(f"{source_config.get('ipv6_address')}/{_as_int(source_config.get('ipv6_prefix'), 64)}")
        target_interface = ipaddress.ip_interface(f"{target_config.get('ipv6_address')}/{_as_int(target_config.get('ipv6_prefix'), 64)}")
    except ValueError:
        return False
    if source_interface.version != 6 or target_interface.version != 6:
        return False
    if source_interface.network == target_interface.network:
        return True
    try:
        gateway = ipaddress.ip_address(str(source_config.get("ipv6_gateway") or ""))
        target_gateway = ipaddress.ip_address(str(target_config.get("ipv6_gateway") or ""))
    except ValueError:
        return False
    if gateway.version != 6 or target_gateway.version != 6:
        return False
    return any(
        devices[device_id].get("type") in {"router", "firewall", "l3switch"}
        and devices[device_id].get("config", {}).get("ip_routing", True)
        for device_id in path[1:-1]
    )


def grade_lab(lab_id, raw_topology, *, _validated=False):
    lab = LABS.get(str(lab_id))
    if not lab:
        raise NetworkDataError("Unknown lab")
    topology = raw_topology if _validated else validate_topology(raw_topology)
    devices = _device_map(topology)
    results = []
    for objective in lab["objectives"]:
        complete = False
        kind = objective.get("kind")
        device = devices.get(objective.get("device"))
        if kind == "link":
            wanted = {objective.get("source"), objective.get("target")}
            complete = any({link.get("source"), link.get("target")} == wanted for link in topology["links"])
        elif kind == "link_ports":
            source = objective.get("source")
            target = objective.get("target")
            source_port = str(objective.get("source_port") or "")
            target_port = str(objective.get("target_port") or "")
            complete = any(
                (link.get("source") == source and link.get("target") == target and link.get("source_port") == source_port and link.get("target_port") == target_port)
                or (link.get("source") == target and link.get("target") == source and link.get("source_port") == target_port and link.get("target_port") == source_port)
                for link in topology["links"]
            )
        elif kind == "device_config" and device:
            config = device.get("config", {})
            complete = all(str(config.get(key, "")) == str(value) for key, value in objective.get("values", {}).items())
        elif kind == "interfaces" and device:
            addresses = {str(item.get("ip") or "") for item in device.get("config", {}).get("interfaces", []) if isinstance(item, dict)}
            complete = set(objective.get("addresses", [])).issubset(addresses)
        elif kind == "svis" and device:
            configured = {(int(item.get("vlan", 0) or 0), str(item.get("ip") or "")) for item in device.get("config", {}).get("svis", []) if isinstance(item, dict)}
            complete = all((int(item.get("vlan", 0) or 0), str(item.get("ip") or "")) in configured for item in objective.get("values", []))
        elif kind == "interface_config" and device:
            interface = device.get("config", {}).get("server_interfaces", {}).get(str(objective.get("interface") or ""), {})
            complete = isinstance(interface, dict) and all(str(interface.get(key, "")) == str(value) for key, value in objective.get("values", {}).items())
        elif kind == "switch_vlans" and device:
            config = device.get("config", {})
            configured_vlans = {_as_int(value) for value in config.get("vlans", [])}
            configured_ports = {str(key): _as_int(value) for key, value in config.get("port_vlans", {}).items()}
            complete = set(objective.get("vlans", [])).issubset(configured_vlans) and all(configured_ports.get(str(port)) == int(vlan) for port, vlan in objective.get("port_vlans", {}).items())
        elif kind == "dns_record" and device:
            complete = any(
                isinstance(record, dict)
                and str(record.get("name", "")).lower() == str(objective.get("name", "")).lower()
                and str(record.get("type", "")).upper() == str(objective.get("type", "A")).upper()
                and str(record.get("value", "")).lower() == str(objective.get("value", "")).lower()
                for record in device.get("config", {}).get("dns_records", [])
            )
        elif kind == "dhcp_bound" and device:
            config = device.get("config", {})
            complete = config.get("addressing_mode") == "dhcp" and config.get("dhcp_state") == "bound" and _ipv4(config.get("ip")) is not None
        elif kind == "wan_connected" and device:
            config = device.get("config", {})
            complete = config.get("wan_state") == "connected" and _ipv4(config.get("wan_ip")) is not None and (not objective.get("nat_required") or config.get("nat_enabled") is not False)
        elif kind == "service" and device:
            complete = str(objective.get("service")) in device.get("config", {}).get("services", [])
        elif kind == "firewall_rule" and device:
            wanted_port = int(objective.get("port", -1))
            complete = any(
                isinstance(rule, dict)
                and str(rule.get("action", "")).lower() == str(objective.get("action", "")).lower()
                and str(rule.get("protocol", "tcp")).lower() == str(objective.get("protocol", "tcp")).lower()
                and _as_int(rule.get("port")) == wanted_port
                for rule in device.get("config", {}).get("firewall_rules", [])
            )
        elif kind == "acl_rule" and device:
            complete = any(
                isinstance(rule, dict)
                and all(str(rule.get(key, "")).lower() == str(value).lower() for key, value in objective.get("values", {}).items())
                for rule in device.get("config", {}).get("acl_rules", [])
            )
        elif kind == "stp_blocked":
            blocked, _loop_risk = _stp_state(topology, devices)
            complete = len(blocked) >= max(1, _as_int(objective.get("minimum"), 1))
        elif kind == "routing_protocol" and device:
            config = device.get("config", {})
            complete = (
                str(config.get("routing_protocol") or "static").lower() == str(objective.get("protocol") or "static").lower()
                and (not objective.get("router_id") or str(config.get("router_id") or "") == str(objective.get("router_id")))
            )
        elif kind == "ipv6_config" and device:
            config = device.get("config", {})
            complete = (
                str(config.get("ipv6_address") or "").lower() == str(objective.get("address") or "").lower()
                and _as_int(config.get("ipv6_prefix"), 64) == _as_int(objective.get("prefix"), 64)
                and (not objective.get("gateway") or str(config.get("ipv6_gateway") or "").lower() == str(objective.get("gateway")).lower())
            )
        elif kind == "ipv6_reachability":
            complete = can_reach_ipv6(topology, objective.get("source"), objective.get("target")) == bool(objective.get("expected", True))
        elif kind == "port_forward" and device:
            complete = any(
                isinstance(rule, dict)
                and str(rule.get("protocol") or "tcp").lower() == str(objective.get("protocol") or "tcp").lower()
                and _as_int(rule.get("external_port")) == _as_int(objective.get("external_port"))
                and str(rule.get("internal_ip") or "") == str(objective.get("internal_ip") or "")
                and _as_int(rule.get("internal_port")) == _as_int(objective.get("internal_port"))
                for rule in device.get("config", {}).get("port_forwards", [])
            )
        elif kind == "wireless_association" and device:
            associations = set(_wireless_pairs(devices))
            complete = any(
                client_id == device.get("id") and (not objective.get("wap") or wap_id == objective.get("wap"))
                for client_id, wap_id in associations
            )
        elif kind == "traffic_profile":
            completed_profiles = topology.get("metadata", {}).get("simulation", {}).get("completed_profiles", [])
            complete = str(objective.get("profile") or "") in completed_profiles
        elif kind == "reachability":
            reachable = can_reach(topology, objective.get("source"), objective.get("target"), objective.get("protocol", "icmp"), objective.get("port"))
            complete = reachable == bool(objective.get("expected", True))
        results.append({"id": objective["id"], "label": objective["label"], "complete": bool(complete)})
    completed = sum(1 for item in results if item["complete"])
    total = len(results)
    return {
        "lab_id": lab_id,
        "objectives": results,
        "completed": completed,
        "total": total,
        "percent": round((completed / total) * 100) if total else 100,
        "passed": completed == total,
    }


class NetworkStore:
    def __init__(self, base_dir):
        self.base_dir = Path(base_dir).expanduser().resolve()
        self.users_dir = self.base_dir / "users"
        self.progress_dir = self.base_dir / "progress"
        self.catalog_path = self.base_dir / "catalog.json"
        self._lock = threading.RLock()
        self.users_dir.mkdir(parents=True, exist_ok=True)
        self.progress_dir.mkdir(parents=True, exist_ok=True)
        if not self.catalog_path.exists():
            self._write_json(self.catalog_path, {"schema_version": SCHEMA_VERSION, "class_access": {}, "assignments": []})

    @staticmethod
    def _write_json(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    @staticmethod
    def _read_json(path, fallback):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else copy.deepcopy(fallback)
        except (OSError, ValueError):
            return copy.deepcopy(fallback)

    @staticmethod
    def _user_key(email):
        return hashlib.sha256(str(email or "").strip().lower().encode("utf-8")).hexdigest()

    def _user_path(self, email):
        return self.users_dir / f"{self._user_key(email)}.json"

    def _catalog(self):
        return self._read_json(self.catalog_path, {"schema_version": SCHEMA_VERSION, "class_access": {}, "assignments": []})

    def _progress_path(self, email, class_id, lab_id):
        safe_class = _safe_id(class_id)
        safe_lab = _safe_id(lab_id)
        return self.progress_dir / safe_class / safe_lab / f"{self._user_key(email)}.json"

    def list_topologies(self, email):
        with self._lock:
            data = self._read_json(self._user_path(email), {"topologies": []})
            return [{key: item.get(key) for key in ("id", "title", "description", "updated_at", "created_at")} for item in data.get("topologies", []) if isinstance(item, dict)]

    def get_topology(self, email, topology_id):
        wanted = _safe_id(topology_id)
        with self._lock:
            data = self._read_json(self._user_path(email), {"topologies": []})
            for item in data.get("topologies", []):
                if item.get("id") == wanted:
                    return copy.deepcopy(item)
        return None

    def save_topology(self, email, raw, topology_id=None):
        topology = validate_topology(raw)
        if topology_id:
            topology["id"] = _safe_id(topology_id)
        now = int(time.time())
        with self._lock:
            path = self._user_path(email)
            data = self._read_json(path, {"schema_version": SCHEMA_VERSION, "topologies": []})
            items = [item for item in data.get("topologies", []) if isinstance(item, dict)]
            existing = next((item for item in items if item.get("id") == topology["id"]), None)
            topology["created_at"] = existing.get("created_at", now) if existing else now
            topology["updated_at"] = now
            if existing:
                items = [topology if item.get("id") == topology["id"] else item for item in items]
            else:
                if len(items) >= MAX_SAVED_TOPOLOGIES:
                    raise NetworkDataError(f"You may save at most {MAX_SAVED_TOPOLOGIES} networks")
                items.append(topology)
            data = {"schema_version": SCHEMA_VERSION, "topologies": items}
            self._write_json(path, data)
        return copy.deepcopy(topology)

    def delete_topology(self, email, topology_id):
        wanted = _safe_id(topology_id)
        with self._lock:
            path = self._user_path(email)
            data = self._read_json(path, {"schema_version": SCHEMA_VERSION, "topologies": []})
            before = len(data.get("topologies", []))
            data["topologies"] = [item for item in data.get("topologies", []) if item.get("id") != wanted]
            if len(data["topologies"]) == before:
                return False
            self._write_json(path, data)
            return True

    def class_access(self, class_id):
        with self._lock:
            return bool(self._catalog().get("class_access", {}).get(str(class_id), False))

    def set_class_access(self, class_id, enabled):
        with self._lock:
            data = self._catalog()
            data.setdefault("class_access", {})[str(class_id)] = bool(enabled)
            self._write_json(self.catalog_path, data)
            return bool(enabled)

    def assignments_for_class(self, class_id):
        wanted = str(class_id)
        with self._lock:
            return [copy.deepcopy(item) for item in self._catalog().get("assignments", []) if item.get("class_id") == wanted]

    def assigned_lab_ids(self, class_ids):
        wanted = {str(item) for item in class_ids}
        with self._lock:
            return sorted({item.get("lab_id") for item in self._catalog().get("assignments", []) if item.get("class_id") in wanted and item.get("lab_id") in LABS})

    def assign_lab(self, class_id, lab_id, teacher_email):
        if lab_id not in LABS:
            raise NetworkDataError("Unknown lab")
        class_id = str(class_id)
        with self._lock:
            data = self._catalog()
            assignments = data.setdefault("assignments", [])
            existing = next((item for item in assignments if item.get("class_id") == class_id and item.get("lab_id") == lab_id), None)
            if not existing:
                existing = {"class_id": class_id, "lab_id": lab_id, "assigned_by": str(teacher_email).lower(), "assigned_at": int(time.time())}
                assignments.append(existing)
                data.setdefault("class_access", {})[class_id] = True
                self._write_json(self.catalog_path, data)
            return copy.deepcopy(existing)

    def unassign_lab(self, class_id, lab_id):
        class_id = str(class_id)
        with self._lock:
            data = self._catalog()
            before = len(data.get("assignments", []))
            data["assignments"] = [item for item in data.get("assignments", []) if not (item.get("class_id") == class_id and item.get("lab_id") == lab_id)]
            changed = len(data["assignments"]) != before
            if changed:
                self._write_json(self.catalog_path, data)
            return changed

    def save_progress(self, email, class_id, lab_id, raw_topology):
        topology = validate_topology(raw_topology)
        result = grade_lab(lab_id, topology, _validated=True)
        class_id = str(class_id)
        entry = {
            "class_id": class_id,
            "lab_id": lab_id,
            "student_email": str(email).strip().lower(),
            "topology": topology,
            "grade": result,
            "updated_at": int(time.time()),
        }
        with self._lock:
            self._write_json(self._progress_path(email, class_id, lab_id), entry)
        return copy.deepcopy(entry)

    def get_progress(self, email, class_id, lab_id):
        with self._lock:
            path = self._progress_path(email, class_id, lab_id)
            return copy.deepcopy(self._read_json(path, {})) if path.exists() else None

    def class_progress(self, class_id):
        class_root = self.progress_dir / _safe_id(class_id)
        with self._lock:
            if not class_root.exists():
                return []
            results = []
            for path in class_root.glob("*/*.json"):
                item = self._read_json(path, {})
                if item.get("class_id") == str(class_id):
                    results.append(copy.deepcopy(item))
            return results
