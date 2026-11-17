"""Built-in Infra Sim challenges and their editable starter plans."""

import math

from network_store import WIFI_SCHEMA_VERSION, validate_wifi_site
from wifi_hospital import hospital_layout
from wifi_industrial import industrial_layout
from wifi_motel import motel_layout
from wifi_office_park import OFFICE_PARK_TITLE, office_park_layout
from wifi_school import school_layout
from wifi_small_sites import clinic_layout, highrise_suite_layout, modern_house_layout
from wifi_stadium import stadium_layout


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
    surface('gym-floor', 'floor', '#eadcc4', [north_west, north_east, (1485, 365), (1517, 362),
            (1558, 811), (1524, 814), (1540, 968), (1177, 1000), (1060, 1011), (805, 1034),
            (694, 1043), small_store_corner, (660, 667)])
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
    symbol('basketball_court', (1080, 584), 355)
    for y in (481, 542, 603, 664, 725, 786):
        symbol('bench', (1488, y), 85)
    symbol('desk', (1208, 1026))
    symbol('chair', (1208, 1044))
    for p in ((988, 1185), (1319, 1045), (1372, 1045), (1318, 1178), (1370, 1178), (1599, 1155), (1676, 1155)):
        symbol('table', p)
        symbol('chair', (p[0], p[1] - 19), 180)
        symbol('chair', (p[0], p[1] + 19))

    return validate_wifi_site({'schema_version': WIFI_SCHEMA_VERSION, 'title': 'Port Adelaide Community Center',
                               'units': 'm', 'band': '5', 'walls': walls, 'openings': openings, 'labels': labels,
                               'floor_locked': True, 'access_points': [], 'decor': decor, 'surfaces': surfaces})


