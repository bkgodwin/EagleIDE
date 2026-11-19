"""Grading, attempt counters, concurrency, and privacy for assessed Infra Sim labs."""

import copy
from concurrent.futures import ThreadPoolExecutor
import tempfile
from pathlib import Path
import unittest

from network_store import NetworkStore, WifiAccessError, WifiRevisionError, WifiStorageError, validate_wifi_site
import test_network_sim as network_tests
from wifi_guided_labs import LABS, public_question
from wifi_lab_model import LabNetwork
from wifi_lab_store import GuidedLabStore


def solution(lab):
    site = copy.deepcopy(lab['site'])
    equipment = {item['id']: item for item in site['equipment']}
    for key, role in lab['roles'].items():
        if key in equipment:
            continue
        if role['kind'] == 'access_point':
            site['access_points'].append(dict(id=key, name=key, mount='ceiling', x=role['point'][0], y=role['point'][1],
                                             angle=0, power_db=0, radios={'2.4': {'channel': 1, 'width': 20}, '5': {'channel': 36, 'width': 20}},
                                             ssid_ids=[]))
            continue
        device = dict(id=key, kind=role['kind'], name=key)
        if role.get('rack'):
            device.update(rack_id=role['rack'], rack_u=role['unit'])
        elif role['kind'] == 'demarc':
            device.update(wall_id='lab-east', t=3 / site['walls'][3]['b']['y'], isp='meadowlink' if lab['id'].endswith('01') else 'alderline')
        else:
            device.update(x=role['point'][0], y=role['point'][1])
        equipment[key] = device
    devices = {**equipment, **{ap['id']: ap for ap in site['access_points']}}
    for phase in lab['lessons']:
        for task in phase['tasks']:
            rule = task['rule']
            kind = rule['test']
            device = devices.get(rule.get('role'))
            if kind == 'wire':
                site['cables'].append(dict(id=task['id'], source=dict(device_id=rule['a'], port=rule['aport']),
                    target=dict(device_id=rule['b'], port=rule['bport']), media=rule['medium'], rack_patch=rule['patch'],
                    label='', color='#168aaf', waypoints=[]))
            elif kind == 'config':
                parts = rule['field'].split('.')
                value = device
                if parts[0] == 'dhcp':
                    value['dhcp'] = dict(gateway=rule['value'], dns='1.1.1.1', fallback_dns='8.8.8.8')
                    continue
                for part in parts[:-1]:
                    value = value.setdefault(part, {})
                value[parts[-1]] = rule['value']
            elif kind == 'vlan':
                site['vlans'].append(dict(id=rule['vid'], name=rule['name']))
            elif kind == 'tags':
                device.setdefault('port_vlans', {})[rule['port']] = rule['values']
            elif kind == 'ssid':
                sid = rule['name'].lower()
                if not any(ssid['id'] == sid for ssid in site['ssids']):
                    site['ssids'].append(dict(id=sid, name=rule['name'], vlan=rule['vid'], band=rule['band']))
                if device.get('kind') == 'home_router':
                    device['wifi_ssid'] = sid
                else:
                    device['ssid_ids'] = [sid]
            elif kind == 'join':
                device['ssid_id'] = rule['name'].lower()
            elif kind == 'service':
                device['services'] = [dict(kind=rule['kind'], vlan=rule['vid'], ip='')]
            elif kind == 'limit':
                device['ssid_limits'] = {rule['name'].lower(): rule['rate']}
            elif kind == 'firewall':
                device['firewall'] = [dict(action='deny', source_vlan=20, destination_vlan=0, source_ip='', destination_ip='')]
    site['equipment'] = list(equipment.values())
    return validate_wifi_site(site)


class GuidedLabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.host = NetworkStore(Path(self.temp.name))
        self.store = GuidedLabStore(self.host)
        self.store.assign('class', 'infra-lab-01', True, 1)

    def tearDown(self):
        self.temp.cleanup()

    def mutate(self, action, data=None, lab_id='infra-lab-01'):
        return self.store.mutate('student@example.test', 'class', lab_id, action, data, authorized=lambda: True)

    def test_all_labs_have_valid_solutions_and_private_question_keys(self):
        counts = []
        for lab in LABS.values():
            with self.subTest(lab=lab['id']):
                site = solution(lab)
                checks = LabNetwork(lab, site).checks()
                self.assertTrue(all(checks.values()), [key for key, value in checks.items() if not value])
                counts.append(len(site['equipment']) + len(site['access_points']))
                self.assertEqual(len(lab['questions']), 5)
                for i in range(5):
                    quiz = public_question(lab, i)
                    self.assertNotIn('correct', quiz)
                    self.assertTrue(all('explanation' not in option for option in quiz['options']))
        self.assertEqual(counts, sorted(counts))

    def test_revised_questions_have_four_choices_and_a_progressive_reasoning_mix(self):
        levels = []
        for lab in LABS.values():
            current = []
            for phase, authored in enumerate(lab['questions']):
                quiz = public_question(lab, phase, seed='attempt-a')
                self.assertEqual(len(quiz['options']), 4)
                self.assertEqual(len({o['text'] for o in quiz['options']}), 4)
                self.assertIn(quiz['dok'], (1, 2, 3))
                current.append(quiz['dok'])
                feedback = [public_question(lab, phase, o['id'], seed='attempt-a') for o in quiz['options']]
                self.assertEqual(sum(o['correct'] for o in feedback), 1)
                self.assertEqual(len({o['explanation'] for o in feedback}), 4)
                self.assertTrue(all(len(o['explanation']) > 60 for o in feedback))
            levels.extend(current)
        self.assertEqual(set(levels), {1, 2, 3})
        self.assertNotIn(3, [q['dok'] for q in LABS['infra-lab-01']['questions']])
        self.assertIn(3, [q['dok'] for q in LABS['infra-lab-05']['questions']])

    def test_option_order_is_stable_for_an_attempt_and_varies_between_attempts(self):
        lab = LABS['infra-lab-01']
        a = public_question(lab, 0, seed='attempt-a')
        self.assertEqual(a, public_question(lab, 0, seed='attempt-a'))
        orders = {tuple(o['text'] for o in public_question(lab, 0, seed=str(i))['options']) for i in range(20)}
        self.assertGreater(len(orders), 3)
        data = self.mutate('open')
        data = self.mutate('save', dict(site=solution(lab), revision=data['revision'],
                                       attempt_id=data['attempt_id'], evidence=['internet']))
        self.assertEqual(data['progress']['quiz'], self.mutate('open')['progress']['quiz'])

    def test_legacy_attempts_keep_their_questions_and_feedback_then_repeat_on_the_new_bank(self):
        self.store.assign('class', 'infra-lab-01', True, 0)
        self.mutate('open')
        data = self.store.read('student@example.test')
        run = data['runs']['class']['infra-lab-01']
        run.pop('question_version')
        run.update(site=solution(LABS['infra-lab-01']), completed=5, evidence=['internet'], submitted=True, attempts=1)
        for i in range(5):
            q = public_question(LABS['infra-lab-01'], i, version=1)
            run['answers'][q['id']] = next(o['id'] for o in q['options']
                if public_question(LABS['infra-lab-01'], i, o['id'], version=1)['correct'])
        run['latest'] = dict(**self.store.score(LABS['infra-lab-01'], run), attempt=1, submitted_at=1)
        run['best'] = 100
        self.host._write_json(self.store.path('student@example.test'), data)
        opened = self.mutate('open')
        assessment = opened['progress']['assessment']
        self.assertEqual(assessment['question_version'], 1)
        self.assertEqual(assessment['score'], 100)
        self.assertEqual(assessment['latest']['score'], 100)
        old = assessment['answers'][0]
        self.assertEqual(len(old['options']), 3)
        self.assertIn('Why connect the ISP handoff', old['prompt'])
        self.assertIn('WAN is the router', next(o['text'] for o in old['options'] if o['id'] == old['selected']))
        next_run = self.mutate('next', dict(revision=opened['revision'], attempt_id=opened['attempt_id']))
        self.assertEqual(next_run['progress']['assessment']['question_version'], 2)
        self.assertEqual(next_run['progress']['assessment']['latest']['score'], 100)
        self.assertEqual(next_run['progress']['assessment']['attempts'], 1)

    def test_unknown_question_versions_fail_closed_without_overwriting_saved_work(self):
        self.mutate('open')
        data = self.store.read('student@example.test')
        data['runs']['class']['infra-lab-01']['question_version'] = 999
        self.host._write_json(self.store.path('student@example.test'), data)
        before = self.store.path('student@example.test').read_bytes()
        with self.assertRaises(WifiStorageError):
            self.mutate('open')
        self.assertEqual(before, self.store.path('student@example.test').read_bytes())

    def test_all_five_labs_grade_complete_designs_and_current_objectives(self):
        for lab_id, lab in LABS.items():
            with self.subTest(lab=lab_id):
                self.store.assign('class', lab_id, True, 3)
                data = self.mutate('open', lab_id=lab_id)
                data = self.mutate('save', dict(site=solution(lab), revision=data['revision'],
                    attempt_id=data['attempt_id'], evidence=['internet']), lab_id=lab_id)
                for i in range(5):
                    quiz = data['progress']['quiz']
                    selected = next(o['id'] for o in quiz['options'] if public_question(lab, i, o['id'], seed=data['attempt_id'])['correct'])
                    data = self.mutate('answer', dict(question=quiz['id'], choice=selected,
                        revision=data['revision'], attempt_id=data['attempt_id']), lab_id=lab_id)
                self.assertEqual(data['progress']['assessment']['score'], 100)
                modified = solution(lab)
                modified['cables'].pop()
                data = self.mutate('save', dict(site=modified, revision=data['revision'],
                    attempt_id=data['attempt_id'], evidence=[]), lab_id=lab_id)
                self.assertLess(data['progress']['assessment']['score'], 100)

    def test_grading_requires_effective_firewall_order_and_independent_patch_circuits(self):
        lab = LABS['infra-lab-04']
        site = solution(lab)
        router = next(d for d in site['equipment'] if d['kind'] == 'router')
        router['firewall'].insert(0, dict(action='allow', source_vlan=20, destination_vlan=0, source_ip='', destination_ip=''))
        self.assertFalse(LabNetwork(lab, site).checks()['guest-firewall'])
        router['firewall'].pop(0)
        self.assertTrue(LabNetwork(lab, site).checks()['guest-firewall'])
        lead = next(c for c in site['cables'] if c['id'] == 'patch-pc1')
        lead['source']['port'] = 'FRONT24'
        checks = LabNetwork(lab, site).checks()
        self.assertFalse(checks['patch-pc1'])
        self.assertFalse(checks['verify-network'])

    def test_answers_are_final_submissions_are_idempotent_and_reset_invalidates_old_tabs(self):
        data = self.mutate('open')
        payload = dict(revision=data['revision'], attempt_id=data['attempt_id'], site=solution(LABS['infra-lab-01']), evidence=['internet'])
        data = self.mutate('save', payload)
        correct = 0
        for i in range(5):
            quiz = data['progress']['quiz']
            answer = next(option['id'] for option in quiz['options'] if public_question(LABS['infra-lab-01'], i, option['id'], seed=data['attempt_id'])['correct'])
            if i == 0:
                answer = next(option['id'] for option in quiz['options'] if option['id'] != answer)
            else:
                correct += 1
            payload = dict(revision=data['revision'], attempt_id=data['attempt_id'], question=quiz['id'], choice=answer)
            data = self.mutate('answer', payload)
            self.assertIn('explanation', data['feedback'])
            self.assertEqual(self.mutate('answer', payload)['revision'], data['revision'])
            with self.assertRaises(WifiRevisionError):
                self.mutate('answer', {**payload, 'choice': str((int(answer) + 1) % 3)})
        payload = dict(revision=data['revision'], attempt_id=data['attempt_id'])
        submitted = self.mutate('submit', payload)
        self.assertEqual(submitted['progress']['assessment']['score'], 94)
        self.assertEqual(self.mutate('submit', payload)['progress']['assessment']['attempts'], 1)
        with self.assertRaises(WifiAccessError):
            self.mutate('next', dict(revision=submitted['revision'], attempt_id=submitted['attempt_id']))
        self.store.reset('student@example.test', 'class', 'infra-lab-01', authorized=lambda: True)
        with self.assertRaises(WifiRevisionError):
            self.mutate('save', {**payload, 'site': solution(LABS['infra-lab-01'])})
        reset = self.mutate('open')
        self.assertEqual(reset['progress']['assessment']['attempts'], 0)
        self.assertEqual(reset['progress']['assessment']['questions_answered'], 0)
        self.assertEqual(reset['site']['cables'], solution(LABS['infra-lab-01'])['cables'])

    def test_concurrent_final_submissions_count_once_and_unlimited_allows_next_attempt(self):
        self.store.assign('class', 'infra-lab-01', True, 0)
        data = self.mutate('open')
        payload = dict(revision=data['revision'], attempt_id=data['attempt_id'])
        with ThreadPoolExecutor(max_workers=8) as pool:
            submissions = list(pool.map(lambda _: self.mutate('submit', payload), range(8)))
        self.assertTrue(all(item['progress']['assessment']['attempts'] == 1 for item in submissions))
        last = submissions[0]
        new = self.mutate('next', dict(revision=last['revision'], attempt_id=last['attempt_id']))
        self.assertNotEqual(new['attempt_id'], data['attempt_id'])
        self.assertEqual(new['progress']['assessment']['attempts'], 1)
        self.assertEqual(new['site']['cables'], [])

    def test_removal_of_assignment_and_corrupt_work_do_not_silently_reset_attempts(self):
        self.mutate('open')
        self.store.assign('class', 'infra-lab-01', False, 1)
        with self.assertRaises(WifiAccessError):
            self.mutate('open')
        self.store.assign('class', 'infra-lab-01', True, 1)
        path = self.store.path('student@example.test')
        path.write_text('{"runs": invalid}', encoding='utf-8')
        with self.assertRaises(WifiStorageError):
            self.mutate('open')
        self.assertEqual(path.read_text(encoding='utf-8'), '{"runs": invalid}')
        self.host.delete_account_wifi('student@example.test')
        self.assertFalse(self.store.path('student@example.test').exists())


