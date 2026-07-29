"""Flask routes for EagleIDE's public wiki and protected authoring tools."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from flask import Flask, jsonify, request, send_file

from wiki_store import MAX_PAGE_BYTES, ASSET_TYPES, WikiStore, safe_filename, safe_title


MAX_STANDARDS_CSV_BYTES = 1024 * 1024


def register(
    app: Flask,
    *,
    base_dir: Path,
    backup_dir: Path,
    require_admin: Callable[[Any], bool],
    require_teacher: Callable[[Any], Optional[dict]],
    require_user: Callable[[Any], Optional[dict]],
    find_user: Callable[[str], Optional[dict]],
    get_user_class_ids: Callable[[Optional[dict]], list[str]],
    find_class: Callable[[str], Optional[dict]],
    config_provider: Callable[[], dict],
) -> WikiStore:
    cfg = config_provider()
    max_asset_mb = max(1, min(4096, int(cfg.get("wiki_max_asset_mb", 1024))))
    total_asset_mb = max(max_asset_mb, min(102_400, int(cfg.get("wiki_total_asset_mb", 10_240))))
    store = WikiStore(
        Path(base_dir),
        backup_dir=Path(backup_dir),
        max_asset_bytes=max_asset_mb * 1024 * 1024,
        max_total_asset_bytes=total_asset_mb * 1024 * 1024,
    )
    app.extensions["eagle_wiki_store"] = store
    backup_tickets: dict[str, dict[str, Any]] = {}
    backup_ticket_lock = threading.Lock()

    def _clean_backup_tickets() -> None:
        now = time.time()
        expired: list[Path] = []
        with backup_ticket_lock:
            for ticket, item in list(backup_tickets.items()):
                if float(item["expires_at"]) <= now:
                    expired.append(Path(item["path"]))
                    backup_tickets.pop(ticket, None)
        for path in expired:
            path.unlink(missing_ok=True)

    def _json_error(message: str, status: int = 400):
        return jsonify(ok=False, error=message), status

    def _admin_required():
        if not require_admin(request):
            return None, _json_error("Admin token required", 401)
        return {"role": "admin"}, None

    def _actor() -> Optional[dict]:
        teacher = require_teacher(request)
        if teacher:
            return {**teacher, "role": "teacher"}
        user = require_user(request)
        if user:
            fresh = find_user(str(user.get("email") or "")) or user
            return {**fresh, "role": "student"}
        if require_admin(request):
            return {"role": "admin", "email": ""}
        return None

    def _teacher_class(teacher: dict, class_id: str) -> Optional[dict]:
        cls = find_class(class_id)
        if not cls:
            return None
        if str(cls.get("teacher_email") or "").strip().lower() != str(teacher.get("email") or "").strip().lower():
            return None
        return cls

    def _class_name(class_id: str) -> str:
        cls = find_class(class_id)
        return str(cls.get("name") or "Class") if cls else "Class"

    def _bookmark_payload(actor: dict, selected_class_id: str = "") -> list[dict[str, Any]]:
        role = actor.get("role")
        email = str(actor.get("email") or "").strip().lower()
        class_ids = get_user_class_ids(actor) if role == "student" else []
        raw = store.list_bookmarks(
            email,
            class_ids=class_ids,
            role=role,
            selected_class_id=selected_class_id,
        )
        merged: dict[str, dict[str, Any]] = {}
        for item in raw:
            target = merged.setdefault(item["node_id"], {
                "node_id": item["node_id"],
                "title": item["title"],
                "slug": item["slug"],
                "kind": item["node_kind"],
                "description": item["description"],
                "labels": [],
                "lesson_classes": [],
                "created_at": item["created_at"],
            })
            if item["created_at"] > target["created_at"]:
                target["created_at"] = item["created_at"]
            if item["kind"] == "personal":
                if "Bookmarked" not in target["labels"]:
                    target["labels"].append("Bookmarked")
            else:
                if "Lesson Material" not in target["labels"]:
                    target["labels"].append("Lesson Material")
                target["lesson_classes"].append({
                    "id": item["class_id"],
                    "name": _class_name(item["class_id"]),
                    "teacher_email": item["owner_email"],
                })
        return sorted(merged.values(), key=lambda item: item["created_at"], reverse=True)

    @app.get("/api/wiki/tree")
    def wiki_tree():
        response = jsonify(ok=True, tree=store.get_tree(), catalog_version=store.catalog_version())
        response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300"
        response.set_etag(f"wiki-tree-{store.catalog_version()}")
        return response.make_conditional(request)

    @app.get("/api/wiki/home")
    def wiki_home():
        actor = _actor()
        class_id = str(request.args.get("class_id") or "").strip()
        features: list[dict[str, Any]] = []
        bookmarks: list[dict[str, Any]] = []
        active_class = None
        if actor and actor.get("role") == "teacher" and class_id:
            active_class = _teacher_class(actor, class_id)
        elif actor and actor.get("role") == "student" and class_id:
            if class_id in get_user_class_ids(actor):
                active_class = find_class(class_id)
        if active_class:
            features = store.list_class_features(class_id)
        if actor and actor.get("role") in {"student", "teacher"}:
            bookmarks = _bookmark_payload(actor, class_id if actor.get("role") == "teacher" else "")
        return jsonify(
            ok=True,
            tree=store.get_tree(),
            featured=features,
            bookmarks=bookmarks,
            home_settings=store.home_settings(),
            active_class={"id": active_class.get("id"), "name": active_class.get("name")} if active_class else None,
            catalog_version=store.catalog_version(),
        )

    @app.get("/api/wiki/standards/coverage")
    def wiki_standards_coverage():
        try:
            payload = store.standards_coverage(request.args.get("folder_id") or "")
        except ValueError as exc:
            return _json_error(str(exc), 404)
        catalog_version = store.catalog_version()
        response = jsonify(ok=True, **payload, catalog_version=catalog_version)
        response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300"
        response.set_etag(
            f"wiki-standards-coverage-{catalog_version}-{payload.get('folder_id') or 'all'}"
        )
        return response.make_conditional(request)

    @app.get("/api/wiki/nodes/<identifier>")
    def wiki_node(identifier: str):
        payload = store.page_response(identifier)
        if not payload:
            store.record_analytics("not_found", identifier)
            return _json_error("Wiki item not found", 404)
        store.record_analytics("page_view", payload["node"]["id"])
        response = jsonify(ok=True, **payload)
        response.headers["Cache-Control"] = "public, max-age=60, stale-while-revalidate=300"
        response.set_etag(f"wiki-{payload['node']['id']}-{payload['node']['version']}-{payload['catalog_version']}")
        return response.make_conditional(request)

    @app.get("/api/wiki/previews/<identifier>")
    def wiki_preview(identifier: str):
        payload = store.preview(
            identifier,
            term=request.args.get("term") or "",
            anchor=request.args.get("anchor") or "",
        )
        if not payload:
            return _json_error("Wiki item not found", 404)
        response = jsonify(ok=True, preview=payload)
        response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=600"
        return response

    @app.get("/api/wiki/search")
    def wiki_search():
        query = str(request.args.get("q") or "").strip()[:200]
        if len(query) < 2:
            return jsonify(ok=True, results=[], query=query)
        try:
            limit = int(request.args.get("limit", 20))
            offset = int(request.args.get("offset", 0))
        except Exception:
            limit, offset = 20, 0
        limit = max(1, min(50, limit))
        offset = max(0, min(10_000, offset))
        results = store.search(query, limit=limit, offset=offset)
        response = jsonify(ok=True, query=query, results=results)
        version = store.catalog_version()
        query_key = hashlib.sha256(query.casefold().encode("utf-8")).hexdigest()[:16]
        response.headers["Cache-Control"] = "public, max-age=30, stale-while-revalidate=120"
        response.set_etag(f"wiki-search-{version}-{query_key}-{limit}-{offset}")
        return response.make_conditional(request)

    @app.post("/api/wiki/search/complete")
    def wiki_search_complete():
        data = request.get_json(silent=True) or {}
        query = str(data.get("query") or "").strip()[:200]
        if len(query) < 2:
            return _json_error("A completed search requires at least two characters", 400)
        result_id = str(data.get("result_id") or "").strip().lower()
        result = store.get_node(result_id, include_content=False) if re.fullmatch(r"[0-9a-f]{32}", result_id) else None
        results = [result] if result else store.search(query, limit=1, offset=0)
        store.record_analytics("search_completed", query)
        if not results:
            store.record_analytics("search_no_results_completed", query)
        return jsonify(ok=True, has_results=bool(results))

    @app.get("/api/wiki/media/<node_id>")
    def wiki_media(node_id: str):
        node, path = store.media_path(node_id)
        if not node or not path:
            return _json_error("Wiki file not found", 404)
        suffix = Path(node["file_name"]).suffix.lower()
        force_download = request.args.get("download") == "1" or ASSET_TYPES.get(suffix, ("", "", True))[2]
        mime_type = str(node.get("mime_type") or "application/octet-stream").split(";", 1)[0]
        response = send_file(
            path,
            mimetype=mime_type,
            as_attachment=force_download,
            download_name=node["file_name"],
            conditional=True,
            max_age=3600,
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        if force_download:
            response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        elif node.get("kind") == "image":
            response.headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:"
        elif node.get("kind") == "video":
            response.headers["Content-Security-Policy"] = "default-src 'none'; media-src 'self'"
        return response

    @app.get("/api/wiki/bookmarks")
    def wiki_bookmarks_get():
        actor = _actor()
        if not actor or actor.get("role") not in {"student", "teacher"}:
            return _json_error("Sign in to view bookmarks", 401)
        selected = str(request.args.get("class_id") or "").strip()
        if actor["role"] == "teacher" and selected and not _teacher_class(actor, selected):
            return _json_error("Class not found", 404)
        return jsonify(ok=True, bookmarks=_bookmark_payload(actor, selected))

    @app.put("/api/wiki/bookmarks/<node_id>")
    def wiki_bookmarks_put(node_id: str):
        actor = _actor()
        if not actor or actor.get("role") not in {"student", "teacher"}:
            return _json_error("Sign in to bookmark wiki pages", 401)
        data = request.get_json(silent=True) or {}
        try:
            if actor["role"] == "teacher":
                class_id = str(data.get("class_id") or "").strip()
                if not _teacher_class(actor, class_id):
                    return _json_error("Select one of your classes", 403)
                store.add_lesson_bookmark(actor["email"], class_id, node_id)
            else:
                store.add_personal_bookmark(actor["email"], node_id)
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True)

    @app.delete("/api/wiki/bookmarks/<node_id>")
    def wiki_bookmarks_delete(node_id: str):
        actor = _actor()
        if not actor or actor.get("role") not in {"student", "teacher"}:
            return _json_error("Sign in to manage bookmarks", 401)
        data = request.get_json(silent=True) or {}
        try:
            if actor["role"] == "teacher":
                class_id = str(data.get("class_id") or "").strip()
                if not _teacher_class(actor, class_id):
                    return _json_error("Select one of your classes", 403)
                store.remove_bookmark(actor["email"], node_id, class_id=class_id, kind="lesson_material")
            else:
                store.remove_bookmark(actor["email"], node_id)
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True)

    @app.get("/api/wiki/classes/<class_id>/features")
    def wiki_features_get(class_id: str):
        actor = _actor()
        if actor and actor.get("role") == "teacher":
            if not _teacher_class(actor, class_id):
                return _json_error("Class not found", 404)
        elif actor and actor.get("role") == "student":
            if class_id not in get_user_class_ids(actor):
                return _json_error("Class not found", 404)
        else:
            return _json_error("Authentication required", 401)
        return jsonify(ok=True, featured=store.list_class_features(class_id))

    @app.put("/api/wiki/classes/<class_id>/features/<node_id>")
    def wiki_features_put(class_id: str, node_id: str):
        teacher = require_teacher(request)
        if not teacher:
            return _json_error("Teacher token required", 401)
        if not _teacher_class(teacher, class_id):
            return _json_error("Class not found", 404)
        try:
            store.set_class_feature(class_id, node_id, teacher["email"])
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True)

    @app.delete("/api/wiki/classes/<class_id>/features/<node_id>")
    def wiki_features_delete(class_id: str, node_id: str):
        teacher = require_teacher(request)
        if not teacher:
            return _json_error("Teacher token required", 401)
        if not _teacher_class(teacher, class_id):
            return _json_error("Class not found", 404)
        try:
            store.remove_class_feature(class_id, node_id)
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True)

    @app.get("/api/admin/wiki/tree")
    def admin_wiki_tree():
        _, error = _admin_required()
        if error:
            return error
        include_deleted = request.args.get("include_deleted") == "1"
        return jsonify(
            ok=True,
            tree=store.get_tree(include_drafts=True, include_deleted=include_deleted, include_images=False),
            catalog_version=store.catalog_version(),
        )

    @app.get("/api/admin/wiki/settings")
    def admin_wiki_settings_get():
        _, error = _admin_required()
        if error:
            return error
        return jsonify(ok=True, home_settings=store.home_settings())

    @app.patch("/api/admin/wiki/settings")
    def admin_wiki_settings_update():
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        try:
            settings = store.update_home_settings(
                title=data.get("title"),
                subtitle=data.get("subtitle"),
                standards_markdown=data.get("standards_markdown") if "standards_markdown" in data else None,
                external_resources=data.get("external_resources") if "external_resources" in data else None,
                standards=data.get("standards") if "standards" in data else None,
                footer_text=data.get("footer_text") if "footer_text" in data else None,
            )
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, home_settings=settings, catalog_version=store.catalog_version())

    @app.post("/api/admin/wiki/standards/import")
    def admin_wiki_standards_import():
        _, error = _admin_required()
        if error:
            return error
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            return _json_error("Standards CSV file required", 400)
        if Path(safe_filename(uploaded.filename)).suffix.lower() != ".csv":
            return _json_error("Only .csv files can be imported as standards", 400)
        raw = uploaded.stream.read(MAX_STANDARDS_CSV_BYTES + 1)
        if len(raw) > MAX_STANDARDS_CSV_BYTES:
            return _json_error("Standards CSV exceeds the 1MB limit", 413)
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return _json_error("Standards CSV files must use UTF-8 encoding", 400)
        if "\x00" in text:
            return _json_error("Standards CSV contains invalid characters", 400)
        try:
            csv_reader = csv.DictReader(io.StringIO(text, newline=""))
            fields = {
                re.sub(r"[^a-z0-9]+", "", str(name or "").casefold()): name
                for name in (csv_reader.fieldnames or [])
            }
            id_field = next((fields[key] for key in ("standardid", "standard", "code", "id") if key in fields), None)
            description_field = next((
                fields[key] for key in ("description", "standarddescription", "details")
                if key in fields
            ), None)
            if not id_field or not description_field:
                return _json_error('CSV headers must include "Standard ID" and "Description"', 400)
            standards = []
            for row_number, row in enumerate(csv_reader, start=2):
                standard_id = str(row.get(id_field) or "").strip()
                description = str(row.get(description_field) or "").strip()
                if not standard_id and not description:
                    continue
                if not standard_id or not description:
                    return _json_error(
                        f"CSV row {row_number} requires both a Standard ID and Description", 400
                    )
                standards.append({"standard_id": standard_id, "description": description})
        except csv.Error as exc:
            return _json_error(f"Could not read standards CSV: {exc}", 400)
        try:
            settings = store.import_standards(standards)
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(
            ok=True,
            imported_count=len(standards),
            home_settings=settings,
            catalog_version=store.catalog_version(),
        )

    @app.get("/api/admin/wiki/nodes/<node_id>")
    def admin_wiki_node_get(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        node = store.get_node(node_id, include_drafts=True)
        if not node:
            return _json_error("Wiki item not found", 404)
        return jsonify(ok=True, node=node, revisions=store.list_revisions(node_id) if node["kind"] == "page" else [])

    @app.post("/api/admin/wiki/folders")
    def admin_wiki_folder_create():
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        try:
            node = store.create_folder(data.get("title"), data.get("parent_id"), data.get("icon") or "")
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, node=node), 201

    @app.post("/api/admin/wiki/pages")
    def admin_wiki_page_create():
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        try:
            node = store.create_page(
                data.get("title"), data.get("content") or "", data.get("parent_id"),
                status=data.get("status") or "draft",
                aliases=data.get("aliases") or [],
                description=data.get("description") or "",
                icon=data.get("icon") or "",
                standard_ids=data.get("standard_ids") or [],
            )
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, node=node), 201

    @app.post("/api/admin/wiki/pages/upload")
    def admin_wiki_page_upload():
        _, error = _admin_required()
        if error:
            return error
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            return _json_error("Markdown file required", 400)
        filename = safe_filename(uploaded.filename)
        if Path(filename).suffix.lower() != ".md":
            return _json_error("Only .md files can be uploaded as wiki pages", 400)
        raw = uploaded.stream.read(MAX_PAGE_BYTES + 1)
        if len(raw) > MAX_PAGE_BYTES:
            return _json_error("Markdown page exceeds the 2MB limit", 413)
        try:
            content = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return _json_error("Markdown files must use UTF-8 encoding", 400)
        title = str(request.form.get("title") or "").strip()
        if not title:
            first_heading = re.search(r"^#\s+(.+?)\s*$", content, re.M)
            title = first_heading.group(1).strip() if first_heading else Path(filename).stem
        try:
            node = store.create_page(
                title, content, request.form.get("parent_id") or None,
                status="draft", file_name=filename,
            )
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, node=node), 201

    @app.patch("/api/admin/wiki/nodes/<node_id>")
    def admin_wiki_node_update(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        allowed = {key: data[key] for key in ("title", "slug", "description", "icon", "status", "aliases", "content", "standard_ids") if key in data}
        try:
            node = store.update_node(node_id, **allowed)
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, node=node)

    @app.put("/api/admin/wiki/nodes/<node_id>/draft")
    def admin_wiki_node_draft(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        try:
            draft = store.save_page_draft(node_id, str(data.get("content") or ""))
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, draft=draft)

    @app.post("/api/admin/wiki/nodes/<node_id>/move")
    def admin_wiki_node_move(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        try:
            node = store.move_node(node_id, data.get("parent_id") or None)
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, node=node)

    @app.post("/api/admin/wiki/nodes/<node_id>/reorder")
    def admin_wiki_node_reorder(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        try:
            node = store.reorder_node(node_id, str(data.get("direction") or "down"))
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, node=node)

    @app.post("/api/admin/wiki/nodes/<node_id>/position")
    def admin_wiki_node_position(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        try:
            node = store.position_node(node_id, data.get("target_id"), data.get("position"))
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, node=node)

    @app.delete("/api/admin/wiki/nodes/<node_id>")
    def admin_wiki_node_delete(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        try:
            store.soft_delete(node_id)
        except ValueError as exc:
            return _json_error(str(exc), 404)
        return jsonify(ok=True)

    @app.get("/api/admin/wiki/media")
    def admin_wiki_media_list():
        _, error = _admin_required()
        if error:
            return error
        return jsonify(ok=True, images=store.list_images(), catalog_version=store.catalog_version())

    @app.delete("/api/admin/wiki/media/<node_id>")
    def admin_wiki_media_delete(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        try:
            result = store.delete_image_permanently(node_id)
        except ValueError as exc:
            return _json_error(str(exc), 404)
        return jsonify(ok=True, result=result, catalog_version=store.catalog_version())

    @app.post("/api/admin/wiki/nodes/<node_id>/restore")
    def admin_wiki_node_restore(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        try:
            store.restore_deleted(node_id)
        except ValueError as exc:
            return _json_error(str(exc), 404)
        return jsonify(ok=True)

    @app.get("/api/admin/wiki/nodes/<node_id>/revisions")
    def admin_wiki_revisions(node_id: str):
        _, error = _admin_required()
        if error:
            return error
        try:
            return jsonify(ok=True, revisions=store.list_revisions(node_id))
        except ValueError as exc:
            return _json_error(str(exc), 400)

    @app.post("/api/admin/wiki/nodes/<node_id>/revisions/<revision_id>/restore")
    def admin_wiki_revision_restore(node_id: str, revision_id: str):
        _, error = _admin_required()
        if error:
            return error
        try:
            node = store.restore_revision(node_id, revision_id)
        except ValueError as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, node=node)

    @app.post("/api/admin/wiki/uploads/start")
    def admin_wiki_upload_start():
        _, error = _admin_required()
        if error:
            return error
        data = request.get_json(silent=True) or {}
        try:
            result = store.create_upload_session(
                data.get("filename"), int(data.get("total_size") or 0),
                parent_id=data.get("parent_id") or None,
                title=data.get("title") or "",
                description=data.get("description") or "",
                purpose=data.get("purpose") or "asset",
            )
        except (ValueError, TypeError) as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, **result), 201

    @app.put("/api/admin/wiki/uploads/<upload_id>/chunk")
    def admin_wiki_upload_chunk(upload_id: str):
        _, error = _admin_required()
        if error:
            return error
        try:
            offset = int(request.headers.get("X-Upload-Offset", "0"))
            chunk = request.get_data(cache=False)
            next_offset = store.append_upload_chunk(upload_id, offset, chunk)
        except (ValueError, TypeError) as exc:
            return _json_error(str(exc), 409)
        return jsonify(ok=True, offset=next_offset)

    @app.post("/api/admin/wiki/uploads/<upload_id>/complete")
    def admin_wiki_upload_complete(upload_id: str):
        _, error = _admin_required()
        if error:
            return error
        try:
            result = store.complete_upload(upload_id)
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            return _json_error(str(exc), 400)
        return jsonify(ok=True, result=result)

    @app.get("/api/admin/wiki/backup")
    def admin_wiki_backup():
        _, error = _admin_required()
        if error:
            return error
        try:
            archive = store.create_backup(
                store.backup_dir / f"wiki_download_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.zip"
            )
        except Exception as exc:
            return _json_error(f"Could not create wiki backup: {exc}", 500)
        response = send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"eagleide_wiki_backup_{time.strftime('%Y%m%d_%H%M%S')}.zip",
            conditional=True,
        )
        response.call_on_close(lambda: archive.unlink(missing_ok=True))
        return response

    @app.post("/api/admin/wiki/backup-tickets")
    def admin_wiki_backup_ticket():
        _, error = _admin_required()
        if error:
            return error
        _clean_backup_tickets()
        ticket = uuid.uuid4().hex
        file_name = f"eagleide_wiki_backup_{time.strftime('%Y%m%d_%H%M%S')}.zip"
        try:
            archive = store.create_backup(
                store.backup_dir / f"wiki_download_{time.strftime('%Y%m%d_%H%M%S')}_{ticket[:8]}.zip"
            )
        except Exception as exc:
            return _json_error(f"Could not create wiki backup: {exc}", 500)
        with backup_ticket_lock:
            backup_tickets[ticket] = {
                "path": str(archive),
                "file_name": file_name,
                "expires_at": time.time() + 300,
            }
        return jsonify(
            ok=True,
            download_url=f"/api/admin/wiki/backup-download/{ticket}",
            file_name=file_name,
            expires_in=300,
        ), 201

    @app.get("/api/admin/wiki/backup-download/<ticket>")
    def admin_wiki_backup_download(ticket: str):
        _clean_backup_tickets()
        with backup_ticket_lock:
            item = backup_tickets.pop(ticket, None)
        if not item:
            return _json_error("Backup download link is invalid or expired", 404)
        archive = Path(item["path"])
        if not archive.is_file():
            return _json_error("Backup file is no longer available", 404)
        response = send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name=str(item["file_name"]),
            conditional=True,
        )
        response.headers["Cache-Control"] = "no-store"
        response.call_on_close(lambda: archive.unlink(missing_ok=True))
        return response

    @app.get("/api/admin/wiki/analytics")
    def admin_wiki_analytics():
        _, error = _admin_required()
        if error:
            return error
        return jsonify(ok=True, data=store.analytics_summary())

    return store
