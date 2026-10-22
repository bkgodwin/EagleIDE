"""Generic fixture only: no third-party application downloads or installations."""
import base64
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import IncompleteRead
import json
import logging
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from concurrent.futures import ThreadPoolExecutor

from flask import Flask

from external_tools import register
from tool_gateway import CapabilityLogFilter, PinnedConnection, approve_addresses, html_body, redirect_path, safe_path, target_url
from tool_store import ToolError, ToolStore

FIXTURE_CSS = b'body { font: 16px sans-serif; color: #123; background: #eef; }'
FIXTURE_SRI = 'sha384-' + base64.b64encode(hashlib.sha384(FIXTURE_CSS).digest()).decode()

FIXTURE_HTML = b'''<!doctype html><meta charset="utf-8"><title>Generic tool fixture</title>
<link rel="stylesheet" href="style.css" integrity="SRI_HASH"><h1>Generic application fixture</h1>
<label>Project draft <textarea id="draft" rows="5">Initial project</textarea></label>
<button id="serverCheck" type="button">Check server action</button><output id="serverResult"></output>
<p><input type="file" id="fileInput"><output id="fileBytes"></output><button id="fileDownload">Download imported file</button></p>
<p><button id="promptTest">Prompt</button><output id="promptResult"></output><button id="popupTest">Popup</button></p>
<p id="result">Loading fixture</p>
<script type="module" src="module.js"></script>'''.replace(b'SRI_HASH', FIXTURE_SRI.encode())
FIXTURE_MODULE = b'''import {value} from './dependency.js';
const checks = {module: value};
await WebAssembly.instantiate(await (await fetch('./empty.wasm')).arrayBuffer()); checks.wasm=true;
checks.font=(await fetch('./font.woff')).ok;
checks.write=(await (await fetch('./echo', {method:'POST',body:'fixture write'})).json()).body;
try { localStorage.setItem('fixture-secret','private'); checks.storage='scoped'; } catch { checks.storage='blocked'; }
try { parent.document.body.dataset.leaked='yes'; checks.parent='UNSAFE'; } catch { checks.parent='blocked'; }
try { await navigator.serviceWorker.register('./worker.js'); checks.worker='UNSAFE'; } catch { checks.worker='blocked'; }
document.querySelector('#result').textContent=JSON.stringify(checks);
let imported;
document.querySelector('#fileInput').onchange=async event=>{imported=await event.target.files[0].arrayBuffer();document.querySelector('#fileBytes').textContent=String(imported.byteLength);};
document.querySelector('#fileDownload').onclick=()=>{const url=URL.createObjectURL(new Blob([imported]));const link=document.createElement('a');link.href=url;link.download='imported.bin';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
document.querySelector('#promptTest').onclick=()=>document.querySelector('#promptResult').textContent=prompt('Fixture filename','default') || 'empty';
document.querySelector('#popupTest').onclick=()=>window.open('about:blank','tool-fixture');
document.querySelector('#serverCheck').onclick=async () => {
  const reply=await fetch('./echo', {method:'POST',body:document.querySelector('#draft').value});
  document.querySelector('#serverResult').textContent=reply.ok ? (await reply.json()).body : 'FAILED';
};
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
        if path.endswith('burst-asset'):
            time.sleep(0.15)
            content, mime = b'asset loaded', 'text/plain'
        elif path.endswith('large-data'):
            size = 72 * 1024 * 1024
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(size))
            self.end_headers()
            if not head:
                try:
                    for _ in range(size // (64 * 1024)):
                        self.wfile.write(b'x' * (64 * 1024))
                except (ConnectionError, OSError):
                    pass
            return
        elif path.endswith('echo'):
            content, mime = json.dumps({'headers': dict(self.headers), 'body': self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()}).encode(), 'application/json'
        elif path.endswith('module.js'):
            content, mime = FIXTURE_MODULE, 'application/javascript'
        elif path.endswith('dependency.js'):
            content, mime = b'export const value = "loaded";', 'application/javascript'
        elif path.endswith('style.css'):
            content, mime = FIXTURE_CSS, 'text/css'
        elif path.endswith('empty.wasm'):
            content, mime = b'\0asm\x01\0\0\0', 'application/wasm'
        elif path.endswith('font.woff'):
            content, mime = b'wOFF-fixture-resource', 'font/woff'
        elif path.endswith('gzip'):
            content, mime, extra = gzip.compress(b'compressed fixture'), 'text/plain', {'Content-Encoding': 'gzip'}
        elif path.endswith('gzip-html'):
            content, extra = gzip.compress(FIXTURE_HTML), {'Content-Encoding': 'gzip'}
        elif path.endswith('html-attachment'):
            extra = {'Content-Disposition': 'attachment; filename="project.html"'}
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
        self.send_header('Content-Length', str(1024 * 1024 * 1024 if path.endswith('large') else len(content)))
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
            'm': {'email':'manager@example.invalid','role':'wiki_manager','enabled':True},
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
                                require_wiki_manager=require('X-Wiki-Manager-Token','wiki_manager'),
                                require_teacher=require('X-Teacher-Token', 'teacher'), require_user=require('X-User-Token', 'student'),
                                find_user=lambda email: next((value for value in self.users.values() if value['email'] == email), None),
                                get_user_class_ids=lambda user: user.get('class_ids', []), find_class=self.classes.get,
                                teacher_classes=lambda email: [c for c in self.classes.values() if c['teacher_email'] == email],
                                account_id=lambda user: user['email'] if user else 'administrator')
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

    def test_scoped_storage_routes_revalidate_and_never_expose_another_account(self):
        self.registered()
        def update(data):
            data['tools'][0].update(storage=True, popups=True, dialogs=True)
        self.feature.store.mutate(self.revision(), update)
        launch = self.launch()
        prefix = launch['url'] + '__eagle__/'
        document = self.client.get(launch['url'])
        self.assertIn('__eagle__/runtime.js', document.get_data(as_text=True))
        policy = document.headers.getlist('Content-Security-Policy')[-1]
        self.assertIn('allow-popups allow-modals', policy)
        self.assertNotIn('allow-same-origin', policy)
        script = self.client.get(prefix + 'runtime.js', headers={'Origin': 'null'})
        self.assertEqual(script.status_code, 200)
        self.assertNotIn('X-User-Token', script.get_data(as_text=True))
        script.close()
        for _ in range(3):
            with self.client.get(prefix + 'runtime.js', headers={'Origin': 'null'}) as repeated:
                self.assertEqual(repeated.status_code, 200)
        self.assertEqual(self.feature.gateway.active, {})
        snapshot = self.feature.storage.snapshot(self.users['s']['email'], self.tool['id'])
        begin = self.client.post(prefix + 'begin', json={**snapshot, 'changes': [{'key': 'project', 'size': 5}]}, headers={'Origin': 'null'}).get_json()
        upload = begin['upload_id']
        second = self.launch(self.teacher)['url'] + '__eagle__/'
        self.assertEqual(self.client.post(second + 'commit', json={'upload_id': upload}).status_code, 410)
        self.assertEqual(self.client.post(prefix + 'chunk?id=' + upload + '&offset=0', data=b'hello').status_code, 200)
        self.assertEqual(self.client.post(prefix + 'commit', json={'upload_id': upload}).status_code, 200)
        self.assertEqual(self.client.get('/api/tools/storage', headers=self.student).get_json()['storage']['used_bytes'], 5)
        self.assertEqual(self.client.get('/api/tools/storage', headers=self.teacher).get_json()['storage']['used_bytes'], 0)
        with self.client.get('/api/tools/storage/' + self.tool['id'] + '/export', headers=self.student) as exported:
            self.assertEqual(exported.get_json()['entries'], {'project': 'hello'})
        self.tokens.pop('s')
        self.assertEqual(self.client.get(prefix + 'runtime.js', headers={'Origin': 'null'}).status_code, 403)
        self.assertEqual(self.client.get('/api/tools/storage').status_code, 401)

    def test_storage_admin_policy_and_user_clear_require_ownership_and_fresh_version(self):
        self.registered()
        self.assertEqual(self.client.put('/api/admin/tools/storage?email=student@example.test', headers=self.teacher, json={}).status_code, 403)
        policy = self.call('GET', '/api/admin/tools/storage?email=student@example.test')['storage']
        self.call('PUT', '/api/admin/tools/storage?email=student@example.test', {'version': policy['version'], 'enabled': True, 'quota_mib': 1})
        self.assertEqual(self.client.put('/api/admin/tools/storage?email=student@example.test', headers=self.admin, json={'version': 0, 'enabled': False, 'quota_mib': 1}).status_code, 409)
        self.assertEqual(self.client.delete('/api/tools/storage', headers=self.student, json={'epoch': policy['epoch']}).status_code, 409)
        current = self.call('GET', '/api/tools/storage', headers=self.student)['storage']
        self.call('DELETE', '/api/tools/storage', {'epoch': current['epoch']}, self.student)

    def test_configured_server_uploads_remain_bounded_and_separate_from_cloud_chunks(self):
        self.registered()
        self.feature.store.mutate(self.revision(), lambda data: data['tools'][0].update(upload_mib=3))
        prefix = self.launch()['url']
        response = self.client.post(prefix + 'echo', data=b'x' * (2 * 1024 * 1024))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.get_json()['body']), 2 * 1024 * 1024)
        self.assertEqual(self.client.post(prefix + 'echo', data=b'x' * (3 * 1024 * 1024 + 1)).status_code, 413)
        self.assertEqual(self.client.post(prefix + '__eagle__/begin', data=b'x' * (512 * 1024 + 1)).status_code, 403)

    def test_snapshot_slots_release_over_real_http_and_head_never_reserves_one(self):
        from urllib.request import urlopen
        from werkzeug.serving import make_server
        self.registered()
        prefix = self.launch()['url']
        server = make_server('127.0.0.1', 0, self.app, threaded=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for _ in range(5):
                with urlopen(f'http://127.0.0.1:{server.server_port}' + prefix + '__eagle__/runtime.js', timeout=3) as response:
                    self.assertIn(b'showOpenFilePicker', response.read())
            for _ in range(3):
                self.assertEqual(self.client.head(prefix + '__eagle__/runtime.js').status_code, 200)
            self.assertEqual(self.feature.gateway.active, {})
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)

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

    def test_wiki_managers_can_launch_enabled_tools_but_cannot_administer_tools_or_class_grants(self):
        self.registered()
        manager = {'X-Wiki-Manager-Token':'m'}
        self.assertEqual(len(self.call('GET','/api/tools',headers=manager)['tools']),1)
        launch = self.launch(manager)
        self.assertEqual(self.client.get(launch['url']).status_code,200)
        self.assertIn(self.client.get('/api/admin/tools',headers=manager).status_code,(401,403))
        self.assertIn(self.client.put('/api/teacher/classes/one/tools',json={'revision':self.revision(),'tool_ids':[]},headers=manager).status_code,(401,403))
        self.users['m']['enabled'] = False
        self.assertEqual(self.client.get(launch['url']).status_code,403)

    def test_teachers_have_enabled_tools_without_classes_or_grants_but_students_do_not(self):
        self.registered()
        self.grant('one', False)
        self.classes.clear()
        self.assertEqual(len(self.call('GET', '/api/tools', headers=self.teacher)['tools']), 1)
        self.assertEqual(self.call('GET', '/api/tools', headers=self.student)['tools'], [])
        self.assertEqual(self.call('GET', '/api/tools', headers={'X-User-Token': 'ct'})['tools'], [])
        launch = self.launch(self.teacher)
        self.assertEqual(self.client.get(launch['url']).status_code, 200)
        self.call('POST', f"/api/tools/instances/{launch['instance_id']}", headers=self.teacher)
        self.users['t']['role'] = 'student'
        self.assertEqual(self.client.get(launch['url']).status_code, 403)

    def test_teacher_access_obeys_tool_global_account_and_session_disablement(self):
        self.registered()
        launch = self.launch(self.teacher)
        self.users['t']['enabled'] = False
        self.assertEqual(self.client.get(launch['url']).status_code, 403)
        self.users['t']['enabled'] = True
        token = self.tokens.pop('t')
        self.assertEqual(self.client.get(launch['url']).status_code, 403)
        self.tokens['t'] = token
        self.feature.store.mutate(self.revision(), lambda data: data.update(enabled=False))
        self.assertEqual(self.call('GET', '/api/tools', headers=self.teacher)['tools'], [])
        self.assertEqual(self.client.get(launch['url']).status_code, 403)
        self.feature.store.mutate(self.revision(), lambda data: data.update(enabled=True))
        self.call('POST', f"/api/admin/tools/{self.tool['id']}/enable", {'revision': self.revision(), 'enabled': False})
        self.assertEqual(self.call('GET', '/api/tools', headers=self.teacher)['tools'], [])
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
            with patch('tool_gateway.ADMISSION_TIMEOUT', 0.02):
                self.assertEqual(self.client.get(launch['url']).status_code, 429)
        finally:
            for _ in range(16):
                self.feature.gateway.slots.release()

    def test_asset_bursts_wait_for_bounded_capacity_instead_of_failing_startup(self):
        self.registered()
        prefix = self.launch()['url']
        barrier = threading.Barrier(10)
        def download(_index):
            barrier.wait(timeout=5)
            with self.app.test_client() as client:
                response = client.get(prefix + 'burst-asset')
                return response.status_code, response.data
        with ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(download, range(10)))
        self.assertEqual(results, [(200, b'asset loaded')] * 10)
        self.assertEqual(self.feature.gateway.active, {})
        self.assertEqual(self.feature.gateway.waiting, [])

    def test_large_binary_stream_exceeds_old_64_mib_limit_without_buffering(self):
        self.registered()
        response = self.client.get(self.launch()['url'] + 'large-data', buffered=False)
        self.assertEqual(response.status_code, 200)
        size = sum(len(chunk) for chunk in response.response)
        response.close()
        self.assertEqual(size, 72 * 1024 * 1024)
        self.assertEqual(self.feature.gateway.active, {})

    def test_sri_html_keeps_integrity_adds_anonymous_cors_and_reframes_gzip(self):
        self.registered()
        prefix = self.launch()['url']
        for path in ('', 'gzip-html'):
            response = self.client.get(prefix + path)
            self.assertEqual(response.status_code, 200)
            self.assertIn(f'integrity="{FIXTURE_SRI}" crossorigin="anonymous"', response.get_data(as_text=True))
            self.assertEqual(int(response.headers['Content-Length']), len(response.data))
            self.assertNotIn('Content-Encoding', response.headers)
            self.assertIn('sandbox allow-scripts allow-downloads;', response.headers.getlist('Content-Security-Policy')[-1])
        attachment = self.client.get(prefix + 'html-attachment')
        self.assertEqual(attachment.data, FIXTURE_HTML)
        self.assertEqual(int(attachment.headers['Content-Length']), len(FIXTURE_HTML))
        head = self.client.head(prefix + 'gzip-html')
        self.assertNotIn('Content-Encoding', head.headers)
        self.assertNotIn('Content-Length', head.headers)

    def test_html_adapter_preserves_scripts_attributes_encoding_and_integrity_values(self):
        body = (b'<!-- <link integrity="comment"> -->\r\n'
                b'<script>const text="<link integrity=script>";</script>\n'
                b'<LINK rel="stylesheet" integrity="unchanged" href="a.css"/>\r\n'
                b'<script integrity="unchanged-2" src="a.js"></script>\n'
                b'<link integrity="existing" crossorigin="anonymous" href="b.css">\n'
                b'<p>\xc3\xa9</p>')
        response = Mock()
        response.getheader.side_effect = lambda name, default=None: {'Content-Length': str(len(body))}.get(name, default)
        response.read1.side_effect = [body[:50], body[50:], b'']
        close = Mock()
        result = html_body(response, close, lambda: True)
        expected = body.replace(b'href="a.css"/>', b'href="a.css" crossorigin="anonymous"/>').replace(b'src="a.js">', b'src="a.js" crossorigin="anonymous">')
        self.assertEqual(result, expected)
        close.assert_called_once()

    def test_bootstrap_precedes_app_scripts_without_matching_comments_or_script_text(self):
        body = b'<!doctype html><!-- <head> --><html><head><meta charset="utf-8"><script>const raw="<head>";</script></head></html>'
        response = Mock()
        response.read1.side_effect = [body, b'']
        response.getheader.side_effect = lambda name, default=None: default
        result = html_body(response, Mock(), lambda: True, 'https://eagle.test/_tools/scoped/runtime.js')
        self.assertTrue(result.startswith(b'<!doctype html><!-- <head> --><html><head><script src='))
        self.assertIn(b'<script>const raw="<head>";</script>', result)
        self.assertEqual(result.count(b'/runtime.js'), 1)

    def test_html_adapter_rejects_oversize_expansion_and_incomplete_documents(self):
        for body, length, encoding in [(gzip.compress(b'x' * 100), None, 'gzip'), (b'<html>', 100, 'identity')]:
            response = Mock()
            response.getheader.side_effect = lambda name, default=None: {'Content-Length': str(length) if length else None, 'Content-Encoding': encoding}.get(name, default)
            response.read1.side_effect = [body, b'']
            with patch('tool_gateway.MAX_HTML', 60), self.assertRaises(ToolError):
                html_body(response, Mock(), lambda: True)
        response = Mock()
        response.read1.side_effect = IncompleteRead(b'partial chunked HTML')
        with self.assertRaises(ToolError):
            html_body(response, Mock(), lambda: True)
        response = Mock()
        response.read1.side_effect = [b'<html></html>', b'']
        response.getheader.side_effect = lambda name, default=None: default
        with self.assertRaises(ToolError) as revoked:
            html_body(response, Mock(), Mock(side_effect=[True, False]))
        self.assertEqual(revoked.exception.status, 403)

    def test_queued_asset_request_rechecks_access_after_promotion(self):
        self.registered()
        prefix = self.launch()['url']
        row = next(row for row in self.feature.sessions.values() if not row['preview'])
        permits = [self.feature.gateway.admit(row['owner']) for _ in range(4)]
        result = []
        def request_asset():
            with self.app.test_client() as client:
                result.append(client.get(prefix + 'burst-asset').status_code)
        thread = threading.Thread(target=request_asset)
        thread.start()
        try:
            deadline = time.monotonic() + 2
            while not self.feature.gateway.waiting and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(self.feature.gateway.waiting)
            self.grant('one', False)
        finally:
            for release in permits:
                release()
            thread.join(timeout=3)
        self.assertEqual(result, [403])
        self.assertEqual(self.feature.gateway.waiting, [])
        self.assertEqual(self.feature.gateway.active, {})

    def test_per_account_queue_bound_and_timeout_release_waiters(self):
        gateway = self.feature.gateway
        permits = [gateway.admit('busy') for _ in range(4)]
        result = []
        def wait_for_slot():
            try:
                gateway.admit('busy', wait=True)()
            except ToolError as error:
                result.append(error.status)
        try:
            with patch('tool_gateway.MAX_OWNER_WAITING', 1), patch('tool_gateway.ADMISSION_TIMEOUT', 0.3):
                thread = threading.Thread(target=wait_for_slot)
                thread.start()
                deadline = time.monotonic() + 1
                while not gateway.waiting and time.monotonic() < deadline:
                    time.sleep(0.005)
                with self.assertRaises(ToolError):
                    gateway.admit('busy', wait=True)
                gateway.admit('other')()  # A busy account does not block another.
                thread.join(timeout=2)
                self.assertEqual(result, [429])
        finally:
            for release in permits:
                release()
        self.assertEqual(gateway.waiting, [])
        self.assertEqual(gateway.active, {})

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
