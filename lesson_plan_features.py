"""Lesson-plan APIs and public page routes for EagleIDE."""

from __future__ import annotations

from datetime import date, timedelta
from html import escape as html_escape
from pathlib import Path
from secrets import token_urlsafe
from threading import Lock
from time import monotonic
from typing import Any, Callable, Optional

from flask import Flask, jsonify, request, send_from_directory

from lesson_plan_store import (
    DAYS,
    LessonPlanConflictError,
    LessonPlanDataError,
    LessonPlanStore,
    normalize_week_start,
)


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

    def empty_plan(week: Any) -> dict[str, Any]:
        week_start = normalize_week_start(week)
        return {
            "week_start": week_start,
            "version": 0,
            "created_at": "",
            "published_at": "",
            "updated_at": "",
            "days": {
                day: {"markdown": "", "wiki_node_ids": []}
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
                "standards": standards,
            }
        result["days"] = result_days
        return result

    def response_payload(cls: dict, week: Any, *, include_empty: bool, through: Any = None):
        selected = normalize_week_start(week)
        plan = store.get_plan(str(cls.get("id") or ""), selected)
        if plan is None and include_empty:
            plan = empty_plan(selected)
        if through is None:
            nav = store.navigation(str(cls.get("id") or ""), selected)
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
        return {
            "ok": True,
            "class": class_summary(cls),
            "plan": hydrate_plan(plan) if plan else None,
            "selected_week": selected,
            "current_week": normalize_week_start(),
            **nav,
        }

    def sharing_payload(cls: dict, token: str) -> dict[str, Any]:
        root = request.host_url.rstrip("/")
        public_url = f"{root}/lesson-plans/public/{token}"
        embed_url = f"{root}/lesson-plans/embed/{token}"
        public_path = f"/lesson-plans/public/{token}"
        embed_path = f"/lesson-plans/embed/{token}"
        return {
            "ok": True,
            "class": class_summary(cls),
            "public_url": public_url,
            "embed_url": embed_url,
            "public_path": public_path,
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
            return jsonify(**response_payload(cls, request.args.get("week"), include_empty=True))
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
            saved = store.save_plan(
                class_id,
                week,
                body,
                expected_version=expected_version,
                updated_by=str(teacher.get("email") or ""),
            )
            payload = response_payload(cls, saved["week_start"], include_empty=True)
            return jsonify(**payload)
        except LessonPlanConflictError as exc:
            return error(str(exc), 409)
        except (LessonPlanDataError, ValueError) as exc:
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
