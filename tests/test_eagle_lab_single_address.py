import shutil
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

import requests
from flask import Flask, jsonify, request
from werkzeug.serving import make_server

from eagle_lab_gateway import LabGateway, _TrustedLabFront
from eagle_lab_store import EagleLabStore
from security_controls import client_ip


class FrontPeerTests(unittest.TestCase):
    def test_only_authenticated_loopback_front_can_restore_transport_peer(self):
        app = Flask(__name__)
        app.wsgi_app = _TrustedLabFront(app.wsgi_app, "private-key")
        @app.get("/peer")
        def peer():
            return jsonify(peer=request.remote_addr, client=client_ip(request), key=request.headers.get("X-Eagle-Front-Key"))
        client = app.test_client()
        restored = client.get("/peer", headers={"X-Eagle-Front-Key": "private-key", "X-Eagle-Front-Peer": "203.0.113.7", "X-Forwarded-For": "8.8.8.8"}).get_json()
        self.assertEqual(restored, {"peer": "203.0.113.7", "client": "203.0.113.7", "key": None})
        forged = client.get("/peer", headers={"X-Eagle-Front-Key": "wrong", "X-Eagle-Front-Peer": "203.0.113.7"}).get_json()
        self.assertEqual(forged["peer"], "127.0.0.1")
        remote = client.get("/peer", environ_overrides={"REMOTE_ADDR": "192.168.1.8"}, headers={"X-Eagle-Front-Key": "private-key", "X-Eagle-Front-Peer": "203.0.113.7"}).get_json()
        self.assertEqual(remote["peer"], "192.168.1.8")


@unittest.skipUnless(shutil.which("node"), "Node.js is required for the single-address gateway")
class SingleAddressTests(unittest.TestCase):
    def test_normal_app_and_pin_launch_share_the_original_public_listener(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Flask(__name__)
            store = EagleLabStore(Path(temporary) / "lab")
            server = store.save_server({"hostname": "PVE fixture", "ip": "192.168.30.10", "password": "fixture", "pin": "1234"})
            def actor(req):
                return {"role": "admin", "email": "admin"} if req.headers.get("X-Admin-Token") == "fixture-admin" else {"role": "guest", "email": ""}
            gateway = LabGateway(app, store, actor, lambda current, _: current["role"] == "admin", settings={})
            self.assertEqual(gateway.transport, "path")
            @app.get("/health")
            def health():
                response = jsonify(ok=True, peer=request.remote_addr, private_header=request.headers.get("X-Eagle-Front-Key"))
                response.headers["Cache-Control"] = "private, no-store"
                return response
            with socket.socket() as reserved:
                reserved.bind(("127.0.0.1", 0))
                public_port = reserved.getsockname()[1]
            host, backend_port = gateway.application_listener("127.0.0.1", public_port)
            self.assertEqual(host, "127.0.0.1")
            backend = make_server(host, backend_port, app, threaded=True)
            thread = threading.Thread(target=backend.serve_forever, daemon=True)
            thread.start()
            try:
                gateway.start(port=backend_port, public_host="127.0.0.1", public_port=public_port)
                deadline = time.monotonic() + 5
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", public_port), timeout=.2):
                            break
                    except OSError:
                        if time.monotonic() > deadline or gateway.process.poll() is not None:
                            self.fail("Automatic public listener did not start")
                        time.sleep(.025)
                with requests.Session() as client:
                    client.trust_env = False
                    base = f"http://127.0.0.1:{public_port}"
                    headers = {"Host": "ide.school.test", "Origin": "http://ide.school.test", "X-Admin-Token": "fixture-admin", "X-Eagle-Front-Peer": "8.8.8.8", "X-Eagle-Front-Key": "forged"}
                    health = client.get(base + "/health", headers=headers, timeout=5)
                    self.assertTrue(health.json()["ok"])
                    self.assertEqual(health.json()["peer"], "127.0.0.1")
                    self.assertIsNone(health.json()["private_header"])
                    self.assertEqual(health.headers["Cache-Control"], "private, no-store")
                    launch = client.post(base + f"/api/eagle-lab/servers/{server['id']}/launch", headers=headers, json={}, timeout=5)
                    self.assertEqual(launch.status_code, 200, launch.text)
                    data = launch.json()["data"]
                    self.assertTrue(data["url"].startswith("/_eagle/lab/"))
                    exchange = client.post(base + data["url"], headers=headers, data={"ticket": data["ticket"]}, allow_redirects=False, timeout=5)
                    self.assertEqual(exchange.status_code, 303, exchange.text)
                    self.assertNotIn("Set-Cookie", exchange.headers)
                    bridge = client.get(base + exchange.headers["Location"] + "_eagle/bridge.js", headers={"Host": "ide.school.test", "Origin": "null"}, timeout=5)
                    self.assertEqual(bridge.status_code, 200)
                    self.assertNotIn("fixture-admin", bridge.text)
                    self.assertEqual(bridge.headers["Access-Control-Allow-Origin"], "null")
                    store.save_server({**server, "pin": "4321"}, server["id"])
                    revoked = client.get(base + exchange.headers["Location"] + "_eagle/bridge.js", headers={"Host": "ide.school.test", "Origin": "null"}, timeout=5)
                    self.assertEqual(revoked.status_code, 403)
            finally:
                gateway.close()
                backend.shutdown()
                backend.server_close()
                thread.join(timeout=2)
