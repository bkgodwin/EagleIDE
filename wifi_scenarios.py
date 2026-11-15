"""Built-in Infra Sim challenges and their editable starter plans."""

import math

from network_store import WIFI_SCHEMA_VERSION, validate_wifi_site


def _community_center():
    # Trace the Lefevre Community Stadium floor plan supplied for the exercise.
    # Coordinates are landmarks in a 2105 × 1489 render. Calibrate using the
    # labeled 38.3 m gym wall and retain the angles and setbacks of the drawing.
    origin = (542, 210)
    north_west, north_east = (626, 286), (1471, 210)
    meters_per_pixel = 38.3 / math.dist(north_west, north_east)
    walls, openings, labels, decor, surfaces = [], [], [], [], []

    def point(p):
        return {axis: round((value - offset) * meters_per_pixel, 4)
                for axis, value, offset in zip(('x', 'y'), p, origin)}

    def wall(wall_id, a, b, *, doors=(), windows=(), material='concrete'):
        walls.append({'id': wall_id, 'a': point(a), 'b': point(b), 'material': material})
        # Opening intervals use the primary coordinate of the source wall.
        axis = int(abs(b[1] - a[1]) > abs(b[0] - a[0]))
        span = b[axis] - a[axis]
        for kind, intervals in (('door', doors), ('window', windows)):
            for i, (start, end, surface) in enumerate(intervals, 1):
                openings.append({'id': f'{wall_id}-{kind}-{i}', 'wall_id': wall_id, 'kind': kind,
                                 'material': surface, 't': ((start + end) / 2 - a[axis]) / span,
                                 'width': abs((end - start) / span) * math.dist(a, b) * meters_per_pixel})

    def label(label_id, p, text):
        labels.append({'id': label_id, **point(p), 'text': text})

    def symbol(kind, p, angle=0):
        decor.append({'id': f'fixture-{len(decor) + 1}', **point(p), 'kind': kind, 'angle': angle})

    def surface(surface_id, kind, fill, outline):
        surfaces.append({'id': surface_id, 'kind': kind, 'color': fill,
                         'points': [point(p) for p in outline]})

    wall('gym-north', north_west, north_east, windows=[(657, 770, 'glass'), (824, 938, 'glass'),
         (992, 1106, 'glass'), (1161, 1273, 'glass'), (1327, 1441, 'glass')])
    wall('gym-west', north_west, (660, 667), doors=[(618, 664, 'metal')])
    wall('gym-east-upper', north_east, (1485, 365))
    wall('gym-east-step', (1485, 365), (1517, 362))
    wall('gym-east-seating', (1517, 362), (1558, 811))
    wall('gym-east-return', (1558, 811), (1524, 814))
    wall('gym-east-exit', (1524, 814), (1540, 968), doors=[(816, 862, 'metal')])
    # Keep the circulation openings as doors in the plan's room boundaries.
    wall('gym-south-west', (694, 1043), (805, 1034), doors=[(766, 804, 'wood')])
    wall('gym-south-middle', (805, 1034), (1060, 1011), windows=[(892, 1005, 'glass')], material='reinforced_concrete')
    wall('gym-foyer-entry', (1060, 1011), (1177, 1000), doors=[(1074, 1150, 'glass')])
    wall('gym-south-east', (1177, 1000), (1540, 968), windows=[(1227, 1341, 'glass')])

    wall('store-north', (542, 674), (660, 667))
    wall('west-wing-exterior', (542, 674), (542, 1242))
    upper_partition = (676.55, 850)
    lower_partition = (681.07, 900)
    wall('store-gym', (660, 667), upper_partition, doors=[(768, 817, 'metal')], material='reinforced_concrete')
    wall('services-gym', upper_partition, lower_partition, material='reinforced_concrete')
    small_store_corner = (689.39, 992)
    small_store_bottom = (637, 1043)
    wall('store-gym-lower', lower_partition, small_store_corner, doors=[(918, 966, 'metal'), (969, 990, 'wood')], material='reinforced_concrete')
    wall('store-gym-bottom', small_store_corner, (694, 1043), material='reinforced_concrete')
    wall('comms-store-divider', (542, 850), upper_partition, doors=[(618, 639, 'metal')], material='reinforced_concrete')
    wall('services-store-divider', (542, 900), lower_partition, doors=[(625, 645, 'metal')], material='reinforced_concrete')
    wall('comms-services-divider', (613, 850), (613, 900), doors=[(868, 886, 'metal')], material='reinforced_concrete')
    wall('store-small-side', small_store_bottom, (633, 997), material='brick')
    wall('store-small-entry', (633, 997), small_store_corner, doors=[(650, 672, 'wood')], material='brick')
    wall('store-restrooms', (542, 1043), (694, 1043))
    wall('restrooms-top', (694, 1043), (766, 1045))
    wall('restroom-divider', (542, 1142), (643, 1142))
    wall('restroom-chase-end', (643, 1134), (643, 1150), material='brick')
    wall('restroom-chase', (643, 1134), (766, 1134), material='brick')
    wall('restroom-chase-south', (643, 1150), (766, 1150), material='brick')
    wall('restrooms-hall', (766, 1045), (766, 1200), doors=[(1100, 1122, 'wood'), (1134, 1150, 'wood')], material='brick')
    wall('restrooms-turn', (766, 1200), (801, 1200), doors=[(777, 798, 'wood')], material='brick')
    wall('restrooms-end', (801, 1200), (801, 1242))
    wall('restrooms-south', (542, 1242), (801, 1242), windows=[(559, 630, 'glass'), (716, 787, 'glass')])
    wall('west-hall-gym', (766, 1079), (801, 1077), doors=[(776, 798, 'wood')], material='brick')

    wall('service-hall', (801, 1077), (801, 1200), doors=[(1148, 1170, 'wood')], material='brick')
    wall('kitchen-north', (801, 1077), (1036, 1057), doors=[(803, 823, 'wood'), (887, 908, 'wood')], material='brick')
    wall('accessible-kitchen-divider', (870, 1071), (870, 1191), material='brick')
    kitchen_corner = (1043.21875, 1134)
    wall('service-crosswall', (801, 1134), kitchen_corner, doors=[(889, 908, 'wood')], material='brick')
    wall('service-south', (801, 1191), (918, 1191), material='brick')
    wall('meeting-west', (918, 1134), (918, 1224), material='brick')
    wall('meeting-step', (918, 1224), (934, 1224), material='brick')
    wall('meeting-west-lower', (934, 1224), (934, 1260))
    wall('meeting-south', (934, 1260), (1054, 1249))
    entry_corner = (1047.71875, 1182)
    exterior_corner = (1051.9375, 1227)
    wall('kitchen-foyer', (1036, 1057), kitchen_corner, material='brick')
    wall('meeting-foyer', kitchen_corner, entry_corner, doors=[(1139, 1178, 'wood')], material='brick')
    wall('meeting-entry', entry_corner, exterior_corner, material='brick')
    wall('meeting-outside', exterior_corner, (1054, 1249))

    wall('office-west', (1148, 1019), (1148, 1095), material='brick')
    wall('office-top-return', (1148, 1019), (1177, 1019), material='brick')
    wall('office-top-post', (1177, 1019), (1177, 1000))
    wall('office-south', (1148, 1095), (1245, 1099), doors=[(1198, 1221, 'wood')], material='brick')
    wall('office-activity-divider', (1245, 994), (1245, 1099), material='reinforced_concrete')
    wall('activity-foyer-upper', (1245, 1099), (1225, 1125), doors=[(1101, 1122, 'wood')], material='brick')
    wall('activity-store-north', (1177, 1182), (1231, 1182), doors=[(1191, 1213, 'wood')], material='brick')
    wall('activity-store-east', (1231, 1182), (1231, 1281), material='brick')
    wall('entry-east', (1177, 1182), (1177, 1281))
    wall('entry-inner', entry_corner, (1177, 1182), doors=[(1091, 1134, 'glass')], material='brick')
    wall('entry-exterior', exterior_corner, (1177, 1227), doors=[(1091, 1134, 'glass')])
    wall('activity-south', (1177, 1281), (1426, 1281), windows=[(1248, 1297, 'glass'), (1310, 1363, 'glass'), (1377, 1424, 'glass')])
    wall('activity-east-upper', (1426, 978), (1426, 1113), doors=[(1027, 1066, 'glass'), (1070, 1110, 'glass')])
    wall('activity-east-bump-top', (1426, 1113), (1449, 1113))
    wall('activity-east-bump', (1449, 1113), (1449, 1151))
    wall('activity-east-bump-bottom', (1449, 1151), (1426, 1151))
    wall('activity-east-lower', (1426, 1151), (1426, 1281), doors=[(1154, 1192, 'glass'), (1196, 1234, 'glass')])
    activity_split = (1225 + 6 * (1132 - 1125) / (1182 - 1125), 1132)
    wall('activity-foyer-lower', (1225, 1125), activity_split, material='brick')
    wall('activity-foyer-doors', activity_split, (1231, 1182), doors=[(1136, 1179, 'wood')], material='brick')
    wall('activity-split', activity_split, (1449, 1132), doors=[(1290, 1360, 'none')], material='drywall')

    label('gym-label', (1060, 580), 'Gymnasium / events')
    label('seating-label', (1415, 588), 'Seating')
    label('gym-store-label', (567, 774), 'Gym store')
    label('comms-label', (558, 869), 'Comms')
    label('services-label', (642, 899), 'Electrical')
    label('event-store-label', (560, 966), 'Event storage')
    label('west-store-label', (661, 1020), 'Store')
    label('male-label', (608, 1092), 'Male WC')
    label('female-label', (608, 1191), 'Female WC')
    label('accessible-label', (813, 1104), 'Access WC')
    label('cleaner-label', (835, 1162), 'Cleaner')
    label('plant-label', (893, 1179), 'Plant')
    label('kitchen-label', (966, 1117), 'Kitchen')
    label('meeting-label', (980, 1192), 'Meeting')
    label('foyer-label', (1097, 1114), 'Foyer')
    label('entry-label', (1109, 1206), 'Entry')
    label('office-label', (1194, 1050), 'Office')
    label('activity-label', (1304, 1074), 'Activity room')
    label('multipurpose-label', (1300, 1239), 'Multipurpose room')
    label('activity-store-label', (1205, 1245), 'Store')
    label('entry-awning-label', (1116, 1321), 'Entry awning')
    label('east-awning-label', (1508, 1115), 'Side awning')
    label('parking-label', (300, 1140), 'Visitor parking')
    label('plaza-label', (1660, 1060), 'Civic plaza')

    surface('parking-paving', 'pavement', '#aab5bd', [(275, 690), (514, 690), (514, 1099), (275, 1099)])
    surface('parking-walk', 'sidewalk', '#e4ded0', [(514, 698), (536, 698), (536, 1265), (1056, 1265),
            (1056, 1227), (1177, 1227), (1177, 1320), (514, 1320)])
    surface('east-walk', 'sidewalk', '#e4ded0', [(1177, 1281), (1426, 1281), (1426, 980), (1515, 980),
            (1515, 1281), (1655, 1281), (1655, 1320), (1177, 1320)])
    surface('east-lawn', 'landscape', '#dbead1', [(1576, 932), (1790, 932), (1790, 1280), (1515, 1280), (1515, 980)])
    surface('plaza-paving', 'pavement', '#d4cdc0', [(1550, 1005), (1712, 1005), (1754, 1061), (1754, 1242),
            (1693, 1281), (1550, 1281)])
    surface('office-floor', 'floor', '#e1e9ef', [(1148, 1019), (1177, 1019), (1177, 1000), (1245, 994), (1245, 1099), (1148, 1095)])
    surface('meeting-floor', 'floor', '#e6e1ed', [(918, 1134), kitchen_corner, entry_corner, exterior_corner,
            (1054, 1249), (934, 1260), (934, 1224), (918, 1224)])
    surface('activity-floor', 'floor', '#f0e8db', [(1245, 994), (1426, 978), (1426, 1113), (1449, 1113), (1449, 1132),
            activity_split, (1225, 1125), (1245, 1099)])

    for y in (732, 788, 844, 900, 956, 1012, 1068):
        symbol('parking_bay', (450, y), 90)
        if y in (732, 844, 900, 1012):
            symbol('car', (450, y), 90 if y in (732, 1012) else 270)
    for p in ((310, 717), (310, 1074), (1531, 1261), (1724, 1210), (1698, 1028)):
        symbol('lamp', p)
    for p in ((329, 607), (443, 620), (363, 1193), (445, 1275), (1590, 964), (1752, 968), (1781, 1165), (1761, 1294)):
        symbol('tree', p)
    for p, angle in (((1571, 1089), 90), ((1683, 1242), 0), ((1101, 1274), 0), ((1490, 1225), 90)):
        symbol('bench', p, angle)
    symbol('desk', (1208, 1026))
    symbol('chair', (1208, 1044))
    for p in ((988, 1185), (1319, 1045), (1372, 1045), (1318, 1178), (1370, 1178), (1599, 1155), (1676, 1155)):
        symbol('table', p)
        symbol('chair', (p[0], p[1] - 19), 180)
        symbol('chair', (p[0], p[1] + 19))

    return validate_wifi_site({'schema_version': WIFI_SCHEMA_VERSION, 'title': 'Port Adelaide Community Center',
                               'units': 'm', 'band': '5', 'walls': walls, 'openings': openings, 'labels': labels,
                               'access_points': [], 'decor': decor, 'surfaces': surfaces})


