"""Run an isolated EagleIDE copy for opt-in agenda browser checks; all data is temporary."""
import argparse
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mock-ai', action='store_true', help='Use a local fake Ollama HTTP endpoint for AI browser checks')
    args = parser.parse_args()
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
                            ('EAGLEIDE_ASSIGNMENT_SUBMISSIONS_DIR', 'submissions'), ('EAGLEIDE_CLEANUP_DATA_DIR', 'cleanup')]:
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
        if args.mock_ai:
            manager = {'email': 'ai-manager@example.test', 'name': 'AI Fixture Manager', 'role': 'wiki_manager', 'enabled': True}
            coteacher = {**student, 'email': 'ai-coteacher@example.test', 'name': 'AI Fixture CoTeacher'}
            users = eagle._load_users(); users['users'].extend([manager, coteacher]); eagle._save_users(users)
            classes = eagle._load_classes()
            classes['classes'][0]['students'].append(coteacher['email'])
            classes['classes'][0]['coteachers'] = [coteacher['email']]
            eagle._save_classes(classes)
            eagle._wiki_manager_tokens['agenda-ai-manager'] = manager
            eagle._student_tokens['agenda-ai-coteacher'] = coteacher

            @eagle.app.post('/fixture-ollama/api/generate')
            def mock_ollama_generate():
                # Exercise the real AI dispatcher/HTTP protocol, without a model
                # installation or sending fixture prompts to any external service.
                return eagle.app.response_class(json.dumps({'response': 'AI browser fixture response.', 'done': True}) + '\n',
                                                mimetype='application/x-ndjson')
        student_root = eagle._get_user_dir(student['email'])
        student_root.mkdir(parents=True, exist_ok=True)
        (student_root / 'preview.html').write_text('<h1>Preview fixture</h1>', encoding='utf-8')
        (student_root / 'attack.htm').write_text('<script>document.documentElement.setAttribute("data-student-script", "executed")</script><p>Inert fixture</p>', encoding='utf-8')
        (student_root / 'attack.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>document.documentElement.setAttribute("data-student-script", "executed")</script><text y="20">Inert fixture</text></svg>', encoding='utf-8')
        private = student_root / '.eagleide'
        private.mkdir(exist_ok=True)
        (private / 'private.json').write_text('{"fixture":true}', encoding='utf-8')
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
        if os.environ.get('EAGLE_CLEANUP_BROWSER_FIXTURE') == '1':
            import time
            eagle._ensure_workspace_system_dirs(student_root)
            for name, age in [('cleanup-old.py', 40), ('cleanup-recent.py', 0)]:
                original = student_root / name
                original.write_text('print("synthetic cleanup fixture")', encoding='utf-8')
                target, _ = eagle._move_workspace_item_to_trash(student_root, original)
                metadata = eagle._load_trash_metadata(student_root)
                metadata[target.relative_to(student_root).as_posix()]['deleted_at'] = time.time() - age * 86400
                eagle._save_trash_metadata(student_root, metadata)
        from werkzeug.serving import make_server
        server = make_server('127.0.0.1', 0, eagle.app, threaded=True)
        if args.mock_ai:
            eagle._update_config({'ai_ollama_url': f'http://127.0.0.1:{server.server_port}/fixture-ollama',
                                  'ai_explainer_enabled': True})
        print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}', 'teacher': teacher, 'student': student,
                          'wiki_id': page['id'], 'assignment_id': assignment['id'], 'week': week}), flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
