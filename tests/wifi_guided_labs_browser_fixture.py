"""Isolated loopback fixture for assessed Infra Sim lab browser checks."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import types

from cryptography.fernet import Fernet
from werkzeug.serving import make_server

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
from config import DEFAULT_CONFIG

with tempfile.TemporaryDirectory(prefix='eagle-infra-check-') as temporary:
    root = Path(temporary)
    shutil.copytree(repo / 'static', root / 'static')
    for pattern in ('*.py', '*.csv', '*.html', 'js_worker.js'):
        for source in repo.glob(pattern):
            shutil.copy2(source, root / source.name)
    for key, folder in [('EAGLEIDE_TOOL_DATA_DIR', 'tools'), ('EAGLEIDE_NETWORK_DATA_DIR', 'network'),
                        ('EAGLEIDE_WIKI_DATA_DIR', 'wiki'), ('EAGLEIDE_WIKI_BACKUP_DIR', 'backups'),
                        ('EAGLEIDE_LESSON_PLAN_DATA_DIR', 'plans'), ('EAGLEIDE_BACKGROUND_ASSETS_DIR', 'backgrounds'),
                        ('EAGLEIDE_ASSIGNMENT_SUBMISSIONS_DIR', 'submissions'), ('EAGLEIDE_CLEANUP_DATA_DIR', 'cleanup')]:
        os.environ[key] = str(root / folder)
    key = Fernet.generate_key()
    (root / '.admin_key').write_bytes(key)
    config = {**DEFAULT_CONFIG, 'admin_email': 'admin@example.test', 'network_sim_enabled': True,
              'admin_password_encrypted': Fernet(key).encrypt(b'fixture-only-password').decode()}
    (root / 'config.txt').write_text(json.dumps(config), encoding='utf-8')
    eagle = types.ModuleType('app')
    eagle.__file__ = str(root / 'app.py')
    sys.modules['app'] = eagle
    exec(compile((root / 'app.py').read_text(encoding='utf-8'), str(root / 'app.py'), 'exec'), eagle.__dict__)
    eagle.app.static_folder = str(repo / 'static')
    eagle._admin_tokens.add('infra-fixture-admin')
    eagle._assignment_ai_recovery_checked = True
    @eagle.app.get('/fixture/light')
    @eagle.app.get('/fixture/dark')
    def fixture_session():
        light = eagle.request.path.endswith('light')
        theme = 'light' if light else 'dark'
        return '<!doctype html><title>Infra Sim test fixture</title><script src="/fixture/session.js?theme=' + theme + '"></script>'

    @eagle.app.get('/fixture/session.js')
    def fixture_script():
        theme = 'light' if eagle.request.args.get('theme') == 'light' else 'dark'
        code = 'sessionStorage.setItem("eagle-auth-session-v1", JSON.stringify({adminToken:"infra-fixture-admin"})); localStorage.setItem("ide-theme",' + json.dumps(theme) + '); location.replace("/network");'
        return eagle.app.response_class(code, mimetype='text/javascript')

    from network_store import NetworkStore
    classroom = {'id': 'net-design', 'name': 'Infra Design', 'teacher_email': 'teacher@example.test', 'students': ['student@example.test']}
    second = {'id': 'net-review', 'name': 'Policy Review', 'teacher_email': 'teacher@example.test', 'students': []}
    eagle._save_classes({'classes': [classroom, second]})
    teacher = {'email': 'teacher@example.test', 'role': 'teacher', 'name': 'Fixture Teacher', 'enabled': True}
    student = {'email': 'student@example.test', 'role': 'student', 'name': 'Fixture Student', 'enabled': True, 'class_ids': ['net-design']}
    eagle._save_users({'users': [teacher, student]})
    eagle._teacher_tokens['fixture-teacher'] = teacher
    eagle._student_tokens['fixture-student'] = student
    NetworkStore(eagle.NETWORK_DATA_DIR).set_class_access('net-design', True)

    @eagle.app.get('/fixture/classroom/<role>')
    def classroom_session(role):
        if role not in ('teacher', 'student'):
            return '', 404
        return '<!doctype html><title>Infra classroom fixture</title><script src="/fixture/classroom.js?role=' + role + '"></script>'

    @eagle.app.get('/fixture/classroom.js')
    def classroom_script():
        role = eagle.request.args.get('role')
        profile = teacher if role == 'teacher' else student
        payload = {'teacherToken': 'fixture-teacher', 'currentTeacher': profile} if role == 'teacher' else {'userToken': 'fixture-student', 'currentUser': profile}
        code = 'sessionStorage.setItem("eagle-auth-session-v1",' + json.dumps(json.dumps(payload)) + '); localStorage.setItem("ide-theme","light"); location.replace("/network");'
        return eagle.app.response_class(code, mimetype='text/javascript')
    sys.path.insert(0, str(repo / 'tests'))
    from test_wifi_guided_labs import solution
    from wifi_guided_labs import LABS

    @eagle.app.get('/fixture/lab5')
    def lab5():
        site = solution(LABS['infra-lab-05'])
        site['cables'] = [c for c in site['cables'] if c['id'] != 'wing-backbone']
        next(d for d in site['equipment'] if d['id'] == 'remote-switch')['port_vlans']['SFP1'] = [0]
        return eagle.jsonify(site)

    server = make_server('127.0.0.1', 0, eagle.app, threaded=True)
    print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}'}), flush=True)
    server.serve_forever()
