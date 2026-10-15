"""Per-student assignment deadlines, submission bundles, and protected previews."""
from __future__ import annotations

import copy
import ast
import csv
import hashlib
import json
import math
import re
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import jsonify, request, send_file
import file_provenance

MAX_FILES = 20
MAX_BUNDLE_BYTES = 25 * 1024 * 1024
MAX_PREVIEW_BYTES = 2 * 1024 * 1024
HISTORY_LIMIT = 3
CODE_EXTENSIONS = {".py", ".js"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}


def accommodation(value, *, strict=False):
    if strict and not isinstance(value, dict):
        raise ValueError("Accommodations must be an object")
    value = value if isinstance(value, dict) else {}
    days = value.get("extendedWeekdays", 0)
    try:
        if isinstance(days, bool) or int(days) != float(days) or not 0 <= int(days) <= 365:
            raise ValueError()
        days = int(days)
    except (TypeError, ValueError, OverflowError):
        if strict:
            raise ValueError("Extended time must be a whole number from 0 to 365 weekdays")
        days = 0
    if strict and not isinstance(value.get("noDueDate", False), bool):
        raise ValueError("No due date must be enabled or disabled")
    return {"extendedWeekdays": days, "noDueDate": bool(value.get("noDueDate", False))}


def window_settings(value, *, strict=False):
    if strict and not isinstance(value, dict):
        raise ValueError("Submission window must be an object")
    value = value if isinstance(value, dict) else {}
    start, end = str(value.get("start") or "08:00"), str(value.get("end") or "15:00")
    zone = str(value.get("timeZone") or "UTC")
    valid = all(re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", t) for t in (start, end)) and start < end
    if not valid:
        if strict:
            raise ValueError("Submission window end must be later than its start on the same weekday")
        start, end = "08:00", "15:00"
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError):
        if strict:
            raise ValueError("Choose a valid IANA time zone, for example America/Chicago")
        zone = "UTC"
    if strict and not isinstance(value.get("enabled", False), bool):
        raise ValueError("Submission window must be enabled or disabled")
    return {"enabled": bool(value.get("enabled", False)), "start": start, "end": end, "timeZone": zone}


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_extensions(eagle, value):
    result = {}
    for email, record in (value.items() if isinstance(value, dict) else []):
        if not isinstance(email, str) or not isinstance(record, dict):
            continue
        try:
            until = eagle._normalize_assignment_due_at(record.get("until"))
        except ValueError:
            continue
        if not until:
            continue
        result[email.strip().lower()] = {"until": until, "grantedAt": str(record.get("grantedAt") or "")[:80],
            **{key: max(0, record[key]) for key in ("fileAttemptLimit", "quizAttemptLimit") if type(record.get(key)) is int}}
    return result


def student_state(eagle, assignment, email, *, now=None):
    cls = eagle._find_class_by_id(assignment.get("targetClassId")) or {}
    support = accommodation((cls.get("accommodations") or {}).get(str(email).lower()))
    window = window_settings((cls.get("settings") or {}).get("assignment_submission_window"))
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    due = str(assignment.get("dueAt") or "")
    note = ""
    if due and support["extendedWeekdays"] and not support["noDueDate"]:
        local_due = datetime.fromisoformat(due.replace("Z", "+00:00")).astimezone(ZoneInfo(window["timeZone"]))
        remaining = support["extendedWeekdays"]
        while remaining:
            local_due += timedelta(days=1)
            if local_due.weekday() < 5:
                remaining -= 1
        due = iso(local_due)
        note = "Extended deadline provided per accommodation"
    effective = {**assignment, "dueAt": due}
    expired = eagle._assignment_due_has_passed(effective, now=current)
    past = not eagle._assignment_is_active(effective, now=current)
    deadline_allowed = bool(assignment.get("active")) and (not expired or support["noDueDate"] or assignment.get("dueLockOverride"))
    if support["noDueDate"]:
        # No-deadline work moves to Past on the ordinary class deadline, but
        # remains submittable unless the teacher explicitly locks it.
        past = not eagle._assignment_is_active(assignment, now=current)
        due = ""
        note = "No deadline provided per accommodation"
    extension = (assignment.get("studentExtensions") or {}).get(str(email).lower()) or {}
    until = extension.get("until", "")
    reopened = bool(until and not eagle._assignment_due_has_passed({"dueAt": until}, now=current))
    if reopened:
        due, expired, past, deadline_allowed = until, False, False, True
        note = "Make-up / retest deadline"
    if assignment.get("gradingCompletedAt"):
        past, deadline_allowed = True, False
    window_allowed, next_change = True, ""
    message = ""
    if window["enabled"] and not assignment.get("allowSubmissionAnyTime", False) and not reopened:
        local = current.astimezone(ZoneInfo(window["timeZone"]))
        clock = local.strftime("%H:%M")
        window_allowed = local.weekday() < 5 and window["start"] <= clock < window["end"]
        next_local = local.replace(hour=int(window["end" if window_allowed else "start"][:2]), minute=int(window["end" if window_allowed else "start"][3:]), second=0, microsecond=0)
        if not window_allowed:
            if next_local <= local:
                next_local += timedelta(days=1)
            while next_local.weekday() >= 5:
                next_local += timedelta(days=1)
        next_change = iso(next_local)
        message = f"Submissions open weekdays {window['start']}–{window['end']} ({window['timeZone']})."
    return {"dueAt": due, "accommodationNote": note, "isPast": past,
            "active": not past, "dueExpired": expired, "canSubmit": bool(deadline_allowed and window_allowed),
            "deadlineOpen": bool(deadline_allowed),
            "submissionWindowOpen": window_allowed, "submissionWindowMessage": message,
            "nextWindowChangeAt": next_change}


