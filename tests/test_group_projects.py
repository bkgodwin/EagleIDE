"""Authorization, convergence, recovery and atomic group submission regressions."""
import io
import itertools
import threading
import unittest
import zipfile
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

import group_project_text as text_ops
import group_projects as groups
import test_assignments as fixtures

eagle = fixtures.eagle
ROOT = "/api/group-projects"


class GroupProjectTests(unittest.TestCase):
    setUp_fixture = fixtures.AssignmentWorkflowTestCase.setUp
    teacher_headers = fixtures.AssignmentWorkflowTestCase.teacher_headers
    student_headers = fixtures.AssignmentWorkflowTestCase.student_headers
    create_assignment = fixtures.AssignmentWorkflowTestCase.create_assignment

    def setUp(self):
        self.setUp_fixture()
        self.originals["GROUP_PROJECTS_DIR"] = eagle.GROUP_PROJECTS_DIR
        self.originals["SANDBOX_DIR"] = eagle.SANDBOX_DIR
        eagle.GROUP_PROJECTS_DIR = self.root / "group_projects"
        eagle.SANDBOX_DIR = self.root / "sandboxes"
        self.addCleanup(fixtures.AssignmentWorkflowTestCase.tearDown, self)
        self.others = [self.missing_email, "third@example.com", "fourth@example.com", "fifth@example.com"]
        users = eagle._load_users()
        for index, email in enumerate(self.others[1:], 3):
            users["users"].append({"email": email, "name": f"Student {index}", "role": "student",
                                   "enabled": True, "class_id": self.class_one, "class_ids": [self.class_one]})
        eagle._save_users(users)
        catalog = eagle._load_classes()
        catalog["classes"][0]["students"].extend(self.others[1:])
        eagle._save_classes(catalog)
        self.tokens = {}
        for email in self.others:
            token = self.tokens[email] = uuid4().hex
            eagle._student_tokens[token] = eagle._find_user(email)
            self.addCleanup(eagle._student_tokens.pop, token, None)
        groups._project_creation.clear()
        groups._edits_per_member.clear()
        self.settings(True)
        workspace = self.workspace = eagle._get_user_dir(self.student_email)
        (workspace / "Demo" / "data").mkdir(parents=True)
        (workspace / "Demo" / "main.py").write_text("print('start')\n", encoding="utf-8")
        (workspace / "Demo" / "index.html").write_text('<link rel="stylesheet" href="data/sheet.css"><h1>Group demo</h1>', encoding="utf-8")
        (workspace / "Demo" / "data" / "sheet.css").write_text("h1 { color: blue; }", encoding="utf-8")
        (workspace / "Demo" / "data" / "note.txt").write_text("😀 team", encoding="utf-8")
        (workspace / "Demo" / "data" / "asset.bin").write_bytes(b"\0\xff")

    def settings(self, enabled, **extra):
        result = self.client.post("/api/teacher/classes/settings", headers=self.teacher_headers,
                                  json={"classId":self.class_one, "settings":{"group_projects_enabled":enabled, **extra}})
        self.assertEqual(result.status_code, 200, result.get_json())

    def student(self, email):
        return self.student_headers if email == self.student_email else {"X-User-Token":self.tokens[email]}

    def post(self, path, data, email=None):
        return self.client.post(path, headers=self.student(email or self.student_email),
                                json={"classId":self.class_one, **data})

    def get(self, path, email=None, **args):
        return self.client.get(path, headers=self.student(email or self.student_email),
                               query_string={"classId":self.class_one, **args})

    def create(self, invites=(), path="Demo"):
        result = self.post(ROOT, {"path":path, "invitees":list(invites)})
        self.assertEqual(result.status_code, 200, result.get_json())
        return result.json["project"]

    def change(self, project, action, email=None, **data):
        return self.post(f"{ROOT}/{project['id']}", {"action":action, **data}, email)

    def accept(self, project, *members):
        for email in members:
            result = self.change(project, "accept", email)
            self.assertEqual(result.status_code, 200, result.get_json())

    def file(self, project, name):
        return next(file for file in project["files"] if file["path"] == name)

    def file_url(self, project, file):
        return f"{ROOT}/{project['id']}/files/{file['id']}"

    def edit(self, project, file, parts, email=None, revision=0, **extra):
        return self.post(self.file_url(project, file),
                         {"revision":revision, "opId":uuid4().hex, "parts":parts, **extra}, email)

    def test_folder_membership_capacity_and_teacher_revocation(self):
        project = self.create(self.others[:3])
        url = f"{ROOT}/{project['id']}"
        self.assertEqual(len(project["invitations"]), 3)
        self.assertEqual({f["path"] for f in project["files"]},
                         {"index.html", "main.py", "data", "data/sheet.css", "data/note.txt", "data/asset.bin"})
        for email in self.others[:3]:
            self.assertEqual(self.get(url,email).status_code,403)
        self.assertEqual(self.change(project,"invite",email=self.student_email, **{"path":"unused"}).status_code,403)
        self.assertEqual(self.post(url, {"action":"invite","email":self.others[3]}).status_code,409)
        self.accept(project,*self.others[:3])
        refreshed = self.get(url).json["project"]
        self.assertEqual(len({p["color"] for p in refreshed["members"]}),4)
        self.assertEqual(self.get(url,self.others[3]).status_code,403)
        self.assertEqual(self.get(url,classId=self.class_two).status_code,403)
        preview = "/api/teacher/group-projects/" + project["id"]
        self.assertEqual(self.get(preview).status_code,403)
        row = refreshed["members"][1]
        response = self.client.post(preview, headers=self.teacher_headers, query_string={"classId":self.class_one},
                                    json={"action":"remove","memberId":row["id"]})
        self.assertEqual(response.status_code,200)
        removed = [email for email in self.others[:3] if self.get(url,email).status_code == 403]
        self.assertEqual(len(removed),1)
        self.assertEqual(self.post(url,{"action":"invite","email":removed[0]}).status_code,409)
        self.assertEqual(self.change(project,"leave").status_code,200)
        self.assertEqual(self.get(url).status_code,403)
        remaining = next(email for email in self.others[:3] if email not in removed)
        self.assertEqual(len(self.get(url,remaining).json["project"]["members"]),2)

    def test_import_and_tree_mutations_keep_stable_identities(self):
        for path in ("..", "../Demo", "Demo/../Demo", "Trash", "Demo//main.py", "C:/private"):
            self.assertEqual(self.post(ROOT,{"path":path}).status_code,400,path)
        project = self.create()
        node = self.file(project, "data")
        result = self.change(project,"rename",fileId=node["id"],revision=0,path="resources")
        self.assertEqual(result.status_code,200,result.json)
        tree = self.get(f"{ROOT}/{project['id']}").json["project"]
        self.assertEqual(self.file(tree,"resources/note.txt")["id"],self.file(project,"data/note.txt")["id"])
        self.assertEqual(self.change(project,"new",path="resources/next.py").status_code,200)
        self.assertEqual(self.change(project,"new",path="RESOURCES/next.py").status_code,400)
        self.assertEqual(self.change(project,"rename",fileId=node["id"],revision=0,path="resources/child").status_code,400)
        self.assertEqual(self.change(project,"delete",fileId=node["id"],revision=0).status_code,200)
        self.assertTrue((self.workspace / "Demo" / "data" / "note.txt").is_file())
        self.assertEqual(self.get(self.file_url(project,self.file(project,"data/note.txt"))).status_code,404)

    def test_concurrent_edits_rebase_unicode_with_attribution_and_receipts(self):
        project = self.create(self.others[:1])
        self.accept(project,self.missing_email)
        file = self.file(project,"data/note.txt")
        url = self.file_url(project,file)
        initial = self.get(url, self.missing_email).json["file"]["contribution"]
        self.assertEqual(initial, {"authors":[project["own"]], "spans":[[0, 7, project["own"]["id"]]]})
        payloads = [([2, " A", 5], self.student_email), ([2, " B", 5], self.missing_email)]
        barrier = threading.Barrier(2)
        responses = []
        def edit(payload):
            parts, email = payload
            barrier.wait(timeout=4)
            with eagle.app.test_client() as client:
                response = client.post(url, headers=self.student(email), json={
                    "classId":self.class_one, "revision":0, "opId":uuid4().hex, "parts":parts})
                responses.append(response)
        threads = [threading.Thread(target=edit,args=(payload,)) for payload in payloads]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertEqual([r.status_code for r in responses],[200,200])
        source = self.get(url).json["file"]
        self.assertIn(source["content"], ("😀 A B team", "😀 B A team"))
        self.assertEqual(source["revision"],2)
        owner = project["own"]["id"]
        spans = source["contribution"]["spans"]
        self.assertEqual(sum(end - start for start, end, author in spans if author == owner), 9)
        self.assertEqual(sum(end - start for start, end, author in spans if author != owner), 2)
        self.assertEqual(sum(end - start for start, end, _ in spans), 11)
        self.assertEqual({a["name"] for a in source["contribution"]["authors"]},{"Student One","Student Two"})
        self.assertEqual(len(self.get(url,since=0).json["file"]["updates"]),2)
        with patch.object(groups, "monotonic", return_value=100000000):
            invalid = self.edit(project,file,[1,"x",10],revision=2)
        self.assertEqual(invalid.status_code,400)

    def test_socket_live_edits_only_reach_current_file_viewers(self):
        project = self.create(self.others[:2])
        self.accept(project,*self.others[:2])
        file = self.file(project,"main.py")
        def socket(email):
            client = eagle.socketio.test_client(eagle.app)
            self.addCleanup(lambda: client.disconnect() if client.is_connected() else None)
            client.emit("join_class_room", {"role":"student","token":self.tokens.get(email,self.student_token),"class_id":self.class_one})
            return client
        one, two, three = [socket(email) for email in (self.student_email,*self.others[:2])]
        marker = {"classId":self.class_one,"projectId":project["id"],"fileId":file["id"]}
        self.assertTrue(one.emit("group_project_watch", marker, callback=True)["ok"])
        self.assertTrue(three.emit("group_project_watch",{**marker,"fileId":self.file(project,"index.html")["id"]},callback=True)["ok"])
        self.assertEqual(self.edit(project,file,["# idle\n",15]).status_code,200)
        self.assertNotIn("group_project_edit",[event["name"] for event in one.get_received()])
        self.assertEqual(len(two.emit("group_project_watch", marker, callback=True)["viewers"]),2)
        result = two.emit("group_project_change",{**marker,"revision":1,"opId":uuid4().hex,"parts":["# live\n",22]},callback=True)
        self.assertTrue(result["ok"],result)
        self.assertIn("group_project_edit",[event["name"] for event in one.get_received()])
        self.assertNotIn("group_project_edit",[event["name"] for event in three.get_received()])
        self.settings(False)
        self.assertIn("group_project_access_changed",[event["name"] for event in two.get_received()])
        self.assertFalse(two.emit("group_project_watch",marker,callback=True)["ok"])

    def test_teacher_edits_and_cursor_are_class_scoped_and_teacher_stays_off_roster(self):
        project = self.create(self.others[:3])
        self.accept(project, *self.others[:3])
        file = self.file(project, "main.py")
        file_url = self.file_url(project, file)
        teacher_url = "/api/teacher" + file_url.removeprefix("/api")
        scope = {"classId":self.class_one}
        payload = {"revision":0, "opId":uuid4().hex, "parts":["# teacher\n", 15]}
        self.assertEqual(self.get(teacher_url).status_code, 403)
        self.assertEqual(self.client.get(teacher_url, headers=self.teacher_headers,
                         query_string={"classId":self.class_two}).status_code, 404)
        open_file = self.client.get(teacher_url, headers=self.teacher_headers, query_string=scope)
        self.assertEqual(open_file.status_code, 200)
        teacher = open_file.json["own"]
        self.assertEqual(teacher["name"], "Teacher")
        members = self.get(f"{ROOT}/{project['id']}").json["project"]["members"]
        self.assertEqual(len(members), 4)
        self.assertNotIn(teacher["id"], {member["id"] for member in members})
        self.assertEqual(self.client.post(teacher_url, headers=self.student_headers,
                         query_string=scope, json=payload).status_code, 403)
        receipt = self.client.post(teacher_url, headers=self.teacher_headers, query_string=scope, json=payload)
        self.assertEqual(receipt.status_code, 200, receipt.json)
        self.assertEqual(receipt.json["file"]["updates"][0]["author"], teacher)

        def socket(role, token, class_id=self.class_one):
            client = eagle.socketio.test_client(eagle.app)
            self.addCleanup(lambda: client.disconnect() if client.is_connected() else None)
            client.emit("join_class_room", {"role":role, "token":token, "class_id":class_id})
            return client

        student = socket("student", self.student_token)
        mentor = socket("teacher", self.teacher_token)
        elsewhere = socket("teacher", self.teacher_token, self.class_two)
        marker = {**scope, "projectId":project["id"], "fileId":file["id"]}
        self.assertFalse(elsewhere.emit("group_project_watch", marker, callback=True)["ok"])
        self.assertTrue(student.emit("group_project_watch", marker, callback=True)["ok"])
        self.assertIn(teacher["id"], mentor.emit("group_project_watch", marker, callback=True)["viewers"])
        mentor.emit("group_project_cursor", {**marker, "position":3, "revision":1})
        cursor = next(event["args"][0] for event in student.get_received() if event["name"] == "group_project_cursor")
        self.assertEqual(cursor["person"], teacher)
        self.assertEqual(cursor["position"], 3)
        mentor.emit("group_project_cursor", {**marker, "position":None, "revision":1})
        self.assertTrue(any(event["name"] == "group_project_cursor" and event["args"][0]["position"] is None
                            for event in student.get_received()))
        update = mentor.emit("group_project_change", {**marker, "revision":1, "opId":uuid4().hex,
                             "parts":[25, "# live\n"]}, callback=True)
        self.assertTrue(update["ok"], update)
        self.assertTrue(any(event["name"] == "group_project_edit" and event["args"][0]["author"] == teacher
                            for event in student.get_received()))
        saved = self.get(file_url).json["file"]
        self.assertEqual(saved["content"], "# teacher\nprint('start')\n# live\n")
        self.assertEqual(saved["contribution"]["spans"], [[0, 10, teacher["id"]], [10, 25, project["own"]["id"]],
                                                          [25, 32, teacher["id"]]])
        self.settings(False)
        self.assertEqual(self.client.post(teacher_url, headers=self.teacher_headers, query_string=scope, json=payload).status_code, 404)
        self.assertFalse(mentor.emit("group_project_watch", marker, callback=True)["ok"])

    def test_disable_freezes_recovery_and_reenable_creates_new_groups(self):
        project = self.create(self.others[:2])
        self.accept(project,self.missing_email)
        self.settings(False)
        url = f"{ROOT}/{project['id']}"
        self.assertEqual(self.get(url).status_code,403)
        self.assertEqual(self.get(url+"/download",self.others[1]).status_code,403)
        result = self.get(url+"/download",self.missing_email)
        with zipfile.ZipFile(io.BytesIO(result.data)) as archive:
            self.assertEqual(archive.read("data/asset.bin"),b"\0\xff")
        self.settings(True)
        self.assertEqual(self.get(url).status_code,403)
        self.assertEqual(self.get(ROOT).json["projects"][0]["status"],"canceled")
        self.assertNotEqual(self.create()["id"],project["id"])

    def test_annotation_threads_follow_group_revisions_and_close_with_deleted_text(self):
        project = self.create(self.others[:1])
        file = self.file(project, "data/note.txt")
        url = self.file_url(project, file) + "/annotations"
        teacher_url = "/api/teacher" + url.removeprefix("/api")
        scope = {"classId": self.class_one}
        add = {"action": "add", "revision": 0, "start": 3, "end": 7, "body": "Check the team name"}
        self.assertEqual(self.get(url, self.missing_email).status_code, 403)
        self.assertEqual(self.client.post(teacher_url, headers=self.teacher_headers,
                         query_string={"classId":self.class_two}, json=add).status_code, 404)
        self.accept(project, self.missing_email)
        result = self.client.post(teacher_url, headers=self.teacher_headers, query_string=scope, json=add)
        self.assertEqual(result.status_code, 200, result.json)
        thread = result.json["annotations"][0]
        self.assertEqual(thread["author"]["name"], "Teacher")
        reply = self.client.post(url, headers=self.student(self.missing_email), query_string=scope,
                                 json={"action":"reply", "threadId":thread["id"], "body":"I checked it"})
        self.assertEqual(reply.json["annotations"][0]["messages"][-1]["author"]["name"], "Student Two")
        close = self.client.post(url, headers=self.student_headers, query_string=scope, json={
            "action":"closeMessage", "threadId":thread["id"], "messageId":thread["messages"][0]["id"],
        })
        self.assertEqual([message["body"] for message in close.json["annotations"][0]["messages"]], ["I checked it"])
        self.assertEqual(self.edit(project, file, ["😀", 7]).status_code, 200)
        self.assertEqual(self.client.post(teacher_url, headers=self.teacher_headers, query_string=scope, json=add).status_code, 409)
        shifted = self.get(url).json["annotations"][0]
        self.assertEqual((shifted["start"], shifted["end"]), (5, 9))
        self.assertEqual(self.edit(project, file, [5, -4, "club"], revision=1).status_code, 200)
        self.assertEqual(self.get(url).json["annotations"], [])

    def test_audit_annotations_share_the_workspace_file_without_changing_its_source(self):
        path = "Demo/data/note.txt"
        url = "/api/files/annotations"
        audit = "/api/teacher/students/files/annotations"
        scope = {"classId":self.class_one, "studentEmail":self.student_email, "path":path}
        read = self.client.get("/api/files/read", headers=self.student_headers, query_string={"path":path}).json
        add = {"action":"add", "digest":read["annotationDigest"], "start":3, "end":7, "body":"Explain team"}
        self.assertEqual(self.client.post(audit, headers=self.student_headers, query_string=scope, json=add).status_code, 401)
        self.assertEqual(self.client.post(audit, headers=self.teacher_headers,
                         query_string={**scope,"classId":self.class_two}, json=add).status_code, 403)
        response = self.client.post(audit, headers=self.teacher_headers, query_string=scope, json=add)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual((self.workspace / path).read_text(encoding="utf-8"), "😀 team")
        thread = self.client.get(url, headers=self.student_headers, query_string={"path":path}).json["annotations"][0]
        self.assertEqual(thread["messages"][0]["body"], "Explain team")
        save = self.client.post("/api/files/write", headers=self.student_headers, json={
            "path":path, "content":"A😀 team!", "annotationBase":read["annotationDigest"],
            "annotationEdits":[[0,0,1],[8,8,1]],
        })
        self.assertEqual(save.status_code, 200, save.json)
        moved = self.client.get(url, headers=self.student_headers, query_string={"path":path}).json["annotations"][0]
        self.assertEqual((moved["start"], moved["end"]), (4, 8))
        self.assertEqual(self.client.post("/api/files/rename", headers=self.student_headers,
                         json={"old_path":path, "new_name":"renamed.txt"}).status_code, 200)
        path = "Demo/data/renamed.txt"
        self.assertEqual(self.client.get(url, headers=self.student_headers,
                         query_string={"path":path}).json["annotations"][0]["id"], thread["id"])
        save = self.client.post("/api/files/write", headers=self.student_headers, json={
            "path":path, "content":"A😀 club!", "annotationBase":save.json["annotationDigest"],
            "annotationEdits":[[4,8,4]],
        })
        self.assertEqual(save.status_code, 200, save.json)
        self.assertEqual(self.client.get(url, headers=self.student_headers, query_string={"path":path}).json["annotations"], [])

    def test_schedule_uses_class_local_days_and_rejects_bad_configuration(self):
        cls = eagle._find_class_by_id(self.class_one)
        cls["settings"]["group_project_schedule"] = groups.schedule(
            {"enabled":True,"days":[0],"start":"08:00","end":"09:00","timeZone":"America/Chicago"})
        for stamp, expected in [("2026-11-09T13:59:59",False),("2026-11-09T14:00:00",True),
                                ("2026-11-09T15:00:00",False),("2026-11-10T14:00:00",False)]:
            now = datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)
            self.assertEqual(groups.class_open(cls,now)[0],expected)
        with self.assertRaises(groups.ProjectError):
            groups.schedule({"enabled":True,"days":[0],"start":"08:00","end":"07:00","timeZone":"UTC"})

    def test_group_turn_in_is_atomic_and_teacher_can_get_saved_colors(self):
        project = self.create(self.others[:1])
        self.accept(project,self.missing_email)
        file = self.file(project,"main.py")
        self.assertEqual(self.edit(project,file,["# added\n",15]).status_code,200)
        a = self.create_assignment(active=True)
        updated = self.client.post("/api/assignments/update",headers=self.teacher_headers,
                                   json={"assignmentId":a["id"],"allowGroupSubmission":True})
        self.assertEqual(updated.status_code,200,updated.json)
        group = self.get(f"{ROOT}/{project['id']}").json["project"]
        selected = {"mode":"group","projectId":project["id"],"recipients":sorted(p["id"] for p in group["members"]),
                    "files":[{"id":file["id"],"revision":1}]}
        payload = {"assignmentId":a["id"],"submissionKey":"group-attempt-1","groupSelection":selected}
        self.assertEqual(self.post("/api/assignments/submit",{**payload,"groupSelection":{**selected,"recipients":[]}}).status_code,409)
        with patch.object(eagle,"_save_assignment",return_value=False):
            self.assertEqual(self.post("/api/assignments/submit",payload).status_code,500)
        self.assertEqual(eagle._load_assignment(a["id"])["submissions"],[])
        result = self.post("/api/assignments/submit",payload)
        self.assertEqual(result.status_code,200,result.json)
        self.assertEqual(self.post("/api/assignments/submit",payload).json["receipt"],result.json["receipt"])
        submitted = eagle._load_assignment(a["id"])["submissions"]
        self.assertEqual(sorted(row["email"] for row in submitted),sorted([self.student_email,self.missing_email]))
        self.assertTrue(all(row["fileSubmissionCount"] == 1 for row in submitted))
        self.assertEqual(len({row["submissionPath"] for row in submitted}),1)
        args = {"assignmentId":a["id"],"fileId":submitted[0]["files"][0]["id"]}
        path = "/api/assignments/submission-file"
        review = self.client.get(path,headers=self.teacher_headers,query_string={**args,"studentEmail":self.missing_email})
        self.assertEqual(review.status_code,200,review.json)
        self.assertEqual(review.json["content"],"# added\nprint('start')\n")
        self.assertEqual(review.json["contribution"]["spans"][0][:2],[0,23])
        self.assertEqual(review.json["contributors"][0]["name"],"Student One")
        self.assertNotIn("contribution",self.client.get(path,headers=self.student_headers,query_string=args).json)
        self.settings(False)
        reread = self.client.get(path,headers=self.teacher_headers,query_string={**args,"studentEmail":self.missing_email})
        self.assertEqual(reread.json["contribution"],review.json["contribution"])

    def test_group_turn_in_does_not_replace_a_partners_individual_work(self):
        a = self.create_assignment(active=True)
        self.client.post("/api/assignments/update",headers=self.teacher_headers,
                         json={"assignmentId":a["id"],"allowGroupSubmission":True})
        workspace = eagle._get_user_dir(self.missing_email)
        workspace.mkdir(parents=True,exist_ok=True)
        (workspace / "solo.py").write_text("print('solo')",encoding="utf-8")
        prior = self.post("/api/assignments/submit",{"assignmentId":a["id"],"filePath":"solo.py"},self.missing_email)
        self.assertEqual(prior.status_code,200,prior.json)
        project = self.create(self.others[:1])
        self.accept(project,self.missing_email)
        group = self.get(f"{ROOT}/{project['id']}").json["project"]
        payload = {"assignmentId":a["id"],"submissionKey":"group-attempt-2","groupSelection":{
            "projectId":project["id"],"mode":"group","recipients":sorted(p["id"] for p in group["members"]),
            "files":[{"id":self.file(project,"main.py")["id"],"revision":0}]}}
        result = self.post("/api/assignments/submit",payload)
        self.assertEqual(result.status_code,409,result.json)
        self.assertEqual([s["email"] for s in eagle._load_assignment(a["id"])["submissions"]],[self.missing_email])
        payload["groupSelection"]["mode"] = "self"
        self.assertEqual(self.post("/api/assignments/submit",payload).status_code,200)

    def test_html_preview_reads_sibling_assets_and_revokes_after_disable(self):
        project = self.create()
        target = {"classId":self.class_one,"projectId":project["id"],"fileId":self.file(project,"index.html")["id"],"revision":0}
        response = self.client.post("/api/html-runtime/start",headers=self.student_headers,json={"groupProject":target})
        self.assertEqual(response.status_code,200,response.json)
        runtime = response.json["runtime_id"]
        self.addCleanup(eagle._remove_html_runtime_session,runtime)
        css = f"/api/html-runtime/view/{runtime}/data/sheet.css"
        with self.client.get(css) as asset:
            self.assertIn(b"color: blue", asset.data)
        self.settings(False)
        self.assertEqual(self.client.get(css).status_code,404)


class TextOperationTests(unittest.TestCase):
    def test_all_single_splices_converge_under_overlaps_and_ties(self):
        source = "abcd"
        operations = [[part for part in (start, start-end, value, len(source)-end) if part]
                      for start in range(5) for end in range(start,5) for value in ("","!","😀")]
        for earlier, later in itertools.product(operations, repeat=2):
            before, _ = text_ops.apply(source,earlier,[],None)
            after, _ = text_ops.apply(source,later,[],None)
            merged1, _ = text_ops.apply(before,text_ops.transform(later,earlier),[],None)
            merged2, _ = text_ops.apply(after,text_ops.transform(earlier,later,before=True),[],None)
            self.assertEqual(merged1,merged2)
