"""Generic fixture only: no third-party application downloads or installations."""
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from flask import Flask

from external_tools import register
from tool_gateway import CapabilityLogFilter, PinnedConnection, approve_addresses, redirect_path, safe_path, target_url
from tool_store import ToolError, ToolStore


FIXTURE_HTML = b'''<!doctype html><meta charset="utf-8"><title>Generic tool fixture</title>
<link rel="stylesheet" href="style.css"><p id="result">Loading fixture</p>
<script type="module" src="module.js"></script>'''
FIXTURE_MODULE = b'''import {value} from './dependency.js';
const checks = {module: value};
await WebAssembly.instantiate(await (await fetch('./empty.wasm')).arrayBuffer()); checks.wasm=true;
checks.font=(await fetch('./font.woff')).ok;
checks.write=(await (await fetch('./echo', {method:'POST',body:'fixture write'})).json()).body;
try { localStorage.setItem('fixture-secret','private'); checks.storage='UNSAFE'; } catch { checks.storage='blocked'; }
try { parent.document.body.dataset.leaked='yes'; checks.parent='UNSAFE'; } catch { checks.parent='blocked'; }
try { await navigator.serviceWorker.register('./worker.js'); checks.worker='UNSAFE'; } catch { checks.worker='blocked'; }
document.querySelector('#result').textContent=JSON.stringify(checks);
'''


class FixtureHandler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_args):
        pass

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_POST(self):
        self.do_GET()

    def do_GET(self, head=False):
        self.requests.append((self.command, self.path, dict(self.headers)))
        path = self.path.split('?', 1)[0]
        if path.endswith('drip-headers'):
            try:
                for byte in b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n':
                    self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.03)
            except (ConnectionError, OSError):
                pass
            return
        content, mime, status, extra = FIXTURE_HTML, 'text/html', 200, {}
        if path.endswith('echo'):
            content, mime = json.dumps({'headers': dict(self.headers), 'body': self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()}).encode(), 'application/json'
        elif path.endswith('module.js'):
            content, mime = FIXTURE_MODULE, 'application/javascript'
        elif path.endswith('dependency.js'):
            content, mime = b'export const value = "loaded";', 'application/javascript'
        elif path.endswith('style.css'):
            content, mime = b'body { font: 16px sans-serif; color: #123; background: #eef; }', 'text/css'
        elif path.endswith('empty.wasm'):
            content, mime = b'\0asm\x01\0\0\0', 'application/wasm'
        elif path.endswith('font.woff'):
            content, mime = b'wOFF-fixture-resource', 'font/woff'
        elif path.endswith('gzip'):
            content, mime, extra = gzip.compress(b'compressed fixture'), 'text/plain', {'Content-Encoding': 'gzip'}
        elif path.endswith('redirect'):
            status, content, extra = 302, b'', {'Location': '/prefix/next?ok=1'}
        elif path.endswith('escape'):
            status, content, extra = 302, b'', {'Location': '/admin'}
        elif path.endswith('evil'):
            status, content, extra = 302, b'', {'Location': 'http://169.254.169.254/latest/'}
        elif path.endswith('cookie'):
            extra = {'Set-Cookie': 'session=private; Path=/'}
        elif path.endswith('sse'):
            mime = 'text/event-stream'
        elif path.endswith('restricted'):
            extra = {'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY'}
        elif path.endswith('drip-body'):
            content, mime = b'x' * 128, 'text/plain'
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(100 * 1024 * 1024 if path.endswith('large') else len(content)))
        for name, value in extra.items():
            self.send_header(name, value)
        self.end_headers()
        if not head:
            try:
                if path.endswith('drip-body'):
                    for byte in content:
                        self.wfile.write(bytes([byte])); self.wfile.flush(); time.sleep(0.03)
                    return
                self.wfile.write(content)
            except (ConnectionError, OSError):
                pass


class ExternalToolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.users = {
            's': {'email': 'student@example.test', 'role': 'student', 'enabled': True, 'class_ids': ['one', 'two']},
            't': {'email': 'teacher@example.test', 'role': 'teacher', 'enabled': True},
            'ct': {'email': 'co@example.test', 'role': 'student', 'enabled': True, 'class_ids': ['one']},
        }
        self.tokens = {'a': True, **self.users}
        self.classes = {cid: {'id': cid, 'teacher_email': 'teacher@example.test', 'students': ['student@example.test', 'co@example.test']} for cid in ('one', 'two')}
        def require(header, role):
            def check(req):
                value = self.tokens.get(req.headers.get(header))
                return value if isinstance(value, dict) and value['role'] == role else None
            return check
        self.app = Flask(__name__, static_folder=None)
        self.feature = register(self.app, base_dir=self.temp.name, source_dir=Path(__file__).parents[1],
                                require_admin=lambda req: self.tokens.get(req.headers.get('X-Admin-Token')) is True,
                                require_teacher=require('X-Teacher-Token', 'teacher'), require_user=require('X-User-Token', 'student'),
                                find_user=lambda email: next((value for value in self.users.values() if value['email'] == email), None),
                                get_user_class_ids=lambda user: user.get('class_ids', []), find_class=self.classes.get,
                                teacher_classes=lambda email: [c for c in self.classes.values() if c['teacher_email'] == email])
        self.client = self.app.test_client()
        self.admin = {'X-Admin-Token': 'a'}
        self.teacher = {'X-Teacher-Token': 't'}
        self.student = {'X-User-Token': 's'}
        self.addresses = ['10.231.24.20']
        original_resolve = socket.getaddrinfo
        def resolve(*args, **kwargs):
            if args[0] != 'fixture.internal':
                return original_resolve(*args, **kwargs)
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 8080)) for ip in self.addresses]
        self.resolve = patch('tool_gateway.socket.getaddrinfo', side_effect=resolve)
        self.resolve.start()
        self.addCleanup(self.resolve.stop)
        port = self.server.server_port
        def dial(connection):
            sock = socket.socket()
            sock.settimeout(2)
            sock.connect(('127.0.0.1', port))
            connection.sock = sock
        self.dial = patch.object(PinnedConnection, 'connect', dial)
        self.dial.start()
        self.addCleanup(self.dial.stop)
        FixtureHandler.requests.clear()

    def call(self, method, path, data=None, headers=None):
        response = self.client.open(path, method=method, json=data, headers=headers or self.admin)
        self.assertLess(response.status_code, 400, response.get_data(as_text=True))
        return response.get_json()

    def revision(self):
        return self.feature.store.read()['revision']

    def registered(self, enable=True):
        self.call('PUT', '/api/admin/tools/policy', {'revision': 0, 'enabled': True, 'allowed_networks': ['10.231.24.0/24'], 'denied_networks': ['10.231.24.1/32']})
        result = self.call('POST', '/api/admin/tools', {'revision': self.revision(), 'name': 'Generic fixture', 'label': 'Open fixture', 'slug': '/fixture/', 'backend_url': 'http://fixture.internal:8080/prefix/', 'methods': ['GET', 'HEAD', 'POST']})
        self.tool = result['tool']
        tested = self.call('POST', f"/api/admin/tools/{self.tool['id']}/test", {'revision': self.revision()})
        self.assertTrue(tested['reachable'])
        if enable:
            preview = self.launch(self.admin)
            self.assertEqual(self.client.get(preview['url']).status_code, 200)
            self.call('POST', f"/api/admin/tools/{self.tool['id']}/enable", {'revision': self.revision(), 'enabled': True, 'confirmed': True, 'preview_id': preview['instance_id']})
            self.call('DELETE', f"/api/tools/instances/{preview['instance_id']}")
            self.grant('one', True)
        return self.tool

    def grant(self, cid, enabled):
        self.call('PUT', f'/api/teacher/classes/{cid}/tools', {'revision': self.revision(), 'tool_ids': [self.tool['id']] if enabled else []}, self.teacher)

    def launch(self, headers=None):
        return self.call('POST', f"/api/tools/{self.tool['id']}/launch", headers=headers or self.student)

    def test_empty_disabled_default_does_not_write_runtime_data(self):
        self.assertEqual(self.feature.store.read()['tools'], [])
        self.assertFalse(self.feature.store.read()['enabled'])
        self.assertFalse(self.feature.store.path.exists())
        self.assertEqual(self.client.get('/api/tools').status_code, 401)

    def test_admin_ownership_coteacher_and_preview_gates(self):
        self.registered(False)
        for headers in (self.student, self.teacher, {'X-Teacher-Token': 'ct'}):
            self.assertIn(self.client.get('/api/admin/tools', headers=headers).status_code, (401, 403))
        self.assertEqual(self.client.post(f"/api/tools/{self.tool['id']}/launch", headers=self.student).status_code, 403)
        self.assertEqual(self.client.put('/api/teacher/classes/one/tools', json={'revision': self.revision(), 'tool_ids': []}, headers={'X-Teacher-Token': 'ct'}).status_code, 401)
        self.classes['one']['teacher_email'] = 'another@example.test'
        self.assertEqual(self.client.get('/api/teacher/classes/one/tools', headers=self.teacher).status_code, 403)
        self.assertEqual(self.client.post(f"/api/admin/tools/{self.tool['id']}/enable", json={'revision': self.revision(), 'enabled': True, 'confirmed': True}, headers=self.admin).status_code, 409)

    def test_union_membership_disable_and_session_revocation(self):
        self.registered()
        launch = self.launch()
        self.grant('two', True)
        self.grant('one', False)
        self.assertEqual(self.client.get(launch['url']).status_code, 200)
        self.classes['two']['students'].clear()
        self.assertEqual(self.client.get(launch['url']).status_code, 403)
        self.classes['two']['students'].append('student@example.test')
        self.users['s']['enabled'] = False
        self.assertEqual(self.client.get(launch['url']).status_code, 403)
        self.users['s']['enabled'] = True
        self.tokens.pop('s')
        self.assertEqual(self.client.get(launch['url']).status_code, 403)

    def test_class_deletion_and_teacher_access_use_current_owned_grants(self):
        self.registered()
        launch = self.launch(self.teacher)
        del self.classes['one']
        self.assertEqual(self.client.get(launch['url']).status_code, 403)

    def test_gateway_prefix_cors_sandbox_and_no_credential_forwarding(self):
        self.registered()
        launch = self.launch()
        response = self.client.get(launch['url'] + 'echo', headers={'Origin': 'null', 'X-User-Token': 's', 'Cookie': 'eagle_device=secret', 'Authorization': 'Bearer secret', 'X-Forwarded-For': 'secret', 'Range': 'bytes=0-1', 'If-None-Match': 'secret'})
        self.assertEqual(response.status_code, 200)
        forwarded = {key.lower(): value for key, value in response.get_json()['headers'].items()}
        for name in ('cookie', 'authorization', 'x-user-token', 'x-forwarded-for', 'range', 'if-none-match'):
            self.assertNotIn(name, forwarded)
        self.assertEqual(FixtureHandler.requests[-1][1], '/prefix/echo')
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'null')
        self.assertNotIn('Access-Control-Allow-Credentials', response.headers)
        policy = response.headers.getlist('Content-Security-Policy')[-1]
        self.assertIn('sandbox allow-scripts allow-downloads;', policy)
        self.assertNotIn('allow-same-origin', policy)
        self.assertIn("worker-src 'none'", policy)
        self.assertIn('private, no-store', response.headers['Cache-Control'])
        # Opening the document directly still gets response-level sandboxing.
        self.assertIn('sandbox ', self.client.get(launch['url']).headers['Content-Security-Policy'])
        for asset in ('style.css', 'module.js', 'dependency.js', 'empty.wasm', 'font.woff'):
            self.assertEqual(self.client.get(launch['url'] + asset, headers={'Origin': 'null'}).status_code, 200)

    def test_redirect_cookie_sse_compression_and_response_limits(self):
        self.registered()
        prefix = self.launch()['url']
        response = self.client.get(prefix + 'redirect')
        self.assertTrue(response.headers['Location'].endswith(prefix + 'next?ok=1'))
        for path in ('escape', 'evil', 'cookie', 'sse', 'large'):
            self.assertEqual(self.client.get(prefix + path).status_code, 502, path)
        compressed = self.client.get(prefix + 'gzip')
        self.assertEqual(compressed.headers['Content-Encoding'], 'gzip')
        self.assertEqual(gzip.decompress(compressed.data), b'compressed fixture')
        self.assertEqual(self.feature.gateway.active, {})

    def test_preflight_methods_upload_and_worker_rejection(self):
        self.registered()
        prefix = self.launch()['url']
        response = self.client.options(prefix + 'echo', headers={'Origin': 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type'})
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.client.options(prefix, headers={'Origin': 'null', 'Access-Control-Request-Headers': 'Authorization'}).status_code, 403)
        self.assertEqual(self.client.get(prefix, headers={'Origin': 'https://other.test'}).status_code, 403)
        self.assertEqual(self.client.get(prefix + 'worker.js', headers={'Service-Worker': 'script'}).status_code, 403)
        self.assertEqual(self.client.delete(prefix).status_code, 405)
        self.assertEqual(self.client.post(prefix, data=b'x' * (1024 * 1024 + 1)).status_code, 413)
        self.assertEqual(self.client.post(prefix + 'echo', data=b'hello', headers={'Origin': 'null', 'Content-Type': 'text/plain'}).get_json()['body'], 'hello')

    def test_dns_rebinding_traversal_and_destination_denial(self):
        self.registered()
        prefix = self.launch()['url']
        self.addresses = ['10.231.24.21']
        self.assertEqual(self.client.get(prefix).status_code, 503)
        for address in ('127.0.0.1', '169.254.169.254', '10.231.24.1', '8.8.8.8', '::ffff:10.231.24.20'):
            self.addresses = [address]
            self.assertGreaterEqual(self.client.get(prefix).status_code, 400)
        self.addresses = ['10.231.24.20']
        for path in ('../secret', '%2e%2e/secret', 'a%2fb', '%252e%252e/secret', 'a%5cb'):
            self.assertGreaterEqual(self.client.get(prefix + path).status_code, 400, path)

    def test_expiry_closed_copied_and_wrong_instance_paths(self):
        self.registered()
        launch = self.launch()
        for row in self.feature.sessions.values():
            if not row['preview']:
                row['lease'] = time.monotonic() - 1
        self.assertEqual(self.client.get(launch['url']).status_code, 403)
        launch = self.launch()
        self.call('DELETE', f"/api/tools/instances/{launch['instance_id']}", headers=self.student)
        self.assertEqual(self.client.get(launch['url']).status_code, 403)
        self.assertEqual(self.client.get(launch['url'].replace(self.tool['id'], '0' * 32)).status_code, 403)
        self.assertEqual(self.client.get(f"/_tools/{self.tool['id']}/guessed/app/").status_code, 403)

    def test_revision_collision_and_edits_invalidate_instances(self):
        self.registered()
        launch = self.launch()
        old = self.revision()
        for slug in ('api', 'static', 'ide', 'wiki', 'network', 'health', '_tools', 'two/segments'):
            with self.assertRaises(ToolError):
                self.feature.store.save_tool({'revision': old, 'name': 'n', 'label': 'l', 'slug': slug, 'backend_url': 'http://fixture.internal/'}, set())
        self.assertEqual(self.client.post('/api/admin/tools', headers=self.admin, json={'revision': old - 1, 'name': 'n', 'label': 'l', 'slug': 'other', 'backend_url': 'http://fixture.internal/'}).status_code, 409)
        raw = {**self.tool, 'revision': old, 'name': 'Updated'}
        self.call('POST', '/api/admin/tools', raw)
        self.assertEqual(self.client.get(launch['url']).status_code, 403)

    def test_global_disable_instance_ownership_limits_and_safe_student_metadata(self):
        self.registered()
        launch = self.launch()
        listed = self.call('GET', '/api/tools', headers=self.student)
        self.assertNotIn('backend_url', listed['tools'][0])
        self.assertNotIn('addresses', listed['tools'][0])
        self.assertEqual(self.client.delete(f"/api/tools/instances/{launch['instance_id']}", headers=self.teacher).status_code, 410)
        self.launch()
        self.assertEqual(self.client.post(f"/api/tools/{self.tool['id']}/launch", headers=self.student).status_code, 429)
        self.call('PUT', '/api/admin/tools/policy', {'revision': self.revision(), 'enabled': False, 'allowed_networks': [], 'denied_networks': []})
        self.assertEqual(self.client.get(launch['url']).status_code, 403)
        self.assertEqual(self.call('GET', '/api/tools', headers=self.student)['tools'], [])

    def test_original_frame_restrictions_and_head_are_preserved(self):
        self.registered()
        prefix = self.launch()['url']
        response = self.client.get(prefix + 'restricted')
        self.assertEqual(response.headers['X-Frame-Options'], 'DENY')
        self.assertIn("frame-ancestors 'none'", response.headers.getlist('Content-Security-Policy'))
        self.assertTrue(any('sandbox ' in policy for policy in response.headers.getlist('Content-Security-Policy')))
        head = self.client.head(prefix + 'module.js')
        self.assertEqual(head.data, b'')
        self.assertEqual(head.headers['Content-Type'], 'application/javascript')

    def test_destination_parsing_tls_pinning_and_self_address_rejection(self):
        for url in ('file:///etc/passwd', 'ftp://example.test/', 'http://user:password@host/', 'http://host/base/../secret/', 'http://host/?url=other', 'http://host/base%2fescape/'):
            with self.assertRaises(ToolError, msg=url):
                target_url(url)
        target = target_url('https://fixture.internal:8443/prefix/')
        with self.assertRaises(ToolError):
            approve_addresses(target, {'allowed_networks': ['10.231.24.0/24']}, self.addresses)
        self.addresses = ['10.231.24.20', '169.254.169.254']
        with self.assertRaises(ToolError):
            approve_addresses(target, {'allowed_networks': ['10.231.24.0/24']})
        # Exercise the real connect implementation, not the fixture dial replacement.
        self.dial.stop()
        connection = PinnedConnection(target, '10.231.24.20')
        with patch('tool_gateway.socket.create_connection') as connect, patch('tool_gateway.ssl.create_default_context') as context:
            connection.connect()
            self.assertEqual(connect.call_args.args[0], ('10.231.24.20', 8443))
            self.assertEqual(context.return_value.wrap_socket.call_args.kwargs['server_hostname'], 'fixture.internal')
        self.dial.start()

    def test_stream_cancel_timeout_and_connection_limits_release_slots(self):
        self.registered()
        launch = self.launch()
        response = self.client.get(launch['url'], buffered=False)
        response.close()
        self.assertEqual(self.feature.gateway.active, {})
        with patch.object(PinnedConnection, 'connect', side_effect=socket.timeout()):
            self.assertEqual(self.client.get(launch['url']).status_code, 502)
        self.assertEqual(self.feature.gateway.active, {})
        for _ in range(16):
            self.feature.gateway.slots.acquire()
        try:
            self.assertEqual(self.client.get(launch['url']).status_code, 429)
        finally:
            for _ in range(16):
                self.feature.gateway.slots.release()

    def test_slow_upload_is_bounded_before_upstream_and_other_requests_stay_available(self):
        self.registered()
        launch = self.launch()
        from werkzeug.serving import make_server
        server = make_server('127.0.0.1', 0, self.app, threaded=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch('external_tools.UPLOAD_IDLE_SECONDS', 0.08), patch('external_tools.UPLOAD_TOTAL_SECONDS', 0.15):
                with socket.socket() as client:
                    client.settimeout(2)
                    client.connect(('127.0.0.1', server.server_port))
                    client.sendall(f"POST {launch['url']}echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n".encode())
                    self.assertEqual(self.client.get('/api/tools', headers=self.student).status_code, 200)
                    self.assertIn(b'408', client.recv(8192).split(b'\r\n', 1)[0])
            self.assertEqual(self.feature.gateway.active, {})
            self.assertFalse(any(path.endswith('echo') for _, path, _ in FixtureHandler.requests))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_trickling_headers_hit_absolute_deadline_and_release_admission(self):
        self.registered()
        launch = self.launch()
        started = time.monotonic()
        with patch('tool_gateway.TOTAL_TIMEOUT', 0.12):
            response = self.client.get(launch['url'] + 'drip-headers')
        self.assertEqual(response.status_code, 502)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(self.feature.gateway.active, {})

    def test_trickling_body_cannot_extend_response_deadline(self):
        self.registered()
        launch = self.launch()
        started = time.monotonic()
        with patch('tool_gateway.TOTAL_TIMEOUT', 0.12):
            response = self.client.get(launch['url'] + 'drip-body')
            self.assertLess(len(response.get_data()), 128)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(self.feature.gateway.active, {})

    def test_catalog_corruption_fails_closed_and_capability_logs_are_redacted(self):
        self.feature.store.path.write_text('{broken', encoding='utf-8')
        self.assertEqual(self.client.get('/api/tools', headers=self.student).status_code, 503)
        record = logging.LogRecord('werkzeug', logging.INFO, '', 0, 'GET %s', (f"/_tools/{'a' * 32}/secret-token/app/",), None)
        CapabilityLogFilter().filter(record)
        self.assertNotIn('secret-token', record.getMessage())


if __name__ == '__main__':
    unittest.main()
