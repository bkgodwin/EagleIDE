"""Atomic, revision-checked guided lab drafts and submission counters."""

import copy
import json
import time
import uuid

from network_store import NetworkDataError, WifiAccessError, WifiRevisionError, WifiStorageError, validate_wifi_site
from wifi_guided_labs import LABS, lessons, public_question, summary
from wifi_lab_model import LabNetwork


def _question(lab, run, phase, answer=None):
    return public_question(lab, phase, answer, version=run.get('question_version', 1), seed=run['attempt_id'])


class GuidedLabStore:
    def __init__(self, host):
        self.host = host

    def path(self, email):
        return self.host.wifi_dir / f"{self.host._user_key('guided-labs:' + str(email).strip().lower())}.json"

    def read(self, email):
        path = self.path(email)
        try:
            if path.is_symlink() or self.host.wifi_dir.is_symlink():
                raise WifiStorageError("Lab work is unavailable")
            data = json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {"runs": {}}
        except (OSError, ValueError, RecursionError) as exc:
            raise WifiStorageError("Lab work is unavailable. Try again before making changes.") from exc
        if not isinstance(data, dict) or not isinstance(data.get('runs'), dict):
            raise WifiStorageError("Lab work is unavailable")
        for scope in data['runs'].values():
            if not isinstance(scope, dict):
                raise WifiStorageError("Lab work is unavailable")
            for key, run in scope.items():
                if key not in LABS or not isinstance(run, dict):
                    raise WifiStorageError("Lab work is unavailable")
                version = run.get('question_version', 1)
                if type(version) is not int or version not in LABS[key]['question_versions']:
                    raise WifiStorageError("Lab question version is unavailable")
                bank = LABS[key]['question_versions'][version]
                choices = {f'q{i + 1}': {str(j) for j in range(len(q['options']))} for i, q in enumerate(bank)}
                if (not isinstance(run.get('site'), dict)
                        or type(run.get('revision')) is not int or run['revision'] < 1
                        or type(run.get('attempts')) is not int or run['attempts'] < 0
                        or type(run.get('completed')) is not int or not 0 <= run['completed'] <= 5
                        or not isinstance(run.get('attempt_id'), str) or not isinstance(run.get('answers'), dict)
                        or any(q not in choices or not isinstance(a, str) or a not in choices[q]
                               for q, a in run['answers'].items())
                        or not isinstance(run.get('evidence'), list) or any(e != 'internet' for e in run['evidence'])
                        or type(run.get('submitted')) is not bool):
                    raise WifiStorageError("Lab work is unavailable")
        return data

    def settings(self, class_id):
        with self.host._lock:
            data = self.host._catalog().get('infra_labs', {}).get(str(class_id), {})
            return {key: dict(assigned=data.get(key, {}).get('assigned', False),
                              submissions=data.get(key, {}).get('submissions', 3)) for key in LABS}

    def assign(self, class_id, lab_id, assigned, limit):
        if type(assigned) is not bool or type(limit) is not int or not 0 <= limit <= 2**31 - 1:
            raise NetworkDataError("Choose class access and a nonnegative submission allowance")
        with self.host._lock:
            data = self.host._catalog()
            data.setdefault('infra_labs', {}).setdefault(str(class_id), {})[lab_id] = dict(assigned=assigned, submissions=limit)
            if assigned:
                data.setdefault('class_modes', {}).setdefault(str(class_id), {})['infra'] = True
            self.host._write_json(self.host.catalog_path, data)

    @staticmethod
    def new_run(lab, previous=None):
        previous = previous or {}
        return dict(site=copy.deepcopy(lab['site']), revision=previous.get('revision', 0) + 1,
                    attempt_id=uuid.uuid4().hex, question_version=lab['question_version'], completed=0, answers={}, evidence=[],
                    attempts=previous.get('attempts', 0), latest=previous.get('latest'), best=previous.get('best'),
                    submitted=False, updated_at=time.time())

    @staticmethod
    def score(lab, run, checks=None):
        checks = checks if checks is not None else LabNetwork(lab, run['site']).checks()
        if 'internet' not in run['evidence']:
            checks['verify-ping'] = False
        correct = sum(_question(lab, run, i, run['answers'].get(f'q{i + 1}')).get('correct', False)
                      for i in range(len(lab['questions'])))
        complete = sum(checks.values())
        return dict(score=round(70 * complete / len(checks) + 30 * correct / len(lab['questions'])),
                    objectives_complete=complete, objectives_total=len(checks), questions_correct=correct,
                    questions_answered=len(run['answers']), questions_total=len(lab['questions']))

    def progress(self, lab, run, setting, *, preview=False):
        checks = LabNetwork(lab, run['site']).checks()
        index = run['completed']
        stage = lab['lessons'][index] if index < len(lab['lessons']) else None
        checked = [task['id'] for task in stage['tasks'] if checks[task['id']]] if stage else []
        if stage and 'verify-ping' in checked and 'internet' not in run['evidence']:
            checked.remove('verify-ping')
        quiz = _question(lab, run, index) if stage and len(checked) == len(stage['tasks']) else None
        return dict(version=1, completed=index, checked=checked, can_restart=False, attempt=run['attempts'] + (not run['submitted']),
                    quiz=quiz, assessment=dict(**self.score(lab, run, checks), attempts=run['attempts'], question_version=run.get('question_version', 1),
                    allowance=setting['submissions'], submitted=run['submitted'], preview=preview, latest=run['latest'], best=run['best'],
                    answers=[_question(lab, run, i, run['answers'][f'q{i + 1}'])
                             for i in range(5) if f'q{i + 1}' in run['answers']]))

    def payload(self, lab, run, setting, *, preview=False, full=False):
        result = dict(revision=run['revision'], attempt_id=run['attempt_id'],
                      progress=self.progress(lab, run, setting, preview=preview))
        if full:
            result.update(site={**run['site'], "revision": run['revision']}, lessons=lessons(lab),
                          lab_id=lab['id'], assessment=True)
        return result

    def mutate(self, email, class_id, lab_id, action, payload=None, *, authorized, preview=False):
        path = self.path(email)
        payload = payload or {}
        lab = LABS[lab_id]
        with self.host._wifi_lock(path):
            self.host._require_wifi_write(authorized)
            setting = self.settings(class_id)[lab_id]
            if not preview and not setting['assigned']:
                raise WifiAccessError("This lab is not assigned to your class")
            data = self.read(email)
            scope = data['runs'].setdefault(str(class_id), {})
            run = scope.get(lab_id)
            if action == 'open':
                if run is None or preview:
                    run = self.new_run(lab, run)
                    scope[lab_id] = run
                    self.host._write_json(path, data, compact=True)
                return self.payload(lab, run, setting, preview=preview, full=True)
            if run is None:
                raise WifiRevisionError("Open this lab before saving")
            if payload.get('attempt_id') != run['attempt_id']:
                raise WifiRevisionError("This attempt changed. Reopen the lab to continue.")
            if action == 'answer' and (not isinstance(payload.get('question'), str) or not isinstance(payload.get('choice'), str)):
                raise NetworkDataError("Choose one answer for this question")
            if action == 'submit' and run['submitted']:
                return self.payload(lab, run, setting, preview=preview)
            if action == 'answer' and payload.get('question') in run['answers']:
                if run['answers'][payload['question']] != payload.get('choice'):
                    raise WifiRevisionError("That answer is already recorded for this attempt")
                result = self.payload(lab, run, setting, preview=preview)
                phase = int(payload['question'][1:]) - 1
                result['feedback'] = _question(lab, run, phase, payload['choice'])
                return result
            revision = payload.get('revision')
            if type(revision) is not int or revision != run['revision']:
                if (action == 'save' and revision == run['revision'] - 1 and payload.get('site') == run['site']
                        and payload.get('evidence', []) == run['evidence']):
                    return self.payload(lab, run, setting, preview=preview)
                raise WifiRevisionError("Lab work changed in another tab. Reopen it to continue.")
            if action == 'next':
                if not run['submitted']:
                    raise NetworkDataError("Submit the current attempt before starting another")
                if not preview and setting['submissions'] and run['attempts'] >= setting['submissions']:
                    raise WifiAccessError("The submission allowance has been reached. Ask your teacher to reset attempts.")
                run = self.new_run(lab, run)
                scope[lab_id] = run
                self.host._write_json(path, data, compact=True)
                return self.payload(lab, run, setting, preview=preview, full=True)
            if run['submitted']:
                raise WifiAccessError("This attempt has been submitted. Start another attempt from Labs.")
            if not preview and setting['submissions'] and run['attempts'] >= setting['submissions']:
                raise WifiAccessError("The submission allowance has been reached")
            if action == 'save':
                site = validate_wifi_site(payload.get('site'), existing=run['site'])
                site.pop('scenario_id', None)
                events = payload.get('evidence', [])
                if not isinstance(events, list) or len(events) > 1 or any(event != 'internet' for event in events):
                    raise NetworkDataError("Invalid lab activity")
                run['site'] = site
                if events and LabNetwork(lab, site).check(dict(test='internet')):
                    run['evidence'] = ['internet']
            elif action == 'answer':
                quiz = self.progress(lab, run, setting)['quiz']
                if not quiz or payload.get('question') != quiz['id'] or payload.get('choice') not in {o['id'] for o in quiz['options']}:
                    raise NetworkDataError("Complete this section and choose one of its answers")
                run['answers'][quiz['id']] = payload['choice']
                feedback = _question(lab, run, run['completed'], payload['choice'])
                run['completed'] += 1
            elif action == 'submit':
                if preview:
                    raise WifiAccessError("Teacher previews do not submit student work")
                score = self.score(lab, run)
                run['attempts'] += 1
                run['submitted'] = True
                run['latest'] = {**score, "submitted_at": time.time(), "attempt": run['attempts']}
                run['best'] = max(run.get('best') or 0, score['score'])
            else:
                raise NetworkDataError("Unknown lab action")
            run['revision'] += 1
            run['updated_at'] = time.time()
            self.host._write_json(path, data, compact=True)
            result = self.payload(lab, run, setting, preview=preview)
            if action == 'answer':
                result['feedback'] = feedback
            return result

    def student_catalog(self, email, classrooms):
        with self.host._wifi_lock(self.path(email)):
            data = self.read(email)
        result = []
        for classroom in classrooms:
            class_id = str(classroom['id'])
            for lab_id, setting in self.settings(class_id).items():
                if not setting['assigned'] or not self.host.class_access(class_id, 'infra'):
                    continue
                run = data['runs'].get(class_id, {}).get(lab_id)
                result.append(dict(**summary(LABS[lab_id]), class_id=class_id, class_name=classroom.get('name', 'Class'),
                                   allowance=setting['submissions'], attempts=(run or {}).get('attempts', 0),
                                   submitted=(run or {}).get('submitted', False), latest=(run or {}).get('latest'),
                                   started=bool(run)))
        return sorted(result, key=lambda row: (row['id'], row['class_name'].casefold()))

    def teacher_catalog(self, classrooms):
        classes = []
        for classroom in classrooms:
            class_id = str(classroom['id'])
            settings = self.settings(class_id)
            classes.append(dict(id=class_id, name=classroom.get('name') or 'Class',
                                infra_enabled=self.host.class_access(class_id, 'infra'),
                                assigned={key: setting['assigned'] for key, setting in settings.items()}))
        return dict(labs=[summary(lab) for lab in LABS.values()],
                    classes=sorted(classes, key=lambda item: (item['name'].casefold(), item['id'])))

    def class_report(self, class_id, roster):
        settings = self.settings(class_id)
        records = []
        for student in roster:
            with self.host._wifi_lock(self.path(student['email'])):
                data = self.read(student['email'])
            records.append((student, data['runs'].get(str(class_id), {})))
        return [dict(**summary(lab), **settings[lab_id], students=[
            dict(**student, attempts=runs.get(lab_id, {}).get('attempts', 0), latest=runs.get(lab_id, {}).get('latest'),
                 best=runs.get(lab_id, {}).get('best'), completed=runs.get(lab_id, {}).get('completed', 0),
                 started=bool(runs.get(lab_id))) for student, runs in records]) for lab_id, lab in LABS.items()]

    def reset(self, email, class_id, lab_id, *, authorized):
        path = self.path(email)
        with self.host._wifi_lock(path):
            self.host._require_wifi_write(authorized)
            data = self.read(email)
            scope = data['runs'].setdefault(str(class_id), {})
            previous = scope.get(lab_id)
            if previous:
                run = self.new_run(LABS[lab_id], {**previous, 'attempts': 0, 'latest': None, 'best': None})
                run['site'] = previous['site']
                scope[lab_id] = run
                self.host._write_json(path, data, compact=True)