def _starter(title, walls, rooms, furniture, surfaces=(), equipment=()):
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

    def outline(bounds):
        if len(bounds) == 1:
            return bounds[0]
        x1, y1, x2, y2 = bounds
        return ((x1, y1), (x2, y1), (x2, y2), (x1, y2))

    return validate_wifi_site({
        'schema_version': WIFI_SCHEMA_VERSION, 'title': title, 'units': 'm', 'band': '5',
        'floor_locked': True, 'walls': segments, 'openings': openings, 'access_points': [],
        'equipment': list(equipment),
        'labels': [{'id': f'room-{i}', **point(x, y), 'text': text}
                   for i, (x, y, text) in enumerate(rooms)],
        'decor': [{'id': f'fixture-{i}', **point(x, y), 'kind': kind, 'angle': angle}
                  for i, (kind, x, y, angle) in enumerate(furniture)],
        'surfaces': [{'id': f'finish-{i}', 'kind': kind, 'color': color,
                      'points': [point(x, y) for x, y in outline(bounds)]}
                     for i, (kind, color, *bounds) in enumerate(surfaces)],
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
    seating = [(10.7, 8.5), (13, 8.5),
               (17, 7.5), (19.5, 7.5), (17, 10), (19.5, 10)]
    furniture = [('counter', 2, 5.6, 0), ('counter', 3.82, 5.6, 0), ('counter', 5.64, 5.6, 0),
                 ('desk', 9.5, 2.3, 0), ('bench', 1.4, 2.1, 0), ('bench', 12.8, 6.9, 0),
                 ('tree', 21.2, 10, 0), ('tree', 20.7, 4.3, 0), ('lamp', 15.7, 11.7, 0),
                 ('cafeteria_table', 3.7, 8.8, 0), ('counter', 1.45, .46, 0),
                 ('counter', 3.27, .46, 0), ('counter', 4.44, 2, 90)]
    for x, y in seating:
        furniture.extend([('table', x, y, 0), ('chair', x, y - .8, 180), ('chair', x, y + .8, 0)])
    surfaces = [
        ('floor', '#eee3d1', 0, 4, 15, 11), ('floor', '#e9d4bb', 0, 4, 7.5, 6.3),
        ('floor', '#dbe3df', 0, 0, 7.5, 4), ('floor', '#dbe6ed', 7.5, 0, 10.9, 4),
        ('floor', '#e3e5ee', 10.9, 0, 15, 4), ('pavement', '#e4d9c9', 15, 5, 21, 11.8),
        ('sidewalk', '#e5e7e9', -1, 11, 21, 13.5), ('pavement', '#d6dce1', -1, -2, 15, 0),
        ('sidewalk', '#e5e7e9', 15, 7.35, 16.45, 9.9), ('landscape', '#d4e2c6', 19.2, 3.25, 22.6, 5.6),
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
        ('counter', 13.45, 7.02, 0), ('counter', 15.35, 7.02, 0), ('counter', 17.25, 7.02, 0),
        ('car', 13.94, 10.03, 0), ('bench', -3.55, 10.95, 0),
        ('table', -2.4, 9.28, 0), ('chair', -2.95, 8.48, 180), ('chair', -1.85, 8.48, 180),
        ('chair', -2.95, 10.08, 0), ('chair', -1.85, 10.08, 0),
        ('tree', -3.4, 3.9, 0), ('tree', 2.5, 15.9, 0), ('lamp', 8.17, 13.7, 0),
    ]
    surfaces = [
        ('landscape', '#dce9d5', -5.8, -3.5, 0, 18), ('landscape', '#dce9d5', 0, 13.2, 19.5, 18),
        ('sidewalk', '#dfc9ad', -4.5, 7.32, 0, 11.5),
        ('sidewalk', '#e4ddd2', 8.05, 13.2, 11.46, 14.86), ('sidewalk', '#e4ddd2', 9.02, 14.86, 10.4, 18),
        ('pavement', '#cfd6db', 12.15, 13.2, 18.35, 18),
        ('floor', '#ebe4d9', 0, 0, 4.5, 4.8), ('floor', '#e6e8e2', 4.5, 0, 8.1, 4.8),
        ('floor', '#e4e8ec', 8.1, 0, 12, 4.8), ('floor', '#dbe7ec', 0, 2.55, 2.4, 4.8),
        ('floor', '#e9dbc7', 0, 4.8, 12, 6.4), ('floor', '#eee4d6', 0, 6.4, 12, 13.2),
        ('floor', '#dbe7ec', 7.25, 6.4, 9.5, 9.15), ('floor', '#dae3e7', 9.5, 6.4, 12, 9.15),
        ('floor', '#d9dadd', 12, 6.6, 18.5, 13.2),
        ('floor', '#c4cacf', 12.06, 6.65, 18.44, 7.75),
    ]
    return _starter('Maple Lane House', walls, rooms, furniture, surfaces)


# Catalog order progresses from homes and small venues to complex campuses.
SCENARIOS = {
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
    'willow-creek-family-medicine': {
        'id': 'willow-creek-family-medicine',
        'title': 'Willow Creek Family Medicine',
        'description': 'Build a small network for one doctor, exam rooms, reception, and patient waiting.',
        'briefing': 'One doctor, a medical assistant, and a receptionist share this neighborhood practice. '
                    'Patients check in at the front desk, then move down the short clinical corridor to an exam '
                    'room. Staff need a dependable connection for the appointment desk and exam-room computers. '
                    'The practice also wants a separate Wi-Fi network for visitors.',
        'traits': [
            'Choose a location for the router or network closet near staff space and plan wired drops to reception and the exam rooms.',
            'Keep patient Wi-Fi separate from staff devices and test that it cannot reach the practice computers.',
            'Check signal in the waiting room, consultation room, and treatment room with the doors closed.',
        ],
        'plan_note': 'This furnished 20 × 13 m, single-doctor clinic opens with its floor plan locked and no network devices installed.',
        'site': _starter('Willow Creek Family Medicine', *clinic_layout()),
    },
    'cedar-court-smart-home': {
        'id': 'cedar-court-smart-home',
        'title': 'Cedar Court Smart Home',
        'description': 'Bring a four-bedroom home, media setup, and detached garage onto a home network.',
        'briefing': 'A family has moved into a modern single-story house with an office, game room, and detached '
                    'two-car garage. They have placed TVs, a game console, speakers, light switches, two '
                    'desktops, phones, and PoE cameras. Work calls must stay reliable while the household streams '
                    'video, and the garage lights and driveway camera need a dependable connection.',
        'traits': [
            'Choose a provider handoff and a router location. Try the Residential Router with an Ethernet WAN handoff and compare its 100 Mb/s links with your coverage needs.',
            'Decide whether to cable the TVs and console or associate them with Wi-Fi. Join the speakers, phones, and wall switches to the SSID.',
            'Plan PoE for the front and garage cameras. Check the path to the garage and compare signal inside the garage with the patio and game room.',
            'Verify the office desktop can reach the Internet and test an IP firewall rule for a device that should stay local.',
        ],
        'plan_note': 'This four-bedroom plan includes a home office, a game room, and an 8 × 8.5 m detached garage. '
                     'Clients and cameras are placed. The locked starter has no router, switches, access points, or cabling.',
        'site': _starter('Cedar Court Smart Home', *modern_house_layout()),
    },
    'lakeview-advisory-floor-12': {
        'id': 'lakeview-advisory-floor-12',
        'title': 'Lakeview Advisory · Floor 12',
        'description': 'Fit out a small firm’s new office suite on the twelfth floor of a high-rise.',
        'briefing': 'Lakeview Advisory has leased the south wing of floor twelve for its new office. Clients '
                    'arrive by elevator and check in at reception. Twelve private offices line the perimeter, '
                    'and staff share a meeting room and break room. The building operator provides a riser '
                    'handoff in the IT closet and manages the elevators and stairs.',
        'traits': [
            'Use the IT and riser closet for the handoff and plan wired drops to the twelve offices, meeting room, and reception.',
            'Offer visitor Wi-Fi in reception and the meeting room and keep it separate from staff devices.',
            'Compare signal near the reinforced stair and elevator core with signal in the perimeter offices. Keep tenant cable routes inside the suite.',
        ],
        'plan_note': 'This plan represents one level of the tower only. It includes the shared elevator lobby, '
                     'stair landing, and restrooms. The furnished suite opens locked with an empty IT closet.',
        'site': _starter('Lakeview Advisory · Floor 12', *highrise_suite_layout()),
    },
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
    'suntrail-motor-lodge': {
        'id': 'suntrail-motor-lodge',
        'title': 'Suntrail Motor Lodge',
        'description': 'Retrofit a roadside motel with courtyard-facing rooms, an enclosed guest wing, and a breakfast room.',
        'briefing': 'Suntrail is a single-story motor lodge built around drive-up parking and a small outdoor pool. '
                    'The original brick rooms open directly onto the courtyard walks. A later addition added twelve rooms '
                    'along an interior hall connected to reception. The owners are renovating in phases and want to keep '
                    'the front desk and as many rooms open as possible. They have set a VoIP phone on every guest-room desk '
                    'and a payment terminal at reception. Your job is to design the network that will put them into service.',
        'traits': [
            'Plan the provider entry and switching in the comms closet behind reception. Route power and data to the room '
            'phones and connect the front-desk POS.',
            'Compare a route along the covered courtyard walks with the interior hallway route in the addition. '
            'Plan how each room bank can be brought online in phases.',
            'Separate guest Wi-Fi, room voice, and reception payment traffic. Verify that each can reach the services it needs.',
            'Check Wi-Fi inside closed guest rooms, along the exterior walks, in the breakfast dining room, and on the pool deck.',
        ],
        'plan_note': 'The plan has 43 furnished guestrooms, including single-bed rooms and two-bed suites. '
                     'It starts locked with only the room phones and reception POS placed. The comms closet is empty '
                     'and all links are for you to design.',
        'site': _starter('Suntrail Motor Lodge', *motel_layout()),
    },
    'alder-ridge-high-school': {
        'id': 'alder-ridge-high-school',
        'title': 'Alder Ridge High School',
        'description': 'Plan a network across a courtyard high school with two academic wings, two gyms, and a detached trades building.',
        'briefing': 'Alder Ridge serves four hundred students in two academic wings around a learning courtyard. '
                    'The glazed commons connects the wings to lunch service and the athletic concourse. On tournament '
                    'nights, visitors enter from the main plaza or bus-side doors while the academic doors stay closed. '
                    'The ISP enters at the main IT room near operations. The school needs wired teaching and office '
                    'drops, managed student and visitor Wi-Fi, and a backbone link to the detached trades building.',
        'traits': ['Plan backbone routes from the main IT room to the West, East, Athletics, and Shop IDFs.',
                   'Plan coverage in the learning courtyard, outdoor classrooms, dining terrace, and covered bus waiting area.',
                   'Check whether concrete, smoke-door crossings, and the outdoor span to the shops change your routing choices.',
                   'Keep reception and school operations separate from visitors. Check what remains online during after-hours events.'],
        'plan_note': 'The one-story main building is 155 m across. The 16 classrooms are 9 × 9.5 m, both gyms '
                     'contain 28 × 15 m courts, and the detached trades building is 40 × 28 m. '
                     'Furniture, trades fixtures, and landscape features are shown. All network rooms and closets are empty.',
        'site': _starter('Alder Ridge High School', *school_layout()),
    },
    'rivermill-fabrication-works': {
        'id': 'rivermill-fabrication-works',
        'title': 'Rivermill Fabrication Works',
        'description': 'Design a network for a two-shift machine and fabrication plant, a fleet garage, and a training center.',
        'briefing': 'Rivermill makes pump frames and industrial skids to order. Steel arrives at the north receiving docks '
                    'and is staged in the materials warehouse or outdoor stockyard. Forklifts carry cut stock through the '
                    'central aisle to welding and CNC machining. Parts meet at assembly, pass inspection, and leave from '
                    'the shipping docks. The detached fleet garage services the yard equipment. The training center '
                    'runs apprenticeships and vendor courses from its own pedestrian entrance. The ISP enters at the main IT room.',
        'traits': [
            'Plan wired connections for office staff, CNC job terminals, assembly stations, and dock scanners.',
            'Draw backbone paths from the main IT room to the Warehouse, Production, and Assembly IDFs. '
            'Choose links to the detached Fleet and Training IDFs and document each building entry.',
            'Keep production traffic separate from business services and training guests. Verify that each group can reach '
            'the services it needs and that training guests cannot reach shop equipment.',
            'Check Wi-Fi in rack aisles, loading lanes, and the outdoor yard and service pad. Compare coverage '
            'on both sides of the concrete partitions and metal roll-up doors.',
        ],
        'plan_note': 'The single-story plant measures 168 × 92 m. Six receiving bays and seven shipping bays '
                     'face the north truck apron. The garage and training center have separate routes from the plant. '
                     'Machinery and vehicles are shown as floor-plan symbols. Network rooms start empty and '
                     'the floor plan starts locked for network layout.',
        'site': _starter('Rivermill Fabrication Works', *industrial_layout()),
    },
    'harborline-stadium': {
        'id': 'harborline-stadium',
        'title': 'Harborline Stadium & Sports Center',
        'description': 'Plan matchday and everyday networks for an indoor football stadium, an attached sports center, and their outdoor plazas.',
        'briefing': 'Harborline hosts football and community events in a concrete bowl with seating on every side. '
                    'On match days, visitors arrive at the plaza and pass through screening before entering a continuous '
                    'concourse. The press and announcer rooms overlook the field. The sports center opens daily for '
                    'basketball, indoor tennis, fitness, lessons, and swimming. Its street entrance stays open when the '
                    'fire doors to the stadium are closed. Delivery and team vehicles arrive through the service lanes.',
        'traits': [
            'Plan wired service for ticketing, concessions, broadcast, and facility operations. Keep public traffic separate.',
            'Route from the main IT room to the West, North, East, and Sports center IDFs. Account for concrete barriers, '
            'the length of the concourse, and the closed link between venues.',
            'Check Wi-Fi at the four seating sides, concessions, entrance queues, the pool deck, and the outdoor fan park.',
            'Keep the north mechanical plant and the pool filtration and dehumidification rooms accessible from their service routes.',
        ],
        'plan_note': 'The starter is drawn in meters on one plan level. It includes the playing field, raked seating '
                     'sections, sports courts, and a 25 m lap pool. Network closets are empty. The floor plan '
                     'starts locked for network layout and can be unlocked from the toolbar.',
        'site': _starter('Harborline Stadium & Sports Center', *stadium_layout()),
    },
    'briar-glen-insurance-campus': {
        'id': 'briar-glen-insurance-campus',
        'title': OFFICE_PARK_TITLE,
        'description': 'Design a campus network for four insurance offices, a data center, an event venue, and a gated entrance.',
        'briefing': 'Briar Glen Mutual is bringing claims, technology, training, and underwriting together on one '
                    'campus. Staff come in from the south lot, while visitors check in at the guardhouse and '
                    'continue to reception or the event ballroom. The Technology Center houses a twelve-rack '
                    'data center. Facilities staff reach the detached mechanical plant from a service drive north '
                    'of the park. The network must support confidential claims work, a busy annual meeting, '
                    'building operations, and a staffed gate.',
        'traits': [
            'Design a fiber backbone from the Technology Center to the other office buildings, the guardhouse, '
            'and the mechanical plant. Mark entries and routes, and check the 90 m copper limit for local drops.',
            'Connect the preinstalled servers through their patch panels and switches. Leave room for expansion '
            'and check the resulting load against each rack’s UPS capacity.',
            'Separate claims and underwriting, servers, event guests, gate security, and building controls. '
            'Check that the guard desktop can reach both cameras while event guests cannot.',
            'Survey office cubicles, the ballroom, and the park paths. Compare coverage during an event with normal office use.',
        ],
        'plan_note': 'One level, drawn in meters. The office buildings span just over 300 m east to west. '
                     'The data center starts with twelve 16U racks, four servers, one top patch panel, '
                     'and two UPS units in each. The guardhouse starts with two PoE cameras and a desktop. '
                     'The floor plan is locked and all cabling and switching are yours to design.',
        'site': _starter(OFFICE_PARK_TITLE, *office_park_layout()),
    },
    'marshpoint-regional-hospital': {
        'id': 'marshpoint-regional-hospital',
        'title': 'Marshpoint Regional Hospital',
        'description': 'Design a resilient network for a regional hospital and its disaster triage and command operations.',
        'briefing': 'Marshpoint serves a coastal region from a single-story hospital. Ambulance crews bring patients '
                    'to the emergency and trauma department, and a separate paved path links the ground helipad to the '
                    'clinical transfer corridor. County emergency partners use the hospital’s command center during '
                    'hurricanes, pandemics, and mass-casualty incidents, including terrorist attacks. The west surge '
                    'intake can open while routine emergency, surgical, and inpatient care continues. An on-site '
                    'diesel plant supports the hospital during utility outages.',
        'traits': [
            'Plan network links from the main IT room to the ED, surgery, acute ward, family care, and command closets. '
            'Give emergency departments and command a second route that avoids the same corridor crossing.',
            'Keep clinical systems, incident coordination, facilities monitoring, and public Wi-Fi on separate networks. '
            'Document which network equipment and services need emergency power.',
            'Verify reachability for ordinary care and a regional surge. Simulate the loss of one backbone link '
            'and record which care and command services remain reachable.',
            'Check Wi-Fi along the ambulance handover and helipad transfer routes, at covered surge intake, '
            'and across the public concourse and family courtyard.',
        ],
        'plan_note': 'The single-story hospital measures 196 × 126 m. The ground helipad sits west of the building '
                     'and the four-generator diesel plant is in the east service zone. The floor plan starts locked '
                     'with empty network rooms so you can begin placing infrastructure.',
        'site': _starter('Marshpoint Regional Hospital', *hospital_layout()),
    },
}


def scenario_summary(scenario):
    return {key: scenario[key] for key in ('id', 'title', 'description')}


def scenario_briefing(scenario):
    return {key: scenario[key] for key in ('id', 'title', 'briefing', 'traits', 'plan_note')}
