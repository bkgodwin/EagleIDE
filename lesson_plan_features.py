"""Lesson-plan APIs and public page routes for EagleIDE."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from html import escape as html_escape, unescape as html_unescape
from ipaddress import ip_address
from pathlib import Path
import re
from secrets import token_urlsafe
import socket
import http.client
import ssl
from threading import BoundedSemaphore, Lock
from time import monotonic
from typing import Any, Callable, Optional
from urllib.parse import urljoin, urlsplit
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, request, send_file, send_from_directory

from lesson_plan_store import (
    DAYS,
    LessonPlanConflictError,
    LessonPlanDataError,
    LessonPlanStore,
    normalize_external_url,
    normalize_week_start,
)
from lesson_plan_resources import AgendaAssets, IMAGE_REF, register as register_resources


LINK_PREVIEW_MAX_BYTES = 131_072
LINK_TITLE_RE = re.compile(r"<title\b[^>]*>(.*?)</title\s*>", re.IGNORECASE | re.DOTALL)
HTML_TAG_RE = re.compile(r"<[^>]+>")


def _public_link_target(value: Any):
    url = normalize_external_url(value)
    parsed = urlsplit(url)
    host = str(parsed.hostname or "")
    port = parsed.port or (443 if parsed.scheme.casefold() == "https" else 80)
    try:
        addresses = {item[4][0].split("%", 1)[0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)}
        if not addresses or any(not ip_address(address).is_global for address in addresses):
            raise LessonPlanDataError("External link previews cannot access private networks")
    except (OSError, ValueError) as exc:
        raise LessonPlanDataError("Could not resolve that external link") from exc
    return url, parsed, sorted(addresses)[0]


class _PinnedPublicConnection(http.client.HTTPConnection):
    def __init__(self, parsed, address, timeout):
        super().__init__(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), timeout=timeout)
        self.address, self.tls = address, parsed.scheme.casefold() == "https"

    def connect(self):
        sock = socket.create_connection((self.address, self.port), self.timeout)
        try:
            if self.tls:
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=self.host)
            self.sock = sock
            self.transport = sock
        except BaseException:
            sock.close()
            raise


def fetch_external_link_metadata(value: Any) -> dict[str, str]:
    deadline = monotonic() + 4
    url = value
    try:
        for _ in range(5):
            url, parsed, address = _public_link_target(url)
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise TimeoutError()
            connection = _PinnedPublicConnection(parsed, address, remaining)
            try:
                path = (parsed.path or "/") + (("?" + parsed.query) if parsed.query else "")
                connection.request("GET", path, headers={"Accept": "text/html,text/plain;q=0.5", "Accept-Encoding": "identity", "User-Agent": "EagleIDE-LinkPreview/1.0"})
                response = connection.getresponse()
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.getheader("Location")
                    if not location:
                        raise LessonPlanDataError("Invalid external page redirect")
                    url = urljoin(url, location)
                    continue
                if response.status >= 400 or response.getheader("Content-Encoding", "identity").lower() not in {"", "identity"}:
                    raise LessonPlanDataError("Could not read that external page")
                content_type = response.headers.get_content_type().casefold()
                charset = response.headers.get_content_charset() or "utf-8"
                body = bytearray()
                while len(body) <= LINK_PREVIEW_MAX_BYTES:
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise TimeoutError()
                    connection.transport.settimeout(remaining)
                    chunk = response.read1(min(16384, LINK_PREVIEW_MAX_BYTES + 1 - len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                if len(body) > LINK_PREVIEW_MAX_BYTES:
                    raise LessonPlanDataError("That page is too large to preview")
                break
            finally:
                connection.close()
        else:
            raise LessonPlanDataError("Too many external page redirects")
    except (OSError, TimeoutError, http.client.HTTPException, UnicodeError) as exc:
        raise LessonPlanDataError("Could not read that external page") from exc
    title = str(parsed.hostname or "External link").removeprefix("www.")
    if content_type in {"text/html", "application/xhtml+xml"}:
        try:
            text = body.decode(charset, errors="replace")
        except LookupError:
            text = body.decode("utf-8", errors="replace")
        match = LINK_TITLE_RE.search(text)
        if match:
            title = " ".join(html_unescape(HTML_TAG_RE.sub("", match.group(1))).replace("\x00", "").split())[:200] or title
    return {"url": url, "title": title}


def register(
    app: Flask,
    *,
    base_dir: Path,
    public_dir: Path,
    wiki_store: Any,
    require_teacher: Callable[[Any], Optional[dict]],
    require_user: Callable[[Any], Optional[dict]],
    find_user: Callable[[str], Optional[dict]],
    get_user_class_ids: Callable[[Optional[dict]], list[str]],
    find_class: Callable[[str], Optional[dict]],
    list_teacher_classes: Optional[Callable[[dict], list[dict]]] = None,
    eagle: Any = None,
) -> LessonPlanStore:
    store = LessonPlanStore(Path(base_dir))
    assets = AgendaAssets(store)
    app.extensions["eagle_lesson_plan_store"] = store
    print_exports: dict[str, dict[str, Any]] = {}
    print_exports_lock = Lock()
    pdf_slots = BoundedSemaphore(2)
    pdf_accounts: set[str] = set()

    def purge_print_exports(now: float) -> None:
        for token, export in list(print_exports.items()):
            if float(export.get("expires_at") or 0) <= now:
                print_exports.pop(token, None)

    def create_print_export(class_id: str, week: str) -> str:
        now = monotonic()
        with print_exports_lock:
            purge_print_exports(now)
            while len(print_exports) >= 256:
                print_exports.pop(next(iter(print_exports)))
            token = token_urlsafe(32)
            print_exports[token] = {
                "class_id": class_id,
                "week": week,
                "expires_at": now + 600,
            }
        return token

    def get_print_export(token: str) -> Optional[dict[str, Any]]:
        now = monotonic()
        with print_exports_lock:
            purge_print_exports(now)
            export = print_exports.get(token)
            return dict(export) if export else None

    def error(message: str, status: int = 400):
        return jsonify(ok=False, error=message), status

    def teacher_class(class_id: str) -> tuple[Optional[dict], Optional[Any]]:
        teacher = require_teacher(request)
        if not teacher:
            return None, error("Teacher token required", 401)
        cls = find_class(class_id)
        teacher_email = str(teacher.get("email") or "").strip().lower()
        if not cls or (str(cls.get("teacher_email") or "").strip().lower() != teacher_email
                       and not (teacher_email in cls.get("coteachers", []) and teacher_email in cls.get("students", []))):
            return None, error("Class not found", 404)
        return cls, None

    def class_summary(cls: dict) -> dict[str, str]:
        return {
            "id": str(cls.get("id") or ""),
            "name": str(cls.get("name") or "Class"),
        }

    def plan_source_class(cls: dict) -> dict:
        class_id = str(cls.get("id") or "")
        source_id = store.resolve_plan_source(class_id)
        source = find_class(source_id) if source_id and source_id != class_id else cls
        target_owner = str(cls.get("teacher_email") or "").strip().casefold()
        source_owner = str((source or {}).get("teacher_email") or "").strip().casefold()
        return source if source and target_owner and source_owner == target_owner else cls

    def empty_plan(week: Any) -> dict[str, Any]:
        week_start = normalize_week_start(week)
        return {
            "week_start": week_start,
            "version": 0,
            "created_at": "",
            "published_at": "",
            "updated_at": "",
            "days": {
                day: {"markdown": "", "wiki_node_ids": [], "external_links": []}
                for day in DAYS
            },
            "notes_markdown": "",
        }

    def hydrate_plan(raw_plan: dict[str, Any], source_id: str, assignments: dict, class_id: str) -> dict[str, Any]:
        result = {
            key: value
            for key, value in raw_plan.items()
            if key != "updated_by"
        }
        result_days: dict[str, dict[str, Any]] = {}
        monday = date.fromisoformat(result["week_start"])
        asset_entries = assets.manifest(source_id, result['week_start'])
        node_cache = {}
        for day_index, day in enumerate(DAYS):
            stored_day = (raw_plan.get("days") or {}).get(day) or {}
            pages: list[dict[str, Any]] = []
            standards: list[dict[str, str]] = []
            seen_standards: set[str] = set()
            links = stored_day.get('wiki_links')
            if links is None:
                links = [{'node_id': node_id, 'anchor': ''} for node_id in stored_day.get('wiki_node_ids') or []]
            for link in links:
                node_id, anchor = link['node_id'], link.get('anchor') or ''
                if node_id not in node_cache:
                    node_cache[node_id] = wiki_store.get_node(node_id, include_drafts=False, include_content=False)
                node = node_cache[node_id]
                if not node or node.get("kind") != "page":
                    continue
                section = next((section for section in node.get('sections', []) if section['anchor'] == anchor), None)
                if anchor and not section:
                    continue
                page_standards = [
                    {
                        "id": str(standard.get("id") or ""),
                        "standard_id": str(standard.get("standard_id") or ""),
                        "description": str(standard.get("description") or ""),
                    }
                    for standard in node.get("standards") or []
                ]
                pages.append({
                    "id": str(node.get("id") or ""),
                    "title": str(node.get("title") or "Wiki page"),
                    "anchor": anchor,
                    "section_title": section['heading'] if section else '',
                    "slug": str(node.get("slug") or ""),
                    "description": str(node.get("description") or ""),
                    "url": f"/wiki/{node.get('slug') or ''}" + (f'#{anchor}' if anchor else ''),
                    "standards": page_standards,
                })
                for standard in page_standards:
                    identity = standard["id"] or standard["standard_id"].casefold()
                    if identity and identity not in seen_standards:
                        seen_standards.add(identity)
                        standards.append(standard)
            result_days[day] = {
                "date": (monday + timedelta(days=day_index)).isoformat(),
                "markdown": str(stored_day.get("markdown") or ""),
                "color": stored_day.get('color') or '',
                "wiki_links": [{'node_id': page['id'], 'anchor': page['anchor']} for page in pages],
                "attachment_ids": stored_day.get('attachment_ids') or [],
                "attachments": [entry for asset_id in stored_day.get('attachment_ids') or []
                                if (entry := asset_entries.get(asset_id)) and entry['kind'] == 'file'],
                "assignment_ids": [item for item in stored_day.get('assignment_ids') or [] if item in assignments],
                "assignments": [assignments[item] for item in stored_day.get('assignment_ids') or [] if item in assignments],
                "images": [{'id': asset_id, 'url': f"/api/lesson-plans/{class_id}/{result['week_start']}/assets/{asset_id}"}
                           for asset_id in dict.fromkeys(IMAGE_REF.findall(stored_day.get('markdown') or ''))
                           if asset_entries.get(asset_id, {}).get('kind') == 'image'],
                "wiki_node_ids": [page["id"] for page in pages],
                "wiki_pages": pages,
                "external_links": [
                    {
                        "url": str(link.get("url") or ""),
                        "title": str(link.get("title") or "External link"),
                    }
                    for link in stored_day.get("external_links") or []
                    if isinstance(link, dict)
                ],
                "standards": standards,
            }
        result["days"] = result_days
        return result

    def agenda_assignments(cls, student=None, teacher=False):
        if eagle is None or not (student or teacher):
            return {}
        result = {}
        for assignment in eagle._list_assignments():
            if assignment.get('targetClassId') != cls['id']:
                continue
            if not teacher and not (assignment.get('releasedAt') or assignment.get('active')):
                continue
            summary = {'id': assignment['id'], 'name': assignment.get('name') or 'Assignment',
                       'dueAt': assignment.get('dueAt') or '', 'fileControl': bool(assignment.get('fileControl'))}
            if student:
                summary.update(eagle.assignment_workflow.student_state(eagle, assignment, student['email']))
                if summary.get('accommodationNote') == 'Make-up / retest deadline':
                    summary['accommodationNote'] = 'Deadline adjusted by your teacher'
            result[summary['id']] = summary
        return result

    def response_payload(
        cls: dict,
        week: Any,
        *,
        include_empty: bool,
        through: Any = None,
        include_source: bool = False,
        student: Optional[dict] = None,
        public: bool = False,
    ):
        selected = normalize_week_start(week)
        source_class = plan_source_class(cls)
        source_class_id = str(source_class.get("id") or "")
        plan = store.get_plan(source_class_id, selected)
        if plan is None and include_empty:
            plan = empty_plan(selected)
        if through is None:
            nav = store.navigation(source_class_id, selected)
        else:
            latest = normalize_week_start(through)
            selected_date = date.fromisoformat(selected)
            try:
                previous_week = (selected_date - timedelta(days=7)).isoformat()
            except OverflowError:
                previous_week = None
            try:
                following_week = (selected_date + timedelta(days=7)).isoformat()
            except OverflowError:
                following_week = None
            nav = {
                "previous_week": previous_week,
                "next_week": (
                    following_week
                    if selected < latest and following_week
                    else None
                ),
            }
        assignments = agenda_assignments(source_class if include_source else cls, student, include_source)
        hydrated = hydrate_plan(plan, source_class_id, assignments, cls['id']) if plan else None
        if hydrated and public and not hydrated.get('notes_public', False):
            hydrated.pop('notes_markdown', None)
        zone = (cls.get('settings') or {}).get('assignment_submission_window', {}).get('timeZone') or 'UTC'
        try:
            zone_info = ZoneInfo(zone)
        except (KeyError, ValueError):
            zone, zone_info = 'UTC', ZoneInfo('UTC')
        if hydrated and student:
            by_date = {}
            for item in assignments.values():
                if item['dueAt']:
                    due_date = datetime.fromisoformat(item['dueAt'].replace('Z', '+00:00')).astimezone(zone_info).date().isoformat()
                    by_date.setdefault(due_date, []).append({**item, 'due_date': due_date})
            for day in hydrated['days'].values():
                day['due_assignments'] = by_date.get(day['date'], [])
            hydrated['weekend_due_assignments'] = [item for offset in (5, 6)
                for item in by_date.get((date.fromisoformat(selected) + timedelta(days=offset)).isoformat(), [])]
        payload = {
            "ok": True,
            "class": class_summary(cls),
            "plan": hydrated,
            "assignment_choices": list(assignments.values()) if include_source else [],
            "asset_class_id": str(cls['id']),
            "time_zone": zone,
            "selected_week": selected,
            "current_week": normalize_week_start(),
            **nav,
        }
        if include_source:
            payload["plan_source"] = class_summary(source_class)
        return payload

    def sharing_payload(cls: dict, token: str) -> dict[str, Any]:
        root = request.host_url.rstrip("/")
        public_url = f"{root}/lesson-plans/public/{token}"
        current_url = f"{root}/lesson-plans/current/{token}"
        embed_url = f"{root}/lesson-plans/embed/{token}"
        public_path = f"/lesson-plans/public/{token}"
        current_path = f"/lesson-plans/current/{token}"
        embed_path = f"/lesson-plans/embed/{token}"
        return {
            "ok": True,
            "class": class_summary(cls),
            "public_url": public_url,
            "current_url": current_url,
            "embed_url": embed_url,
            "public_path": public_path,
            "current_path": current_path,
            "embed_path": embed_path,
            "embed_code": (
                f'<iframe src="{embed_url}" title="{html_escape(class_summary(cls)["name"], quote=True)} lesson plan" '
                'style="width:100%;aspect-ratio:16/9;border:0" loading="lazy"></iframe>'
            ),
        }

    @app.get("/api/teacher/classes/<class_id>/lesson-plans")
    def teacher_get_lesson_plan(class_id: str):
        cls, failure = teacher_class(class_id)
        if failure:
            return failure
        try:
            return jsonify(
                **response_payload(
                    cls,
                    request.args.get("week"),
                    include_empty=True,
                    include_source=True,
                )
            )
        except LessonPlanDataError as exc:
            return error(str(exc))

    @app.put("/api/teacher/classes/<class_id>/lesson-plans/<week>")
    def teacher_put_lesson_plan(class_id: str, week: str):
        cls, failure = teacher_class(class_id)
        if failure:
            return failure
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return error("Lesson plan data must be an object")
        try:
            expected_version = body.get("expected_version")
            if expected_version is not None and (
                isinstance(expected_version, bool) or not isinstance(expected_version, int)
            ):
                raise LessonPlanDataError("expected_version must be an integer")
            teacher = require_teacher(request) or {}
            source_class = plan_source_class(cls)
            if teacher.get("is_coteacher") and source_class.get("id") != class_id and teacher.get("email") not in source_class.get("coteachers", []):
                return error("The owner must edit this linked source plan", 403)
            from lesson_plan_store import normalize_plan_payload
            normalized = normalize_plan_payload(body)
            available_assignments = agenda_assignments(source_class, teacher=True)
            # Keep resource validation and publication atomic with media removal.
            # Assignment reads precede this lock to preserve assignment -> plan lock order.
            with store._lock:
                asset_entries = assets.manifest(source_class['id'], week)
                for day in normalized['days'].values():
                    if any(item not in available_assignments for item in day['assignment_ids']):
                        return error('Select assignments belonging to the plan source class')
                    selections = [(asset_id, 'file') for asset_id in day['attachment_ids']]
                    selections += [(asset_id, 'image') for asset_id in IMAGE_REF.findall(day['markdown'])]
                    for asset_id, kind in selections:
                        if asset_entries.get(asset_id, {}).get('kind') != kind:
                            return error('An agenda image or file is unavailable. Insert it again.')
                previous = store.get_plan(source_class['id'], week)
                saved = store.save_plan(
                    str(source_class.get("id") or class_id),
                    week,
                    body,
                    expected_version=expected_version,
                    updated_by=str(teacher.get("email") or ""),
                )
                try:
                    assets.prune_removed(source_class['id'], week, previous, saved)
                except OSError:
                    app.logger.warning('Could not reclaim removed agenda media after publishing')
            payload = response_payload(
                cls,
                saved["week_start"],
                include_empty=True,
                include_source=True,
            )
            return jsonify(**payload)
        except LessonPlanConflictError as exc:
            return error(str(exc), 409)
        except (LessonPlanDataError, ValueError) as exc:
            return error(str(exc))

    @app.put("/api/teacher/classes/<class_id>/lesson-plans/source")
    def teacher_put_lesson_plan_source(class_id: str):
        if (require_teacher(request) or {}).get("is_coteacher"):
            return error("Class owner required", 403)
        cls, failure = teacher_class(class_id)
        if failure:
            return failure
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return error("Lesson plan source data must be an object")
        source_id = str(body.get("source_class_id") or "").strip()
        if source_id:
            source = find_class(source_id)
            owner = str(cls.get("teacher_email") or "").strip().casefold()
            source_owner = str((source or {}).get("teacher_email") or "").strip().casefold()
            if not source or source_owner != owner:
                return error("Source class not found", 404)
        try:
            store.set_plan_source(class_id, source_id)
            return jsonify(
                **response_payload(
                    cls,
                    body.get("week") or request.args.get("week"),
                    include_empty=True,
                    include_source=True,
                )
            )
        except LessonPlanDataError as exc:
            return error(str(exc))

    @app.post("/api/teacher/lesson-plans/link-preview")
    def teacher_lesson_plan_link_preview():
        if not require_teacher(request):
            return error("Teacher token required", 401)
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return error("External link data must be an object")
        try:
            return jsonify(ok=True, link=fetch_external_link_metadata(body.get("url")))
        except LessonPlanDataError as exc:
            return error(str(exc))

    @app.post("/api/teacher/classes/<class_id>/lesson-plans/sharing")
    def teacher_lesson_plan_sharing(class_id: str):
        if (require_teacher(request) or {}).get("is_coteacher"):
            return error("Class owner required", 403)
        cls, failure = teacher_class(class_id)
        if failure:
            return failure
        return jsonify(**sharing_payload(cls, store.ensure_public_token(class_id)))

    @app.post("/api/teacher/classes/<class_id>/lesson-plans/sharing/reset")
    def teacher_reset_lesson_plan_sharing(class_id: str):
        if (require_teacher(request) or {}).get("is_coteacher"):
            return error("Class owner required", 403)
        cls, failure = teacher_class(class_id)
        if failure:
            return failure
        return jsonify(**sharing_payload(cls, store.reset_public_token(class_id)))

    @app.post("/api/teacher/classes/<class_id>/lesson-plans/<week>/print")
    def teacher_lesson_plan_print(class_id: str, week: str):
        cls, failure = teacher_class(class_id)
        if failure:
            return failure
        try:
            selected = normalize_week_start(week)
        except LessonPlanDataError as exc:
            return error(str(exc))
        token = create_print_export(str(cls.get("id") or ""), selected)
        return jsonify(
            ok=True,
            print_path=f"/lesson-plans/print/{token}",
            expires_in_seconds=600,
        )

    @app.post('/api/teacher/lesson-plans/<week>/print-all')
    def teacher_print_all_lesson_plans(week: str):
        teacher = require_teacher(request)
        if not teacher:
            return error('Teacher token required', 401)
        email = str(teacher.get('email') or '').lower()
        if not pdf_slots.acquire(blocking=False):
            return error('Two PDFs are being prepared. Try again shortly.', 429)
        admitted = False
        try:
            with print_exports_lock:
                if email in pdf_accounts:
                    return error('Your PDF is already being prepared.', 429)
                pdf_accounts.add(email)
                admitted = True
            from lesson_plan_pdf import MAX_CLASSES, MAX_IMAGE_BYTES, render_week_pdf
            import io
            selected = normalize_week_start(week)
            candidates = list_teacher_classes(teacher) if list_teacher_classes else (eagle._load_classes().get('classes', []) if eagle else [])
            classes = [cls for cls in candidates if cls.get('teacher_email', '').lower() == email or
                       (email in cls.get('coteachers', []) and email in cls.get('students', []))]
            classes.sort(key=lambda cls: (str(cls.get('name') or '').casefold(), str(cls.get('id'))))
            if len(classes) > MAX_CLASSES:
                return error(f'At most {MAX_CLASSES} classes can be exported at once', 413)
            catalog = eagle._list_assignments() if eagle else []
            plans, images, raw_cache = [], {}, {}
            image_bytes = 0
            with store._lock:
                for cls in classes:
                    source = plan_source_class(cls)
                    source_id = source['id']
                    if source_id not in raw_cache:
                        raw_cache[source_id] = store.get_plan(source_id, selected) or empty_plan(selected)
                    assignment_choices = {item['id']: {'id': item['id'], 'name': item.get('name') or 'Assignment'}
                        for item in catalog if item.get('targetClassId') == source_id}
                    plan = hydrate_plan(raw_cache[source_id], source_id, assignment_choices, cls['id'])
                    plans.append({'class': class_summary(cls), 'plan': plan, 'source_id': source_id})
                    for day in plan['days'].values():
                        for image in day.get('images') or []:
                            key = (source_id, image['id'])
                            if key in images:
                                continue
                            entry = assets.get(source_id, selected, image['id'])
                            if not entry or entry['kind'] != 'image':
                                continue
                            image_bytes += entry['size']
                            if image_bytes > MAX_IMAGE_BYTES:
                                return error('This week exceeds the PDF image limit (32 MB)', 413)
                            with (assets.directory(source_id, selected) / f'{image["id"]}.bin').open('rb') as handle:
                                images[key] = handle.read(entry['size'] + 1)
            document = render_week_pdf(plans, selected, images)
            if not require_teacher(request) or any(teacher_class(cls['id'])[1] for cls in classes):
                return error('Class access changed. Prepare the PDF again.', 403)
            response = send_file(io.BytesIO(document), mimetype='application/pdf', as_attachment=False,
                                 download_name=f'lesson-plans-week-{selected}.pdf')
            response.headers['Cache-Control'] = 'private, no-store'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            return response
        except (ValueError, OSError) as exc:
            return error(str(exc) if isinstance(exc, ValueError) else 'Could not read the published agenda media', 422)
        finally:
            if admitted:
                with print_exports_lock:
                    pdf_accounts.discard(email)
            pdf_slots.release()

    @app.get("/api/classes/<class_id>/lesson-plans")
    def student_get_lesson_plan(class_id: str):
        user = require_user(request)
        if not user:
            return error("Student token required", 401)
        fresh = find_user(str(user.get("email") or "")) or user
        cls = find_class(class_id)
        if not cls or class_id not in get_user_class_ids(fresh):
            return error("Class not found", 404)
        try:
            current = normalize_week_start()
            selected = normalize_week_start(request.args.get("week"))
            if selected > current:
                return error("Future lesson plans are not available", 404)
            return jsonify(**response_payload(cls, selected, include_empty=True, through=current, student=fresh))
        except LessonPlanDataError as exc:
            return error(str(exc))

    @app.get("/api/lesson-plans/public/<token>")
    def public_get_lesson_plan(token: str):
        class_id = store.class_id_for_token(token)
        cls = find_class(class_id) if class_id else None
        if not cls:
            return error("Lesson plan not found", 404)
        try:
            current = normalize_week_start()
            selected = normalize_week_start(request.args.get("week"))
            if selected > current:
                return error("Future lesson plans are not available", 404)
            return jsonify(**response_payload(cls, selected, include_empty=True, through=current, public=True))
        except LessonPlanDataError as exc:
            return error(str(exc))

    @app.get("/api/lesson-plans/current/<token>")
    def public_get_current_lesson_plan(token: str):
        class_id = store.class_id_for_token(token)
        cls = find_class(class_id) if class_id else None
        if not cls:
            return error("Lesson plan not found", 404)
        current = normalize_week_start()
        return jsonify(**response_payload(cls, current, include_empty=True, through=current, public=True))

    @app.get("/api/lesson-plans/print/<token>")
    def teacher_print_lesson_plan_data(token: str):
        export = get_print_export(token)
        cls = find_class(str(export.get("class_id") or "")) if export else None
        if not export or not cls:
            return error("Print export not found or expired", 404)
        payload = response_payload(cls, export["week"], include_empty=True)
        payload["previous_week"] = None
        payload["next_week"] = None
        return jsonify(**payload)

    @app.get("/lesson-plans/public/<token>")
    @app.get("/lesson-plans/current/<token>")
    @app.get("/lesson-plans/embed/<token>")
    def public_lesson_plan_page(token: str):
        class_id = store.class_id_for_token(token)
        if not class_id or not find_class(class_id):
            return send_from_directory(public_dir, "lesson_plan_public.html"), 404
        return send_from_directory(public_dir, "lesson_plan_public.html")

    @app.get("/lesson-plans/print/<token>")
    def teacher_print_lesson_plan_page(token: str):
        export = get_print_export(token)
        if not export or not find_class(str(export.get("class_id") or "")):
            return send_from_directory(public_dir, "lesson_plan_public.html"), 404
        return send_from_directory(public_dir, "lesson_plan_public.html")

    register_resources(app, store=store, assets=assets, teacher_class=teacher_class,
        plan_source_class=plan_source_class, require_teacher=require_teacher,
        require_user=require_user, find_user=find_user, get_user_class_ids=get_user_class_ids,
        find_class=find_class, get_print_export=get_print_export, eagle=eagle)
    return store
