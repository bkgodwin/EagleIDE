"""Stable cloud identity stays private and is never inherited by a reused email."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import test_notebook as notebook_tests
import app as eagle
from tool_storage import ToolStorage


class ExternalToolAccountTests(unittest.TestCase):
    def setUp(self):
        self.fixture = notebook_tests.NotebookTestCase()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.storage = ToolStorage(self.fixture.root / 'tools')
        patched = patch.object(eagle._external_tools, 'storage', self.storage)
        patched.start()
        self.addCleanup(patched.stop)

    def test_concurrent_signins_keep_one_identity_and_public_auth_omits_it(self):
        record = eagle._find_user(self.fixture.student_email)
        with ThreadPoolExecutor(4) as pool:
            identities = list(pool.map(lambda _: eagle._external_tool_account_id(record), range(8)))
        self.assertEqual(len(set(identities)), 1)
        self.assertEqual(eagle._external_tool_account_id(eagle._find_user(record['email'])), identities[0])
        self.assertNotIn('tool_storage_id', eagle._user_info_from_record(eagle._find_user(record['email'])))
        self.assertNotEqual(eagle._external_tool_account_id(eagle._find_user(self.fixture.teacher_email)), identities[0])

    def test_delete_removes_cloud_data_and_recreated_email_gets_fresh_profile(self):
        record = eagle._find_user(self.fixture.student_email)
        identity = eagle._external_tool_account_id(record)
        snapshot = self.storage.snapshot(identity, 'cad')
        upload = self.storage.begin(identity, 'cad', 'visit', {**snapshot, 'changes': [{'key': 'project', 'size': 4}]})['upload_id']
        self.storage.chunk(identity, 'cad', 'visit', upload, 0, b'work')
        self.storage.commit(identity, 'cad', 'visit', upload)
        self.assertTrue(eagle._delete_user_by_email(record['email']))
        self.assertEqual(self.storage.summary(identity)['used_bytes'], 0)
        users = eagle._load_users()
        users['users'].append(record)  # Original pre-identity registration fields.
        eagle._save_users(users)
        recreated = eagle._external_tool_account_id(eagle._find_user(record['email']))
        self.assertNotEqual(recreated, identity)
        self.assertEqual(self.storage.snapshot(recreated, 'cad')['entries'], {})
