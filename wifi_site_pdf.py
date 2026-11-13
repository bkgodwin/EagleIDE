"""Compose a printable Infra Sim sheet from its bounded plan rendering."""

import base64
import binascii
import io
import re
import threading
from datetime import date
from pathlib import Path

from PIL import Image


MAX_EXPORT_BYTES = 2_500_000
_FONT_LOCK = threading.Lock()


def render_plan_pdf(encoded, title, author, export_date):
    from matplotlib import get_data_path
    from reportlab.lib.colors import HexColor
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen.canvas import Canvas

    if not isinstance(encoded, str) or len(encoded) > MAX_EXPORT_BYTES:
        raise ValueError('The floor plan image is too large to export')
    try:
        payload = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(payload)) as source:
            width, height = source.size
            if source.format != 'JPEG' or min(width, height) < 16 or max(width, height) > 2500 or width * height > 5_000_000:
                raise ValueError('Unsupported floor plan image')
            source.load()
    except (OSError, ValueError, binascii.Error, Image.DecompressionBombError) as exc:
        raise ValueError('The floor plan image could not be read') from exc

    if not isinstance(title, str) or len(title) > 120:
        raise ValueError('The file name must be 120 characters or fewer')
    if not isinstance(export_date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', export_date):
        raise ValueError('Choose a valid export date')
    day = date.fromisoformat(export_date).isoformat()
    title = ' '.join(title.split()) or 'Untitled Wi-Fi Site'

    with _FONT_LOCK:
        if 'InfraPlan' not in pdfmetrics.getRegisteredFontNames():
            fonts = Path(get_data_path()) / 'fonts' / 'ttf'
            pdfmetrics.registerFont(TTFont('InfraPlan', str(fonts / 'DejaVuSans.ttf')))
            pdfmetrics.registerFont(TTFont('InfraPlanBold', str(fonts / 'DejaVuSans-Bold.ttf')))

    def supported(text):
        glyphs = pdfmetrics.getFont('InfraPlan').face.charToGlyph
        return ''.join(char if ord(char) in glyphs else '?' for char in text)

    author = ' '.join(str(author).split())[:120] or 'Guest'
    margin, block_height, gap = 24, 60, 12

    def drawing_scale(page):
        return min((page[0] - 2 * margin) / width, (page[1] - 2 * margin - block_height - gap) / height)

    page = max((letter, landscape(letter)), key=drawing_scale)
    page_w, page_h = page
    out = io.BytesIO()
    sheet = Canvas(out, pagesize=page, pageCompression=1)
    sheet.setTitle(supported(title))
    sheet.setAuthor(supported(author))
    scale = drawing_scale(page)
    image_w, image_h = width * scale, height * scale
    drawing_top, drawing_bottom = page_h - margin, margin + block_height + gap
    sheet.drawImage(ImageReader(io.BytesIO(payload)), (page_w - image_w) / 2,
                    (drawing_top + drawing_bottom - image_h) / 2, width=image_w, height=image_h)

    sheet.setStrokeColor(HexColor('#a9b8c2'))
    sheet.setFillColor(HexColor('#f3f6f8'))
    sheet.roundRect(margin, margin, page_w - 2 * margin, block_height, 4, stroke=1, fill=1)
    columns = (margin + 12, margin + (page_w - 2 * margin) * .54, page_w - margin - 106)
    for x in columns[1:]:
        sheet.line(x - 10, margin + 9, x - 10, margin + block_height - 9)

    for index, (heading, value) in enumerate((('FILE NAME', title), ('STUDENT / AUTHOR', author), ('DATE', day))):
        x = columns[index]
        right = columns[index + 1] - 19 if index < 2 else page_w - margin - 10
        sheet.setFillColor(HexColor('#455e71'))
        sheet.setFont('InfraPlanBold', 8)
        sheet.drawString(x, margin + 43, heading)
        sheet.setFillColor(HexColor('#172d40'))
        font = 'InfraPlanBold' if index == 0 else 'InfraPlan'
        sheet.setFont(font, 10)
        text = supported(value)
        for row in range(3):
            if not text:
                break
            count = len(text)
            suffix = ''
            while count > 1 and pdfmetrics.stringWidth(text[:count] + suffix, font, 10) > right - x:
                count -= 1
                suffix = '…' if row == 2 else ''
            if row < 2 and count < len(text) and ' ' in text[:count]:
                count = text.rfind(' ', 0, count) or count
            sheet.drawString(x, margin + 30 - row * 11, text[:count].rstrip() + suffix)
            text = text[count:].lstrip()

    sheet.showPage()
    sheet.save()
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '-', title).strip(' .') or 'Infra Sim plan'
    return out.getvalue(), filename + '.pdf'
