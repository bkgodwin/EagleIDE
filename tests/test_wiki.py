import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from flask import Flask

from wiki_features import register as register_wiki_features
from wiki_store import WikiStore


class WikiStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = WikiStore(
            self.root / "wiki_data",
            backup_dir=self.root / "backups",
            max_asset_bytes=16 * 1024 * 1024,
            max_total_asset_bytes=64 * 1024 * 1024,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_public_tree_hides_draft_descendants_and_preserves_order(self):
        published = self.store.create_folder("Published")
        draft_parent = self.store.create_folder("Draft Parent")
        self.store.update_node(draft_parent["id"], status="draft")
        visible_page = self.store.create_page("Visible", "# Visible", published["id"], status="published")
        hidden_page = self.store.create_page("Hidden", "# Hidden", draft_parent["id"], status="published")

        tree = self.store.get_tree()
        ids = {item["id"] for item in self.store.get_tree(include_drafts=True)}
        public_ids = {item["id"] for item in _flatten(tree)}

        self.assertIn(published["id"], public_ids)
        self.assertIn(visible_page["id"], public_ids)
        self.assertNotIn(draft_parent["id"], public_ids)
        self.assertNotIn(hidden_page["id"], public_ids)
        self.assertIn(draft_parent["id"], ids)

    def test_move_rejects_descendant_cycle(self):
        parent = self.store.create_folder("Parent")
        child = self.store.create_folder("Child", parent["id"])
        with self.assertRaisesRegex(ValueError, "descendants"):
            self.store.move_node(parent["id"], child["id"])

    def test_drag_positioning_reorders_siblings_and_moves_inside_folder(self):
        first = self.store.create_page("First", "# First", status="published")
        second = self.store.create_page("Second", "# Second", status="published")
        folder = self.store.create_folder("Folder", icon="🐍")
        self.store.position_node(second["id"], first["id"], "before")
        roots = self.store.get_tree(include_drafts=True)
        self.assertEqual([node["id"] for node in roots[:2]], [second["id"], first["id"]])
        moved = self.store.position_node(first["id"], folder["id"], "inside")
        self.assertEqual(moved["parent_id"], folder["id"])
        self.assertEqual(self.store.get_node(folder["id"], include_drafts=True)["icon"], "🐍")
        with self.assertRaisesRegex(ValueError, "descendants"):
            self.store.position_node(folder["id"], first["id"], "before")

    def test_only_three_published_revisions_are_preserved(self):
        page = self.store.create_page("Versioned", "# Version 0", status="published")
        for version in range(1, 6):
            self.store.update_node(page["id"], content=f"# Version {version}", status="published")
        revisions = self.store.list_revisions(page["id"])
        self.assertEqual(len(revisions), 3)
        revision_files = list((self.store.revisions_dir / page["id"]).glob("*.md"))
        self.assertEqual(len(revision_files), 3)

    def test_search_headings_aliases_and_unambiguous_link_candidates(self):
        basics = self.store.create_page(
            "Python Basics",
            "# Python Basics\n## Iteration\nLoops repeat instructions.",
            status="published",
            aliases=["Python introduction"],
        )
        caller = self.store.create_page(
            "Practice",
            "# Practice\nReview Python Basics, Python introduction, and Iteration.",
            status="published",
        )
        self.assertEqual(self.store.search("introduction")[0]["id"], basics["id"])
        payload = self.store.page_response(caller["id"])
        terms = {item["term"]: item for item in payload["node"]["link_candidates"]}
        self.assertEqual(terms["Python Basics"]["node_id"], basics["id"])
        self.assertEqual(terms["Iteration"]["anchor"], "iteration")

    def test_autosaved_draft_does_not_change_published_page(self):
        page = self.store.create_page("Published", "# Published\nLive", status="published")
        self.store.save_page_draft(page["id"], "# Published\nDraft")
        public = self.store.get_node(page["id"])
        admin = self.store.get_node(page["id"], include_drafts=True)
        self.assertIn("Live", public["markdown"])
        self.assertIn("Draft", admin["draft_markdown"])
        self.store.update_node(page["id"], content=admin["draft_markdown"], status="published")
        self.assertEqual(self.store.get_node(page["id"], include_drafts=True)["draft_markdown"], "")
        self.assertIn("Draft", self.store.get_node(page["id"])["markdown"])

    def test_public_read_caches_are_invalidated_by_catalog_changes(self):
        page = self.store.create_page("Cached Page", "# Cached Page\nOriginal text", status="published")
        self.store.get_tree()
        self.store.get_node(page["id"])
        self.store.search("Original")

        self.store.update_node(page["id"], title="Updated Page", content="# Updated Page\nReplacement text")

        self.assertEqual(self.store.get_node(page["id"])["title"], "Updated Page")
        self.assertIn("Replacement text", self.store.get_node(page["id"])["markdown"])
        self.assertIn("Updated Page", {item["title"] for item in _flatten(self.store.get_tree())})
        self.assertEqual(self.store.search("Replacement")[0]["id"], page["id"])

    def test_backup_excludes_bookmarks_and_restore_preserves_live_bookmarks(self):
        folder = self.store.create_folder("Course Folder", icon="🖧")
        sibling = self.store.create_page("Earlier Page", "# Earlier Page", folder["id"], status="published")
        page = self.store.create_page("Backup Page", "# Backup Page", folder["id"], status="published")
        self.store.position_node(page["id"], sibling["id"], "before")
        image_bytes = b"\x89PNG\r\n\x1a\nportable-image"
        source = self.root / "diagram.png"
        source.write_bytes(image_bytes)
        image = self.store.create_asset_from_file(source, "diagram.png", title="diagram.png")
        directive = f"{{{{image:{image['id']}|alt=diagram.png|caption=|align=center|width=original}}}}"
        published_markdown = f"# Backup Page\n\n{directive}\n\nPublished lesson."
        self.store.update_node(page["id"], content=published_markdown, status="published")
        self.store.add_personal_bookmark("student@example.com", page["id"])
        self.store.save_page_draft(page["id"], f"# Backup Page\n\n{directive}\n\nDraft lesson.")
        settings = self.store.update_home_settings(
            "Course Knowledge Base",
            "Everything students need for class.",
            external_resources=[{"title": "Reference", "url": "https://example.org/reference", "description": "Course reference."}],
            standards=[{"standard_id": "CS.1", "description": "Analyze algorithms."}],
            footer_text="Computer Science Department",
        )
        self.store.update_node(page["id"], standard_ids=[settings["standards"][0]["id"]])
        self.store.set_class_feature("class-1", page["id"], "teacher@example.com")
        self.store.record_analytics("page_view", page["id"])
        backup = self.store.create_backup(self.root / "portable.zip")

        with zipfile.ZipFile(backup) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertFalse(manifest["bookmarks_included"])
            self.assertNotIn("bookmarks", manifest)
            self.assertIn("content_organization", manifest["components"])
            self.assertIn("uploaded_media", manifest["components"])
            self.assertIn("home_settings", manifest["components"])
            self.assertTrue(manifest["page_drafts"])
            self.assertTrue(any(name.startswith("drafts/") for name in archive.namelist()))
            self.assertIn(f"media/{image['storage_name']}", archive.namelist())
            self.assertEqual(archive.read(f"media/{image['storage_name']}"), image_bytes)
            self.assertIn(directive, archive.read(f"content/{page['storage_name']}").decode("utf-8"))

        self.store.update_node(page["id"], title="Changed")
        self.store.move_node(page["id"], None)
        self.store.update_home_settings("Changed", "Changed")
        self.store.remove_class_feature("class-1", page["id"])
        _, changed_media_path = self.store.media_path(image["id"], include_drafts=True)
        changed_media_path.write_bytes(b"\x89PNG\r\n\x1a\nchanged")
        result = self.store.restore_archive(backup)
        self.assertTrue(result["ok"])
        restored_page = self.store.get_node(page["id"], include_drafts=True)
        self.assertEqual(restored_page["title"], "Backup Page")
        self.assertEqual(restored_page["parent_id"], folder["id"])
        self.assertIn(directive, restored_page["markdown"])
        self.assertIn(directive, restored_page["draft_markdown"])
        restored_folder = self.store.get_node(folder["id"], include_drafts=True)
        self.assertEqual(restored_folder["icon"], "🖧")
        tree_folder = next(item for item in self.store.get_tree(include_drafts=True) if item["id"] == folder["id"])
        self.assertEqual([item["id"] for item in tree_folder["children"][:2]], [page["id"], sibling["id"]])
        restored_image, restored_media_path = self.store.media_path(image["id"], include_drafts=True)
        self.assertEqual(restored_image["file_name"], "diagram.png")
        self.assertEqual(restored_media_path.read_bytes(), image_bytes)
        self.assertEqual(len(self.store.list_bookmarks("student@example.com")), 1)
        self.assertEqual(self.store.home_settings()["title"], "Course Knowledge Base")
        self.assertEqual(self.store.home_settings()["footer_text"], "Computer Science Department")
        self.assertEqual(self.store.home_settings()["standards"][0]["standard_id"], "CS.1")
        self.assertEqual(self.store.get_node(page["id"])["standards"][0]["standard_id"], "CS.1")
        self.assertEqual(self.store.home_settings()["external_resources"][0]["title"], "Reference")
        self.assertEqual(self.store.list_class_features("class-1")[0]["node_id"], page["id"])
        self.assertEqual(self.store.analytics_summary()["totals"]["page_views"], 1)

    def test_restore_rejects_path_traversal(self):
        archive_path = self.root / "unsafe.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("../escape.txt", "bad")
            archive.writestr("manifest.json", json.dumps({
                "format": "eagleide-wiki-backup",
                "schema_version": 1,
                "bookmarks_included": False,
            }))
        with self.assertRaisesRegex(ValueError, "unsafe path"):
            self.store.restore_archive(archive_path)

    def test_structured_standards_tag_pages_and_validate_references(self):
        settings = self.store.update_home_settings(
            None,
            None,
            standards=[
                {"standard_id": "CS.1", "description": "Analyze a problem."},
                {"standard_id": "CS.2", "description": "Create an algorithm."},
            ],
        )
        standard_id = settings["standards"][0]["id"]
        page = self.store.create_page(
            "Tagged Page", "# Tagged Page", status="published", standard_ids=[standard_id]
        )
        self.assertEqual(page["standard_ids"], [standard_id])
        self.assertEqual(page["standards"][0]["standard_id"], "CS.1")
        with self.assertRaisesRegex(ValueError, "selected standards"):
            self.store.update_node(page["id"], standard_ids=["0" * 32])

    def test_standards_coverage_preserves_order_and_filters_by_folder(self):
        settings = self.store.update_home_settings(
            None,
            None,
            standards=[
                {"standard_id": "NET.2", "description": "Configure addressing."},
                {"standard_id": "NET.1", "description": "Explain network models."},
                {"standard_id": "CYB.1", "description": "Apply access controls."},
            ],
        )
        standards = settings["standards"]
        networking = self.store.create_folder("Networking")
        switching = self.store.create_folder("Switching", networking["id"])
        cybersecurity = self.store.create_folder("Cybersecurity")
        addressing = self.store.create_page(
            "IP Addressing",
            "# IP Addressing",
            networking["id"],
            status="published",
            standard_ids=[standards[0]["id"], standards[1]["id"]],
        )
        vlans = self.store.create_page(
            "VLANs",
            "# VLANs",
            switching["id"],
            status="published",
            standard_ids=[standards[0]["id"]],
        )
        acl = self.store.create_page(
            "Router ACLs",
            "# Router ACLs",
            cybersecurity["id"],
            status="published",
            standard_ids=[standards[2]["id"]],
        )
        self.store.create_page(
            "Draft Lab",
            "# Draft Lab",
            networking["id"],
            status="draft",
            standard_ids=[standards[0]["id"]],
        )

        all_coverage = self.store.standards_coverage()
        self.assertEqual(
            [item["standard_id"] for item in all_coverage["standards"]],
            ["NET.2", "NET.1", "CYB.1"],
        )
        self.assertEqual(
            [page["id"] for page in all_coverage["standards"][0]["pages"]],
            [vlans["id"], addressing["id"]],
        )
        self.assertEqual(all_coverage["standards"][2]["pages"][0]["id"], acl["id"])
        self.assertEqual([folder["title"] for folder in all_coverage["folders"]], [
            "Networking", "Switching", "Cybersecurity",
        ])

        networking_coverage = self.store.standards_coverage(networking["id"])
        self.assertEqual(networking_coverage["folder_title"], "Networking")
        self.assertEqual(networking_coverage["page_count"], 2)
        self.assertEqual(
            [page["id"] for page in networking_coverage["standards"][0]["pages"]],
            [vlans["id"], addressing["id"]],
        )
        self.assertEqual(networking_coverage["standards"][2]["pages"], [])
        self.store.update_node(addressing["id"], standard_ids=[standards[2]["id"]])
        refreshed = self.store.standards_coverage(networking["id"])
        self.assertEqual(
            [page["id"] for page in refreshed["standards"][2]["pages"]],
            [addressing["id"]],
        )
        self.assertNotIn(
            addressing["id"],
            {page["id"] for page in refreshed["standards"][0]["pages"]},
        )
        with self.assertRaisesRegex(ValueError, "Published wiki folder"):
            self.store.standards_coverage("0" * 32)

    def test_standard_import_merges_by_id_and_preserves_page_tags(self):
        settings = self.store.update_home_settings(
            None,
            None,
            standards=[{"standard_id": "CS.1", "description": "Original description."}],
        )
        original = settings["standards"][0]
        page = self.store.create_page(
            "Tagged", "# Tagged", status="published", standard_ids=[original["id"]]
        )
        imported = self.store.import_standards([
            {"standard_id": "CS.1", "description": "Updated description."},
            {"standard_id": "CS.2", "description": "A newly imported standard."},
        ])
        self.assertEqual([item["standard_id"] for item in imported["standards"]], ["CS.1", "CS.2"])
        self.assertEqual(imported["standards"][0]["id"], original["id"])
        self.assertEqual(imported["standards"][0]["description"], "Updated description.")
        self.assertEqual(self.store.get_node(page["id"])["standard_ids"], [original["id"]])

    def test_restore_rejects_manifest_storage_traversal(self):
        page = self.store.create_page("Safe Page", "# Safe Page", status="published")
        valid = self.store.create_backup(self.root / "valid.zip")
        crafted = self.root / "crafted.zip"
        with zipfile.ZipFile(valid, "r") as source:
            manifest = json.loads(source.read("manifest.json"))
            next(row for row in manifest["nodes"] if row["id"] == page["id"])["storage_name"] = "../../config.txt"
            entries = {name: source.read(name) for name in source.namelist() if name != "manifest.json"}
        with zipfile.ZipFile(crafted, "w") as target:
            for name, content in entries.items():
                target.writestr(name, content)
            target.writestr("manifest.json", json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "invalid storage path"):
            self.store.restore_archive(crafted)


class WikiApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True)
        self.admin_tokens = {"admin-token"}
        self.teachers = {
            "teacher-token": {"email": "teacher@example.com", "name": "Teacher", "role": "teacher"},
            "other-teacher": {"email": "other@example.com", "name": "Other", "role": "teacher"},
        }
        self.students = {
            "student-token": {
                "email": "student@example.com", "name": "Student", "role": "student",
                "class_id": "class-one", "class_ids": ["class-one"],
            }
        }
        self.users = {"student@example.com": self.students["student-token"]}
        self.classes = {
            "class-one": {"id": "class-one", "name": "Coding 1", "teacher_email": "teacher@example.com"},
            "class-two": {"id": "class-two", "name": "Coding 2", "teacher_email": "other@example.com"},
        }
        self.store = register_wiki_features(
            self.app,
            base_dir=self.root / "wiki_data",
            backup_dir=self.root / "backups",
            require_admin=lambda req: req.headers.get("X-Admin-Token") in self.admin_tokens,
            require_teacher=lambda req: self.teachers.get(req.headers.get("X-Teacher-Token")),
            require_user=lambda req: self.students.get(req.headers.get("X-User-Token")),
            find_user=lambda email: self.users.get(email),
            get_user_class_ids=lambda user: list((user or {}).get("class_ids") or []),
            find_class=lambda class_id: self.classes.get(class_id),
            config_provider=lambda: {"wiki_max_asset_mb": 16, "wiki_total_asset_mb": 64},
        )
        self.client = self.app.test_client()
        self.admin = {"X-Admin-Token": "admin-token"}
        self.teacher = {"X-Teacher-Token": "teacher-token"}
        self.other_teacher = {"X-Teacher-Token": "other-teacher"}
        self.student = {"X-User-Token": "student-token"}

    def tearDown(self):
        self.client.__exit__ if False else None
        self.temp.cleanup()

    def _create_published_page(self, title="Loops"):
        folder_response = self.client.post("/api/admin/wiki/folders", headers=self.admin, json={"title": "Python"})
        self.assertEqual(folder_response.status_code, 201)
        folder = folder_response.get_json()["node"]
        page_response = self.client.post("/api/admin/wiki/pages", headers=self.admin, json={
            "title": title, "parent_id": folder["id"], "content": f"# {title}\nContent", "status": "published",
        })
        self.assertEqual(page_response.status_code, 201)
        return folder, page_response.get_json()["node"]

    def _upload_asset(self, filename, raw):
        started = self.client.post("/api/admin/wiki/uploads/start", headers=self.admin, json={
            "filename": filename, "total_size": len(raw),
        })
        self.assertEqual(started.status_code, 201)
        upload_id = started.get_json()["upload_id"]
        chunk = self.client.put(
            f"/api/admin/wiki/uploads/{upload_id}/chunk",
            headers={**self.admin, "X-Upload-Offset": "0", "Content-Type": "application/octet-stream"},
            data=raw,
        )
        self.assertEqual(chunk.status_code, 200)
        completed = self.client.post(
            f"/api/admin/wiki/uploads/{upload_id}/complete", headers=self.admin, json={}
        )
        self.assertEqual(completed.status_code, 200)
        return completed.get_json()["result"]

    def test_guest_reads_published_content_but_not_draft(self):
        _, published = self._create_published_page()
        draft = self.client.post("/api/admin/wiki/pages", headers=self.admin, json={
            "title": "Draft", "content": "# Draft", "status": "draft",
        }).get_json()["node"]
        self.assertEqual(self.client.get(f"/api/wiki/nodes/{published['id']}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/wiki/nodes/{draft['id']}").status_code, 404)
        tree = self.client.get("/api/wiki/tree").get_json()["tree"]
        self.assertNotIn(draft["id"], {node["id"] for node in _flatten(tree)})

    def test_standards_coverage_api_is_public_cacheable_and_folder_scoped(self):
        settings = self.store.update_home_settings(
            None,
            None,
            standards=[
                {"standard_id": "CS.1", "description": "Decompose problems."},
                {"standard_id": "CS.2", "description": "Develop solutions."},
            ],
        )
        python_folder = self.store.create_folder("Python")
        javascript_folder = self.store.create_folder("JavaScript")
        python_page = self.store.create_page(
            "Functions",
            "# Functions",
            python_folder["id"],
            status="published",
            standard_ids=[settings["standards"][0]["id"]],
        )
        self.store.create_page(
            "Callbacks",
            "# Callbacks",
            javascript_folder["id"],
            status="published",
            standard_ids=[settings["standards"][1]["id"]],
        )

        response = self.client.get("/api/wiki/standards/coverage")
        self.assertEqual(response.status_code, 200)
        self.assertIn("public", response.headers["Cache-Control"])
        self.assertTrue(response.headers.get("ETag"))
        self.assertEqual(
            self.client.get(
                "/api/wiki/standards/coverage",
                headers={"If-None-Match": response.headers["ETag"]},
            ).status_code,
            304,
        )
        payload = response.get_json()
        self.assertEqual([item["standard_id"] for item in payload["standards"]], ["CS.1", "CS.2"])

        scoped = self.client.get(
            f"/api/wiki/standards/coverage?folder_id={python_folder['id']}"
        ).get_json()
        self.assertEqual(scoped["folder_id"], python_folder["id"])
        self.assertEqual(scoped["standards"][0]["pages"][0]["id"], python_page["id"])
        self.assertEqual(scoped["standards"][1]["pages"], [])
        self.assertEqual(
            self.client.get("/api/wiki/standards/coverage?folder_id=" + ("0" * 32)).status_code,
            404,
        )

    def test_admin_mutations_require_admin_token(self):
        response = self.client.post("/api/admin/wiki/folders", json={"title": "Denied"})
        self.assertEqual(response.status_code, 401)
        self.assertFalse(response.get_json()["ok"])

    def test_admin_can_edit_public_home_banner_text(self):
        original = self.client.get("/api/wiki/home").get_json()["home_settings"]
        self.assertIn("Learn it", original["title"])
        denied = self.client.patch(
            "/api/admin/wiki/settings", json={"title": "Denied", "subtitle": "Denied"}
        )
        self.assertEqual(denied.status_code, 401)
        updated = self.client.patch(
            "/api/admin/wiki/settings",
            headers=self.admin,
            json={
                "title": "Programming Reference",
                "subtitle": "Read, practice, and build.",
                "footer_text": "Created for Test School | Contact teacher@example.org",
                "standards": [{"standard_id": "CS.1", "description": "Analyze algorithms."}],
                "external_resources": [{
                    "title": "Python Documentation",
                    "url": "https://docs.python.org/3/",
                    "description": "Official language reference.",
                }],
            },
        )
        self.assertEqual(updated.status_code, 200)
        home = self.client.get("/api/wiki/home").get_json()["home_settings"]
        self.assertEqual(home["title"], "Programming Reference")
        self.assertEqual(home["subtitle"], "Read, practice, and build.")
        self.assertEqual(home["footer_text"], "Created for Test School | Contact teacher@example.org")
        self.assertEqual(home["standards"][0]["standard_id"], "CS.1")
        self.assertEqual(home["external_resources"][0]["title"], "Python Documentation")
        rejected = self.client.patch(
            "/api/admin/wiki/settings", headers=self.admin,
            json={"external_resources": [{"title": "Unsafe", "url": "javascript:alert(1)"}]},
        )
        self.assertEqual(rejected.status_code, 400)

    def test_admin_can_import_standards_csv(self):
        initial = self.client.patch(
            "/api/admin/wiki/settings",
            headers=self.admin,
            json={"standards": [{"standard_id": "CS.1", "description": "Old description."}]},
        ).get_json()["home_settings"]["standards"][0]
        response = self.client.post(
            "/api/admin/wiki/standards/import",
            headers=self.admin,
            data={
                "file": (
                    io.BytesIO(
                        b'\xef\xbb\xbfStandard ID,Description\r\n'
                        b'CS.1,"Updated, with a comma."\r\n'
                        b'CS.2,Create and test a program.\r\n'
                    ),
                    "standards.csv",
                )
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["imported_count"], 2)
        standards = payload["home_settings"]["standards"]
        self.assertEqual([item["standard_id"] for item in standards], ["CS.1", "CS.2"])
        self.assertEqual(standards[0]["id"], initial["id"])
        self.assertEqual(standards[0]["description"], "Updated, with a comma.")

        denied = self.client.post(
            "/api/admin/wiki/standards/import",
            data={"file": (io.BytesIO(b"Standard ID,Description\nCS.3,Denied"), "denied.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(denied.status_code, 401)
        invalid = self.client.post(
            "/api/admin/wiki/standards/import",
            headers=self.admin,
            data={"file": (io.BytesIO(b"Code,Title\nCS.3,Missing description"), "invalid.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(invalid.status_code, 400)

    def test_teacher_features_only_owned_class_and_folder_is_dynamic(self):
        folder, page = self._create_published_page()
        denied = self.client.put(f"/api/wiki/classes/class-two/features/{folder['id']}", headers=self.teacher)
        self.assertEqual(denied.status_code, 404)
        allowed = self.client.put(f"/api/wiki/classes/class-one/features/{folder['id']}", headers=self.teacher)
        self.assertEqual(allowed.status_code, 200)
        later = self.store.create_page("While Loops", "# While Loops", folder["id"], status="published")
        home = self.client.get("/api/wiki/home?class_id=class-one", headers=self.student).get_json()
        self.assertEqual(home["featured"][0]["node_id"], folder["id"])
        folder_in_tree = next(node for node in _flatten(home["tree"]) if node["id"] == folder["id"])
        self.assertIn(later["id"], {child["id"] for child in folder_in_tree["children"]})

    def test_admin_can_tag_a_page_with_a_structured_standard(self):
        settings_response = self.client.patch(
            "/api/admin/wiki/settings",
            headers=self.admin,
            json={"standards": [{"standard_id": "AP-CSP-3.2", "description": "Develop an algorithm."}]},
        )
        self.assertEqual(settings_response.status_code, 200)
        standard = settings_response.get_json()["home_settings"]["standards"][0]
        _, page = self._create_published_page("Algorithms")
        tagged = self.client.patch(
            f"/api/admin/wiki/nodes/{page['id']}",
            headers=self.admin,
            json={"standard_ids": [standard["id"]]},
        )
        self.assertEqual(tagged.status_code, 200)
        public = self.client.get(f"/api/wiki/nodes/{page['id']}").get_json()["node"]
        self.assertEqual(public["standard_ids"], [standard["id"]])
        self.assertEqual(public["standards"][0]["standard_id"], "AP-CSP-3.2")

    def test_folder_and_page_icons_and_drag_position_api(self):
        first = self.client.post(
            "/api/admin/wiki/folders", headers=self.admin, json={"title": "Python", "icon": "🐍"}
        ).get_json()["node"]
        second = self.client.post(
            "/api/admin/wiki/folders", headers=self.admin, json={"title": "JavaScript", "icon": "🟨"}
        ).get_json()["node"]
        moved = self.client.post(
            f"/api/admin/wiki/nodes/{second['id']}/position",
            headers=self.admin,
            json={"target_id": first["id"], "position": "before"},
        )
        self.assertEqual(moved.status_code, 200)
        tree = self.client.get("/api/wiki/tree").get_json()["tree"]
        self.assertEqual([node["id"] for node in tree[:2]], [second["id"], first["id"]])
        self.assertEqual(tree[0]["icon"], "🟨")
        page = self.client.post(
            "/api/admin/wiki/pages",
            headers=self.admin,
            json={"title": "Server Setup", "content": "# Server Setup", "status": "published", "icon": "🗄️"},
        ).get_json()["node"]
        self.assertEqual(page["icon"], "🗄️")
        updated = self.client.patch(
            f"/api/admin/wiki/nodes/{page['id']}",
            headers=self.admin,
            json={"icon": "⚙️"},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.get_json()["node"]["icon"], "⚙️")
        public_nodes = _flatten(self.client.get("/api/wiki/tree").get_json()["tree"])
        self.assertEqual(next(item for item in public_nodes if item["id"] == page["id"])["icon"], "⚙️")

    def test_student_and_teacher_bookmarks_merge_labels(self):
        _, page = self._create_published_page()
        self.assertEqual(self.client.put(
            f"/api/wiki/bookmarks/{page['id']}", headers=self.teacher, json={"class_id": "class-one"}
        ).status_code, 200)
        self.assertEqual(self.client.put(
            f"/api/wiki/bookmarks/{page['id']}", headers=self.student, json={}
        ).status_code, 200)
        bookmarks = self.client.get("/api/wiki/bookmarks", headers=self.student).get_json()["bookmarks"]
        self.assertEqual(len(bookmarks), 1)
        self.assertEqual(set(bookmarks[0]["labels"]), {"Bookmarked", "Lesson Material"})
        self.assertEqual(bookmarks[0]["lesson_classes"][0]["name"], "Coding 1")

    def test_chunk_upload_checks_offset_signature_and_forces_html_download(self):
        raw = b"<!doctype html><title>Attachment</title>"
        start = self.client.post("/api/admin/wiki/uploads/start", headers=self.admin, json={
            "filename": "sample.html", "total_size": len(raw),
        }).get_json()
        wrong = self.client.put(
            f"/api/admin/wiki/uploads/{start['upload_id']}/chunk",
            headers={**self.admin, "X-Upload-Offset": "1", "Content-Type": "application/octet-stream"},
            data=raw,
        )
        self.assertEqual(wrong.status_code, 409)
        uploaded = self.client.put(
            f"/api/admin/wiki/uploads/{start['upload_id']}/chunk",
            headers={**self.admin, "X-Upload-Offset": "0", "Content-Type": "application/octet-stream"},
            data=raw,
        )
        self.assertEqual(uploaded.status_code, 200)
        completed = self.client.post(
            f"/api/admin/wiki/uploads/{start['upload_id']}/complete", headers=self.admin, json={}
        ).get_json()["result"]
        media = self.client.get(f"/api/wiki/media/{completed['id']}")
        self.assertEqual(media.status_code, 200)
        self.assertIn("attachment", media.headers.get("Content-Disposition", ""))
        media.close()

    def test_images_video_and_pdf_validate_and_serve_inline_with_ranges(self):
        def upload(filename, raw):
            started = self.client.post("/api/admin/wiki/uploads/start", headers=self.admin, json={
                "filename": filename, "total_size": len(raw),
            }).get_json()
            self.assertEqual(self.client.put(
                f"/api/admin/wiki/uploads/{started['upload_id']}/chunk",
                headers={**self.admin, "X-Upload-Offset": "0", "Content-Type": "application/octet-stream"},
                data=raw,
            ).status_code, 200)
            return self.client.post(
                f"/api/admin/wiki/uploads/{started['upload_id']}/complete", headers=self.admin, json={}
            )

        fixtures = [
            ("diagram.png", b"\x89PNG\r\n\x1a\nminimal", "image"),
            ("lesson.mp4", b"\x00\x00\x00\x18ftypmp42minimal", "video"),
            ("handout.pdf", b"%PDF-1.4\nminimal", "pdf"),
        ]
        uploaded = []
        for filename, raw, kind in fixtures:
            response = upload(filename, raw)
            self.assertEqual(response.status_code, 200)
            node = response.get_json()["result"]
            self.assertEqual(node["kind"], kind)
            uploaded.append((node, raw))
        for node, _ in uploaded:
            media = self.client.get(f"/api/wiki/media/{node['id']}")
            self.assertEqual(media.status_code, 200)
            self.assertNotIn("attachment", media.headers.get("Content-Disposition", ""))
            media.close()
        public_ids = {item["id"] for item in _flatten(self.client.get("/api/wiki/tree").get_json()["tree"])}
        self.assertNotIn(uploaded[0][0]["id"], public_ids)
        self.assertIn(uploaded[1][0]["id"], public_ids)
        self.assertIn(uploaded[2][0]["id"], public_ids)
        ranged = self.client.get(
            f"/api/wiki/media/{uploaded[1][0]['id']}", headers={"Range": "bytes=0-7"}
        )
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.data, uploaded[1][1][:8])
        ranged.close()
        rejected = upload("fake.png", b"this is not a png")
        self.assertEqual(rejected.status_code, 400)

    def test_admin_tree_excludes_images_and_media_manager_can_delete_them(self):
        image = self._upload_asset("diagram.png", b"\x89PNG\r\n\x1a\nminimal")
        directive = f"{{{{image:{image['id']}|alt=Diagram|width=65|align=center}}}}"
        page = self.store.create_page(
            "Image Lesson", f"# Image Lesson\n\n{directive}\n\nPublished text.", status="published"
        )
        self.store.save_page_draft(page["id"], f"# Image Lesson Draft\n\n{directive}\n\nDraft text.")
        _, media_path = self.store.media_path(image["id"], include_drafts=True)

        admin_tree = self.client.get("/api/admin/wiki/tree", headers=self.admin).get_json()["tree"]
        self.assertNotIn(image["id"], {item["id"] for item in _flatten(admin_tree)})
        media = self.client.get("/api/admin/wiki/media", headers=self.admin)
        self.assertEqual(media.status_code, 200)
        listed = next(item for item in media.get_json()["images"] if item["id"] == image["id"])
        self.assertEqual(listed["reference_count"], 1)
        self.assertEqual(self.client.get("/api/admin/wiki/media").status_code, 401)

        deleted = self.client.delete(f"/api/admin/wiki/media/{image['id']}", headers=self.admin)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.get_json()["result"]["removed_from_pages"], 1)
        self.assertFalse(media_path.exists())
        self.assertEqual(self.client.get(f"/api/wiki/media/{image['id']}").status_code, 404)
        updated = self.store.get_node(page["id"], include_drafts=True)
        self.assertNotIn(image["id"], updated["markdown"])
        self.assertNotIn(image["id"], updated["draft_markdown"])
        self.assertIn("Published text", updated["markdown"])
        self.assertIn("Draft text", updated["draft_markdown"])

    def test_preview_and_search_return_exact_plain_text_locations(self):
        content = (
            "# Loop Reference\n\nA short **overview**.\n\n"
            "## For Loops\n\nIteration repeats a fixed sequence.\n\n"
            "## While Loops\n\nIteration continues while a condition is true."
        )
        page = self.store.create_page("Loop Reference", content, status="published")
        preview = self.client.get(
            f"/api/wiki/previews/{page['id']}?term=Iteration&anchor=while-loops"
        ).get_json()["preview"]
        self.assertGreaterEqual(len(preview["locations"]), 2)
        self.assertEqual(preview["locations"][0]["anchor"], "while-loops")
        self.assertIn("condition is true", preview["locations"][0]["excerpt"])
        self.assertTrue(all("**" not in item["excerpt"] for item in preview["locations"]))

        results = self.client.get("/api/wiki/search?q=iteration").get_json()["results"]
        result = next(item for item in results if item["id"] == page["id"])
        self.assertEqual(result["anchor"], "for-loops")
        self.assertEqual(result["location_heading"], "For Loops")
        self.assertIn("Iteration repeats", result["excerpt"])

    def test_markdown_upload_search_analytics_and_backup(self):
        uploaded = self.client.post(
            "/api/admin/wiki/pages/upload",
            headers=self.admin,
            data={"file": (io.BytesIO(b"# Conditionals\nUse if statements."), "conditionals.md")},
            content_type="multipart/form-data",
        )
        self.assertEqual(uploaded.status_code, 201)
        page = uploaded.get_json()["node"]
        self.client.patch(
            f"/api/admin/wiki/nodes/{page['id']}", headers=self.admin,
            json={"status": "published", "content": "# Conditionals\nUse if statements."},
        )
        self.assertTrue(self.client.get("/api/wiki/search?q=conditionals").get_json()["results"])
        analytics = self.client.get("/api/admin/wiki/analytics", headers=self.admin).get_json()["data"]
        self.assertEqual(analytics["totals"]["searches"], 0)
        completed = self.client.post("/api/wiki/search/complete", json={"query": "conditionals"})
        self.assertEqual(completed.status_code, 200)
        self.assertTrue(completed.get_json()["has_results"])
        no_result = self.client.post("/api/wiki/search/complete", json={"query": "unfindable-term"})
        self.assertEqual(no_result.status_code, 200)
        self.assertFalse(no_result.get_json()["has_results"])
        analytics = self.client.get("/api/admin/wiki/analytics", headers=self.admin).get_json()["data"]
        self.assertEqual(analytics["totals"]["searches"], 2)
        self.assertEqual(analytics["top_searches"][0]["searches"], 1)
        self.assertEqual(analytics["no_result_searches"][0]["query"], "unfindable-term")
        backup = self.client.get("/api/admin/wiki/backup", headers=self.admin)
        self.assertEqual(backup.status_code, 200)
        self.assertTrue(backup.data.startswith(b"PK"))
        with zipfile.ZipFile(io.BytesIO(backup.data)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertFalse(manifest["bookmarks_included"])
            self.assertNotIn("bookmarks", manifest)
        backup.close()
        ticket = self.client.post("/api/admin/wiki/backup-tickets", headers=self.admin)
        self.assertEqual(ticket.status_code, 201)
        download_url = ticket.get_json()["download_url"]
        ticket_download = self.client.get(download_url)
        self.assertEqual(ticket_download.status_code, 200)
        self.assertTrue(ticket_download.data.startswith(b"PK"))
        ticket_download.close()
        self.assertEqual(self.client.get(download_url).status_code, 404)


def _flatten(nodes):
    output = []
    for node in nodes or []:
        output.append(node)
        output.extend(_flatten(node.get("children") or []))
    return output


if __name__ == "__main__":
    unittest.main()
