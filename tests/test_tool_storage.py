import tempfile
import unittest
from unittest.mock import patch
import time
from concurrent.futures import ThreadPoolExecutor
from tool_storage import ToolStorage, CHUNK, MIB
from tool_store import ToolError


class ToolStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ToolStorage(self.temp.name)

    def save(self, values, account='one', tool='cad', owner='visit', snapshot=None):
        snapshot = snapshot or self.store.snapshot(account, tool)
        manifest = [{'key': key, 'size': len(value.encode()) if value is not None else None} for key, value in values.items()]
        upload = self.store.begin(account, tool, owner, {**snapshot, 'changes': manifest})['upload_id']
        body = ''.join(value for value in values.values() if value is not None).encode()
        for offset in range(0, len(body), CHUNK):
            self.store.chunk(account, tool, owner, upload, offset, body[offset:offset + CHUNK])
        return self.store.commit(account, tool, owner, upload)

    def test_large_unicode_save_survives_restart_isolates_accounts_and_tools(self):
        self.save({'solidcraft.file.test': '☃' * 400000})
        reopened = ToolStorage(self.temp.name)
        self.assertEqual(reopened.snapshot('one', 'cad')['entries']['solidcraft.file.test'], '☃' * 400000)
        self.assertEqual(reopened.summary('one')['used_bytes'], 1200000)
        self.assertEqual(reopened.snapshot('two', 'cad')['entries'], {})
        self.assertEqual(reopened.snapshot('one', 'other')['entries'], {})
        self.save({'solidcraft.file.test': None})
        self.assertEqual(reopened.summary('one')['used_bytes'], 0)

    def test_competing_devices_and_clear_never_overwrite_newer_work(self):
        old = self.store.snapshot('one', 'cad')
        self.save({'project': 'first device'})
        with self.assertRaises(ToolError) as caught:
            self.save({'project': 'stale device'}, snapshot=old)
        self.assertEqual(caught.exception.status, 409)
        newer = self.store.snapshot('one', 'cad')
        self.store.clear('one', newer['epoch'])
        with self.assertRaises(ToolError):
            self.save({'project': 'resurrected'}, snapshot=newer)
        self.assertEqual(self.store.summary('one')['used_bytes'], 0)

    def test_quota_disable_preserves_export_and_cancels_pending(self):
        self.store.policy('one', {'enabled': True, 'quota_mib': 1, 'version': 0})
        self.save({'first': 'x' * (MIB - 10)})
        with self.assertRaises(ToolError) as caught:
            self.save({'second': 'x' * 20}, tool='other')
        self.assertEqual(caught.exception.status, 413)
        policy = self.store.policy('one', {'enabled': False, 'quota_mib': 1, 'version': 1})
        self.assertEqual(policy['used_bytes'], MIB - 10)
        self.assertEqual(self.store.snapshot('one', 'cad')['entries'], {})
        self.assertIn('first', self.store.snapshot('one', 'cad', export=True)['entries'])
        with self.assertRaises(ToolError):
            self.store.policy('one', {'enabled': True, 'quota_mib': 10, 'version': 0})

    def test_chunks_require_owner_order_and_exact_replays_atomic_commit(self):
        snapshot = self.store.snapshot('one', 'cad')
        upload = self.store.begin('one', 'cad', 'visit', {**snapshot, 'changes': [{'key': '../project', 'size': 6}]})['upload_id']
        self.assertEqual(self.store.chunk('one', 'cad', 'visit', upload, 0, b'abc'), 3)
        self.assertEqual(self.store.chunk('one', 'cad', 'visit', upload, 0, b'abc'), 3)
        for account, owner, offset, body in [('two', 'visit', 3, b'def'), ('one', 'other', 3, b'def'), ('one', 'visit', 0, b'BAD'), ('one', 'visit', 4, b'ef')]:
            with self.assertRaises(ToolError):
                self.store.chunk(account, 'cad', owner, upload, offset, body)
        with self.assertRaises(ToolError):
            self.store.commit('one', 'cad', 'visit', upload)
        self.assertEqual(self.store.snapshot('one', 'cad')['entries'], {})
        self.store.chunk('one', 'cad', 'visit', upload, 3, b'def')
        self.store.commit('one', 'cad', 'visit', upload)
        self.assertEqual(self.store.snapshot('one', 'cad')['entries'], {'../project': 'abcdef'})

    def test_invalid_utf8_rolls_back_entire_batch(self):
        snapshot = self.store.snapshot('one', 'cad')
        upload = self.store.begin('one', 'cad', 'visit', {**snapshot, 'changes': [{'key': 'good', 'size': 1}, {'key': 'bad', 'size': 1}]})['upload_id']
        self.store.chunk('one', 'cad', 'visit', upload, 0, b'x\xff')
        with self.assertRaises(ToolError):
            self.store.commit('one', 'cad', 'visit', upload)
        self.assertEqual(self.store.snapshot('one', 'cad')['entries'], {})

    def test_quota_rechecked_when_different_tools_commit_concurrently(self):
        self.store.policy('one', {'enabled': True, 'quota_mib': 1, 'version': 0})
        def save(tool):
            try:
                self.save({'project': 'x' * 600000}, tool=tool)
                return True
            except ToolError:
                return False
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sum(pool.map(save, ['a', 'b'])), 1)
        self.assertEqual(self.store.summary('one')['used_bytes'], 600000)

    def test_expired_spools_are_reclaimed_and_deleted_accounts_leave_no_data(self):
        snapshot = self.store.snapshot('one', 'cad')
        raw = {**snapshot, 'changes': [{'key': 'project', 'size': 4}]}
        old = self.store.begin('one', 'cad', 'old-visit', raw)['upload_id']
        self.store.chunk('one', 'cad', 'old-visit', old, 0, b'work')
        with patch('tool_storage.time.time', return_value=time.time() + 301):
            self.store.begin('one', 'cad', 'new-visit', raw)
        self.assertFalse(self.store._spool(old).exists())
        self.store.delete_account('one')
        self.assertEqual(list(self.store.root.glob('*.upload')), [])
        self.assertEqual(self.store.snapshot('one', 'cad')['entries'], {})
        self.assertEqual(self.store.summary('one')['used_bytes'], 0)