def attempt_limit(eagle, assignment, email, kind):
    maximum = assignment.get("maxFileSubmissions", 0) if kind == "file" else (assignment.get("quizSettings") or {}).get("maxSubmissions", 0)
    extension = (assignment.get("studentExtensions") or {}).get(str(email).lower()) or {}
    if maximum and extension.get("until") and not eagle._assignment_due_has_passed({"dueAt": extension["until"]}):
        maximum = max(maximum, extension.get(f"{kind}AttemptLimit", maximum))
    return maximum


def submission_error(eagle, assignment, user):
    email = str(user.get("email") or "").lower()
    if not eagle._user_in_class(eagle._find_user(email) or user, assignment.get("targetClassId")):
        return "This assignment is not assigned to your class"
    state = student_state(eagle, assignment, email)
    if not state["canSubmit"]:
        return state["submissionWindowMessage"] if not state["submissionWindowOpen"] else "Assignment is locked or its deadline has passed"
    return None


def files_for(submission):
    files = submission.get("files") or []
    if files:
        return files
    if submission.get("submissionPath"):
        return [{"id": "legacy", "name": submission.get("submittedFileName") or "submission.py", "path": submission["submissionPath"], "size": 0}]
    return []


def public_files(submission):
    return [{key: f.get(key) for key in ("id", "name", "size")} for f in files_for(submission)]


def teacher_payload(eagle, assignment):
    payload = eagle._assignment_effective_payload(assignment)
    for submission in payload.get("submissions", []):
        submission["hasGradableFiles"] = bool(submission.get("code")) and not submission.get("withdrawn") and has_gradable_files(submission)
        submission["hasPastedText"] = any(f.get("pasteRanges") for f in files_for(submission))
        submission.pop("code", None)
        for old in submission.get("history", []):
            old.pop("code", None)
    return payload


def student_feedback(assignment, submission):
    if not assignment.get("shareAiFeedback"):
        return ""
    return submission.get("teacherFeedback", "") if submission.get("teacherFeedbackEdited") else submission.get("aiFeedback", "")


def archive(previous):
    if not previous:
        return []
    snapshot = copy.deepcopy({k: v for k, v in previous.items() if k not in {"history", "code"}})
    snapshot["revisionId"] = snapshot.get("revisionId") or uuid.uuid4().hex
    snapshot["files"] = files_for(previous)
    return [snapshot, *(previous.get("history") or [])][:HISTORY_LIMIT]


def grading_code(eagle, assignment, submission, *, anonymous=False):
    files = files_for(submission)
    if not files:
        return str(submission.get("code") or "")
    parts = []
    for f in files:
        suffix = Path(f.get("name") or "").suffix.lower()
        if suffix not in CODE_EXTENSIONS:
            continue
        target = eagle._assignment_submission_path(assignment, f.get("path") or "")
        if not target or not target.is_file() or target.stat().st_size > MAX_PREVIEW_BYTES + 1024:
            raise ValueError("A submitted code file is unavailable or exceeds the grading size limit")
        content = target.read_text(encoding="utf-8")
        if anonymous:
            content = eagle.SUBMISSION_HEADER_PREFIX_PATTERN.sub("", content)
        if len(files) == 1:
            parts.append(content)
        else:
            label = f"Source file {len(parts) + 1} ({suffix})" if anonymous else f"File: {f['name']}"
            prefix = "#" if suffix == ".py" else "//"
            parts.append(f"{prefix} {label}\n{content}")
    return "\n\n".join(parts)


