/* A wired campus floor with a fiber backbone and a satellite backup WAN. */
(function () {
  'use strict';

  window.wifiCampusExample = function (plan) {
    const wall = (id, ax, ay, bx, by, material) => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, material });
    const device = (id, kind, name, x, y) => ({ id, kind, name, x, y });
    const ap = (id, name, x, y, mount = 'ceiling', angle = 0) => ({ id, name, x, y, mount, angle, power_db: 0 });
    const point = (x, y) => ({ x, y });
    const pass = pass_id => ({ pass_id });
    const wire = (id, label, source, sourcePort, target, targetPort, waypoints = [], media = 'ethernet', color) =>
      ({ id, label, media, color: color || (media === 'fiber' ? '#8f37ae' : '#0879b3'), waypoints,
        source: { device_id: source, port: sourcePort }, target: { device_id: target, port: targetPort } });
    const jack = (id, name, wall_id, t) => ({ id, kind: 'keystone', name, wall_id, t });
    return {
      ...plan, title: 'Northfield Learning Center',
      walls: [
        wall('north', 0, 0, 64, 0, 'concrete'), wall('south', 0, 37, 64, 37, 'concrete'),
        wall('west', 0, 0, 0, 37, 'concrete'), wall('east', 64, 0, 64, 37, 'concrete'),
        wall('partition', 32, 0, 32, 37, 'concrete'),
        wall('corridor-west-top', 0, 15, 32, 15, 'drywall'), wall('corridor-east-top', 32, 15, 64, 15, 'drywall'),
        wall('corridor-west-bottom', 0, 22, 32, 22, 'brick'), wall('corridor-east-bottom', 32, 22, 64, 22, 'drywall'),
        wall('west-rooms', 15, 0, 15, 15, 'drywall'), wall('west-south-rooms', 15, 22, 15, 37, 'drywall'),
        wall('east-rooms', 47, 0, 47, 15, 'drywall'), wall('east-south-rooms', 49, 22, 49, 37, 'glass'),
      ],
      openings: [
        { id: 'door-n1', kind: 'door', material: 'wood', wall_id: 'corridor-west-top', t: 0.3, width: 1.2 },
        { id: 'door-n2', kind: 'door', material: 'glass', wall_id: 'corridor-west-top', t: 0.72, width: 1.4 },
        { id: 'door-n3', kind: 'door', material: 'wood', wall_id: 'corridor-east-top', t: 0.31, width: 1.2 },
        { id: 'door-n4', kind: 'door', material: 'wood', wall_id: 'corridor-east-top', t: 0.7, width: 1.2 },
        { id: 'door-s1', kind: 'door', material: 'metal', wall_id: 'corridor-west-bottom', t: 0.27, width: 1.1 },
        { id: 'door-s2', kind: 'door', material: 'wood', wall_id: 'corridor-west-bottom', t: 0.7, width: 1.2 },
        { id: 'door-s3', kind: 'door', material: 'glass', wall_id: 'corridor-east-bottom', t: 0.34, width: 1.5 },
        { id: 'door-s4', kind: 'door', material: 'glass', wall_id: 'corridor-east-bottom', t: 0.74, width: 1.5 },
        { id: 'fire-door', kind: 'door', material: 'metal', wall_id: 'partition', t: 0.56, width: 1.4 },
        { id: 'window-n', kind: 'window', material: 'coated_glass', wall_id: 'north', t: 0.44, width: 5 },
        { id: 'window-s', kind: 'window', material: 'glass', wall_id: 'south', t: 0.69, width: 6 },
      ],
      equipment: [
        device('router', 'router', 'Edge router', 5, 25), device('core', 'core_switch', 'Campus core', 10, 29),
        device('west-dist', 'distribution_switch', 'West IDF', 19, 18), device('east-dist', 'distribution_switch', 'East IDF', 39, 18),
        device('media-switch', 'access_switch', 'Media access switch', 56, 28),
        { id: 'isp-fiber', kind: 'demarc', isp: 'alderline', name: '', wall_id: 'west', t: 0.7 },
        { id: 'isp-backup', kind: 'demarc', isp: 'cindersky', name: '', wall_id: 'west', t: 0.86 },
        jack('jack-stem', 'STEM jack', 'corridor-west-top', 0.67), jack('jack-library', 'Library jack', 'corridor-east-bottom', 0.36),
        jack('jack-media', 'Media jack', 'east-south-rooms', 0.67),
      ],
      pass_throughs: [{ id: 'east-trunk', wall_id: 'partition', t: 0.48 }, { id: 'spare-pass', wall_id: 'partition', t: 0.78 }],
      access_points: [
        ap('ap-admin', 'Admin AP', 7, 9), ap('ap-stem', 'STEM AP', 23, 8),
        ap('ap-west', 'Workshop AP', 23, 30), ap('ap-class', 'Classroom AP', 41, 8),
        ap('ap-meet', 'Meeting AP', 55, 8), ap('ap-library', 'Library AP', 42, 30),
        ap('ap-media', 'Media AP', 57, 32, 'wall', 265),
      ],
      labels: [
        ['Administration', 4, 3], ['STEM lab', 19, 3], ['Workshop', 19, 25], ['Network room', 4, 35],
        ['Classroom', 38, 3], ['Meeting room', 51, 3], ['Library', 37, 25], ['Media studio', 52, 35],
      ].map(([text, x, y], i) => ({ id: `room-label-${i}`, text, x, y })),
      cables: [
        wire('wan-fiber', 'Primary WAN', 'isp-fiber', 'ISP', 'router', 'WAN-SFP1', [], 'fiber'),
        wire('wan-backup', 'Satellite backup', 'isp-backup', 'ISP', 'router', 'WAN1', [point(2, 31), point(2, 25)], 'ethernet', '#966012'),
        wire('core-fiber', 'Core uplink', 'router', 'SFP1', 'core', 'SFP1', [point(10, 25)], 'fiber'),
        wire('west-fiber', 'West uplink', 'core', 'SFP2', 'west-dist', 'SFP1', [point(12, 29), point(12, 18)], 'fiber'),
        wire('east-fiber', 'East uplink', 'core', 'SFP3', 'east-dist', 'SFP1', [point(12, 29), point(12, 17.76), pass('east-trunk'), point(39, 17.76)], 'fiber'),
        wire('east-spare', 'East secondary run', 'core', 'SFP4', 'east-dist', 'SFP2', [point(12, 29), point(12, 17.76), pass('east-trunk'), point(39, 17.76)], 'fiber'),
        wire('west-admin', '', 'west-dist', 'ETH1', 'ap-admin', 'ETH1', [point(7, 18)]),
        wire('west-stem', '', 'west-dist', 'ETH2', 'jack-stem', 'BACK', [point(21.44, 18)]),
        wire('stem-patch', '', 'jack-stem', 'FRONT', 'ap-stem', 'ETH1', [], 'ethernet', '#18816f'),
        wire('west-workshop', '', 'west-dist', 'ETH3', 'ap-west', 'ETH1', [point(23, 18)]),
        wire('east-class', '', 'east-dist', 'ETH1', 'ap-class', 'ETH1', [point(41, 18)]),
        wire('east-meet', '', 'east-dist', 'ETH2', 'ap-meet', 'ETH1', [point(55, 18)]),
        wire('east-library', '', 'east-dist', 'ETH3', 'jack-library', 'BACK', [point(43.52, 18)]),
        wire('library-patch', '', 'jack-library', 'FRONT', 'ap-library', 'ETH1', [], 'ethernet', '#18816f'),
        wire('east-media', '', 'east-dist', 'ETH4', 'jack-media', 'BACK', [point(45, 18), point(45, 32.05)]),
        wire('media-patch', '', 'jack-media', 'FRONT', 'ap-media', 'ETH1', [], 'ethernet', '#18816f'),
        wire('media-link', '', 'east-dist', 'ETH5', 'media-switch', 'ETH1', [point(56, 18)]),
      ],
    };
  };
})();
