"""Private annotation threads and bounded UTF-16 anchors for editor files."""
from bisect import bisect_left, bisect_right
from difflib import SequenceMatcher
import json
from uuid import uuid4

from flask import jsonify, request

import file_provenance as provenance
from classroom_features import _verify_teacher_class_student
from security_controls import AttemptLimiter

MAX_THREADS = 40
MAX_MESSAGES = 30
MAX_BODY = 1000
MAX_TOTAL = 24000
MAX_EDITS = 256
_mutations = AttemptLimiter(45, 60)


class AnnotationError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def request_data():
    if (request.content_length or 0) > 8192:
        raise AnnotationError("Annotation request is too large", 413)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise AnnotationError("Invalid annotation request")
    return data


def response(threads, **metadata):
    result = jsonify(ok=True, annotations=threads, **metadata)
    result.headers["Cache-Control"] = "private, no-store"
    return result


def author(user, *, mentor=False):
    return {"name": str(user.get("name") or "User")[:120], "mentor": mentor}


def mutate(threads, data, person, actor, source=None):
    action = data.get("action")
    if not _mutations.admit(actor):
        raise AnnotationError("Too many annotation changes. Try again shortly.", 429)
    if action in ("add", "reply"):
        body = data.get("body")
        body = body.strip() if isinstance(body, str) else ""
        try:
            size = len(body.encode("utf-8"))
        except UnicodeError:
            size = 0
        if not size or len(body) > MAX_BODY:
            raise AnnotationError(f"Enter a message of up to {MAX_BODY} characters")
        if sum(len(m["body"]) for t in threads for m in t["messages"]) + len(body) > MAX_TOTAL:
            raise AnnotationError("Close some messages before adding more", 409)
        message = {"id": uuid4().hex, "body": body, "author": person}
    if action == "add":
        if len(threads) >= MAX_THREADS:
            raise AnnotationError("Close an annotation before adding another", 409)
        start, end = data.get("start"), data.get("end")
        if not isinstance(source, str) or type(start) is not int or type(end) is not int:
            raise AnnotationError("Select text before adding an annotation")
        encoded = source.encode("utf-16-le")
        if (not 0 <= start < end <= len(encoded) // 2 or any(
                offset * 2 < len(encoded) and 0xDC <= encoded[offset * 2 + 1] <= 0xDF for offset in (start, end))):
            raise AnnotationError("Select a valid range of text")
        thread = {"id": uuid4().hex, "start": start, "end": end, "author": person, "messages": [message]}
        threads.append(thread)
        return thread["id"]
    thread = next((t for t in threads if t["id"] == data.get("threadId")), None)
    if not thread:
        raise AnnotationError("This annotation has closed", 404)
    if action == "close":
        threads.remove(thread)
    elif action == "reply":
        if len(thread["messages"]) >= MAX_MESSAGES:
            raise AnnotationError("Close a message before adding another reply", 409)
        thread["messages"].append(message)
    elif action == "closeMessage":
        remaining = [m for m in thread["messages"] if m["id"] != data.get("messageId")]
        if len(remaining) == len(thread["messages"]):
            raise AnnotationError("This message has already closed", 404)
        if remaining:
            thread["messages"] = remaining
        else:
            threads.remove(thread)
    else:
        raise AnnotationError("Unknown annotation action")
    return thread["id"]


def remap(threads, segments):
    """Retain the first and last surviving character of each anchor."""
    segments = [(a, b, shift) for a, b, shift in segments if a < b]
    starts = [a for a, _, _ in segments]
    ends = [b for _, b, _ in segments]
    result = []
    for thread in threads:
        start, end = thread["start"], thread["end"]
        first, last = bisect_right(ends, start), bisect_left(starts, end) - 1
        if first <= last:
            a, _, before = segments[first]
            _, b, after = segments[last]
            result.append({**thread, "start": max(a, start) + before, "end": min(b, end) + after})
    return result


def remap_group(threads, parts):
    if not threads:
        return []
    offset = shift = 0
    segments = []
    for part in parts:
        if isinstance(part, str):
            shift += provenance.length(part)
        elif part > 0:
            segments.append((offset, offset + part, shift))
            offset += part
        else:
            offset -= part
            shift += part
    return remap(threads, segments)


def remap_workspace(threads, old, new, edits=None):
    if isinstance(edits, list) and len(edits) <= MAX_EDITS:
        length = provenance.length(old)
        mapped = threads
        for edit in edits:
            if not isinstance(edit, list) or len(edit) != 3 or any(type(n) is not int for n in edit):
                break
            start, end, inserted = edit
            if not 0 <= start <= end <= length or not 0 <= inserted <= 20_000_000:
                break
            shift = inserted - (end - start)
            mapped = remap(mapped, [(0, start, 0), (end, length, shift)])
            length += shift
        else:
            if length == provenance.length(new) and (edits or old == new):
                return mapped
    if old == new:
        return threads
    # Files changed outside CodeMirror have no edit journal. Compare only a
    # bounded middle after discarding the common prefix and suffix.
    m, n = len(old), len(new)
    if not m or not n:
        return []
    prefix = 0
    while prefix < min(m, n) and old[prefix] == new[prefix]:
        prefix += 1
    suffix = 0
    while suffix < min(m, n) - prefix and old[m-suffix-1] == new[n-suffix-1]:
        suffix += 1
    offset = provenance.length(old[:prefix])
    segments = [(0, offset, 0)]
    if max(m, n) - prefix - suffix <= 4000:
        left, right = old[prefix:m-suffix], new[prefix:n-suffix]
        for i, j, size in SequenceMatcher(None, left, right).get_matching_blocks():
            if size:
                a, b = provenance.length(left[:i]), provenance.length(right[:j])
                segments.append((offset + a, offset + a + provenance.length(left[i:i+size]), b - a))
    before, after = provenance.length(old), provenance.length(new)
    segments.append((before - provenance.length(old[m-suffix:]), before, after - before))
    return remap(threads, segments)


