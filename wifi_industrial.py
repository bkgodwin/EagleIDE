"""Meter-based building, process, and yard schedule for Rivermill Fabrication Works."""


def industrial_layout():
    walls, notes, symbols, surfaces = [], [], [], []
    concrete, heavy, steel, partition = 'concrete', 'reinforced_concrete', 'metal', 'drywall'
    warehouse, fabrication, machining = '#eadfce', '#ebe0d3', '#dce8ef'
    assembly, service, admin = '#deebe2', '#dce1e3', '#e8e0eb'
    aisle, walk, asphalt, stripe = '#f2e7cc', '#ece1c9', '#9da9ae', '#f8f0d7'
    lawn, shelter = '#cfe0bd', '#dfe5e6'

    def door(at, width=1.2, material='wood'):
        return 'door', material, at, width

    def window(at, width=4.6):
        return 'window', 'coated_glass', at, width

    def horizontal(name, y, left, right, material, *cuts):
        walls.append((name, (left, y), (right, y), material,
                      *((kind, finish, center - left, width) for kind, finish, center, width in cuts)))

    def vertical(name, x, top, bottom, material, *cuts):
        walls.append((name, (x, top), (x, bottom), material,
                      *((kind, finish, center - top, width) for kind, finish, center, width in cuts)))

    def shape(kind, color, *points):
        surfaces.append((kind, color, points))

    def rect(kind, color, left, top, right, bottom):
        shape(kind, color, (left, top), (right, top), (right, bottom), (left, bottom))

    def room(name, left, top, right, bottom, color, *, label=None):
        rect('floor', color, left, top, right, bottom)
        x, y = label if label is not None else (left + .85, top + 1.35)
        notes.append((x, y, name))

    def room_row(wall_prefix, top, bottom, rooms, material=partition):
        for i, (name, left, right, color) in enumerate(rooms):
            if i:
                vertical(f'{wall_prefix}-{i}', left, top, bottom, material)
            room(name, left, top, right, bottom, color)

    def place(kind, x, y, angle=0):
        symbols.append((kind, x, y, angle))

    def row(kind, xs, y, angle=0):
        for x in xs:
            place(kind, x, y, angle)

    # The main building is 168 × 92 m. Trucks work from the north apron.
    # A separate south hallway connects the offices and staff entrances.
    receiving_docks = (7.5, 15.5, 23.5, 31.5, 39.5, 47.5)
    shipping_docks = (116, 124, 132, 140, 148, 156, 164)
    horizontal('plant-north-shell', 0, 0, 168, heavy,
               *(door(x, 3.6, 'metal') for x in receiving_docks),
               door(59.8, 3.1, 'metal'), door(76, 2.8, 'metal'), door(90, 2.6, 'metal'),
               *(door(x, 3.6, 'metal') for x in shipping_docks))
    horizontal('plant-south-shell', 92, 0, 168, concrete,
               window(6, 4), door(19.5, 2.8, 'glass'), window(31, 5.2), window(46, 5.0),
               window(72, 6.5), window(85, 4.4), window(100, 6.2), door(130, 3, 'glass'), window(158, 4.6))
    vertical('plant-west-shell', 0, 0, 92, heavy,
             door(10, 1.7, 'metal'), door(47.5, 5.3, 'metal'), door(70.8, 1.5, 'metal'), door(80, 2, 'glass'))
    vertical('plant-east-shell', 168, 0, 92, heavy,
             door(34, 1.6, 'metal'), door(47.5, 5.3, 'metal'), door(69.2, 1.6, 'metal'), door(80, 2.3, 'glass'))

    # Two cross-plant fire barriers interrupt the material handling spine.
    # The rolling doors are placed on the travel lane, clear of storage.
    vertical('warehouse-fire-separation', 52, 0, 78, heavy, door(47.5, 5.6, 'metal'))
    vertical('assembly-fire-separation', 112, 0, 78, heavy, door(47.5, 5.6, 'metal'))
    horizontal('receiving-rack-threshold', 13, 0, 52, concrete,
               door(12.5, 5.1, 'metal'), door(39.4, 5.1, 'metal'))
    horizontal('shipping-staging-threshold', 13, 112, 168, concrete,
               door(124.8, 5.1, 'metal'), door(154, 5.1, 'metal'))
    horizontal('production-spine-north', 43, 0, 168, concrete,
               door(11.1, 4.8, 'metal'), door(40.5, 4.8, 'metal'),
               door(65.5, 4.8, 'metal'), door(92.5, 4.8, 'metal'),
               door(124.5, 4.8, 'metal'), door(155, 4.8, 'metal'))
    horizontal('production-spine-south', 52, 0, 168, concrete,
               door(11.5, 4.8, 'metal'), door(42.5, 4.8, 'metal'), door(65, 4.8, 'metal'),
               door(95, 4.8, 'metal'), door(124, 3.3, 'metal'), door(149, 4.4, 'metal'))
    room('Forklift / material spine', 0, 43, 168, 52, aisle, label=(59, 47.1))
    for x in range(18, 157, 8):
        if abs(x - 52) > 4 and abs(x - 112) > 4:
            rect('floor', '#c4ad75', x, 47.4, x + 2.6, 47.65)

    # Receiving and shipping have staging, inspection, and their own docks.
    room('Inbound receiving docks', 0, 0, 52, 13, warehouse, label=(6.5, 7.8))
    room('Outbound shipping docks', 112, 0, 168, 13, assembly, label=(122, 4.4))
    row('pallet_rack', (10.5, 23, 36.5), 9.7)
    row('pallet_rack', (124.8, 138.5, 153.5), 9.7)
    place('forklift', 30.9, 5.2, 90)
    place('forklift', 148, 5.1, 270)
    room('Materials warehouse', 0, 13, 52, 43, warehouse, label=(8.6, 16.5))
    for y in (19.4, 26.3, 33.2, 39.6):
        row('pallet_rack', (8.2, 18.8, 30.6, 42.1), y)
    place('forklift', 24.4, 36.2, 180)
    room('Cut stock & kitting', 0, 52, 52, 78, warehouse, label=(18.5, 56.4))
    for y in (62, 68, 73):
        row('steel_stock', (14.8, 28.5, 42.2), y)
    horizontal('warehouse-idf-north', 68, 0, 8.8, concrete)
    vertical('warehouse-idf-east', 8.8, 68, 78, concrete)
    room('Warehouse IDF', 0, 68, 8.8, 78, service)
    place('forklift', 6.2, 57.1, 90)

    # Keep noisy fabrication and machine auxiliaries behind physical partitions.
    horizontal('utilities-production-threshold', 13, 52, 112, concrete,
               door(60.6, 1.6, 'metal'), door(76.5, 1.6, 'metal'), door(91.5, 1.6, 'metal'),
               door(102.5, 1.4, 'metal'), door(109, 1.35, 'metal'))
    room_row('north-utilities', 0, 13, [
        ('Main power & electrical', 52, 70, service), ('Compressor & extraction', 70, 84, service),
        ('Coolant & tool service', 84, 99, service), ('Production IDF', 99, 106, service),
        ('Tool crib', 106, 112, admin),
    ], concrete)
    row('switchgear', (56.5, 63.8), 3.3)
    row('switchgear', (56.5, 63.8), 8.4)
    row('air_handler', (75.7, 80.9), 4.7, 90)
    row('pump_skid', (88.5, 94.4), 8.6)
    room('Fabrication & welding hall', 52, 13, 112, 43, fabrication, label=(54.2, 38.9))
    rect('floor', '#e3dccd', 53, 21.25, 111, 25.5)
    for y in (18.4, 29.8, 38.2):
        row('welding_cell', (58.2, 67.1, 76, 84.9), y, 180 if y == 29.8 else 0)
    for y in (19, 30.5, 38):
        row('press_brake', (95.7, 104.0), y)
    place('forklift', 91, 35.5, 180)
    room('CNC machining hall', 52, 52, 112, 78, machining, label=(73, 54.1))
    rect('floor', '#e5e9e7', 55, 62.6, 109, 66.4)
    for y in (58.8, 70.2):
        row('cnc_mill', (58.5, 67.5, 76.5, 85.5, 94.5, 103.5), y, 180 if y < 60 else 0)
    row('cnc_lathe', (58.8, 69.8, 80.8, 91.8, 102.8), 75.3, 180)

    # Assembly feeds a separate test and packing area, with a dispatch route
    # back to the north loading bays through the assembly-side cross aisle.
    room('Assembly lines', 112, 13, 168, 43, assembly, label=(123, 23.4))
    for y in (22.4, 34.7):
        row('assembly_conveyor', (123.3, 135.3, 147.3), y)
        row('desk', (121.3, 132, 142.7, 153.4), y + 3.0, 180)
    rect('floor', '#e9efd9', 157.4, 14, 164.7, 42)
    place('forklift', 161.0, 25.4, 0)
    vertical('test-and-packing-separation', 138, 52, 78, concrete, door(63.6, 3.6, 'metal'))
    room('Inspection & test', 112, 52, 138, 78, machining)
    room('Packing & finished goods', 138, 52, 168, 78, assembly)
    for y in (59.7, 65.8, 72.1):
        row('table', (117, 122.3, 127.6, 132.9), y)
    for y in (58.7, 65.8):
        row('pallet_rack', (144.8, 156.9), y)
    horizontal('assembly-idf-north', 69, 157, 168, concrete)
    vertical('assembly-idf-west', 157, 69, 78, concrete)
    room('Assembly IDF', 157, 69, 168, 78, service)

    # Visitors and workers can reach offices and training without using the
    # main forklift aisle. The MDF serves the plant from the office strip.
    horizontal('plant-personnel-fire-partition', 78, 0, 168, concrete,
               *(door(x, width, 'metal') for x, width in (
                   (4.5, 1.4), (18.5, 1.6), (42, 1.6), (62, 1.6), (85, 1.6),
                   (109, 1.5), (123, 1.55), (148, 1.55), (162.3, 1.4))))
    horizontal('plant-offices-north', 82, 0, 168, partition,
               *(door(x, width) for x, width in (
                   (6, 1.15), (20, 2.1), (34, 1.2), (47, 1.2), (58.7, 1.4), (73, 1.3),
                   (86, 1.2), (101, 1.3), (116, 1.35), (130, 2.1), (143.6, 1.55), (158, 1.45))))
    room('Staff pedestrian corridor', 0, 78, 168, 82, aisle, label=(24, 80))
    room_row('office-divider', 82, 92, [
        ('Security & visitor services', 0, 12, admin), ('Reception', 12, 26, admin),
        ('Production planning', 26, 40, admin), ('Engineering & CAD', 40, 53, admin),
        ('Main IT / network room', 53, 65, service), ('Conference & sign-off', 65, 79, admin),
        ('Plant management', 79, 93, admin), ('Staff break room', 93, 109, admin),
        ('Staff washrooms', 109, 122, shelter), ('Shift entrance', 122, 136, aisle),
        ('Lockers & PPE', 136, 151, shelter), ('Safety & first aid', 151, 168, admin),
    ])
    row('desk', (4, 10, 17.3, 29.5, 36.3, 43.5, 49.3, 82, 90, 158.6), 86.1)
    row('chair', (4, 10, 17.3, 29.5, 36.3, 43.5, 49.3, 82, 90, 158.6), 87)
    row('cafeteria_table', (69, 74.8, 97.7, 104.4), 88.4)
    row('toilet', (113, 115.4, 118), 90.45, 180)
    row('bench', (140, 146.5, 162.9), 89.2)

    # Detached fleet shop: four large back-in bays, a technician hallway,
    # separated parts/fluid stores, and its own communications closet.
    fleet_bays = (200, 211.7, 223.4, 235.4)
    horizontal('fleet-north-shell', -16, 194, 241, heavy,
               *(door(x, 6.7, 'metal') for x in fleet_bays))
    horizontal('fleet-south-shell', 27, 194, 241, concrete, window(212, 4.8), window(225.5, 4.8))
    vertical('fleet-west-shell', 194, -16, 27, concrete, door(15.1, 1.8, 'glass'))
    vertical('fleet-east-shell', 241, -16, 27, concrete, door(4.8, 1.6, 'metal'), door(15.1, 1.8, 'glass'))
    horizontal('fleet-bays-south', 13, 194, 241, concrete, *(door(x, 1.55, 'metal') for x in fleet_bays))
    horizontal('fleet-support-north', 17.4, 194, 241, partition,
               *(door(x, width) for x, width in ((200, 1.45), (212, 1.6), (224, 1.55), (235.5, 1.4))))
    room('Heavy equipment garage', 194, -16, 241, 13, fabrication, label=(195.8, -13.3))
    room('Fleet service hallway', 194, 13, 241, 17.4, aisle)
    for j, x in enumerate((205.75, 217.5, 229.25), 1):
        vertical(f'fleet-bay-divider-{j}', x, -16, 13, steel, door(7.8, 1.4, 'metal'))
    for x in fleet_bays:
        place('service_bay', x, 0)
    place('telehandler', fleet_bays[1], -.3)
    place('forklift', fleet_bays[3], 1.3)
    room_row('fleet-support', 17.4, 27, [
        ('Parts store', 194, 206, warehouse), ('Service office', 206, 217.5, admin),
        ('Lubricants & fluid store', 217.5, 229.25, service), ('Fleet IDF', 229.25, 241, service),
    ])
    place('pallet_rack', 200, 24.8)
    place('desk', 211.2, 22.3)
    place('chair', 211.2, 23.2)
    place('counter', 223.7, 24.8)

    # Detached training center separates classroom access from the yard.
    horizontal('training-north-shell', 69, 202, 232, concrete, window(209, 5.5), window(223.5, 6.2))
    horizontal('training-south-shell', 91, 202, 232, concrete, window(207.6, 3.8), window(226.1, 4.6))
    vertical('training-west-shell', 202, 69, 91, concrete, door(80.4, 2.5, 'glass'))
    vertical('training-east-shell', 232, 69, 91, concrete, door(80.4, 1.8, 'glass'))
    horizontal('training-classrooms-south', 78.5, 202, 232, partition, door(205.1, 1.4), door(220.6, 1.4))
    horizontal('training-support-north', 82.5, 202, 232, partition, door(207, 1.3), door(216, 1.4), door(225.5, 1.5))
    room_row('training-classrooms', 69, 78.5, [
        ('Training classroom', 202, 216, admin), ('Practical training lab', 216, 232, machining),
    ])
    room('Training center entry', 202, 78.5, 232, 82.5, aisle, label=(205, 79.4))
    room_row('training-support', 82.5, 91, [
        ('Instructor & records', 202, 211.5, admin), ('Training IDF', 211.5, 220.6, service),
        ('Restrooms & storage', 220.6, 232, shelter),
    ])
    for y in (73.6, 75.6, 77.3):
        row('student_table', (205.3, 208.6, 211.9), y)
    row('table', (219, 223.9, 228.8), 73.5)
    row('chair', (219, 223.9, 228.8), 74.5)
    place('desk', 206.1, 70.4)
    place('desk', 206.7, 87.2)
    place('chair', 206.7, 88.1)
    place('toilet', 228.6, 89.6, 180)

    # Give trucks room to line up straight, with painted bay guides.
    surfaces.insert(0, ('landscape', '#e9eee2', (
        (-44, -34), (-28, -58), (161, -58), (178, -53), (250, -53),
        (267, -24), (267, 99), (245, 124), (-28, 124), (-44, 104),
    )))
    shape('pavement', asphalt, (-33, -49), (168, -49), (190, -43), (250, -43),
          (258, -33), (255, -15.9), (194, -15.9), (184, 0), (-17, 0), (-33, -12))
    rect('pavement', '#b2babc', -2, -23, 169.5, 0)
    rect('pavement', '#a9b4b7', 177, -16, 187, 56)
    rect('pavement', '#b5bbb9', 168, 42, 199, 54)
    shape('pavement', asphalt, (246, -22), (255, -22), (255, 26), (252, 34), (243, 34), (246, 25))
    rect('pavement', '#aab0a8', 213, 41.1, 225, 50.9)
    shape('pavement', asphalt, (-40, -18), (-32, -18), (-31, 22), (-37, 30), (-43, 23), (-40, 16))
    rect('pavement', asphalt, -40, -29, -26, -16)
    for x in (*receiving_docks, *shipping_docks):
        for edge in (x - 2.15, x + 2.15):
            rect('landscape', stripe, edge, -22, edge + .19, -.48)
    notes.extend([
        (11.4, -38, 'Receiving truck apron'), (117, -37, 'Dispatch truck apron'),
        (63.5, -20.7, 'Utility service approach'), (196.8, -33, 'Fleet approach'),
    ])
    for x in (7.5, 31.5, 47.5, 124, 148, 164):
        place('semi_truck', x, -10.15)
    for x in (2.6, 51, 111, 168.4, 183.7, 244):
        place('lamp', x, -25.4)

    # Steel is stored in distinct outdoor lanes. A paved lift and test pad
    # is set apart from the pedestrian route between buildings.
    shape('pavement', '#aeb8b5', (-37, 22), (-4, 22), (-4, 43.4), (0, 43.4), (0, 51.6),
          (-4, 51.6), (-4, 78), (-37, 78))
    rect('pavement', '#c0c5b6', -34.5, 27, -9.7, 42)
    rect('pavement', '#c0c5b6', -34.5, 55, -9.7, 73.5)
    notes.extend([(-35.2, 24.4, 'Outdoor steel stockyard'), (-32.5, 53.5, 'Long stock lanes')])
    for y in (30.4, 35.4, 40, 59, 64.4, 69.5):
        row('steel_stock', (-28.7, -15.8), y)
    place('forklift', -12, 48.8, 90)
    place('telehandler', -27, 46.7, 90)
    rect('pavement', '#b8bbb2', 195, 37, 218, 63)
    rect('pavement', '#aab0a8', 220, 32, 256, 60.8)
    rect('sidewalk', '#c7c3aa', 223, 34.8, 252.5, 57.8)
    for x, y, dx, dy in ((224.6, 38.8, 1, 1), (250.9, 38.8, -1, 1),
                         (224.6, 56.2, 1, -1), (250.9, 56.2, -1, -1)):
        shape('landscape', stripe, (x, y), (x + dx * 3.2, y), (x + dx * 3.2, y + dy * .22),
              (x + dx * .22, y + dy * .22), (x + dx * .22, y + dy * 3.2), (x, y + dy * 3.2))
    row('steel_stock', (202, 213.2), 58.5)
    place('mobile_crane', 237.5, 46.5)
    place('telehandler', 211.8, 45.4, 180)
    place('forklift', 194.4, 48.8, 90)
    notes.extend([(196.7, 39.3, 'Outdoor staging'), (224, 35.2, 'Crane & service pad')])

    # Vehicle staging stops north of the signed training path. The garage
    # crossing is at right angles to the truck lane.
    rect('sidewalk', walk, 168, 78.05, 202, 82.75)
    rect('sidewalk', walk, 168, 32.4, 193, 35.6)
    rect('sidewalk', walk, 190, 13.45, 194, 35.6)
    for x in (177.5, 179.6, 181.7, 183.8, 185.9):
        rect('landscape', stripe, x, 32.4, x + .6, 35.6)
    shape('landscape', lawn, (180, 65), (194, 65), (199, 73), (198, 76), (180, 76))
    shape('landscape', lawn, (190, 85), (198, 85), (198, 95), (226, 95), (232, 100), (190, 101))
    rect('sidewalk', walk, 202, 91, 232, 94.5)
    notes.append((170, 79, 'Training walkway'))
    notes.append((202.3, 66.8, 'Detached training center'))
    for x, y in ((182.4, 71.3), (191.2, 72.2), (195.1, 88.8), (218, 97.9), (237.6, 89.1)):
        place('tree', x, y)
    place('bench', 214.3, 93)

    # Visitor parking sits at the office frontage, clear of dock traffic.
    rect('sidewalk', walk, 0, 92, 168, 98)
    rect('sidewalk', '#d1d8d8', 14, 92, 26, 102)
    rect('sidewalk', '#d1d8d8', 124.4, 92, 135.6, 102)
    shape('pavement', asphalt, (-8, 100), (145, 100), (155, 107), (155, 121), (-8, 121))
    rect('pavement', asphalt, -18, 97, -8, 121)
    for x in (4, 7, 10, 13, 29, 32, 35, 38, 99, 102, 105, 108, 111, 114, 139, 142, 145):
        place('parking_bay', x, 104)
    for x in (4, 10, 29, 35, 99, 105, 114, 142):
        place('car', x, 104, 0)
    for left, right in ((44, 59), (67, 81), (87, 96), (150, 166)):
        rect('landscape', lawn, left, 93, right, 99.4)
        place('tree', (left + right) / 2, 96.5)
    notes.append((15.5, 96.1, 'Visitor entrance'))
    notes.append((23.0, 113.7, 'Visitor & staff parking'))

    # Give the overall plan useful labels before room-level detail.
    overview = (
        'Receiving truck apron', 'Dispatch truck apron', 'Materials warehouse',
        'Fabrication & welding hall', 'CNC machining hall', 'Assembly lines',
        'Outdoor steel stockyard', 'Crane & service pad', 'Heavy equipment garage', 'Detached training center',
        'Main power & electrical', 'Main IT / network room', 'Warehouse IDF', 'Production IDF',
        'Assembly IDF', 'Fleet IDF', 'Training IDF', 'Visitor entrance',
    )
    rank = {name: i for i, name in enumerate(overview)}
    notes.sort(key=lambda item: rank.get(item[2], len(rank)))
    return walls, notes, symbols, surfaces
