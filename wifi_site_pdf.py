"""Compose vector-labeled Infra Sim diagrams and paginated print schedules."""

from __future__ import annotations

import base64
import binascii
import io
import math
import re
import threading
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from PIL import Image
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

from wifi_cabling import COST_ITEMS, EQUIPMENT, MAX_RACKS, RACK_UNITS, _ports


MAX_EXPORT_BYTES = 6_500_000
_IMAGE_BYTES = 2_500_000
_FONT_LOCK = threading.Lock()
_FONT, _BOLD = 'InfraPlan', 'InfraPlanBold'
_INK, _MUTED, _RULE, _WASH = map(HexColor, ('#182d3e', '#425b6c', '#bac8cd', '#f1f5f6'))
_NETWORK, _AP, _CAMERA = map(HexColor, ('#145370', '#146d67', '#28578e'))
_MARGIN = 23
_TABLOID = (1224, 792)
_SCHEDULE_TITLE = 'Cable schedule and device inventory'
_SCHEDULE_GAP = 24
_CABLE_COLUMNS = (134, 160, 160, 61, 62)
_DEVICE_COLUMNS = (190, 115, 272)
_RACK_COLUMN = 208
_RACK_COLUMN_GAP = 12
_RACK_ROW = 11
_RACK_COLUMN_HEADER = 23
_SHEETS = ('Network layout', 'Wi-Fi coverage', 'Camera coverage')
_GLYPHS = {
    'router': 'R', 'core_switch': 'S', 'distribution_switch': 'S', 'access_switch': 'S', 'keystone': 'J',
    'demarc': 'I', 'desktop': 'D', 'phone': 'M', 'voip_phone': 'V', 'pos_terminal': '$',
    'poe_camera': 'C', 'copy_machine': 'P', 'pass_through': 'T', 'access_point': 'A',
    'rack': 'E', 'patch_panel': 'P', 'server': 'H', 'ups': 'U',
}
_DEVICE_TYPES = {
    'router': 'Router', 'core_switch': 'Core switch', 'distribution_switch': 'Distribution switch',
    'access_switch': 'Access switch', 'keystone': 'Keystone jack', 'demarc': 'ISP handoff',
    'desktop': 'Desktop computer', 'phone': 'Wireless phone', 'voip_phone': 'VoIP phone',
    'pos_terminal': 'POS terminal', 'poe_camera': 'PoE camera', 'copy_machine': 'Copy machine',
    'pass_through': 'Concrete pass-through', 'access_point': 'Access point',
    'rack': 'Equipment rack', 'patch_panel': 'Patch panel', 'server': 'Rack server', 'ups': 'UPS unit',
}


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float

    def overlaps(self, other):
        return self.x < other.x + other.w and other.x < self.x + self.w and self.y < other.y + other.h and other.y < self.y + self.h

    def contains(self, other):
        return (self.x <= other.x and self.y <= other.y
                and self.x + self.w >= other.x + other.w and self.y + self.h >= other.y + other.h)


@dataclass(frozen=True)
class Mark:
    anchor: tuple
    box: Box
    lines: tuple
    color: object
    style: str


def _decode(encoded):
    if not isinstance(encoded, str) or len(encoded) > _IMAGE_BYTES:
        raise ValueError('The floor plan image is too large or missing')
    try:
        raw = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(raw)) as source:
            width, height = source.size
            if source.format != 'JPEG' or min(width, height) < 16 or max(width, height) > 2500 or width * height > 5_000_000:
                raise ValueError('Unsupported floor plan image')
            source.load()
        # Construct from the validated JPEG so ReportLab can embed the compressed bytes.
        return ImageReader(io.BytesIO(raw))
    except (OSError, ValueError, binascii.Error, Image.DecompressionBombError) as exc:
        raise ValueError('The floor plan image could not be read') from exc


def _text(value, limit):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError('Invalid floor plan text')
    return ' '.join(value.split())


def _number(value, low, high):
    if type(value) not in (int, float) or not low <= value <= high:
        raise ValueError('Invalid floor plan dimensions or coordinates')
    return value


def _list(value, limit):
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError('Invalid floor plan annotations')
    return value


def _point(value):
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError('Invalid floor plan coordinate')
    return tuple(_number(item, 0, 1) for item in value)


def _points(value, limit):
    return [_point(item) for item in _list(value, limit)]


def _read_annotations(data):
    notes, equipment, aps, cables = [], [], [], []
    for key, limit, output, prefix in (
        ('notes', 320, notes, 'N'), ('equipment', 576, equipment, 'D'), ('aps', 128, aps, 'A'),
    ):
        for i, item in enumerate(_list(data.get(key, []), limit), 1):
            if not isinstance(item, dict):
                raise ValueError('Invalid floor plan label')
            kind = item.get('kind', '')
            if key != 'notes' and (not isinstance(kind, str) or kind not in _GLYPHS):
                raise ValueError('Unknown floor plan device')
            if key == 'aps' and kind != 'access_point':
                raise ValueError('Only access points belong on the Wi-Fi sheet')
            powered, mounted = item.get('powered', False), item.get('mounted', False)
            if type(powered) is not bool or type(mounted) is not bool:
                raise ValueError('Invalid device power state')
            details = [_text(value, 120) for value in _list(item.get('details', []), 4)]
            output.append(dict(ref=f'{prefix}{i:02}', name=_text(item.get('name'), 160), kind=kind,
                               point=_point(item.get('point')), details=details, powered=powered, mounted=mounted,
                               rack_id=_text(item.get('rack_id', ''), 64) if kind == 'rack' else '',
                               radio_plan=_text(item.get('radio_plan', ''), 120),
                               cone=_points(item.get('cone', []), 256) if kind == 'poe_camera' else []))
    for i, item in enumerate(_list(data.get('cables', []), 512), 1):
        if not isinstance(item, dict):
            raise ValueError('Invalid cable annotation')
        media, color = item.get('media'), item.get('color')
        if media not in ('ethernet', 'fiber') or not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
            raise ValueError('Invalid cable media or color')
        path = _points(item.get('points'), 42)
        if len(path) < 2:
            raise ValueError('A cable must have two endpoints')
        cables.append(dict(ref=f'W{i:02}', name=_text(item.get('name'), 80), media=media, color=HexColor(color),
                           points=path, source=_text(item.get('source'), 120), target=_text(item.get('target'), 120),
                           length=_number(item.get('length'), 0, 20_000_000_000_000)))
    return notes, equipment, aps, cables


