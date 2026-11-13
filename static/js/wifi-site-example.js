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
    const mounted = (id, name, x, y, wall_id, t, angle) => ({ ...ap(id, name, x, y, 'wall', angle), wall_id, t });
    const fill = (kind, color, left, top, right, bottom) => ({
      kind, color, points: [point(left, top), point(right, top), point(right, bottom), point(left, bottom)], holes: [],
    });
    const floor = (color, ...bounds) => fill('floor', color, ...bounds);
    const walk = (...bounds) => fill('sidewalk', '#dedbd1', ...bounds);
    const lawn = (...bounds) => fill('landscape', '#d7e8cc', ...bounds);
    const workstations = (xs, ys) => ys.flatMap(y => xs.flatMap(x => [['desk', x, y], ['chair', x, y + .9]]));
    const tables = (xs, ys) => ys.flatMap(y => xs.flatMap(x =>
      [['table', x, y], ['chair', x, y + .9], ['chair', x, y - .9, 180]]));
    return {
      ...plan, title: 'Northfield Learning Center', background_color: '#f4f2ea',
      surfaces: [
        lawn(37, -13, 62, 0), lawn(34, 37, 63, 53), lawn(75, 34, 101, 46), lawn(65, -6, 100, 7),
        fill('pavement', '#a5acb2', -18, -1, -4, 19), fill('pavement', '#a5acb2', -18, 19, -12, 25),
        walk(-4, 1, 3, 4), walk(48, -4, 55, 0), walk(43, -10, 58, -4),
        walk(52, 37, 59, 41), walk(39, 41, 59, 49), walk(93, 34, 97, 38), walk(81, 38, 98, 44),
        floor('#e5eef6', 0, 0, 15, 7), floor('#e9e4f0', 0, 7, 15, 15),
        floor('#dcebe6', 15, 0, 32, 15), floor('#dcebe6', 32, 0, 47, 15),
        floor('#e5eef6', 47, 0, 64, 15), floor('#f4e9d5', 0, 15, 64, 22),
        floor('#dfe5eb', 0, 22, 15, 32), floor('#e9e4df', 0, 32, 15, 37),
        floor('#e8e7db', 15, 22, 32, 37), floor('#e9e4f0', 32, 22, 49, 37),
        floor('#e5eef6', 49, 22, 64, 37), floor('#e5eef6', 64, 15, 72, 22),
        floor('#f1dfc5', 72, 8, 101, 22), floor('#e5eef6', 72, 22, 86, 34),
        floor('#dcebe6', 86, 22, 101, 34),
        floor('#cdd8e1', 16, 11, 22, 15), floor('#cdd8e1', 36, 11, 42, 15),
        floor('#cdd8e1', 73, 15, 78, 20),
      ].map((surface, i) => ({ id: `campus-surface-${i}`, ...surface })),
      decor: [
        ...workstations([3, 11], [5.4, 12.8]), ...workstations([24, 27, 30], [4.2, 6.8]),
        ...workstations([37, 40, 43, 45], [5, 9.5]), ...workstations([53, 56, 60], [24.5, 27.2]),
        ...tables([19, 23, 27], [28, 33]), ...tables([37, 42, 46], [28, 33]),
        ...tables([53, 57, 61], [5, 11]), ...tables([43, 48, 54], [44, 47]),
        ...tables([46, 55], [-7]), ...tables([83, 87, 91, 96], [41.5]),
        ['bench', 3.8, 2.6], ['bench', 10.5, 2.6], ['bench', 75.5, 30], ['bench', 82.5, 30],
        ['bench', 91, 26, 90], ['bench', 98, 29, 90], ['bench', 96, 10], ['bench', 99, 15, 90],
        ...[[38, -9], [59, -10], [61, -3], [39, 38.8], [61, 43], [59, 50.5], [36, 49.5],
          [77.5, 39], [99, 44], [70, 1.5], [85, 2], [97, 2]].map(([x, y]) => ['tree', x, y]),
        ...[2, 5, 8, 11, 14, 17].map(y => ['parking_bay', -14.5, y, 90]),
        ...[2, 8, 14].map(y => ['car', -14.5, y, 90]),
        ...[[-5, 1], [-5, 16], [42, 41.7], [57, 48.2], [44, -9.4], [57, -5], [82, 38.5], [97, 43.5]]
          .map(([x, y]) => ['lamp', x, y]),
      ].map(([kind, x, y, angle = 0], i) => ({ id: `campus-symbol-${i}`, kind, x, y, angle })),
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
        wall('garden-screen', 48, -6, 53, -6, 'wood'), wall('courtyard-screen', 45, 40, 50, 40, 'wood'),
        wall('terrace-screen', 89, 39, 96, 39, 'wood'),
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
        door('main-entrance', 'west', 2.5 / 37, 2.2, 'glass'),
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
        device('desktop-stem', 'desktop', 'STEM desktop', 27, 4),
        device('desktop-media', 'desktop', 'Media desktop', 60, 25),
        device('phone-library', 'phone', 'Library phone', 39, 35),
        device('phone-courtyard', 'phone', 'Courtyard phone', 56, 47),
      ],
      pass_throughs: [
        { id: 'east-trunk', wall_id: 'partition', t: 0.48 }, { id: 'spare-pass', wall_id: 'partition', t: 0.78 },
        { id: 'courtyard-feed', wall_id: 'south', t: 0.72 }, { id: 'garden-feed', wall_id: 'north', t: 0.78 },
      ],
      access_points: [
        ap('ap-admin', 'Admin AP', 7, 9), ap('ap-stem', 'STEM AP', 23, 8),
        ap('ap-west', 'Workshop AP', 23, 30), ap('ap-class', 'Classroom AP', 41, 8),
        ap('ap-meet', 'Meeting AP', 55, 8), ap('ap-library', 'Library AP', 42, 30),
        mounted('ap-media', 'Media AP', 49, 25, 'east-south-rooms', 0.2, 0), ap('ap-reception', 'Reception AP', 6, 4.7),
        ap('ap-gym', 'Gym AP', 89, 15), ap('ap-fitness', 'Fitness AP', 93, 28),
        ap('ap-lockers', 'Locker AP', 80, 28), mounted('ap-terrace', 'Terrace AP', 94, 39, 'terrace-screen', 5 / 7, 90),
        mounted('ap-courtyard', 'Courtyard AP', 46, 40, 'courtyard-screen', 0.2, 90),
        mounted('ap-garden', 'Garden AP', 50, -6, 'garden-screen', 0.4, 270),
      ],
      labels: [
        ['Reception', 2, 2], ['Administration', 2, 11], ['STEM lab', 17, 2], ['Workshop', 19, 25],
        ['Main network room', 2, 23], ['Storage', 3, 35], ['West IDF closet', 16.3, 11.8], ['East IDF closet', 36.3, 11.8],
        ['Classroom', 38, 3], ['Meeting room', 51, 3], ['Library', 37, 25], ['Media studio', 52, 35],
        ['Glass connector', 64.4, 20.5], ['Athletics IDF', 73.5, 16], ['Gymnasium', 84, 10],
        ['Locker rooms', 74, 24], ['Fitness studio', 89, 24], ['Athletics terrace', 80, 37],
        ['Outdoor learning courtyard', 38, 51], ['Reading garden', 45, -11], ['Visitor parking', -17, 22],
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
        wire('courtyard-link', 'Courtyard feed', 'east-dist', 'ETH6', 'ap-courtyard', 'ETH1', [point(46.08, 13), pass('courtyard-feed'), point(46.08, 40)]),
        wire('garden-link', 'Garden feed', 'east-dist', 'ETH7', 'ap-garden', 'ETH1', [point(49.92, 13), pass('garden-feed'), point(49.92, -6)]),
        wire('stem-desktop-link', '', 'west-dist', 'ETH5', 'desktop-stem', 'ETH1', [point(27, 13)]),
        wire('media-desktop-link', '', 'media-switch', 'ETH2', 'desktop-media', 'ETH1', [point(60, 28)]),
      ],
    };
  };
})();
