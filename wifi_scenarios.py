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
    wall('activity-split', activity_split, (1449, 1132), doors=[(1290, 1360, 'wood')], material='drywall')

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
}


def scenario_summary(scenario):
    return {key: scenario[key] for key in ('id', 'title', 'description')}


def scenario_briefing(scenario):
    return {key: scenario[key] for key in ('id', 'title', 'briefing', 'traits', 'plan_note')}