def _load_fonts():
    from matplotlib import get_data_path
    with _FONT_LOCK:
        if _FONT not in pdfmetrics.getRegisteredFontNames():
            fonts = Path(get_data_path()) / 'fonts' / 'ttf'
            pdfmetrics.registerFont(TTFont(_FONT, str(fonts / 'DejaVuSans.ttf')))
            pdfmetrics.registerFont(TTFont(_BOLD, str(fonts / 'DejaVuSans-Bold.ttf')))


def _supported(text):
    glyphs = pdfmetrics.getFont(_FONT).face.charToGlyph
    return ''.join(char if ord(char) in glyphs else '?' for char in text)


def _wrap(text, font, size, width):
    text = _supported(text)
    lines = []
    while pdfmetrics.stringWidth(text, font, size) > width:
        lo, hi = 1, len(text) - 1
        while lo < hi:
            middle = (lo + hi + 1) // 2
            if pdfmetrics.stringWidth(text[:middle], font, size) <= width:
                lo = middle
            else:
                hi = middle - 1
        split = text.rfind(' ', 0, lo + 1)
        take = split if split > 0 else lo
        lines.append(text[:take])
        text = text[take:].lstrip()
    return [*lines, text]


def _label_lines(title, details, width, title_size=7.5, detail_size=7, color=_INK):
    return tuple((line, font, size, ink) for text, font, size, ink in
                 [(title, _BOLD, title_size, color), *((value, _FONT, detail_size, _MUTED) for value in details)]
                 for line in _wrap(text, font, size, width))


class _Placement:
    def __init__(self, frame):
        self.frame = frame
        self.cells = defaultdict(list)

    @staticmethod
    def _tiles(box):
        for x in range(math.floor(box.x / 32), math.floor((box.x + box.w) / 32) + 1):
            for y in range(math.floor(box.y / 32), math.floor((box.y + box.h) / 32) + 1):
                yield x, y

    def reserve(self, box):
        for tile in self._tiles(box):
            self.cells[tile].append(box)

    def fits(self, box):
        return self.frame.contains(box) and not any(box.overlaps(other) for tile in self._tiles(box) for other in self.cells.get(tile, ()))

    def place(self, anchors, lines, color, style):
        width = max(pdfmetrics.stringWidth(text, font, size) for text, font, size, _ in lines) + 8
        height = sum(size + 2 for _, _, size, _ in lines) + 4
        for gap in ((7, 16, 29, 42, 56) if style == 'full' else (5, 12, 23, 36, 54, 80, 115, 160)):
            for x, y in anchors:
                for dx, dy in ((gap, -.5 * height), (-width - gap, -.5 * height), (-.5 * width, gap),
                               (-.5 * width, -height - gap), (gap, gap), (-width - gap, gap),
                               (gap, -height - gap), (-width - gap, -height - gap)):
                    box = Box(x + dx, y + dy, width, height)
                    if self.fits(box):
                        self.reserve(Box(box.x - .8, box.y - .8, box.w + 1.6, box.h + 1.6))
                        return Mark((x, y), box, lines, color, style)
        if style == 'full':
            return None
        # Nearby labels may all refer to the same physical point. Keep every reference
        # by searching the free cells in the drawing and linking back to the anchor.
        frame = self.frame
        x, y = anchors[0]
        dx, dy = width + 2, height + 2
        columns, rows = int(frame.w / dx), int(frame.h / dy)
        cx, cy = min(columns - 1, int((x - frame.x) / dx)), min(rows - 1, int((y - frame.y) / dy))
        for radius in range(max(columns, rows)):
            left, right, bottom, top = cx - radius, cx + radius, cy - radius, cy + radius
            rim = [(i, j) for i in range(left, right + 1) for j in (bottom, top)]
            rim.extend((i, j) for j in range(bottom + 1, top) for i in (left, right))
            for i, j in rim:
                if 0 <= i < columns and 0 <= j < rows:
                    box = Box(frame.x + i * dx, frame.y + j * dy, width, height)
                    if self.fits(box):
                        self.reserve(box)
                        return Mark((x, y), box, lines, color, style)
        return None


def _map_point(frame, point):
    return frame.x + point[0] * frame.w, frame.y + (1 - point[1]) * frame.h


def _wire_anchors(points):
    segments = sorted(zip(points, points[1:]), key=lambda pair: math.dist(*pair), reverse=True)[:4]
    return [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) for a, b in segments for t in (.5, .32, .68)]