def _starter(title, walls, rooms, furniture, surfaces=()):
    """Build an unwired starter from meter-based wall and furnishing schedules."""
    def point(x, y):
        return {'x': x, 'y': y}

    openings, segments = [], []
    for wall_id, a, b, material, *cuts in walls:
        segments.append({'id': wall_id, 'a': point(*a), 'b': point(*b), 'material': material})
        length = math.dist(a, b)
        for i, (kind, finish, center, width) in enumerate(cuts):
            openings.append({'id': f'{wall_id}-{i + 1}', 'wall_id': wall_id, 'kind': kind,
                             'material': finish, 't': center / length, 'width': width})

    return validate_wifi_site({
        'schema_version': WIFI_SCHEMA_VERSION, 'title': title, 'units': 'm', 'band': '5',
        'walls': segments, 'openings': openings, 'access_points': [],
        'labels': [{'id': f'room-{i}', **point(x, y), 'text': text}
                   for i, (x, y, text) in enumerate(rooms)],
        'decor': [{'id': f'fixture-{i}', **point(x, y), 'kind': kind, 'angle': angle}
                  for i, (kind, x, y, angle) in enumerate(furniture)],
        'surfaces': [{'id': f'finish-{i}', 'kind': kind, 'color': color,
                      'points': [point(x1, y1), point(x2, y1), point(x2, y2), point(x1, y2)]}
                     for i, (kind, color, x1, y1, x2, y2) in enumerate(surfaces)],
    })


