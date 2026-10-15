"""Teacher-only class assignment folders. Names never become filesystem paths."""
from __future__ import annotations

import hashlib
import json
import re
import uuid

from flask import jsonify, request

MAX_FOLDERS = 100
MAX_NAME = 80
ID = re.compile(r"[a-f0-9]{32}")


def _path(eagle, class_id):
    key = hashlib.sha256(class_id.encode("utf-8")).hexdigest()
    return eagle.ASSIGNMENTS_DIR / ".organization" / f"{key}.json"


def _read(eagle, class_id):
    path = _path(eagle, class_id)
    if not path.exists():
        return {"classId": class_id, "folders": [], "assignments": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("classId") != class_id:
        raise ValueError("Invalid folder catalog")
    folders, assignments = data.get("folders"), data.get("assignments")
    if not isinstance(folders, list) or not isinstance(assignments, dict) or len(folders) > MAX_FOLDERS:
        raise ValueError("Invalid folder catalog")
    ids = set()
    for folder in folders:
        if not isinstance(folder, dict) or not isinstance(folder.get("id"), str) or not ID.fullmatch(folder["id"]) or folder["id"] in ids:
            raise ValueError("Invalid folder catalog")
        if _name(folder.get("name")) != folder["name"]:
            raise ValueError("Invalid folder name")
        ids.add(folder["id"])
    if any(not isinstance(key, str) or not ID.fullmatch(key) or value not in ids for key, value in assignments.items()):
        raise ValueError("Invalid assignment folders")
    return {"classId": class_id, "folders": folders, "assignments": assignments}


def _name(value):
    if not isinstance(value, str) or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Enter a folder name of 1–80 characters")
    name = " ".join(value.split())
    if not name or len(name) > MAX_NAME:
        raise ValueError("Enter a folder name of 1–80 characters")
    return name


def forget_assignment(eagle, assignment):
    """Called under the assignment lock when an assignment is deleted."""
    class_id = str(assignment.get("targetClassId") or "")
    data = _read(eagle, class_id)
    if data["assignments"].pop(assignment["id"], None):
        eagle._write_json_file_atomic(_path(eagle, class_id), data)


def delete_class(eagle, class_id):
    """Called under the assignment lock after class assignment storage cleanup."""
    _path(eagle, class_id).unlink(missing_ok=True)


def register(app, eagle):
    @app.route("/api/assignments/folders", methods=["GET", "POST"])
    def assignment_folders():
        data = request.args if request.method == "GET" else request.get_json(silent=True)
        if data is None or not hasattr(data, "get") or (request.method == "POST" and not isinstance(data, dict)):
            return jsonify(ok=False, error="Invalid request"), 400
        actor = eagle._assignment_actor(request)
        if not actor:
            return jsonify(ok=False, error="Teacher authentication required"), 401
        class_id = data.get("classId")
        if not isinstance(class_id, str) or not class_id.strip():
            return jsonify(ok=False, error="classId is required"), 400
        class_id = class_id.strip()
        with eagle._assignment_lock:
            cls = eagle._find_class_by_id(class_id)
            owner = bool(cls and not actor.get("is_coteacher") and str(cls.get("teacher_email") or "").lower() == actor["email"])
            if not cls or not (owner or (actor.get("is_coteacher") and eagle._is_coteacher(actor["email"], cls))):
                return jsonify(ok=False, error="Class unavailable"), 403
            if request.method == "POST" and not owner:
                return jsonify(ok=False, error="Class owner required to organize assignments"), 403
            try:
                catalog = _read(eagle, class_id)
            except (OSError, ValueError, TypeError):
                return jsonify(ok=False, error="Assignment folders could not be loaded. No organization changes were made."), 503
            if request.method == "POST":
                action = data.get("action")
                if not isinstance(action, str):
                    return jsonify(ok=False, error="Invalid folder action"), 400
                folder_id = data.get("folderId", "")
                if not isinstance(folder_id, str):
                    return jsonify(ok=False, error="Invalid folder"), 400
                folder = next((f for f in catalog["folders"] if f["id"] == folder_id), None)
                if action in {"create", "rename"}:
                    try:
                        name = _name(data.get("name"))
                    except ValueError as exc:
                        return jsonify(ok=False, error=str(exc)), 400
                    if any(f["name"].casefold() == name.casefold() and (action == "create" or f["id"] != folder_id) for f in catalog["folders"]):
                        return jsonify(ok=False, error="A folder with this name already exists"), 409
                    if action == "create":
                        if len(catalog["folders"]) >= MAX_FOLDERS:
                            return jsonify(ok=False, error="This class already has 100 assignment folders"), 400
                        catalog["folders"].append({"id": uuid.uuid4().hex, "name": name})
                    elif folder:
                        folder["name"] = name
                    else:
                        return jsonify(ok=False, error="Folder not found"), 404
                elif action == "delete":
                    if not folder:
                        return jsonify(ok=False, error="Folder not found"), 404
                    catalog["folders"].remove(folder)
                    catalog["assignments"] = {key: value for key, value in catalog["assignments"].items() if value != folder_id}
                elif action == "move":
                    assignment_id = data.get("assignmentId")
                    if not isinstance(assignment_id, str) or not ID.fullmatch(assignment_id):
                        return jsonify(ok=False, error="Invalid assignment ID"), 400
                    assignment = eagle._load_assignment(assignment_id)
                    if not assignment or assignment.get("targetClassId") != class_id or not eagle._assignment_access(actor, assignment, owner_only=True):
                        return jsonify(ok=False, error="Assignment unavailable in this class"), 403
                    if folder_id and not folder:
                        return jsonify(ok=False, error="Folder not found"), 404
                    if folder_id:
                        catalog["assignments"][assignment_id] = folder_id
                    else:
                        catalog["assignments"].pop(assignment_id, None)
                else:
                    return jsonify(ok=False, error="Invalid folder action"), 400
                try:
                    eagle._write_json_file_atomic(_path(eagle, class_id), catalog)
                except OSError:
                    return jsonify(ok=False, error="Could not save assignment folders"), 503
            return jsonify(ok=True, **catalog, canOrganize=owner)
