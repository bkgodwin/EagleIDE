"""Authenticated class assignments and assessed Infra Sim lab routes."""

from flask import jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from network_store import MAX_WIFI_SITE_BYTES, NetworkDataError, WifiAccessError, WifiRevisionError, WifiStorageError
from wifi_guided_labs import LABS
from wifi_lab_store import GuidedLabStore


def register(app, host, *, actor, may_open, teacher_class, get_user_class_ids, find_class):
    labs = GuidedLabStore(host)
    app.extensions['wifi_guided_labs'] = labs

    def response(call):
        try:
            result = jsonify(ok=True, data=call())
        except WifiRevisionError as exc:
            result = jsonify(ok=False, error=str(exc))
            result.status_code = 409
        except WifiAccessError as exc:
            result = jsonify(ok=False, error=str(exc))
            result.status_code = 403
        except RequestEntityTooLarge:
            result = jsonify(ok=False, error="Lab work is too large")
            result.status_code = 413
        except (NetworkDataError, ValueError, RecursionError) as exc:
            result = jsonify(ok=False, error=str(exc) if not isinstance(exc, RecursionError) else "Lab data is nested too deeply")
            result.status_code = 400
        except (WifiStorageError, OSError):
            result = jsonify(ok=False, error="Lab work is unavailable. Try again or download your project.")
            result.status_code = 503
        result.cache_control.private = True
        result.cache_control.no_store = True
        return result

    def access(current, class_id, lab_id):
        classroom = find_class(class_id)
        if not classroom or lab_id not in LABS or not may_open(current, 'infra'):
            return False
        if current['role'] == 'admin':
            return True
        if current['role'] == 'teacher':
            return str(classroom.get('teacher_email', '')).strip().lower() == current['email']
        if current['role'] != 'student':
            return False
        return (class_id in get_user_class_ids(current['record'])
                and current['email'] in [str(email).strip().lower() for email in classroom.get('students', [])]
                and host.class_access(class_id, 'infra') and labs.settings(class_id)[lab_id]['assigned'])

    @app.route('/api/network/wifi-labs/<lab_id>', methods=['POST', 'PUT'])
    @app.post('/api/network/wifi-labs/<lab_id>/<action>')
    def lab_project(lab_id, action=None):
        request.max_content_length = MAX_WIFI_SITE_BYTES
        current = actor()
        class_id = request.args.get('class_id', '')
        if not access(current, class_id, lab_id):
            return response(lambda: denied())
        preview = current['role'] != 'student'
        if request.method == 'PUT':
            action = 'save'
        elif action is None:
            action = 'open'
        if action not in ('open', 'save', 'answer', 'submit', 'next'):
            return response(lambda: invalid())
        payload = request.get_json(silent=True)
        if payload is not None and not isinstance(payload, dict):
            return response(lambda: invalid())
        original = (current['role'], current['email'])
        def authorized():
            fresh = actor()
            return (fresh['role'], fresh['email']) == original and access(fresh, class_id, lab_id)
        return response(lambda: labs.mutate(current['email'], class_id, lab_id, action, payload,
                                             authorized=authorized, preview=preview))

    def denied():
        raise WifiAccessError("This lab is available only to signed-in members of an assigned class")

    def invalid():
        raise NetworkDataError("Choose a valid lab action")

    @app.put('/api/network/teacher/classes/<class_id>/infra-labs/<lab_id>')
    def class_assignment(class_id, lab_id):
        owned, error = teacher_class(class_id)
        if error:
            return error
        if lab_id not in LABS:
            return response(lambda: invalid())
        request.max_content_length = 4096
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return response(lambda: invalid())
        def save():
            labs.assign(class_id, lab_id, payload.get('assigned'), payload.get('submissions'))
            return labs.settings(class_id)[lab_id]
        return response(save)

    @app.post('/api/network/teacher/classes/<class_id>/infra-labs/<lab_id>/reset')
    def reset_attempts(class_id, lab_id):
        request.max_content_length = 4096
        owned, error = teacher_class(class_id)
        if error:
            return error
        _, classroom = owned
        payload = request.get_json(silent=True)
        email = str(payload.get('email', '')).strip().lower() if isinstance(payload, dict) else ''
        if lab_id not in LABS or email not in [str(value).strip().lower() for value in classroom.get('students', [])]:
            return response(lambda: invalid())
        def authorized():
            fresh, failure = teacher_class(class_id)
            return not failure and email in [str(value).strip().lower() for value in fresh[1].get('students', [])]
        return response(lambda: labs.reset(email, class_id, lab_id, authorized=authorized))

    return labs
