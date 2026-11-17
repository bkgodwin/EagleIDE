"""One-level office and grounds plan for Briar Glen Insurance Campus."""

OFFICE_PARK_TITLE = 'Briar Glen Insurance Campus'
BUILDINGS = {
    'A': (0, 60, 'Claims Center'),
    'B': (76, 64, 'Technology Center'),
    'C': (156, 70, 'Training & Events'),
    'D': (242, 60, 'Executive & Underwriting'),
}


def office_park_layout():
    walls, labels, symbols, surfaces, equipment = [], [], [], [], []
    concrete, fire, drywall = 'concrete', 'reinforced_concrete', 'drywall'
    asphalt, walk, lawn, island = '#899aa3', '#e7ded0', '#d7e8ce', '#bccfac'
    accent = {'A': '#ddeaf1', 'B': '#dcebe8', 'C': '#f0e5d3', 'D': '#e6e1ee'}
    room_colors = {
        'meeting': '#e8dce9', 'lounge': '#e5ead9', 'wc': '#dbe8ed', 'idf': '#cddbe0',
        'support': '#e9e4d8', 'technical': '#cbdce4', 'hall': '#ece8de',
    }

    def door(at, width=1.05, finish='wood'):
        return 'door', finish, at, width

    def window(at, width=3.2):
        return 'window', 'coated_glass', at, width

    def horizontal(name, left, right, y, material, *cuts):
        walls.append((name, (left, y), (right, y), material,
                      *((kind, finish, center - left, width) for kind, finish, center, width in cuts)))

    def vertical(name, x, top, bottom, material, *cuts):
        walls.append((name, (x, top), (x, bottom), material,
                      *((kind, finish, center - top, width) for kind, finish, center, width in cuts)))

    def rect(kind, color, left, top, right, bottom):
        surfaces.append((kind, color, left, top, right, bottom))

    def symbol(kind, x, y, angle=0):
        symbols.append((kind, x, y, angle))

    def row(kind, centers, y, angle=0):
        symbols.extend((kind, x, y, angle) for x in centers)

    def furnish(use, left, top, right, bottom):
        center = (left + right) / 2
        mid_y = (top + bottom) / 2 + .8
        if use == 'work':
            # Paired cubicle rows share a spine, with circulation at either end.
            stations = range(left + 3, right - 2, 3)
            pairs = ((top + 2.0, top + 4.45), (bottom - 4.45, bottom - 2.0))
            for upper, lower in pairs:
                row('cubicle', stations, upper, 180)
                row('cubicle', stations, lower)
        elif use in ('office', 'assistant'):
            symbol('desk', center + .5, mid_y)
            symbol('chair', center + .5, mid_y + .9)
            symbol('chair', center - .2, mid_y - .9, 180)
            if right - left >= 7:
                symbol('counter', right - 1.2, bottom - .65)
        elif use == 'meeting':
            symbol('conference_table', center, mid_y)
        elif use == 'lounge':
            symbol('sofa', left + 2, mid_y + 1.15)
            symbol('table', left + 2, mid_y)
            symbol('cafeteria_table', right - 2.2, mid_y)
            symbol('counter', left + 2.0, bottom - .55)
        elif use == 'wc':
            row('toilet', range(left + 1, right - 1, 2), bottom - .9, 180)
            symbol('counter', left + 1.3, top + .65)
        elif use == 'support':
            row('counter', range(left + 2, right - 1, 2), bottom - .65)
        elif use == 'entry':
            symbol('counter', left + 2.1, mid_y)
            symbol('sofa', right - 2.1, mid_y + 1.5)

    def room(name, left, top, right, bottom, use, palette):
        rect('floor', room_colors.get(use, palette), left, top, right, bottom)
        if name:
            labels.append((left + .85, top + (6.8 if use == 'work' else 1.35), name))
        furnish(use, left, top, right, bottom)

    # Place campus labels first so they take precedence over room notes at Fit Site.
    for key, (origin, _, name) in BUILDINGS.items():
        labels.append((origin + 1, -6, f'{key} · {name}'))
    labels.extend([
        (110, -38, 'Briar Glen Green'), (132.8, -72.5, 'E · Campus Plant'),
        (148, 80.6, 'Visitor gate & guardhouse'), (27, 62.2, 'Staff parking west'),
        (105, 62.2, 'Visitor parking'), (186, 62.2, 'Event parking'), (259, 62.2, 'Staff parking east'),
        (6, 88, 'Briar Glen Drive'),
    ])

    # Grounds: pedestrian paths approach all entries and loop around several gardens.
    rect('landscape', lawn, -9, -51, 308, 38)
    rect('landscape', '#c9ddbd', -9, -51, 308, -25)
    rect('sidewalk', walk, -6, -24, 306, -20.8)
    rect('sidewalk', walk, -6, 34, 308, 38)
    for x in (-6, 64, 144, 230, 303):
        rect('sidewalk', walk, x, -20.8, x + 2.8, 34)
    for left, right, y in ((-6, 0, 16), (64, 76, 16), (144, 156, 21), (230, 242, 16)):
        rect('sidewalk', walk, left, y - 1.6, right, y + 1.6)
    rect('sidewalk', walk, 60, 14.4, 64, 17.6)
    rect('sidewalk', walk, 140, 14.4, 144, 17.6)
    rect('sidewalk', walk, 226, 19.4, 230, 22.6)
    rect('sidewalk', walk, 226, 7.5, 230, 10.5)
    rect('sidewalk', walk, 66.8, 5.5, 76, 8.5)
    rect('sidewalk', walk, 302, 14.4, 306, 17.6)

    surfaces.append(('sidewalk', walk, ((11, -36), (22, -47), (42, -50), (65, -47),
                     (77, -38), (72, -28), (52, -24), (50, -21), (46.5, -21),
                     (48.5, -27), (69.6, -30), (73.5, -37.8), (63.7, -44),
                     (42, -47.3), (23.5, -44.5), (14, -35.3), (21, -27),
                     (29, -24), (26, -22), (19, -24.5))))
    pond = ((18, -37), (25, -45), (42, -48), (62, -45), (71, -37),
            (65, -30), (45, -28), (26, -31))
    surfaces.append(('landscape', '#7cabb1', pond))
    surfaces.append(('landscape', '#98c6cc',
                     ((23, -37), (29, -43), (42, -45), (58, -43), (66, -37),
                      (62, -32), (44, -30), (30, -33))))
    labels.append((29, -38, 'Stormwater pond'))
    for left, right, name in ((83, 110, 'Shaded picnic grove'), (179, 211, 'Events terrace'),
                              (249, 284, 'Employee garden')):
        top = -18 if left != 179 else -17
        rect('sidewalk', walk, left, top, right, -1)
        rect('sidewalk', walk, (left + right) / 2 - 1.6, -20.8, (left + right) / 2 + 1.6, top)
        labels.append((left + .8, top + 2.4, name))
        row('bench', (left + 3, right - 3), -3)
        row('cafeteria_table', (left + 6, right - 6), -8)
    rect('sidewalk', walk, 203, -3, 224, 0)
    surfaces.append(('landscape', island, ((116, -43), (130, -48), (158, -47),
                     (170, -41), (174, -30), (160, -27), (131, -28), (119, -34))))
    surfaces.append(('sidewalk', walk, ((149.6, -53), (152.4, -53), (152.4, -49.8),
                     (173, -45), (180, -36.8), (180, -23.6), (177.2, -23.6),
                     (177.2, -35.2), (171.4, -42.4), (149.6, -47.6))))
    labels.append((137, -36, 'Meadow lawn'))
    row('bench', (122, 165), -40, 22)
    row('tree', (116, 173, 193), -42)
    for y, trees in (
        (-48, (6, 12, 77, 89, 103, 187, 203, 217, 238, 259, 278, 296)),
        (-32, (9, 15, 78, 85, 106, 113, 181, 193, 208, 226, 247, 266, 289, 300)),
        (-13, (9, 28, 49, 61, 74, 79, 115, 126, 139, 151, 170, 219, 235, 244, 290, 299)),
    ):
        row('tree', trees, y)
    for x in (70, 151, 237):
        row('bench', (x,), 9, 90)
        for y in (4, 17, 32):
            symbol('tree', x, y)
    row('lamp', (6, 50, 88, 122, 160, 212, 252, 295), -22.5)

    # South parking lots share two aisles and a striped pedestrian spine.
    rect('pavement', asphalt, -8, 38, 310, 76)
    rect('pavement', '#6f818b', -8, 84, 316, 93)
    rect('pavement', asphalt, 141, 76, 162, 84)
    rect('sidewalk', walk, 148, 68, 154, 82)
    for x in (1, 65, 76, 136, 164, 235, 245, 301):
        rect('landscape', island, x, 42, x + 2.8, 69.6)
        row('tree', (x + 1.4,), 47)
        row('tree', (x + 1.4,), 65.7)
    for x in (31, 104, 194, 269):
        rect('sidewalk', walk, x - 1.4, 38, x + 1.4, 74)
        for y in (50.2, 64.4):
            left, right = x - 1.35, x + 1.35
            bars = [(left, y), (right, y), (right, y + .34)]
            for i in range(1, 4):
                bottom = y + i * .85
                bars.extend(((left + .09, bottom - .51), (left + .09, bottom),
                             (right, bottom), (right, bottom + .34)))
            bars.append((left, y + 2.89))
            surfaces.append(('pavement', '#fff8e3', bars))
    for zone, starts in enumerate(((12, 40, 54), (87, 113, 129), (174, 204, 216), (256, 282, 295))):
        for i, (y, angle) in enumerate(((44.7, 0), (56, 180), (61.2, 0), (72.3, 180))):
            row('parking_row', starts[:2], y, angle)
            # Short end banks leave room for trees and curb returns.
            row('parking_bay', (starts[2] - 2.5, starts[2], starts[2] + 2.5), y, angle)
            row('car', (starts[(zone + i) % 2] - 3.75, starts[(zone + i + 1) % 2] + 1.25),
                y, (angle + 180) % 360)
    rect('pavement', '#d3b771', 142.4, 79.2, 147.2, 79.43)
    rect('pavement', '#d3b771', 154.8, 79.2, 160, 79.43)
    row('barrier_gate', (144.6, 157.6), 78.7)
    for x in (18, 67, 116, 186, 236, 290):
        symbol('lamp', x, 58.6)

    # Tucked behind the park, the plant has its own collection and equipment yard.
    rect('pavement', asphalt, 310, -77, 316, 84)
    rect('pavement', asphalt, 127, -77, 310, -70)
    rect('pavement', '#a8ada7', 125, -70, 132, -53)
    rect('pavement', '#a8ada7', 170, -70, 180, -53)
    horizontal('plant-north', 132, 170, -70, fire,
               door(137, 3.6, 'metal'), door(151, 3.8, 'metal'), door(164.2, 2.0, 'metal'))
    horizontal('plant-south', 132, 170, -53, fire, door(151, 1.5, 'metal'))
    vertical('plant-west', 132, -70, -53, fire, door(-61.4, 3.3, 'metal'))
    vertical('plant-east', 170, -70, -53, fire, door(-59.5, 1.6, 'metal'))
    vertical('plant-hvac-divider', 142, -70, -53, fire)
    vertical('plant-electrical-divider', 160, -70, -53, fire)
    room('Waste & recycling', 132, -70, 142, -53, 'support', accent['B'])
    room('Central HVAC plant', 142, -70, 160, -53, 'technical', accent['B'])
    room('Main electrical', 160, -70, 170, -53, 'technical', accent['B'])
    row('dumpster', (135.1, 139.1), -63)
    row('air_handler', (146.6, 155.1), -64)
    row('pump_skid', (146.7, 155.5), -57)
    row('switchgear', (165,), -63)
    row('switchgear', (165,), -57)

    def wing(key, north, upper, lower=()):
        x, width, _ = BUILDINGS[key]
        lobby = (24, 36)
        event = key == 'C'
        band = accent[key]
        hall_top = 19 if event else 14
        hall_end = hall_top + 4
        hall_center = hall_top + 2

        def h(name, left, right, y, material, *cuts):
            horizontal(f'{key}-{name}', x + left, x + right, y, material,
                       *((kind, finish, at + x, size) for kind, finish, at, size in cuts))

        def v(name, at, top, bottom, material, *cuts):
            vertical(f'{key}-{name}', x + at, top, bottom, material, *cuts)

        def spans(entries, start=0):
            left = start
            for name, right, use in entries:
                yield name, left, right, use
                left = right

        def cells(prefix, entries, top, bottom, start=0):
            rated = {'technical', 'idf'}
            for i, (name, left, right, use) in enumerate(spans(entries, start)):
                if i:
                    cuts = (door(10.8, 1.6, 'metal'),) if event and prefix == 'north' and left == 41 else ()
                    v(f'{prefix}-divider-{i}', left, top, bottom,
                      fire if use in rated or entries[i - 1][2] in rated or cuts else drywall, *cuts)
                room(name, x + left, top, x + right, bottom, use, band)
                if use == 'suite':
                    h(f'exec-inner-{i}', left, right, 8, drywall, door(right - 2.0))
                    room('Executive Assistant', x + left, 8, x + right, bottom, 'assistant', band)
                    furnish('office', x + left, top, x + right, 8)

        def entries(rooms, start=0):
            for _, left, right, use in spans(rooms, start):
                at = right - 2.0 if use == 'suite' else (left + right) / 2
                finish = 'metal' if use in ('idf', 'technical') else 'glass' if use in ('work', 'ballroom', 'entry') else 'wood'
                yield door(at, 2.8 if use in ('entry', 'ballroom') else 1.65 if use == 'work' else 1.05, finish)

        split = lobby[1]
        north_partitions = [right for _, right, _ in north]
        h('north-shell', 0, width, 0, concrete,
          *(window(at) for at in range(5 if key != 'B' else 47, width - 3, 6)
            if (not event or abs(at - 56) > 3) and all(abs(at - edge) > 1.8 for edge in north_partitions)),
          *((door(56, 3.2, 'glass'),) if event else ()))
        h('south-shell', 0, width, 34, concrete, door(56 if event else sum(lobby) / 2, 3, 'glass'),
          *(window(at, 2.7) for at in range(4, width - 2, 6)
            if abs(at - (56 if event else sum(lobby) / 2)) >= 4))
        ends = (door(25.5, 1.55, 'glass'),) if not event else ()
        data_exit = (door(7, 1.5, 'metal'),) if key == 'B' else ()
        v('west-shell', 0, 0, 34, concrete, door(hall_center, 2, 'glass'), *ends, *data_exit)
        event_exit = (door(9, 2.2, 'metal'),) if event else ()
        v('east-shell', width, 0, 34, concrete, door(hall_center, 2, 'glass'), *ends, *event_exit)
        h('north-corridor', 0, width, hall_top, fire if key == 'B' else drywall, *entries(north))
        cells('north', north, 0, hall_top)
        room('', x, hall_top, x + width, hall_end, 'hall', band)

        if event:
            h('south-corridor', 0, width, hall_end, drywall, *entries(upper))
            cells('south', upper, hall_end, 34)
            return

        for side, start, stop, rooms, front in (
            ('west', 0, lobby[0], upper[0], lower[0]),
            ('east', split, width, upper[1], lower[1]),
        ):
            h(f'{side}-hall-edge', start, stop, hall_end, drywall, *entries(rooms, start))
            h(f'{side}-service-edge', start, stop, 24, drywall)
            h(f'{side}-office-edge', start, stop, 27, drywall, *entries(front, start))
            cells(f'{side}-service', rooms, hall_end, 24, start)
            cells(f'{side}-office', front, 27, 34, start)
            room('', x + start, 24, x + stop, 27, 'hall', band)
        h('lobby-threshold', lobby[0], lobby[1], hall_end, drywall, door(sum(lobby) / 2, 3.1, 'none'))
        v('lobby-west', lobby[0], hall_end, 34, drywall, door(25.5, 2.5, 'none'))
        v('lobby-east', lobby[1], hall_end, 34, drywall, door(25.5, 2.5, 'none'))
        room('Reception', x + lobby[0], hall_end, x + lobby[1], 34, 'entry', band)

    wing('A', (
        ('Claims Intake', 22, 'work'), ('Claims Review', 44, 'work'),
        ('Quality Review', 51, 'office'), ('Case Conference', 60, 'meeting'),
    ), (
        (('Copy & Mail', 6, 'support'), ('Restrooms', 14, 'wc'),
              ('Access WC', 19, 'wc'), ('A IDC', 24, 'idf')),
        (('Interviews', 44, 'office'), ('Files', 51, 'support'), ('Supervisor', 60, 'office')),
    ), (
        (('Staff Lounge', 12, 'lounge'), ('Client Meeting', 24, 'meeting')),
        (('Claims Counsel', 47, 'office'), ('Team Breakout', 60, 'meeting')),
    ))

    wing('B', (
        ('Data Center', 29, 'technical'), ('Build & Staging', 37, 'support'),
        ('Power & Cooling', 43, 'technical'), ('IT Office', 52, 'office'), ('Platform Team', 64, 'work'),
    ), (
        (('B IDC / MDF', 8, 'idf'), ('Copy & Supplies', 16, 'support'), ('Facilities Ops', 24, 'office')),
        (('Restrooms', 46, 'wc'), ('Access WC', 51, 'wc'), ('Service Operations', 64, 'office')),
    ), (
        (('Staff Lounge', 12, 'lounge'), ('Network Team', 24, 'meeting')),
        (('Help Desk', 48, 'office'), ('Incident Review', 64, 'meeting')),
    ))

    wing('C', (
        ('Training Support', 22, 'work'), ('Seminar Room', 32, 'meeting'),
        ('Catering Prep', 41, 'support'), ('Ballroom · 29 × 19 m', 70, 'ballroom'),
    ), (('C IDC', 8, 'idf'), ('Copy & Storage', 16, 'support'), ('Restrooms', 25, 'wc'),
             ('Access WC', 33, 'wc'), ('AV & Chair Store', 41, 'support'), ('Event Foyer', 70, 'entry')))
    rect('floor', '#e4cb9e', 198.3, 1.2, 224.7, 17.5)
    rect('floor', '#cbb08c', 198.7, 4.5, 201.2, 14.5)
    labels.append((198.5, 3.5, 'Presentation platform'))
    row('banquet_table', (204, 209, 214, 219), 6.2)
    row('banquet_table', (204, 209, 214, 219), 12.5)

    wing('D', (
        ('Chief Executive', 12, 'suite'), ('VP Underwriting', 24, 'suite'),
        ('Boardroom', 40, 'meeting'), ('Policy Analysts', 60, 'work'),
    ), (
        (('People Ops', 9, 'office'), ('Restrooms', 18, 'wc'), ('D West IDC', 24, 'idf')),
        (('Copy & Records', 44, 'support'), ('Access WC', 51, 'wc'), ('D East IDC', 60, 'idf')),
    ), (
        (('Executive Lounge', 12, 'lounge'), ('Finance Meeting', 24, 'meeting')),
        (('Legal', 47, 'office'), ('Risk Review', 60, 'meeting')),
    ))

    # Two rows of six 16U cabinets. Clear U positions leave room for student switches.
    for row_number, y in enumerate((4.4, 10.1), 1):
        rect('floor', '#b6cedb', 78, y - 1.25, 103, y + 1.25)
        for column in range(6):
            number = (row_number - 1) * 6 + column + 1
            rack_id = f'bg-rack-{number:02d}'
            equipment.append(dict(id=rack_id, kind='rack', name=f'DC-{number:02d}', x=80.3 + column * 4.05, y=y))
            parts = [('patch_panel', 16, 'Copper patch panel')]
            parts += [('server', unit, f'BG-{number:02d}-{index}') for index, unit in enumerate((6, 8, 10, 12), 1)]
            parts += [('ups', 1, 'UPS A'), ('ups', 3, 'UPS B')]
            for kind, unit, name in parts:
                equipment.append(dict(id=f'{rack_id}-u{unit}', kind=kind, name=name, rack_id=rack_id, rack_u=unit))

    # The glazed guardhouse has a canopy overlooking the approach to both gates.
    rect('sidewalk', '#c7cfd2', 146.9, 73.8, 155.1, 77.1)
    horizontal('guard-north', 148, 154, 70.1, concrete, door(151, 1.05))
    horizontal('guard-south', 148, 154, 76.2, concrete, window(151, 2.2))
    vertical('guard-west', 148, 70.1, 76.2, concrete, window(73.4, 2.1))
    vertical('guard-east', 154, 70.1, 76.2, concrete, window(73.4, 2.1))
    room('', 148, 70.1, 154, 76.2, 'office', accent['A'])
    equipment.extend([
        dict(id='bg-guard-pc', kind='desktop', name='Gate desk', x=151.5, y=73.95),
        dict(id='bg-entry-camera', kind='poe_camera', name='Entry lane', x=147.4, y=75.6,
             angle=109, range=17, field_of_view=60),
        dict(id='bg-exit-camera', kind='poe_camera', name='Exit lane', x=154.6, y=75.6,
             angle=66, range=17, field_of_view=60),
    ])
    return walls, labels, symbols, surfaces, equipment
