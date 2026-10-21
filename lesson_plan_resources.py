"""Bounded immutable agenda media and workspace snapshots, outside user workspaces."""
from __future__ import annotations

import os
import re
import secrets
from pathlib import Path
from time import time

from flask import jsonify, request, send_file

from lesson_plan_store import LessonPlanDataError, normalize_week_start
from notebook_media import photo_bytes

MAX_ASSET_BYTES = 5 * 1024 * 1024
MAX_WEEK_BYTES = 25 * 1024 * 1024
MAX_CLASS_BYTES = 100 * 1024 * 1024
IMAGE_REF = re.compile(r"agenda-image:([0-9a-f]{32})")
FILE_EXTENSIONS = {'.py', '.js', '.html', '.css', '.txt', '.md', '.json', '.csv', '.svg'}


def referenced_assets(plan):
    return {asset for day in (plan or {}).get('days', {}).values()
            for asset in [*(day.get('attachment_ids') or []), *IMAGE_REF.findall(day.get('markdown') or '')]}


class AgendaAssets:
    def __init__(self, store):
        self.store = store

    def directory(self, class_id, week):
        return self.store.base_dir / 'assets' / self.store._class_key(class_id) / normalize_week_start(week)

    def manifest(self, class_id, week):
        return self.store._read_json(self.directory(class_id, week) / 'manifest.json', {})

    def get(self, class_id, week, asset_id):
        with self.store._lock:
            return self.manifest(class_id, week).get(asset_id)

    def put(self, class_id, week, payload, *, name, kind, media_type):
        if len(payload) > MAX_ASSET_BYTES:
            raise LessonPlanDataError('Agenda media must be smaller than 5 MB')
        with self.store._lock:
            folder = self.directory(class_id, week)
            entries = self.manifest(class_id, week)
            # Abandoned inserts are retained for a day to allow unpublished tab drafts.
            referenced = referenced_assets(self.store.get_plan(class_id, week))
            cleaned = False
            for stale_id, item in list(entries.items()):
                if stale_id not in referenced and time() - item.get('created_at', time()) > 86400:
                    (folder / f'{stale_id}.bin').unlink(missing_ok=True)
                    entries.pop(stale_id)
                    cleaned = True
            if cleaned:
                self.store._write_json(folder / 'manifest.json', entries)
            if len(entries) >= 100 or sum(item['size'] for item in entries.values()) + len(payload) > MAX_WEEK_BYTES:
                raise LessonPlanDataError('This week has reached its media limit (100 items / 25 MB)')
            used = sum(path.stat().st_size for path in folder.parent.glob('*/*.bin'))
            if used + len(payload) > MAX_CLASS_BYTES:
                raise LessonPlanDataError('Class agenda storage limit reached (100 MB)')
            folder.mkdir(parents=True, exist_ok=True)
            asset_id = secrets.token_hex(16)
            path = folder / f'{asset_id}.bin'
            entry = {'id': asset_id, 'name': name, 'kind': kind, 'media_type': media_type, 'size': len(payload), 'created_at': time()}
            try:
                with path.open('xb') as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                entries[asset_id] = entry
                self.store._write_json(folder / 'manifest.json', entries)
            except Exception:
                path.unlink(missing_ok=True)
                raise
            return entry

    def prune_removed(self, class_id, week, previous, current):
        with self.store._lock:
            entries = self.manifest(class_id, week)
            current = self.store.get_plan(class_id, week) or current
            removed = referenced_assets(previous) - referenced_assets(current)
            for asset_id in removed:
                entries.pop(asset_id, None)
            if removed:
                self.store._write_json(self.directory(class_id, week) / 'manifest.json', entries)
                for asset_id in removed:
                    (self.directory(class_id, week) / f'{asset_id}.bin').unlink(missing_ok=True)