def has_gradable_files(submission):
    files = files_for(submission)
    if files:
        return any(Path(f.get("name") or "").suffix.lower() in CODE_EXTENSIONS for f in files)
    # Old records sometimes retained source only, without a file copy/name.
    name = submission.get("submittedFileName") or submission.get("sourceFilePath") or "submission.py"
    return bool(submission.get("code")) and Path(name).suffix.lower() in CODE_EXTENSIONS


def python_syntax(eagle, assignment, submission):
    """Check Python files separately; concatenation is only a grading envelope."""
    files = files_for(submission)
    errors = []
    if len(files) <= 1:
        files = [{"name": submission.get("submittedFileName") or "submission.py", "content": submission.get("code", "")}]
    for file in files:
        if Path(file.get("name") or "").suffix.lower() != ".py":
            continue
        if "content" in file:
            source = file["content"]
        else:
            target = eagle._assignment_submission_path(assignment, file.get("path") or "")
            if not target or not target.is_file() or target.stat().st_size > MAX_PREVIEW_BYTES + 1024:
                raise ValueError("Submitted Python source is unavailable")
            source = target.read_text(encoding="utf-8")
        try:
            ast.parse(source)
        except SyntaxError as exc:
            errors.append(f"{file['name']}: an error on line {exc.lineno}: {exc.msg}")
    return "; ".join(errors)


def store_bundle(eagle, assignment, user, data, uploads=()):
    with file_provenance.lock(eagle._get_user_dir(user["email"])):
        return _store_bundle(eagle, assignment, user, data, uploads)


def _store_bundle(eagle, assignment, user, data, uploads=()):
    paths = data.get("filePaths", [data["filePath"]] if data.get("filePath") else [])
    if not isinstance(paths, list) or any(not isinstance(p, str) for p in paths) or len(set(paths)) != len(paths):
        raise ValueError("Select distinct workspace files")
    uploads = list(uploads)
    if assignment.get("fileControl"):
        import assignment_development as development
        controlled = development.binding(eagle, assignment["id"], user["email"])
        expected = eagle._validate_workspace_path(eagle._get_user_dir(user["email"]), controlled["path"]) if controlled else None
        selected = eagle._validate_workspace_path(eagle._get_user_dir(user["email"]), paths[0]) if len(paths) == 1 else None
        if uploads or not expected or selected != expected:
            raise ValueError("Submit only the dedicated assignment file from Home. Attachments and other files are not accepted.")
    count = len(paths) + len(uploads)
    if not 1 <= count <= MAX_FILES:
        raise ValueError(f"Select from 1 to {MAX_FILES} files")
    if not assignment.get("allowMultiFileSubmission") and count != 1:
        raise ValueError("This assignment accepts one file")
    sources = []
    total = 0
    root = eagle._get_user_dir(user["email"])
    for path in paths:
        target = eagle._validate_workspace_path(root, path)
        if not target or not target.is_file() or eagle._is_trash_path(root, target):
            raise ValueError("Selected workspace file not found")
        with target.open("rb") as handle:
            content = handle.read(MAX_BUNDLE_BYTES - total + 1)
        total += len(content)
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("Submission files exceed the 25 MB total limit")
        sources.append((target.name, content, path))
    for upload in uploads:
        name = str(upload.filename or "")
        if not eagle._valid_workspace_name(name):
            raise ValueError("Attachment filename is invalid")
        content = upload.stream.read(MAX_BUNDLE_BYTES - total + 1)
        total += len(content)
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("Submission files exceed the 25 MB total limit")
        sources.append((name, content, ""))
    total = 0
    for name, content, _ in sources:
        total += len(content)
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("Submission files exceed the 25 MB total limit")
        if Path(name).suffix.lower() in CODE_EXTENSIONS:
            if len(content) > MAX_PREVIEW_BYTES:
                raise ValueError("Each Python or JavaScript file must be at most 2 MB")
            content.decode("utf-8")
    assignment_dir = eagle._assignment_submission_directory(assignment)
    student_key = hashlib.sha256(user["email"].lower().encode()).hexdigest()[:20]
    student_dir = assignment_dir / f"student--{student_key}"
    student_dir.resolve().relative_to(assignment_dir.resolve())
    revision = uuid.uuid4().hex
    destination = student_dir / revision
    staging = student_dir / f".{revision}.tmp"
    student_dir.mkdir(parents=True, exist_ok=True)
    submitted_at = eagle._current_timestamp()
    try:
        staging.mkdir()
        records = []
        for index, (name, content, source) in enumerate(sources):
            stored_name = f"{index + 1:02d}-{name}"
            ranges = []
            if source and Path(name).suffix.lower() in eagle.TEXT_EXTENSIONS:
                try:
                    text = content.decode("utf-8")
                    canonical = text.replace("\r\n", "\n").replace("\r", "\n")
                    target = eagle._validate_workspace_path(root, source)
                    ranges = file_provenance.read(eagle, root, target, canonical)
                    if canonical != text:
                        ranges = file_provenance.remap(ranges, canonical, text)
                except UnicodeError:
                    pass
            if Path(name).suffix.lower() == ".py":
                text = content.decode("utf-8")
                stamped = eagle._prepend_submission_timestamp(text, submitted_at, user.get("name") or "Student")
                ranges = file_provenance.remap(ranges, text, stamped)
                content = stamped.encode("utf-8")
            (staging / stored_name).write_bytes(content)
            records.append({"id": uuid.uuid4().hex, "name": name, "size": len(content), "sourceFilePath": source,
                            "path": (destination / stored_name).relative_to(eagle.ASSIGNMENT_SUBMISSIONS_DIR.resolve()).as_posix(), "pasteRanges": ranges})
        staging.replace(destination)
        result = {"revisionId": revision, "files": records, "submittedAt": submitted_at,
                  "revisionDirectory": destination.relative_to(eagle.ASSIGNMENT_SUBMISSIONS_DIR.resolve()).as_posix(),
                  "submissionPath": records[0]["path"], "submittedFileName": records[0]["name"],
                  "sourceFilePath": records[0]["sourceFilePath"]}
        result["code"] = grading_code(eagle, assignment, result)
        return result
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(destination, ignore_errors=True)
        raise


