"""Run an isolated EagleIDE copy for opt-in agenda browser checks; all data is temporary."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import types
from datetime import date, datetime, timedelta, timezone

from cryptography.fernet import Fernet


def main():
    repo = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo))
    with tempfile.TemporaryDirectory(prefix='eagle-agenda-browser-') as temporary:
        root = Path(temporary)
        shutil.copytree(repo / 'static', root / 'static')
        for pattern in ('*.py', '*.csv', '*.html', 'js_worker.js'):
            for source in repo.glob(pattern):
                shutil.copy2(source, root / source.name)
        for key, folder in [('EAGLEIDE_TOOL_DATA_DIR', 'tools'), ('EAGLEIDE_NETWORK_DATA_DIR', 'network'),
                            ('EAGLEIDE_WIKI_DATA_DIR', 'wiki'), ('EAGLEIDE_WIKI_BACKUP_DIR', 'backups'),
                            ('EAGLEIDE_LESSON_PLAN_DATA_DIR', 'plans'), ('EAGLEIDE_BACKGROUND_ASSETS_DIR', 'backgrounds'),
                            ('EAGLEIDE_ASSIGNMENT_SUBMISSIONS_DIR', 'submissions')]:
            os.environ[key] = str(root / folder)
        from config import DEFAULT_CONFIG
        key = Fernet.generate_key()
        (root / '.admin_key').write_bytes(key)
        config = {**DEFAULT_CONFIG, 'admin_email': 'admin@example.test',
                  'admin_password_encrypted': Fernet(key).encrypt(b'fixture-only-password').decode()}
        (root / 'config.txt').write_text(json.dumps(config), encoding='utf-8')
        eagle = types.ModuleType('app')
        eagle.__file__ = str(root / 'app.py')
        sys.modules['app'] = eagle
        exec(compile((root / 'app.py').read_text(encoding='utf-8'), str(root / 'app.py'), 'exec'), eagle.__dict__)
        eagle.app.static_folder = str(repo / 'static')
        eagle._assignment_ai_recovery_checked = True
        teacher = {'email': 'teacher@example.test', 'name': 'Alex Rivera', 'role': 'teacher', 'enabled': True}
        student = {'email': 'student@example.test', 'name': 'Jamie Lee', 'role': 'student', 'enabled': True,
                   'class_id': 'agenda-class', 'class_ids': ['agenda-class']}
        eagle._save_users({'users': [teacher, student]})
        eagle._save_classes({'classes': [{'id': 'agenda-class', 'name': 'Computer Science · Period 2',
            'teacher_email': teacher['email'], 'students': [student['email']], 'join_code': 'AGENDA',
            'settings': {'assignment_submission_window': {'timeZone': 'America/Chicago'}},
            'accommodations': {student['email']: {'extendedWeekdays': 1}}},
            {'id':'agenda-section','name':'Computer Science · Period 3','teacher_email':teacher['email'],'students':[],'settings':{}},
            {'id':'other-class','name':'Unrelated private class','teacher_email':'other@example.test','students':[],'settings':{}}]})
        eagle._teacher_tokens['agenda-teacher'] = teacher
        eagle._student_tokens['agenda-student'] = student
        eagle._admin_tokens.add('agenda-admin')
        teacher_root = eagle._get_user_dir(teacher['email'])
        teacher_root.mkdir(parents=True, exist_ok=True)
        (teacher_root / 'loops.py').write_text('for number in range(5):\n    print(number)\n', encoding='utf-8')
        page = eagle._wiki_store.create_page('Python loops', '# Loop patterns\n\nUse loops to repeat work.\n\n## For loops\n\nIterate with range.\n\n## While loops\n\nRepeat while a condition holds.', status='published')
        eagle._wiki_store.set_class_feature('agenda-class', page['id'], teacher['email'])
        from lesson_plan_store import normalize_week_start
        week = normalize_week_start()
        with eagle.app.test_client() as client:
            assignment = client.post('/api/assignments/create', headers={'X-Teacher-Token': 'agenda-teacher'},
                json={'classId': 'agenda-class', 'name': 'Loop lab', 'task': 'Print the numbers 1 through 5.',
                      'maxScore': 10, 'fileControl': True, 'fileControlExtension': '.py'}).json['assignment']
            due = datetime.combine(date.fromisoformat(week), datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=2, hours=20)
            client.post('/api/assignments/update', headers={'X-Teacher-Token': 'agenda-teacher'},
                json={'assignmentId': assignment['id'], 'active': True, 'dueAt': due.isoformat()})
        days = {day: {'markdown': f'### {title}\n\n- Warm-up: trace a loop\n- Explore a worked example\n- Try it together',
                      'wiki_links': [{'node_id': page['id'], 'anchor': ''}],
                      'assignment_ids': [assignment['id']] if index == 2 else [],
                      'color': '#ed6b6b' if index == 4 else ''}
                for index, (day, title) in enumerate(zip(('monday','tuesday','wednesday','thursday','friday'),
                    ('Start with patterns','Build a loop','Make it your own','Practice & reflect','Checkpoint')))}
        eagle.app.extensions['eagle_lesson_plan_store'].save_plan('agenda-class', week, {'days': days})
        eagle.app.extensions['eagle_lesson_plan_store'].set_plan_source('agenda-section','agenda-class')
        from werkzeug.serving import make_server
        server = make_server('127.0.0.1', 0, eagle.app, threaded=True)
        print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}', 'teacher': teacher, 'student': student,
                          'wiki_id': page['id'], 'assignment_id': assignment['id'], 'week': week}), flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