def _device_details(item, sheet):
    if item['kind'] == 'rack':
        return []
    if sheet == 1 and item['kind'] == 'access_point':
        radios = [item['radio_plan']] if item['radio_plan'] else []
        return radios + (item['details'] or (['No SSIDs enabled'] if item['powered'] else ['Not transmitting (no PoE)']))
    if sheet == 2:
        return [] if item['powered'] else ['Unpowered preview']
    if item['kind'] == 'access_point':
        return []
    return item['details']


def _arrange(sheet, frame, plot, notes, devices, cables):
    placement = _Placement(plot)
    for item in [*notes, *devices]:
        x, y = _map_point(frame, item['point'])
        placement.reserve(Box(x - 5, y - 5, 10, 10))
    marks, note_refs = [], set()
    name_counts = defaultdict(int)
    for device in devices:
        name_counts[device['name']] += 1
    for items in ((notes, devices) if sheet == 0 else (devices, notes)):
        is_note = items is notes
        for item in items:
            title = item['name']
            if not is_note and (name_counts[title] > 1 or item['kind'] == 'rack'):
                title = f"{item['ref']}  {title}"
            details = [] if is_note else _device_details(item, sheet)
            anchor = [_map_point(frame, item['point'])]
            color = _MUTED if is_note else _AP if item['kind'] == 'access_point' else _CAMERA if item['kind'] == 'poe_camera' else _NETWORK
            lines = _label_lines(title, details, 151)
            mark = placement.place(anchor, lines, color, 'full')
            if not mark:
                ref = item['ref']
                mark = placement.place(anchor, _label_lines(ref, [], 50, 7, color=color), color, 'tag')
                if not mark:
                    return None
                if is_note:
                    note_refs.add(ref)
            marks.append(mark)
    for wire in cables:
        points = [_map_point(frame, point) for point in wire['points']]
        ink = _NETWORK if wire['media'] == 'ethernet' else HexColor('#6b3a85')
        mark = placement.place(_wire_anchors(points), _label_lines(wire['ref'], [], 50, 7, color=ink), wire['color'], 'wire')
        if not mark:
            return None
        marks.append(mark)
    return marks, note_refs


def _rack_inventory(racks, equipment):
    references = {item['rack_id']: item['ref'] for item in equipment if item['rack_id']}
    inventory = []
    for rack in racks:
        title = rack['name'] or 'Equipment rack'
        if rack['id'] and rack['id'] in references:
            title = f"{references[rack['id']]}  {title}"
        rows = []
        for device in sorted(rack['gear'], key=lambda item: -item['u']):
            start = device['u']
            last = start + device['size'] - 1
            units = f'U{start}' if start == last else f'U{start}-U{last}'
            rows.append((units, _wrap(device['name'] or _DEVICE_TYPES[device['kind']], _FONT, 8, _RACK_COLUMN - 61)))
        if not rows:
            rows.append(('', ['Empty rack']))
        heading = _wrap(title, _BOLD, 9, _RACK_COLUMN - 16)
        height = _RACK_ROW * (len(heading) + sum(len(lines) for _, lines in rows)) + 13
        inventory.append((heading, rows, height))
    return inventory


def _rack_columns(inventory, height):
    columns, remaining = [], 0
    capacity = height - _RACK_COLUMN_HEADER
    for group in inventory:
        needed = group[2]
        if needed > capacity:
            return None
        if needed > remaining:
            columns.append([])
            remaining = capacity
        columns[-1].append(group)
        remaining -= needed
    return columns


def _layout(image_size, notes, equipment, aps, cables, inventory):
    racks = [item for item in equipment if item['kind'] == 'rack']
    sheets = ([*(item for item in equipment if not item['mounted']), *aps], [*aps, *racks],
              [*(item for item in equipment if item['kind'] == 'poe_camera'), *racks])
    landscape_sizes = (_TABLOID, (1728, 1296), (2592, 1728), (3456, 2592), (4320, 3456))
    ratio = image_size[0] / image_size[1]
    best = None
    fewest_references = float('inf')
    for w, h in landscape_sizes:
        paper = (h, w) if ratio < .76 else (w, h)
        plot = Box(_MARGIN + 4, _MARGIN + 38, paper[0] - 2 * _MARGIN - 8, paper[1] - 2 * _MARGIN - 91)
        columns = _rack_columns(inventory, plot.h)
        if columns is None:
            continue
        directory_width = len(columns) * (_RACK_COLUMN + _RACK_COLUMN_GAP)
        if directory_width > plot.w / 2:
            continue
        plot = Box(plot.x, plot.y, plot.w - directory_width, plot.h)
        image_w = min(plot.w - 14, (plot.h - 14) * ratio)
        image_h = image_w / ratio
        frame = Box(plot.x + (plot.w - image_w) / 2, plot.y + (plot.h - image_h) / 2, image_w, image_h)
        layouts, note_refs = [], set()
        for index, devices in enumerate(sheets):
            layer = _arrange(index, frame, plot, notes, devices, cables if index == 0 else [])
            if layer is None:
                break
            marks, refs = layer
            layouts.append(marks)
            note_refs.update(refs)
        if len(layouts) == len(sheets):
            references = sum(mark.style == 'tag' for marks in layouts for mark in marks)
            if references < fewest_references:
                best = paper, frame, sheets, layouts, note_refs, plot, columns
                fewest_references = references
            if references == 0:
                break
    if best is None:
        raise ValueError('This floor plan has too many overlapping labels to fit on three diagram sheets')
    return best


