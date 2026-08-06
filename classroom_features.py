"""Classroom signals, file sharing, and audit features for EagleIDE."""
from __future__ import annotations

import json
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from flask import jsonify, request

BASE_DIR = Path(__file__).resolve().parent
CLASSROOM_EVENTS_FILE = BASE_DIR / "classroom_events.json"
CLASSROOM_SIGNALS_FILE = BASE_DIR / "classroom_signals.json"

MAX_CLASSROOM_EVENTS = 5000
CLASSROOM_RETENTION_DAYS = 90
MAX_QUESTION_LENGTH = 200
MAX_RESPONSE_LENGTH = 500
MAX_OPEN_QUESTIONS_PER_STUDENT = 3
SHARED_DIR = "Shared"

DEFAULT_CLASSROOM_SETTINGS: dict[str, bool] = {
    "challenges_enabled": True,
    "student_ide_access_enabled": True,
    "raise_hand_enabled": True,
    "student_send_to_teacher_enabled": True,
    "student_peer_sharing_enabled": False,
    "teacher_file_send_enabled": True,
}

_classroom_events_lock = threading.Lock()
_classroom_signals_lock = threading.Lock()


def merge_class_settings(settings: Optional[dict]) -> dict:
    out = dict(settings or {})
    for key, default in DEFAULT_CLASSROOM_SETTINGS.items():
        if key not in out:
            out[key] = default
        else:
            out[key] = bool(out[key])
    return out


def _eagle():
    return sys.modules.get("app") or sys.modules.get("__main__")


def _read_json_list(path: Path) -> list:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_json_list(path: Path, payload: list) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _read_signals_store() -> dict:
    if not CLASSROOM_SIGNALS_FILE.exists():
        return {"classes": {}}
    try:
        data = json.loads(CLASSROOM_SIGNALS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("classes", {})
            return data
    except Exception:
        pass
    return {"classes": {}}


def _write_signals_store(data: dict) -> None:
    tmp = CLASSROOM_SIGNALS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CLASSROOM_SIGNALS_FILE)


def _class_bucket(class_id: str) -> dict:
    with _classroom_signals_lock:
        store = _read_signals_store()
        bucket = store.setdefault("classes", {}).setdefault(class_id, {"hands": [], "questions": []})
        bucket.setdefault("hands", [])
        bucket.setdefault("questions", [])
        return bucket


def _save_class_bucket(class_id: str, bucket: dict) -> None:
    with _classroom_signals_lock:
        store = _read_signals_store()
        store.setdefault("classes", {})[class_id] = bucket
        _write_signals_store(store)


def append_classroom_event(
    event_type: str,
    class_id: str,
    actor_email: str,
    actor_role: str,
    details: Optional[dict] = None,
) -> None:
    M = _eagle()
    entry = {
        "timestamp": M._current_timestamp(),
        "ts": int(time.time()),
        "type": str(event_type or "event"),
        "class_id": class_id,
        "actor_email": (actor_email or "").strip().lower(),
        "actor_role": str(actor_role or ""),
        "details": details or {},
    }
    with _classroom_events_lock:
        events = _read_json_list(CLASSROOM_EVENTS_FILE)
        events.append(entry)
        cutoff = int(time.time()) - (CLASSROOM_RETENTION_DAYS * 24 * 3600)
        events = [row for row in events if int(row.get("ts", 0)) >= cutoff][-MAX_CLASSROOM_EVENTS:]
        try:
            _write_json_list(CLASSROOM_EVENTS_FILE, events)
        except Exception:
            pass


