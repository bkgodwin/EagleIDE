"""Opt-in local browser fixture. All accounts, grants and application state are temporary.

Run from the repository root with Python; prints the local URL and test tokens.
The numerical application connection is replaced only in this test process.
"""
import builtins
import argparse
from functools import partial
import getpass
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_external_tools import FixtureHandler
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-directory', type=Path, help='Serve an existing public static app build at /prefix/ instead of the generic fixture')
    args = parser.parse_args()
    handler = FixtureHandler
    if args.app_directory:
        directory = args.app_directory.resolve()
        if not (directory / 'index.html').is_file():
            parser.error('--app-directory must contain a public index.html build')

        class StaticApp(SimpleHTTPRequestHandler):
            def do_GET(self):
                if not self.path.startswith('/prefix/'):
                    self.send_error(404)
                    return
                self.path = self.path[len('/prefix'):]
                super().do_GET()

            def log_message(self, *_args):
                pass

        handler = partial(StaticApp, directory=str(directory))
    with tempfile.TemporaryDirectory(prefix='eagle-tool-browser-') as temporary:
        root = Path(temporary)
        for key, folder in [('EAGLEIDE_TOOL_DATA_DIR', 'tools'), ('EAGLEIDE_NETWORK_DATA_DIR', 'network'), ('EAGLEIDE_WIKI_DATA_DIR', 'wiki'), ('EAGLEIDE_WIKI_BACKUP_DIR', 'backup')]:
            os.environ[key] = str(root / folder)
        with patch.object(builtins, 'input', return_value='admin@example.test'), patch.object(getpass, 'getpass', return_value='fixture-only-password'):
            import app as eagle
        eagle.USERS_FILE, eagle.CLASSES_FILE = root / 'users.json', root / 'classes.json'
        eagle.USER_FILES_DIR, eagle.NOTEBOOKS_DIR = root / 'files', root / 'notebooks'
        eagle.SANDBOX_DIR = root / 'sandboxes'
        for folder in (eagle.USER_FILES_DIR, eagle.NOTEBOOKS_DIR, eagle.SANDBOX_DIR):
            folder.mkdir()
        eagle._admin_tokens.add('fixture-admin')
        teacher = {'email': 'teacher@example.test', 'name': 'Fixture Teacher', 'role': 'teacher', 'enabled': True}
        student = {'email': 'student@example.test', 'name': 'Fixture Student', 'role': 'student', 'enabled': True, 'class_ids': ['fixture-class'], 'class_id': 'fixture-class'}
        eagle._save_users({'users': [teacher, student]})
        eagle._save_classes({'classes': [{'id': 'fixture-class', 'name': 'Fixture class', 'teacher_email': teacher['email'], 'join_code': 'FIXTURE', 'students': [student['email']], 'settings': {}}]})
        eagle._teacher_tokens['fixture-teacher'] = teacher
        eagle._student_tokens['fixture-student'] = student
        fixture = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
        from tool_gateway import PinnedConnection
        original_resolve = socket.getaddrinfo
        def resolve(host, port, *args, **kwargs):
            if host == 'fixture.internal':
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('10.231.24.20', 8080))]
            return original_resolve(host, port, *args, **kwargs)
        def dial(connection):
            sock = socket.socket(); sock.settimeout(3); sock.connect(('127.0.0.1', fixture.server_port)); connection.sock = sock
        from werkzeug.serving import make_server
        with patch('tool_gateway.socket.getaddrinfo', side_effect=resolve), patch.object(PinnedConnection, 'connect', dial):
            server = make_server('127.0.0.1', 0, eagle.app, threaded=True)
            print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}', 'admin': 'fixture-admin', 'teacher': 'fixture-teacher', 'student': 'fixture-student'}), flush=True)
            try:
                server.serve_forever()
            finally:
                fixture.shutdown(); fixture.server_close()


if __name__ == '__main__':
    main()