def prune_history(eagle, assignment, previous):
    retained = set()
    for sub in assignment.get("submissions") or []:
        for record in [sub, *(sub.get("history") or [])]:
            retained.update(f.get("path") for f in files_for(record))
    for old in [previous, *(previous.get("history") or [])]:
        for f in files_for(old):
            if f.get("path") in retained:
                continue
            target = eagle._assignment_submission_path(assignment, f.get("path") or "")
            if target and target.is_file():
                try:
                    target.unlink()
                except OSError:
                    eagle.app.logger.warning("Could not remove an expired submission snapshot")
                    continue
                try:
                    target.parent.rmdir()
                except OSError:
                    pass  # A bundle may still contain other expired files.


def submit(eagle):
    user = eagle._require_user(request)
    if not user:
        return jsonify(ok=False, error="Student login required"), 401
    if request.mimetype == "multipart/form-data":
        try:
            data = json.loads(request.form.get("payload", "{}"))
        except (ValueError, TypeError):
            return jsonify(ok=False, error="Invalid submission selection"), 400
        uploads = request.files.getlist("files")
    else:
        data, uploads = request.get_json(silent=True) or {}, []
    if not isinstance(data, dict):
        return jsonify(ok=False, error="Invalid submission"), 400
    if data.get("quizResponses"):
        return jsonify(ok=False, error="Submit question answers using the questions menu"), 400
    reference, class_hint = eagle._assignment_request_reference(data)
    with eagle._assignment_lock:
        assignment = eagle._load_assignment(reference, class_hint)
        if not assignment:
            return jsonify(ok=False, error="Assignment not found"), 404
        error = submission_error(eagle, assignment, user)
        if error:
            return jsonify(ok=False, error=error), 403
        email = user["email"].lower()
        previous = next((s for s in assignment.get("submissions", []) if s.get("email", "").lower() == email), {})
        count = int(previous.get("fileSubmissionCount", 0))
        maximum = attempt_limit(eagle, assignment, email, "file")
        if maximum and count >= maximum:
            return jsonify(ok=False, error="Maximum file submission attempts reached. Ask your teacher to un-submit accidental work."), 403
        if not assignment.get("allowFileSubmission", True):
            return jsonify(ok=False, error="File submissions are disabled. Use the questions menu."), 400
        try:
            bundle = store_bundle(eagle, assignment, user, data, uploads)
        except (ValueError, UnicodeError) as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except OSError:
            return jsonify(ok=False, error="Could not store submission files"), 500
        sub = {"name": user.get("name") or email, "email": email, **bundle,
               "history": archive(previous), "fileSubmissionCount": count + 1,
               "adminFilePath": "", "codeScore": None, "totalScore": previous.get("quizScore"),
               "quizResponses": previous.get("quizResponses", []), "quizScore": previous.get("quizScore"),
               "quizSubmissionCount": previous.get("quizSubmissionCount", 0),
               "quizLastSubmittedByClose": previous.get("quizLastSubmittedByClose", False),
               "aiSuggestedScore": None, "aiFeedback": "", "teacherFeedback": "", "aiGradingStatus": "",
               "aiGradingError": "", "manualScoreOverride": False, "withdrawn": False}
        assignment["submissions"] = [s for s in assignment.get("submissions", []) if s.get("email", "").lower() != email] + [sub]
        if not eagle._save_assignment(assignment):
            path = eagle._assignment_submission_path(assignment, bundle["submissionPath"])
            if path:
                shutil.rmtree(path.parent, ignore_errors=True)
            return jsonify(ok=False, error="Could not save submission metadata"), 500
        prune_history(eagle, assignment, previous)
    eagle.socketio.emit("assignment_workflow_updated", {"classId": assignment.get("targetClassId")}, to=f"class_{assignment.get('targetClassId')}")
    visible = {k: v for k, v in sub.items() if k not in {"history", "aiFeedback", "teacherFeedback", "aiGradingStatus", "aiGradingError", "aiSuggestedScore", "manualScoreOverride"}}
    visible["files"] = public_files(sub)
    if len(sub["files"]) > 1:
        visible.pop("code", None)
    return jsonify(ok=True, message="Submission saved successfully", submission=visible)