def _coffee_shop():
    walls = [
        ('front-glazing', (0, 11), (15, 11), 'brick',
         ('window', 'coated_glass', 2.7, 4), ('door', 'glass', 7, 1.8), ('window', 'coated_glass', 11.6, 4)),
        ('west-exterior', (0, 0), (0, 11), 'brick', ('window', 'glass', 8.5, 2.4)),
        ('east-exterior', (15, 0), (15, 11), 'brick', ('door', 'glass', 8.6, 1.6)),
        ('rear-exterior', (0, 0), (15, 0), 'brick', ('door', 'metal', 3.2, 1.15)),
        ('service-partition', (0, 4), (15, 4), 'drywall',
         ('door', 'none', 4.2, 1.3), ('door', 'wood', 9.1, 1), ('door', 'wood', 12.7, 1.05)),
        ('prep-office', (7.5, 0), (7.5, 4), 'drywall'),
        ('office-restroom', (10.9, 0), (10.9, 4), 'drywall'),
        ('stockroom', (4.8, 0), (4.8, 2.4), 'drywall', ('door', 'wood', 1.1, .85)),
        ('stockroom-front', (4.8, 2.4), (7.5, 2.4), 'drywall'),
        ('patio-screen', (15, 5), (21, 5), 'wood'),
    ]
    rooms = [
        (1, 1.2, 'Prep and wash'), (5.25, 1.2, 'Stock'), (8.1, 1.2, 'Office / network shelf'),
        (11.7, 1.2, 'Accessible WC'), (1, 4.8, 'Service counter'), (8, 5, 'Pickup'),
        (1, 7.1, 'Indoor seating'), (15.8, 6.1, 'Patio seating'),
        (1, 12.7, 'Street entrance'), (1, -0.8, 'Delivery lane'),
    ]
    seating = [(2.4, 8.5), (4.9, 8.5), (10.7, 8.5), (13, 8.5),
               (17, 7.5), (19.5, 7.5), (17, 10), (19.5, 10)]
    furniture = [('desk', 2, 5.6, 0), ('desk', 4.1, 5.6, 0), ('desk', 6.2, 5.6, 0),
                 ('desk', 9.5, 2.3, 0), ('bench', 1.4, 2.1, 0), ('bench', 12.8, 6.9, 0),
                 ('tree', 21.2, 10, 0), ('tree', 20.7, 4.3, 0), ('lamp', 15.7, 11.7, 0)]
    for x, y in seating:
        furniture.extend([('table', x, y, 0), ('chair', x, y - .8, 180), ('chair', x, y + .8, 0)])
    surfaces = [
        ('floor', '#eee3d1', 0, 4, 15, 11), ('floor', '#e9d4bb', 0, 4, 7.5, 6.3),
        ('floor', '#dbe3df', 0, 0, 7.5, 4), ('floor', '#dbe6ed', 7.5, 0, 10.9, 4),
        ('floor', '#e3e5ee', 10.9, 0, 15, 4), ('pavement', '#e4d9c9', 15, 5, 21, 11.8),
        ('sidewalk', '#e5e7e9', -1, 11, 21, 13.5), ('pavement', '#d6dce1', -1, -2, 15, 0),
    ]
    return _starter('Juniper & Main Coffee', walls, rooms, furniture, surfaces)


