"""Meter-based departments and grounds for Marshpoint Regional Hospital."""


def hospital_layout():
    walls, notes, symbols, surfaces = [], [], [], []
    shell, barrier, partition = 'brick', 'reinforced_concrete', 'drywall'
    ed, surgical, ward = '#efdfd8', '#dce9ed', '#e5eee9'
    family, behavioral, office = '#eee4d9', '#e7e1ee', '#e8e8e1'
    utility, command, corridor = '#d8e0e3', '#dfe8ef', '#f1ead8'
    walk, pavement, lawn = '#ded9ca', '#a4afb4', '#d2e2c3'

    def door(at, width=1.35, finish='wood'):
        return 'door', finish, at, width

    def window(at, width=3.4):
        return 'window', 'coated_glass', at, width

    def horizontal(name, y, left, right, material, *cuts):
        walls.append((name, (left, y), (right, y), material,
                      *((kind, finish, at - left, width) for kind, finish, at, width in cuts)))

    def vertical(name, x, top, bottom, material, *cuts):
        walls.append((name, (x, top), (x, bottom), material,
                      *((kind, finish, at - top, width) for kind, finish, at, width in cuts)))

    def shape(kind, color, *points):
        surfaces.append((kind, color, points))

    def rect(kind, color, left, top, right, bottom):
        surfaces.append((kind, color, left, top, right, bottom))

    def room(text, color, left, top, right, bottom, *, label=None):
        rect('floor', color, left, top, right, bottom)
        notes.append((*(label or (left + .9, top + 1.4)), text))

    def place(kind, x, y, angle=0):
        symbols.append((kind, x, y, angle))

    def row(kind, positions, y, angle=0):
        for x in positions:
            place(kind, x, y, angle)

    def column(kind, x, positions, angle=0):
        for y in positions:
            place(kind, x, y, angle)

    def room_row(prefix, left, top, bottom, rooms, material=partition):
        for index, (text, right, color) in enumerate(rooms):
            if index:
                vertical(f'{prefix}-{index}', left, top, bottom, material)
            room(text, color, left, top, right, bottom)
            left = right

    # Two east-west spines connect all departments under one roof. The public
    # concourse is separate from the ambulance, clinical and service route.
    horizontal('north-shell', 0, 0, 196, shell,
               *(window(107 + i * 6, 2.8) for i in range(8)), door(181, 5.5, 'metal'))
    horizontal('south-shell', 126, 0, 196, shell,
               window(9), window(28), window(67.2, 8), door(81, 4.5, 'glass'), window(93, 8),
               window(116, 6), window(134, 6), door(173, 2.5, 'glass'), window(185, 4.2))
    vertical('west-shell', 0, 0, 126, shell,
             door(21, 2.45, 'glass'), door(37, 3.2, 'glass'), door(77.7, 3.2, 'glass'), window(109))
    vertical('east-shell', 196, 0, 126, barrier,
             door(24.9, 2.5, 'metal'), door(33.1, 3.1, 'metal'), door(42.9, 2.8, 'metal'),
             door(74.7, 2.3, 'glass'), door(92.5, 2, 'glass'), door(113.8, 1.7))
    horizontal('north-spine-face', 47, 0, 196, barrier,
               *(door(x, width, 'glass') for x, width in ((8, 1.65), (24.5, 2.5), (41, 2.4), (51, 2.8),
                   (68.2, 2), (90, 2.25), (113.6, 2.35), (137, 2.4), (150.2, 1.5), (155.8, 2.2), (172, 1.65), (191, 1.6))))
    horizontal('south-spine-face', 52, 0, 196, barrier,
               *(door(x, width, 'glass') for x, width in ((18, 2.4), (44, 1.8), (51, 2.8), (64, 2),
                   (81.5, 2.25), (105.5, 2.3), (114, 2), (121, 2.5), (141, 2.1), (176, 2.3))))
    room('Clinical transfer spine', corridor, 0, 47, 196, 52, label=(57, 49.8))
    horizontal('public-north-face', 90, 0, 196, barrier,
               *(door(x, width, 'glass') for x, width in ((8.1, 1.6), (37.7, 2.15), (51, 2.7),
                   (64, 1.65), (81.5, 2.2), (105.5, 2.25), (114, 1.55), (121, 2.5), (141, 2), (177, 1.7))))
    horizontal('public-south-face', 95, 0, 196, shell,
               *(door(x, width, 'glass') for x, width in ((30, 2.2), (51, 2.35), (67, 1.55),
                   (81, 4), (98, 1.7), (117, 2.35), (134, 2.15), (151, 1.65), (175, 1.8))))
    room('Public concourse', corridor, 0, 90, 196, 95, label=(99, 92.8))
    for x, y0, y1, at in ((48, 0, 47, (21, 40.4)), (54, 0, 47, (16.2, 41.6)),
                           (104, 0, 47, (34.6,)), (158, 0, 47, (26.0,)),
                           (48, 52, 90, (62.5, 82.4)), (54, 52, 90, (79.5,)),
                           (118, 52, 90, (73.7, 86.4)), (124, 52, 90, (70.8,)),
                           (158, 52, 90, ())):
        vertical(f'department-{x}-{y0}', x, y0, y1, barrier,
                 *(door(center, 2.2, 'glass') for center in at))
    rect('floor', corridor, 48, 0, 54, 47)
    rect('floor', corridor, 48, 52, 54, 90)
    rect('floor', corridor, 118, 52, 124, 90)

    # ED air transfers and staffed ambulance handover meet the trauma route.
    horizontal('trauma-south', 18.8, 0, 48, partition,
               door(13.5, 4.4, 'none'), door(33, 2.1), door(43, 2.1))
    vertical('trauma-imaging', 28, 0, 18.8, barrier)
    vertical('ed-imaging-divider', 38, 0, 18.8, barrier)
    room('Trauma & resuscitation', ed, 0, 0, 28, 18.8, label=(2.3, 2.6))
    room('Emergency CT', surgical, 28, 0, 38, 18.8)
    room('Emergency imaging', surgical, 38, 0, 48, 18.8)
    room('Air transfer', corridor, 0, 18.8, 48, 23.2, label=(2.8, 21))
    for x in (7, 14, 21):
        vertical(f'trauma-bay-{x}', x, 5, 14.2, partition)
    row('hospital_bed', (3.5, 10.5, 17.5, 24.5), 9.4)
    row('counter', (3.5, 10.5, 17.5, 24.5), 6.2)
    row('ct_scanner', (33, 43), 7.7)
    horizontal('ed-north', 23.2, 0, 48, partition,
               door(5.2, 2.4, 'none'), door(19.2, 2.25), door(30.2, 2.25), door(42, 1.55))
    vertical('ambulance-handover-east', 11.2, 23.2, 47, barrier, door(37, 2.4))
    vertical('ed-pod-east', 35.5, 23.2, 47, partition, door(40.4, 1.75))
    room('Ambulance handover', ed, 0, 23.2, 11.2, 47, label=(1.2, 31))
    room('Emergency department', ed, 11.2, 23.2, 35.5, 47, label=(18.2, 35.7))
    room('ED support & observation', ward, 35.5, 23.2, 48, 47, label=(36.4, 28.2))
    for y in (31.5, 38.2, 43.8):
        row('hospital_bed', (15, 21, 27, 32.8), y, 90)
    row('hospital_bed', (39.6, 44.6), 35)
    row('desk', (5.2, 8.2), 27.9)

    # Six operating rooms share a restricted corridor and clean core.
    for y, positions in ((14, (61, 73, 85)), (18.2, (61, 73, 85))):
        horizontal(f'or-hall-{y}', y, 54, 91, barrier, *(door(x, 2.25) for x in positions))
    for left, right, number in ((54, 66.4, 1), (66.4, 78.7, 2), (78.7, 91, 3)):
        if number > 1:
            vertical(f'or-north-{number}', left, 0, 14, partition)
            vertical(f'or-south-{number}', left, 18.2, 32.4, partition)
        for top, bottom, n in ((0, 14, number), (18.2, 32.4, number + 3)):
            room(f'OR {n}', surgical, left, top, right, bottom)
            x, y = (left + right) / 2, (top + bottom) / 2
            place('operating_table', x, y)
            place('counter', x - 3.4, y - 2.2, 90)
            place('counter', x + 3.4, y - 2.2, 90)
    room('Surgical wing', corridor, 54, 14, 91, 18.2, label=(57, 16.0))
    vertical('sterile-core-west', 91, 0, 32.4, barrier, door(16.2, 2.35))
    horizontal('sterile-core-divider', 14, 91, 104, partition)
    room('Sterile processing', utility, 91, 0, 104, 14)
    room('Clean core & supplies', utility, 91, 14, 104, 32.4)
    row('pallet_rack', (97.4,), 7.5)
    row('counter', (94.2, 96.4, 98.6, 100.8), 22.7)
    horizontal('or-lower', 32.4, 54, 104, barrier, door(97.5, 2.4, 'metal'))
    horizontal('periop-hall', 37.2, 54, 104, partition,
               door(68, 2), door(85.8, 2), door(97.5, 1.65))
    rect('floor', corridor, 54, 32.4, 104, 37.2)
    room_row('periop', 54, 37.2, 47, [
        ('Pre-op & holding', 76, surgical), ('Post-anesthesia recovery', 94, surgical), ('Surgery IDF', 104, utility),
    ])
    row('hospital_bed', (58.2, 63.4, 70.8, 79.4, 84, 89.2), 43.8)

    # The acute ward has two rows of private rooms, a workroom and ICU.
    for direction, top, bottom, face, angle in (
        ('north', 0, 9.3, 9.3, 0), ('south', 13.1, 22.6, 13.1, 180),
    ):
        entrances = []
        for i in range(8):
            left = 104 + i * 6.2
            if i:
                vertical(f'acute-{direction}-{i}', left, top, bottom, partition)
            entrances.append(door(left + 1.3, 1.3))
            rect('floor', ward, left, top, left + 6.2, bottom)
            bed_y = (top + 2.75) if direction == 'north' else (bottom - 2.75)
            place('hospital_bed', left + 3.8, bed_y, angle)
            place('chair', left + 5.13, bed_y + .84)
            place('counter', left + 1.4, bed_y, 90)
            bath_face = face - 2.8 if direction == 'north' else face + 2.8
            bath_top, bath_bottom = sorted((bath_face, face))
            rect('floor', utility, left + 3.48, bath_top, left + 6.2, bath_bottom)
            vertical(f'acute-{direction}-{i}-bath-side', left + 3.48, bath_top, bath_bottom, partition)
            horizontal(f'acute-{direction}-{i}-bath-front', bath_face, left + 3.48, left + 6.2, partition,
                       door(left + 4.59, .92))
            place('toilet', left + 4.26, (bath_top + bath_bottom) / 2, angle)
            place('counter', left + 5.8, (bath_top + bath_bottom) / 2, 90)
        horizontal(f'acute-{direction}-entries', face, 104, 153.6, partition, *entrances)
        vertical(f'acute-{direction}-east', 153.6, top, bottom, partition)
    room('Acute inpatient ward', corridor, 104, 9.3, 153.6, 13.1, label=(114, 11.5))
    rect('floor', corridor, 153.6, 0, 158, 47)
    horizontal('acute-ward-lower', 22.6, 104, 153.6, barrier)
    vertical('acute-support-east', 153.6, 22.6, 47, barrier, door(34, 2.1))
    room('ICU & monitored care', ward, 104, 22.6, 130, 47, label=(107, 26.1))
    room('Lab & inpatient pharmacy', surgical, 130, 22.6, 153.6, 38.7, label=(132, 25.9))
    vertical('icu-east', 130, 22.6, 47, barrier, door(34.8, 2.25))
    horizontal('inpatient-workroom', 38.7, 130, 153.6, partition, door(138.2, 1.65), door(150.2, 1.4))
    vertical('inpatient-idf-west', 147.6, 38.7, 47, partition)
    room('Ward team station', ward, 130, 38.7, 147.6, 47)
    room('Ward IDF', utility, 147.6, 38.7, 153.6, 47)
    for y in (29.5, 41.2):
        row('hospital_bed', (107.8, 113.4, 119.8, 125.5), y)
    row('counter', (133.7, 138.3, 142.9, 147.5, 152.1), 32.7)

    # The utility plant and release area use a service approach east of the hospital.
    horizontal('plant-service-threshold', 23.2, 158, 196, barrier, door(178, 2.6, 'metal'))
    horizontal('plant-services-north', 28.3, 158, 196, barrier,
               door(165.6, 1.8, 'metal'), door(176.5, 1.55, 'metal'), door(189, 1.8, 'metal'))
    room('Diesel power plant', utility, 158, 0, 196, 23.2, label=(190.2, 17.6))
    room('Plant service corridor', corridor, 158, 23.2, 196, 28.3, label=(162, 26.2))
    for y in (10, 17.3):
        row('diesel_generator', (167.5, 185), y)
        rect('floor', '#c3cfd0', 162.3, y - 2, 172.7, y + 2)
        rect('floor', '#c3cfd0', 179.8, y - 2, 190.2, y + 2)
    room_row('plant-service', 158, 28.3, 39, [
        ('Switchgear', 172, utility), ('UPS & electrical', 182, utility), ('Mechanical plant', 196, utility),
    ], barrier)
    row('switchgear', (161.8, 168.1, 177.2), 34.6, 90)
    row('air_handler', (186.0, 192.1), 35, 90)
    horizontal('plant-service-release', 39, 158, 196, barrier)
    vertical('morgue-west', 168, 39, 47, barrier, door(42.7, 1.65, 'metal'))
    vertical('morgue-release-door', 184, 39, 47, barrier, door(42.7, 2.35, 'metal'))
    room('Service control', utility, 158, 39, 168, 47)
    room('Morgue', utility, 168, 39, 184, 47)
    room('Private transfer', utility, 184, 39, 196, 47)
    row('hospital_bed', (172, 177.5), 43.8, 90)
    row('counter', (174.1, 179), 39.65)

    # Walk-in emergency and disaster intake can operate while the ED stays in use.
    horizontal('surge-south', 72, 0, 48, barrier,
               door(8.2, 2.3), door(22.5, 2.35), door(38, 2.3))
    vertical('surge-support-east', 34, 52, 72, partition, door(62.5, 2.15))
    room('Regional surge triage', ed, 0, 52, 34, 72, label=(4, 56.3))
    room('ED staff & supply', utility, 34, 52, 48, 72)
    for y in (61, 67.5):
        row('hospital_bed', (4.1, 9.7, 15.3, 20.9, 26.5, 31), y, 90)
    row('pallet_rack', (41.5,), 57.4)
    row('counter', (39, 42, 45), 67.9)
    vertical('triage-isolation', 14.7, 72, 90, barrier, door(79.1, 1.8))
    vertical('isolation-waiting', 29, 72, 90, barrier, door(82.2, 1.75))
    horizontal('emergency-idf-south', 81, 42, 48, partition)
    vertical('emergency-idf-west', 42, 72, 81, partition, door(77.3, 1.4))
    room('Disaster intake', ed, 0, 72, 14.7, 90, label=(2.2, 74.8))
    room('Isolation assessment', surgical, 14.7, 72, 29, 90)
    room('ED walk-in waiting', office, 29, 72, 42, 90)
    room('ED IDF', utility, 42, 72, 48, 81)
    rect('floor', office, 42, 81, 48, 90)
    row('desk', (3.5, 7.7, 12.1), 80.3)
    row('hospital_bed', (19.1, 24.6), 82, 90)
    row('bench', (33, 37.3, 40), 87.4)

    # The enclosed family wing wraps around an open-air garden court.
    for x, openings in ((79, (58.2, 65.5, 83.4)), (107, (57.8, 70, 85.1))):
        vertical(f'family-wing-{x}', x, 52, 90, partition, *(door(y, 1.75) for y in openings))
    for y in (64, 76):
        horizontal(f'maternity-partition-{y}', y, 54, 79, partition)
        horizontal(f'pediatric-partition-{y}', y, 107, 118, partition)
    room('Women’s care', family, 54, 52, 79, 64, label=(70.1, 62.8))
    room('Labor & delivery', family, 54, 64, 79, 76, label=(56, 66.1))
    rect('floor', corridor, 54, 64, 79, 67.2)
    horizontal('labor-room-entries', 67.2, 54, 79, partition, *(door(x, 1.65) for x in (58.3, 66.5, 74.8)))
    for x in (62.3, 70.6):
        vertical(f'labor-room-{x}', x, 67.2, 76, partition)
    room('Postpartum & newborn care', family, 54, 76, 79, 90, label=(55.8, 79.2))
    room('Pediatric care', family, 107, 52, 118, 64, label=(107.5, 55.4))
    room('Pediatric treatment', surgical, 107, 64, 118, 76)
    room('Pediatric observation', family, 107, 76, 118, 90)
    for y in (60.5, 85.3):
        row('hospital_bed', (58.7, 64.8, 70.9, 75.7, 110, 114.9), y)
    row('hospital_bed', (58.7, 66.5, 74.8, 110, 114.9), 72.3)
    rect('floor', corridor, 79, 52, 84, 90)
    rect('floor', corridor, 102, 52, 107, 90)
    vertical('family-waiting-west', 84, 52, 61, partition, door(56.9, 1.55))
    vertical('family-waiting-east', 102, 52, 61, partition, door(56.9, 1.55))
    room('Family waiting', office, 84, 52, 102, 61, label=(85.8, 54.4))
    room('Family cross-hall', corridor, 84, 79, 102, 83.1, label=(85.5, 81.2))
    horizontal('family-staff-north', 83.1, 84, 102, partition, door(93, 1.65))
    vertical('family-staff-west', 84, 83.1, 90, partition)
    vertical('family-staff-east', 102, 83.1, 90, partition)
    room('Family care IDF', utility, 84, 83.1, 102, 90)
    for x in (84, 102):
        vertical(f'garden-court-{x}', x, 61, 79, 'glass', door(70, 1.65, 'glass'))
    horizontal('garden-court-north', 61, 84, 102, 'glass')
    horizontal('garden-court-south', 79, 84, 102, 'glass')
    notes.append((87.5, 73.7, 'Family courtyard'))
    rect('landscape', lawn, 84, 61, 102, 79)
    rect('sidewalk', walk, 84, 68.7, 102, 71.3)
    row('tree', (88.4, 97.7), 65.2)
    row('bench', (89.5, 96.3), 75.6)
    row('sofa', (87.8, 94.3, 99.0), 57.4)

    # Behavioral health has quiet rooms and a buffered public reception.
    horizontal('behavior-hall-north', 68, 124, 158, partition,
               door(130, 1.5), door(141.1, 1.5), door(151.6, 1.7))
    horizontal('behavior-hall-south', 73, 124, 158, partition,
               door(130, 1.5), door(141.1, 1.8), door(151.6, 1.7))
    room_row('behavior-north', 124, 52, 68, [
        ('Counseling', 135, behavioral), ('Quiet assessment', 146, behavioral), ('Group therapy', 158, behavioral),
    ])
    room('Mental health care', corridor, 124, 68, 158, 73, label=(126.7, 71.3))
    room_row('behavior-south', 124, 73, 81, [
        ('Consult', 135, behavioral), ('Care team', 146, behavioral), ('Quiet room', 158, behavioral),
    ])
    horizontal('behavior-check-in-north', 81, 124, 158, partition, door(141, 1.8))
    room('Behavioral health check-in', behavioral, 124, 81, 158, 90)
    row('table', (130, 141), 61)
    row('sofa', (151, 154.8), 60.6)
    row('desk', (131.5, 141.1, 151.1), 77.6)
    row('bench', (131, 136), 87.4)

    # Command has a dedicated entrance and rooms for coordination and logistics.
    horizontal('incident-hall-north', 71, 158, 196, barrier, door(169, 2), door(188.6, 1.8))
    horizontal('incident-hall-south', 76, 158, 196, barrier,
               door(166, 2.1, 'metal'), door(179, 2), door(190.25, 1.5, 'metal'))
    room_row('incident-north', 158, 52, 71, [
        ('Emergency command center', 181, command), ('Coordination & dispatch', 196, command),
    ], barrier)
    rect('floor', corridor, 158, 71, 196, 76)
    room_row('incident-south', 158, 76, 90, [
        ('Disaster supplies', 173, utility), ('Continuity workspace', 186, command), ('Command IDF', 196, utility),
    ], barrier)
    for y in (59.2, 62.4, 65.6):
        row('desk', (163, 168.4, 174.8, 185, 191), y)
        row('chair', (163, 168.4, 174.8, 185, 191), y + .95)
    for y in (81, 86):
        row('pallet_rack', (165.7,), y)
    row('desk', (176.6, 181.7), 83.3)

    # The street frontage keeps public and administrative uses on one concourse.
    vertical('admin-west-hall', 48, 95, 126, partition, door(110.7, 1.9))
    vertical('public-lobby-west', 54, 95, 126, partition, door(104.8, 2.25), door(118, 2.25))
    for y, doors in ((108.4, (7.8, 20.4, 32.8, 43.5)), (113, (7.8, 21.8, 36.8))):
        horizontal(f'office-hall-{y}', y, 0, 48, partition, *(door(x, 1.55) for x in doors))
    room_row('office-north', 0, 95, 108.4, [
        ('Administration', 13.5, office), ('Clinical offices', 25.7, office),
        ('Records & scheduling', 39, office), ('Staff support', 48, office),
    ])
    rect('floor', corridor, 0, 108.4, 48, 113)
    room_row('office-south', 0, 113, 126, [
        ('Staff break room', 14.5, office), ('Conference & training', 30, office), ('Outpatient offices', 48, office),
    ])
    rect('floor', corridor, 48, 95, 54, 126)
    row('desk', (6, 10.5, 18, 21.9, 31.6, 36.1, 44.2), 102.4)
    row('chair', (6, 10.5, 18, 21.9, 31.6, 36.1, 44.2), 103.3)
    row('table', (6.2, 10.7, 20.4, 24.1), 119.2)
    row('desk', (34.5, 39, 43.9), 119.2)
    room('Main lobby & reception', corridor, 54, 95, 108, 126, label=(62, 114.8))
    horizontal('registration-south', 107, 54, 71, partition, door(66, 1.5))
    vertical('registration-east', 71, 95, 107, partition)
    room('Registration', office, 54, 95, 71, 107)
    horizontal('main-it-south', 107.5, 88.4, 108, barrier)
    vertical('main-it-west', 88.4, 95, 107.5, barrier)
    room('Main IT / network room', utility, 88.4, 95, 108, 107.5)
    horizontal('public-restrooms-north', 111.2, 54, 68, partition)
    horizontal('public-restrooms-south', 116.4, 54, 68, partition, door(57.8), door(64.8))
    vertical('public-restrooms-east', 68, 111.2, 116.4, partition)
    vertical('public-restrooms-divider', 61, 111.2, 116.4, partition)
    room('Public restrooms', utility, 54, 111.2, 68, 116.4, label=(55, 114))
    row('toilet', (56, 63), 112)
    row('counter', (59.4, 66.4), 112)
    row('counter', (74.8, 77, 79.2, 81.4, 83.6), 107.35)
    row('bench', (62, 66.8, 90.6, 95.5, 100), 118.4)
    row('desk', (60.4, 65.8), 102.2)
    vertical('cafeteria-west', 108, 95, 126, partition, door(112, 3.1, 'none'))
    vertical('kitchen-west', 142, 95, 126, partition,
             door(103, 2.05, 'none'), door(114.8, 1.65, 'metal'))
    vertical('cafeteria-east', 158, 95, 126, barrier, door(116.8, 1.9, 'metal'))
    room('Cafeteria', '#eee5d4', 108, 95, 142, 126, label=(112.4, 109))
    room('Kitchen & food service', utility, 142, 95, 158, 126, label=(143.2, 98.2))
    for y in (112.5, 117.4, 122.1):
        row('cafeteria_table', (113.5, 119.8, 126.1, 132.4, 137.6), y)
    row('counter', (119, 121, 123, 125, 127, 129, 131), 102.1)
    column('counter', 155.5, (104.1, 106.2, 108.3, 110.4, 114.7, 116.8), 90)
    vertical('support-office-divider', 180, 95, 126, partition, door(112.2, 1.65))
    horizontal('support-office-cross', 109, 158, 196, partition, door(175, 1.8), door(189, 1.5))
    room('Volunteer check-in', office, 158, 109, 180, 126)
    room('Staff briefing room', command, 158, 95, 180, 109)
    room('Facilities administration', utility, 180, 95, 196, 109)
    room('Receiving & storage', utility, 180, 109, 196, 126)
    row('table', (163, 170, 175), 102.5)
    row('desk', (166, 175, 187.5), 116.8)
    row('pallet_rack', (187.5,), 121.5)

    # Ground-level air transfer, emergency traffic and visitor arrival occupy
    # distinct sides. The helipad connects by a pedestrian transfer path.
    surfaces.insert(0, ('landscape', '#e9eee2', (
        (-69, 38), (-63, -6), (-41, -14), (211, -14), (231, 7), (231, 143),
        (210, 157), (14, 157), (-16, 142), (-27, 97), (-61, 88), (-69, 71),
    )))
    shape('pavement', '#bbc2bf', (-57, 7), (-27, 7), (-22, 12), (-22, 30), (-27, 35),
          (-57, 35), (-62, 30), (-62, 12))
    rect('sidewalk', '#d1d8d3', -23, 18.85, 0, 23.15)
    place('helipad', -42, 21)
    notes.extend([(-56, 3.8, 'Ground helipad'), (-23, 15.1, 'Patient transfer walk')])
    shape('pavement', pavement, (-69, 54), (-31, 54), (-24, 47), (-24, 30), (-19, 27.5),
          (0, 27.5), (0, 48.5), (-13, 48.5), (-20, 69), (-69, 69))
    for y in (31, 35.25, 39.5, 43.75, 48):
        rect('pavement', '#faf3d9', -13.5, y - .13, -.45, y + .13)
    for y in (33.1, 37.3, 41.6, 45.8):
        place('ambulance', -5, y, 270)
    rect('sidewalk', walk, -13.3, 71, 0, 87)
    rect('sidewalk', '#e4e1d3', -12.7, 73.7, -.5, 82.4)
    for y in (74.7, 81.3):
        row('lamp', (-12.2, -3), y)
    row('bench', (-10.2, -6.8, -3.4), 80.7)
    rect('pavement', pavement, -24, 68.8, -13.3, 87)
    notes.extend([(-21.3, 25.9, 'Ambulance bays'), (-60.9, 61, 'EMS vehicle approach'),
                  (-15.5, 89, 'Covered surge arrival')])

    # Facilities vehicles and command staff use the east approach.
    shape('pavement', pavement, (196, 17.5), (217, 17.5), (227, 27), (227, 135),
          (215, 145), (201, 145), (201, 117), (196, 114), (196, 104), (205, 101), (205, 53), (196, 52))
    rect('pavement', '#c4cbca', 167, -10.7, 207, 0)
    rect('pavement', pavement, 198.4, -10.7, 209.2, 18.2)
    rect('pavement', '#bcc5c5', 196, 23, 210.5, 48)
    rect('sidewalk', walk, 196, 70, 208, 80.8)
    rect('sidewalk', walk, 196, 89.9, 209, 95.1)
    notes.extend([(168, -4, 'Facilities service yard'), (199.4, 36.5, 'Service apron'),
                  (198, 76.8, 'Command entrance')])

    rect('sidewalk', walk, 0, 126, 196, 131)
    rect('sidewalk', '#e9dfca', 67.5, 126, 98, 136.3)
    rect('pavement', pavement, 25, 136.3, 194, 153)
    rect('pavement', pavement, 190, 135.7, 205, 145)
    for left, right in ((13, 23), (49, 64.2), (103, 114), (148, 166)):
        rect('landscape', lawn, left, 130.1, right, 135.1)
        place('tree', (left + right) / 2, 132.7)
    parking = tuple(29 + i * 2.75 for i in range(58))
    row('parking_bay', parking, 150.1, 180)
    row('car', (x for i, x in enumerate(parking) if i % 5 in (1, 4)), 150.1, 180)
    notes.extend([(72.1, 133.9, 'Public arrival plaza'), (28, 143.8, 'Visitor parking & drop-off')])

    # Department labels are first so they remain legible when the whole site fits.
    overview = (
        'Ground helipad', 'Ambulance bays', 'Emergency department', 'Trauma & resuscitation', 'Surgical wing',
        'Acute inpatient ward', 'ICU & monitored care', 'Diesel power plant', 'Morgue', 'Regional surge triage',
        'Women’s care', 'Pediatric care', 'Mental health care', 'Emergency command center', 'Disaster supplies',
        'Cafeteria', 'Main lobby & reception', 'Public arrival plaza', 'Administration', 'Main IT / network room',
        'Clinical transfer spine', 'Public concourse', 'Command entrance', 'Covered surge arrival',
    )
    rank = {name: index for index, name in enumerate(overview)}
    notes.sort(key=lambda item: rank.get(item[2], len(rank)))
    return walls, notes, symbols, surfaces