def clone_revision(eagle, assignment, previous):
    """Keep old file snapshots immutable when a quiz-only resubmission occurs."""
    records = files_for(previous)
    if not records:
        return {"revisionId": uuid.uuid4().hex}
    assignment_dir = eagle._assignment_submission_directory(assignment)
    student_key = hashlib.sha256(previous["email"].lower().encode()).hexdigest()[:20]
    destination = assignment_dir / f"student--{student_key}" / uuid.uuid4().hex
    destination.resolve().relative_to(assignment_dir.resolve())
    copied = []
    try:
        destination.mkdir(parents=True)
        for index, record in enumerate(records):
            source = eagle._assignment_submission_path(assignment, record.get("path") or "")
            if not source or not source.is_file():
                raise ValueError("A previous submission file is unavailable")
            target = destination / f"{index + 1:02d}-{record['name']}"
            target.resolve().relative_to(destination.resolve())
            shutil.copyfile(source, target)
            copied.append({**record, "path": target.relative_to(eagle.ASSIGNMENT_SUBMISSIONS_DIR.resolve()).as_posix()})
        return {"revisionId": destination.name, "files": copied, "submissionPath": copied[0]["path"],
                "revisionDirectory": destination.relative_to(eagle.ASSIGNMENT_SUBMISSIONS_DIR.resolve()).as_posix()}
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def override_score(eagle):
    """Serialize per-question grading and reject stale submission revisions."""
    actor = eagle._assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(ok=False, error="Invalid score request"), 400
    reference, hint = eagle._assignment_request_reference(data)
    email = str(data.get("studentEmail") or "").strip().lower()
    with eagle._assignment_lock:
        assignment = eagle._load_assignment(reference, hint)
        if not assignment:
            return jsonify(ok=False, error="Assignment not found"), 404
        if not eagle._assignment_access(actor, assignment):
            return jsonify(ok=False, error="Assignment access denied"), 403
        question = next((q for q in (assignment.get("quiz") or {}).get("questions", []) if q.get("id") == data.get("questionId")), None)
        sub = next((s for s in assignment.get("submissions", []) if s.get("email", "").lower() == email), None)
        response = next((r for r in (sub or {}).get("quizResponses", []) if r.get("questionId") == data.get("questionId")), None)
        if not question or not sub or response is None or sub.get("withdrawn"):
            return jsonify(ok=False, error="Current submission or question not found"), 404
        if data.get("revisionId") and data["revisionId"] != sub.get("revisionId"):
            return jsonify(ok=False, error="A newer submission arrived. Reopen grading before saving."), 409
        score = data.get("manualScore")
        if score is not None and (isinstance(score, bool) or not isinstance(score, (int, float)) or not 0 <= score <= question.get("points", 0) or not math.isfinite(score)):
            return jsonify(ok=False, error="Score must be between zero and the question maximum"), 400
        response["manualScore"] = score
        fallback = response.get("aiScore")
        if fallback is None:
            fallback = question.get("points", 0) if question.get("type") in {"multiple_choice", "multiple_choice_code"} and response.get("answer") == question.get("correctAnswer") else 0
        if not isinstance(fallback, (int, float)) or isinstance(fallback, bool) or not 0 <= fallback <= question.get("points", 0):
            fallback = 0
        response["pointsEarned"] = score if score is not None else fallback
        sub["quizScore"] = sum(r.get("pointsEarned", 0) or 0 for r in sub.get("quizResponses", []))
        sub["totalScore"] = (sub.get("codeScore") or 0) + sub["quizScore"]
        if not eagle._save_assignment(assignment):
            return jsonify(ok=False, error="Failed to save score"), 500
        return jsonify(ok=True, pointsEarned=response["pointsEarned"], quizScore=sub["quizScore"], totalScore=sub["totalScore"])


