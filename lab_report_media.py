"""Bounded, private report illustrations; never fetch teacher-provided URLs."""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import threading
import uuid
from pathlib import Path

from flask import jsonify, request, send_file
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.exceptions import RequestEntityTooLarge

IMAGE_TOKEN = re.compile(r"!\[[^\]\n]{0,200}\]\(lab-image:([a-f0-9]{32})\)")
MAX_UPLOAD = 5 * 1024 * 1024


def register(app, eagle, *, base_dir: Path):
    base = Path(base_dir).resolve()
    lock = threading.Lock()
    image_slots = threading.BoundedSemaphore(2)

    def author():
        if eagle._require_admin(request):
            return '__admin__', None
        teacher = eagle._require_teacher(request, allow_coteacher=True)
        class_id = str(request.args.get('class_id') or '')
        if teacher and eagle._class_dashboard_access(teacher['email'], class_id):
            return teacher['email'].strip().lower(), None
        return None, (jsonify(ok=False, error='Class author access required'), 403)

    def owner_dir(email):
        return base / hashlib.sha256(email.encode('utf-8')).hexdigest()

    @app.post('/api/lab-reports/images')
    def upload_image():
        email, error = author()
        if error:
            return error
        if not image_slots.acquire(blocking=False):
            return jsonify(ok=False, error='Image uploads are busy. Try again shortly.'), 429
        try:
            return receive_image(email)
        except RequestEntityTooLarge:
            return jsonify(ok=False, error='Choose an image smaller than 5 MB'), 413
        finally:
            image_slots.release()

    def receive_image(email):
        if request.content_length and request.content_length > MAX_UPLOAD + 65536:
            return jsonify(ok=False, error='Choose an image smaller than 5 MB'), 413
        request.max_content_length = MAX_UPLOAD + 65536
        upload = request.files.get('image')
        if not upload:
            return jsonify(ok=False, error='Choose a JPEG or PNG image'), 400
        payload = upload.stream.read(MAX_UPLOAD + 1)
        if len(payload) > MAX_UPLOAD:
            return jsonify(ok=False, error='Choose an image smaller than 5 MB'), 413
        try:
            with Image.open(io.BytesIO(payload)) as source:
                if source.format not in {'JPEG', 'PNG'} or source.width * source.height > 25_000_000 or getattr(source, 'n_frames', 1) != 1:
                    raise ValueError()
                source.load()
                image = ImageOps.exif_transpose(source).convert('RGB')
                image.thumbnail((1920, 1920))
                image.info.clear()
                encoded = io.BytesIO()
                image.save(encoded, 'JPEG', quality=85, optimize=True)
                payload = encoded.getvalue()
        except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError):
            return jsonify(ok=False, error='Choose a valid, static JPEG or PNG image'), 400
        with lock:
            directory = owner_dir(email)
            directory.mkdir(parents=True, exist_ok=True)
            files = list(directory.glob('*.jpg'))
            if len(files) >= 100 or sum(path.stat().st_size for path in files) + len(payload) > 50 * 1024 * 1024:
                return jsonify(ok=False, error='Report image storage is full (100 images / 50 MB per author)'), 413
            image_id = uuid.uuid4().hex
            path = directory / (image_id + '.jpg')
            path.write_bytes(payload)
            metadata = path.with_suffix('.json')
            metadata.write_text(json.dumps({'class_id': str(request.args.get('class_id') or '')}), encoding='utf-8')
            os.chmod(directory, 0o700)
            os.chmod(path, 0o600)
            os.chmod(metadata, 0o600)
        return jsonify(ok=True, data={'id': image_id}), 201

    @app.get('/api/lab-reports/images/<image_id>')
    def read_image(image_id):
        if not re.fullmatch(r'[a-f0-9]{32}', image_id):
            return jsonify(ok=False, error='Image not found'), 404
        email, _ = author()
        path = owner_dir(email) / (image_id + '.jpg') if email else None
        if not path or not path.is_file():
            assignment = eagle._load_assignment(str(request.args.get('assignment_id') or ''))
            if not assignment or assignment.get('assignmentType') != 'lab_report':
                return jsonify(ok=False, error='Image not found'), 404
            class_id = assignment.get('targetClassId')
            teacher = eagle._require_teacher(request, allow_coteacher=True)
            student = eagle._require_user(request)
            allowed = eagle._require_admin(request) or (teacher and eagle._class_dashboard_access(teacher['email'], class_id)) or (student and eagle._user_in_class(eagle._find_user(student['email']) or {}, class_id))
            if not allowed:
                return jsonify(ok=False, error='Report access required'), 403
            questions = (assignment.get('quiz') or {}).get('questions') or []
            text = '\n'.join([str(assignment.get('task') or '')] + [str(q.get('question') or '') + '\n' + '\n'.join(q.get('steps') or []) for q in questions])
            if image_id not in IMAGE_TOKEN.findall(text):
                return jsonify(ok=False, error='Image not found'), 404
            # Only an explicitly referenced immutable ID is readable. No URL,
            # account identity or filesystem path comes from the browser.
            paths = list(base.glob('*/' + image_id + '.jpg'))
            path = paths[0] if paths else None
            try:
                if not path or json.loads(path.with_suffix('.json').read_text(encoding='utf-8')).get('class_id') != class_id:
                    return jsonify(ok=False, error='Image not found'), 404
            except (OSError, ValueError):
                return jsonify(ok=False, error='Image not found'), 404
        if not path or not path.is_file():
            return jsonify(ok=False, error='Image not found'), 404
        response = send_file(path, mimetype='image/jpeg', conditional=False)
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    return base
