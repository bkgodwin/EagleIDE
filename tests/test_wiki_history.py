import json
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from tests import test_wiki as fixture
from tests.test_wiki import png_fixture
from wiki_history import RETENTION_SECONDS
from wiki_history import WikiHistory
from wiki_store import WikiStore


class WikiHistoryTests(unittest.TestCase):
    setUp = fixture.WikiApiTests.setUp
    tearDown = fixture.WikiApiTests.tearDown
    _upload_asset = fixture.WikiApiTests._upload_asset

    @property
    def manager(self):
        return {"X-Wiki-Manager-Token":"manager-token"}

    @property
    def history(self):
        return self.app.extensions["eagle_wiki_history"]

    def entries(self):
        return self.client.get("/api/admin/wiki/history",headers=self.admin).json["entries"]

    def page(self):
        response = self.client.post("/api/admin/wiki/pages",headers=self.manager,
            json={"title":"Managed page","content":"# Original","status":"published"})
        self.assertEqual(response.status_code,201,response.json)
        return response.json["node"]

    def test_manager_edits_are_audited_and_only_admin_may_read_or_rollback_history(self):
        page = self.page()
        self.assertEqual(self.client.patch(f"/api/admin/wiki/nodes/{page['id']}",headers=self.manager,json={"content":"# Edited"}).status_code,200)
        entries = self.entries()
        self.assertEqual(len(entries),2)
        self.assertEqual(entries[0]["actor"],"manager@example.invalid")
        self.assertEqual(entries[0]["status"],"completed")
        self.assertTrue(entries[0]["can_restore"])
        self.assertNotIn("Original",json.dumps(entries))
        for headers in (self.manager,self.teacher,self.student,{}):
            self.assertIn(self.client.get("/api/admin/wiki/history",headers=headers).status_code,(401,403))
            self.assertIn(self.client.post(f"/api/admin/wiki/history/{entries[0]['id']}/restore",headers=headers).status_code,(401,403))
        for path in ("analytics","backup","backup-tickets"):
            method = self.client.post if path=="backup-tickets" else self.client.get
            self.assertEqual(method("/api/admin/wiki/"+path,headers=self.manager).status_code,401)
        self.assertEqual(self.client.post("/api/admin/wiki/uploads/start",headers=self.manager,
            json={"filename":"wiki.zip","total_size":12,"purpose":"restore"}).status_code,403)
        restored = self.client.post(f"/api/admin/wiki/history/{entries[0]['id']}/restore",headers=self.admin)
        self.assertEqual(restored.status_code,200,restored.json)
        self.assertEqual(self.store.get_node(page["id"])["markdown"],"# Original")
        self.assertEqual(len(self.entries()),3)
        self.assertEqual(self.entries()[0]["action"],"admin_wiki_history_restore")
        first_restore_version = restored.json["catalog_version"]
        undo = self.client.post(f"/api/admin/wiki/history/{self.entries()[0]['id']}/restore",headers=self.admin)
        self.assertEqual(undo.status_code,200,undo.json)
        self.assertGreater(undo.json["catalog_version"],first_restore_version)
        self.assertEqual(self.store.get_node(page["id"])["markdown"],"# Edited")

    def test_deleted_media_and_drafts_restore_without_rewinding_private_live_state(self):
        image = self._upload_asset("picture.png",png_fixture())
        page = self.page()
        self.store.save_page_draft(page["id"],"Unpublished draft")
        self.store.add_personal_bookmark("student@example.com",page["id"])
        deleted = self.client.delete("/api/admin/wiki/media/"+image["id"],headers=self.manager)
        self.assertEqual(deleted.status_code,200,deleted.json)
        milestone = self.entries()[0]["id"]
        self.store.record_analytics("search_completed","private-new-search")
        self.store.set_class_feature("class-one",page["id"],"teacher@example.com")
        restored = self.client.post(f"/api/admin/wiki/history/{milestone}/restore",headers=self.admin)
        self.assertEqual(restored.status_code,200,restored.json)
        self.assertIsNotNone(self.store.media_path(image["id"])[1])
        self.assertEqual(self.store.get_node(page["id"],include_drafts=True)["draft_markdown"],"Unpublished draft")
        self.assertTrue(self.store.list_bookmarks("student@example.com"))
        self.assertEqual(len(self.store.list_class_features("class-one")),1)
        with self.store._connect() as conn:
            self.assertEqual(conn.execute("SELECT count FROM analytics_daily WHERE event_key='private-new-search'").fetchone()[0],1)

    def test_expiry_removes_only_unreferenced_files_and_preserves_the_audit(self):
        page = self.page()
        self.client.patch(f"/api/admin/wiki/nodes/{page['id']}",headers=self.manager,json={"content":"# Second"})
        self.client.patch(f"/api/admin/wiki/nodes/{page['id']}",headers=self.manager,json={"description":"New description"})
        entries = self.entries()
        with self.history.connect() as conn:
            first = conn.execute("SELECT id FROM milestones ORDER BY created LIMIT 1").fetchone()[0]
            conn.execute("UPDATE milestones SET created=? WHERE id=?",(time.time()-RETENTION_SECONDS-1,first))
        self.history.prune()
        self.assertFalse((self.history.manifests/(first+".json")).exists())
        self.assertEqual(len(self.entries()),len(entries))
        self.assertFalse(next(row for row in self.entries() if row["id"]==first)["can_restore"])
        self.assertEqual(self.client.post(f"/api/admin/wiki/history/{first}/restore",headers=self.admin).status_code,400)
        self.assertTrue(self.history.blobs.exists())
        self.assertEqual(self.client.post("/api/admin/wiki/history/..%2f..%2frestore",headers=self.admin).status_code,404)

    def test_repeated_media_is_shared_and_storage_failure_prevents_the_edit(self):
        self._upload_asset("picture.png",png_fixture())
        page = self.page()
        self.client.patch(f"/api/admin/wiki/nodes/{page['id']}",headers=self.manager,json={"description":"Changed"})
        with self.history.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM blobs").fetchone()[0],2)
        with patch.object(self.history,"capture",side_effect=OSError("private path must not leak")):
            response = self.client.patch(f"/api/admin/wiki/nodes/{page['id']}",headers=self.manager,json={"content":"must not save"})
        self.assertEqual(response.status_code,503)
        self.assertNotIn("private path",response.json["error"])
        self.assertEqual(self.store.get_node(page["id"])["markdown"],"# Original")

    def test_upload_sessions_belong_to_the_originating_editor(self):
        start = self.client.post("/api/admin/wiki/uploads/start",headers=self.manager,json={"filename":"example.py","total_size":8}).json
        other = {"X-Wiki-Manager-Token":"other-manager"}
        self.assertEqual(self.client.put(f"/api/admin/wiki/uploads/{start['upload_id']}/chunk",headers=other,data=b"print(1)").status_code,409)
        self.assertEqual(self.client.post(f"/api/admin/wiki/uploads/{start['upload_id']}/complete",headers=other).status_code,400)
        self.assertEqual(self.client.put(f"/api/admin/wiki/uploads/{start['upload_id']}/chunk",headers=self.manager,data=b"print(1)").status_code,200)
        self.assertEqual(self.client.post(f"/api/admin/wiki/uploads/{start['upload_id']}/complete",headers=self.manager).status_code,200)

    def test_history_budget_refuses_the_edit_without_removing_live_milestones(self):
        page = self.page()
        previous = self.entries()[0]["id"]
        with patch("wiki_history.MAX_HISTORY_BYTES",1):
            response = self.client.patch(f"/api/admin/wiki/nodes/{page['id']}",headers=self.manager,json={"content":"must not save"})
        self.assertEqual(response.status_code,503)
        self.history.prune()
        self.assertTrue((self.history.manifests/(previous+".json")).exists())
        self.assertEqual(self.store.get_node(page["id"])["markdown"],"# Original")

    def test_history_survives_restore_when_backup_directory_is_inside_wiki_root(self):
        root = self.root/"nested-wiki"
        store = WikiStore(root,backup_dir=root/"backups")
        history = WikiHistory(store)
        page = store.create_page("Nested", "Original",status="published")
        milestone = history.capture({"role":"admin"},"test_edit")
        history.finish(milestone,True)
        store.soft_delete(page["id"])
        history.restore(milestone)
        self.assertFalse(history.root.resolve().is_relative_to(root.resolve()))
        self.assertEqual(len(history.listing()),1)
        self.assertEqual(store.get_node(page["id"])["markdown"],"Original")

    def test_simultaneous_edits_each_have_an_ordered_recovery_point(self):
        page = self.page()
        def save(content):
            with self.app.test_client() as client:
                return client.patch(f"/api/admin/wiki/nodes/{page['id']}",headers=self.manager,json={"content":content}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(list(executor.map(save,["# First edit","# Second edit"])),[200,200])
        entries = self.entries()
        self.assertEqual(len(entries),3)
        states = [json.loads((self.history.manifests/(entry["id"]+".json")).read_text())["checksums"] for entry in entries]
        content_name = 'content/'+self.store.get_node(page['id'])['storage_name']
        previous = [(self.history.blobs/state[content_name]).read_text() for state in states[:2]]
        self.assertIn(previous[0], ['# First edit','# Second edit'])
        self.assertEqual(previous[1],'# Original')


if __name__ == "__main__":
    unittest.main()