def _three_bedroom_house():
    # The living footprint is 12 × 13.2 m. The garage projects east beside the
    # mudroom and has 6.5 × 6.6 m clear for two cars and a rear workbench.
    walls = [
        ('front', (0, 13.2), (12, 13.2), 'brick', ('window', 'glass', 3.1, 3.2), ('door', 'wood', 9.7, 1.05)),
        ('rear', (0, 0), (12, 0), 'brick', ('window', 'glass', 1.5, 1.6),
         ('window', 'glass', 6, 1.6), ('window', 'glass', 10, 1.6)),
        ('west', (0, 0), (0, 13.2), 'brick', ('window', 'glass', 6.97, 1.05), ('door', 'glass', 9.12, 1.95)),
        ('east-house', (12, 0), (12, 6.6), 'brick', ('window', 'glass', 1.8, 1.6)),
        ('garage-north', (12, 6.6), (18.5, 6.6), 'brick'),
        ('garage-east', (18.5, 6.6), (18.5, 13.2), 'brick', ('window', 'glass', 2.2, 1.4)),
        ('garage-front', (12, 13.2), (18.5, 13.2), 'brick', ('door', 'metal', 3.25, 5.0)),
        ('garage-house', (12, 6.6), (12, 13.2), 'drywall', ('door', 'wood', 1.55, .95)),
        ('bedroom-hall', (0, 4.8), (12, 4.8), 'drywall',
         ('door', 'wood', 3.64, .9), ('door', 'wood', 5.3, .9), ('door', 'wood', 8.9, .9)),
        ('bedroom-primary-divider', (4.5, 0), (4.5, 4.8), 'drywall'),
        ('bedroom-divider', (8.1, 0), (8.1, 4.8), 'drywall'),
        ('ensuite-north', (0, 2.55), (2.4, 2.55), 'drywall', ('door', 'wood', 1.82, .8)),
        ('ensuite-side', (2.4, 2.55), (2.4, 4.8), 'drywall'),
        ('hall-living', (0, 6.4), (12, 6.4), 'drywall',
         ('door', 'none', 4.5, 3.35), ('door', 'wood', 8.38, .85), ('door', 'wood', 10.53, .9)),
        ('bath-west', (7.25, 6.4), (7.25, 9.15), 'drywall'),
        ('bath-laundry', (9.5, 6.4), (9.5, 9.15), 'drywall'),
        ('bath-south', (7.25, 9.15), (12, 9.15), 'drywall'),
    ]
    rooms = [
        (2.94, 1.15, 'Primary bedroom'), (.32, 4.4, 'En suite'), (4.76, 3.9, 'Bedroom 2'),
        (8.42, 3.9, 'Bedroom 3'), (6.5, 5.63, 'Bedroom hall'), (.99, 7.88, 'Kitchen'),
        (4.48, 7.35, 'Dining'), (1.1, 10.55, 'Living room'), (9.02, 11.1, 'Entry'),
        (7.57, 7.93, 'Hall bath'), (9.81, 8.88, 'Laundry / mudroom'), (15.01, 8.05, 'Two-car garage'),
        (-4, 7.7, 'Side deck'), (14.12, 15.1, 'Driveway'), (8.29, 14.52, 'Front porch'),
    ]
    furniture = [
        ('bed', 1.23, 1.3, 0), ('counter', 3.91, 2.9, 90),
        ('tub', .48, 3.74, 90), ('toilet', 1.36, 4.34, 180), ('counter', 2.03, 3.75, 90),
        ('bed', 7.07, 1.4, 0), ('desk', 5.48, .59, 0), ('chair', 5.48, 1.45, 0),
        ('bed', 11.09, 1.4, 0), ('desk', 9.18, .59, 0), ('chair', 9.18, 1.45, 0),
        ('counter', .66, 7.23, 90), ('counter', 1.91, 6.74, 0), ('counter', .96, 10.13, 0),
        ('table', 5.32, 8.6, 0), ('chair', 4.88, 7.76, 180), ('chair', 5.76, 7.76, 180),
        ('chair', 4.88, 9.44, 0), ('chair', 5.76, 9.44, 0),
        ('sofa', 2.83, 12.4, 0), ('table', 2.83, 11.08, 0), ('chair', 4.23, 11.46, 270),
        ('tub', 8.43, 8.67, 0), ('toilet', 7.66, 7.25, 90), ('counter', 9.15, 7.34, 90),
        ('counter', 10.93, 8.76, 0), ('bench', 11.03, 7.02, 0),
        ('counter', 15.65, 6.98, 0), ('car', 13.94, 10.03, 0),
        ('table', -2.4, 9.28, 0), ('chair', -2.95, 8.48, 180), ('chair', -1.85, 8.48, 180),
        ('chair', -2.95, 10.08, 0), ('chair', -1.85, 10.08, 0),
        ('tree', -3.4, 3.9, 0), ('tree', 2.5, 15.9, 0), ('lamp', 8.17, 13.7, 0),
    ]
    surfaces = [
        ('landscape', '#dce9d5', -5.8, -3.5, 0, 18), ('landscape', '#dce9d5', 0, 13.2, 19.5, 18),
        ('sidewalk', '#dfc9ad', -4.5, 7.32, 0, 11.5),
        ('sidewalk', '#e4ddd2', 8.05, 13.2, 11.46, 14.86), ('sidewalk', '#e4ddd2', 9.02, 14.86, 10.4, 18),
        ('pavement', '#cfd6db', 12.15, 13.2, 18.35, 18),
        ('floor', '#ebe4d9', 0, 0, 12, 4.8), ('floor', '#dbe7ec', 0, 2.55, 2.4, 4.8),
        ('floor', '#e9dbc7', 0, 4.8, 12, 6.4), ('floor', '#eee4d6', 0, 6.4, 12, 13.2),
        ('floor', '#dbe7ec', 7.25, 6.4, 9.5, 9.15), ('floor', '#dae3e7', 9.5, 6.4, 12, 9.15),
        ('floor', '#d9dadd', 12, 6.6, 18.5, 13.2),
    ]
    return _starter('Maple Lane House', walls, rooms, furniture, surfaces)


