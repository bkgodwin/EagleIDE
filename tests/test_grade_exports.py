"""Account student numbers and completion-only notebook grade exports."""
import csv
import io
import unittest
from unittest.mock import patch

import test_notebook as notebook_tests
import app as eagle


class GradeExportTests(unittest.TestCase):
    def setUp(self):
        self.fixture = notebook_tests.NotebookTestCase()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.client = self.fixture.client
        self.headers = {"X-Teacher-Token": self.fixture.teacher_token}
        users = eagle._load_users()
        users["users"][1]["student_id"] = "00042"
        eagle._save_users(users)

    def export(self, prompt, **kwargs):
        query = {"classId": self.fixture.class_id, "promptId": prompt["id"], **kwargs}
        return self.client.get('/api/teacher/notebook-prompts/csv', query_string=query, headers=self.headers)

    def rows(self, response):
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.mimetype.startswith('text/csv'))
        return list(csv.reader(io.StringIO(response.get_data(as_text=True))))

    def save_response(self, prompt, html):
        headers = {"X-User-Token": self.fixture.student_token}
        notebook = self.client.get('/api/notebook', query_string={"classId": self.fixture.class_id}, headers=headers).get_json()["notebook"]
        eagle._notebook_prompt_response(notebook, prompt["id"])["responseHtml"] = html
        response = self.client.post('/api/notebook/save', headers=headers,
                                    json={"classId": self.fixture.class_id, "notebook": notebook})
        self.assertEqual(response.status_code, 200)

    def test_written_completion_uses_saved_response_not_feedback_or_legacy_score(self):
        prompt = self.fixture._create_prompt(title='Reflection, "loops"')
        self.save_response(prompt, '<p>I used a loop to repeat instructions.</p>')
        with eagle._notebooks_lock:
            notebook = eagle._load_student_notebook(self.fixture.student_email, self.fixture.class_id)
            block = eagle._notebook_prompt_response(notebook, prompt["id"])
            block['score'] = 2
            block['practice'] = {"status": "failed", "id": "attempt", "submittedAt": 1, "feedback": "Try again"}
            eagle._write_json_file_atomic(eagle._notebook_path(self.fixture.student_email, self.fixture.class_id), notebook)
        before = {p: p.read_bytes() for p in self.fixture.notebooks_dir.rglob('*') if p.is_file()}
        response = self.export(prompt)
        self.assertEqual(self.rows(response), [['Student Number', 'Score'], ['00042', '100%'], ['', '0%']])
        self.assertIn('_completion_scores.csv', response.headers['Content-Disposition'])
        self.assertEqual(self.rows(self.export(prompt, format='points'))[1:], [['00042', '100'], ['', '0']])
        after = {p: p.read_bytes() for p in self.fixture.notebooks_dir.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_code_response_counts_without_ai_and_empty_placeholders_do_not(self):
        prompt = self.fixture._create_prompt(response_type='code', graded=False)
        self.assertEqual(self.rows(self.export(prompt))[1:], [['00042', '0%'], ['', '0%']])
        self.save_response(prompt, '<figure class="student-notebook-code-block" data-language="python"><ol><li><code>print(1)</code></li></ol></figure>')
        self.assertEqual(self.rows(self.export(prompt))[1], ['00042', '100%'])
        self.save_response(prompt, '<ul><li>&nbsp;<br></li></ul>')
        self.assertEqual(self.rows(self.export(prompt))[1], ['00042', '0%'])

    def test_selected_prompt_and_current_roster_only(self):
        first = self.fixture._create_prompt()
        second = self.fixture._create_prompt(title='Another prompt')
        self.save_response(first, '<p>Done</p>')
        self.assertEqual(self.rows(self.export(second))[1], ['00042', '0%'])
        classes = eagle._load_classes()
        classes['classes'][0]['students'] = [self.fixture.second_student_email, self.fixture.second_student_email.upper()]
        eagle._save_classes(classes)
        self.assertEqual(self.rows(self.export(first)), [['Student Number', 'Score'], ['', '0%']])

    def test_export_validates_parameters_and_class_access(self):
        prompt = self.fixture._create_prompt()
        self.assertEqual(self.export(prompt, format='other').status_code, 400)
        self.assertEqual(self.export({"id": 'missing'}).status_code, 404)
        self.assertEqual(self.export(prompt, classId='../another-class').status_code, 404)
        self.assertEqual(self.client.get('/api/teacher/notebook-prompts/csv', headers=self.headers).status_code, 400)
        query = {"classId": self.fixture.class_id, "promptId": prompt['id']}
        for headers in ({}, {"X-User-Token": self.fixture.student_token}):
            self.assertEqual(self.client.get('/api/teacher/notebook-prompts/csv', query_string=query, headers=headers).status_code, 401)
        users = eagle._load_users(); users['users'].append({"email": "other@example.com", "role": "teacher"}); eagle._save_users(users)
        with patch.dict(eagle._teacher_tokens, {'other-teacher': {"email": "other@example.com", "role": "teacher"}}):
            self.assertEqual(self.client.get('/api/teacher/notebook-prompts/csv', query_string=query,
                                            headers={"X-Teacher-Token": 'other-teacher'}).status_code, 404)

    def test_current_coteacher_can_export_but_revoked_coteacher_cannot(self):
        prompt = self.fixture._create_prompt()
        promoted = self.client.post('/api/teacher/classes/coteacher', headers=self.headers,
                                    json={"classId": self.fixture.class_id, "email": self.fixture.student_email, "enabled": True})
        self.assertEqual(promoted.status_code, 200)
        self.headers = {"X-Teacher-Token": self.fixture.student_token}
        self.assertEqual(self.export(prompt).status_code, 200)
        self.client.post('/api/teacher/classes/coteacher', headers={"X-Teacher-Token": self.fixture.teacher_token},
                         json={"classId": self.fixture.class_id, "email": self.fixture.student_email, "enabled": False})
        self.assertEqual(self.export(prompt).status_code, 401)

    def test_registration_student_number_is_used_in_both_grade_exports(self):
        with patch.object(eagle, '_record_sign_in_event'), patch.object(eagle, '_set_device_session_cookie'), patch.dict(eagle._reg_rate_limit, {}, clear=True):
            response = self.client.post('/api/auth/register', json={
                "email": "999999@example.com", "password": "TestPassword123!",
                "first_name": "New", "last_name": "Student", "student_id": "00007",
            })
        self.assertEqual(response.status_code, 200, response.get_json())
        token = response.get_json()['token']
        self.addCleanup(eagle._student_tokens.pop, token, None)
        joined = self.client.post('/api/classes/join', headers={"X-User-Token": token}, json={"joinCode": 'ABC123'})
        self.assertEqual(joined.status_code, 200)
        assignment = self.client.post('/api/assignments/create', headers=self.headers,
                                      json={"name": "Code grade", "task": "Try", "maxScore": 10, "classId": self.fixture.class_id}).get_json()['assignment']
        stored = eagle._load_assignment(assignment['id'])
        stored['submissions'] = [{"email": '999999@example.com', "score": 7, "totalScore": 7}]
        self.assertTrue(eagle._save_assignment(stored))
        for score_format in ('points', 'percent'):
            rows = self.rows(self.client.get(f"/api/assignments/{assignment['id']}/csv?format={score_format}", headers=self.headers))
            expected = '7' if score_format == 'points' else '70.0%'
            self.assertIn(['00007', expected], rows)
            self.assertNotIn(['999999', expected], rows)
            self.assertIn(['', ''], rows)
        rows = self.rows(self.export(self.fixture._create_prompt()))
        self.assertIn(['00007', '0%'], rows)
        self.assertNotIn(['999999', '0%'], rows)
