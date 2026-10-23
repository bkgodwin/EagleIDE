"""Account color preferences: authorization, validation and durable isolation."""
import unittest
from unittest.mock import patch

import test_notebook as fixtures
import app as eagle


class EditorPreferencesTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.NotebookTestCase()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.client = self.fixture.client
        self.route = '/api/auth/editor-preferences'
        self.value = {'scheme': 'accessible-dark', 'backgrounds': {'dark': '#102030', 'light': '#fafafa'}}

    def test_student_and_teacher_save_to_their_own_accounts(self):
        student = {'X-User-Token': self.fixture.student_token}
        teacher = {'X-Teacher-Token': self.fixture.teacher_token}
        self.assertEqual(self.client.post(self.route, headers=student, json=self.value).status_code, 200)
        self.assertEqual(self.client.get(self.route, headers=student).get_json()['preferences'], self.value)
        self.assertEqual(self.client.get(self.route, headers=teacher).get_json()['preferences']['scheme'], 'auto')
        other = {**self.value, 'scheme': 'paper-light'}
        self.assertEqual(self.client.post(self.route, headers=teacher, json=other).status_code, 200)
        self.assertEqual(self.client.get(self.route, headers=student).get_json()['preferences'], self.value)
        with patch.object(eagle, '_users_cache', None):
            self.assertEqual(self.client.get(self.route, headers=teacher).get_json()['preferences'], other)
        record = eagle._find_user(self.fixture.student_email)
        self.assertEqual(record['editor_preferences'], self.value)
        self.assertEqual(record['class_id'], self.fixture.class_id)

    def test_admin_colors_persist_without_changing_student_preferences(self):
        config = self.fixture.root / 'config.json'
        original = eagle._load_config()
        with patch.object(eagle, 'PERSIST_FILE', config), patch.object(eagle, '_cfg_cache', None), patch.object(eagle, '_cfg_cache_mtime_ns', None):
            # Seed a complete isolated config before exercising its atomic writer.
            eagle._save_config({**original, 'admin_editor_preferences': self.value})
            with patch.object(eagle, '_admin_tokens', {'editor-admin'}):
                headers = {'X-Admin-Token': 'editor-admin'}
                self.assertEqual(self.client.get(self.route, headers=headers).get_json()['preferences'], self.value)
                next_value = {**self.value, 'scheme': 'mono-light'}
                self.assertEqual(self.client.post(self.route, headers=headers, json=next_value).status_code, 200)
                self.assertEqual(eagle._load_config()['admin_editor_preferences'], next_value)

    def test_new_profiles_round_trip_without_changing_existing_background_overrides(self):
        for scheme in ('legacy-dark', 'legacy-light', 'midnight-dark', 'forest-dark', 'graphite-dark', 'alpine-dark'):
            for token in (self.fixture.student_token, self.fixture.teacher_token):
                header = 'X-User-Token' if token == self.fixture.student_token else 'X-Teacher-Token'
                value = {**self.value, 'scheme': scheme}
                response = self.client.post(self.route, headers={header: token}, json=value)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(self.client.get(self.route, headers={header: token}).json['preferences'], value)

    def test_invalid_payloads_and_unauthenticated_requests_are_rejected(self):
        self.assertEqual(self.client.get(self.route).status_code, 401)
        self.assertEqual(self.client.post(self.route, json=self.value).status_code, 401)
        headers = {'X-User-Token': self.fixture.student_token}
        for invalid in [None, [], {}, {**self.value, 'scheme': []}, {**self.value, 'scheme': 'unknown'},
                        {**self.value, 'email': self.fixture.teacher_email},
                        {**self.value, 'backgrounds': {'dark': 'url(javascript:x)', 'light': ''}},
                        {**self.value, 'backgrounds': {'dark': '#123456'}},
                        {**self.value, 'backgrounds': {'dark': 1, 'light': ''}}]:
            self.assertEqual(self.client.post(self.route, headers=headers, json=invalid).status_code, 400, invalid)
