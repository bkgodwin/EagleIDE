"""Generic, opt-in external applications. No upstream application code is installed."""
from __future__ import annotations

import hashlib
import io
import json
import logging
import secrets
import socket
import sqlite3
import threading
import time
import uuid
from types import SimpleNamespace
from urllib.parse import urlsplit

from flask import Response, jsonify, request, send_from_directory

from tool_gateway import (CapabilityLogFilter, Gateway, MAX_UPLOAD, local_addresses,
                          html_body, redirect_path, stream_body)
from tool_store import ToolError, ToolStore, networks
from tool_storage import ToolStorage, CHUNK

LEASE_SECONDS = 90
HARD_SECONDS = 8 * 60 * 60
MAX_INSTANCES = 256
UPLOAD_IDLE_SECONDS = 5
UPLOAD_TOTAL_SECONDS = 15


def read_upload(req):
    """Bound slow writes on the supported threaded Werkzeug listener as well as size."""
    connection = req.environ.get("werkzeug.socket")
    if connection is None and not isinstance(req.environ.get("wsgi.input"), io.BytesIO):
        raise ToolError("This HTTP server does not expose a bounded upload stream", 501)
    reader = req.environ.get("wsgi.input")
    if not hasattr(reader, "read1"):
        raise ToolError("This HTTP server does not expose a bounded upload stream", 501)
    previous = connection.gettimeout() if connection else None
    remaining, parts = req.content_length, []
    deadline = time.monotonic() + UPLOAD_TOTAL_SECONDS
    try:
        while remaining:
            budget = deadline - time.monotonic()
            if budget <= 0:
                raise ToolError("Tool upload timed out", 408)
            if connection:
                connection.settimeout(min(UPLOAD_IDLE_SECONDS, budget))
            # read1 performs at most one underlying read, so a drip-fed body
            # cannot reset the total deadline inside a buffered read loop.
            chunk = reader.read1(min(64 * 1024, remaining))
            if not chunk:
                raise ToolError("Tool upload ended before Content-Length", 400)
            parts.append(chunk)
            remaining -= len(chunk)
        return b"".join(parts)
    except (socket.timeout, TimeoutError) as exc:
        raise ToolError("Tool upload timed out", 408) from exc
    finally:
        if connection:
            try:
                connection.settimeout(previous)
            except OSError:
                pass