def register(app, eagle):
    @app.post("/api/assignments/extend-student")
    def extend_student():
        actor = eagle._assignment_actor(request)
        if not actor:
            return jsonify(ok=False, error="Teacher authentication required"), 401
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(ok=False, error="Invalid extension request"), 400
        days = data.get("days")
        if isinstance(days, bool) or not isinstance(days, int) or not 0 <= days <= 365:
            return jsonify(ok=False, error="Choose a whole number from 1 to 365 days, or 0 to remove the extension"), 400
        email = str(data.get("studentEmail") or "").strip().lower()
        with eagle._assignment_lock:
            assignment = eagle._load_assignment(data.get("assignmentId") or "")
            if not assignment or not eagle._assignment_access(actor, assignment, owner_only=True):
                return jsonify(ok=False, error="Only the class owner may extend assignments"), 403
            if assignment.get("gradingCompletedAt"):
                return jsonify(ok=False, error="Grading is finalized. Copy this assignment to start a new assignment."), 409
            cls = eagle._find_class_by_id(assignment.get("targetClassId")) or {}
            if email not in cls.get("students", []):
                return jsonify(ok=False, error="Student is not in this class"), 404
            if not assignment.get("releasedAt"):
                return jsonify(ok=False, error="Release this assignment before granting make-up time"), 409
            extensions = assignment.setdefault("studentExtensions", {})
            if days:
                now = datetime.now(timezone.utc)
                sub = next((s for s in assignment.get("submissions", []) if s.get("email", "").lower() == email), {})
                extensions[email] = {"until": iso(now + timedelta(days=days)), "grantedAt": iso(now),
                                     "fileAttemptLimit": int(sub.get("fileSubmissionCount", 0)) + 1,
                                     "quizAttemptLimit": int(sub.get("quizSubmissionCount", 0)) + 1}
            else:
                extensions.pop(email, None)
            if not eagle._save_assignment(assignment):
                return jsonify(ok=False, error="Could not save extension"), 500
        eagle.socketio.emit("assignment_workflow_updated", {"classId": assignment.get("targetClassId")}, to=f"class_{assignment.get('targetClassId')}")
        return jsonify(ok=True, extension=extensions.get(email))

    @app.post("/api/quiz/score-question")
    def score_question():
        return override_score(eagle)

    def resolve():
        assignment = eagle._load_assignment(str(request.args.get("assignmentId") or ""))
        if not assignment:
            return None, None, None, (jsonify(ok=False, error="Assignment not found"), 404)
        actor = eagle._assignment_actor(request)
        user = eagle._require_user(request)
        if actor:
            if not eagle._assignment_access(actor, assignment):
                return None, None, None, (jsonify(ok=False, error="Assignment access denied"), 403)
            email = str(request.args.get("studentEmail") or "").lower()
        elif user:
            email = str(user.get("email") or "").lower()
            if request.args.get("studentEmail", email).lower() != email or not eagle._user_in_class(eagle._find_user(email) or user, assignment.get("targetClassId")):
                return None, None, None, (jsonify(ok=False, error="Submission access denied"), 403)
        else:
            return None, None, None, (jsonify(ok=False, error="Authentication required"), 401)
        submission = next((s for s in assignment.get("submissions", []) if str(s.get("email") or "").lower() == email), None)
        if not submission:
            return None, None, None, (jsonify(ok=False, error="Submission not found"), 404)
        revision = str(request.args.get("revisionId") or "")
        if revision and revision != submission.get("revisionId"):
            if not actor:
                return None, None, None, (jsonify(ok=False, error="Submission history is teacher-only"), 403)
            submission = next((s for s in submission.get("history", []) if s.get("revisionId") == revision), None)
            if not submission:
                return None, None, None, (jsonify(ok=False, error="Submission version not found"), 404)
        return assignment, submission, actor, None

    @app.get("/api/assignments/submission-files")
    def submission_files():
        assignment, sub, actor, error = resolve()
        if error:
            return error
        latest = next(s for s in assignment["submissions"] if str(s.get("email") or "").lower() == str(sub.get("email") or "").lower())
        history = [{"revisionId": s.get("revisionId"), "submittedAt": s.get("submittedAt"), "files": public_files(s)} for s in latest.get("history", [])] if actor else []
        return jsonify(ok=True, files=public_files(sub), revisionId=sub.get("revisionId"), submittedAt=sub.get("submittedAt"), history=history,
                       latestRevisionId=latest.get("revisionId"), quizResponses=sub.get("quizResponses", []) if actor else [{"questionId": r.get("questionId"), "answer": r.get("answer")} for r in sub.get("quizResponses", [])])

    @app.get("/api/assignments/submission-file")
    def submission_file():
        assignment, sub, actor, error = resolve()
        if error:
            return error
        record = next((f for f in files_for(sub) if f.get("id") == request.args.get("fileId")), None)
        target = eagle._assignment_submission_path(assignment, (record or {}).get("path") or "")
        if not record or not target or not target.is_file():
            return jsonify(ok=False, error="Submission file not found"), 404
        name = record["name"]
        suffix = Path(name).suffix.lower()
        if request.args.get("download") == "1":
            response = send_file(target, mimetype="application/octet-stream", as_attachment=True, download_name=name, conditional=False)
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Cache-Control"] = "no-store"
            return response
        try:
            if suffix == ".csv":
                from workspace_data import records, PAGE_ROWS, PAGE_COLUMNS
                cursor = int(request.args.get("cursor", 0))
                with target.open("r", encoding="utf-8-sig", newline="") as handle:
                    _, header = next(records(handle), (0, []))
                    first = handle.tell()
                    if cursor and not first <= cursor <= target.stat().st_size:
                        raise ValueError("Invalid CSV page")
                    handle.seek(cursor or first)
                    rows, chars = [], 0
                    for _, row in records(handle):
                        cells = row[:PAGE_COLUMNS]
                        rows.append(cells)
                        chars += sum(len(c) for c in cells)
                        if len(rows) >= PAGE_ROWS or chars >= 512 * 1024:
                            break
                    next_cursor = handle.tell()
                    more = bool(handle.read(1))
                return jsonify(ok=True, kind="csv", header=header[:PAGE_COLUMNS], rows=rows, nextCursor=next_cursor if more else None)
            if suffix in IMAGE_EXTENSIONS and target.stat().st_size <= MAX_PREVIEW_BYTES:
                from PIL import Image
                with Image.open(target) as image:
                    width, height = image.size
                    image.verify()
                if width > 16384 or height > 16384 or width * height > 25000000:
                    raise ValueError("Image exceeds the preview dimensions")
                return jsonify(ok=True, kind="image")
            if target.stat().st_size <= MAX_PREVIEW_BYTES:
                content = target.read_text(encoding="utf-8")
                if "\x00" not in content:
                    return jsonify(ok=True, kind="text", content=content, **({"pasteRanges": record.get("pasteRanges", [])} if actor else {}))
        except (UnicodeError, ValueError, OSError, csv.Error):
            pass
        return jsonify(ok=True, kind="download", message="Download this attachment to open it. The browser preview supports text, CSV, and images.")

    @app.post("/api/assignments/feedback")
    def feedback():
        actor = eagle._assignment_actor(request)
        if not actor:
            return jsonify(ok=False, error="Teacher authentication required"), 401
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify(ok=False, error="Invalid feedback request"), 400
        value = data.get("feedback", "")
        if not isinstance(value, str) or len(value) > eagle.MAX_ASSIGNMENT_RUBRIC_CHARS:
            return jsonify(ok=False, error="Feedback must be text of at most 12,000 characters"), 400
        with eagle._assignment_lock:
            assignment = eagle._load_assignment(data.get("assignmentId") or "")
            if not assignment or not eagle._assignment_access(actor, assignment):
                return jsonify(ok=False, error="Assignment access denied"), 403
            sub = next((s for s in assignment.get("submissions", []) if s.get("email") == str(data.get("studentEmail") or "").lower()), None)
            if not sub:
                return jsonify(ok=False, error="Submission not found"), 404
            if data.get("revisionId") and data["revisionId"] != sub.get("revisionId"):
                return jsonify(ok=False, error="The student submitted a newer version. Reopen feedback before saving."), 409
            sub["teacherFeedback"] = eagle._sanitize_ai_feedback_text(value)
            sub["teacherFeedbackEdited"] = True
            if not eagle._save_assignment(assignment):
                return jsonify(ok=False, error="Could not save feedback"), 500
        return jsonify(ok=True)

    @app.post("/api/assignments/unsubmit")
    def unsubmit():
        actor = eagle._assignment_actor(request)
        if not actor:
            return jsonify(ok=False, error="Teacher authentication required"), 401
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify(ok=False, error="Invalid un-submit request"), 400
        with eagle._assignment_lock:
            assignment = eagle._load_assignment(data.get("assignmentId") or "")
            if not assignment or not eagle._assignment_access(actor, assignment, owner_only=True):
                return jsonify(ok=False, error="Only the class teacher may un-submit work"), 403
            sub = next((s for s in assignment.get("submissions", []) if s.get("email") == str(data.get("studentEmail") or "").lower()), None)
            if not sub or sub.get("withdrawn"):
                return jsonify(ok=False, error="No submitted work to un-submit"), 409
            if data.get("revisionId") and data["revisionId"] != sub.get("revisionId"):
                return jsonify(ok=False, error="A newer submission arrived. Refresh before un-submitting."), 409
            sub["withdrawn"] = True
            sub["fileSubmissionCount"] = max(0, int(sub.get("fileSubmissionCount", 1)) - 1)
            sub["quizSubmissionCount"] = max(0, int(sub.get("quizSubmissionCount", 0)) - 1)
            sub["aiGradingStatus"] = "canceled"
            if not eagle._save_assignment(assignment):
                return jsonify(ok=False, error="Could not un-submit work"), 500
        eagle.socketio.emit("assignment_workflow_updated", {"classId": assignment.get("targetClassId")}, to=f"class_{assignment.get('targetClassId')}")
        return jsonify(ok=True)

    def update_class(class_id, *, support):
        teacher = eagle._require_teacher(request)
        if not teacher:
            return jsonify(ok=False, error="Class teacher authentication required"), 401
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify(ok=False, error="Invalid class setting request"), 400
        try:
            value = accommodation(data.get("accommodations"), strict=True) if support else window_settings(data.get("window"), strict=True)
            zone = window_settings({"timeZone": data["timeZone"]}, strict=True)["timeZone"] if support and "timeZone" in data else None
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        with eagle._classes_lock:
            catalog = eagle._load_classes()
            cls = next((c for c in catalog["classes"] if c["id"] == class_id and c["teacher_email"] == teacher["email"].lower()), None)
            if not cls:
                return jsonify(ok=False, error="Class not found"), 404
            if support:
                email = str(data.get("studentEmail") or "").lower()
                if email not in cls["students"]:
                    return jsonify(ok=False, error="Student is not in this class"), 404
                cls.setdefault("accommodations", {})[email] = value
                if zone:
                    settings = cls.setdefault("settings", {})
                    settings["assignment_submission_window"] = {**window_settings(settings.get("assignment_submission_window")), "timeZone": zone}
            else:
                cls.setdefault("settings", {})["assignment_submission_window"] = value
            eagle._save_classes(catalog)
        eagle.socketio.emit("assignment_workflow_updated", {"classId": class_id}, to=f"class_{class_id}")
        return jsonify(ok=True)

    @app.post("/api/teacher/classes/<class_id>/accommodations")
    def update_accommodations(class_id):
        return update_class(class_id, support=True)

    @app.post("/api/teacher/classes/<class_id>/submission-window")
    def update_window(class_id):
        return update_class(class_id, support=False)
