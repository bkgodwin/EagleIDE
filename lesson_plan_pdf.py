"""Bounded, local-only PDF rendering of published weekly class agendas."""
from __future__ import annotations

import io
import re
import threading
from datetime import date, timedelta
from html import escape
from pathlib import Path
from time import monotonic

MAX_CLASSES = 128
MAX_TEXT_CHARS = 8_000_000
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_PDF_BYTES = 20 * 1024 * 1024
_font_lock = threading.Lock()


def render_week_pdf(plans, week, images):
    from matplotlib import get_data_path
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Image, LongTable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, TableStyle

    if len(plans) > MAX_CLASSES:
        raise ValueError(f'At most {MAX_CLASSES} classes can be exported at once')
    if sum(len(str(plan['plan'])) for plan in plans) > MAX_TEXT_CHARS or sum(map(len, images.values())) > MAX_IMAGE_BYTES:
        raise ValueError('This week exceeds the PDF text or image limit')
    with _font_lock:
        if 'Agenda' not in pdfmetrics.getRegisteredFontNames():
            fonts = Path(get_data_path()) / 'fonts' / 'ttf'
            pdfmetrics.registerFont(TTFont('Agenda', str(fonts / 'DejaVuSans.ttf')))
            pdfmetrics.registerFont(TTFont('Agenda-Bold', str(fonts / 'DejaVuSans-Bold.ttf')))
            pdfmetrics.registerFontFamily('Agenda', normal='Agenda', bold='Agenda-Bold', italic='Agenda', boldItalic='Agenda-Bold')
    glyphs = pdfmetrics.getFont('Agenda').face.charToGlyph

    def clean(value):
        text = str(value or '').replace('\x00', '')
        return ''.join(char if ord(char) in glyphs or char in '\n\t' else '?' for char in text)

    body = ParagraphStyle('Agenda body', fontName='Agenda', fontSize=8.5, leading=12, spaceAfter=6,
                          textColor=colors.HexColor('#243647'), alignment=TA_LEFT, splitLongWords=True)
    title = ParagraphStyle('Class title', parent=body, fontName='Agenda-Bold', fontSize=18, leading=23, textColor=colors.HexColor('#173b55'))
    heading = ParagraphStyle('Day heading', parent=body, fontName='Agenda-Bold', fontSize=10, leading=14)
    small = ParagraphStyle('Caption', parent=body, fontSize=7.5, leading=10, textColor=colors.HexColor('#526779'))
    code = ParagraphStyle('Code', parent=body, fontSize=7.5, leading=10, backColor=colors.HexColor('#f0f3f6'))
    monday = date.fromisoformat(week)
    week_label = f'{monday:%B %d, %Y} - {monday + timedelta(days=4):%B %d, %Y}'
    width, height = landscape(letter)
    column = (width - 56) / 5
    cell_width = column - 18

    def inline(value):
        value = re.sub(r'!\[([^]]*)\]\([^)]*\)', r'[Image: \1]', value)
        value = re.sub(r'\[([^]]+)\]\([^)]*\)', r'\1', value)
        value = escape(clean(value))
        value = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', value)
        value = re.sub(r'`([^`]+)`', r'<font color="#31516b">\1</font>', value)
        return value

    def markdown(value, source_id):
        result, paragraph, in_code = [], [], False
        def flush():
            if paragraph:
                result.append(Paragraph('<br/>'.join(paragraph) if in_code else ' '.join(paragraph), code if in_code else body))
                paragraph.clear()
        for line in str(value or '').splitlines():
            if line.lstrip().startswith('```'):
                flush(); in_code = not in_code; continue
            matches = list(re.finditer(r'!\[([^]]*)\]\(agenda-image:([a-f0-9]{32})\)', line)) if not in_code else []
            if matches:
                flush(); cursor = 0
                for match in matches:
                    if line[cursor:match.start()].strip():
                        result.append(Paragraph(inline(line[cursor:match.start()]), body))
                    payload = images.get((source_id, match[2]))
                    if payload:
                        image = Image(io.BytesIO(payload), lazy=1)
                        scale = min(cell_width / image.imageWidth, 155 / image.imageHeight)
                        image.drawWidth, image.drawHeight = image.imageWidth * scale, image.imageHeight * scale
                        result.extend([image, Spacer(1, 8)])
                    else:
                        result.append(Paragraph(inline(f'[Image unavailable: {match[1]}]'), small))
                    cursor = match.end()
                if line[cursor:].strip():
                    result.append(Paragraph(inline(line[cursor:]), body))
            elif in_code:
                paragraph.append(escape(clean(line)).replace(' ', '&#160;'))
            elif not line.strip():
                flush()
            elif re.match(r'^\s*#{1,6}\s+', line):
                flush(); result.append(Paragraph(inline(re.sub(r'^\s*#{1,6}\s+', '', line)), heading))
            elif re.match(r'^\s*(?:[-*+] |\d+[.)] )', line):
                flush(); result.append(Paragraph('- ' + inline(re.sub(r'^\s*(?:[-*+] |\d+[.)] )', '', line)), body))
            else:
                paragraph.append(inline(line))
        flush()
        return result

    story = []
    for index, data in enumerate(plans):
        if index:
            story.append(PageBreak())
        plan = data['plan']; source_id = data['source_id']
        banner = [Paragraph(escape(clean(data['class']['name'])), title), Paragraph(escape(week_label), small)]
        headers, columns = [], []
        commands = [('SPAN', (0, 0), (-1, 0)), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 9), ('RIGHTPADDING', (0, 0), (-1, -1), 9),
                    ('TOPPADDING', (0, 0), (-1, -1), 10), ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
                    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eaf1f6')),
                    ('LINEBELOW', (0, 1), (-1, 1), .6, colors.HexColor('#a8bdcc')),
                    ('INNERGRID', (0, 1), (-1, -1), .4, colors.HexColor('#cdd9e1')),
                    ('BOX', (0, 0), (-1, -1), .5, colors.HexColor('#b6c9d7'))]
        for day_index, day in enumerate(('monday', 'tuesday', 'wednesday', 'thursday', 'friday')):
            item = plan['days'].get(day) or {}
            headers.append(Paragraph(f'{day.title()}<br/><font size="8">{monday + timedelta(days=day_index):%b %d}</font>', heading))
            content = markdown(item.get('markdown') or '', source_id)
            for page in item.get('wiki_pages') or []:
                if page.get('url') and f"]({page['url']})" in item.get('markdown', ''):
                    continue
                content.append(Paragraph('Wiki: ' + inline(page.get('title', '') + (f" - {page['section_title']}" if page.get('section_title') else '')), small))
            for file in item.get('attachments') or []:
                content.append(Paragraph('File: ' + inline(file['name']), small))
            for assignment in item.get('assignments') or []:
                content.append(Paragraph('Assignment: ' + inline(assignment['name']), small))
            for link in item.get('external_links') or []:
                content.append(Paragraph('Resource: ' + inline(link.get('title') or link.get('url')), small))
            if item.get('standards'):
                content.append(Paragraph('Standards: ' + inline(', '.join(entry['standard_id'] for entry in item['standards'])), small))
            columns.append(content or [Paragraph('No activities published.', small)])
            tint = colors.HexColor(item.get('color') or '#f2f6f9')
            tint = colors.Color(*(1 - (1 - part) * .16 for part in (tint.red, tint.green, tint.blue)))
            commands.append(('BACKGROUND', (day_index, 1), (day_index, 2), tint))
        table = LongTable([[banner, '', '', '', ''], headers, columns], colWidths=[column] * 5,
                          repeatRows=2, splitByRow=1, splitInRow=1, hAlign='LEFT')
        table.setStyle(TableStyle(commands)); story.append(table)
        if plan.get('notes_markdown', '').strip():
            story.extend([Spacer(1, 12), Paragraph('Additional notes', heading), *markdown(plan['notes_markdown'], source_id)])
    if not story:
        story.append(Paragraph('No classes are available for this account.', body))

    class CappedBuffer(io.BytesIO):
        def write(self, payload):
            if self.tell() + len(payload) > MAX_PDF_BYTES:
                raise ValueError('This week exceeds the PDF size limit')
            return super().write(payload)

    started = monotonic()
    def decorate(canvas, doc):
        if doc.page > 256 or monotonic() - started > 20:
            raise ValueError('This week exceeds the PDF page or rendering limit')
        canvas.setTitle(f'Lesson plans - week of {week}')
        canvas.setFont('Agenda', 7)
        canvas.setFillColor(colors.HexColor('#526779'))
        canvas.drawString(28, 18, f'EagleIDE | Week of {week}')
        canvas.drawRightString(width - 28, 18, f'Page {doc.page}')
    output = CappedBuffer()
    document = SimpleDocTemplate(output, pagesize=(width, height), leftMargin=28, rightMargin=28,
                                 topMargin=24, bottomMargin=34, allowSplitting=1)
    document.build(story, onFirstPage=decorate, onLaterPages=decorate)
    return output.getvalue()
