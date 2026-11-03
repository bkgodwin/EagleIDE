"""Native Eagle Lab routes with admin enrollment and class-scoped access."""

from __future__ import annotations

import concurrent.futures
import http.client
import ssl
import threading
import time
from pathlib import Path

from flask import jsonify, request

from eagle_lab_store import EagleLabDataError, EagleLabStore
from eagle_lab_gateway import LabGateway, AUTH_HEADERS


_STATUS_TTL = 5.0


def _probe(server: dict) -> dict:
    started = time.monotonic()
    context = ssl._create_unverified_context() if server.get("allow_self_signed", True) else ssl.create_default_context()
    connection = http.client.HTTPSConnection(server["ip"], int(server.get("port", 8006)), timeout=4, context=context)
    try:
        connection.request("GET", "/api2/json/version", headers={"Accept": "application/json", "Connection": "close"})
        response = connection.getresponse()
        response.read(1024)
        status = int(response.status or 0)
        up = 200 <= status < 500
        return {
            "status": "up" if up else "down",
            "http_status": status,
            "latency_ms": round((time.monotonic() - started) * 1000) if up else None,
            "status_reason": f"PVE management responded with HTTP {status}.",
        }
    except ssl.SSLCertVerificationError:
        return {"status": "down", "http_status": None, "latency_ms": None, "status_reason": "TLS certificate validation failed."}
    except (TimeoutError, OSError) as exc:
        code = getattr(exc, "errno", None) or exc.__class__.__name__
        return {"status": "down", "http_status": None, "latency_ms": None, "status_reason": f"PVE connection failed ({code})."}
    finally:
        connection.close()


