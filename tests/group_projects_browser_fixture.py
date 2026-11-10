"""Loopback fixture for group project browser checks with synthetic accounts."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import types

from cryptography.fernet import Fernet
from werkzeug.serving import make_server


def main():
    repo = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo))
    from config import DEFAULT_CONFIG
    from credential_security import hash_admin_password, ADMIN_HASH_SCHEME

    with tempfile.TemporaryDirectory(prefix="eagle-group-browser-") as temporary:
        root = Path(temporary)
        shutil.copytree(repo / "static", root / "static")
        for pattern in ("*.py", "*.csv", "*.html", "js_worker.js"):
            for source in repo.glob(pattern):
                shutil.copy2(source, root / source.name)
        for key in ("ADMIN_KEY_FILE", "ASSIGNMENT_SUBMISSIONS_DIR", "GROUP_PROJECTS_DIR", "WIKI_DATA_DIR",
                    "WIKI_BACKUP_DIR", "NETWORK_DATA_DIR", "EAGLE_LAB_DATA_DIR", "LAB_REPORT_DATA_DIR",
                    "LESSON_PLAN_DATA_DIR", "BACKGROUND_ASSETS_DIR", "CLEANUP_DATA_DIR", "TOOL_DATA_DIR"):
            os.environ[f"EAGLEIDE_{key}"] = str(root / (".admin_key" if key == "ADMIN_KEY_FILE" else key.lower()))
        os.environ.pop("EAGLEIDE_HTML_PREVIEW_ORIGIN", None)
        (root / ".admin_key").write_bytes(Fernet.generate_key())
        (root / "config.txt").write_text(json.dumps({
            **DEFAULT_CONFIG, "admin_email":"admin@example.test", "admin_password_hash":hash_admin_password("fixture-only-password"),
            "admin_password_scheme":ADMIN_HASH_SCHEME,
        }), encoding="utf-8")
        eagle = types.ModuleType("app")
        eagle.__file__ = str(root / "app.py")
        sys.modules["app"] = eagle
        exec(compile((root / "app.py").read_text(encoding="utf-8"), str(root / "app.py"), "exec"), eagle.__dict__)
        eagle.app.static_folder = str(repo / "static")
        eagle._assignment_ai_recovery_checked = True
        cid = "group-class"
        teacher = {"email":"teacher@example.test","name":"Teacher Example","role":"teacher","enabled":True}
        students = [{"email":f"{name.lower()}@example.test","name":name,"role":"student","enabled":True,
                     "class_id":cid,"class_ids":[cid]} for name in ("Alice","Ben","Carmen","Devon")]
        eagle._save_users({"users":[teacher,*students]})
        eagle._save_classes({"classes":[{"id":cid,"name":"Project lab","teacher_email":teacher["email"],
            "students":[s["email"] for s in students],"join_code":"GROUPS","settings":{"group_projects_enabled":True}}]})
        eagle._teacher_tokens["group-teacher"] = teacher
        for student in students:
            eagle._student_tokens["group-" + student["name"].lower()] = student
        folder = eagle._get_user_dir(students[0]["email"]) / "Lab files"
        folder.mkdir(parents=True)
        (folder / "main.py").write_text("print(open('message.txt').read())\n", encoding="utf-8")
        (folder / "message.txt").write_text("Hello from the shared folder", encoding="utf-8")
        with eagle.app.test_client() as client:
            headers = {"X-Teacher-Token":"group-teacher"}
            a = client.post("/api/assignments/create", headers=headers, json={
                "name":"Group lab", "task":"Write a greeting.", "classId":cid, "allowGroupSubmission":True,
            })
            assert a.status_code == 200, a.json
            assignment = a.json["assignment"]["id"]
            active = client.post("/api/assignments/update",headers=headers,json={"assignmentId":assignment,"active":True})
            assert active.status_code == 200, active.json
        server = make_server("127.0.0.1", 0, eagle.app, threaded=True)
        print(json.dumps({"url":f"http://127.0.0.1:{server.server_port}","assignment":assignment,"classId":cid}),flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