def _schedule_pages(rows, widths):
    pages, page = [], []
    height = _TABLOID[1] - 2 * _MARGIN - 104
    used = 0
    for row in rows:
        cells = [tuple(line for value in values for line in _wrap(value, _FONT, 8.5, width - 12))
                 for values, width in zip(row, widths)]
        row_height = max(17, max(len(cell) for cell in cells) * 11 + 5)
        if page and used + row_height > height:
            pages.append(page)
            page, used = [], 0
        page.append((cells, row_height))
        used += row_height
    return [*pages, page]


def _schedules(equipment, aps, notes, note_refs, cables, units):
    cable_rows = []
    for wire in cables:
        media = wire['media'].title()
        name = wire['name'] or media
        cable_rows.append(([f"{wire['ref']}  {name}"], [wire['source']], [wire['target']],
                           [media], [f"{wire['length']:g} {units}"]))
    device_rows = []
    for item in [*equipment, *aps]:
        details = _device_details(item, 1) if item['kind'] == 'access_point' else item['details']
        device_rows.append(([f"{item['ref']}  {item['name']}"], [_DEVICE_TYPES[item['kind']]], details))
    device_rows.extend(([f"{note['ref']}  {note['name']}"], ['Plan label reference'], [])
                       for note in notes if note['ref'] in note_refs)
    return _schedule_pages(cable_rows, _CABLE_COLUMNS), _schedule_pages(device_rows, _DEVICE_COLUMNS)


def _draw_line(canvas, text, x, y, font, size, color):
    canvas.setFillColor(color)
    canvas.setFont(font, size)
    canvas.drawString(x, y, _supported(text))


def _draw_title(canvas, heading, page, count, paper, title, author, day):
    w, h = paper
    left, right = _MARGIN, w - _MARGIN
    _draw_line(canvas, heading, left, h - _MARGIN - 12, _BOLD, 16, _INK)
    canvas.setFont(_BOLD, 9)
    canvas.setFillColor(_MUTED)
    canvas.drawRightString(right, h - _MARGIN - 11, f'SHEET {page} / {count}')
    canvas.setStrokeColor(_RULE)
    canvas.setLineWidth(.65)
    canvas.line(left, h - _MARGIN - 22, right, h - _MARGIN - 22)
    canvas.setFillColor(_WASH)
    canvas.rect(left, _MARGIN, right - left, 29, stroke=0, fill=1)
    canvas.line(left, _MARGIN + 29, right, _MARGIN + 29)
    title_cap = (right - left) * .52
    for row, line in enumerate(_wrap(title, _BOLD, 10, title_cap)[:2]):
        _draw_line(canvas, line, left + 9, _MARGIN + 17 - row * 11, _BOLD, 10, _INK)
    meta_x = left + title_cap + 14
    for row, line in enumerate(_wrap(author, _FONT, 8, max(100, right - meta_x - 146))[:2]):
        _draw_line(canvas, line, meta_x, _MARGIN + 18 - row * 9, _FONT, 8, _MUTED)
    _draw_line(canvas, day, right - 119, _MARGIN + 17, _FONT, 8.5, _MUTED)


def _draw_scale(canvas, frame, paper, unit, world_width):
    points_per_unit = frame.w / world_width * (.3048 if unit == 'ft' else 1)
    desired = 92 / points_per_unit
    step = 10 ** math.floor(math.log10(desired))
    value = max(factor * step for factor in (1, 2, 5) if factor * step <= desired)
    length = value * points_per_unit
    x, y = paper[0] - _MARGIN - 128, _MARGIN + 7
    canvas.setStrokeColor(_INK)
    canvas.setLineWidth(.8)
    canvas.lines([(x, y, x + length, y), (x, y - 2, x, y + 3), (x + length, y - 2, x + length, y + 3)])
    _draw_line(canvas, f'{value:g} {unit}', x + length + 5, y - 2, _FONT, 7.4, _INK)


def _draw_legend(canvas, index, paper, devices):
    x, y = _MARGIN, paper[1] - _MARGIN - 36
    if index == 1:
        _draw_line(canvas, 'Usable signal (both bands), including channel interference', x, y, _FONT, 8, _MUTED)
        x += 283
        for swatch, text in (('#9b72a7', '< -85'), ('#e98264', '-85'), ('#efbe53', '-75'),
                             ('#8eba60', '-67'), ('#36aa7c', '-58 dBm')):
            canvas.setFillColor(HexColor(swatch))
            canvas.rect(x, y - 1, 9, 8, fill=1, stroke=0)
            _draw_line(canvas, text, x + 12, y, _FONT, 7.3, _MUTED)
            x += 51
        if not devices or not any(item['powered'] and item['details'] for item in devices):
            _draw_line(canvas, 'No access points are transmitting.', _MARGIN, y - 12, _FONT, 8, _MUTED)
    elif index == 2:
        legend = ('Solid cones show powered cameras. Dashed cones mark unpowered previews.'
                  if any(item['kind'] == 'poe_camera' for item in devices) else 'No cameras are placed on this plan.')
        _draw_line(canvas, legend, x, y, _FONT, 8, _MUTED)


