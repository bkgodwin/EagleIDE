"""Workspace data, profile migration, and class-scoped assistant permissions."""
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_assignments as assignment_tests
import app as eagle


class ClassroomUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = assignment_tests.AssignmentWorkflowTestCase()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.client = self.fixture.client
        self.teacher_headers = self.fixture.teacher_headers
        self.co_headers = {"X-Teacher-Token": self.fixture.student_token}
        self.email = self.fixture.student_email

    def promote(self):
        response = self.client.post('/api/teacher/classes/coteacher', headers=self.teacher_headers,
                                    json={"classId": self.fixture.class_one, "email": self.email, "enabled": True})
        self.assertEqual(response.status_code, 200)

    def test_legacy_names_migrate_without_splitting_or_losing_identity(self):
        user = eagle._normalize_user_record({"name": "Mary Jane Smith", "role": "student"})
        self.assertEqual(user['first_name'], 'Mary Jane Smith')
        self.assertEqual(user['last_name'], '')
        self.assertEqual(user['student_id'], '')
        self.assertEqual(user['name'], 'Mary Jane Smith')

    def test_profile_edits_preserve_password_membership_and_refresh_tokens(self):
        old = eagle._find_user(self.email)
        response = self.client.post('/api/auth/profile', headers=self.fixture.student_headers,
                                    json={"first_name": "Ana", "last_name": "Zulu", "student_id": "00042"})
        self.assertEqual(response.status_code, 200)
        user = eagle._find_user(self.email)
        self.assertEqual(user['name'], 'Ana Zulu')
        self.assertEqual(user['student_id'], '00042')
        self.assertEqual(user['class_ids'], old['class_ids'])
        self.assertEqual(eagle._student_tokens[self.fixture.student_token]['name'], 'Ana Zulu')
        bad = self.client.post('/api/auth/profile', headers=self.fixture.student_headers, json={"student_id": "=1+1"})
        self.assertEqual(bad.status_code, 400)

    def test_owner_can_edit_id_and_export_uses_it_with_no_email_fallback(self):
        changed = self.client.post('/api/teacher/students/update', headers=self.teacher_headers,
                                  json={"email": self.email, "student_id": "00008"})
        self.assertEqual(changed.status_code, 200)
        assignment = self.fixture.create_assignment()
        response = self.client.get(f"/api/assignments/{assignment['id']}/csv", headers=self.teacher_headers)
        rows = list(csv.reader(io.StringIO(response.get_data(as_text=True))))
        self.assertIn(['00008', ''], rows)
        self.assertNotIn(['123456', ''], rows)

    def test_coteacher_can_read_only_promoted_class_create_and_grade_assignments(self):
        self.promote()
        classes = self.client.get('/api/teacher/classes', headers=self.co_headers).get_json()['classes']
        self.assertEqual([c['id'] for c in classes], [self.fixture.class_one])
        self.assertFalse(classes[0]['canManageClass'])
        assignment = self.fixture.create_assignment(active=True)
        self.fixture.submit_code(assignment)
        listed = self.client.get('/api/assignments', headers=self.co_headers).get_json()['assignments']
        self.assertEqual(listed[0]['id'], assignment['id'])
        score = self.client.post('/api/assignments/score', headers=self.co_headers,
                                 json={"assignmentId": assignment['id'], "studentEmail": self.email, "score": 7})
        self.assertEqual(score.status_code, 200)
        created = self.client.post('/api/assignments/create', headers=self.co_headers,
                                  json={"name": "Co-created", "task": "Try", "classId": self.fixture.class_one})
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.get_json()['assignment']['createdByEmail'], self.fixture.teacher_email)
        wrong = self.client.post('/api/assignments/create', headers=self.co_headers,
                                json={"name": "Wrong class", "classId": self.fixture.class_two})
        self.assertEqual(wrong.status_code, 403)
        for route, payload in [('/api/assignments/update', {"assignmentId": assignment['id'], "active": False}),
                               ('/api/assignments/delete', {"assignmentId": assignment['id']}),
                               ('/api/teacher/classes/coteacher', {"classId": self.fixture.class_one, "email": self.email, "enabled": True}),
                               ('/api/teacher/students/update', {"email": self.email, "student_id": "9"})]:
            self.assertIn(self.client.post(route, headers=self.co_headers, json=payload).status_code, (401, 403))
        self.client.post('/api/teacher/classes/coteacher', headers=self.teacher_headers,
                         json={"classId": self.fixture.class_one, "email": self.email, "enabled": False})
        self.assertEqual(self.client.get('/api/assignments', headers=self.co_headers).get_json()['assignments'], [])
        self.assertEqual(self.client.post('/api/assignments/score', headers=self.co_headers,
                                         json={"assignmentId": assignment['id'], "studentEmail": self.email, "score": 1}).status_code, 401)

    def test_python_timeout_validation_and_admin_only_cpu_sample(self):
        for invalid in (0, 301, True, 'bad', 1.5):
            with self.assertRaises(ValueError):
                eagle._normalize_config_partial({'python_execution_timeout_seconds': invalid})
        settings = eagle._normalized_python_runtime_settings({'python_execution_timeout_seconds': 120})
        self.assertEqual(settings['python_execution_timeout_seconds'], 120)
        self.assertEqual(self.client.get('/api/admin/cpu-sample', headers=self.co_headers).status_code, 401)

    def test_presence_reports_authenticated_open_file_and_scopes_access(self):
        self.promote()
        socket = eagle.socketio.test_client(eagle.app)
        self.addCleanup(socket.disconnect)
        socket.emit('join_class_room', {'role':'student', 'token':self.fixture.student_token, 'class_id':self.fixture.class_one})
        socket.emit('workspace_file_opened', {'name':'folder/data.json'})
        response = self.client.get(f'/api/teacher/classes/{self.fixture.class_one}/active-students', headers=self.co_headers)
        self.assertEqual(response.get_json()['openFilesByEmail'][self.email], 'data.json')
        self.assertEqual(self.client.get(f'/api/teacher/classes/{self.fixture.class_two}/active-students', headers=self.co_headers).status_code, 404)


class CsvUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        patcher = patch.object(eagle, 'USER_FILES_DIR', self.root)
        patcher.start(); self.addCleanup(patcher.stop)
        self.token = 'csv-upgrade-token'
        eagle._student_tokens[self.token] = {'email': 'csv@school.test', 'role': 'student'}
        self.addCleanup(eagle._student_tokens.pop, self.token, None)
        self.headers = {'X-User-Token': self.token}
        self.workspace = eagle._get_user_dir('csv@school.test')
        self.workspace.mkdir(parents=True)
        self.file = self.workspace / 'data.csv'
        self.client = eagle.app.test_client()

    def page(self, **kwargs):
        return self.client.get('/api/files/csv-page', query_string={'path': 'data.csv', **kwargs}, headers=self.headers)

    def test_large_csv_is_paged_and_headers_are_separate(self):
        self.file.write_text('name,score\n' + 'Student,99\n' * 100000, encoding='utf-8')
        read = self.client.get('/api/files/read?path=data.csv', headers=self.headers)
        self.assertEqual(read.get_json()['kind'], 'csv')
        self.assertNotIn('content', read.get_json())
        first = self.page().get_json()
        self.assertEqual(first['header'], ['name', 'score'])
        self.assertEqual(len(first['rows']), 50)
        self.assertLess(len(json.dumps(first)), 10000)
        second = self.page(cursor=first['nextCursor'], version=first['version']).get_json()
        self.assertGreater(second['rows'][0]['offset'], first['rows'][-1]['offset'])

    def test_csv_edits_preserve_quoted_newlines_unicode_and_other_pages(self):
        self.file.write_text('name,note\n"Éva","line one\nline two"\nSam,untouched\n', encoding='utf-8')
        first = self.page().get_json()
        row = first['rows'][0]
        response = self.client.post('/api/files/csv-edit', headers=self.headers,
            json={'path':'data.csv', 'version':first['version'], 'changes':[{'offset':row['offset'], 'column':1, 'value':'a,"quote"\nnew line'}], 'offsets':[r['offset'] for r in first['rows']]})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        with self.file.open(encoding='utf-8', newline='') as handle:
            rows = list(csv.reader(handle))
        self.assertEqual(rows[1], ['Éva', 'a,"quote"\nnew line'])
        self.assertEqual(rows[2], ['Sam', 'untouched'])
        fresh = self.page().get_json()
        self.assertEqual(response.get_json()['offsets'][str(first['rows'][1]['offset'])], fresh['rows'][1]['offset'])
        conflict = self.client.post('/api/files/csv-edit', headers=self.headers, json={'path':'data.csv','version':first['version'], 'changes':[]})
        self.assertEqual(conflict.status_code, 409)

    def test_empty_csv_can_create_header_and_path_boundaries_remain(self):
        self.file.write_text('', encoding='utf-8')
        page = self.page().get_json()
        response = self.client.post('/api/files/csv-edit', headers=self.headers,
            json={'path':'data.csv','version':page['version'],'changes':[{'offset':0,'column':0,'value':'name'}], 'appendRow':True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['appendRowNumber'], 2)
        self.assertEqual(self.page().get_json()['header'], ['name'])
        self.assertEqual(self.client.get('/api/files/csv-page?path=../data.csv', headers=self.headers).status_code, 404)
        self.assertEqual(self.client.get('/api/files/csv-page?path=data.csv').status_code, 401)
        created = self.client.post('/api/files/create', headers=self.headers, json={'name':'new.json'})
        self.assertEqual(created.status_code, 200)
        self.assertEqual(json.loads((self.workspace/'new.json').read_text()), {})

    def test_appending_empty_csv_creates_header_and_editable_data_row(self):
        self.file.write_text('', encoding='utf-8')
        page = self.page().get_json()
        response = self.client.post('/api/files/csv-edit', headers=self.headers,
            json={'path':'data.csv','version':page['version'],'changes':[], 'appendRow':True})
        result = response.get_json()
        self.assertEqual(result['appendRowNumber'], 2)
        fresh = self.page(cursor=result['appendOffset'], version=result['version']).get_json()
        self.assertEqual(len(fresh['rows']), 1)

    def test_wide_and_large_records_keep_responses_bounded(self):
        self.file.write_text('a,b\n' + ('x' * 30000 + ',y\n') * 50, encoding='utf-8')
        result = self.page().get_json()
        self.assertLess(len(result['rows']), 50)
        self.assertIsNotNone(result['nextCursor'])
        self.file.write_text('a\n' + 'x' * 300000, encoding='utf-8')
        self.assertEqual(self.page().status_code, 422)
