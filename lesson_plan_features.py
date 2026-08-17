"""Lesson-plan APIs and public page routes for EagleIDE."""

from __future__ import annotations

from datetime import date, timedelta
from html import escape as html_escape, unescape as html_unescape
from ipaddress import ip_address
from pathlib import Path
import re
from secrets import token_urlsafe
import socket
from threading import Lock
from time import monotonic
from typing import Any, Callable, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from flask import Flask, jsonify, request, send_from_directory

from lesson_plan_store import (
    DAYS,
    LessonPlanConflictError,
    LessonPlanDataError,
    LessonPlanStore,
    normalize_external_url,
    normalize_week_start,
)


LINK_PREVIEW_MAX_BYTES = 131_072
LINK_TITLE_RE = re.compile(r"<title\b[^>]*>(.*?)</title\s*>", re.IGNORECASE | re.DOTALL)
HTML_TAG_RE = re.compile(r"<[^>]+>")


def _public_link_url(value: Any) -> str:
    url = normalize_external_url(value)
    parsed = urlsplit(url)
    host = str(parsed.hostname or "")
    port = parsed.port or (443 if parsed.scheme.casefold() == "https" else 80)
    try:
        addresses = {
            item[4][0].split("%", 1)[0]
            for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        }
    except OSError as exc:
        raise LessonPlanDataError("Could not resolve that external link") from exc
    if not addresses:
        raise LessonPlanDataError("Could not resolve that external link")
    try:
        if any(not ip_address(address).is_global for address in addresses):
            raise LessonPlanDataError("External link previews cannot access private networks")
    except ValueError as exc:
        raise LessonPlanDataError("Could not resolve that external link") from exc
    return url


class _SafeLinkRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url = _public_link_url(urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, safe_url)


def fetch_external_link_metadata(value: Any) -> dict[str, str]:
    url = _public_link_url(value)
    parsed = urlsplit(url)
    fallback = str(parsed.hostname or "External link").removeprefix("www.")
    request_data = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
            "Accept-Encoding": "identity",
            "User-Agent": "EagleIDE-LinkPreview/1.0",
        },
    )
    try:
        with build_opener(_SafeLinkRedirectHandler()).open(request_data, timeout=4) as response:
            final_url = _public_link_url(response.geturl())
            content_type = str(response.headers.get_content_type() or "").casefold()
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read(LINK_PREVIEW_MAX_BYTES + 1)
            if len(body) > LINK_PREVIEW_MAX_BYTES:
                raise LessonPlanDataError("That page is too large to preview")
    except LessonPlanDataError:
        raise
    except (HTTPError, URLError, OSError, TimeoutError) as exc:
        raise LessonPlanDataError("Could not read that external page") from exc
    title = fallback
    if content_type in {"text/html", "application/xhtml+xml"}:
        try:
            text = body.decode(charset, errors="replace")
        except LookupError:
            text = body.decode("utf-8", errors="replace")
        match = LINK_TITLE_RE.search(text)
        if match:
            title = " ".join(
                html_unescape(HTML_TAG_RE.sub("", match.group(1))).replace("\x00", "").split()
            )[:200] or fallback
    return {"url": final_url, "title": title}


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
) -> LessonPlanStore:
    store = LessonPlanStore(Path(base_dir))
    app.extensions["eagle_lesson_plan_store"] = store
    print_exports: dict[str, dict[str, Any]] = {}
    print_exports_lock = Lock()

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
        if not cls or str(cls.get("teacher_email") or "").strip().lower() != teacher_email:
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

    def hydrate_plan(raw_plan: dict[str, Any]) -> dict[str, Any]:
        result = {
            key: value
            for key, value in raw_plan.items()
            if key != "updated_by"
        }
        result_days: dict[str, dict[str, Any]] = {}
        monday = date.fromisoformat(result["week_start"])
        for day_index, day in enumerate(DAYS):
            stored_day = (raw_plan.get("days") or {}).get(day) or {}
            pages: list[dict[str, Any]] = []
            standards: list[dict[str, str]] = []
            seen_standards: set[str] = set()
            for node_id in stored_day.get("wiki_node_ids") or []:
                node = wiki_store.get_node(node_id, include_drafts=False, include_content=False)
                if not node or node.get("kind") != "page":
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
                    "slug": str(node.get("slug") or ""),
                    "description": str(node.get("description") or ""),
                    "url": f"/wiki/{node.get('slug') or ''}",
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

    def response_payload(
        cls: dict,
        week: Any,
        *,
        include_empty: bool,
        through: Any = None,
        include_source: bool = False,
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
        payload = {
            "ok": True,
            "class": class_summary(cls),
            "plan": hydrate_plan(plan) if plan else None,
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
            saved = store.save_plan(
                str(source_class.get("id") or class_id),
                week,
                body,
                expected_version=expected_version,
                updated_by=str(teacher.get("email") or ""),
            )
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
        cls, failure = teacher_class(class_id)
        if failure:
            return failure
        return jsonify(**sharing_payload(cls, store.ensure_public_token(class_id)))

    @app.post("/api/teacher/classes/<class_id>/lesson-plans/sharing/reset")
    def teacher_reset_lesson_plan_sharing(class_id: str):
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
            return jsonify(**response_payload(cls, selected, include_empty=True, through=current))
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
            return jsonify(**response_payload(cls, selected, include_empty=True, through=current))
        except LessonPlanDataError as exc:
            return error(str(exc))

    @app.get("/api/lesson-plans/current/<token>")
    def public_get_current_lesson_plan(token: str):
        class_id = store.class_id_for_token(token)
        cls = find_class(class_id) if class_id else None
        if not cls:
            return error("Lesson plan not found", 404)
        current = normalize_week_start()
        return jsonify(**response_payload(cls, current, include_empty=True, through=current))

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

    return store