def _draw_rack_inventory(canvas, plot, columns):
    left = plot.x + plot.w + _RACK_COLUMN_GAP
    top = plot.y + plot.h
    for column in columns:
        _draw_line(canvas, 'Rack equipment', left, top - 10, _BOLD, 11, _INK)
        y = top - _RACK_COLUMN_HEADER
        for heading, rows, height in column:
            canvas.setFillColor(_WASH)
            canvas.setStrokeColor(_RULE)
            canvas.setLineWidth(.5)
            canvas.roundRect(left, y - height + 5, _RACK_COLUMN, height - 5, 4, stroke=1, fill=1)
            line_y = y - 12
            for line in heading:
                _draw_line(canvas, line, left + 8, line_y, _BOLD, 9, _NETWORK)
                line_y -= _RACK_ROW
            for units, lines in rows:
                _draw_line(canvas, units, left + 8, line_y, _BOLD, 7.5, _MUTED)
                for line in lines:
                    _draw_line(canvas, line, left + 53, line_y, _FONT, 8, _INK)
                    line_y -= _RACK_ROW
            y -= height
        left += _RACK_COLUMN + _RACK_COLUMN_GAP


def _draw_cables(canvas, frame, wires):
    canvas.setLineCap(1)
    canvas.setLineJoin(1)
    for wire in wires:
        points = [_map_point(frame, point) for point in wire['points']]
        path = canvas.beginPath()
        path.moveTo(*points[0])
        for point in points[1:]:
            path.lineTo(*point)
        width = .85 if wire['media'] == 'fiber' else .65
        if wire['media'] == 'fiber':
            canvas.setDash(2.5, 1.5)
        else:
            canvas.setDash()
        if min(wire['color'].red, wire['color'].green, wire['color'].blue) > .67:
            canvas.setStrokeColor(_MUTED)
            canvas.setLineWidth(width + .55)
            canvas.drawPath(path)
        canvas.setStrokeColor(wire['color'])
        canvas.setLineWidth(width)
        canvas.drawPath(path)
    canvas.setDash()


def _draw_cones(canvas, frame, cameras):
    canvas.saveState()
    for item in cameras:
        if not item['cone']:
            continue
        points = [_map_point(frame, point) for point in item['cone']]
        path = canvas.beginPath()
        path.moveTo(*points[0])
        for point in points[1:]:
            path.lineTo(*point)
        path.close()
        canvas.setStrokeColor(_CAMERA)
        canvas.setFillColor(_CAMERA)
        canvas.setStrokeAlpha(.68)
        canvas.setFillAlpha(.14 if item['powered'] else .06)
        canvas.setLineWidth(.7)
        if item['powered']:
            canvas.setDash()
        else:
            canvas.setDash(3, 2)
        canvas.drawPath(path, fill=1, stroke=1)
    canvas.restoreState()


def _draw_markers(canvas, frame, notes, devices):
    canvas.setFillColor(_MUTED)
    for note in notes:
        x, y = _map_point(frame, note['point'])
        canvas.circle(x, y, 1.55, stroke=0, fill=1)
    for item in devices:
        x, y = _map_point(frame, item['point'])
        kind = item['kind']
        color = _AP if kind == 'access_point' else _CAMERA if kind == 'poe_camera' else _NETWORK
        canvas.setFillColor(color)
        canvas.setStrokeColor(white)
        canvas.setLineWidth(.6)
        if kind == 'access_point':
            canvas.circle(x, y, 4.25, stroke=1, fill=1)
        else:
            canvas.roundRect(x - 4.25, y - 4.25, 8.5, 8.5, 1.6, stroke=1, fill=1)
        canvas.setFont(_BOLD, 5.6)
        canvas.setFillColor(white)
        canvas.drawCentredString(x, y - 2, _GLYPHS[kind])


def _draw_marks(canvas, marks):
    canvas.setLineWidth(.42)
    for mark in marks:
        x, y = mark.anchor
        box = mark.box
        canvas.setStrokeColor(mark.color)
        canvas.line(x, y, min(max(x, box.x), box.x + box.w), min(max(y, box.y), box.y + box.h))
    for mark in marks:
        box = mark.box
        canvas.setFillColor(white)
        canvas.setStrokeColor(_RULE if mark.style == 'full' else mark.color)
        canvas.setLineWidth(.4)
        canvas.roundRect(box.x, box.y, box.w, box.h, 2, stroke=1, fill=1)
        y = box.y + box.h - 2
        for text, font, size, ink in mark.lines:
            y -= size
            _draw_line(canvas, text, box.x + 4, y, font, size, ink)
            y -= 2


def _draw_schedule(canvas, entries, x, title, headings, widths, continued, empty):
    top = _TABLOID[1] - _MARGIN - 41
    _draw_line(canvas, f'{title} (continued)' if continued else title, x, top, _BOLD, 11, _INK)
    top -= 9
    width = sum(widths)
    canvas.setFillColor(_WASH)
    canvas.rect(x, top - 20, width, 20, stroke=0, fill=1)
    start = x
    for heading, column in zip(headings, widths):
        _draw_line(canvas, heading, start + 6, top - 13, _BOLD, 8.5, _MUTED)
        start += column
    top -= 20
    if not entries:
        _draw_line(canvas, empty, x + 6, top - 14, _FONT, 8.5, _MUTED)
    for cells, height in entries:
        start = x
        for lines, column in zip(cells, widths):
            y = top - 11.5
            for line in lines:
                _draw_line(canvas, line, start + 6, y, _FONT, 8.5, _INK)
                y -= 11
            start += column
        top -= height
        canvas.setStrokeColor(_RULE)
        canvas.setLineWidth(.35)
        canvas.line(x, top, x + width, top)