class GuidedLabRouteTests(unittest.TestCase):
    def setUp(self):
        self.fixture = network_tests.NetworkRouteTests()
        self.fixture.setUp()
        self.client, self.store = self.fixture.client, self.fixture.store
        self.teacher = {'X-Teacher-Token': 'teacher-token'}
        self.student = {'X-User-Token': 'student-token'}

    def tearDown(self):
        self.fixture.tearDown()

    def test_teacher_catalog_previews_unassigned_labs_with_or_without_a_class(self):
        result = self.client.get('/api/network/bootstrap', headers=self.teacher)
        data = result.json['data']
        self.assertTrue(result.cache_control.private)
        self.assertTrue(result.cache_control.no_store)
        self.assertEqual(len(data['infra_labs']), 5)
        self.assertEqual([c['id'] for c in data['infra_lab_classes']], ['class-1'])
        self.assertFalse(any(data['infra_lab_classes'][0]['assigned'].values()))
        self.assertTrue(all('questions' not in lab for lab in data['infra_labs']))
        for lab_id in LABS:
            for suffix in ('', '?class_id=class-1'):
                opened = self.client.post('/api/network/wifi-labs/' + lab_id + suffix, headers=self.teacher)
                self.assertEqual(opened.status_code, 200)
                self.assertTrue(opened.json['data']['progress']['assessment']['preview'])
                self.assertEqual(opened.json['data']['progress']['assessment']['attempts'], 0)
        self.store.set_class_access('class-1', True)
        self.assertFalse(self.client.get('/api/network/bootstrap', headers=self.student).json['data']['infra_labs'])
        self.assertEqual(self.client.post('/api/network/wifi-labs/infra-lab-01', headers=self.student).status_code, 403)
        self.assertEqual(self.client.post('/api/network/wifi-labs/infra-lab-01').status_code, 403)
        self.assertEqual(self.client.post('/api/network/wifi-labs/infra-lab-01?class_id=class-2', headers=self.teacher).status_code, 403)
        self.fixture.classes.clear()
        data = self.client.get('/api/network/bootstrap', headers=self.teacher).json['data']
        self.assertEqual(len(data['infra_labs']), 5)
        self.assertEqual(data['infra_lab_classes'], [])
        self.assertEqual(self.client.post('/api/network/wifi-labs/infra-lab-01', headers=self.teacher).status_code, 200)

    def test_teacher_catalog_reports_assignments_without_granting_students_other_labs(self):
        settings = '/api/network/teacher/classes/class-1/infra-labs/infra-lab-02'
        self.client.put(settings, json={'assigned': True, 'submissions': 3}, headers=self.teacher)
        data = self.client.get('/api/network/bootstrap', headers=self.teacher).json['data']
        selected = data['infra_lab_classes'][0]
        self.assertTrue(selected['infra_enabled'])
        self.assertEqual([k for k, v in selected['assigned'].items() if v], ['infra-lab-02'])
        student = self.client.get('/api/network/bootstrap', headers=self.student).json['data']
        self.assertEqual([lab['id'] for lab in student['infra_labs']], ['infra-lab-02'])

    def test_class_membership_mode_access_and_account_attempts_remain_separate(self):
        settings = '/api/network/teacher/classes/class-1/infra-labs/infra-lab-01'
        url = '/api/network/wifi-labs/infra-lab-01?class_id=class-1'
        self.client.put(settings, json={'assigned': True, 'submissions': 0}, headers=self.teacher)
        first = self.client.post(url, headers=self.student).json['data']
        second_headers = {'X-User-Token': 'second'}
        self.fixture.students['second'] = dict(email='second@example.test', role='student', class_ids=['class-1'])
        self.fixture.classes['class-1']['students'].append('second@example.test')
        second = self.client.post(url, headers=second_headers).json['data']
        self.assertNotEqual(first['attempt_id'], second['attempt_id'])
        self.assertEqual(self.client.post(url.replace('?', '/submit?'), headers=second_headers,
            json=dict(revision=first['revision'], attempt_id=first['attempt_id'])).status_code, 409)
        self.fixture.students['student-token']['class_ids'] = []
        self.assertEqual(self.client.post(url, headers=self.student).status_code, 403)
        self.fixture.students['student-token']['class_ids'] = ['class-1']
        self.fixture.classes['class-1']['students'].remove('student@example.com')
        self.assertEqual(self.client.post(url, headers=self.student).status_code, 403)
        self.fixture.classes['class-1']['students'].append('student@example.com')
        self.fixture.config_state['infra_sim_enabled'] = False
        self.assertEqual(self.client.post(url, headers=self.student).status_code, 403)
        self.assertEqual(self.client.post(url, headers=self.teacher).status_code, 403)
        self.fixture.config_state['infra_sim_enabled'] = True
        self.assertEqual(self.client.post(url, headers=self.student).status_code, 200)
        self.assertEqual(self.client.post(url.replace('class-1', 'class-2'), headers=self.student).status_code, 403)
        for invalid in (-1, True, '3'):
            self.assertEqual(self.client.put(settings, headers=self.teacher,
                json={'assigned': True, 'submissions': invalid}).status_code, 400)

    def test_class_assignments_attempts_and_roster_require_current_authorization(self):
        url = '/api/network/wifi-labs/infra-lab-01?class_id=class-1'
        settings = '/api/network/teacher/classes/class-1/infra-labs/infra-lab-01'
        self.assertEqual(self.client.post(url).status_code, 403)
        self.assertEqual(self.client.post(url, headers=self.student).status_code, 403)
        self.assertEqual(self.client.put(settings, json={'assigned': True, 'submissions': 1}, headers=self.student).status_code, 401)
        self.assertEqual(self.client.put(settings, json={'assigned': True, 'submissions': 1}, headers=self.teacher).status_code, 200)
        opened = self.client.post(url, headers=self.student).json['data']
        self.assertTrue(self.client.get('/api/network/bootstrap', headers=self.student).json['data']['infra_labs'])
        body = dict(revision=opened['revision'], attempt_id=opened['attempt_id'])
        result = self.client.post(url.replace('?', '/submit?'), json=body, headers=self.student)
        self.assertEqual(result.status_code, 200)
        roster = self.client.get('/api/network/teacher/classes/class-1', headers=self.teacher).json['data']['infra_labs'][0]['students']
        self.assertEqual(roster[0]['attempts'], 1)
        self.assertEqual(roster[0]['latest']['score'], 0)
        reset = settings + '/reset'
        self.assertEqual(self.client.post(reset.replace('class-1', 'class-2'), headers=self.teacher,
                                          json={'email': 'student@example.com'}).status_code, 403)
        self.assertEqual(self.client.post(reset, headers=self.teacher, json={'email': 'student@example.com'}).status_code, 200)
        self.assertEqual(self.client.put(settings, json={'assigned': False, 'submissions': 0}, headers=self.teacher).status_code, 200)
        self.assertEqual(self.client.post(url, headers=self.student).status_code, 403)
        preview = self.client.post(url, headers=self.teacher).json['data']
        self.assertEqual(self.client.post(url.replace('?', '/submit?'),
            json=dict(revision=preview['revision'], attempt_id=preview['attempt_id']), headers=self.teacher).status_code, 403)