def register(
    app,
    *,
    base_dir: Path,
    require_admin,
    require_teacher,
    require_user,
    find_user,
    get_user_class_ids,
    find_class,
    config_provider,
    gateway_settings=None,
):
    store = EagleLabStore(base_dir)
    status_cache: dict[str, tuple[float, dict]] = {}
    status_lock = threading.Lock()

    def global_enabled() -> bool:
        return bool((config_provider() or {}).get("eagle_lab_enabled", False))

    def actor(req=request):
        if require_admin(req):
            return {"role": "admin", "email": "__admin__", "record": None}
        teacher = require_teacher(req)
        if teacher:
            email = str(teacher.get("email") or "").strip().lower()
            return {"role": "teacher", "email": email, "record": teacher}
        user = require_user(req)
        if user:
            fresh = find_user(str(user.get("email") or "")) or user
            return {"role": "student", "email": str(fresh.get("email") or "").strip().lower(), "record": fresh}
        return {"role": "guest", "email": "", "record": None}

    def object_body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise EagleLabDataError("A JSON object is required")
        return data

    def teacher_class(class_id: str):
        teacher = require_teacher(request)
        if not teacher:
            return None, (jsonify(ok=False, error="Teacher token required"), 401)
        classroom = find_class(str(class_id))
        if not classroom:
            return None, (jsonify(ok=False, error="Class not found"), 404)
        email = str(teacher.get("email") or "").strip().lower()
        if str(classroom.get("teacher_email") or "").strip().lower() != email:
            return None, (jsonify(ok=False, error="Class owner required"), 403)
        return (teacher, classroom), None

    def class_access(current: dict, class_id: str) -> bool:
        if current["role"] == "admin":
            return True
        if not global_enabled():
            return False
        if current["role"] == "teacher":
            classroom = find_class(class_id) or {}
            return str(classroom.get("teacher_email") or "").strip().lower() == current["email"]
        if current["role"] == "student":
            return class_id in {str(item) for item in get_user_class_ids(current.get("record"))} and store.class_rule(class_id)["enabled"]
        return False

    def status(server: dict) -> dict:
        now = time.monotonic()
        with status_lock:
            cached = status_cache.get(server["id"])
            if cached and now - cached[0] < _STATUS_TTL:
                return dict(cached[1])
        result = _probe(server)
        result["checked_at"] = int(time.time())
        with status_lock:
            status_cache[server["id"]] = (now, result)
        return dict(result)

    gateway = LabGateway(app, store, actor, class_access, settings=gateway_settings)
    app.extensions["eagle_lab_gateway"] = gateway

    def with_status(servers: list[dict]) -> list[dict]:
        if not servers:
            return []
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(servers)), thread_name_prefix="eagle-lab-probe") as pool:
            results = list(pool.map(status, servers))
        return [{**server, **state, "connect_url": f"https://{server['ip']}:{server.get('port', 8006)}/"} for server, state in zip(servers, results)]

    @app.get("/api/eagle-lab/bootstrap")
    def eagle_lab_bootstrap():
        current = actor()
        class_id = str(request.args.get("class_id") or "").strip()
        if current["role"] == "guest":
            return jsonify(ok=False, error="Sign in to open Eagle Lab"), 401
        if current["role"] == "student" and not class_id:
            enabled_classes = [str(item) for item in get_user_class_ids(current.get("record")) if store.class_rule(item)["enabled"]]
            class_id = enabled_classes[0] if enabled_classes else ""
        if current["role"] == "teacher" and not class_id:
            return jsonify(ok=False, error="Choose a class to open Eagle Lab"), 400
        if not class_access(current, class_id):
            message = "Eagle Lab is disabled for this class" if global_enabled() else "Eagle Lab is disabled"
            return jsonify(ok=False, error=message, enabled=False), 403
        rule = store.class_rule(class_id) if current["role"] != "admin" else {"enabled": True, "show_credentials": True, "server_ids": [item["id"] for item in store.list_servers()]}
        servers = store.list_servers() if current["role"] == "admin" else store.servers_for_class(class_id)
        if current["role"] == "student":
            servers = [{key: value for key, value in server.items() if key != "username"} for server in servers]
        return jsonify(ok=True, data={
            "enabled": global_enabled(),
            "admin_preview": current["role"] == "admin" and not global_enabled(),
            "role": current["role"],
            "class_id": class_id,
            "show_credentials": bool(rule.get("show_credentials")) or current["role"] in {"admin", "teacher"},
            "gateway_configured": gateway.configured,
            "gateway_transport": gateway.transport,
            "servers": with_status(servers),
        })

    @app.get("/api/eagle-lab/servers/<server_id>/credentials")
    def eagle_lab_credentials(server_id):
        current = actor()
        class_id = str(request.args.get("class_id") or "").strip()
        if current["role"] == "guest" or not class_access(current, class_id):
            return jsonify(ok=False, error="Eagle Lab access required"), 403
        rule = store.class_rule(class_id) if current["role"] != "admin" else {"server_ids": [item["id"] for item in store.list_servers()], "show_credentials": True}
        if server_id not in set(rule.get("server_ids", [])):
            return jsonify(ok=False, error="This server is not assigned to the class"), 403
        if current["role"] == "student" and not rule.get("show_credentials"):
            return jsonify(ok=False, error="Credentials are hidden for this class"), 403
        auth_headers = {key: request.headers[key] for key in AUTH_HEADERS if request.headers.get(key)}
        if current["role"] == "student" and not gateway.pin_unlocked(server_id, auth_headers, class_id):
            return jsonify(ok=False, error="Unlock this server with its PIN first"), 403
        server = store.get_server(server_id, credentials=True)
        if not server:
            return jsonify(ok=False, error="Lab server not found"), 404
        return jsonify(ok=True, data={key: server[key] for key in ("id", "hostname", "ip", "port", "username", "password", "notes")})

    @app.get("/api/eagle-lab/admin/servers")
    def eagle_lab_admin_servers():
        if not require_admin(request):
            return jsonify(ok=False, error="Administrator access required"), 401
        return jsonify(ok=True, data={"enabled": global_enabled(), "servers": store.list_servers(), "gateway_configured": gateway.configured, "proxy_domain": gateway.domain, "gateway_transport": gateway.transport})

    @app.post("/api/eagle-lab/admin/servers")
    def eagle_lab_admin_server_create():
        if not require_admin(request):
            return jsonify(ok=False, error="Administrator access required"), 401
        try:
            saved = store.save_server(object_body())
        except EagleLabDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        return jsonify(ok=True, data=saved), 201

    @app.put("/api/eagle-lab/admin/server-order")
    def eagle_lab_admin_server_order():
        if not require_admin(request):
            return jsonify(ok=False, error="Administrator access required"), 401
        try:
            servers = store.reorder_servers(object_body().get("server_ids"))
        except EagleLabDataError as exc:
            return jsonify(ok=False, error=str(exc)), 409 if "list changed" in str(exc) else 400
        return jsonify(ok=True, data={"servers": servers})

    @app.put("/api/eagle-lab/admin/servers/<server_id>")
    def eagle_lab_admin_server_update(server_id):
        if not require_admin(request):
            return jsonify(ok=False, error="Administrator access required"), 401
        try:
            saved = store.save_server(object_body(), server_id)
        except EagleLabDataError as exc:
            status_code = 404 if str(exc) == "Lab server not found" else 400
            return jsonify(ok=False, error=str(exc)), status_code
        with status_lock:
            status_cache.pop(server_id, None)
        return jsonify(ok=True, data=saved)

    @app.delete("/api/eagle-lab/admin/servers/<server_id>")
    def eagle_lab_admin_server_delete(server_id):
        if not require_admin(request):
            return jsonify(ok=False, error="Administrator access required"), 401
        if not store.delete_server(server_id):
            return jsonify(ok=False, error="Lab server not found"), 404
        with status_lock:
            status_cache.pop(server_id, None)
        return jsonify(ok=True)

    @app.get("/api/eagle-lab/teacher/classes/<class_id>")
    def eagle_lab_teacher_class_get(class_id):
        owned, error = teacher_class(class_id)
        if error:
            return error
        _, classroom = owned
        return jsonify(ok=True, data={
            "class_id": class_id,
            "class_name": classroom.get("name") or "Class",
            "globally_enabled": global_enabled(),
            "rule": store.class_rule(class_id),
            "servers": with_status(store.list_servers()),
        })

    @app.put("/api/eagle-lab/teacher/classes/<class_id>")
    def eagle_lab_teacher_class_put(class_id):
        _, error = teacher_class(class_id)
        if error:
            return error
        try:
            rule = store.set_class_rule(class_id, object_body())
        except EagleLabDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        return jsonify(ok=True, data={"class_id": class_id, "rule": rule})

    app.extensions["eagle_lab_store"] = store
    return store
