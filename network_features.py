"""Flask routes for the optional EagleIDE network simulator.

This module has no dependency on IDE runners, sockets, or wiki persistence.  The
host application supplies only its existing authentication/class callbacks.
"""

from __future__ import annotations

import copy

from flask import jsonify, request

from network_content import ACRONYM_REFERENCE, COMMAND_REFERENCE, EXAMPLE_TOPOLOGIES, LABS, PORT_REFERENCE, example_summaries, lab_summary
from network_store import NetworkDataError, NetworkStore, grade_lab, validate_topology


def register(
    app,
    *,
    base_dir,
    require_admin,
    require_teacher,
    require_user,
    find_user,
    get_user_class_ids,
    find_class,
    config_provider,
):
    store = NetworkStore(base_dir)

    def actor():
        if require_admin(request):
            return {"role": "admin", "email": "__admin__", "record": None}
        teacher = require_teacher(request)
        if teacher:
            return {"role": "teacher", "email": str(teacher.get("email") or "").strip().lower(), "record": teacher}
        user = require_user(request)
        if user:
            fresh = find_user(str(user.get("email") or "")) or user
            return {"role": "student", "email": str(fresh.get("email") or "").strip().lower(), "record": fresh}
        return {"role": "guest", "email": "", "record": None}

    def globally_enabled():
        return bool((config_provider() or {}).get("network_sim_enabled", False))

    def json_object():
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else None

    def student_enabled(current):
        return any(store.class_access(class_id) for class_id in get_user_class_ids(current.get("record")))

    def may_open(current):
        if current["role"] == "admin":
            return True
        if not globally_enabled():
            return False
        if current["role"] == "student":
            return student_enabled(current)
        return True

    def teacher_class(class_id):
        teacher = require_teacher(request)
        if not teacher:
            return None, (jsonify(ok=False, error="Teacher token required"), 401)
        classroom = find_class(str(class_id))
        if not classroom:
            return None, (jsonify(ok=False, error="Class not found"), 404)
        email = str(teacher.get("email") or "").strip().lower()
        if str(classroom.get("teacher_email") or "").strip().lower() != email:
            return None, (jsonify(ok=False, error="You do not own this class"), 403)
        return (teacher, classroom), None

    def student_lab_access(current, class_id, lab_id):
        if current["role"] != "student":
            return False
        class_id = str(class_id or "")
        if class_id not in get_user_class_ids(current.get("record")) or not store.class_access(class_id):
            return False
        return lab_id in {item.get("lab_id") for item in store.assignments_for_class(class_id)}

    @app.get("/api/network/bootstrap")
    def network_bootstrap():
        current = actor()
        if not may_open(current):
            message = "Network Simulator is disabled for your class" if current["role"] == "student" and globally_enabled() else "Network Simulator is disabled"
            return jsonify(ok=False, error=message, enabled=False), 403
        class_ids = get_user_class_ids(current.get("record")) if current["role"] == "student" else []
        assigned = []
        if current["role"] == "student":
            for class_id in class_ids:
                if not store.class_access(class_id):
                    continue
                classroom = find_class(class_id) or {}
                for assignment in store.assignments_for_class(class_id):
                    lab = LABS.get(assignment.get("lab_id"))
                    if lab:
                        assigned.append({
                            **lab_summary(lab),
                            "class_id": class_id,
                            "class_name": classroom.get("name") or "Class",
                            "assigned_at": assignment.get("assigned_at"),
                        })
        saved = [] if current["role"] == "guest" else store.list_topologies(current["email"])
        return jsonify(
            ok=True,
            data={
                "enabled": globally_enabled(),
                "admin_preview": current["role"] == "admin" and not globally_enabled(),
                "role": current["role"],
                "can_save": current["role"] != "guest",
                "examples": example_summaries(),
                "assigned_labs": assigned,
                "saved": saved,
                "command_reference": COMMAND_REFERENCE,
                "port_reference": PORT_REFERENCE,
                "acronym_reference": ACRONYM_REFERENCE,
                "limits": {"devices": 100, "links": 200, "saved": 40, "topology_bytes": 512000},
            },
        )

    @app.get("/api/network/examples/<example_id>")
    def network_example(example_id):
        current = actor()
        if not may_open(current):
            return jsonify(ok=False, error="Network Simulator is disabled"), 403
        topology = EXAMPLE_TOPOLOGIES.get(str(example_id))
        if not topology:
            return jsonify(ok=False, error="Example not found"), 404
        return jsonify(ok=True, data=copy.deepcopy(topology))

    @app.get("/api/network/labs/<lab_id>")
    def network_lab(lab_id):
        current = actor()
        lab = LABS.get(str(lab_id))
        if not lab:
            return jsonify(ok=False, error="Lab not found"), 404
        if not may_open(current):
            return jsonify(ok=False, error="Network Simulator is disabled"), 403
        class_id = str(request.args.get("class_id") or "")
        include_solution = current["role"] == "admin"
        if current["role"] == "teacher":
            owned, error = teacher_class(class_id)
            if error:
                return error
            include_solution = bool(owned)
        elif current["role"] == "student":
            if not student_lab_access(current, class_id, lab_id):
                return jsonify(ok=False, error="This lab is not assigned to you"), 403
        elif current["role"] == "guest":
            return jsonify(ok=False, error="Sign in to open assigned labs"), 401
        payload = lab_summary(lab, include_solution=include_solution)
        payload["starter_topology"] = copy.deepcopy(lab["starter_topology"])
        return jsonify(ok=True, data=payload)

    @app.get("/api/network/topologies")
    def network_topology_list():
        current = actor()
        if current["role"] == "guest":
            return jsonify(ok=False, error="Sign in to save networks"), 401
        if not may_open(current):
            return jsonify(ok=False, error="Network Simulator is disabled"), 403
        return jsonify(ok=True, data=store.list_topologies(current["email"]))

    @app.get("/api/network/topologies/<topology_id>")
    def network_topology_get(topology_id):
        current = actor()
        if current["role"] == "guest":
            return jsonify(ok=False, error="Sign in to open saved networks"), 401
        if not may_open(current):
            return jsonify(ok=False, error="Network Simulator is disabled"), 403
        topology = store.get_topology(current["email"], topology_id)
        if not topology:
            return jsonify(ok=False, error="Saved network not found"), 404
        return jsonify(ok=True, data=topology)

    @app.put("/api/network/topologies/<topology_id>")
    def network_topology_put(topology_id):
        current = actor()
        if current["role"] == "guest":
            return jsonify(ok=False, error="Guests cannot save networks"), 401
        if not may_open(current):
            return jsonify(ok=False, error="Network Simulator is disabled"), 403
        payload = json_object()
        if payload is None:
            return jsonify(ok=False, error="A JSON object is required"), 400
        try:
            topology = store.save_topology(current["email"], payload.get("topology"), topology_id)
        except NetworkDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        return jsonify(ok=True, data=topology)

    @app.delete("/api/network/topologies/<topology_id>")
    def network_topology_delete(topology_id):
        current = actor()
        if current["role"] == "guest":
            return jsonify(ok=False, error="Sign in to manage saved networks"), 401
        if not may_open(current):
            return jsonify(ok=False, error="Network Simulator is disabled"), 403
        try:
            deleted = store.delete_topology(current["email"], topology_id)
        except NetworkDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        if not deleted:
            return jsonify(ok=False, error="Saved network not found"), 404
        return jsonify(ok=True)

    @app.get("/api/network/student/labs/<class_id>/<lab_id>")
    def network_student_lab_progress_get(class_id, lab_id):
        current = actor()
        if not may_open(current) or not student_lab_access(current, class_id, lab_id):
            return jsonify(ok=False, error="This lab is not assigned to you"), 403
        lab = LABS.get(lab_id)
        if not lab:
            return jsonify(ok=False, error="Lab not found"), 404
        progress = store.get_progress(current["email"], class_id, lab_id)
        if not progress:
            topology = copy.deepcopy(lab["starter_topology"])
            progress = {"class_id": class_id, "lab_id": lab_id, "student_email": current["email"], "topology": topology, "grade": grade_lab(lab_id, topology), "updated_at": None}
        return jsonify(ok=True, data=progress)

    @app.put("/api/network/student/labs/<class_id>/<lab_id>")
    def network_student_lab_progress_put(class_id, lab_id):
        current = actor()
        if not may_open(current) or not student_lab_access(current, class_id, lab_id):
            return jsonify(ok=False, error="This lab is not assigned to you"), 403
        payload = json_object()
        if payload is None:
            return jsonify(ok=False, error="A JSON object is required"), 400
        try:
            progress = store.save_progress(current["email"], class_id, lab_id, payload.get("topology"))
        except NetworkDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        return jsonify(ok=True, data=progress)

    @app.get("/api/network/teacher/classes/<class_id>")
    def network_teacher_class_get(class_id):
        owned, error = teacher_class(class_id)
        if error:
            return error
        teacher, classroom = owned
        assignments = {item.get("lab_id"): item for item in store.assignments_for_class(class_id)}
        roster = []
        for raw_email in classroom.get("students", []):
            email = str(raw_email or "").strip().lower()
            if not email:
                continue
            user = find_user(email) or {}
            roster.append({"email": email, "name": user.get("name") or email})
        roster.sort(key=lambda item: (str(item.get("name") or "").lower(), item["email"]))
        progress_lookup = {
            (str(item.get("lab_id") or ""), str(item.get("student_email") or "").strip().lower()): item
            for item in store.class_progress(class_id)
            if isinstance(item, dict)
        }
        labs = []
        for lab in LABS.values():
            item = lab_summary(lab, include_solution=True)
            item["assigned"] = lab["id"] in assignments
            student_results = []
            for student in roster:
                saved = progress_lookup.get((lab["id"], student["email"]))
                grade = (saved or {}).get("grade") or {}
                passed = bool(grade.get("passed"))
                percent = max(0, min(100, int(grade.get("percent", 0) or 0))) if saved else 0
                student_results.append({
                    **student,
                    "status": "completed" if passed else ("in_progress" if saved else "not_started"),
                    "completed": passed,
                    "percent": percent,
                    "score": percent,
                    "objectives_completed": int(grade.get("completed", 0) or 0),
                    "objectives_total": int(grade.get("total", len(lab.get("objectives", []))) or 0),
                    "updated_at": (saved or {}).get("updated_at"),
                })
            started_rows = [result for result in student_results if result["status"] != "not_started"]
            passed_rows = [result for result in student_results if result["completed"]]
            item["progress"] = {
                "started": len(started_rows),
                "passed": len(passed_rows),
                "average_percent": round(sum(result["percent"] for result in started_rows) / len(started_rows)) if started_rows else 0,
                "students": student_results,
                "roster_count": len(roster),
            }
            labs.append(item)
        return jsonify(ok=True, data={"class_id": class_id, "class_name": classroom.get("name"), "enabled": store.class_access(class_id), "labs": labs})

    @app.put("/api/network/teacher/classes/<class_id>/access")
    def network_teacher_class_access_put(class_id):
        owned, error = teacher_class(class_id)
        if error:
            return error
        data = json_object()
        if data is None:
            return jsonify(ok=False, error="A JSON object is required"), 400
        enabled = store.set_class_access(class_id, bool(data.get("enabled")))
        return jsonify(ok=True, data={"class_id": class_id, "enabled": enabled})

    @app.put("/api/network/teacher/classes/<class_id>/labs/<lab_id>")
    def network_teacher_lab_assign(class_id, lab_id):
        owned, error = teacher_class(class_id)
        if error:
            return error
        teacher, _ = owned
        try:
            assignment = store.assign_lab(class_id, lab_id, teacher.get("email"))
        except NetworkDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        return jsonify(ok=True, data=assignment)

    @app.delete("/api/network/teacher/classes/<class_id>/labs/<lab_id>")
    def network_teacher_lab_unassign(class_id, lab_id):
        owned, error = teacher_class(class_id)
        if error:
            return error
        store.unassign_lab(class_id, lab_id)
        return jsonify(ok=True)

    # Exposed for focused tests and operational diagnostics; not used by app.py.
    app.extensions["network_store"] = store
