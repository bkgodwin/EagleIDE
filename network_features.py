"""Flask routes for the optional EagleIDE network simulator.

This module has no dependency on IDE runners, sockets, or wiki persistence.  The
host application supplies only its existing authentication/class callbacks.
"""

from __future__ import annotations

import copy
import io

from flask import jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge

from network_content import ACRONYM_REFERENCE, COMMAND_REFERENCE, EXAMPLE_TOPOLOGIES, LABS, PORT_REFERENCE, example_summaries, lab_summary
from network_store import (MAX_WIFI_SITE_BYTES, WIFI_LIMITS, WIFI_SCHEMA_VERSION, validate_wifi_site, NetworkDataError, NetworkStore, WifiAccessError,
                           WifiRevisionError, WifiStorageError, grade_lab, validate_topology)
import wifi_starter_labs as starter
from wifi_cabling import CABLING_CATALOG
from wifi_scenarios import SCENARIOS, scenario_briefing, scenario_summary
from wifi_site_pdf import MAX_EXPORT_BYTES, render_plan_pdf
from wifi_site_network import SERVER_SERVICES
from wifi_lab_features import register as register_guided_labs


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
    require_wiki_manager=lambda req: None,
    get_teacher_classes=lambda email: [],
):
    store = NetworkStore(base_dir)

    def actor():
        if require_admin(request):
            return {"role": "admin", "email": "__admin__", "record": None}
        manager = require_wiki_manager(request)
        if manager:
            return {"role": "wiki_manager", "email": manager["email"], "record": manager}
        teacher = require_teacher(request)
        if teacher:
            return {"role": "teacher", "email": str(teacher.get("email") or "").strip().lower(), "record": teacher}
        user = require_user(request)
        if user:
            fresh = find_user(str(user.get("email") or "")) or user
            return {"role": "student", "email": str(fresh.get("email") or "").strip().lower(), "record": fresh}
        return {"role": "guest", "email": "", "record": None}

    def global_modes():
        config = config_provider() or {}
        legacy = bool(config.get("network_sim_enabled", False))
        explicit = {mode: config.get(f"{mode}_sim_enabled") for mode in ("packet", "infra")}
        return {mode: value if type(value) is bool else legacy for mode, value in explicit.items()}

    def json_object():
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else None

    def allowed_modes(current):
        role = current["role"]
        if role == "admin":
            return dict(packet=True, infra=True)
        modes = global_modes()
        if role == "student":
            grants = store.student_modes(get_user_class_ids(current.get("record")))
            return {mode: enabled and grants[mode] for mode, enabled in modes.items()}
        if role == "guest":
            modes["infra"] = modes["infra"] and (config_provider() or {}).get("infra_sim_guest_enabled", True) is not False
        return modes

    def may_open(current, mode=None):
        modes = allowed_modes(current)
        return modes[mode] if mode else any(modes.values())

    def recheck_wifi_access(original, scenario_id=None):
        current = actor()
        return (current["role"] == original["role"] and current["email"] == original["email"] and may_open(current, "infra")
                and (scenario_id is None or scenario_id in available_scenarios(current)))

    def access_denied(current):
        message = "Network Lab is disabled for your class" if current["role"] == "student" and any(global_modes().values()) else "Network Lab is disabled"
        return jsonify(ok=False, error=message, enabled=False), 403

    @app.get("/api/network/access")
    def network_access():
        current = actor()
        if not may_open(current):
            response, status = access_denied(current)
            response.status_code = status
        else:
            response = jsonify(ok=True, data={"role": current["role"]})
        response.cache_control.private = True
        response.cache_control.no_store = True
        return response

    def available_scenarios(current):
        if current["role"] == "student":
            return store.student_scenarios(get_user_class_ids(current.get("record")), SCENARIOS)
        return SCENARIOS if current["role"] in ("admin", "teacher", "guest") else ()

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
        if class_id not in get_user_class_ids(current.get("record")) or not store.class_access(class_id, "packet"):
            return False
        return lab_id in {item.get("lab_id") for item in store.assignments_for_class(class_id)}

    guided_labs = register_guided_labs(app, store, actor=actor, may_open=may_open, teacher_class=teacher_class,
                                        get_user_class_ids=get_user_class_ids, find_class=find_class)

    @app.get("/api/network/bootstrap")
    def network_bootstrap():
        current = actor()
        modes = allowed_modes(current)
        if not any(modes.values()):
            return access_denied(current)
        class_ids = get_user_class_ids(current.get("record")) if current["role"] == "student" else []
        assigned = []
        if current["role"] == "student" and modes["packet"]:
            for class_id in class_ids:
                if not store.class_access(class_id, "packet"):
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
        saved = [] if current["role"] == "guest" or not modes["packet"] else store.list_topologies(current["email"])
        saved_sites, wifi_storage_available = [], True
        starter_progress = None
        if current["role"] != "guest" and modes["infra"]:
            try:
                saved_sites = store.list_wifi_sites(current["email"])
            except WifiStorageError:
                wifi_storage_available = False
            try:
                starter_progress = store.wifi_starter_progress(current["email"])
            except WifiStorageError:
                pass
        assigned_infra_labs, lab_classes, labs_available = [], [], True
        if current["role"] in ("teacher", "admin") and modes["infra"]:
            owned = []
            if current["role"] == "teacher":
                owned = [classroom for classroom in get_teacher_classes(current["email"])
                         if str(classroom.get("teacher_email", "")).strip().lower() == current["email"]]
            teacher_labs = guided_labs.teacher_catalog(owned)
            assigned_infra_labs, lab_classes = teacher_labs["labs"], teacher_labs["classes"]
        if current["role"] == "student" and modes["infra"]:
            try:
                assigned_infra_labs = guided_labs.student_catalog(current["email"], [
                    {**(find_class(key) or {}), "id": key} for key in class_ids if find_class(key)
                ])
            except WifiStorageError:
                labs_available = False
        allowed_scenarios = available_scenarios(current) if modes["infra"] else ()
        response = jsonify(
            ok=True,
            data={
                "enabled": any(global_modes().values()),
                "modes": modes,
                "admin_preview": current["role"] == "admin" and not all(global_modes().values()),
                "role": current["role"],
                "can_save": current["role"] != "guest",
                "examples": example_summaries() if modes["packet"] else [],
                "assigned_labs": assigned,
                "practice_labs": [{key: lab[key] for key in ("id", "title", "description", "level", "estimated_minutes")}
                                  for lab in LABS.values()] if modes["packet"] else [],
                "saved": saved,
                "saved_sites": saved_sites,
                "starter_labs": starter.catalog() if modes["infra"] else [],
                "starter_progress": starter_progress,
                "infra_labs": assigned_infra_labs,
                "infra_lab_classes": lab_classes,
                "infra_labs_available": labs_available,
                "wifi_storage_available": wifi_storage_available,
                "scenarios": [scenario_summary(item) for scenario_id, item in SCENARIOS.items()
                              if scenario_id in allowed_scenarios],
                "wifi_limits": WIFI_LIMITS if modes["infra"] else None,
                "wifi_cabling": {**CABLING_CATALOG, "server_services": SERVER_SERVICES} if modes["infra"] else None,
                "command_reference": COMMAND_REFERENCE,
                "port_reference": PORT_REFERENCE,
                "acronym_reference": ACRONYM_REFERENCE,
                "limits": {"devices": 100, "links": 200, "saved": 40, "topology_bytes": 512000},
            },
        )
        response.cache_control.private = True
        response.cache_control.no_store = True
        return response

    @app.get("/api/network/examples/<example_id>")
    def network_example(example_id):
        current = actor()
        if not may_open(current, "packet"):
            return jsonify(ok=False, error="Packet Sim is disabled"), 403
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
        if not may_open(current, "packet"):
            return jsonify(ok=False, error="Packet Sim is disabled"), 403
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

    @app.get("/api/network/practice-labs/<lab_id>")
    def network_practice_lab(lab_id):
        if not may_open(actor(), "packet"):
            return jsonify(ok=False, error="Packet Sim is disabled"), 403
        lab = LABS.get(lab_id)
        if not lab:
            return jsonify(ok=False, error="Lab not found"), 404
        payload = lab_summary(lab)
        payload["starter_topology"] = copy.deepcopy(lab["starter_topology"])
        return jsonify(ok=True, data=payload)

    @app.get("/api/network/topologies")
    def network_topology_list():
        current = actor()
        if current["role"] == "guest":
            return jsonify(ok=False, error="Sign in to save networks"), 401
        if not may_open(current, "packet"):
            return jsonify(ok=False, error="Packet Sim is disabled"), 403
        return jsonify(ok=True, data=store.list_topologies(current["email"]))

    @app.get("/api/network/topologies/<topology_id>")
    def network_topology_get(topology_id):
        current = actor()
        if current["role"] == "guest":
            return jsonify(ok=False, error="Sign in to open saved networks"), 401
        if not may_open(current, "packet"):
            return jsonify(ok=False, error="Packet Sim is disabled"), 403
        topology = store.get_topology(current["email"], topology_id)
        if not topology:
            return jsonify(ok=False, error="Saved network not found"), 404
        return jsonify(ok=True, data=topology)

    @app.put("/api/network/topologies/<topology_id>")
    def network_topology_put(topology_id):
        current = actor()
        if current["role"] == "guest":
            return jsonify(ok=False, error="Guests cannot save networks"), 401
        if not may_open(current, "packet"):
            return jsonify(ok=False, error="Packet Sim is disabled"), 403
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
        if not may_open(current, "packet"):
            return jsonify(ok=False, error="Packet Sim is disabled"), 403
        try:
            deleted = store.delete_topology(current["email"], topology_id)
        except NetworkDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        if not deleted:
            return jsonify(ok=False, error="Saved network not found"), 404
        return jsonify(ok=True)

    def wifi_account():
        current = actor()
        if current["role"] == "guest":
            return None, (jsonify(ok=False, error="Sign in to save or open Wi-Fi sites"), 401)
        if not may_open(current, "infra"):
            return None, (jsonify(ok=False, error="Infra Sim is disabled"), 403)
        return current, None

    @app.post("/api/network/wifi-starter/check")
    def wifi_guest_starter_check():
        current = actor()
        if current["role"] != "guest" or not may_open(current, "infra"):
            return access_denied(current)
        request.max_content_length = MAX_WIFI_SITE_BYTES
        try:
            payload = json_object()
            if not payload:
                raise NetworkDataError("A Starter Labs plan is required")
            site = validate_wifi_site(payload.get("site"), existing={})
            progress = starter.guest_grade(site, payload.get("progress"), payload.get("evidence", []))
        except RequestEntityTooLarge:
            return jsonify(ok=False, error="Starter Labs request is too large"), 413
        except (ValueError, RecursionError):
            return jsonify(ok=False, error="The Starter Labs plan or progress is invalid"), 400
        response = jsonify(ok=True, data={"progress": progress})
        response.cache_control.no_store = True
        return response

    @app.route("/api/network/wifi-starter", methods=["POST", "PUT"])
    def wifi_starter():
        current = actor()
        if current["role"] == "guest" and request.method == "POST":
            if not may_open(current, "infra"):
                return access_denied(current)
            site = validate_wifi_site(starter.blank_site(WIFI_SCHEMA_VERSION))
            return jsonify(ok=True, data={"site": site, "lessons": starter.LESSONS,
                                         "progress": {**starter.initial_progress(), "can_restart": True}, "guest": True})
        current, error = wifi_account()
        if error:
            return error
        authorized = lambda: recheck_wifi_access(current)
        try:
            if request.method == "POST":
                if request.is_json:
                    request.max_content_length = 4096
                    payload = json_object()
                    if not payload or "reset" not in payload:
                        raise NetworkDataError("Choose a Starter Labs reset action")
                    site = store.reset_wifi_starter(current["email"], payload.get("reset"), payload.get("revision"),
                                                   payload.get("lesson"), authorized=authorized)
                else:
                    site = store.start_wifi_starter(current["email"], authorized=authorized)
                data = dict(site={key: value for key, value in site.items() if not key.startswith("starter_")},
                            lessons=starter.LESSONS, progress=starter.summary(site, refresh=True))
            else:
                request.max_content_length = MAX_WIFI_SITE_BYTES
                payload = json_object()
                if payload is None:
                    raise NetworkDataError("A JSON object is required")
                site = store.save_wifi_starter(current["email"], payload.get("site"), payload.get("revision"),
                                              payload.get("evidence", []), authorized=authorized)
                data = dict(revision=site["revision"], progress=starter.summary(site))
        except RequestEntityTooLarge:
            return jsonify(ok=False, error="Starter Labs request is too large"), 413
        except RecursionError:
            return jsonify(ok=False, error="Starter Labs data is nested too deeply"), 400
        except WifiRevisionError as exc:
            return jsonify(ok=False, error=str(exc)), 409
        except WifiAccessError as exc:
            return jsonify(ok=False, error=str(exc)), 403
        except WifiStorageError as exc:
            return jsonify(ok=False, error=str(exc)), 503
        except OSError:
            return jsonify(ok=False, error="Starter Labs could not be saved. Try again."), 503
        except NetworkDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        response = jsonify(ok=True, data=data)
        response.cache_control.private = True
        response.cache_control.no_store = True
        return response

    @app.get("/api/network/wifi-sites")
    def wifi_sites_list():
        current, error = wifi_account()
        if error:
            return error
        try:
            return jsonify(ok=True, data=store.list_wifi_sites(current["email"]))
        except WifiStorageError:
            return jsonify(ok=False, error="Saved sites are unavailable. Try again later."), 503

    @app.post("/api/network/wifi-project/validate")
    def wifi_project_validate():
        current = actor()
        if not may_open(current, "infra"):
            return access_denied(current)
        request.max_content_length = MAX_WIFI_SITE_BYTES
        try:
            payload = json_object()
            if not payload or payload.get("format") != "eagleide-infra-project":
                raise NetworkDataError("Choose an EagleIDE Infra Sim project file")
            project = store.open_wifi_project(current["email"], payload.get("project"))
            return jsonify(ok=True, data=project)
        except RequestEntityTooLarge:
            return jsonify(ok=False, error="Project files must be 2 MB or smaller"), 413
        except RecursionError:
            return jsonify(ok=False, error="Project data is nested too deeply"), 400
        except WifiStorageError:
            return jsonify(ok=False, error="Saved sites are unavailable. Try again later."), 503
        except NetworkDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400

    @app.route("/api/network/wifi-scenarios/<scenario_id>", methods=["GET", "POST"])
    def network_wifi_scenario(scenario_id):
        current = actor()
        if not may_open(current, "infra") or scenario_id not in available_scenarios(current):
            return jsonify(ok=False, error="This scenario is not available"), 404
        scenario = SCENARIOS[scenario_id]
        if request.method == "POST" and current["role"] != "guest":
            try:
                site = store.start_wifi_scenario(
                    current["email"], scenario, authorized=lambda: recheck_wifi_access(current, scenario_id))
            except WifiAccessError as exc:
                return jsonify(ok=False, error=str(exc)), 403
            except (WifiStorageError, OSError):
                return jsonify(ok=False, error="Saved sites are unavailable. Try again later."), 503
            except NetworkDataError as exc:
                return jsonify(ok=False, error=str(exc)), 400
            return jsonify(ok=True, data={"site": site, "briefing": scenario_briefing(scenario)}), 201
        return jsonify(ok=True, data={"site": {**scenario["site"], "scenario_id": scenario_id},
                                     "briefing": scenario_briefing(scenario)})

    @app.post("/api/network/wifi-export.pdf")
    def network_wifi_export():
        current = actor()
        if not may_open(current, "infra"):
            return jsonify(ok=False, error="Infra Sim is disabled"), 403
        request.max_content_length = MAX_EXPORT_BYTES
        try:
            data = json_object()
            if data is None:
                raise ValueError("A floor plan is required")
            author = (current["record"] or {}).get("name") or ("Administrator" if current["role"] == "admin" else "Guest")
            pdf, filename = render_plan_pdf(data, author)
        except RequestEntityTooLarge:
            return jsonify(ok=False, error="The floor plan is too large to export"), 413
        except RecursionError:
            return jsonify(ok=False, error="Floor plan annotations are nested too deeply"), 400
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        response = send_file(io.BytesIO(pdf), mimetype="application/pdf", as_attachment=True, download_name=filename, max_age=0)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/network/wifi-sites/<site_id>", methods=["GET", "PUT", "DELETE"])
    def wifi_site(site_id):
        current, error = wifi_account()
        if error:
            return error
        email = current["email"]
        try:
            if request.method == "PUT":
                request.max_content_length = MAX_WIFI_SITE_BYTES
                payload = json_object()
                if payload is None:
                    raise NetworkDataError("A JSON object is required")
                site = store.save_wifi_site(email, site_id, payload.get("site"), payload.get("revision"),
                                            available_scenarios=available_scenarios(current),
                                            authorized=lambda: recheck_wifi_access(current))
                data = {key: site[key] for key in ("id", "revision", "updated_at")} if request.args.get("summary") == "1" else site
                return jsonify(ok=True, data=data)
            if request.method == "DELETE":
                if store.delete_wifi_site(email, site_id, authorized=lambda: recheck_wifi_access(current)):
                    return jsonify(ok=True)
            else:
                site = store.get_wifi_site(email, site_id)
                if site:
                    scenario = SCENARIOS.get(site.get("scenario_id"))
                    if scenario:
                        site = {**site, "scenario_briefing": scenario_briefing(scenario)}
                    return jsonify(ok=True, data=site)
        except RequestEntityTooLarge:
            return jsonify(ok=False, error="Wi-Fi site requests must be 2 MB or smaller"), 413
        except RecursionError:
            return jsonify(ok=False, error="Wi-Fi site data is nested too deeply"), 400
        except WifiRevisionError as exc:
            return jsonify(ok=False, error=str(exc)), 409
        except WifiAccessError as exc:
            return jsonify(ok=False, error=str(exc)), 403
        except (WifiStorageError, OSError):
            return jsonify(ok=False, error="Saved sites are unavailable. Try again later."), 503
        except NetworkDataError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        return jsonify(ok=False, error="Saved Wi-Fi site not found"), 404

    @app.get("/api/network/student/labs/<class_id>/<lab_id>")
    def network_student_lab_progress_get(class_id, lab_id):
        current = actor()
        if not may_open(current, "packet") or not student_lab_access(current, class_id, lab_id):
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
        if not may_open(current, "packet") or not student_lab_access(current, class_id, lab_id):
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
        starter_roster = []
        for student in roster:
            try:
                progress = store.wifi_starter_progress(student["email"])
            except WifiStorageError:
                progress = None
            starter_roster.append({**student, "progress": progress})
        try:
            infra_labs = guided_labs.class_report(class_id, roster)
        except WifiStorageError:
            infra_labs = None
        access, visibility = store.class_settings(class_id, SCENARIOS, modes=True)
        scenarios = [{**scenario_summary(item), "visible": visibility[scenario_id]} for scenario_id, item in SCENARIOS.items()]
        response = jsonify(ok=True, data={"class_id": class_id, "class_name": classroom.get("name"),
                                          "enabled": any(access.values()), "access": access, "global_access": global_modes(),
                                          "globally_enabled": any(global_modes().values()), "labs": labs, "scenarios": scenarios,
                                          "starter_labs": starter.catalog(), "starter_roster": starter_roster, "infra_labs": infra_labs})
        response.cache_control.private = True
        response.cache_control.no_store = True
        return response

    @app.put("/api/network/teacher/classes/<class_id>/settings")
    def network_teacher_class_settings_put(class_id):
        _, error = teacher_class(class_id)
        if error:
            return error
        data = json_object()
        if data is None:
            return jsonify(ok=False, error="A JSON object is required"), 400
        enabled = data.get("enabled")
        visibility = data.get("scenario_visibility", {})
        access = data.get("access", {})
        if (("enabled" in data and type(enabled) is not bool)
                or not isinstance(access, dict)
                or any(key not in ("packet", "infra") or type(value) is not bool for key, value in access.items())
                or not isinstance(visibility, dict)
                or any(key not in SCENARIOS or type(value) is not bool for key, value in visibility.items())
                or (enabled is None and not visibility and not access)):
            return jsonify(ok=False, error="Invalid class access or scenario settings"), 400
        access, visibility = store.update_class_settings(class_id, SCENARIOS, enabled, visibility, access=access)
        return jsonify(ok=True, data={"enabled": any(access.values()), "access": access, "global_access": global_modes(),
                                     "globally_enabled": any(global_modes().values()), "scenario_visibility": visibility})

    @app.put("/api/network/teacher/classes/<class_id>/scenarios/<scenario_id>")
    def network_teacher_scenario_visibility(class_id, scenario_id):
        owned, error = teacher_class(class_id)
        if error:
            return error
        if scenario_id not in SCENARIOS:
            return jsonify(ok=False, error="Scenario not found"), 404
        data = json_object()
        if data is None or type(data.get("visible")) is not bool:
            return jsonify(ok=False, error="Choose whether to show this scenario"), 400
        store.set_scenario_visibility(class_id, scenario_id, data["visible"])
        return jsonify(ok=True, data={"id": scenario_id, "visible": data["visible"]})

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