def _high_school():
    walls, rooms, furniture, surfaces = [], [], [], []
    teaching, circulation, support = '#e2eaf0', '#ecdfcb', '#dbe4e9'
    academic, wet, office = '#dbe6df', '#d5e5eb', '#e8e2ed'

    def h(wall_id, y, x1, x2, material, *cuts):
        walls.append((wall_id, (x1, y), (x2, y), material,
                      *((kind, finish, center - x1, width) for kind, finish, center, width in cuts)))

    def v(wall_id, x, y1, y2, material, *cuts):
        walls.append((wall_id, (x, y1), (x, y2), material,
                      *((kind, finish, center - y1, width) for kind, finish, center, width in cuts)))

    def door(center, width=1.0, material='wood'):
        return 'door', material, center, width

    def window(center, width=3.6):
        return 'window', 'coated_glass', center, width

    def room(name, x1, y1, x2, y2, finish=teaching):
        surfaces.append(('floor', finish, x1, y1, x2, y2))
        rooms.append((x1 + .6, y1 + 1.25, name))

    def place(kind, x, y, angle=0):
        furniture.append((kind, x, y, angle))

    # Two double-loaded academic wings. Each 9 × 9.5 m classroom has 28
    # seats, a teacher desk, exterior windows, and a door into the 4 m hall.
    wings = [('west', 0, 100), ('east', 47, 200)]
    h('classrooms-north', 0, 0, 83, 'concrete',
      *(window(x + column * 9 + 4.5, 4.4) for _, x, _ in wings for column in range(4)))
    v('classrooms-west', 0, 0, 23, 'concrete', door(11.5, 2.2, 'glass'))
    v('classrooms-east', 83, 0, 23, 'concrete', door(11.5, 2.2, 'glass'))
    for name, start, first in wings:
        left, right = start, start + 36
        entrances = [door(left + column * 9 + 1.05) for column in range(4)]
        h(f'{name}-hall-north', 9.5, left, right, 'drywall', *entrances)
        h(f'{name}-hall-south', 13.5, left, right, 'drywall', *entrances)
        h(f'{name}-classrooms-south', 23, left, right, 'concrete',
          *(window(left + column * 9 + 4.5, 4.4) for column in range(4)))
        room(f'{name.title()} classroom hall', left, 9.5, right, 13.5, circulation)
        for divider in range(1, 4):
            x = left + divider * 9
            v(f'{name}-north-divider-{divider}', x, 0, 9.5, 'drywall')
            v(f'{name}-south-divider-{divider}', x, 13.5, 23, 'drywall')
        for row, top, bottom, facing in [(0, 0, 9.5, 0), (1, 13.5, 23, 180)]:
            for column in range(4):
                x = left + column * 9
                room(f'Classroom {first + row * 4 + column + 1}', x, top, x + 9, bottom,
                     teaching if name == 'west' else academic)
                # The cleared 2.2 m strip next to the classroom entry leads
                # past the seat rows toward the instructional wall.
                for row_index, seats in enumerate((4, 4, 3, 3)):
                    y = top + 3.0 + row_index * 1.38 if facing == 0 else bottom - 3.0 - row_index * 1.38
                    for seat in range(seats):
                        place('student_table', x + 2.92 + seat * 1.58, y, facing)
                place('desk', x + 6.84, top + 1.05 if facing == 0 else bottom - 1.05, facing)
                place('chair', x + 6.84, top + .41 if facing == 0 else bottom - .41, facing + 180 if facing == 0 else 0)

    # Concrete compartment lines have paired fire doors across the main hall.
    v('west-academic-fire-wall', 36, 0, 23, 'concrete', door(11.5, 2.5, 'metal'))
    v('east-academic-fire-wall', 47, 0, 23, 'concrete', door(11.5, 2.5, 'metal'))
    v('central-wc-divider', 41.5, 0, 9.5, 'drywall')
    h('central-wc-entry', 9.5, 36, 47, 'drywall', door(37.45), door(44.45))
    room('Student restrooms A', 36, 0, 41.5, 9.5, wet)
    room('Student restrooms B', 41.5, 0, 47, 9.5, wet)
    room('Academic cross hall', 36, 9.5, 47, 13.5, circulation)
    for side, left in [('a', 36), ('b', 41.5)]:
        front = left + 2.35
        v(f'academic-wc-{side}-stall-doors', front, 2.05, 8.05, 'drywall',
          door(2.75, .75), door(4.1, .75), door(5.4, .75), door(7.22, .95))
        for i, y in enumerate((2.05, 3.45, 4.75, 6.05, 8.05)):
            h(f'academic-wc-{side}-stall-divider-{i}', y, left, front, 'drywall')
        for y in (2.75, 4.1, 5.4, 6.85):
            place('toilet', left + .57, y, 270)
        for y in (3.3, 5.35):
            place('counter', left + 5.1, y, 90)

    h('west-support-entry', 13.5, 36, 39.5, 'drywall', door(37.75))
    h('east-support-entry', 13.5, 43.5, 47, 'drywall', door(45.25))
    v('west-connector-wall', 39.5, 13.5, 23, 'drywall', door(20.1))
    v('east-connector-wall', 43.5, 13.5, 23, 'drywall', door(20.1))
    h('west-support-divider', 18, 36, 39.5, 'drywall')
    h('east-support-divider', 18, 43.5, 47, 'drywall')
    h('west-support-end', 23, 36, 39.5, 'drywall')
    h('east-support-end', 23, 43.5, 47, 'drywall')
    room('West IDF', 36, 13.5, 39.5, 18, support)
    room('East IDF', 43.5, 13.5, 47, 18, support)
    room('Academic storage', 36, 18, 39.5, 23, support)
    room('Academic custodial', 43.5, 18, 47, 23, support)
    h('academic-smoke-partition', 22.5, 39.5, 43.5, 'drywall', door(41.5, 2.4, 'glass'))
    room('Academic connector', 39.5, 13.5, 43.5, 23, circulation)

    # The commons links the academics, cafeteria, controlled entry, and gyms.
    v('commons-west', 31, 23, 58, 'concrete', door(36, 2.6, 'metal'))
    v('commons-east', 74, 23, 58, 'concrete', door(35.6, 2.3, 'metal'), door(53.5, 2.6, 'metal'))
    h('commons-front', 58, 31, 74, 'concrete', window(43.8, 3.4),
      door(53.5, 3.0, 'glass'), window(61.7, 3.7), door(71, 1.8, 'glass'))
    room('Student commons', 31, 23, 74, 39, circulation)
    for x in (48, 54, 60, 66):
        place('table', x, 27.6)
        place('chair', x, 26.75, 180)
        place('chair', x, 28.45)
    for x in (35, 39, 64, 69):
        place('bench', x, 32.5)

    h('admin-north', 39, 31, 49, 'drywall')
    v('admin-lobby-wall', 49, 39, 58, 'drywall', door(46.5), door(52, 1.2, 'glass'))
    h('admin-offices-north', 45, 31, 49, 'drywall', door(34.1), door(38.5), door(44))
    h('admin-offices-south', 48, 31, 49, 'drywall', door(34), door(40), door(45.7))
    v('admin-north-divider-a', 36, 39, 45, 'drywall')
    v('admin-north-divider-b', 41, 39, 45, 'drywall')
    v('admin-south-divider-a', 37, 48, 58, 'drywall')
    v('admin-south-divider-b', 42, 48, 58, 'drywall')
    room('Counseling office', 31, 39, 36, 45, office)
    room('Assistant principal', 36, 39, 41, 45, office)
    room('Conference room', 41, 39, 49, 45, office)
    room('Admin hall', 31, 45, 49, 48, circulation)
    room('Principal office', 31, 48, 37, 58, office)
    room('Registrar', 37, 48, 42, 58, office)
    room('Front office / reception', 42, 48, 49, 58, office)
    for x, y in [(33.2, 41.1), (38.2, 41.1), (34, 51.4), (39.5, 51.6), (45, 53.2)]:
        place('desk', x, y)
        place('chair', x, y - .75, 180)
        place('chair', x, y + .9)
    for x in (43.5, 45.3, 47.1):
        place('table', x, 42)
        place('chair', x, 41.15, 180)
        place('chair', x, 42.85)
    h('secure-vestibule', 54.8, 49, 58, 'glass', door(53.5, 2.4, 'glass'))
    room('Visitor lobby', 49, 39, 58, 54.8, circulation)
    room('Secure vestibule', 49, 54.8, 58, 58, circulation)
    place('bench', 55.7, 51.8, 90)

    h('it-support-top', 39, 58, 74, 'drywall', door(61), door(69.1))
    v('it-support-left', 58, 39, 51, 'drywall', door(47.9))
    v('it-support-divider', 64, 39, 51, 'concrete')
    h('it-support-row-divider', 45, 58, 74, 'drywall')
    h('athletics-concourse-north', 51, 58, 74, 'drywall', door(68.9, 1.2))
    room('Main IT / network room', 58, 39, 64, 45, support)
    room('School storage', 64, 39, 74, 45, support)
    room('Facilities office', 58, 45, 64, 51, office)
    room('Main custodial', 64, 45, 74, 51, support)
    room('Athletics concourse', 58, 51, 74, 58, circulation)
    place('desk', 61, 49)
    place('chair', 61, 48.2, 180)

    # Food service has a separate loading door and a dining terrace.
    h('cafeteria-north', 31, 0, 31, 'concrete', window(14, 5), window(23, 5), door(28.8, 2.0, 'glass'))
    h('cafeteria-south', 55, 0, 31, 'concrete', door(12.2, 2.4, 'glass'), door(25, 2.4, 'glass'))
    v('cafeteria-west', 0, 31, 55, 'concrete', door(34, 1.8, 'metal'), door(50.5, 1.1, 'metal'))
    v('kitchen-service-divider', 8, 31, 55, 'drywall', door(37.3, 2.3, 'none'), door(44.7, 1.3, 'none'), door(51.6))
    h('kitchen-stores', 48, 0, 8, 'drywall', door(3.9))
    room('Kitchen / food service', 0, 31, 8, 48, support)
    room('Dry storage / receiving', 0, 48, 8, 55, support)
    room('Cafeteria', 8, 31, 31, 55, '#f1e3cc')
    for x in (11.8, 16.4, 21, 25.6):
        for y in (36.8, 40.6, 44.4, 48.2, 52.0):
            place('cafeteria_table', x, y)
    for x in (1.5, 3.4, 5.3):
        place('counter', x, 33.4)
        place('counter', x, 45.7)

    # Each gym can be reached from the concourse without crossing a court.
    h('gyms-north', 27, 74, 140, 'concrete',
      window(82, 5), door(96, 2.2, 'metal'), window(119, 5), door(131, 2.2, 'metal'))
    v('gyms-east', 140, 27, 64, 'concrete', door(53.5, 2.6, 'glass'))
    v('gym-fire-divider', 108, 27, 51, 'concrete')
    h('gym-corridor-north', 51, 74, 140, 'concrete',
      door(82, 2.4, 'metal'), door(101, 2.4, 'metal'), door(116, 2.4, 'metal'), door(132, 2.4, 'metal'))
    h('gym-corridor-south', 56, 74, 140, 'drywall',
      *(door(x, 1.1) for x in (77, 87, 98, 107.5, 113.5, 120, 129, 136)))
    h('athletics-south', 64, 74, 140, 'concrete', door(123, 1.6, 'metal'), door(137, 1.8, 'metal'))
    v('athletics-west-return', 74, 58, 64, 'concrete')
    room('Main gym', 74, 27, 108, 51, '#ead7b7')
    room('Auxiliary gym', 108, 27, 140, 51, '#ead7b7')
    room('Gym corridor', 74, 51, 140, 56, circulation)
    for center in (91, 124):
        place('basketball_court', center, 38.6)
        for x in range(center - 10, center + 11, 4):
            place('bench', x, 47.8)
            place('bench', x, 48.95)
    gym_support = [
        ('Athletics IDF', 74, 81), ('Locker room A', 81, 94), ('Locker room B', 94, 105),
        ('Public WC A', 105, 111), ('Public WC B', 111, 117), ('Athletics storage', 117, 125),
        ('PE offices', 125, 133), ('Gym custodial', 133, 140),
    ]
    for i, (name, left, right) in enumerate(gym_support):
        if i:
            v(f'gym-support-divider-{i}', left, 56, 64, 'drywall')
        room(name, left, 56, right, 64, wet if i in (1, 2, 3, 4) else support)
    for x in (85, 89, 98, 102):
        place('bench', x, 60.2)
    for side, left in [('a', 105), ('b', 111)]:
        h(f'athletics-wc-{side}-stall-doors', 61, left, left + 6, 'drywall',
          door(left + .84, .75), door(left + 2.55, .75), door(left + 4.6, .95))
        for i, x in enumerate((left + 1.7, left + 3.4)):
            v(f'athletics-wc-{side}-stall-divider-{i}', x, 61, 64, 'drywall')
        for x in (left + .84, left + 2.55, left + 4.6):
            place('toilet', x, 63.56, 180)
        place('counter', left + 4.9, 58.65, 90)
    place('desk', 130.2, 62)

    # A detached shop building keeps noisy and service areas away from teaching.
    h('shops-north', -12, 102, 133, 'concrete', door(105, 3.4, 'metal'), door(129.5, 3.5, 'metal'))
    h('shops-south', 11, 102, 133, 'concrete', window(122.5, 4), door(131, 1.5, 'metal'))
    v('shops-west', 102, -12, 11, 'concrete', door(4, 2.0, 'glass'))
    v('shops-east', 133, -12, 11, 'concrete', door(4, 1.8, 'metal'))
    v('shop-fire-divider', 116, -12, 2, 'concrete')
    h('shops-corridor-north', 2, 102, 133, 'concrete', door(113, 1.6, 'metal'), door(119, 1.6, 'metal'))
    h('shops-corridor-south', 6, 102, 133, 'drywall',
      *(door(x) for x in (105, 110, 113.1, 115.9, 118.5, 128.5)))
    room('Metal shop', 102, -12, 116, 2, support)
    room('Wood shop', 116, -12, 133, 2, support)
    room('Shop corridor', 102, 2, 133, 6, circulation)
    shops = [('Tool storage', 102, 108), ('Shop IDF', 108, 112), ('Shop restrooms', 112, 117),
             ('Project design', 117, 126), ('Materials store', 126, 133)]
    for i, (name, left, right) in enumerate(shops):
        if i:
            v(f'shop-support-divider-{i}', left, 6, 11, 'drywall')
        room(name, left, 6, right, 11, wet if i == 2 else academic)
    for x in (106, 111, 121, 127):
        for y in (-7, -3, 0):
            place('table', x, y)
            place('bench', x, y + .8)
    for x in (119.1, 121.65, 124.2):
        place('student_table', x, 8.55)
    v('shops-wc-divider', 114.5, 6, 11, 'drywall')
    place('toilet', 113, 10.55, 180)
    place('toilet', 115.65, 10.55, 180)

    # Sidewalks and loading areas remain separate from both pickup queues.
    surfaces.extend([
        ('landscape', '#dce9d4', -7, 23, 31, 31),
        ('sidewalk', '#e3e0d8', 26.8, 23, 31, 31),
        ('sidewalk', '#e3e0d8', 83, 9.8, 102, 13.1),
        ('sidewalk', '#e3e0d8', 98.6, 3, 102, 12.5),
        ('landscape', '#dee9d1', 85, 14, 101, 25),
        ('sidewalk', '#e3e0d8', 87, 13.1, 90, 16),
        ('landscape', '#dae8d5', 108, 14, 140, 25),
        ('sidewalk', '#e3e0d8', 84, 23.9, 140, 27),
        ('pavement', '#c9cfd2', 101, -18, 138, -12),
        ('pavement', '#c9cfd2', -7, 31, 0, 51),
        ('sidewalk', '#e0d4bf', 1, 55, 30, 64),
        ('sidewalk', '#e4e0d6', 32, 58, 83, 69),
        ('pavement', '#aebcc3', -5, 69, 84, 83),
        ('sidewalk', '#e3e0d8', 84, 66, 147, 69),
        ('sidewalk', '#e3e0d8', 140, 51.9, 147, 56.1),
        ('sidewalk', '#e3e0d8', 143.8, 27, 147, 69),
        ('pavement', '#b0bdc3', 147, 25, 161, 83),
        ('pavement', '#b0bdc3', 108, 73, 147, 83),
    ])
    rooms.extend([
        (6, 26, 'Learning courtyard'), (88, 15.9, 'Outdoor classrooms'), (114, 16.4, 'PE practice lawn'),
        (108, -16, 'Shop delivery apron'), (3, 58, 'Cafeteria terrace'),
        (46, 61, 'Main entrance plaza'), (42, 70.8, 'Car rider pickup'), (6, 75, 'Visitor parking'),
        (147.6, 28, 'Bus rider pickup'), (-6.8, 39, 'Kitchen loading'),
    ])
    for x, y in [(3, 28.4), (26, 28.9), (87, 20.7), (99, 19.9), (134.5, 20),
                 (37, 62.2), (77, 63.2), (3, 65.7), (28, 65.7), (143, 34)]:
        place('tree', x, y)
    for x in (6, 12, 18, 24):
        place('cafeteria_table', x, 61.1)
    for x in (7, 12, 17, 22):
        place('parking_bay', x, 72)
    place('car', 7, 72, 0)
    place('car', 17, 72, 0)
    for x in (45, 51, 57, 63, 69, 75):
        place('car', x, 73.8, 270)
    for y in (36.3, 51.3, 66.3):
        place('bus', 150.25, y, 0)
    return _starter('Alder Ridge High School', walls, rooms, furniture, surfaces)


