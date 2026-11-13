"""Validate the visual layers of an Infra Sim floor plan."""

import re


DECOR_TYPES = {'tree', 'desk', 'chair', 'table', 'bench', 'car', 'bed', 'lamp', 'parking_bay'}
DESIGN_LIMITS = {'decor': 500, 'surfaces': 160, 'surface_vertices': 1600}
_COLOR = re.compile(r'#[0-9a-fA-F]{6}\Z')


def color(value):
    if not isinstance(value, str) or not _COLOR.fullmatch(value):
        raise ValueError('Choose a valid surface color')
    return value.lower()


def validate_design(raw, *, seen, number, point, safe_id):
    def objects(kind):
        items = raw.get(kind, [])
        if not isinstance(items, list) or len(items) > DESIGN_LIMITS[kind]:
            raise ValueError(f'Too many {kind} objects')
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str):
                raise ValueError('Invalid design object')
            object_id = safe_id(item['id'])
            if object_id in seen:
                raise ValueError('Floor plan object IDs must be unique')
            seen.add(object_id)
            yield object_id, item

    decor = []
    for object_id, item in objects('decor'):
        kind = item.get('kind')
        if not isinstance(kind, str) or kind not in DECOR_TYPES:
            raise ValueError('Unknown plan symbol')
        decor.append({'id': object_id, **point(item), 'kind': kind,
                      'angle': number(item.get('angle', 0), 0, 360, 'symbol rotation') % 360})

    vertices = 0

    def ring(value):
        nonlocal vertices
        if not isinstance(value, list) or not 3 <= len(value) <= 320:
            raise ValueError('A surface boundary needs 3 to 320 corners')
        vertices += len(value)
        if vertices > DESIGN_LIMITS['surface_vertices']:
            raise ValueError('Too many surface corners')
        points = [point(entry) for entry in value]
        if len({(p['x'], p['y']) for p in points}) != len(points):
            raise ValueError('Surface corners must be distinct')
        x, y = points[0]['x'], points[0]['y']
        area = sum((a['x'] - x) * (b['y'] - y) - (a['y'] - y) * (b['x'] - x)
                   for a, b in zip(points, points[1:] + points[:1]))
        if abs(area) < 0.01:
            raise ValueError('Choose a surface with a measurable area')
        return points

    surfaces = []
    for object_id, item in objects('surfaces'):
        kind = item.get('kind')
        if kind not in ('floor', 'sidewalk', 'pavement', 'landscape'):
            raise ValueError('Unknown surface type')
        holes = item.get('holes', [])
        if not isinstance(holes, list) or len(holes) > 40:
            raise ValueError('Too many interior boundaries')
        surfaces.append({'id': object_id, 'kind': kind, 'color': color(item.get('color')),
                         'points': ring(item.get('points')), 'holes': [ring(hole) for hole in holes]})
    background = raw.get('background_color')
    return {'decor': decor, 'surfaces': surfaces, 'background_color': color(background) if background is not None else None}
