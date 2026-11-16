"""Compose three print sheets with vector labels over bounded Infra Sim artwork."""

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


MAX_EXPORT_BYTES = 6_500_000
_IMAGE_BYTES = 2_500_000
_FONT_LOCK = threading.Lock()
_FONT, _BOLD = 'InfraPlan', 'InfraPlanBold'
_INK, _MUTED, _RULE, _WASH = map(HexColor, ('#182d3e', '#425b6c', '#bac8cd', '#f1f5f6'))
_NETWORK, _AP, _CAMERA = map(HexColor, ('#145370', '#146d67', '#28578e'))
_MARGIN, _COLUMN, _COLUMN_GAP = 23, 218, 12
_SHEETS = ('Network layout', 'Wi-Fi coverage', 'Camera coverage')
_GLYPHS = {
    'router': 'R', 'core_switch': 'S', 'distribution_switch': 'S', 'access_switch': 'S', 'keystone': 'J',
    'demarc': 'I', 'desktop': 'D', 'phone': 'M', 'voip_phone': 'V', 'pos_terminal': '$',
    'poe_camera': 'C', 'copy_machine': 'P', 'pass_through': 'T', 'access_point': 'A',
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
            powered = item.get('powered', False)
            if type(powered) is not bool:
                raise ValueError('Invalid device power state')
            details = [_text(value, 120) for value in _list(item.get('details', []), 4)]
            output.append(dict(ref=f'{prefix}{i:02}', name=_text(item.get('name'), 160), kind=kind,
                               point=_point(item.get('point')), details=details, powered=powered,
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
        for gap in ((7, 16, 29) if style == 'full' else (5, 12, 23, 36, 54, 80, 115, 160)):
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
    if sheet == 1 and item['kind'] == 'access_point':
        return item['details'] or (['No SSIDs enabled'] if item['powered'] else ['Not transmitting (no PoE)'])
    if sheet == 2:
        return [] if item['powered'] else ['Unpowered preview']
    if item['kind'] == 'access_point':
        return []
    return item['details']


def _section_rows(title, rows):
    if rows:
        return [(title, ()), *rows]
    return []


def _paginate(rows, height, columns):
    sections = []
    current, used = [], 0
    section = ''
    for i, (heading, lines) in enumerate(rows):
        total = 17 if heading else sum(size + 2.5 for _, _, size, _ in lines) + 5
        next_height = sum(line[2] + 2.5 for line in rows[i + 1][1]) + 5 if heading else 0
        if used + total + next_height > height and current:
            sections.append(current)
            current, used = [], 0
            if not heading:
                current, used = [(f'{section} / CONTINUED', (), 17)], 17
        if heading:
            section = heading
        current.append((heading, lines, total))
        used += total
    if current:
        sections.append(current)
    return sections if len(sections) <= columns else None


def _arrange(sheet, frame, plot, notes, devices, cables, units, column_height, columns):
    placement = _Placement(plot)
    for item in [*notes, *devices]:
        x, y = _map_point(frame, item['point'])
        placement.reserve(Box(x - 5, y - 5, 10, 10))
    marks, note_rows, device_rows, wire_rows = [], [], [], []
    for items, rows in ((notes, note_rows), (devices, device_rows)):
        is_note = items is notes
        for item in items:
            title = item['name']
            details = [] if is_note else _device_details(item, sheet)
            anchor = [_map_point(frame, item['point'])]
            color = _MUTED if is_note else _AP if item['kind'] == 'access_point' else _CAMERA if item['kind'] == 'poe_camera' else _NETWORK
            lines = _label_lines(title, details, 151)
            mark = placement.place(anchor, lines, color, 'full') if len(lines) <= 6 else None
            if not mark:
                ref = item['ref']
                mark = placement.place(anchor, _label_lines(ref, [], 50, 7, color=color), color, 'tag')
                if not mark:
                    return None
                rows.append(('', _label_lines(f'{ref}  {title}', details, _COLUMN - 16, 8.5, 7.8, color=color)))
            marks.append(mark)
    for wire in cables:
        points = [_map_point(frame, point) for point in wire['points']]
        ink = _NETWORK if wire['media'] == 'ethernet' else HexColor('#6b3a85')
        mark = placement.place(_wire_anchors(points), _label_lines(wire['ref'], [], 50, 7, color=ink), wire['color'], 'wire')
        if not mark:
            return None
        marks.append(mark)
        title = wire['name'] or ('Fiber' if wire['media'] == 'fiber' else 'Ethernet')
        length = f"{wire['length']:g} {units}"
        details = [f"{wire['source']} → {wire['target']}", f"{wire['media'].title()}  ·  {length}"]
        wire_rows.append(('', _label_lines(f"{wire['ref']}  {title}", details, _COLUMN - 16, 8.5, 7.8, color=ink)))
    packed = _paginate(_section_rows('CABLE SCHEDULE', wire_rows) + _section_rows('DEVICE LABELS', device_rows)
                       + _section_rows('PLAN NOTES', note_rows), column_height, columns)
    return (marks, packed) if packed is not None else None


def _layout_sheet(index, paper, ratio, notes, devices, cables, units):
    w, h = paper
    plot_height = h - 2 * _MARGIN - 88
    minimum = math.ceil(len(cables) * 24 / plot_height) if cables else 0
    for columns in range(minimum, min(minimum + 3, 8) + 1):
        plot_width = w - 2 * _MARGIN - columns * (_COLUMN + _COLUMN_GAP)
        if plot_width < max(440, w * .46):
            break
        plot = Box(_MARGIN + 4, _MARGIN + 45, plot_width - 8, plot_height)
        image_w = min(plot.w - 14, (plot.h - 14) * ratio)
        image_h = image_w / ratio
        frame = Box(plot.x + (plot.w - image_w) / 2, plot.y + (plot.h - image_h) / 2, image_w, image_h)
        layers = _arrange(index, frame, plot, notes, devices, cables, units, plot_height, columns)
        if layers is not None:
            return frame, plot, layers
    return None


def _layout(image_size, notes, equipment, aps, cables, units):
    sheets = ([*equipment, *aps], aps, [item for item in equipment if item['kind'] == 'poe_camera'])
    landscape_sizes = ((1224, 792), (1728, 1296), (2592, 1728), (3456, 2592), (4320, 3456))
    ratio = image_size[0] / image_size[1]
    for w, h in landscape_sizes:
        paper = (h, w) if ratio < .76 and not cables else (w, h)
        layouts = []
        for index, devices in enumerate(sheets):
            layout = _layout_sheet(index, paper, ratio, notes, devices, cables if index == 0 else [], units)
            if layout is None:
                break
            layouts.append(layout)
        if len(layouts) == 3:
            return paper, sheets, layouts
    raise ValueError('This floor plan has too many labels to fit on three sheets')


def _draw_line(canvas, text, x, y, font, size, color):
    canvas.setFillColor(color)
    canvas.setFont(font, size)
    canvas.drawString(x, y, _supported(text))


def _draw_title(canvas, size, frame, paper, title, author, day, unit, world_width):
    w, h = paper
    left, right = _MARGIN, w - _MARGIN
    _draw_line(canvas, _SHEETS[size], left, h - _MARGIN - 12, _BOLD, 16, _INK)
    canvas.setFont(_BOLD, 9)
    canvas.setFillColor(_MUTED)
    canvas.drawRightString(right, h - _MARGIN - 11, f'SHEET {size + 1} / 3')
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

    points_per_unit = frame.w / world_width * (.3048 if unit == 'ft' else 1)
    desired = 92 / points_per_unit
    step = 10 ** math.floor(math.log10(desired))
    value = max(factor * step for factor in (1, 2, 5) if factor * step <= desired)
    length = value * points_per_unit
    x, y = right - 128, _MARGIN + 7
    canvas.setStrokeColor(_INK)
    canvas.setLineWidth(.8)
    canvas.lines([(x, y, x + length, y), (x, y - 2, x, y + 3), (x + length, y - 2, x + length, y + 3)])
    _draw_line(canvas, f'{value:g} {unit}', x + length + 5, y - 2, _FONT, 7.4, _INK)


def _draw_legend(canvas, index, paper, devices):
    x, y = _MARGIN, paper[1] - _MARGIN - 36
    if index == 1:
        _draw_line(canvas, 'Strongest modeled signal across enabled SSIDs and both bands', x, y, _FONT, 8, _MUTED)
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
        legend = 'Solid cones show powered cameras. Dashed cones mark unpowered previews.' if devices else 'No cameras are placed on this plan.'
        _draw_line(canvas, legend, x, y, _FONT, 8, _MUTED)


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


def _draw_index(canvas, plot, columns):
    for i, entries in enumerate(columns):
        x = plot.x + plot.w + 14 + i * (_COLUMN + _COLUMN_GAP)
        y = plot.y + plot.h
        canvas.setStrokeColor(_RULE)
        canvas.setLineWidth(.55)
        canvas.line(x - 6, plot.y, x - 6, y)
        for heading, lines, total in entries:
            if heading:
                _draw_line(canvas, heading, x, y - 9.5, _BOLD, 9, _MUTED)
            else:
                cursor = y
                for text, font, size, color in lines:
                    cursor -= size
                    _draw_line(canvas, text, x, cursor, font, size, color)
                    cursor -= 2.5
            y -= total


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
    paper, devices, layouts = _layout(image.getSize(), notes, equipment, aps, cables, units)
    out = io.BytesIO()
    canvas = Canvas(out, pagesize=paper, pageCompression=1)
    canvas.setTitle(_supported(title))
    canvas.setAuthor(_supported(author))
    canvas.setCreator('EagleIDE Infra Sim')
    for index, (frame, plot, (marks, columns)) in enumerate(layouts):
        _draw_title(canvas, index, frame, paper, title, author, day, units, world_width)
        _draw_legend(canvas, index, paper, devices[index])
        canvas.drawImage(coverage if index == 1 else image, frame.x, frame.y, frame.w, frame.h)
        if index == 0:
            _draw_cables(canvas, frame, cables)
        if index == 2:
            _draw_cones(canvas, frame, devices[index])
        _draw_marks(canvas, marks)
        _draw_markers(canvas, frame, notes, devices[index])
        _draw_index(canvas, plot, columns)
        canvas.showPage()
    canvas.save()
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '-', title).strip(' .') or 'Infra Sim plan'
    return out.getvalue(), filename + '.pdf'
