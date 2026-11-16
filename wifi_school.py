"""Meter-based building and landscape schedule for Alder Ridge High School."""


def school_layout():
    walls, labels, furniture, surfaces = [], [], [], []
    west_classroom, east_classroom = '#dce9ed', '#ddebdf'
    hall, office, service, wet = '#eee4d0', '#e9e2ef', '#dfe6e9', '#d6e9ec'
    walk, plaza, terrace = '#e8e1d1', '#d8dfe1', '#e8d2b2'
    lawn, planting, grove = '#dce9cc', '#a5c693', '#c4dbaf'
    asphalt, stripe = '#929fa9', '#f4f2e9'

    def wall(name, start, end, material, cuts, axis):
        walls.append((name, start, end, material,
                      *((kind, finish, center - start[axis], width) for kind, finish, center, width in cuts)))

    def h(name, y, left, right, material, *cuts):
        wall(name, (left, y), (right, y), material, cuts, 0)

    def v(name, x, top, bottom, material, *cuts):
        wall(name, (x, top), (x, bottom), material, cuts, 1)

    def door(center, width=1.15, material='wood'):
        return 'door', material, center, width

    def window(center, width=3.6):
        return 'window', 'coated_glass', center, width

    def shape(kind, color, *points):
        surfaces.append((kind, color, points))

    def rect(kind, color, left, top, right, bottom):
        shape(kind, color, (left, top), (right, top), (right, bottom), (left, bottom))

    def room(name, left, top, right, bottom, color, *, label=None):
        rect('floor', color, left, top, right, bottom)
        x, y = label if label is not None else (left + .6, top + 1.25)
        labels.append((x, y, name))

    def place(kind, x, y, angle=0):
        furniture.append((kind, x, y, angle))

    def office_desk(x, y):
        place('desk', x, y)
        place('chair', x, y - .82, 180)
        place('chair', x, y + .95)

    def toilet_bank(name, left, top, right, bottom):
        # Three stalls along the exterior, including a wider end stall.
        first = left + 1.65
        second = left + 3.3
        depth = bottom - 2.45
        positions = [(left + .82, .8), (first + .82, .8), (second + (right - second) / 2, 1.0)]
        h(f'{name}-stall-front', depth, left, right, 'drywall',
          *(door(x, width) for x, width in positions))
        for i, x in enumerate((first, second)):
            v(f'{name}-stall-divider-{i}', x, depth, bottom, 'drywall')
        for x, _ in positions:
            place('toilet', x, bottom - .48, 180)
        place('counter', right - .55, top + 1.75, 90)

    # Twin learning wings frame the courtyard. Each entry is through paired
    # smoke doors off the commons spine, with a second exit beyond the IDF.
    for wing, base, grade, color in [('west', 0, 100, west_classroom), ('east', 65, 200, east_classroom)]:
        corridor_left, corridor_right, outer = base + 9.5, base + 14, base + 23.5
        windows = [window(i * 9 + 4.5, 5.0) for i in range(4)]
        v(f'{wing}-outer-left', base, -8, 36, 'concrete', *windows)
        v(f'{wing}-outer-right', outer, -8, 36, 'concrete', *windows)
        h(f'{wing}-north', -8, base, outer, 'concrete', door(base + 11.75, 2.4, 'glass'))
        v(f'{wing}-support-west', corridor_left, -8, 0, 'drywall', door(-6.15), door(-2.05))
        v(f'{wing}-support-east', corridor_right, -8, 0, 'drywall', door(-4.4, 1.25))
        h(f'{wing}-support-split', -4.1, base, corridor_left, 'drywall', door(base + 2.5))
        v(f'{wing}-idf-divider', base + 5.55, -8, -4.1, 'drywall')
        h(f'{wing}-classroom-end-west', 0, base, corridor_left, 'drywall')
        h(f'{wing}-classroom-end-east', 0, corridor_right, outer, 'drywall')
        room(f'{wing.title()} IDF', base + 5.55, -8, corridor_left, -4.1, service)
        room(f'{wing.title()} electrical', base, -8, base + 5.55, -4.1, service)
        room(f'{wing.title()} custodial / stores', base, -4.1, corridor_left, 0, service)
        room(f'{wing.title()} student restrooms', corridor_right, -8, outer, 0, wet)
        toilet_bank(wing, corridor_right, -8, outer, 0)
        room(f'{wing.title()} learning hall', corridor_left, -8, corridor_right, 36, hall)
        for side, left, right, corridor_edge, faces_east in [
            ('left', base, corridor_left, corridor_left, False),
            ('right', corridor_right, outer, corridor_right, True),
        ]:
            starts = (0, 9, 18, 27)
            v(f'{wing}-{side}-classroom-doors', corridor_edge, 0, 36, 'drywall',
              *(door(y + (1.5 if i % 2 == 0 else 7.5)) for i, y in enumerate(starts)))
            for row, top in enumerate(starts):
                if row:
                    h(f'{wing}-{side}-classroom-divider-{row}', top, left, right, 'drywall')
                number = grade + (4 if faces_east else 0) + row + 1
                room(f'Classroom {number}', left, top, right, top + 9, color)
                # Keep the corridor-side aisle open and leave a teaching zone up front.
                seats_start = left + (3.1 if faces_east else 1.22)
                for j, cols in enumerate((4, 4, 3, 3)):
                    for k in range(cols):
                        place('student_table', seats_start + k * 1.59, top + 2.7 + j * 1.43)
                x = right - (2.0 if faces_east else 3.1)
                place('desk', x, top + 1.17)
                place('chair', x, top + .43, 180)
        h(f'{wing}-smoke-partition', 36, base, outer, 'concrete', door(base + 11.75, 2.8, 'glass'))

    # The academic spine runs between dining and athletics. The commons opens
    # onto the courtyard and the lobby has a controllable after-hours boundary.
    h('courtyard-glazing', 36, 23.5, 65, 'concrete',
      window(30.4, 7), door(44.25, 3.0, 'glass'), window(55.3, 7.5))
    room('Academic commons', 0, 36, 88.5, 44.5, hall)
    v('west-spine-exit', 0, 36, 44.5, 'concrete', door(40.4, 2.4, 'glass'))
    v('east-spine-exit', 88.5, 36, 50, 'concrete', door(39.2, 2.4, 'metal'), door(47.2, 2.8, 'metal'))
    for x in (30, 35, 52, 59):
        place('cafeteria_table', x, 38.3)

    # Food service receives deliveries off the west service lane. Dining and
    # the south terrace have independent exits outside the pickup lanes.
    h('dining-north', 44.5, 0, 34, 'drywall', door(4, 1.2), door(17, 2.6, 'none'), door(26.8, 2.6, 'none'))
    h('dining-south', 66, 0, 34, 'concrete', window(4, 4), door(15, 2.6, 'glass'),
      window(21.1, 5), door(28.2, 2.6, 'glass'))
    v('kitchen-service-exits', 0, 44.5, 66, 'concrete', door(50.5, 1.2, 'metal'), door(61.7, 2.4, 'metal'))
    v('dining-admin-divider', 34, 44.5, 66, 'concrete')
    v('service-line', 9.5, 44.5, 66, 'drywall', door(51.4, 2.5, 'none'), door(55.6, 2.5, 'none'))
    h('food-stores-divider', 58.4, 0, 9.5, 'drywall', door(2.3, 1.3))
    v('food-stores-side', 4.2, 58.4, 66, 'drywall', door(62.2))
    room('Kitchen / serving line', 0, 44.5, 9.5, 58.4, service)
    room('Loading / receiving', 0, 58.4, 4.2, 66, service)
    room('Food storage', 4.2, 58.4, 9.5, 66, service)
    room('Cafeteria', 9.5, 44.5, 34, 66, '#f3e2c8', label=(17, 46.3))
    for x in (13, 18.6, 24.2, 30):
        for y in (48.3, 51.7, 55.1, 58.5, 61.9):
            place('cafeteria_table', x, y)
    for y in (49, 53, 57):
        place('counter', 7.5, y, 90)

    # The public entry faces the south plaza. Doors off the vestibule and lobby
    # lead to reception, the controlled academic spine, and the event concourse.
    h('south-frontage', 66, 34, 88.5, 'concrete',
      window(37, 3.0), window(42.55, 3.0), window(48.0, 3.0), window(53.0, 3),
      door(61, 3.6, 'glass'), window(69.6, 4.0))
    v('reception-lobby', 56, 44.5, 66, 'drywall', door(56.8, 1.2), door(60.7, 1.4, 'glass'))
    h('admin-north', 44.5, 34, 56, 'drywall', door(37.0), door(43.5))
    h('admin-north-offices', 55, 34, 56, 'drywall', door(36.7), door(43.5), door(50.3), door(54.5))
    h('admin-south-offices', 58.5, 34, 56, 'drywall', door(37), door(42.3), door(47.4), door(53.0))
    for x in (40, 47, 53):
        v(f'admin-north-{x}', x, 44.5, 55, 'drywall')
    h('admin-service-divider', 49.4, 34, 40, 'drywall')
    for x in (39.5, 45.1, 50.5):
        v(f'admin-south-{x}', x, 58.5, 66, 'drywall')
    room('Office custodial', 34, 44.5, 40, 49.4, service)
    room('Records & supplies', 34, 49.4, 40, 55, service)
    room('Counseling office', 40, 44.5, 47, 55, office)
    room('Conference room', 47, 44.5, 53, 55, office)
    room('Admin supplies', 53, 44.5, 56, 55, service)
    room('Administration hall', 34, 55, 56, 58.5, hall)
    room('Principal office', 34, 58.5, 39.5, 66, office)
    room('Assistant principal', 39.5, 58.5, 45.1, 66, office)
    room('Registrar', 45.1, 58.5, 50.5, 66, office)
    room('Front office / reception', 50.5, 58.5, 56, 66, office)
    for x, y in [(43.25, 48), (37.1, 62.3), (42.2, 62.3), (47.6, 62.3), (53.1, 63.3)]:
        office_desk(x, y)
    for y in (48.9, 50.85):
        place('cafeteria_table', 50.0, y, 90)
    h('secured-academic-doors', 44.5, 56, 66, 'glass', door(61, 3.0, 'glass'))
    h('entry-vestibule', 62.5, 56, 66, 'glass', door(61, 3.2, 'glass'))
    room('Visitor lobby', 56, 44.5, 66, 62.5, hall)
    room('Entry vestibule', 56, 62.5, 66, 66, hall)
    place('bench', 64.4, 60.4, 90)

    h('core-programs-north', 44.5, 66, 88.5, 'concrete', door(76.5, 2.5, 'metal'))
    h('core-programs-south', 50, 66, 88.5, 'drywall')
    h('core-staff-hall-north', 55.5, 66, 88.5, 'drywall', door(71.5, 1.25, 'metal'), door(75.8), door(84.4))
    h('core-staff-hall-south', 58.5, 66, 88.5, 'drywall', door(70.0), door(77.0), door(84.5))
    v('lobby-operations', 66, 50, 66, 'drywall', door(57.0, 1.6))
    v('core-exterior-return', 88.5, 50, 66, 'concrete')
    for x in (73.5, 80.5):
        v(f'core-division-{x}', x, 50, 55.5, 'drywall')
        v(f'core-public-division-{x}', x, 58.5, 66, 'drywall')
    room('Event concourse', 66, 44.5, 88.5, 50, hall)
    room('Main IT / network room', 66, 50, 73.5, 55.5, service)
    room('Facilities office', 73.5, 50, 80.5, 55.5, office)
    room('Building services', 80.5, 50, 88.5, 55.5, service)
    room('Operations hall', 66, 55.5, 88.5, 58.5, hall)
    room('Nurse suite', 66, 58.5, 73.5, 66, office)
    room('Visitor restrooms A', 73.5, 58.5, 80.5, 66, wet)
    room('Visitor restrooms B', 80.5, 58.5, 88.5, 66, wet)
    office_desk(76.0, 53.2)
    place('bench', 68.0, 62.1, 90)
    place('desk', 71.5, 63.9)
    toilet_bank('visitor-a', 73.5, 58.5, 80.5, 66)
    toilet_bank('visitor-b', 80.5, 58.5, 88.5, 66)

    # The event corridor serves both courts, changing rooms and bus entrance.
    # The athletics IDF is at the far end of the east support strip.
    h('athletics-north', 35, 88.5, 155, 'concrete',
      door(90.25, 2.2, 'glass'), window(95.2, 4), window(111, 4), window(143.5, 4))
    v('athletics-east', 155, 35, 74, 'concrete', door(47.3, 3.0, 'glass'))
    v('athletics-west', 88.5, 66, 74, 'concrete')
    h('athletics-support-entries', 44.5, 88.5, 155, 'drywall',
      *(door(x, width) for x, width in [(90.25, 2.3), (93.4, 1.4), (108, 1.4), (121.5, 1.2), (129, 1.2),
                                        (136, 1.2), (143, 1.2), (152.0, 1.3)]))
    h('athletics-court-doors', 50, 88.5, 155, 'concrete',
      *(door(x, 2.5, 'metal') for x in (95, 115.5, 128, 147.5)))
    h('athletics-south', 74, 88.5, 155, 'concrete',
      door(97.5, 2.3, 'metal'), window(110, 6), window(133.5, 6), door(149, 2.3, 'metal'))
    v('gym-fire-divider', 122, 50, 74, 'concrete')
    room('Athletics hall', 88.5, 44.5, 155, 50, hall)
    room('Main gym', 88.5, 50, 122, 74, '#e8d2ab', label=(98.7, 58.7))
    room('Auxiliary gym', 122, 50, 155, 74, '#ebd9b7', label=(127.6, 66.5))
    for x in (105.25, 138.5):
        place('basketball_court', x, 61.3)
        for offset in (-10, -6, -2, 2, 6, 10):
            place('bench', x + offset, 71)
            place('bench', x + offset, 72.15)
    athletics = [
        ('Trades walk vestibule', 88.5, 92, hall), ('Locker room A', 92, 104, wet), ('Locker room B', 104, 119, wet),
        ('Team storage', 119, 125, service), ('Athletics restrooms', 125, 133, wet),
        ('Gym custodial', 133, 139, service), ('Athletic trainer & PE', 139, 149, office),
        ('Athletics IDF', 149, 155, service),
    ]
    for i, (name, left, right, color) in enumerate(athletics):
        if i:
            v(f'athletics-support-divider-{i}', left, 35, 44.5, 'drywall')
        room(name, left, 35, right, 44.5, color)
    for x in (93.0, 96.0, 99.0, 108.5, 111.5, 114.5):
        place('bench', x, 39.8)
    # The fixtures share the side wall so the stall entrances face the corridor.
    for y in (36.3, 38.15, 40.0):
        place('toilet', 132.45, y, 90)
    for y in (35.5, 37.2, 39.1, 41.1):
        h(f'athletics-wc-stall-{y}', y, 130.5, 133, 'drywall')
    v('athletics-wc-stall-doors', 130.5, 35.5, 41.1, 'drywall',
      door(36.35, .8), door(38.18, .8), door(40.1, .95))
    office_desk(143.0, 38.8)

    # Detached trades wing. The corridor separates dusty shops from clean
    # project rooms, network closet, and student-facing entrance.
    shop_left, shop_right = 109, 149
    h('shop-loading-face', -26, shop_left, shop_right, 'concrete',
      door(115.5, 3.9, 'metal'), window(123, 4), window(135, 4), door(143, 3.9, 'metal'))
    h('shop-school-face', 2, shop_left, shop_right, 'concrete', window(113.6, 4),
      door(122.25, 2.2, 'glass'), window(132.5, 5))
    v('shop-west-face', shop_left, -26, 2, 'concrete', door(-11, 2.8, 'glass'))
    v('shop-east-face', shop_right, -26, 2, 'concrete', door(-11, 2.2, 'metal'))
    v('shop-concrete-divider', 128, -26, -13, 'concrete')
    h('shop-corridor-north', -13, shop_left, shop_right, 'concrete',
      door(113.4, 1.8, 'metal'), door(125, 1.8, 'metal'), door(133, 1.8, 'metal'), door(144, 1.8, 'metal'))
    h('shop-corridor-south', -9, shop_left, shop_right, 'drywall',
      door(113), door(122.25, 2.1, 'glass'), door(127), door(132.0), door(135.1), door(139.2), door(146.0))
    room('Metal shop', shop_left, -26, 128, -13, '#e3e7e9')
    room('Wood shop', 128, -26, shop_right, -13, '#e8dfd0')
    room('Trades hall', shop_left, -13, shop_right, -9, hall)
    shop_rooms = [
        ('Project design', 109, 120.3, east_classroom), ('School-side entry', 120.3, 124.2, hall),
        ('Tool storage', 124.2, 130.2, service), ('Shop WC A', 130.2, 133.5, wet),
        ('Shop WC B', 133.5, 136.5, wet), ('Materials store', 136.5, 143.5, service),
        ('Shop IDF', 143.5, 149, service),
    ]
    for i, (name, left, right, color) in enumerate(shop_rooms):
        if i:
            v(f'shop-support-divider-{i}', left, -9, 2, 'drywall')
        room(name, left, -9, right, 2, color)
    place('welding_cell', 114.2, -21.3)
    place('welding_cell', 122.5, -21.3)
    place('press_brake', 120.5, -16.15)
    place('table', 113.4, -16.4)
    place('pallet_rack', 141.7, -3.45, 90)
    for x in (132.7, 137.2, 142.0):
        for y in (-21.8, -17.0):
            place('table', x, y)
    for x in (112, 115.2, 118.4):
        for y in (-5.8, -2.6):
            place('student_table', x, y)
    place('toilet', 131.0, 1.48, 180)
    place('toilet', 134.3, 1.48, 180)

    # Landscape layers read back-to-front: site base, planting, pedestrian
    # paths, paving, then markings. Building floors paint above these layers.
    surfaces.insert(0, ('landscape', '#edf1e4', (
        (-18, -5), (-5, -18), (94, -18), (103, -35), (155, -35), (158, 14),
        (171, 19), (186, 28), (186, 125), (-18, 125),
    )))
    # Central garden with a continuous loop around planted rooms and seating.
    rect('landscape', grove, 23.5, -2, 65, 36)
    rect('sidewalk', walk, 9.5, -11.2, 79.1, -8)
    rect('sidewalk', walk, 42, -8, 46.5, -.8)
    shape('sidewalk', walk, (27, 4), (31, 1), (57, 1), (61, 5), (61, 27),
          (57, 31), (48.0, 31), (48.0, 36), (41, 36), (41, 31), (31, 31), (27, 27))
    shape('landscape', lawn, (30, 6), (34, 3.6), (55, 3.6), (58, 6), (58, 24.5),
          (54.4, 28), (34, 28), (30, 24.5))
    shape('landscape', planting, (31.5, 9), (38.5, 6.5), (39.8, 9), (39.8, 17),
          (36.8, 19.8), (31.5, 17))
    shape('landscape', planting, (49, 5.5), (55.8, 7.1), (56.4, 18.4),
          (51.5, 21.9), (49, 18.0))
    rect('sidewalk', '#d7bb94', 39.8, 21.0, 53.0, 28)
    rect('sidewalk', plaza, 42, -1.2, 46.5, 21)
    labels.extend([(31.7, 2.5, 'Learning courtyard'), (41.0, 23.0, 'Outdoor seminar terrace')])
    for x, y in [(33.5, 12.1), (36.3, 16.3), (51.8, 10), (53.2, 16.0),
                 (35.3, 23.5), (58.5, 2.2), (26.5, -1)]:
        place('tree', x, y)
    for x in (42.4, 46.4, 50.4):
        place('cafeteria_table', x, 25.6)
    for x, y, angle in [(28.8, 11, 90), (28.8, 21, 90), (59.5, 10, 90), (54, 29.4, 0)]:
        place('bench', x, y, angle)

    # The trades walk bypasses its north loading apron. Outdoor teaching and
    # covered lunch seating are sheltered from both vehicle queues.
    rect('pavement', asphalt, 104, -33, 153, -26)
    rect('pavement', '#a8b2b7', -16, 52, 0, 67.5)
    shape('sidewalk', walk, (88.5, 37.5), (92.0, 37.5), (92.0, 11), (108, 4.8), (120.5, 4.8),
          (120.5, 2), (124, 2), (124, 8), (108.8, 8), (95.5, 13.5), (95.5, 41), (88.5, 41))
    shape('landscape', grove, (99, 11), (110, 8), (139.5, 8), (148.5, 14), (148.5, 31), (99, 31))
    shape('sidewalk', terrace, (104, 15.0), (110, 10.5), (132, 10.5), (139, 16),
          (139, 24), (135, 28), (105, 28), (101.5, 24))
    rect('sidewalk', walk, 88.5, 31.8, 95.5, 35)
    rect('sidewalk', walk, 95, 20, 105, 23.2)
    rect('sidewalk', '#c5d2d7', 109.2, 13.8, 131.8, 24.8)
    labels.extend([(107, -31, 'Trade shop service apron'), (-15.2, 56, 'Food service loading'),
                   (106, 12.35, 'Outdoor classrooms'), (92.0, 8.3, 'Trades walk')])
    for x in (112.6, 118.0, 123.5, 129.0):
        for y in (17, 21.6):
            place('cafeteria_table', x, y)
    for x, y in [(100.6, 27), (108, 29.2), (121, 29.2), (136.6, 27.8),
                 (141.1, 14.4), (145.2, 19.7), (143.3, 26.1)]:
        place('tree', x, y)

    # Front plaza joins dining terrace, school entrance and spectator path.
    rect('sidewalk', terrace, 10, 66, 34, 77.0)
    rect('sidewalk', walk, 32, 66, 86.5, 77.0)
    shape('sidewalk', plaza, (53, 66), (69, 66), (73.5, 73), (71.5, 79), (66.4, 84.5),
          (57, 84.5), (51.0, 78.5), (49.3, 73))
    rect('sidewalk', walk, 2.0, 75.2, 53.6, 78.0)
    rect('sidewalk', walk, 57.25, 80.5, 66.0, 88)
    rect('sidewalk', walk, 82, 71.4, 155, 78.2)
    rect('sidewalk', walk, 151, 74.0, 156, 95.5)
    shape('landscape', planting, (36.2, 68), (47.7, 68), (48.4, 72.3), (43, 74.6), (36.2, 73.8))
    shape('landscape', planting, (74.7, 67.5), (84.2, 67.5), (84.2, 71.2), (80.4, 72.8), (73.7, 73.0))
    labels.extend([(10.8, 68.2, 'Cafeteria terrace'), (54.3, 71, 'Main entrance plaza')])
    for x in (13.4, 18.5, 23.6, 28.7):
        place('cafeteria_table', x, 72.2)
    for x, y in [(7.6, 72.2), (36.8, 70.2), (45.0, 71.1), (77.5, 69.8),
                 (83.0, 70.5), (91.0, 78.4), (98.4, 77.5)]:
        place('tree', x, y)
    for x in (54, 70):
        place('bench', x, 75, 90)

    # Practice turf has a perimeter walkway and markings at its playing scale.
    rect('sidewalk', walk, 100, 77, 154.5, 112.5)
    rect('landscape', '#9fc390', 102, 79.1, 152.5, 110.4)
    for x in (103.5, 115.5, 127.5, 139.5):
        rect('landscape', '#abcda0', x, 80.8, x + 6, 108.8)
    for left, top, right, bottom in [(103.5, 80.8, 151.0, 81.0), (103.5, 108.6, 151.0, 108.8),
                                     (103.5, 81.0, 103.7, 108.6), (150.8, 81.0, 151, 108.6),
                                     (127.25, 81.0, 127.45, 108.6)]:
        rect('landscape', stripe, left, top, right, bottom)
    labels.append((105, 84, 'PE practice field'))
    for x in (107.5, 115, 122.5):
        place('bench', x, 77.9)

    # Drop-off, parking and bus circulation. Marked crossings hold the vehicle
    # rows short of the pedestrian routes.
    rect('pavement', '#9da7af', -18, 117, 186, 125)
    rect('pavement', asphalt, 20, 107, 28, 117)
    rect('pavement', asphalt, 170, 103, 178, 117)
    rect('sidewalk', walk, 23.5, 84.5, 89, 88)
    shape('pavement', asphalt, (-12, 79), (19, 79), (23, 84), (23, 88), (89, 88), (96, 94),
          (96, 103), (89, 109), (-13, 109), (-17, 105), (-17, 85))
    shape('landscape', grove, (20, 96), (32, 95), (56.5, 95), (56.5, 98.9), (27, 98.9), (20, 98))
    shape('landscape', grove, (67, 95), (87.5, 95), (91.2, 97.4), (87.5, 98.9), (67, 98.9))
    rect('sidewalk', walk, -7, 75.5, 1.5, 79.2)
    rect('sidewalk', walk, 57.5, 94.4, 66.5, 99.2)
    rect('sidewalk', walk, 57.5, 108.7, 66.5, 117)
    for x in range(58, 66):
        rect('landscape', stripe, x, 88.3, x + .5, 94.4)
        rect('landscape', stripe, x, 99.2, x + .5, 108.8)
    for x in (-10.5, -7.8, -5.1, -2.4, .3, 3, 5.7, 8.4, 11.1, 13.8, 16.5):
        place('parking_bay', x, 82.2)
        place('parking_bay', x, 103.1, 180)
    for x, y, angle in [(-7.8, 82.2, 0), (.3, 82.2, 0), (8.4, 82.2, 0),
                        (-5.1, 103.1, 180), (11.1, 103.1, 180)]:
        place('car', x, y, angle)
    for x in (30.5, 37.0, 43.5, 50, 71, 77.5, 84):
        place('car', x, 90.65, 90)
    labels.extend([(-9.6, 93.1, 'Visitor parking'), (26, 85.4, 'Car rider pickup')])

    shape('pavement', asphalt, (159.8, 26), (177.7, 26), (184, 32.5), (184, 98.5), (177.5, 105),
          (159.8, 105), (159.8, 92), (165.6, 91), (171, 86), (171, 44), (167, 41), (159.8, 41))
    rect('pavement', '#a3afb8', 159.8, 38, 170.8, 94)
    rect('sidewalk', walk, 155, 45, 159.8, 50)
    rect('sidewalk', walk, 156, 39, 159.8, 89)
    rect('sidewalk', '#c1d0d5', 156.4, 52.8, 159.75, 66.8)
    for y in (53.9, 58.8, 63.7):
        place('bench', 157.1, y, 90)
    for y in (49, 66.5, 84):
        place('bus', 163.25, y, 0)
    for x, y in [(156.5, 35.3), (158, 70.2), (157.6, 91.8), (175.7, 108.5),
                 (9.6, 112), (28.3, 112), (43, 112), (77, 112), (91, 111)]:
        place('tree', x, y)
    for x, y in [(158.3, 44), (158.2, 71.8), (87.4, 86.4), (34.4, 86.0), (-14.6, 96)]:
        place('lamp', x, y)
    labels.extend([(161.2, 38.6, 'Bus rider pickup'), (156.5, 67.5, 'Covered bus waiting')])
    # At Fit Site, overlapping labels are resolved in the order they appear.
    overview = (
        'West IDF', 'East IDF', 'Shop IDF', 'Athletics IDF', 'Main IT / network room',
        'Learning courtyard', 'Cafeteria', 'Main gym', 'Auxiliary gym', 'Outdoor classrooms',
        'Car rider pickup', 'Bus rider pickup', 'Main entrance plaza', 'PE practice field',
        'Cafeteria terrace', 'Metal shop', 'Wood shop', 'Academic commons', 'Visitor parking',
    )
    rank = {name: index for index, name in enumerate(overview)}
    labels.sort(key=lambda item: rank.get(item[2], len(rank)))
    return walls, labels, furniture, surfaces
