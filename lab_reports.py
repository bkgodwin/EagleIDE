"""Durable student drafts for continuous-page lab report assignments."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from flask import jsonify, request


MAX_DRAFT_BYTES = 512_000
MAX_RESPONSE_TEXT = 20_000


class LabReportDraftStore:
    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir).resolve()
        self._lock = threading.RLock()

    @staticmethod
    def _assignment_id(value: object) -> str:
        value = str(value or "").strip().lower()
        if not re.fullmatch(r"[a-f0-9]{32}", value):
            raise ValueError("Invalid assignment identifier")
        return value

    @staticmethod
    def _account_id(email: object) -> str:
        normalized = str(email or "").strip().lower()
        if not normalized:
            raise ValueError("Invalid student identity")
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def _path(self, assignment_id: object, email: object) -> Path:
        return self.base_dir / self._assignment_id(assignment_id) / f"{self._account_id(email)}.json"

    def get(self, assignment_id: object, email: object) -> dict:
        path = self._path(assignment_id, email)
        with self._lock:
            if not path.exists():
                return {"revision": 0, "responses": [], "updated_at": None}
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ValueError("Lab report draft is unavailable") from exc
            if not isinstance(data, dict) or not isinstance(data.get("responses", []), list):
                raise ValueError("Lab report draft is invalid")
            return copy.deepcopy({
                "revision": max(0, int(data.get("revision", 0))),
                "responses": data.get("responses", []),
                "updated_at": data.get("updated_at"),
            })

    def save(self, assignment_id: object, email: object, responses: list, expected_revision: int) -> dict:
        path = self._path(assignment_id, email)
        with self._lock:
            current = self.get(assignment_id, email)
            if int(expected_revision) != current["revision"]:
                error = ValueError("Lab report changed in another session")
                error.current = current
                raise error
            result = {
                "student_email": str(email).strip().lower(),
                "revision": current["revision"] + 1,
                "responses": copy.deepcopy(responses),
                "updated_at": int(time.time()),
            }
            encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) > MAX_DRAFT_BYTES:
                raise ValueError("Lab report draft is too large")
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(path.parent, 0o700)
            except OSError:
                pass
            temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
            temporary.write_bytes(encoded)
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            temporary.replace(path)
            return copy.deepcopy({key: result[key] for key in ("revision", "responses", "updated_at")})

    def delete(self, assignment_id: object, email: object) -> None:
        path = self._path(assignment_id, email)
        with self._lock:
            path.unlink(missing_ok=True)
            try:
                path.parent.rmdir()
            except OSError:
                pass

    def clear_assignment(self, assignment_id: object) -> None:
        assignment_id = self._assignment_id(assignment_id)
        target = (self.base_dir / assignment_id).resolve()
        if target.parent != self.base_dir:
            raise ValueError("Invalid assignment draft path")
        with self._lock:
            if not target.exists():
                return
            for path in target.iterdir():
                if path.is_file() and re.fullmatch(r"[a-f0-9]{64}\.json", path.name):
                    path.unlink()
            target.rmdir()


def _clean_responses(assignment: dict, raw: object) -> list[dict]:
    questions = {
        str(item.get("id") or ""): item
        for item in ((assignment.get("quiz") or {}).get("questions") or [])
        if isinstance(item, dict) and item.get("id")
    }
    if not isinstance(raw, list) or len(raw) > len(questions):
        raise ValueError("Invalid lab report responses")
    cleaned, seen = [], set()
    for response in raw:
        if not isinstance(response, dict):
            raise ValueError("Invalid lab report response")
        question_id = str(response.get("questionId") or "")
        if question_id in seen or question_id not in questions:
            raise ValueError("Lab report responses must be unique and belong to this assignment")
        seen.add(question_id)
        question = questions[question_id]
        kind = question.get("type")
        answer = response.get("answer")
        if kind == "procedure":
            steps = question.get("steps") or []
            if not isinstance(answer, list) or len(answer) != len(steps) or any(type(item) is not bool for item in answer):
                raise ValueError("Procedure checklist response is invalid")
        else:
            if not isinstance(answer, str) or len(answer) > MAX_RESPONSE_TEXT:
                raise ValueError("Lab report responses must be text of at most 20,000 characters")
        cleaned.append({"questionId": question_id, "answer": answer, "questionType": kind})
    return cleaned


def register(app, eagle, *, base_dir: Path):
    store = LabReportDraftStore(base_dir)

    def assignment_for_student(reference: str):
        student = eagle._require_user(request)
        if not student:
            return None, None, (jsonify(ok=False, error="Student login required"), 401)
        assignment = eagle._load_assignment(reference)
        if not assignment or assignment.get("assignmentType") != "lab_report":
            return None, None, (jsonify(ok=False, error="Lab report assignment not found"), 404)
        email = str(student.get("email") or "").strip().lower()
        class_id = assignment.get("targetClassId")
        if not class_id or not eagle._user_in_class(eagle._find_user(email) or student, class_id):
            return None, None, (jsonify(ok=False, error="Lab report is not assigned to your class"), 403)
        return student, assignment, None

    @app.get("/api/lab-reports/<assignment_id>/draft")
    def lab_report_draft_get(assignment_id):
        student, assignment, error = assignment_for_student(assignment_id)
        if error:
            return error
        try:
            draft = store.get(assignment["id"], student.get("email"))
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 503
        return jsonify(ok=True, data=draft)

    @app.put("/api/lab-reports/<assignment_id>/draft")
    def lab_report_draft_put(assignment_id):
        # Serialize final submissions, assignment edits/deletion, and autosaves.
        with eagle._assignment_lock:
            return save_draft_locked(assignment_id)

    def save_draft_locked(assignment_id):
        student, assignment, error = assignment_for_student(assignment_id)
        if error:
            return error
        submission_error = eagle.assignment_workflow.submission_error(eagle, assignment, student)
        if submission_error:
            return jsonify(ok=False, error=submission_error), 403
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or type(data.get("revision")) is not int:
            return jsonify(ok=False, error="A draft revision and responses are required"), 400
        try:
            responses = _clean_responses(assignment, data.get("responses"))
            saved = store.save(assignment["id"], student.get("email"), responses, data["revision"])
        except ValueError as exc:
            current = getattr(exc, "current", None)
            if current is not None:
                return jsonify(ok=False, error=str(exc), data=current), 409
            return jsonify(ok=False, error=str(exc)), 400
        return jsonify(ok=True, data=saved)

    app.extensions["lab_report_drafts"] = store
    return store