def register(app, *, store, assets, teacher_class, plan_source_class, require_teacher,
             require_user, find_user, get_user_class_ids, find_class, get_print_export=lambda token: None, eagle=None):
    def fail(message, status=400):
        return jsonify(ok=False, error=message), status

    def teacher_source(class_id):
        cls, failure = teacher_class(class_id)
        if failure:
            return None, failure
        source = plan_source_class(cls)
        teacher = require_teacher(request) or {}
        if teacher.get('is_coteacher') and source['id'] != class_id and teacher.get('email') not in source.get('coteachers', []):
            return None, fail('The owner must edit this linked source plan', 403)
        return source, None

    @app.post('/api/teacher/classes/<class_id>/lesson-plans/<week>/assets')
    def upload_agenda_asset(class_id, week):
        source, failure = teacher_source(class_id)
        if failure:
            return failure
        try:
            week = normalize_week_start(week)
            if 'image' in request.files:
                payload = request.files['image'].stream.read(MAX_ASSET_BYTES + 1)
                if len(payload) > MAX_ASSET_BYTES:
                    return fail('Images must be smaller than 5 MB', 413)
                payload, extension, _ = photo_bytes(payload)
                entry = assets.put(source['id'], week, payload, name=f'Agenda image{extension}', kind='image',
                                   media_type='image/png' if extension == '.png' else 'image/jpeg')
            else:
                if eagle is None:
                    return fail('Workspace attachments unavailable', 503)
                body = request.get_json(silent=True) or {}
                if not isinstance(body, dict):
                    return fail('Attachment data must be an object')
                teacher = require_teacher(request)
                root = eagle._get_user_dir(teacher['email'])
                path = eagle._validate_workspace_path(root, body.get('path'))
                if not path or not path.is_file() or path.suffix.lower() not in FILE_EXTENSIONS:
                    return fail('Choose a text, code, JSON, CSV, or SVG file from your workspace')
                with eagle._assignment_lock, eagle.file_provenance.lock(root):
                    with path.open('rb') as handle:
                        payload = handle.read(eagle.MAX_EDITOR_FILE_BYTES + 1)
                if len(payload) > eagle.MAX_EDITOR_FILE_BYTES:
                    return fail('The file exceeds the 2 MB editor limit', 413)
                entry = assets.put(source['id'], week, payload, name=path.name, kind='file', media_type='application/octet-stream')
            return jsonify(ok=True, asset=entry)
        except (ValueError, OSError) as exc:
            return fail(str(exc) if isinstance(exc, ValueError) else 'Could not store agenda media')

    def accessible(class_id, week, asset_id, *, student_only=False):
        cls = find_class(class_id)
        if not cls:
            return None
        teacher = require_teacher(request) if not student_only else None
        shared = store.class_id_for_token(request.args.get('share') or '') == class_id and week <= normalize_week_start()
        if teacher:
            _, failure = teacher_class(class_id)
            if failure:
                if not shared:
                    return None
                teacher = None
        else:
            user = require_user(request)
            if user:
                fresh = find_user(user.get('email') or '') or user
                if class_id not in get_user_class_ids(fresh) and not shared:
                    return None
            else:
                export = get_print_export(request.args.get('print') or '') if not student_only else None
                printing = export and export['class_id'] == class_id and export['week'] == week
                if student_only or (not printing and store.class_id_for_token(request.args.get('share') or '') != class_id):
                    return None
            if week > normalize_week_start() and not (not user and not student_only and printing):
                return None
        source = plan_source_class(cls)
        if not teacher and asset_id not in referenced_assets(store.get_plan(source['id'], week)):
            return None
        return source

    @app.get('/api/lesson-plans/<class_id>/<week>/assets/<asset_id>')
    def read_agenda_asset(class_id, week, asset_id):
        try:
            week = normalize_week_start(week)
        except ValueError:
            return fail('Media not found', 404)
        source = accessible(class_id, week, asset_id)
        entry = assets.get(source['id'], week, asset_id) if source else None
        if not entry or entry['kind'] != 'image':
            return fail('Media not found', 404)
        try:
            response = send_file(assets.directory(source['id'], week) / f'{asset_id}.bin', mimetype=entry['media_type'])
        except FileNotFoundError:
            return fail('Media not found', 404)
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.post('/api/classes/<class_id>/lesson-plans/<week>/files/<asset_id>/open')
    def copy_agenda_file(class_id, week, asset_id):
        if eagle is None:
            return fail('Workspace attachments unavailable', 503)
        try:
            week = normalize_week_start(week)
            source = accessible(class_id, week, asset_id)
            entry = assets.get(source['id'], week, asset_id) if source else None
            user = eagle._require_user_for_files(request)
            if not entry or entry['kind'] != 'file' or not user:
                return fail('Agenda file not found', 404)
            fresh = find_user(user['email']) or user
            if fresh.get('role') == 'student' or user.get('is_coteacher'):
                ide_class = class_id if class_id in get_user_class_ids(fresh) else ''
                allowed, reason = eagle._student_ide_access_allowed(fresh, ide_class)
                if not allowed:
                    return fail(reason or 'IDE access unavailable', 403)
            root = eagle._get_user_dir(user['email'])
            root.mkdir(parents=True, exist_ok=True)
            with eagle._assignment_lock, eagle.file_provenance.lock(root):
                if not eagle._require_user_for_files(request) or not accessible(class_id, week, asset_id):
                    return fail('Agenda file not found', 404)
                fresh = find_user(user['email']) or user
                if fresh.get('role') == 'student' or user.get('is_coteacher'):
                    ide_class = class_id if class_id in get_user_class_ids(fresh) else ''
                    allowed, reason = eagle._student_ide_access_allowed(fresh, ide_class)
                    if not allowed:
                        return fail(reason or 'IDE access unavailable', 403)
                if eagle._count_all_files_for_user(root) >= eagle.MAX_FILES_PER_ACCOUNT or eagle._count_files_in_folder(root) >= eagle.MAX_FILES_PER_FOLDER:
                    return fail('Home file limit reached', 409)
                if eagle._get_user_storage_used(root) + entry['size'] > eagle.USER_STORAGE_LIMIT_MB * 1024 * 1024:
                    return fail('Account storage limit reached', 413)
                payload = (assets.directory(source['id'], week) / f'{asset_id}.bin').read_bytes()
                filename = Path(entry['name'])
                for number in range(eagle.MAX_FILES_PER_FOLDER + 1):
                    name = filename.name if not number else f'{filename.stem} ({number}){filename.suffix}'
                    target = eagle._validate_workspace_path(root, name)
                    if not target or not eagle._valid_workspace_name(name):
                        return fail('Invalid attachment name')
                    created = False
                    try:
                        with target.open('xb') as handle:
                            created = True
                            handle.write(payload)
                        break
                    except FileExistsError:
                        continue
                    except OSError:
                        if created:
                            target.unlink(missing_ok=True)
                        raise
                else:
                    return fail('Could not allocate a file name', 409)
                eagle._invalidate_workspace_tree_cache(root)
            return jsonify(ok=True, path=target.relative_to(root).as_posix(), name=name)
        except (ValueError, OSError):
            return fail('Could not copy the agenda file')