_RACK_COLORS = {key: HexColor(color) for key, color in {
    "router": "#e7edf2", "core_switch": "#adbfc9", "distribution_switch": "#cedbe2",
    "patch_panel": "#33546a", "server": "#38506a", "ups": "#23384b",
}.items()}


def _read_racks(data):
    racks = []
    for item in _list(data.get("racks", []), MAX_RACKS):
        if not isinstance(item, dict) or not isinstance(item.get("power"), dict):
            raise ValueError("Invalid rack sheet")
        occupied, gear, ports = set(), [], {}
        for device in _list(item.get("devices"), RACK_UNITS):
            if not isinstance(device, dict) or not isinstance(device.get("kind"), str) or device["kind"] not in _RACK_COLORS:
                raise ValueError("Invalid equipment in rack sheet")
            identifier = _text(device.get("id"), 64)
            kind = device["kind"]
            size = EQUIPMENT[kind]["rack_units"]
            u = device.get("u")
            if type(u) is not int or not 1 <= u <= RACK_UNITS + 1 - size:
                raise ValueError("Invalid rack unit")
            slots = set(range(u, u + size))
            if slots & occupied:
                raise ValueError("Equipment overlaps on rack sheet")
            occupied.update(slots)
            face = []
            expected = _ports({"kind": kind})
            for port in _list(device.get("ports"), 52):
                if not isinstance(port, dict):
                    raise ValueError("Invalid rack port")
                key = _text(port.get("id"), 16)
                address = identifier, key
                if key not in expected or key.startswith("BACK") or address in ports:
                    raise ValueError("Unknown or duplicate rack port")
                profile = expected[key]
                connected = port.get("connected")
                if type(connected) is not bool:
                    raise ValueError("Invalid rack port status")
                record = dict(id=key, media=profile["media"], wan=profile["wan"], address=address,
                              connected=connected, destination=_text(port.get("destination", ""), 60),
                              peer=_text(port.get("peer", ""), 100))
                ports[address] = record
                face.append(record)
            gear.append(dict(id=identifier, kind=kind, u=u, size=size, name=_text(device.get("name"), 60), ports=face))
        patches = []
        used = set()
        for patch in _list(item.get("patches"), 416):
            if not isinstance(patch, dict):
                raise ValueError("Invalid rack patch cable")
            media = patch.get("media")
            color = patch.get("color")
            if media not in ("ethernet", "fiber") or not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                raise ValueError("Invalid rack cable color or media")
            endpoints = []
            for key in ("source", "target"):
                end = patch.get(key)
                if not isinstance(end, dict):
                    raise ValueError("Invalid rack cable endpoint")
                address = _text(end.get("device_id"), 64), _text(end.get("port"), 16)
                if address not in ports or address in used or ports[address]["media"] != media or ports[address]["wan"]:
                    raise ValueError("Invalid rack cable port")
                used.add(address)
                endpoints.append(address)
            patches.append(dict(ends=endpoints, color=HexColor(color), media=media, label=_text(patch.get("label", ""), 80)))
        power = item["power"]
        if type(power.get("overloaded")) is not bool:
            raise ValueError("Invalid rack power status")
        racks.append(dict(id=_text(item.get("id", ""), 64), name=_text(item.get("name"), 60), gear=gear, patches=patches,
                          watts=_number(power.get("watts"), 0, 20_000),
                          minutes=_number(power.get("minutes"), 0, 100_000), overloaded=power["overloaded"]))
    return racks


def _cost_breakdown(payload, units):
    if not isinstance(payload, dict) or not payload.keys() <= COST_ITEMS.keys():
        raise ValueError("Unknown bill of materials item")
    rows = []
    for key, profile in COST_ITEMS.items():
        quantity = _number(payload.get(key, 0), 0, 21_000_000_000_000_000 if profile["unit"] == "m" else 1024)
        if not quantity:
            continue
        feet = profile["unit"] == "m" and units == "ft"
        displayed = quantity / .3048 if feet else quantity
        unit_price = profile["cents"] * .3048 if feet else profile["cents"]
        rows.append((profile["name"], displayed, (units if profile["unit"] == "m" else "each"),
                     unit_price, math.floor(quantity * profile["cents"] + .5)))
    return rows


