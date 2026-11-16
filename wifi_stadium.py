"""Meter-based single-level plan for Harborline Stadium and Sports Center."""


def stadium_layout():
    walls, labels, furniture, surfaces = [], [], [], []
    concrete, heavy, partition = 'concrete', 'reinforced_concrete', 'drywall'
    concourse, public, operations = '#e8e2d5', '#dae8eb', '#e9e3ec'
    service, wet, court_floor = '#dbe3e7', '#d2e9eb', '#dfd0b4'
    chalk, garden, pavement = '#eee6d5', '#cddfc2', '#a2adb3'

    def door(at, width=1.25, material='wood'):
        return 'door', material, at, width

    def window(at, width):
        return 'window', 'coated_glass', at, width

    def horizontal(name, y, x1, x2, material, *cuts):
        walls.append((name, (x1, y), (x2, y), material,
                      *((kind, finish, center - x1, width) for kind, finish, center, width in cuts)))

    def vertical(name, x, y1, y2, material, *cuts):
        walls.append((name, (x, y1), (x, y2), material,
                      *((kind, finish, center - y1, width) for kind, finish, center, width in cuts)))

    def shape(kind, color, *points):
        surfaces.append((kind, color, points))

    def rect(kind, color, x1, y1, x2, y2):
        shape(kind, color, (x1, y1), (x2, y1), (x2, y2), (x1, y2))

    def room(name, x1, y1, x2, y2, color, *, label=None):
        rect('floor', color, x1, y1, x2, y2)
        x, y = label or (x1 + 1.05, y1 + 1.65)
        labels.append((x, y, name))

    def place(kind, x, y, angle=0):
        furniture.append((kind, x, y, angle))

    def partition_row(prefix, top, bottom, rooms, material=partition):
        for index, (name, left, right, color) in enumerate(rooms):
            if index:
                vertical(f'{prefix}-partition-{index}', left, top, bottom, material)
            room(name, left, top, right, bottom, color)

    def row_symbols(kind, xs, y, angle=0):
        for x in xs:
            place(kind, x, y, angle)

    # The public ring uses a clear aisle behind the raked seating bowl.
    room('Public concourse', -6, 4, 206, 161, concourse, label=(89, 156.9))
    bowl = ((14, 34), (32, 16), (168, 16), (186, 34), (186, 126), (168, 144), (32, 144), (14, 126))
    field_apron = ((29, 52), (43, 37), (157, 37), (171, 52), (171, 108), (157, 123), (43, 123), (29, 108))
    shape('floor', '#afc1ce', *bowl)
    shape('floor', '#a6baab', *field_apron)
    rect('floor', '#c0c8b4', 40.5, 52.2, 159.5, 107.8)
    horizontal('bowl-north', 16, 32, 168, heavy,
               *(door(x, 3.15, 'metal') for x in (52.5, 71.5, 90.5, 109.5, 128.5, 147.5)))
    horizontal('bowl-south', 144, 32, 168, heavy,
               *(door(x, 3.15, 'metal') for x in (52.5, 71.5, 128.5, 147.5)),
               window(88, 7.5), window(101, 7.5), window(112.5, 6.0))
    vertical('bowl-west', 14, 34, 126, heavy,
             door(57, 3.0, 'metal'), door(80, 5.2, 'metal'), door(103, 3.0, 'metal'))
    vertical('bowl-east', 186, 34, 126, heavy,
             door(57, 3.0, 'metal'), door(80, 5.2, 'metal'), door(103, 3.0, 'metal'))
    for name, a, b in [
        ('bowl-nw', bowl[0], bowl[1]), ('bowl-ne', bowl[2], bowl[3]),
        ('bowl-se', bowl[4], bowl[5]), ('bowl-sw', bowl[6], bowl[7]),
    ]:
        walls.append((name, a, b, heavy))
    place('football_field', 100, 80)
    labels.extend([
        (72, 45.3, 'Indoor football field'), (79, 8.1, 'North concourse'),
        (5.5, 70, 'West concourse'), (192.5, 74, 'East concourse'),
        (18.5, 80, 'West team tunnel'), (181.5, 80, 'East field tunnel'),
    ])
    for x in (43, 62, 81, 100, 119, 138, 157):
        place('stadium_seating', x, 26.5)
        place('stadium_seating', x, 133.4, 180)
    for y in (47.5, 66, 94, 112.5):
        place('stadium_seating', 21.5, y, 270)
        place('stadium_seating', 178.5, y, 90)
    for x, y, angle in ((29.5, 32, 315), (170.5, 32, 45), (170.5, 128, 315), (29.5, 128, 45)):
        place('stadium_seating', x, y, angle)
    for x in (72, 94, 107, 130):
        place('bench', x, 50.6)
        place('bench', x, 109.4)
    for x in (31, 169):
        rect('floor', '#d0cec0', x - 1.6, 76.8, x + 1.6, 83.2)

    # Stadium shell and independently controlled stairs-free public entrances.
    horizontal('stadium-north-shell', -22, -6, 206, heavy,
               door(12.5, 5.8, 'metal'), door(37, 5.6, 'glass'), door(49.1, 6.2, 'glass'),
               door(67.5, 4, 'metal'), door(99, 5.7, 'metal'), door(124, 5.7, 'metal'),
               door(141, 5.6, 'glass'), door(153.5, 6.2, 'glass'), door(174, 4.4, 'metal'), door(198, 6, 'metal'))
    vertical('stadium-west-shell', -6, -22, 184, heavy,
             door(12, 3, 'metal'), door(33, 4.8, 'glass'), door(80, 5.6, 'metal'), door(123, 4.8, 'glass'),
             door(151.5, 4.5, 'glass'), door(169, 2.5, 'metal'))
    vertical('stadium-sports-fire-wall', 206, -22, 184, heavy,
             door(16.5, 4.6, 'metal'), door(86.8, 5.6, 'metal'))
    horizontal('stadium-south-shell', 184, -6, 206, heavy,
               door(8, 2.6, 'metal'), window(31.2, 5.5), door(38.3, 5.0, 'glass'), door(47, 6, 'glass'),
               door(65.6, 2.6, 'metal'), door(86, 2, 'metal'), window(98, 6.2), window(136, 7),
               door(164.6, 5, 'glass'), door(171.5, 3.7, 'glass'), window(177.7, 4.7), door(196, 4.8, 'metal'))

    # High-volume mechanical and service rooms sit along the truck apron.
    # Intake, air-handling, central plant, water and switchgear have distinct rooms.
    north_room_bounds = [
        ('Main bowl air handling', -6, 31, service), ('Northwest gate / screening', 31, 56, public),
        ('Electrical switchgear', 56, 80, service), ('Central chilled-water plant', 80, 110, service),
        ('East bowl air handling', 110, 135, service), ('Northeast gate / screening', 135, 160, public),
        ('Water & fire services', 160, 187, service), ('Central receiving / loading', 187, 206, service),
    ]
    for index, (name, left, right, color) in enumerate(north_room_bounds):
        if index:
            vertical(f'north-services-divider-{index}', left, -22, 4, concrete)
        bottom = -5 if left == 56 else -8 if left == 160 else 4
        room(name, left, -22, right, bottom, color)
    horizontal('north-concourse-divider', 4, -6, 206, concrete,
               door(13, 2.4, 'metal'), *(door(x, 3.1, 'glass') for x in (35.5, 43.5, 51.5)),
               door(60, 1.3, 'metal'), door(73, 2.2, 'metal'), door(95, 2.5, 'metal'), door(122, 2.5, 'metal'),
               *(door(x, 3.1, 'glass') for x in (139.5, 147.5, 155.5)),
               door(166.5, 2.2, 'metal'), door(179.5, 2.2, 'metal'), door(197.5, 3.6, 'metal'))
    horizontal('north-electrical-access', -5, 56, 80, partition, door(73, 2.0, 'metal'))
    vertical('north-idf-partition', 64.5, -5, 4, partition)
    room('North IDF', 56, -5, 64.5, 4, service)
    room('Electrical service lobby', 64.5, -5, 80, 4, operations)
    horizontal('water-plumbing-divider', -8, 160, 187, concrete, door(167, 1.8, 'metal'), door(179.5, 1.8, 'metal'))
    vertical('fire-pump-partition', 173.6, -8, 4, partition)
    room('Fire pumps', 160, -8, 173.6, 4, service)
    room('Plumbing risers & backflow', 173.6, -8, 187, 4, service)
    for x, ys in [(1.2, (-13.5, -2.3)), (12.9, (-13.5, -2.3)), (24.6, (-13.5, -2.3)),
                  (116.2, (-13.5, -2.3)), (128.9, (-13.5, -2.3))]:
        for y in ys:
            place('air_handler', x, y)
    for x in (85.5, 94.7, 104.0):
        place('pump_skid', x, -14.2)
        place('pump_skid', x, -4.5)
    row_symbols('pump_skid', (165, 171, 177, 183), -13.0)
    for y in (-16.3, -10.8):
        row_symbols('switchgear', (61.3, 69.2, 76.1), y)
    place('pallet_rack', 203.7, -11.9, 90)
    place('forklift', 191.6, -2.8, 180)
    for left in (31, 135):
        row_symbols('ticket_gate', (left + 5, left + 9, left + 13, left + 17, left + 21), -6.2)
        row_symbols('counter', (left + 4, left + 20.5), -17.8)

    # Continuous clear paths run past west and east amenities.
    for name, left, right, top, bottom, wall_x, door_y, finish in [
        ('West IDF', -6, 3.5, 16, 27, 3.5, 21.7, service),
        ('West restrooms A', -6, 4, 46, 56, 4, 51, wet),
        ('West restrooms B', -6, 4, 56, 68, 4, 62.5, wet),
        ('West concessions', -6, 4, 95, 111, 4, 103, operations),
        ('First aid & lost guests', -6, 7, 129, 145, 7, 136, operations),
        ('East concessions', 197, 206, 46, 64, 197, 55, operations),
        ('East restrooms A', 197, 206, 109, 120, 197, 115, wet),
        ('East restrooms B', 197, 206, 120, 133, 197, 126.5, wet),
        ('East IDF', 196.5, 206, 140, 152, 196.5, 145.5, service),
    ]:
        prefix = name.lower().replace(' & ', '-').replace(' ', '-')
        if name not in ('West restrooms B', 'East restrooms B'):
            horizontal(f'{prefix}-north', top, left, right, partition)
        horizontal(f'{prefix}-south', bottom, left, right, partition)
        if 'concessions' in name:
            opening = door(door_y, 4.4, 'none')
        else:
            opening = door(door_y, 1.7, 'metal' if name.endswith('IDF') else 'wood')
        vertical(f'{prefix}-entry', wall_x, top, bottom, partition, opening)
        room(name, left, top, right, bottom, finish)
        x = left + (1.2 if left < 0 else 6.7)
        if 'concessions' in name:
            for y in (top + 4, top + 9, top + 13):
                place('counter', x, y, 90)
        if 'restrooms' in name:
            outside, face = (left, left + 2.8) if left < 0 else (right, right - 2.8)
            vertical(f'{prefix}-stall-doors', face, top + .8, top + 9.2, partition,
                     door(top + 2.05, .8), door(top + 4.6, .8), door(top + 7.4, 1.0))
            for i, y in enumerate((top + .8, top + 3.3, top + 5.65, top + 9.2)):
                horizontal(f'{prefix}-stall-divider-{i}', y, min(outside, face), max(outside, face), partition)
            for y in (top + 2.05, top + 4.6, top + 7.2):
                place('toilet', x, y, 270 if left < 0 else 90)
            place('counter', (left + right) / 2, top + 1.4)
    place('desk', -2.3, 139.5)
    horizontal('north-concessions-counter', 11.5, 18.6, 30.2, partition, door(24.4, 4.4, 'none'))
    vertical('north-concessions-west', 18.6, 4, 11.5, partition)
    vertical('north-concessions-east', 30.2, 4, 11.5, partition)
    room('North concessions', 18.6, 4, 30.2, 11.5, operations)
    row_symbols('counter', (21.4, 24.4, 27.4), 7.0)

    # Bowl-facing announcer/press frontage leaves a continuous aisle behind it.
    horizontal('broadcast-rear', 152, 82, 118, partition, door(88), door(100), door(112))
    vertical('broadcast-west', 82, 144, 152, partition)
    vertical('broadcast-east', 118, 144, 152, partition)
    partition_row('broadcast', 144, 152, [
        ('Announcer booth', 82, 94, operations), ('Press box', 94, 107, operations),
        ('Replay / broadcast control', 107, 118, operations),
    ])
    row_symbols('desk', (84.8, 89.0, 96.5, 100.5, 104, 109.1, 114.3), 146.0)
    row_symbols('chair', (84.8, 89.0, 96.5, 100.5, 104, 109.1, 114.3), 147.1)

    # South frontage: matchday entrances, ticket offices, staff operations,
    # team changing rooms, and the main network room with a service-side door.
    horizontal('south-room-entry', 161, -6, 206, concrete,
               *(door(x, 2.2) for x in (9, 22, 64, 86, 102, 135, 152)),
               *(door(x, 3.5, 'glass') for x in (33, 40, 48, 164.9, 171.6, 178.1)),
               door(118.5, 1.45, 'metal'), door(187, 4.4, 'none'), door(195, 2.3, 'metal'))
    south = [
        ('Home team locker room', -6, 19, wet), ('Kit issue / laundry', 19, 27, service),
        ('Southwest gate / screening', 27, 53, public), ('Visiting team locker room', 53, 77, wet),
        ('Officials changing', 77, 92, wet), ('Media workroom', 92, 113, operations),
        ('Main IT / network room', 113, 127, service), ('Facilities offices', 127, 144, operations),
        ('Security operations', 144, 160, operations), ('Southeast gate / screening', 160, 181, public),
        ('Event storage / loading', 181, 206, service),
    ]
    partition_row('south', 161, 184, south)
    horizontal('south-concessions-back', 172, 181, 193, partition)
    vertical('south-concessions-return', 193, 161, 172, partition, door(167))
    room('South concessions', 181, 161, 193, 172, operations)
    row_symbols('counter', (183.5, 187, 190.5), 168.6)
    horizontal('home-locker-shower-wall', 176, 10.4, 19, partition, door(15.3))
    vertical('home-locker-shower-return', 10.4, 176, 184, partition)
    room('Home showers', 10.4, 176, 19, 184, '#bcd7de')
    horizontal('away-locker-shower-wall', 176, 68.4, 77, partition, door(72.6))
    vertical('away-locker-shower-return', 68.4, 176, 184, partition)
    room('Visitor showers', 68.4, 176, 77, 184, '#bcd7de')
    horizontal('south-mdf-divider', 173, 113, 127, partition, door(120.7, 1.3, 'metal'))
    room('IT workroom', 113, 173, 127, 184, operations)
    horizontal('gate-west-ticket-wall', 174, 27, 34.7, partition)
    vertical('gate-west-ticket-return', 34.7, 174, 184, partition, door(180.7))
    room('West ticket office', 27, 174, 34.7, 184, operations)
    horizontal('gate-east-ticket-wall', 174, 174, 181, partition)
    vertical('gate-east-ticket-return', 174, 174, 184, partition, door(180.7))
    room('East ticket office', 174, 174, 181, 184, operations)
    for group in ((35.9, 39.6, 43.3, 47.0, 50.7), (161.6, 165.1, 168.6, 172.1, 175.6, 179.1)):
        row_symbols('ticket_gate', group, 170.2)
    for left in (-6, 53):
        for y in (166.0, 171.0, 176.0):
            row_symbols('bench', (left + 4, left + 8.5, left + 13.5), y)
    for x, y in ((22.8, 172), (86, 171), (100, 169), (105.5, 169), (133, 171), (139, 175),
                 (148, 170), (154.5, 169), (30.5, 179), (177.1, 179)):
        place('desk', x, y)
        place('chair', x, y + .87)

    # The attached sports center has its own everyday public entry. The link
    # through the stadium firewall can close during paid events.
    horizontal('sports-north-shell', 40, 206, 306, concrete,
               window(220, 8), window(250, 8), door(288, 3.4, 'glass'), window(299, 6))
    vertical('sports-east-shell', 306, 40, 165, concrete,
             door(60, 3.2, 'glass'), door(86.8, 5.4, 'glass'), window(105, 8),
             door(121.2, 3.8, 'glass'), window(137.1, 6.5), door(151.2, 3.1, 'metal'))
    horizontal('sports-south-shell', 165, 206, 306, concrete,
               door(215, 2.1, 'metal'), window(234, 7.6), door(249, 3, 'glass'), door(259, 3.3, 'metal'), door(289, 2.7, 'metal'))
    horizontal('sports-north-rooms', 80, 206, 306, partition,
               door(215, 3.1, 'glass'), door(230, 2.2, 'glass'), door(246, 3.0, 'glass'),
               door(260, 2.2, 'glass'), door(277, 3.0, 'glass'), door(295, 2.6, 'glass'))
    vertical('sports-gym-divider', 238, 40, 80, concrete)
    vertical('sports-tennis-divider', 269, 40, 80, concrete)
    room('Basketball gym', 206, 40, 238, 80, court_floor, label=(210, 46))
    room('Strength & cardio gym', 238, 40, 269, 80, public, label=(241, 54))
    room('Indoor tennis hall', 269, 40, 306, 80, court_floor, label=(275, 72.6))
    room('Sports center lobby', 206, 80, 306, 94, concourse, label=(268, 87.4))
    place('basketball_court', 223, 61, 90)
    for y in (50, 69.5):
        place('tennis_court', 288, y)
    for x in (244, 250, 256, 262):
        for y in (48, 53.8, 59.6, 65.4, 71.2):
            place('fitness_station', x, y)
    for y in (48, 55, 62, 69):
        place('bench', 234.4, y, 90)
    for x in (280.5, 295.5):
        place('bench', x, 60.0)
    row_symbols('bench', (212, 218, 251, 279, 284), 90.2)

    horizontal('sports-lobby-south', 94, 206, 306, concrete,
               door(224.0, 3.2, 'glass'), door(247, 2.5, 'glass'), door(263.0, 2.3, 'glass'),
               door(282, 2.3, 'glass'), door(297, 2.8, 'glass'))
    vertical('pool-enclosure-east', 254, 94, 165, concrete,
             door(121.0, 2.6, 'glass'), door(134.6, 1.6, 'metal'), door(151.1, 2.5, 'glass'))
    room('Aquatics hall / lap pool', 206, 94, 254, 138, wet, label=(212, 99))
    place('lap_pool', 230, 114)
    rect('floor', '#aacbd7', 214, 125, 230, 132)
    labels.append((214.5, 127.2, 'Learn-to-swim pool'))
    for x in (215, 219, 240, 245):
        place('bench', x, 100.9)
    place('chair', 245, 116)
    horizontal('pool-lockers-north', 138, 206, 254, concrete,
               door(214.0, 2.1, 'glass'), door(230.0, 2.1, 'glass'), door(247.0, 2.5, 'glass'))
    vertical('pool-changing-spine', 242, 138, 165, partition, door(146.2), door(159.4))
    room('Aquatics changing hall', 242, 138, 254, 165, concourse)
    partition_row('pool-lockers', 138, 154, [
        ('Aquatics locker room A', 206, 223, wet), ('Aquatics locker room B', 223, 242, wet),
    ])
    horizontal('family-change-divider', 154, 206, 242, partition, door(215, 1.5), door(232, 1.5))
    partition_row('family-change', 154, 165, [
        ('Family changing', 206, 223, wet), ('Aquatics staff / first aid', 223, 242, operations),
    ])
    for left in (206, 223):
        for y in (143, 149):
            row_symbols('bench', (left + 3.7, left + 8.1, left + 12.9), y)

    horizontal('studios-south', 117, 254, 306, partition,
               door(262, 1.55), door(280, 1.55), door(296, 2.4, 'glass'))
    partition_row('studios', 94, 117, [
        ('Yoga studio', 254, 272, '#e7dced'), ('Group exercise studio', 272, 289, public),
        ('Sports reception & club office', 289, 306, operations),
    ])
    room('Wellness hall', 254, 117, 306, 125, concourse)
    horizontal('wellness-hall-south', 125, 254, 306, partition,
               door(262, 2.0, 'metal'), door(277, 1.6), door(295, 1.8))
    horizontal('wellness-back-hall-north', 147, 254, 306, partition,
               door(262, 2.0, 'metal'), door(280, 1.6), door(298, 1.6))
    partition_row('wellness', 125, 147, [
        ('Pool filtration & water treatment', 254, 270, service), ('Sports medicine & rehab', 270, 287, operations),
        ('Coaching & personal training', 287, 306, public),
    ])
    room('Service corridor', 254, 147, 306, 155, concourse)
    horizontal('sports-service-room-doors', 155, 254, 306, concrete,
               door(260, 2.0, 'metal'), door(270, 1.5, 'metal'), door(278),
               door(289, 2.2), door(299, 1.5))
    partition_row('sports-plant', 155, 165, [
        ('Pool dehumidification', 254, 266, service), ('Sports center IDF', 266, 275, service),
        ('Custodial & laundry', 275, 284, service), ('Equipment store', 284, 295, service),
        ('Staff restrooms', 295, 306, wet),
    ])
    for x in (257, 260, 263, 266, 269):
        for y in (101, 106, 111):
            place('yoga_mat', x, y)
    for x, y in ((280, 103), (282.6, 103), (277.4, 103), (298, 133), (294, 135), (301.5, 135)):
        place('fitness_station', x, y)
    for y in (132, 136, 141):
        row_symbols('pump_skid', (258.7, 265.8), y)
    place('air_handler', 260, 160)
    for x, y in ((295, 105), (298.5, 108), (275, 135), (280.5, 135), (293, 140)):
        place('desk', x, y)
        place('chair', x + .18, y + .9)

    # Arrival areas and service apron occupy different sides of the property.
    surfaces.insert(0, ('landscape', '#e8eddf', (
        (-34, -35), (-16, -54), (205, -54), (225, 16), (317, 19), (344, 48),
        (344, 215), (319, 240), (-34, 240),
    )))
    rect('pavement', pavement, -27, -43, 205, -22)
    rect('pavement', pavement, -27, -24, -18, 184)
    rect('sidewalk', chalk, -18, 25, -6, 151)
    rect('sidewalk', '#d9d9d0', 31, -50, 56, -22)
    rect('sidewalk', '#d9d9d0', 135, -50, 160, -22)
    rect('sidewalk', chalk, 206, 6, 214, 39.5)
    for x in (28.4, 56.1, 132.4, 160.1):
        rect('landscape', garden, x, -40, x + 2.5, -27)
        place('tree', x + 1.25, -33)
    labels.extend([(78, -38, 'Back-of-house service apron'), (-24, 71, 'Team arrival & service lane')])
    for y in (28, 57, 104, 146):
        place('lamp', -11.3, y)
    for y in (69, 94):
        place('bus', -23, y, 0)

    shape('sidewalk', '#e2d4ba', (-6, 184), (206, 184), (225, 203), (192, 219), (-6, 219), (-17, 204))
    rect('sidewalk', '#cacfd0', 22, 184, 61, 217)
    rect('sidewalk', '#cacfd0', 151, 184, 190, 217)
    for x in (6, 70, 111, 190):
        rect('landscape', garden, x, 194, x + 11, 203)
    labels.extend([(67, 191, 'Matchday plaza'), (33, 209, 'West entry queue'), (157, 210, 'East entry queue')])
    for x in (11, 75, 116, 194):
        place('tree', x, 198)
        place('bench', x + 3, 204.9)
    for x in range(26, 54, 4):
        place('ticket_gate', x, 196.0)
    for x in range(154, 185, 4):
        place('ticket_gate', x, 196.0)
    rect('pavement', pavement, -15, 222, 211, 238)
    labels.append((81, 232, 'Transit & passenger pickup'))
    for x in (31, 62, 155, 185):
        place('bus', x, 228, 90)
    for x in range(92, 107, 2):
        rect('landscape', '#f7f4e8', x, 222, x + .8, 234)

    # The east entrance and fan park serve both venues all week.
    rect('sidewalk', chalk, 306, 54, 332, 151)
    shape('sidewalk', '#d2dbe0', (306, 78), (329, 78), (339, 88), (329, 102), (306, 102))
    shape('landscape', garden, (220, 171), (304, 171), (321, 184), (314, 209), (219, 209), (210, 188))
    rect('sidewalk', chalk, 245, 165, 253, 211)
    rect('sidewalk', '#cfdbd8', 257, 180, 297, 202)
    rect('landscape', '#9cbd95', 261, 183, 293, 199)
    labels.extend([(311, 84, 'Sports center entrance plaza'), (219, 178, 'Fan park & warm-up lawn')])
    for x, y in ((220, 189), (229, 198), (236, 187), (257, 175), (285, 174),
                 (301, 197), (312, 183), (315, 112), (317, 68), (327, 60)):
        place('tree', x, y)
    for x in (220, 228, 236):
        place('cafeteria_table', x, 200.5)
    for x in (265, 277, 289):
        place('bench', x, 202.8)
    for x, y in ((314, 75), (315, 103), (121, 216), (206, 207), (250, 176)):
        place('lamp', x, y)

    overview = (
        'Indoor football field', 'Sports center lobby', 'Basketball gym', 'Strength & cardio gym',
        'Indoor tennis hall', 'Aquatics hall / lap pool', 'Matchday plaza', 'Fan park & warm-up lawn',
        'Main IT / network room', 'North IDF', 'West IDF', 'East IDF', 'Sports center IDF', 'Public concourse',
        'Press box', 'Main bowl air handling', 'Central chilled-water plant', 'Sports center entrance plaza',
        'Southwest gate / screening', 'Southeast gate / screening',
    )
    rank = {name: i for i, name in enumerate(overview)}
    labels.sort(key=lambda item: rank.get(item[2], len(rank)))
    return walls, labels, furniture, surfaces