SCENARIOS = {
    'port-adelaide-community-center': {
        'id': 'port-adelaide-community-center',
        'title': 'Port Adelaide Community Center',
        'description': 'Design the network for a concrete civic building that hosts public events and elections.',
        'briefing': 'The City of Port Adelaide is renovating a 1950s reinforced concrete community center into a '
                    'modern civic hub. It must support large public events, elections, and daily community use '
                    'with reliable, high-speed connectivity.',
        'traits': ['Renovation of a 1950s Cold War era concrete building',
                   'Limited pathways between rooms; drop ceilings in most areas',
                   'Public and administrative Wi-Fi expected',
                   'Security and event reliability critical'],
        'plan_note': 'Adapted from the Lefevre Community Stadium floor plan and scaled from its 38.3 m gym wall. '
                     'Service rooms, parking, landscaping, and wall materials are modeled for this exercise.',
        'site': _community_center(),
    },
    'juniper-main-coffee': {
        'id': 'juniper-main-coffee',
        'title': 'Juniper & Main Coffee',
        'description': 'Design wired service, guest Wi-Fi, and PoE for a busy café with a sidewalk patio.',
        'briefing': 'Juniper & Main is opening in a brick storefront beside a bus stop. The morning line forms '
                    'at the front counter while regulars work inside and on the patio. The owner needs wired '
                    'checkout, an office phone, and camera coverage of the public entrance and delivery lane. '
                    'The network shelf and ISP handoff will sit in the back office.',
        'traits': ['Keep checkout and office traffic separate from guest Wi-Fi.',
                   'Check signal at the far patio tables with the glass door closed.',
                   'Plan PoE capacity and aim cameras away from the restroom.'],
        'plan_note': 'The furnished floor plan has no network equipment. The staff opening behind the counter '
                     'has no door material. The public entrance and patio door are glass.',
        'site': _coffee_shop(),
    },
    'maple-lane-house': {
        'id': 'maple-lane-house',
        'title': 'Maple Lane House',
        'description': 'Plan a home network for three bedrooms, a garage, and a side deck.',
        'briefing': 'A family in a single-story home wants reliable video calls from the desk in bedroom 2, '
                    'streaming in the living room, and coverage on the side deck. The ISP enters in the laundry '
                    'and mudroom. Plan wired drops for fixed equipment and a ceiling-mounted PoE camera '
                    'covering the garage entrance from inside.',
        'traits': ['Compare signal on both bands in the bedrooms, in the garage, and on the deck.',
                   'Use the central hall and open living area when comparing AP locations.',
                   'Check how brick, glass, and the garage door affect coverage.'],
        'plan_note': 'The garage is 6.5 × 6.6 m with a 5 m overhead door aligned to the driveway. '
                     'The laundry and mudroom connect the garage directly to the bedroom hall.',
        'site': _three_bedroom_house(),
    },
    'alder-ridge-high-school': {
        'id': 'alder-ridge-high-school',
        'title': 'Alder Ridge High School',
        'description': 'Design a campus network for a modern one-story high school with 16 classrooms and a detached trades building.',
        'briefing': 'Alder Ridge is moving into a new suburban campus. On a regular day, four hundred students move '
                    'between the two classroom wings, the commons, the cafeteria, and the trades building. During '
                    'tournaments the gyms and bus-side entrance stay open after the academic wing closes. The ISP '
                    'handoff is planned for the main IT room. The school needs wired teaching and office drops, '
                    'managed Wi-Fi indoors and in the outdoor classrooms, and a link to the detached shops.',
        'traits': ['Use the west, east, athletics, and shop IDFs to plan cable lengths and backbone paths.',
                   'Plan separate school and visitor Wi-Fi. Check the gym, cafeteria, and bus-side waiting area at event capacity.',
                   'Account for concrete fire barriers, smoke-control doors, and the outdoor span to the shops.',
                   'Keep reception and operations traffic separate from guests, and plan PoE camera views for entrances and pickup areas.'],
        'plan_note': 'The main building is 140 m across. Classrooms measure 9 × 9.5 m, both gyms have 28 × 15 m courts, '
                     'and the detached 31 × 23 m shop building has its own IDF. Furniture and fixtures are shown. '
                     'Network rooms and closets are empty for your design.',
        'site': _high_school(),
    },
}


def scenario_summary(scenario):
    return {key: scenario[key] for key in ('id', 'title', 'description')}


def scenario_briefing(scenario):
    return {key: scenario[key] for key in ('id', 'title', 'briefing', 'traits', 'plan_note')}