def _draw_rack_face(canvas, rack, paper, width):
    top, left = paper[1] - _MARGIN - 62, _MARGIN
    scale = min(width / 700, (top - _MARGIN - 48) / 561)
    canvas.saveState()
    canvas.translate(left, top)
    canvas.scale(scale, scale)
    canvas.setFillColor(HexColor("#182b3b"))
    canvas.roundRect(0, -562, 700, 562, 6, fill=1, stroke=0)
    for i in range(RACK_UNITS):
        y = -i * 35
        canvas.setStrokeColor(HexColor("#52697f"))
        canvas.line(23, y, 669, y)
        _draw_line(canvas, str(RACK_UNITS - i), 6, y - 22, _BOLD, 9, HexColor("#c3d0dc"))
        canvas.setFillColor(HexColor("#8fa5b6"))
        canvas.circle(29, y - 17, 2, fill=1, stroke=0)
        canvas.circle(658, y - 17, 2, fill=1, stroke=0)
    locations = {}
    for item in rack["gear"]:
        y = -(RACK_UNITS + 1 - item["u"] - item["size"]) * 35
        height = item["size"] * 35 - 2
        kind = item["kind"]
        dark = kind in ("patch_panel", "server", "ups")
        ink = white if dark else _INK
        canvas.setFillColor(_RACK_COLORS[kind])
        canvas.roundRect(35, y - height - 1, 617, height, 2, fill=1, stroke=0)
        label = _wrap(item["name"], _BOLD, 9, 147)
        for j, line in enumerate(label[:2]):
            _draw_line(canvas, line, 48, y - 15 - j * 10, _BOLD, 9, ink)
        if kind == "ups":
            canvas.setFillColor(HexColor("#091a24"))
            canvas.roundRect(411, y - 54, 140, 40, 4, fill=1, stroke=0)
            digital = HexColor("#a7e9d7")
            runtime = "OVERLOAD" if rack["overloaded"] else f"{rack['minutes']:g} MIN" if rack["watts"] else "NO LOAD"
            _draw_line(canvas, runtime, 422, y - 29, _BOLD, 12, digital)
            _draw_line(canvas, f"LOAD {rack['watts']:g} W", 422, y - 43, _FONT, 8, digital)
        regular = [port for port in item["ports"] if port["media"] == "ethernet" and not port["wan"]]
        uplink = [port for port in item["ports"] if port["media"] == "fiber" or port["wan"]]
        anchors = [(port, 223 + (i % 24) * 15, y - (8 + (i // 24) * 16 if len(regular) > 24 else 13))
                   for i, port in enumerate(regular)] + [
                       (port, 634 - (len(uplink) - i - 1) * 17, y - 13) for i, port in enumerate(uplink)]
        for port, x, py in anchors:
            locations[port["address"]] = x, py
            canvas.setFillColor(HexColor("#0d202d"))
            canvas.setStrokeColor(HexColor("#61d8a3" if port["connected"] else "#e9b155" if port["destination"] else "#648398"))
            canvas.setLineWidth(.65)
            canvas.rect(x - 5, py - 4, 10, 8, fill=1, stroke=1)
            tag = re.search(r"\d+$", port["id"])
            prefix = ("WF" if port["media"] == "fiber" else "W") if port["wan"] else "S" if port["media"] == "fiber" else ""
            _draw_line(canvas, prefix + (tag.group() if tag else port["id"]), x - 4, py - 11, _FONT, 5.5, ink)
    canvas.setLineCap(1)
    for i, cord in enumerate(rack["patches"]):
        a, b = (locations[end] for end in cord["ends"])
        rail = 661 + (i % 10) * 3
        path = canvas.beginPath()
        path.moveTo(*a)
        path.lineTo(a[0], a[1] - 6)
        path.lineTo(rail, a[1] - 6)
        path.lineTo(rail, b[1] - 6)
        path.lineTo(b[0], b[1] - 6)
        path.lineTo(*b)
        canvas.setDash()
        canvas.setStrokeColor(HexColor("#102536"))
        canvas.setLineWidth(2.4)
        canvas.drawPath(path)
        if cord["media"] == "fiber":
            canvas.setDash(3.5, 2)
        canvas.setStrokeColor(cord["color"])
        canvas.setLineWidth(1.25)
        canvas.drawPath(path)
    canvas.restoreState()


def _rack_entries(rack):
    lookup = {dev["id"]: dev["name"] for dev in rack["gear"]}
    entries = []
    patched = {end for wire in rack["patches"] for end in wire["ends"]}
    for device in rack["gear"]:
        for port in device["ports"]:
            if port["destination"]:
                entries.append((f"U{device['u']} · {port['id']}", port["destination"]))
            elif port["peer"] and port["address"] not in patched:
                entries.append((f"U{device['u']} · {port['id']}", port["peer"]))
    for i, cable in enumerate(rack["patches"], 1):
        a, b = cable["ends"]
        entries.append((f"P{i:02} · {cable['label'] or cable['media'].title()}",
                        f"{lookup[a[0]]} {a[1]} → {lookup[b[0]]} {b[1]}"))
    return entries


def _layout_rack_entries(entries):
    for paper in (_TABLOID, (1728, 1296), (2592, 1728), (3456, 2592)):
        face_width = min(950, paper[0] * .55)
        left, right = _MARGIN + face_width + 18, paper[0] - _MARGIN
        top, bottom = paper[1] - _MARGIN - 63, _MARGIN + 38
        columns = max(1, int((right - left) / 235))
        width = (right - left) / columns
        arranged = [[]]
        size = 8.5
        cursor = top
        for label, description in entries:
            lines = _wrap(f"{label}   {description}", _FONT, size, width - 13)
            if cursor - (size + 2) * len(lines) < bottom:
                arranged.append([])
                cursor = top
            if len(arranged) > columns:
                break
            for line in lines:
                arranged[-1].append((cursor, line))
                cursor -= size + 2
        if len(arranged) <= columns:
            return paper, face_width, left, width, top, arranged
    raise ValueError("The rack has too many port labels for one sheet")


def _draw_rack_sheet(canvas, rack, page, count, title, author, day):
    entries = _rack_entries(rack)
    paper, face_width, left, width, top, columns = _layout_rack_entries(entries)
    canvas.setPageSize(paper)
    _draw_title(canvas, f"Rack elevation · {rack['name']}", page, count, paper, title, author, day)
    _draw_line(canvas, f"Front view · 16U · {rack['watts']:g} W total load", _MARGIN, paper[1] - _MARGIN - 43, _FONT, 9, _MUTED)
    _draw_rack_face(canvas, rack, paper, face_width)
    _draw_line(canvas, "Port labels and patch cables", left, paper[1] - _MARGIN - 43, _BOLD, 11, _INK)
    for i, lines in enumerate(columns):
        for y, line in lines:
            _draw_line(canvas, line, left + i * width, y, _FONT, 8.5, _INK)
    if not entries:
        _draw_line(canvas, "No cables connected", left, top, _FONT, 9, _MUTED)
    canvas.showPage()


def _draw_cost_sheet(canvas, rows, page, count, title, author, day):
    canvas.setPageSize(_TABLOID)
    _draw_title(canvas, "Bill of Materials", page, count, _TABLOID, title, author, day)
    entries = [([[name], [f"{amount:,.0f}" if unit == "each" else f"{amount:,.2f} {unit}"],
                 [f"${price / 100:,.2f}" + (f" / {unit}" if unit != "each" else "")], [f"${total / 100:,.2f}"]], 20)
               for name, amount, unit, price, total in rows]
    _draw_schedule(canvas, entries, _MARGIN, "Estimated hardware and cable materials · USD",
                   ("Item", "Quantity", "Unit cost", "Subtotal"), (520, 190, 180, 288), False, "No network materials placed")
    y = _TABLOID[1] - _MARGIN - 127 - 20 * max(1, len(entries))
    canvas.setFillColor(_WASH)
    canvas.rect(_MARGIN, y, _TABLOID[0] - 2 * _MARGIN, 35, fill=1, stroke=0)
    _draw_line(canvas, "Estimated total", _MARGIN + 8, y + 12, _BOLD, 12, _INK)
    total = sum(row[-1] for row in rows)
    _draw_line(canvas, f"${total / 100:,.2f}", _MARGIN + 896, y + 12, _BOLD, 14, _INK)
    _draw_line(canvas, "Budget estimates exclude labor, tax, and recurring service.", _MARGIN, y - 20, _FONT, 8.5, _MUTED)
    canvas.showPage()


def render_plan_pdf(data, author):
    image = _decode(data.get('image'))
    coverage = _decode(data['coverage_image']) if data.get('coverage_image') is not None else image
    if coverage.getSize() != image.getSize():
        raise ValueError('The coverage and floor plan images must share the same dimensions')
    title = _text(data.get('title'), 120) or 'Untitled Wi-Fi Site'
    author = ' '.join(str(author).split())[:120] or 'Guest'
    export_date = data.get('date')
    if not isinstance(export_date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', export_date):
        raise ValueError('Choose a valid export date')
    day = date.fromisoformat(export_date).isoformat()
    units = data.get('units', 'm')
    if units not in ('ft', 'm'):
        raise ValueError('Choose meters or feet')
    world_width = _number(data.get('drawing_width', image.getSize()[0]), .01, 400_000_000_000)
    _load_fonts()
    notes, equipment, aps, cables = _read_annotations(data)
    racks = _read_racks(data)
    inventory = _rack_inventory(racks, equipment)
    paper, frame, devices, layouts, note_refs, plot, columns = _layout(image.getSize(), notes, equipment, aps, cables, inventory)
    cable_pages, device_pages = _schedules(equipment, aps, notes, note_refs, cables, units)
    schedule_count = max(len(cable_pages), len(device_pages))
    costs = _cost_breakdown(data["bill"], units) if "bill" in data else None
    sheet_count = len(_SHEETS) + schedule_count + len(racks) + (costs is not None)
    out = io.BytesIO()
    canvas = Canvas(out, pagesize=paper, pageCompression=1)
    canvas.setTitle(_supported(title))
    canvas.setAuthor(_supported(author))
    canvas.setCreator('EagleIDE Infra Sim')
    for index, marks in enumerate(layouts):
        _draw_title(canvas, _SHEETS[index], index + 1, sheet_count, paper, title, author, day)
        _draw_scale(canvas, frame, paper, units, world_width)
        _draw_legend(canvas, index, paper, devices[index])
        canvas.drawImage(coverage if index == 1 else image, frame.x, frame.y, frame.w, frame.h)
        if index == 0:
            _draw_cables(canvas, frame, cables)
        if index == 2:
            _draw_cones(canvas, frame, devices[index])
        _draw_marks(canvas, marks)
        _draw_markers(canvas, frame, notes, devices[index])
        _draw_rack_inventory(canvas, plot, columns)
        canvas.showPage()
    canvas.setPageSize(_TABLOID)
    for index in range(schedule_count):
        _draw_title(canvas, _SCHEDULE_TITLE, len(_SHEETS) + index + 1, sheet_count, _TABLOID, title, author, day)
        if index < len(cable_pages):
            _draw_schedule(canvas, cable_pages[index], _MARGIN, 'Cable schedule',
                           ('Reference / name', 'From', 'To', 'Media', 'Length'), _CABLE_COLUMNS,
                           index > 0, 'No cables routed')
        if index < len(device_pages):
            _draw_schedule(canvas, device_pages[index], _MARGIN + sum(_CABLE_COLUMNS) + _SCHEDULE_GAP,
                           'Device inventory', ('Reference / name', 'Type', 'Details'), _DEVICE_COLUMNS,
                           index > 0, 'No devices placed')
        canvas.showPage()
    for index, rack in enumerate(racks, len(_SHEETS) + schedule_count + 1):
        _draw_rack_sheet(canvas, rack, index, sheet_count, title, author, day)
    if costs is not None:
        _draw_cost_sheet(canvas, costs, sheet_count, sheet_count, title, author, day)
    canvas.save()
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '-', title).strip(' .') or 'Infra Sim plan'
    return out.getvalue(), filename + '.pdf'