def _safe_path_component(name: str, fallback: str = "User") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(name or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return (cleaned[:60] or fallback)


def _verify_teacher_class_student(teacher_email: str, class_id: str, student_email: str) -> tuple[bool, Optional[dict]]:
    M = _eagle()
    cls = M._find_class_by_id(class_id)
    if not cls or (cls.get("teacher_email") or "").lower() != (teacher_email or "").lower():
        return False, None
    student_email = (student_email or "").strip().lower()
    if student_email not in {(e or "").lower() for e in cls.get("students", [])}:
        return False, cls
    return True, cls


def _verify_student_in_class(student_email: str, class_id: str) -> tuple[bool, Optional[dict]]:
    M = _eagle()
    cls = M._find_class_by_id(class_id)
    if not cls:
        return False, None
    student_email = (student_email or "").strip().lower()
    if student_email not in {(e or "").lower() for e in cls.get("students", [])}:
        return False, cls
    return True, cls


def _unique_dest_path(user_dir: Path, rel_path: str) -> Optional[Path]:
    M = _eagle()
    target = M._validate_user_path(user_dir, rel_path)
    if not target:
        return None
    if not target.exists():
        return target
    parent_rel = str(Path(rel_path).parent).replace("\\", "/")
    if parent_rel == ".":
        parent_rel = ""
    stem = target.stem
    suffix = target.suffix
    for i in range(2, 100):
        name = f"{stem}_{i}{suffix}"
        candidate_rel = f"{parent_rel}/{name}" if parent_rel else name
        candidate = M._validate_user_path(user_dir, candidate_rel)
        if candidate and not candidate.exists():
            return candidate
    return None


def _copy_file_to_user(
    src_email: str,
    src_path: str,
    dest_email: str,
    dest_rel_path: str,
) -> tuple[bool, str, Optional[str]]:
    M = _eagle()
    src_dir = M._get_user_dir(src_email)
    dest_dir = M._get_user_dir(dest_email)
    dest_dir.mkdir(parents=True, exist_ok=True)
    src = M._validate_user_path(src_dir, src_path)
    if not src or not src.exists() or not src.is_file():
        return False, "Source file not found", None
    if src.suffix.lower() not in M.ALLOWED_EXTENSIONS:
        return False, "File type not allowed", None
    dest = _unique_dest_path(dest_dir, dest_rel_path)
    if not dest:
        return False, "Could not create destination path", None
    try:
        content = src.read_text(encoding="utf-8")
    except Exception:
        return False, "Could not read source file", None
    limit_bytes = M.USER_STORAGE_LIMIT_MB * 1024 * 1024
    used = M._get_user_storage_used(dest_dir)
    content_bytes = len(content.encode("utf-8"))
    existing_size = dest.stat().st_size if dest.exists() else 0
    if used - existing_size + content_bytes > limit_bytes:
        return False, f"Recipient storage limit of {M.USER_STORAGE_LIMIT_MB}MB exceeded", None
    parent_dir = dest.parent
    if M._count_files_in_folder(parent_dir) >= M.MAX_FILES_PER_FOLDER and not dest.exists():
        return False, f"Recipient folder limit reached (max {M.MAX_FILES_PER_FOLDER} files)", None
    if M._count_all_files_for_user(dest_dir) >= M.MAX_FILES_PER_ACCOUNT and not dest.exists():
        return False, f"Recipient account limit reached (max {M.MAX_FILES_PER_ACCOUNT} files)", None
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        return True, "", str(dest.relative_to(dest_dir)).replace("\\", "/")
    except Exception:
        return False, "Could not copy file", None


def reset_example_files_only(student_email: str) -> int:
    M = _eagle()
    user_dir = M._get_user_dir(student_email)
    user_dir.mkdir(parents=True, exist_ok=True)
    examples_rel = M.EXAMPLES_DIR_NAME
    examples_dir = M._validate_user_path(user_dir, examples_rel)
    if not examples_dir:
        return 0
    examples_dir.mkdir(parents=True, exist_ok=True)
    reset_count = 0
    for file_name, content in M.EXAMPLE_FILES.items():
        target = M._validate_user_path(user_dir, f"{examples_rel}/{file_name}")
        if not target:
            continue
        target.write_text(content, encoding="utf-8")
        reset_count += 1
    return reset_count


def _build_file_tree(directory: Path, base: Path) -> tuple[list, int]:
    M = _eagle()
    items = []
    total_size = 0
    if not directory.exists():
        return items, total_size
    try:
        folder_entries = []
        file_entries = []
        with __import__("os").scandir(directory) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        folder_entries.append(entry)
                    elif entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in M.ALLOWED_EXTENSIONS:
                        file_entries.append(entry)
                except OSError:
                    continue
        folder_entries.sort(key=lambda x: x.name.lower())
        file_entries.sort(key=lambda x: x.name.lower())
        for entry in folder_entries:
            entry_path = Path(entry.path)
            rel = str(entry_path.relative_to(base))
            children, child_size = _build_file_tree(entry_path, base)
            total_size += child_size
            items.append({"name": entry.name, "path": rel, "type": "folder", "children": children})
        for entry in file_entries:
            entry_path = Path(entry.path)
            rel = str(entry_path.relative_to(base))
            try:
                size = entry.stat(follow_symlinks=False).st_size
            except OSError:
                size = 0
            total_size += size
            items.append({"name": entry.name, "path": rel, "type": "file", "size": size})
    except PermissionError:
        pass
    return items, total_size


def _emit_classroom_signal_updates(socketio, class_id: str) -> None:
    bucket = _class_bucket(class_id)
    hands = list(bucket.get("hands") or [])
    questions = list(bucket.get("questions") or [])
    open_questions = [q for q in questions if q.get("status") == "open"]
    socketio.emit(
        "classroom_hands_update",
        {"class_id": class_id, "hands": hands},
        room=f"class_{class_id}",
    )
    socketio.emit(
        "classroom_questions_update",
        {"class_id": class_id, "questions": open_questions},
        room=f"class_{class_id}",
    )


def register(app, socketio) -> None:
    M = _eagle()

    @app.get("/api/admin/classroom-events")
    def admin_classroom_events():
        admin_token = request.headers.get("X-Admin-Token", "").strip()
        if not admin_token or admin_token not in M._admin_tokens:
            return jsonify(ok=False, error="Admin token required"), 401
        try:
            limit = max(1, min(500, int(request.args.get("limit", 200))))
        except Exception:
            limit = 200
        try:
            offset = max(0, int(request.args.get("offset", 0)))
        except Exception:
            offset = 0
        with _classroom_events_lock:
            events = list(reversed(_read_json_list(CLASSROOM_EVENTS_FILE)))
        page = events[offset : offset + limit]
        return jsonify(ok=True, events=page, total=len(events))

    @app.get("/api/student/class-roster")
    def student_class_roster():
        student = M._require_user(request)
        if not student:
            return jsonify(ok=False, error="Authentication required"), 401
        class_id = (request.args.get("classId") or "").strip()
        if not class_id:
            return jsonify(ok=False, error="classId required"), 400
        record = M._find_user(student.get("email", ""))
        if not record or not M._user_in_class(record, class_id):
            return jsonify(ok=False, error="Not in class"), 403
        cls = M._find_class_by_id(class_id)
        if not cls:
            return jsonify(ok=False, error="Class not found"), 404
        my_email = (student.get("email") or "").strip().lower()
        users_by_email = {
            (u.get("email") or "").lower(): u for u in M._load_users().get("users", [])
        }
        roster = []
        for student_email in cls.get("students", []):
            email = (student_email or "").strip().lower()
            if not email or email == my_email:
                continue
            user_row = users_by_email.get(email, {})
            roster.append({
                "email": email,
                "name": user_row.get("name") or email,
            })
        roster.sort(key=lambda s: ((s.get("name") or "").lower(), s.get("email", "")))
        return jsonify(ok=True, students=roster)

    @app.get("/api/teacher/classroom/signals")
    def teacher_classroom_signals():
        teacher = M._require_teacher(request)
        if not teacher:
            return jsonify(ok=False, error="Teacher token required"), 401
        class_id = (request.args.get("classId") or "").strip()
        if not class_id:
            return jsonify(ok=False, error="classId required"), 400
        teacher_email = (teacher.get("email") or "").strip().lower()
        cls = M._find_class_by_id(class_id)
        if not cls or (cls.get("teacher_email") or "").lower() != teacher_email:
            return jsonify(ok=False, error="Class not found"), 404
        bucket = _class_bucket(class_id)
        open_questions = [q for q in bucket.get("questions", []) if q.get("status") == "open"]
        return jsonify(ok=True, hands=bucket.get("hands", []), questions=open_questions)

    @app.get("/api/teacher/students/files/list")
    def teacher_student_files_list():
        teacher = M._require_teacher(request)
        if not teacher:
            return jsonify(ok=False, error="Teacher token required"), 401
        class_id = (request.args.get("classId") or "").strip()
        student_email = (request.args.get("studentEmail") or "").strip().lower()
        if not class_id or not student_email:
            return jsonify(ok=False, error="classId and studentEmail required"), 400
        ok, _ = _verify_teacher_class_student(teacher.get("email", ""), class_id, student_email)
        if not ok:
            return jsonify(ok=False, error="Student not in class"), 403
        user_dir = M._get_user_dir(student_email)
        user_dir.mkdir(parents=True, exist_ok=True)
        tree, used_bytes = _build_file_tree(user_dir, user_dir)
        limit_bytes = M.USER_STORAGE_LIMIT_MB * 1024 * 1024
        return jsonify(ok=True, files=tree, used_bytes=used_bytes, limit_bytes=limit_bytes)

    @app.post("/api/teacher/students/files/read")
    def teacher_student_files_read():
        teacher = M._require_teacher(request)
        if not teacher:
            return jsonify(ok=False, error="Teacher token required"), 401
        data = request.get_json(silent=True) or {}
        class_id = (data.get("classId") or "").strip()
        student_email = (data.get("studentEmail") or "").strip().lower()
        path_str = (data.get("path") or "").strip()
        if not class_id or not student_email or not path_str:
            return jsonify(ok=False, error="classId, studentEmail, and path required"), 400
        ok, _ = _verify_teacher_class_student(teacher.get("email", ""), class_id, student_email)
        if not ok:
            return jsonify(ok=False, error="Student not in class"), 403
        user_dir = M._get_user_dir(student_email)
        target = M._validate_user_path(user_dir, path_str)
        if not target or not target.exists() or not target.is_file():
            return jsonify(ok=False, error="File not found"), 404
        if target.suffix.lower() not in M.ALLOWED_EXTENSIONS:
            return jsonify(ok=False, error="File type not allowed"), 400
        try:
            content = target.read_text(encoding="utf-8")
        except Exception:
            return jsonify(ok=False, error="Could not read file"), 500
        append_classroom_event(
            "file_audit_view",
            class_id,
            teacher.get("email", ""),
            "teacher",
            {"student_email": student_email, "path": path_str},
        )
        return jsonify(ok=True, content=content, path=path_str)

    @app.delete("/api/teacher/students/files/delete")
    def teacher_student_files_delete():
        teacher = M._require_teacher(request)
        if not teacher:
            return jsonify(ok=False, error="Teacher token required"), 401
        data = request.get_json(silent=True) or {}
        class_id = (data.get("classId") or "").strip()
        student_email = (data.get("studentEmail") or "").strip().lower()
        path_str = (data.get("path") or "").strip()
        if not class_id or not student_email or not path_str:
            return jsonify(ok=False, error="classId, studentEmail, and path required"), 400
        ok, _ = _verify_teacher_class_student(teacher.get("email", ""), class_id, student_email)
        if not ok:
            return jsonify(ok=False, error="Student not in class"), 403
        user_dir = M._get_user_dir(student_email)
        target = M._validate_user_path(user_dir, path_str)
        if not target or not target.exists():
            return jsonify(ok=False, error="File not found"), 404
        try:
            if target.is_dir():
                __import__("shutil").rmtree(target)
            else:
                target.unlink()
        except Exception:
            return jsonify(ok=False, error="Could not delete item"), 500
        append_classroom_event(
            "file_audit_delete",
            class_id,
            teacher.get("email", ""),
            "teacher",
            {"student_email": student_email, "path": path_str},
        )
        return jsonify(ok=True)

    @app.post("/api/teacher/students/reset-examples")
    def teacher_student_reset_examples():
        teacher = M._require_teacher(request)
        if not teacher:
            return jsonify(ok=False, error="Teacher token required"), 401
        data = request.get_json(silent=True) or {}
        class_id = (data.get("classId") or "").strip()
        student_email = (data.get("studentEmail") or "").strip().lower()
        if not class_id or not student_email:
            return jsonify(ok=False, error="classId and studentEmail required"), 400
        ok, _ = _verify_teacher_class_student(teacher.get("email", ""), class_id, student_email)
        if not ok:
            return jsonify(ok=False, error="Student not in class"), 403
        reset_count = reset_example_files_only(student_email)
        append_classroom_event(
            "examples_reset",
            class_id,
            teacher.get("email", ""),
            "teacher",
            {"student_email": student_email, "files_reset": reset_count},
        )
        return jsonify(ok=True, files_reset=reset_count)

    @app.post("/api/classroom/send-file")
    def classroom_send_file():
        data = request.get_json(silent=True) or {}
        class_id = (data.get("classId") or "").strip()
        source_path = (data.get("sourcePath") or "").strip()
        recipients = data.get("recipients")
        target_email = (data.get("targetEmail") or "").strip().lower()
        if not class_id or not source_path:
            return jsonify(ok=False, error="classId and sourcePath required"), 400

        teacher = M._require_teacher(request)
        student = M._require_user(request)
        cls = M._find_class_by_id(class_id)
        if not cls:
            return jsonify(ok=False, error="Class not found"), 404
        settings = merge_class_settings(cls.get("settings", {}))

        copied = []
        errors = []

        if teacher:
            if (cls.get("teacher_email") or "").lower() != (teacher.get("email") or "").lower():
                return jsonify(ok=False, error="Class not found"), 404
            if recipients == "all" or recipients == ["all"]:
                dest_emails = [e.lower() for e in cls.get("students", [])]
            elif isinstance(recipients, list) and recipients:
                dest_emails = [str(e).strip().lower() for e in recipients if str(e).strip()]
                for email in dest_emails:
                    if email not in {(e or "").lower() for e in cls.get("students", [])}:
                        return jsonify(ok=False, error=f"Student not in class: {email}"), 400
            else:
                return jsonify(ok=False, error="recipients required"), 400
            src_name = Path(source_path).name
            sender_name = teacher.get("name") or teacher.get("email") or "Teacher"
            for dest_email in dest_emails:
                dest_rel = f"{SHARED_DIR}/From Teacher/{src_name}"
                ok_copy, err, final_path = _copy_file_to_user(
                    teacher.get("email", ""), source_path, dest_email, dest_rel
                )
                if ok_copy:
                    copied.append({"email": dest_email, "path": final_path})
                    socketio.emit(
                        "classroom_file_received",
                        {
                            "class_id": class_id,
                            "path": final_path,
                            "filename": Path(final_path).name,
                            "from_name": sender_name,
                            "target_email": dest_email,
                        },
                        room=f"class_{class_id}_students",
                    )
                else:
                    errors.append({"email": dest_email, "error": err})
            append_classroom_event(
                "file_send_teacher",
                class_id,
                teacher.get("email", ""),
                "teacher",
                {"source_path": source_path, "copied": copied, "errors": errors},
            )
            return jsonify(ok=True, copied=copied, errors=errors)

        if not student:
            return jsonify(ok=False, error="Authentication required"), 401
        student_email = (student.get("email") or "").strip().lower()
        if not M._user_in_class(M._find_user(student_email) or {}, class_id):
            return jsonify(ok=False, error="Not in class"), 403
        sender_name = _safe_path_component(student.get("name") or student_email)
        src_name = Path(source_path).name

        if target_email:
            if not settings.get("student_peer_sharing_enabled"):
                return jsonify(ok=False, error="Peer sharing is disabled for this class"), 403
            peer_ok, _ = _verify_student_in_class(target_email, class_id)
            if not peer_ok:
                return jsonify(ok=False, error="Recipient not in class"), 400
            if target_email == student_email:
                return jsonify(ok=False, error="Cannot send file to yourself"), 400
            dest_rel = f"{SHARED_DIR}/From {sender_name}/{src_name}"
            ok_copy, err, final_path = _copy_file_to_user(
                student_email, source_path, target_email, dest_rel
            )
            if not ok_copy:
                return jsonify(ok=False, error=err), 400
            socketio.emit(
                "classroom_file_received",
                {
                    "class_id": class_id,
                    "path": final_path,
                    "filename": Path(final_path).name,
                    "from_name": sender_name,
                    "target_email": target_email,
                },
                room=f"class_{class_id}_students",
            )
            append_classroom_event(
                "file_send_peer",
                class_id,
                student_email,
                "student",
                {"source_path": source_path, "target_email": target_email, "dest_path": final_path},
            )
            return jsonify(ok=True, copied=[{"email": target_email, "path": final_path}], errors=[])

        if not settings.get("student_send_to_teacher_enabled"):
            return jsonify(ok=False, error="Send to teacher is disabled for this class"), 403
        teacher_email = (cls.get("teacher_email") or "").strip().lower()
        if not teacher_email:
            return jsonify(ok=False, error="Teacher not found"), 400
        dest_rel = f"{SHARED_DIR}/{sender_name} - {src_name}"
        ok_copy, err, final_path = _copy_file_to_user(
            student_email, source_path, teacher_email, dest_rel
        )
        if not ok_copy:
            return jsonify(ok=False, error=err), 400
        append_classroom_event(
            "file_send_student_teacher",
            class_id,
            student_email,
            "student",
            {"source_path": source_path, "dest_path": final_path},
        )
        return jsonify(ok=True, copied=[{"email": teacher_email, "path": final_path}], errors=[])

    def _student_from_token(token: str) -> Optional[dict]:
        return M._student_tokens.get(token)

    def _teacher_from_token(token: str) -> Optional[dict]:
        return M._teacher_tokens.get(token)

    def _auth_class_student(token: str, class_id: str) -> Optional[dict]:
        student = _student_from_token(token)
        if not student:
            return None
        record = M._find_user(student.get("email", ""))
        if not record or not M._user_in_class(record, class_id):
            return None
        return student

    def _auth_class_teacher(token: str, class_id: str) -> Optional[dict]:
        teacher = _teacher_from_token(token)
        if not teacher:
            return None
        cls = M._find_class_by_id(class_id)
        if not cls or (cls.get("teacher_email") or "").lower() != (teacher.get("email") or "").lower():
            return None
        return teacher

    @socketio.on("classroom_hand_raise")
    def on_classroom_hand_raise(payload):
        class_id = str((payload or {}).get("class_id") or "").strip()
        token = str((payload or {}).get("token") or "").strip()
        student = _auth_class_student(token, class_id)
        if not student:
            return
        cls = M._find_class_by_id(class_id)
        if not merge_class_settings(cls.get("settings", {})).get("raise_hand_enabled"):
            return
        email = (student.get("email") or "").strip().lower()
        name = student.get("name") or email
        bucket = _class_bucket(class_id)
        hands = bucket.get("hands", [])
        if not any((h.get("student_email") or "").lower() == email for h in hands):
            hands.append({
                "student_email": email,
                "student_name": name,
                "raised_at": M._current_timestamp(),
            })
        bucket["hands"] = hands
        _save_class_bucket(class_id, bucket)
        append_classroom_event("hand_raise", class_id, email, "student", {})
        _emit_classroom_signal_updates(socketio, class_id)

    @socketio.on("classroom_hand_lower")
    def on_classroom_hand_lower(payload):
        class_id = str((payload or {}).get("class_id") or "").strip()
        token = str((payload or {}).get("token") or "").strip()
        student = _auth_class_student(token, class_id)
        if not student:
            return
        email = (student.get("email") or "").strip().lower()
        bucket = _class_bucket(class_id)
        bucket["hands"] = [
            h for h in bucket.get("hands", [])
            if (h.get("student_email") or "").lower() != email
        ]
        _save_class_bucket(class_id, bucket)
        append_classroom_event("hand_lower", class_id, email, "student", {})
        _emit_classroom_signal_updates(socketio, class_id)

    @socketio.on("classroom_question_submit")
    def on_classroom_question_submit(payload):
        class_id = str((payload or {}).get("class_id") or "").strip()
        token = str((payload or {}).get("token") or "").strip()
        text = str((payload or {}).get("text") or "").strip()[:MAX_QUESTION_LENGTH]
        student = _auth_class_student(token, class_id)
        if not student or not text:
            return
        cls = M._find_class_by_id(class_id)
        if not merge_class_settings(cls.get("settings", {})).get("raise_hand_enabled"):
            return
        email = (student.get("email") or "").strip().lower()
        name = student.get("name") or email
        bucket = _class_bucket(class_id)
        questions = bucket.get("questions", [])
        open_count = sum(
            1 for q in questions
            if (q.get("student_email") or "").lower() == email and q.get("status") == "open"
        )
        if open_count >= MAX_OPEN_QUESTIONS_PER_STUDENT:
            socketio.emit(
                "classroom_question_error",
                {"class_id": class_id, "error": f"Maximum {MAX_OPEN_QUESTIONS_PER_STUDENT} open questions allowed"},
                to=request.sid,
            )
            return
        question = {
            "id": uuid.uuid4().hex,
            "student_email": email,
            "student_name": name,
            "text": text,
            "created_at": M._current_timestamp(),
            "status": "open",
        }
        questions.append(question)
        bucket["questions"] = questions
        _save_class_bucket(class_id, bucket)
        append_classroom_event("question_submit", class_id, email, "student", {"question_id": question["id"]})
        _emit_classroom_signal_updates(socketio, class_id)

    @socketio.on("classroom_hand_ack")
    def on_classroom_hand_ack(payload):
        class_id = str((payload or {}).get("class_id") or "").strip()
        token = str((payload or {}).get("token") or "").strip()
        student_email = str((payload or {}).get("student_email") or "").strip().lower()
        teacher = _auth_class_teacher(token, class_id)
        if not teacher or not student_email:
            return
        bucket = _class_bucket(class_id)
        bucket["hands"] = [
            h for h in bucket.get("hands", [])
            if (h.get("student_email") or "").lower() != student_email
        ]
        _save_class_bucket(class_id, bucket)
        append_classroom_event(
            "hand_ack",
            class_id,
            teacher.get("email", ""),
            "teacher",
            {"student_email": student_email},
        )
        _emit_classroom_signal_updates(socketio, class_id)

    @socketio.on("classroom_question_dismiss")
    def on_classroom_question_dismiss(payload):
        class_id = str((payload or {}).get("class_id") or "").strip()
        token = str((payload or {}).get("token") or "").strip()
        question_id = str((payload or {}).get("question_id") or "").strip()
        teacher = _auth_class_teacher(token, class_id)
        if not teacher or not question_id:
            return
        bucket = _class_bucket(class_id)
        for q in bucket.get("questions", []):
            if q.get("id") == question_id and q.get("status") == "open":
                q["status"] = "dismissed"
        _save_class_bucket(class_id, bucket)
        append_classroom_event(
            "question_dismiss",
            class_id,
            teacher.get("email", ""),
            "teacher",
            {"question_id": question_id},
        )
        _emit_classroom_signal_updates(socketio, class_id)

    @socketio.on("classroom_question_respond")
    def on_classroom_question_respond(payload):
        class_id = str((payload or {}).get("class_id") or "").strip()
        token = str((payload or {}).get("token") or "").strip()
        question_id = str((payload or {}).get("question_id") or "").strip()
        response = str((payload or {}).get("response") or "").strip()[:MAX_RESPONSE_LENGTH]
        teacher = _auth_class_teacher(token, class_id)
        if not teacher or not question_id or not response:
            return
        bucket = _class_bucket(class_id)
        target_q = None
        for q in bucket.get("questions", []):
            if q.get("id") == question_id and q.get("status") == "open":
                q["status"] = "responded"
                q["response"] = response
                q["responded_at"] = M._current_timestamp()
                target_q = q
                break
        if not target_q:
            return
        _save_class_bucket(class_id, bucket)
        append_classroom_event(
            "question_respond",
            class_id,
            teacher.get("email", ""),
            "teacher",
            {"question_id": question_id, "student_email": target_q.get("student_email")},
        )
        socketio.emit(
            "classroom_question_responded",
            {
                "class_id": class_id,
                "question_id": question_id,
                "response": response,
                "student_email": target_q.get("student_email"),
            },
            room=f"class_{class_id}_students",
        )
        _emit_classroom_signal_updates(socketio, class_id)
