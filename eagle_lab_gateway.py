"""Short-lived PVE capabilities and the authenticated single-address transport."""
from __future__ import annotations

import atexit
import hmac
import ipaddress
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
from types import SimpleNamespace
from urllib.parse import urlsplit

from flask import jsonify, request
from security_controls import AttemptLimiter

AUTH_HEADERS = ("X-Admin-Token", "X-Teacher-Token", "X-User-Token")


class _TrustedLabFront:
    """Restore the real transport peer before Flask/Socket.IO construct a request."""
    def __init__(self, wrapped, key):
        self.wrapped, self.key = wrapped, key

    def __call__(self, environ, start_response):
        key = environ.pop("HTTP_X_EAGLE_FRONT_KEY", "")
        peer = environ.pop("HTTP_X_EAGLE_FRONT_PEER", "")
        try:
            if ipaddress.ip_address(environ.get("REMOTE_ADDR", "")).is_loopback and hmac.compare_digest(key, self.key):
                address = ipaddress.ip_address(peer)
                environ["REMOTE_ADDR"] = str(getattr(address, "ipv4_mapped", None) or address)
        except (ValueError, TypeError):
            pass
        return self.wrapped(environ, start_response)


class LabGateway:
    def __init__(self, app, store, actor, class_access, *, settings=None):
        self.app, self.store, self.actor, self.class_access = app, store, actor, class_access
        settings = os.environ if settings is None else settings
        self.domain = settings.get("EAGLEIDE_LAB_PROXY_DOMAIN", "").strip().lower()
        self.portal = settings.get("EAGLEIDE_PUBLIC_ORIGIN", "").strip().rstrip("/")
        self.transport = settings.get("EAGLEIDE_LAB_TRANSPORT", "origin" if self.domain else "path")
        if self.transport not in {"path", "origin", "disabled"}:
            raise ValueError("Lab transport must be path, origin, or disabled")
        self.secret = secrets.token_urlsafe(48)
        self.port = int(settings.get("EAGLEIDE_LAB_GATEWAY_PORT", "8010"))
        if not 1 <= self.port <= 65535:
            raise ValueError("Lab gateway port must be between 1 and 65535")
        self.explicit_internal = bool(settings.get("EAGLEIDE_LAB_INTERNAL_URL"))
        self.internal_url = settings.get("EAGLEIDE_LAB_INTERNAL_URL", "http://127.0.0.1:8000")
        self.process = None
        self.lock = threading.RLock()
        self.tickets, self.sessions = {}, {}
        self.limiter = AttemptLimiter(8, 300)
        self.global_limiter = AttemptLimiter(60, 300)
        if self.transport == "path":
            app.wsgi_app = _TrustedLabFront(app.wsgi_app, self.secret)
        if self.domain:
            parsed = urlsplit(self.portal)
            if (not re.fullmatch(r"(?=.{1,200}$)[a-z0-9]+(?:[-.][a-z0-9]+)*\.[a-z]{2,}", self.domain)
                    or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                    or parsed.path or parsed.query or parsed.fragment
                    or parsed.hostname == self.domain or parsed.hostname.endswith("." + self.domain)):
                raise ValueError("Eagle Lab requires an HTTPS portal origin and a distinct proxy domain")
            internal = urlsplit(self.internal_url)
            if internal.scheme != "http" or internal.hostname not in {"127.0.0.1", "localhost", "::1"} or internal.username or internal.password or internal.path not in {"", "/"}:
                raise ValueError("Lab gateway authorization must use a loopback HTTP URL")
        self.register_routes()

    @property
    def configured(self):
        return self.transport == "path" or (self.transport == "origin" and bool(self.domain))

    def application_listener(self, host, port):
        """Same external listener; Flask moves to an automatically selected loopback port."""
        if self.transport != "path":
            return host, port
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            return "127.0.0.1", reserved.getsockname()[1]

    def prune(self):
        now = time.monotonic()
        for table in (self.tickets, self.sessions):
            for key in list(table):
                if table[key]["expires"] <= now:
                    table.pop(key, None)

    def allowed(self, record):
        server = self.store.get_server(record["server_id"])
        if not server or server["revision"] != record["revision"]:
            return None
        current = self.actor(SimpleNamespace(headers=record["headers"]))
        if (current["role"], current["email"]) != record["actor_key"]:
            return None
        if not self.class_access(current, record["class_id"]):
            return None
        if current["role"] != "admin" and server["id"] not in self.store.class_rule(record["class_id"])["server_ids"]:
            return None
        return server

    def pin_unlocked(self, server_id, headers, class_id):
        server = self.store.get_server(server_id)
        if not server or not server["pin_required"]:
            return True
        with self.lock:
            self.prune()
            return any(item["server_id"] == server_id and item["headers"] == headers
                       and item["class_id"] == class_id and self.allowed(item)
                       for table in (self.sessions, self.tickets) for item in table.values())

    def register_routes(self):
        @self.app.post("/api/eagle-lab/servers/<server_id>/launch")
        def lab_gateway_launch(server_id):
            if not self.configured:
                return jsonify(ok=False, error="Embedded PVE gateway is not configured; ask your administrator"), 503
            body = request.get_json(silent=True) or {}
            if not isinstance(body, dict):
                return jsonify(ok=False, error="A JSON object is required"), 400
            class_id = str(body.get("class_id") or "")
            current = self.actor(request)
            server = self.store.get_server(server_id)
            if not server or not self.class_access(current, class_id):
                return jsonify(ok=False, error="Eagle Lab access required"), 403
            if current["role"] != "admin" and server_id not in self.store.class_rule(class_id)["server_ids"]:
                return jsonify(ok=False, error="Server is not assigned to this class"), 403
            headers = {key: request.headers[key] for key in AUTH_HEADERS if request.headers.get(key)}
            portal = self.portal
            if self.transport == "path":
                if not re.fullmatch(r"[A-Za-z0-9.\-:\[\]]{1,255}", request.host):
                    return jsonify(ok=False, error="Invalid EagleIDE host"), 400
                raw_origin = request.headers.get("Origin", "")
                if raw_origin:
                    parsed = urlsplit(raw_origin)
                    if parsed.scheme not in {"http", "https"} or parsed.netloc.lower() != request.host.lower() or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
                        return jsonify(ok=False, error="Launch origin does not match EagleIDE"), 403
                    portal = raw_origin
                else:
                    portal = request.host_url.rstrip("/")
            if current["role"] == "student" and not self.pin_unlocked(server_id, headers, class_id):
                if not self.limiter.admit((current["email"], server_id)) or not self.global_limiter.admit(server_id):
                    return jsonify(ok=False, error="Too many PIN attempts; try again in five minutes"), 429
                if not self.store.verify_pin(server_id, body.get("pin", "")):
                    return jsonify(ok=False, error="Incorrect server PIN"), 403
            with self.lock:
                self.prune()
                if len(self.tickets) >= 512 or len(self.sessions) >= 2048:
                    return jsonify(ok=False, error="Lab gateway is busy; try again later"), 503
                ticket = secrets.token_urlsafe(32)
                clipboard_key = secrets.token_urlsafe(32)
                self.tickets[ticket] = {"server_id": server_id, "class_id": class_id, "headers": headers,
                                        "actor_key": (current["role"], current["email"]),
                                        "portal_origin": portal, "clipboard_key": clipboard_key,
                                        "revision": server["revision"], "expires": time.monotonic() + 60}
            url = f"/_eagle/lab/{server_id}/launch" if self.transport == "path" else f"https://s-{server_id}.{self.domain}/_eagle/launch"
            return jsonify(ok=True, data={"url": url, "ticket": ticket, "transport": self.transport, "clipboard_key": clipboard_key})

        @self.app.post("/api/eagle-lab/gateway/authorize")
        def lab_gateway_authorize():
            if not hmac.compare_digest(request.headers.get("X-Lab-Gateway-Key", ""), self.secret):
                return jsonify(ok=False), 403
            body = request.get_json(silent=True)
            if not isinstance(body, dict):
                return jsonify(ok=False), 400
            with self.lock:
                self.prune()
                session = str(body.get("session") or "")
                record = self.sessions.get(session)
                if body.get("ticket"):
                    record = self.tickets.pop(str(body["ticket"]), None)
                    session = secrets.token_urlsafe(32)
                if not record or record["server_id"] != body.get("server_id"):
                    return jsonify(ok=False), 403
                server = self.allowed(record)
                if not server:
                    self.sessions.pop(session, None)
                    return jsonify(ok=False), 403
                if body.get("ticket"):
                    if len(self.sessions) >= 2048:
                        return jsonify(ok=False), 503
                    record = {**record, "expires": time.monotonic() + 4 * 3600}
                    self.sessions[session] = record
                if body.get("close"):
                    self.sessions.pop(session, None)
                # No EagleIDE credentials, PVE passwords, or PIN hashes leave this process.
                return jsonify(ok=True, data={"server": {key: server[key] for key in ("id", "ip", "port", "allow_self_signed", "revision")}, "session": session,
                                              "portal_origin": record["portal_origin"], "clipboard_key": record["clipboard_key"]})

        @self.app.post("/api/eagle-lab/servers/<server_id>/disconnect")
        def lab_gateway_disconnect(server_id):
            headers = {key: request.headers[key] for key in AUTH_HEADERS if request.headers.get(key)}
            if not headers or self.actor(request)["role"] == "guest":
                return jsonify(ok=False), 401
            with self.lock:
                for table in (self.tickets, self.sessions):
                    for key in list(table):
                        if table[key]["server_id"] == server_id and table[key]["headers"] == headers:
                            table.pop(key, None)
            return jsonify(ok=True)

    def start(self, *, port=None, public_host=None, public_port=None):
        if not self.configured:
            return
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is required by the embedded PVE gateway")
        if port and (self.transport == "path" or not self.explicit_internal):
            self.internal_url = f"http://127.0.0.1:{int(port)}"
        env = {**os.environ, "EAGLEIDE_LAB_GATEWAY_SECRET": self.secret,
               "EAGLEIDE_LAB_PROXY_DOMAIN": self.domain, "EAGLEIDE_PUBLIC_ORIGIN": self.portal,
               "EAGLEIDE_LAB_TRANSPORT": self.transport,
               "EAGLEIDE_LAB_PUBLIC_HOST": public_host or "127.0.0.1", "EAGLEIDE_LAB_PUBLIC_PORT": str(public_port or self.port),
               "EAGLEIDE_LAB_GATEWAY_PORT": str(self.port), "EAGLEIDE_LAB_INTERNAL_URL": self.internal_url}
        ready = threading.Event()
        self.process = subprocess.Popen([node, str(Path(__file__).parent / "lab_gateway" / "server.mjs")],
                                        env=env, stdout=subprocess.PIPE, text=True)
        process = self.process

        def read_status():
            with process.stdout as output:
                for line in output:
                    print(line.rstrip(), flush=True)
                    if line.strip() in {"EagleIDE single-address gateway listening.", "Eagle Lab PVE gateway listening on loopback."}:
                        ready.set()

        threading.Thread(target=read_status, daemon=True).start()
        atexit.register(self.close)
        if not ready.wait(5) or process.poll() is not None:
            self.close()
            raise RuntimeError("Eagle Lab gateway could not start; check the configured listener and Node.js")

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
