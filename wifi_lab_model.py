"""Validate lab objectives against actual devices and completed cable circuits."""

from collections import deque
import math
import ipaddress

from wifi_cabling import EQUIPMENT, _ports


class LabNetwork:
    def __init__(self, lab, site):
        self.lab, self.site = lab, site
        self.devices = {item['id']: item for item in site['equipment']}
        self.devices.update((item['id'], {**item, 'kind': 'access_point'}) for item in site['access_points'])
        self.walls = {wall['id']: wall for wall in site['walls']}
        self.roles = {}
        used = set()
        for key, role in lab['roles'].items():
            if role.get('rack'):
                rack = self.roles.get(role['rack'], {})
                found = next((d for d in self.devices.values() if d.get('rack_id') == rack.get('id') and
                              d['kind'] == role['kind'] and d.get('rack_u') == role['unit']), {})
            else:
                found = next((d for d in self.devices.values() if d['id'] not in used and d['kind'] == role['kind'] and
                              math.dist(self.location(d), role['point']) <= 1.5), {})
            self.roles[key] = found
            if found:
                used.add(found['id'])
        self.ports = {key: _ports(device) for key, device in self.devices.items()}
        self.cables = {}
        for cable in site['cables']:
            for a, b in ((cable['source'], cable['target']), (cable['target'], cable['source'])):
                self.cables[a['device_id'], a['port']] = (b, cable)
        self.edges = {key: [] for key in self.devices}
        for (device_id, port), (peer, cable) in self.cables.items():
            if self.devices[device_id]['kind'] == 'patch_panel':
                continue
            seen = set()
            while self.devices[peer['device_id']]['kind'] == 'patch_panel':
                key = (peer['device_id'], peer['port'])
                if key in seen:
                    peer = None
                    break
                seen.add(key)
                opposite = ('FRONT' + peer['port'][4:]) if peer['port'].startswith('BACK') else ('BACK' + peer['port'][5:])
                pair = self.cables.get((peer['device_id'], opposite))
                if not pair:
                    peer = None
                    break
                peer, _ = pair
            if peer:
                self.edges[device_id].append((peer['device_id'], port, peer['port']))
        self.powered = set()
        for device_id, edges in self.edges.items():
            device = self.devices[device_id]
            budget = EQUIPMENT[device['kind']].get('poe_budget', 0)
            receivers = [(peer, EQUIPMENT[self.devices[peer]['kind']].get('poe_draw', 0))
                         for peer, port, _ in edges if self.ports[device_id][port].get('poe')]
            if budget and sum(draw for _, draw in receivers) <= budget:
                self.powered.update(peer for peer, draw in receivers if draw)

    def location(self, device):
        if device.get('rack_id'):
            return self.location(self.devices[device['rack_id']])
        if device.get('wall_id'):
            wall = self.walls[device['wall_id']]
            return tuple(wall['a'][axis] + (wall['b'][axis] - wall['a'][axis]) * device['t'] for axis in ('x', 'y'))
        return device['x'], device['y']

    def ssid(self, name):
        return next((item for item in self.site['ssids'] if item['name'].casefold() == name.casefold()), None)

    def broadcast(self, device, ssid):
        return bool(ssid) and (device.get('wifi_ssid') == ssid['id'] if device.get('kind') == 'home_router'
                               else ssid['id'] in device.get('ssid_ids', []))

    def reachable(self, start, vlan=0, goal=None):
        if not start:
            return False
        target = (goal or self.roles.get('router', {})).get('id')
        queue, visited = deque([start['id']]), {start['id']}
        while queue:
            current = queue.popleft()
            if current == target:
                return True
            device = self.devices[current]
            if current != start['id'] and device['kind'] in ('desktop', 'phone', 'poe_camera', 'server', 'demarc', 'router', 'home_router'):
                continue
            for peer, port, other in self.edges[current]:
                if peer in visited or self.ports[current][port].get('wan') or self.ports[peer][other].get('wan'):
                    continue
                next_device = self.devices[peer]
                if any(d['kind'] in ('core_switch', 'distribution_switch') and vlan not in d.get('port_vlans', {}).get(p, [0])
                       for d, p in ((device, port), (next_device, other))):
                    continue
                if next_device['kind'] == 'home_router' and vlan != 0:
                    continue
                visited.add(peer)
                queue.append(peer)
        return False

    def check(self, rule):
        kind = rule['test']
        device = self.roles.get(rule.get('role'), {})
        if kind == 'device':
            return bool(device)
        if kind == 'wire':
            a, b = self.roles[rule['a']], self.roles[rule['b']]
            peer, cable = self.cables.get((a.get('id'), rule['aport']), ({}, {}))
            return bool(a and b and peer.get('device_id') == b['id'] and peer.get('port') == rule['bport'] and
                        bool(cable.get('rack_patch')) == rule['patch'] and cable.get('media') == rule['medium'])
        if kind == 'config':
            value = device
            for part in rule['field'].split('.'):
                value = value.get(part) if isinstance(value, dict) else None
            return value == rule['value'] and (rule['field'] != 'radios.5.channel' or device.get('radios', {}).get('5', {}).get('width') == 20)
        if kind == 'vlan':
            return any(v['id'] == rule['vid'] and v['name'].casefold() == rule['name'].casefold() for v in self.site['vlans'])
        if kind == 'tags':
            values = device.get('port_vlans', {}).get(rule['port'], [0])
            return bool(values) and values[0] == rule['values'][0] and set(rule['values']).issubset(values)
        if kind == 'ssid':
            ssid = self.ssid(rule['name'])
            return bool(ssid and ssid['vlan'] == rule['vid'] and ssid['band'] == rule['band'] and self.broadcast(device, ssid))
        if kind == 'join':
            ssid = self.ssid(rule['name'])
            return bool(ssid and device.get('ssid_id') == ssid['id'])
        if kind == 'service':
            return any(vm['kind'] == rule['kind'] and vm['vlan'] == rule['vid'] for vm in device.get('services', []))
        if kind == 'limit':
            ssid = self.ssid(rule['name'])
            return bool(ssid and device.get('ssid_limits', {}).get(ssid['id']) == rule['rate'])
        if kind == 'firewall':
            for rule in device.get('firewall', []):
                if rule.get('source_vlan') not in (None, 20) or rule.get('destination_vlan') not in (None, 0):
                    continue
                if rule['action'] == 'allow':
                    return False
                if (rule.get('source_vlan') == 20 and rule.get('destination_vlan') == 0
                        and not rule.get('source_ip') and not rule.get('destination_ip')):
                    return True
            return False
        if kind == 'network':
            vlan = rule.get('vlan', 0)
            return all(self.reachable(self.roles[key], vlan) for key in rule['roles'])
        if kind == 'internet':
            router, phone, isp = (self.roles.get(key, {}) for key in ('router', 'phone', 'isp'))
            if not router or not phone or not isp:
                return False
            ssid = next((s for s in self.site['ssids'] if s['id'] == phone.get('ssid_id')), None)
            if not ssid:
                return False
            aps = [d for d in self.devices.values() if (d['kind'] == 'home_router' or d['id'] in self.powered) and self.broadcast(d, ssid)]
            associated = any(math.dist(self.location(ap), self.location(phone)) <= 25 and
                             self.reachable(ap, ssid['vlan']) for ap in aps)
            gateway = ipaddress.ip_interface(router.get('dhcp', {}).get('gateway', '192.168.0.1/24')).network
            reserved = phone.get('reservation', {}).get('ip')
            for rule in router.get('firewall', []):
                if rule.get('source_vlan') not in (None, ssid['vlan']) or rule.get('destination_vlan') is not None:
                    continue
                source, destination = rule.get('source_ip'), rule.get('destination_ip')
                if destination and ipaddress.ip_address('203.0.113.10') not in ipaddress.ip_network(destination, strict=False):
                    continue
                if source:
                    scope = ipaddress.ip_network(source, strict=False)
                    if reserved:
                        if ipaddress.ip_address(reserved) not in scope:
                            continue
                    elif not gateway.subnet_of(scope):
                        continue
                if rule['action'] == 'deny':
                    return False
                break
            wan = any(peer == isp['id'] and self.ports[router['id']][port].get('wan') for peer, port, _ in self.edges[router['id']])
            return associated and wan
        return False

    def checks(self):
        return {task['id']: bool(self.check(task['rule'])) for stage in self.lab['lessons'] for task in stage['tasks']}
