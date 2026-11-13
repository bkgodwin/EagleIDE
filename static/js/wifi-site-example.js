/* A wired campus with dedicated equipment rooms, indoor wings, and outdoor coverage. */
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
    const door = (id, wall_id, t, width = 1.2, material = 'wood') => ({ id, wall_id, t, width, kind: 'door', material });
    return {
      ...plan, title: 'Northfield Learning Center',
      walls: [
        wall('north', 0, 0, 64, 0, 'concrete'), wall('south', 0, 37, 64, 37, 'concrete'),
        wall('west', 0, 0, 0, 37, 'concrete'),
        wall('east-north', 64, 0, 64, 15, 'concrete'), wall('east-south', 64, 22, 64, 37, 'concrete'),
        wall('partition', 32, 0, 32, 37, 'concrete'),
        wall('corridor-west-top', 0, 15, 32, 15, 'drywall'), wall('corridor-east-top', 32, 15, 64, 15, 'drywall'),
        wall('corridor-west-bottom', 0, 22, 32, 22, 'brick'), wall('corridor-east-bottom', 32, 22, 64, 22, 'drywall'),
        wall('west-rooms', 15, 0, 15, 15, 'drywall'), wall('west-south-rooms', 15, 22, 15, 37, 'drywall'),
        wall('east-rooms', 47, 0, 47, 15, 'drywall'), wall('east-south-rooms', 49, 22, 49, 37, 'glass'),
        wall('admin-split', 0, 7, 15, 7, 'drywall'), wall('mdf-split', 0, 32, 15, 32, 'drywall'),
        wall('west-idf-left', 16, 11, 16, 15, 'drywall'), wall('west-idf-top', 16, 11, 22, 11, 'drywall'),
        wall('west-idf-right', 22, 11, 22, 15, 'drywall'),
        wall('east-idf-left', 36, 11, 36, 15, 'drywall'), wall('east-idf-top', 36, 11, 42, 11, 'drywall'),
        wall('east-idf-right', 42, 11, 42, 15, 'drywall'),
        wall('connector-north', 64, 15, 72, 15, 'glass'), wall('connector-south', 64, 22, 72, 22, 'glass'),
        wall('annex-west-north', 72, 8, 72, 15, 'brick'), wall('annex-west-south', 72, 22, 72, 34, 'brick'),
        wall('annex-north', 72, 8, 101, 8, 'brick'), wall('annex-east', 101, 8, 101, 34, 'brick'),
        wall('annex-south', 72, 34, 101, 34, 'brick'), wall('annex-split', 72, 22, 101, 22, 'drywall'),
        wall('annex-lockers', 86, 22, 86, 34, 'drywall'),
        wall('annex-idf-left', 73, 15, 73, 20, 'drywall'), wall('annex-idf-top', 73, 15, 78, 15, 'drywall'),
        wall('annex-idf-right', 78, 15, 78, 20, 'drywall'), wall('annex-idf-bottom', 73, 20, 78, 20, 'drywall'),
      ],
      openings: [
        { id: 'door-n1', kind: 'door', material: 'wood', wall_id: 'corridor-west-top', t: 0.3, width: 1.2 },
        { id: 'door-n2', kind: 'door', material: 'glass', wall_id: 'corridor-west-top', t: 0.83, width: 1.4 },
        { id: 'door-n3', kind: 'door', material: 'wood', wall_id: 'corridor-east-top', t: 0.41, width: 1.2 },
        { id: 'door-n4', kind: 'door', material: 'wood', wall_id: 'corridor-east-top', t: 0.7, width: 1.2 },
        { id: 'door-s1', kind: 'door', material: 'metal', wall_id: 'corridor-west-bottom', t: 0.27, width: 1.1 },
        { id: 'door-s2', kind: 'door', material: 'wood', wall_id: 'corridor-west-bottom', t: 0.7, width: 1.2 },
        { id: 'door-s3', kind: 'door', material: 'glass', wall_id: 'corridor-east-bottom', t: 0.34, width: 1.5 },
        { id: 'door-s4', kind: 'door', material: 'glass', wall_id: 'corridor-east-bottom', t: 0.74, width: 1.5 },
        { id: 'fire-door', kind: 'door', material: 'metal', wall_id: 'partition', t: 0.56, width: 1.4 },
        { id: 'window-n', kind: 'window', material: 'coated_glass', wall_id: 'north', t: 0.44, width: 5 },
        { id: 'window-s', kind: 'window', material: 'glass', wall_id: 'south', t: 0.69, width: 6 },
        door('west-idf-door', 'corridor-west-top', 0.58, 1.2, 'metal'),
        door('east-idf-door', 'corridor-east-top', 0.19, 1.2, 'metal'),
        door('annex-idf-door', 'annex-idf-bottom', 0.5, 1.1, 'metal'),
        door('reception-door', 'admin-split', 0.4), door('mdf-door', 'mdf-split', 0.72, 1.2, 'metal'),
        door('annex-locker-door', 'annex-split', 0.23), door('annex-fitness-door', 'annex-split', 0.68),
        door('courtyard-door', 'south', 0.87, 2.3, 'glass'), door('garden-door', 'north', 0.82, 2.1, 'glass'),
        door('terrace-door', 'annex-south', 0.82, 2.2, 'glass'),
        { id: 'annex-window', kind: 'window', material: 'coated_glass', wall_id: 'annex-north', t: 0.61, width: 7 },
      ],
      equipment: [
        device('router', 'router', 'Edge router', 5, 25), device('core', 'core_switch', 'Campus core', 10, 29),
        device('west-dist', 'distribution_switch', 'West switch', 19, 13), device('east-dist', 'distribution_switch', 'East switch', 39, 13),
        device('annex-dist', 'distribution_switch', 'Athletics switch', 75.5, 18),
        device('media-switch', 'access_switch', 'Media access switch', 56, 28),
        { id: 'isp-fiber', kind: 'demarc', isp: 'alderline', name: '', wall_id: 'west', t: 0.7 },
        { id: 'isp-backup', kind: 'demarc', isp: 'cindersky', name: '', wall_id: 'west', t: 0.86 },
        jack('jack-stem', 'STEM jack', 'corridor-west-top', 0.76), jack('jack-library', 'Library jack', 'corridor-east-bottom', 0.36),
        jack('jack-media', 'Media jack', 'east-south-rooms', 0.67),
      ],
      pass_throughs: [
        { id: 'east-trunk', wall_id: 'partition', t: 0.48 }, { id: 'spare-pass', wall_id: 'partition', t: 0.78 },
        { id: 'courtyard-feed', wall_id: 'south', t: 0.72 }, { id: 'garden-feed', wall_id: 'north', t: 0.78 },
      ],
      access_points: [
        ap('ap-admin', 'Admin AP', 7, 9), ap('ap-stem', 'STEM AP', 23, 8),
        ap('ap-west', 'Workshop AP', 23, 30), ap('ap-class', 'Classroom AP', 41, 8),
        ap('ap-meet', 'Meeting AP', 55, 8), ap('ap-library', 'Library AP', 42, 30),
        ap('ap-media', 'Media AP', 57, 32, 'wall', 265), ap('ap-reception', 'Reception AP', 8, 4),
        ap('ap-gym', 'Gym AP', 89, 15), ap('ap-fitness', 'Fitness AP', 93, 28),
        ap('ap-lockers', 'Locker AP', 80, 28), ap('ap-terrace', 'Terrace AP', 94, 40, 'wall', 100),
        ap('ap-courtyard', 'Courtyard AP', 46, 45, 'wall', 100), ap('ap-garden', 'Garden AP', 50, -6, 'wall', 270),
      ],
      labels: [
        ['Reception', 2, 2], ['Administration', 2, 11], ['STEM lab', 19, 3], ['Workshop', 19, 25],
        ['Main network room', 2, 23.5], ['Storage', 3, 35], ['West IDF closet', 16.3, 11.8], ['East IDF closet', 36.3, 11.8],
        ['Classroom', 38, 3], ['Meeting room', 51, 3], ['Library', 37, 25], ['Media studio', 52, 35],
        ['Glass connector', 64.4, 16.5], ['Athletics IDF', 73.5, 16], ['Gymnasium', 84, 10],
        ['Locker rooms', 74, 24], ['Fitness studio', 89, 24], ['Athletics terrace', 81, 40],
        ['Outdoor learning courtyard', 36, 43], ['Reading garden', 45, -8],
      ].map(([text, x, y], i) => ({ id: `room-label-${i}`, text, x, y })),
      cables: [
        wire('wan-fiber', 'Primary WAN', 'isp-fiber', 'ISP', 'router', 'WAN-SFP1', [], 'fiber'),
        wire('wan-backup', 'Satellite backup', 'isp-backup', 'ISP', 'router', 'WAN1', [point(2, 31), point(2, 25)], 'ethernet', '#966012'),
        wire('core-fiber', 'Core uplink', 'router', 'SFP1', 'core', 'SFP1', [point(10, 25)], 'fiber'),
        wire('west-fiber', 'West backbone', 'core', 'SFP2', 'west-dist', 'SFP1', [point(12, 29), point(12, 17.76), point(19, 17.76)], 'fiber'),
        wire('east-fiber', 'East backbone', 'core', 'SFP3', 'east-dist', 'SFP1', [point(12, 29), point(12, 17.76), pass('east-trunk'), point(39, 17.76)], 'fiber'),
        wire('east-spare', 'East secondary run', 'core', 'SFP4', 'east-dist', 'SFP2', [point(12, 29), point(12, 17.76), pass('east-trunk'), point(39, 17.76)], 'fiber'),
        wire('annex-fiber', 'Athletics backbone', 'west-dist', 'SFP2', 'annex-dist', 'SFP1', [point(19, 17.76), pass('east-trunk'), point(75.5, 17.76)], 'fiber'),
        wire('west-admin', '', 'west-dist', 'ETH1', 'ap-admin', 'ETH1', [point(19, 18.6), point(7, 18.6)]),
        wire('west-stem', '', 'west-dist', 'ETH2', 'jack-stem', 'BACK', [point(24.32, 13)]),
        wire('stem-patch', '', 'jack-stem', 'FRONT', 'ap-stem', 'ETH1', [], 'ethernet', '#18816f'),
        wire('west-workshop', '', 'west-dist', 'ETH3', 'ap-west', 'ETH1', [point(19, 18.6), point(23, 18.6)]),
        wire('east-class', '', 'east-dist', 'ETH1', 'ap-class', 'ETH1', [point(41, 13)]),
        wire('east-meet', '', 'east-dist', 'ETH2', 'ap-meet', 'ETH1', [point(55, 13)]),
        wire('east-library', '', 'east-dist', 'ETH3', 'jack-library', 'BACK', [point(39, 19), point(43.52, 19)]),
        wire('library-patch', '', 'jack-library', 'FRONT', 'ap-library', 'ETH1', [], 'ethernet', '#18816f'),
        wire('east-media', '', 'east-dist', 'ETH4', 'jack-media', 'BACK', [point(39, 19), point(45, 19), point(45, 32.05)]),
        wire('media-patch', '', 'jack-media', 'FRONT', 'ap-media', 'ETH1', [], 'ethernet', '#18816f'),
        wire('media-link', '', 'east-dist', 'ETH5', 'media-switch', 'ETH1', [point(39, 19), point(56, 19)]),
        wire('reception-link', '', 'west-dist', 'ETH4', 'ap-reception', 'ETH1', [point(8, 13)]),
        wire('gym-link', '', 'annex-dist', 'ETH1', 'ap-gym', 'ETH1', [point(89, 18)]),
        wire('fitness-link', '', 'annex-dist', 'ETH2', 'ap-fitness', 'ETH1', [point(93, 18)]),
        wire('locker-link', '', 'annex-dist', 'ETH3', 'ap-lockers', 'ETH1', [point(80, 18)]),
        wire('terrace-link', '', 'annex-dist', 'ETH4', 'ap-terrace', 'ETH1', [point(94, 18)]),
        wire('courtyard-link', 'Courtyard feed', 'east-dist', 'ETH6', 'ap-courtyard', 'ETH1', [point(46.08, 13), pass('courtyard-feed'), point(46.08, 45)]),
        wire('garden-link', 'Garden feed', 'east-dist', 'ETH7', 'ap-garden', 'ETH1', [point(49.92, 13), pass('garden-feed'), point(49.92, -6)]),
      ],
    };
  };
})();
