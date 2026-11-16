"""Meter-based courtyard and guest-room schedule for Suntrail Motor Lodge."""


def motel_layout():
    walls, notes, furnishings, surfaces, equipment = [], [], [], [], []
    masonry, siding, partition = 'brick', 'wood', 'drywall'
    single, suite, new_single, new_suite = '#f4e9d5', '#efdbbe', '#e4ecf0', '#d6e5ec'
    tile, lobby, service = '#dce6e7', '#ecdfcd', '#e3e4df'
    walk, asphalt, grass = '#ded6c2', '#a3adb2', '#d3e2bf'
    stripe = '#f8f6e5'

    def door(center, width=.95, material='wood'):
        return 'door', material, center, width

    def window(center, width=1.9):
        return 'window', 'glass', center, width

    def wall(name, a, b, material, *cuts):
        walls.append((name, a, b, material, *cuts))

    def horizontal(name, y, left, right, material, *cuts):
        wall(name, (left, y), (right, y), material,
             *((kind, finish, center - left, width) for kind, finish, center, width in cuts))

    def vertical(name, x, top, bottom, material, *cuts):
        wall(name, (x, top), (x, bottom), material,
             *((kind, finish, center - top, width) for kind, finish, center, width in cuts))

    def shape(kind, color, *points):
        surfaces.append((kind, color, points))

    def rect(kind, color, left, top, right, bottom):
        surfaces.append((kind, color, left, top, right, bottom))

    def place(kind, x, y, angle=0):
        furnishings.append((kind, x, y, angle))

    def room(name, color, left, top, right, bottom, *, label=None):
        rect('floor', color, left, top, right, bottom)
        x, y = label if label else (left + .8, top + 1.35)
        notes.append((x, y, name))

    # The site has separate space for the street apron, courtyard and addition.
    shape('landscape', '#e9eddf', (-5, -5), (88, -5), (88, 29), (94, 35), (121, 35),
          (123, 38), (123, 76), (-5, 76))
    rect('pavement', asphalt, 7.6, 7.6, 76.4, 49.6)
    shape('pavement', asphalt, (35.6, 47), (46.8, 47), (46.8, 59.5), (118, 59.5),
          (121, 63), (121, 71.5), (31.6, 71.5), (31.6, 64.5), (35.6, 59.5))
    rect('pavement', '#8b999f', 25, 71.5, 123, 78)
    rect('sidewalk', walk, 7.6, 7.6, 76.4, 10.4)
    rect('sidewalk', walk, 7.6, 10.4, 10.4, 49.6)
    rect('sidewalk', walk, 73.6, 10.4, 76.4, 40.8)
    rect('sidewalk', walk, 10.4, 47.5, 35.6, 49.6)
    rect('sidewalk', walk, 46.8, 57.2, 117.6, 59.5)
    rect('sidewalk', walk, 117.6, 47.6, 119.6, 59.5)
    rect('sidewalk', walk, 62, 38.4, 76.4, 40.8)
    rect('sidewalk', walk, 46.8, 42.7, 62, 44.6)

    # Bank coordinates start on the entry face. The along vector tracks doors,
    # and the depth vector points into each room, so the same bath and furniture
    # plan works on every side of the courtyard and both sides of the new hall.
    def guest_bank(name, origin, along, inward, depth, numbers, widths, suite_rooms, *, added=False):
        def point(u, v):
            return (round(origin[0] + u * along[0] + v * inward[0], 4),
                    round(origin[1] + u * along[1] + v * inward[1], 4))

        head_angle = {(0, -1): 0, (-1, 0): 270, (0, 1): 180, (1, 0): 90}[inward]
        front, back = [], []
        span = 0
        for number, width in zip(numbers, widths, strict=True):
            is_suite = number in suite_rooms
            end = span + width
            front.append(door(span + .95, 1.02))
            if added:
                back.append(window(span + width * .58, 2.2))
            else:
                front.append(window(span + width - 1.65, 2.15 if is_suite else 1.9))
            wall(f'room-{number}-side', point(span, 0), point(span, depth), partition if added else masonry)
            shade = (new_suite if is_suite else new_single) if added else (suite if is_suite else single)
            shape('floor', shade, point(span, 0), point(end, 0), point(end, depth), point(span, depth))

            bath = depth - 2.3
            bath_end = span + 2.48
            wall(f'room-{number}-bath-entry', point(span, bath), point(bath_end, bath), partition, door(.94, .82))
            wall(f'room-{number}-bath-side', point(bath_end, bath), point(bath_end, depth), partition)
            shape('floor', tile, point(span, bath), point(bath_end, bath), point(bath_end, depth), point(span, depth))
            place('tub', *point(span + .99, depth - .48), head_angle)
            place('toilet', *point(span + .47, bath + 1.0), (head_angle + 90) % 360)
            place('counter', *point(span + 2.16, bath + .94), (head_angle + 90) % 360)

            place('bed', *point(span + 2.16, bath - 1.43), head_angle)
            if is_suite:
                place('bed', *point(span + 4.22, bath - 1.43), head_angle)
                place('sofa', *point(end - 1.46, .71), (head_angle + 180) % 360)
            desk_u = end - 1.03
            place('desk', *point(desk_u, depth - .68), head_angle)
            place('chair', *point(desk_u, depth - 1.55), head_angle)
            x, y = point(desk_u, depth - .68)
            equipment.append({'id': f'guest-phone-{number}', 'kind': 'voip_phone',
                              'name': f'Room {number} phone', 'x': x, 'y': y})
            notes.append((*point(span + .75, 1.65), str(number)))
            span = end

        entry_material = partition if added else masonry
        exterior_material = siding if added else masonry
        wall(f'{name}-entries', point(0, 0), point(span, 0), entry_material, *front)
        wall(f'{name}-outer', point(0, depth), point(span, depth), exterior_material, *back)
        wall(f'{name}-end', point(span, 0), point(span, depth), entry_material)

    guest_bank('north-court', (7.6, 7.6), (1, 0), (0, -1), 7.6, range(101, 113),
               (6.9, 5.2, 5.2, 5.2, 5.2, 6.7, 5.2, 5.2, 5.2, 5.2, 5.2, 8.4), {101, 106, 112})
    guest_bank('east-court', (76.4, 7.6), (0, 1), (1, 0), 7.6, range(113, 119),
               (5.2, 5.2, 6.7, 5.2, 5.2, 5.7), {115, 118})
    guest_bank('south-court', (7.6, 49.6), (1, 0), (0, 1), 7.6, range(123, 118, -1),
               (5.3, 5.3, 6.8, 5.3, 5.3), {121})
    guest_bank('west-court', (7.6, 7.6), (0, 1), (-1, 0), 7.6, range(131, 123, -1),
               (5, 5, 5, 5.8, 5, 5, 5, 6.2), {124, 128})

    # Service rooms fill the old corners, keeping guest entries on the courtyard.
    for prefix, left, top, right, bottom, side, title in (
        ('northwest', 0, 0, 7.6, 7.6, 'west', 'Laundry & linen'),
        ('northeast', 76.4, 0, 84, 7.6, 'east', 'Housekeeping'),
        ('southwest', 0, 49.6, 7.6, 57.2, 'west', 'Linen & maintenance'),
    ):
        outer_x = left if side == 'west' else right
        vertical(f'{prefix}-service-side', outer_x, top, bottom, masonry,
                 door(top + 3.7, 1.2, 'wood' if prefix == 'northwest' else 'metal'))
        shell_y = bottom if prefix == 'southwest' else top
        horizontal(f'{prefix}-service-shell', shell_y, left, right, masonry, window(left + 3.8, 2))
        room(title, service, left, top, right, bottom)
        for x in (left + 1.6, left + 3.8, left + 6.0):
            place('counter', x, bottom - .65)
    rect('sidewalk', walk, -2.1, 1.0, 0, 7.6)
    rect('sidewalk', walk, 84, 1.0, 86.1, 7.6)
    rect('sidewalk', walk, -2.1, 49.6, 0, 57.2)

    # The front office connects the courtyard and the newer interior corridor.
    horizontal('lobby-court', 40.8, 62, 76.4, masonry, door(68.6, 2.25, 'glass'), window(73.6, 2.6))
    horizontal('dining-court', 44.6, 46.8, 62, masonry, window(50.2, 3.7),
               door(55.8, 1.65, 'glass'), window(59, 2.6))
    vertical('dining-west', 46.8, 44.6, 57.2, masonry, window(50, 3.8))
    vertical('dining-foyer-kitchen', 62, 40.8, 57.2, partition,
             door(46.9, 2.2, 'none'), door(52.0, 1.2))
    horizontal('kitchen-north', 49.6, 62, 72.2, partition)
    vertical('reception-west', 72.2, 40.8, 57.2, partition, door(46.2, 2.1, 'none'))
    horizontal('lobby-street', 57.2, 46.8, 84, masonry, window(53.9, 4.4),
               door(67.8, 1.25, 'metal'), door(76.2, 2.1, 'glass'))
    vertical('old-wing-connection', 84, 40.8, 57.2, masonry, door(49, 2.25, 'glass'))
    horizontal('comms-north', 52.1, 79, 84, partition, door(81.5, 1))
    vertical('comms-west', 79, 52.1, 57.2, partition)
    room('Breakfast dining', lobby, 46.8, 44.6, 62, 57.2, label=(47.9, 46.2))
    room('Lobby', lobby, 62, 40.8, 72.2, 49.6, label=(64.8, 43.6))
    room('Kitchen', tile, 62, 49.6, 72.2, 57.2, label=(64.3, 54.6))
    room('Reception', lobby, 72.2, 40.8, 84, 57.2, label=(78.7, 44.8))
    room('Comms closet', service, 79, 52.1, 84, 57.2, label=(79.45, 54.3))
    rect('floor', '#f0e7d8', 58.45, 48.2, 61.4, 55.8)
    notes.append((60, 54.8, 'Buffet line'))
    for y in (49.4, 51.3, 53.2, 55.1):
        place('counter', 60.96, y, 90)
    for y in (49.5, 52.8, 55.65):
        for x in (49.05, 52.6, 56.15):
            place('table', x, y)
            for dy, angle in ((-.85, 180), (.85, 0)):
                place('chair', x - .47, y + dy, angle)
                place('chair', x + .47, y + dy, angle)
    for x in (63.3, 65.22, 67.14, 69.06, 71):
        place('counter', x, 50.05)
    for y in (52.45, 54.42, 56.42):
        place('counter', 71.69, y, 90)
    place('table', 67.9, 52.8)
    place('sofa', 63.1, 43.75, 90)
    place('sofa', 65.4, 48.8, 0)
    place('table', 66.35, 46.5)
    for x in (75, 76.9, 78.8):
        place('counter', x, 48.65)
    place('chair', 76.9, 49.55)
    equipment.append({'id': 'reception-pos', 'kind': 'pos_terminal',
                      'name': 'Reception POS', 'x': 76.9, 'y': 48.65})

    widths = (5, 5.3, 6.4, 5.2, 5.1, 6.6)
    guest_bank('annex-north', (84, 47.6), (1, 0), (0, -1), 6.8, range(132, 138), widths, {134, 137}, added=True)
    guest_bank('annex-south', (84, 50.4), (1, 0), (0, 1), 6.8, range(138, 144), widths, {140, 143}, added=True)
    vertical('annex-hall-exit', 117.6, 47.6, 50.4, siding, door(49, 1.55, 'glass'))
    room('New wing hall', '#d3e0e1', 84, 47.6, 117.6, 50.4, label=(90.7, 49.2))
    notes.extend([(92, 38.25, 'Later guest-wing addition'), (35.8, 62.55, 'Courtyard entrance')])

    # A small fenced pool sits on an island with a marked route to breakfast.
    rect('landscape', grass, 28.6, 18.8, 56.9, 38.35)
    rect('sidewalk', '#e6dbca', 31.25, 20.3, 54.7, 36.5)
    rect('sidewalk', '#dfd7bd', 51.45, 35.9, 54.05, 38.35)
    for y in (38.6, 39.55, 40.5, 41.45, 42.4):
        rect('pavement', stripe, 51.55, y, 53.95, y + .49)
    shape('pavement', '#f5f1df', (36, 24.2), (49.4, 24.2), (50.05, 24.85), (50.05, 30.1),
          (49.4, 30.75), (36, 30.75), (35.35, 30.1), (35.35, 24.85))
    shape('pavement', '#75b8ce', (36.23, 24.68), (49.17, 24.68), (49.57, 25.08), (49.57, 29.87),
          (49.17, 30.27), (36.23, 30.27), (35.83, 29.87), (35.83, 25.08))
    for i, color in enumerate(('#c8e6e7', '#a8d5e0', '#90c5d7')):
        rect('pavement', color, 48.34 - i * .38, 25.55, 48.72 - i * .38, 28.25)
    # Draw the low pool enclosure in the site layer. Leave a south gate.
    fence = '#647076'
    rect('pavement', fence, 31.25, 20.3, 54.7, 20.46)
    rect('pavement', fence, 31.25, 20.3, 31.41, 36.5)
    rect('pavement', fence, 54.54, 20.3, 54.7, 36.5)
    rect('pavement', fence, 31.25, 36.34, 51.45, 36.5)
    rect('pavement', fence, 54.05, 36.34, 54.7, 36.5)
    for x in (37, 40.6, 44.2, 47.8):
        place('bench', x, 22.15)
        place('bench', x, 33.1, 180)
    for x, y in ((30.25, 23.8), (55.4, 28.8), (30.5, 36), (55.4, 35)):
        place('tree', x, y)
    notes.append((37.5, 28.6, 'Courtyard pool'))

    # Head-in stalls face the room walks. The asphalt loop remains clear.
    parking_rows = (
        (((12.1 + i * 2.68, 13.0) for i in range(23)), 0, {0, 3, 5, 7, 10, 12, 16, 20, 22}),
        (((13.0, 20.3 + i * 2.7) for i in range(9)), 270, {0, 2, 5, 6}),
        (((71, 20.3 + i * 2.7) for i in range(7)), 90, {1, 2, 4, 5}),
        (((19 + i * 2.7, 44.9) for i in range(6)), 180, {1, 3, 4}),
        (((86 + i * 2.7, 62.15) for i in range(12)), 0, {0, 3, 5, 8, 11}),
    )
    for spaces, angle, occupied in parking_rows:
        for i, (x, y) in enumerate(spaces):
            place('parking_bay', x, y, angle)
            if i in occupied:
                place('car', x, y, angle)
    for x, y in ((13, 16.8), (69.9, 17.5), (29.8, 39.1), (56.8, 39), (80.3, 58.4), (114.8, 58.4)):
        place('lamp', x, y)
    for left, top, right, bottom in (
        (1.1, 58.6, 28.9, 63.8), (85.4, 35.9, 114.2, 39.4),
    ):
        rect('landscape', grass, left, top, right, bottom)
        place('tree', (left + right) / 2, (top + bottom) / 2)
    notes.extend([(13, 17.9, 'Guest parking'), (9.2, 39, 'Exterior room walk'), (66, 67.4, 'Street frontage')])

    # Fit Site gives arrival, circulation, and service areas first claim on labels.
    overview = ('Courtyard pool', 'Guest parking', 'Courtyard entrance', 'Reception', 'Breakfast dining',
                'Kitchen', 'Buffet line', 'Comms closet', 'Later guest-wing addition', 'New wing hall',
                'Exterior room walk')
    priority = {name: index for index, name in enumerate(overview)}
    notes.sort(key=lambda item: (priority.get(item[2], len(priority)), item[2].isdigit()))
    return walls, notes, furnishings, surfaces, equipment