def workspace_save(eagle, workspace, target, content, data):
    record = provenance.record(eagle, workspace, target)
    threads = record.get("annotations", [])
    if not threads or not target.is_file():
        return []
    try:
        old = target.read_text(encoding="utf-8")
    except UnicodeError:
        return []
    digest = provenance.digest(old)
    if digest != record.get("sha256"):
        return []
    edits = data.get("annotationEdits") if digest == data.get("annotationBase") else None
    return remap_workspace(threads, old, content.replace("\r\n", "\n").replace("\r", "\n"), edits)


def register(app, eagle):
    @app.errorhandler(AnnotationError)
    def annotation_error(error):
        return jsonify(ok=False, error=str(error)), error.status

    def workspace_annotations(actor, owner, *, mentor=False):
        path = request.args.get("path", "")
        workspace = eagle._get_user_dir(owner)
        with provenance.lock(workspace):
            target = eagle._validate_user_path(workspace, path)
            if (not target or not target.is_file() or eagle._is_trash_path(workspace, target) or
                    target.suffix.lower() not in eagle.TEXT_EXTENSIONS - {".csv"}):
                raise AnnotationError("Open a workspace text file", 404)
            record = provenance.record(eagle, workspace, target)
            threads = record.get("annotations", [])
            digest = record.get("sha256")
            if request.method == "GET":
                return response(threads, digest=digest)
            data = request_data()
            if target.stat().st_size > eagle.MAX_EDITOR_FILE_BYTES:
                raise AnnotationError("The file exceeds the editor limit", 413)
            try:
                source = target.read_text(encoding="utf-8")
            except UnicodeError as exc:
                raise AnnotationError("Open a workspace text file", 415) from exc
            current = provenance.digest(source)
            if current != digest:
                threads = []
            if data.get("action") == "add" and data.get("digest") != current:
                raise AnnotationError("The saved file changed. Reopen it before annotating.", 409)
            thread_id = mutate(threads, data, author(actor, mentor=mentor), actor["email"], source)
            ranges = record.get("ranges", []) if digest == current else []
            provenance.write(eagle, workspace, target, source, ranges, annotations=threads)
            return response(threads, digest=current, threadId=thread_id)

    @app.route("/api/files/annotations", methods=["GET", "POST"])
    def own_annotations():
        actor = eagle._require_user_for_files(request)
        if not actor:
            raise AnnotationError("Sign in to use annotations", 401)
        return workspace_annotations(actor, actor["email"])

    @app.route("/api/teacher/students/files/annotations", methods=["GET", "POST"])
    def audit_annotations():
        actor = eagle._require_teacher(request)
        owner = request.args.get("studentEmail", "").strip().lower()
        if not actor:
            raise AnnotationError("Teacher sign-in required", 401)
        allowed, _ = _verify_teacher_class_student(actor["email"], request.args.get("classId", ""), owner)
        if not allowed:
            raise AnnotationError("Student not in class", 403)
        return workspace_annotations(actor, owner, mentor=True)


def group_read(db, file_id):
    return [{**json.loads(row["discussion"]), "id":row["id"], "start":row["start"], "end":row["end"]}
            for row in db.execute("SELECT id,start,end,discussion FROM annotations WHERE file=? ORDER BY rowid", (file_id,))]


def group_write(db, file_id, threads, thread_id):
    thread = next((item for item in threads if item["id"] == thread_id), None)
    if thread:
        discussion = json.dumps({key:thread[key] for key in ("author", "messages")}, ensure_ascii=False)
        db.execute("""INSERT INTO annotations(file,id,start,end,discussion) VALUES (?,?,?,?,?)
                      ON CONFLICT(file,id) DO UPDATE SET discussion=excluded.discussion""",
                   (file_id, thread_id, thread["start"], thread["end"], discussion))
    else:
        db.execute("DELETE FROM annotations WHERE file=? AND id=?", (file_id, thread_id))


def group_move(db, file_id, parts):
    # Editing code never loads or rewrites message text.
    before = [dict(row) for row in db.execute("SELECT id,start,end FROM annotations WHERE file=?", (file_id,))]
    if not before:
        return False
    after = {thread["id"]:thread for thread in remap_group(before, parts)}
    closed = False
    for previous in before:
        thread = after.get(previous["id"])
        if thread is None:
            db.execute("DELETE FROM annotations WHERE file=? AND id=?", (file_id, previous["id"]))
            closed = True
        elif thread != previous:
            db.execute("UPDATE annotations SET start=?,end=? WHERE file=? AND id=?",
                       (thread["start"], thread["end"], file_id, thread["id"]))
    return closed