def register(app, *, base_dir, source_dir, require_admin, require_teacher, require_user,
             find_user, get_user_class_ids, find_class, teacher_classes, account_id):
    store, gateway = ToolStore(base_dir), Gateway()
    storage = ToolStorage(base_dir)
    snapshot_slots = threading.BoundedSemaphore(2)
    runtime_source = (source_dir / "static/js/external-tool-runtime.js").read_text(encoding="utf-8")
    sessions, lock = {}, threading.RLock()
    self_ips = local_addresses()
    for logger in (logging.getLogger("werkzeug"), app.logger):
        if not any(isinstance(item, CapabilityLogFilter) for item in logger.filters):
            logger.addFilter(CapabilityLogFilter())

    def actor(req):
        for header, check, role in (("X-Admin-Token", require_admin, "admin"),
                                    ("X-Teacher-Token", require_teacher, "teacher"),
                                    ("X-User-Token", require_user, "student")):
            token = req.headers.get(header, "")
            record = check(req) if token else None
            if not record:
                continue
            if role == "admin":
                return {"role": role, "email": "__admin__", "header": header, "token": token}
            fresh = find_user(record.get("email", ""))
            if not fresh or not fresh.get("enabled", True) or fresh.get("role", "student") != role:
                continue
            return {"role": role, "email": fresh["email"], "record": fresh, "header": header, "token": token}
        raise ToolError("Sign in to use external tools", 401)

    def identity(current):
        return hashlib.sha256((current["header"] + "\0" + current["token"]).encode()).hexdigest()

    def entitled(current, tool, data):
        if current["role"] == "admin":
            return True
        if not data["enabled"] or not tool["enabled"] or tool["compatibility"] != "verified":
            return False
        if current["role"] == "teacher":
            return True
        candidates = [find_class(cid) for cid in get_user_class_ids(current["record"])]
        for cls in candidates:
            if not cls or tool["id"] not in data["class_tools"].get(cls["id"], []):
                continue
            if current["role"] == "student" and current["email"] in cls.get("students", []):
                return True
        return False

    def authorized(session):
        try:
            if session["closed"] or time.monotonic() > min(session["lease"], session["expires"]):
                return False
            current = actor(SimpleNamespace(headers={session["header"]: session["token"]}))
            data = store.read()
            tool = store.tool(data, session["tool_id"])
            return tool["revision"] == session["tool_revision"] and entitled(current, tool, data)
        except ToolError:
            return False

    def payload():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ToolError("A JSON object is required")
        return data

    def admin():
        current = actor(request)
        if current["role"] != "admin":
            raise ToolError("Administrator access required", 403)
        return current

    def summary(tool):
        return {key: tool[key] for key in ("id", "name", "label", "slug")}

    def guarded(handler):
        from functools import wraps
        @wraps(handler)
        def call(*args, **kwargs):
            try:
                return handler(*args, **kwargs)
            except ToolError as exc:
                return jsonify(ok=False, error=str(exc)), exc.status
            except (OSError, sqlite3.Error):
                return jsonify(ok=False, error="External tools storage is unavailable"), 503
            finally:
                release = getattr(request, "_tool_storage_release", None)
                if release:
                    release()
        return call

    def snapshot_response(build):
        # Large profiles stay admitted until the response closes. Limit materialized
        # snapshots independently of the streaming gateway's connection capacity.
        if not snapshot_slots.acquire(timeout=15):
            raise ToolError("Tool storage is busy. Retry shortly", 429)
        try:
            response = build()
            release = request._tool_storage_release
            request._tool_storage_release = None
            closed = False
            def finish():
                nonlocal closed
                with lock:
                    if closed:
                        return
                    closed = True
                snapshot_slots.release()
                release()
            original = response.response
            def stream():
                try:
                    for part in original:
                        for offset in range(0, len(part), 64 * 1024):
                            yield part[offset:offset + 64 * 1024]
                finally:
                    finish()
            # Werkzeug can error while draining input before calling close().
            # Release on normal iteration exhaustion as well as early close.
            response.response = stream()
            response.call_on_close(finish)
            return response
        except BaseException:
            snapshot_slots.release()
            raise

    @app.after_request
    def external_tool_headers(response):
        if request.path.startswith(("/api/tools", "/api/admin/tools", "/_tools/")) or request.endpoint == "external_tool_shell":
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Content-Type-Options"] = "nosniff"
        if request.path.startswith("/_tools/"):
            if request.headers.get("Origin") == "null":
                response.headers["Access-Control-Allow-Origin"] = "null"
                response.headers["Vary"] = "Origin"
            client_socket = request.environ.get("werkzeug.socket")
            if client_socket:
                try:
                    # Werkzeug closes every HTTP response, but otherwise drains
                    # unread input afterward. Never let rejected/slow tool bodies
                    # keep that drain alive. The response write half stays open.
                    client_socket.settimeout(5)
                    client_socket.shutdown(socket.SHUT_RD)
                except OSError:
                    pass
        elif request.endpoint == "external_tool_storage_export":
            client_socket = request.environ.get("werkzeug.socket")
            if client_socket:
                client_socket.settimeout(5)
        return response

    @app.get("/api/tools")
    @guarded
    def external_tool_list():
        current, data = actor(request), store.read()
        return jsonify(ok=True, tools=[summary(tool) for tool in data["tools"] if entitled(current, tool, data)], revision=data["revision"])

    def storage_account(current):
        return account_id(current.get("record"))

    @app.route("/api/tools/storage", methods=["GET", "DELETE"])
    @guarded
    def external_tool_storage():
        account = storage_account(actor(request))
        if request.method == "DELETE":
            raw = payload()
            tool = raw.get("tool_id")
            if tool is not None and (not isinstance(tool, str) or len(tool) != 32):
                raise ToolError("Invalid tool identifier")
            result = storage.clear(account, raw.get("epoch"), tool)
        else:
            result = storage.summary(account)
        names = {tool["id"]: tool["name"] for tool in store.read()["tools"]}
        for item in result["tools"]:
            item["name"] = names.get(item["tool"], "Removed tool")
        return jsonify(ok=True, storage=result)

    @app.get("/api/tools/storage/<tool_id>/export")
    @guarded
    def external_tool_storage_export(tool_id):
        current = actor(request)
        account = storage_account(current)
        request._tool_storage_release = gateway.admit(identity(current), wait=True)
        def build():
            result = storage.snapshot(account, tool_id, export=True)
            response = jsonify(format="eagleide-tool-storage-v1", tool_id=tool_id, entries=result["entries"])
            response.headers["Content-Disposition"] = 'attachment; filename="external-tool-backup.json"'
            return response
        return snapshot_response(build)

    @app.route("/api/admin/tools/storage", methods=["GET", "PUT"])
    @guarded
    def external_tool_storage_policy():
        current = admin()
        email = request.args.get("email", "").strip().lower()
        if email:
            record = find_user(email)
            if not record:
                raise ToolError("Account not found", 404)
            account = account_id(record)
        else:
            account = storage_account(current)
        result = storage.policy(account, payload()) if request.method == "PUT" else storage.summary(account)
        return jsonify(ok=True, storage=result)

    @app.get("/api/admin/tools")
    @guarded
    def external_tool_admin_list():
        admin()
        return jsonify(ok=True, catalog=store.read())

    @app.put("/api/admin/tools/policy")
    @guarded
    def external_tool_policy():
        admin()
        raw = payload()
        allowed, denied = networks(raw.get("allowed_networks", [])), networks(raw.get("denied_networks", []))
        def change(data):
            data.update(enabled=raw.get("enabled") is True, allowed_networks=allowed, denied_networks=denied)
            for tool in data["tools"]:
                tool.update(enabled=False, addresses=[], compatibility="unverified", test="Network policy changed; test again", revision=tool["revision"] + 1)
        _, revision = store.mutate(raw.get("revision"), change)
        return jsonify(ok=True, revision=revision)

    @app.post("/api/admin/tools")
    @guarded
    def external_tool_save():
        admin()
        reserved = {rule.rule.split("/")[1] for rule in app.url_map.iter_rules() if len(rule.rule.split("/")) > 1 and not rule.rule.split("/")[1].startswith("<")}
        tool, revision = store.save_tool(payload(), reserved)
        return jsonify(ok=True, tool=tool, revision=revision)

    @app.delete("/api/admin/tools/<tool_id>")
    @guarded
    def external_tool_delete(tool_id):
        admin()
        raw = payload()
        def change(data):
            data["tools"].remove(store.tool(data, tool_id))
            for grants in data["class_tools"].values():
                if tool_id in grants:
                    grants.remove(tool_id)
        _, revision = store.mutate(raw.get("revision"), change)
        return jsonify(ok=True, revision=revision)

    @app.post("/api/admin/tools/<tool_id>/test")
    @guarded
    def external_tool_test(tool_id):
        current, raw, data = admin(), payload(), store.read()
        tool = store.tool(data, tool_id)
        # A retest may approve a deliberate DNS change; it always revokes old verification.
        candidate = {**tool, "addresses": []}
        addresses, diagnostic = [], ""
        try:
            upstream, close, _, addresses = gateway.open(candidate, data, owner=identity(current), self_ips=self_ips)
            try:
                if not 200 <= upstream.status < 400:
                    raise ToolError(f"Backend returned HTTP {upstream.status}", 422)
                if upstream.getheader("Set-Cookie"):
                    raise ToolError("Cookie-based applications are unsupported by the restricted profile", 422)
                diagnostic = f"Reachable (HTTP {upstream.status}). Browser compatibility is not verified."
            finally:
                close()
        except ToolError as exc:
            addresses, diagnostic = [], str(exc)
        def change(catalog):
            saved = store.tool(catalog, tool_id)
            saved.update(addresses=addresses, test=diagnostic, enabled=False, compatibility="unverified", revision=saved["revision"] + 1)
            return saved
        saved, revision = store.mutate(raw.get("revision"), change)
        return jsonify(ok=True, reachable=bool(addresses), tool=saved, revision=revision)

    @app.post("/api/admin/tools/<tool_id>/enable")
    @guarded
    def external_tool_enable(tool_id):
        current, raw = admin(), payload()
        def change(data):
            tool = store.tool(data, tool_id)
            if raw.get("enabled") is not True:
                tool["enabled"] = False
                tool["revision"] += 1
                return
            with lock:
                preview = next((row for row in sessions.values() if row["id"] == raw.get("preview_id")), None)
            if (not preview or preview["owner"] != identity(current) or not preview["preview"] or not preview["delivered"]
                    or preview["tool_id"] != tool_id or preview["tool_revision"] != tool["revision"]
                    or time.monotonic() > min(preview["expires"], preview["created"] + 900)
                    or raw.get("confirmed") is not True or not tool["addresses"]):
                raise ToolError("Test, open an administrator preview, then confirm restricted-profile compatibility", 409)
            tool.update(enabled=True, compatibility="verified")
        _, revision = store.mutate(raw.get("revision"), change)
        return jsonify(ok=True, revision=revision)

    @app.route("/api/teacher/classes/<class_id>/tools", methods=["GET", "PUT"])
    @guarded
    def external_tool_class_grants(class_id):
        current = actor(request)
        cls = find_class(class_id)
        if current["role"] != "teacher" or not cls or cls.get("teacher_email") != current["email"]:
            raise ToolError("Only the class owner can manage external tools", 403)
        data = store.read()
        if request.method == "GET":
            return jsonify(ok=True, tools=[summary(tool) for tool in data["tools"] if data["enabled"] and tool["enabled"]],
                           granted=data["class_tools"].get(class_id, []), revision=data["revision"])
        raw = payload()
        def change(catalog):
            ids = raw.get("tool_ids")
            available = {tool["id"] for tool in catalog["tools"] if catalog["enabled"] and tool["enabled"]}
            if not isinstance(ids, list) or any(not isinstance(value, str) or value not in available for value in ids):
                raise ToolError("Select only globally enabled tools")
            catalog["class_tools"][class_id] = sorted(set(ids))
        _, revision = store.mutate(raw.get("revision"), change)
        return jsonify(ok=True, revision=revision)

    @app.post("/api/tools/<tool_id>/launch")
    @guarded
    def external_tool_launch(tool_id):
        current, data = actor(request), store.read()
        tool = store.tool(data, tool_id)
        if not entitled(current, tool, data):
            raise ToolError("This tool is disabled or your account does not have access", 403)
        if not tool["addresses"]:
            raise ToolError("An administrator must test this destination first", 409)
        now, owner = time.monotonic(), identity(current)
        with lock:
            for key in list(sessions):
                previous = sessions[key]
                if (now > previous["expires"] or (not previous["closed"] and now > previous["lease"])
                        or (previous["owner"] == owner and not previous["closed"] and not authorized(previous))):
                    del sessions[key]
            if len(sessions) >= MAX_INSTANCES or sum(not row["closed"] and row["owner"] == owner for row in sessions.values()) >= 2:
                raise ToolError("Close another application instance before launching", 429)
            capability, instance = secrets.token_urlsafe(32), uuid.uuid4().hex
            digest = hashlib.sha256(capability.encode()).hexdigest()
            scheme = "https" if request.is_secure or request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip() == "https" else request.scheme
            origin = f"{scheme}://{request.host}"
            row = {"id": instance, "tool_id": tool_id, "tool_revision": tool["revision"], "owner": owner,
                   "account": storage_account(current),
                   "header": current["header"], "token": current["token"], "expires": now + HARD_SECONDS,
                   "lease": now + LEASE_SECONDS, "closed": False, "preview": current["role"] == "admin",
                   "delivered": False, "origin": origin, "created": now}
            sessions[digest] = row
        prefix = f"/_tools/{tool_id}/{capability}/app/"
        return jsonify(ok=True, instance_id=instance, url=prefix, preview=row["preview"], forms=tool["forms"],
                       popups=tool["popups"], dialogs=tool["dialogs"], storage=tool["storage"], lease_seconds=LEASE_SECONDS)

    @app.route("/api/tools/instances/<instance_id>", methods=["POST", "DELETE"])
    @guarded
    def external_tool_instance(instance_id):
        current = actor(request)
        with lock:
            row = next((row for row in sessions.values() if row["id"] == instance_id and row["owner"] == identity(current)), None)
        if not row:
            raise ToolError("Application session expired", 410)
        if request.method == "DELETE":
            with lock:
                row["closed"] = True
                row["expires"] = min(row["expires"], time.monotonic() + 15 * 60)
                if not row["preview"]:
                    sessions.pop(next((key for key, value in sessions.items() if value is row), ""), None)
        else:
            if not authorized(row):
                with lock:
                    row["closed"] = True
                raise ToolError("Application access was revoked or expired", 403)
            with lock:
                row["lease"] = min(time.monotonic() + LEASE_SECONDS, row["expires"])
        return jsonify(ok=True)

    @app.route("/_tools/<tool_id>/<capability>/app/", defaults={"path": ""}, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    @app.route("/_tools/<tool_id>/<capability>/app/<path:path>", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    @guarded
    def external_tool_proxy(tool_id, capability, path):
        digest = hashlib.sha256(capability.encode()).hexdigest()
        with lock:
            row = sessions.get(digest)
        if not row or row["tool_id"] != tool_id or not authorized(row):
            raise ToolError("Application access expired or was revoked", 403)
        data = store.read()
        tool = store.tool(data, tool_id)
        if request.headers.get("Service-Worker") or request.headers.get("Upgrade"):
            raise ToolError("Service workers and upgraded connections are unsupported", 403)
        internal = path.startswith("__eagle__/")
        allowed = ["GET", "HEAD", "POST", "DELETE"] if internal else tool["methods"]
        if request.method not in allowed + ["OPTIONS"]:
            raise ToolError("This HTTP method is not enabled for the tool", 405)
        prefix = f"{row['origin']}/_tools/{tool_id}/{capability}/app/"
        cors = request.headers.get("Origin") == "null"
        if request.headers.get("Origin") not in (None, "null", row["origin"]):
            raise ToolError("Application origin is not permitted", 403)
        if request.method == "OPTIONS":
            wanted = request.headers.get("Access-Control-Request-Method", "GET")
            requested = {name.strip().lower() for name in request.headers.get("Access-Control-Request-Headers", "").split(",") if name.strip()}
            if wanted not in allowed or requested - {"content-type"}:
                raise ToolError("Unsupported application preflight", 403)
            result = Response(status=204)
            if cors:
                result.headers.update({"Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": ", ".join(allowed), "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin"})
            return result
        if internal:
            # Bound concurrent snapshot construction and chunk bodies as well as
            # upstream traffic. Release after handling; socket writes stay bounded.
            request._tool_storage_release = gateway.admit(row["owner"], wait=True)
            if not authorized(row):
                raise ToolError("Application access expired or was revoked", 403)
            action = path[len("__eagle__/"):]
            if action == "runtime.js" and request.method in {"GET", "HEAD"}:
                if request.method == "HEAD":
                    return Response(mimetype="application/javascript")
                def build():
                    if not authorized(row):
                        raise ToolError("Application access expired or was revoked", 403)
                    snapshot = storage.snapshot(row["account"], tool_id) if tool["storage"] else {"enabled": False, "entries": {}}
                    config = {"snapshot": snapshot, "instance": row["id"], "prefix": prefix + "__eagle__/", "tool": tool_id, "parentOrigin": row["origin"]}
                    encoded = json.dumps(json.dumps(config, ensure_ascii=False), ensure_ascii=False)
                    return Response("(function(config){\n" + runtime_source + "\n})(JSON.parse(" + encoded + "));", mimetype="application/javascript")
                return snapshot_response(build)
            if not tool["storage"]:
                raise ToolError("Cloud storage is not enabled for this tool", 403)
            if request.method == "POST":
                if request.content_length is None or request.content_length > CHUNK:
                    raise ToolError("Storage requests require Content-Length and are limited to 512 KiB", 413)
                body = read_upload(request)
                if action == "chunk":
                    offset = request.args.get("offset", "")
                    if not offset.isdigit() or len(offset) > 12:
                        raise ToolError("Invalid storage chunk offset")
                    received = storage.chunk(row["account"], tool_id, row["id"], request.args.get("id"), int(offset), body)
                    return jsonify(ok=True, received=received)
                try:
                    raw = json.loads(body)
                except (ValueError, UnicodeError) as exc:
                    raise ToolError("Invalid storage JSON") from exc
                if not isinstance(raw, dict):
                    raise ToolError("A JSON object is required")
                if action == "begin":
                    return jsonify(ok=True, **storage.begin(row["account"], tool_id, row["id"], raw))
                if action == "commit":
                    return jsonify(ok=True, **storage.commit(row["account"], tool_id, row["id"], raw.get("upload_id")))
                if action == "abort":
                    storage.abort(row["account"], tool_id, row["id"], raw.get("upload_id"))
                    return jsonify(ok=True)
            raise ToolError("Unknown tool storage action", 404)
        from tool_gateway import safe_path
        raw_uri = request.environ.get("RAW_URI", request.environ.get("REQUEST_URI", ""))
        if "/app/" in raw_uri:
            safe_path(raw_uri.split("/app/", 1)[1].split("?", 1)[0])
        # Cookies, Authorization, Range, conditional and forwarding headers are deliberately not forwarded.
        if request.content_length is not None and request.content_length > tool["upload_mib"] * MAX_UPLOAD:
            raise ToolError(f"This tool's server uploads are limited to {tool['upload_mib']} MiB", 413)
        headers = {"Accept": request.headers.get("Accept", "*/*")}
        if request.content_type:
            headers["Content-Type"] = request.content_type
        try:
            query = request.query_string.decode("ascii", errors="strict")
        except UnicodeError as exc:
            raise ToolError("Invalid query encoding") from exc
        permit = gateway.admit(row["owner"], wait=True)
        try:
            if not authorized(row):
                raise ToolError("Application access expired or was revoked", 403)
            body = None
            if request.method not in {"GET", "HEAD"}:
                if request.content_length is None:
                    raise ToolError("Content-Length is required", 411)
                body = read_upload(request)
            upstream, close, target, _ = gateway.open(tool, data, path, query,
                                                     request.method, body, headers, row["owner"], self_ips, permit=permit)
        except BaseException:
            permit()
            raise
        try:
            if upstream.getheader("Set-Cookie") or upstream.status in {401, 407}:
                raise ToolError("Cookie/login flows are unsupported by the restricted profile", 502)
            client_socket = request.environ.get("werkzeug.socket")
            previous_timeout = client_socket.gettimeout() if client_socket else None
            original_close = close
            def finish():
                original_close()
                if client_socket:
                    try:
                        client_socket.settimeout(previous_timeout)
                    except OSError:
                        pass
            close = finish
            if client_socket:
                client_socket.settimeout(5)
            html_document = (upstream.getheader("Content-Type", "").split(";", 1)[0].strip().lower() == "text/html"
                             and not upstream.getheader("Content-Disposition", "").strip().lower().startswith("attachment"))
            is_html = html_document and request.method != "HEAD"
            body = html_body(upstream, close, lambda: authorized(row), prefix + "__eagle__/runtime.js") if is_html else stream_body(upstream, close, lambda: authorized(row))
            response = Response(body, status=upstream.status)
            for name in ("Content-Type", "Content-Length", "Content-Encoding", "Content-Language", "Content-Disposition", "Content-Security-Policy", "X-Frame-Options"):
                if html_document and name in {"Content-Length", "Content-Encoding"}:
                    continue
                value = upstream.getheader(name)
                if value:
                    response.headers[name] = value
            location = upstream.getheader("Location")
            if location:
                response.headers["Location"] = prefix + redirect_path(location, target, path)
            forms = " allow-forms" if tool["forms"] else ""
            extras = (" allow-popups" if tool["popups"] else "") + (" allow-modals" if tool["dialogs"] else "")
            form_action = prefix if tool["forms"] else "'none'"
            policy = (f"sandbox allow-scripts allow-downloads{forms}{extras}; default-src 'none'; "
                      f"script-src {prefix} 'unsafe-inline' 'wasm-unsafe-eval'; style-src {prefix} 'unsafe-inline'; "
                      f"connect-src {prefix}; img-src {prefix} data: blob:; font-src {prefix} data:; media-src {prefix} blob:; "
                      f"worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; "
                      f"form-action {form_action}; frame-ancestors {row['origin']}")
            response.headers.add("Content-Security-Policy", policy)
            response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()"
            response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
            if cors:
                response.headers["Access-Control-Allow-Origin"] = "null"
                response.headers["Vary"] = "Origin"
            if request.method == "GET" and not path:
                row["delivered"] = True
            if request.method == "HEAD":
                close()
            response.call_on_close(close)
            return response
        except BaseException:
            close()
            raise

    @app.get("/<tool_slug>/")
    @guarded
    def external_tool_shell(tool_slug):
        if not any(tool["slug"] == tool_slug for tool in store.read()["tools"]):
            raise ToolError("Page not found", 404)
        return send_from_directory(source_dir, "index.html")

    return SimpleNamespace(store=store, storage=storage, gateway=gateway, sessions=sessions)
