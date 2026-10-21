"""Agenda media authorization, immutable copies, personalization and storage limits."""
import io
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

from PIL import Image

import test_assignments as fixtures
from lesson_plan_store import normalize_week_start

eagle = fixtures.eagle


class AgendaResourcesTests(unittest.TestCase):
    teacher_headers = fixtures.AssignmentWorkflowTestCase.teacher_headers
    student_headers = fixtures.AssignmentWorkflowTestCase.student_headers
    create_assignment = fixtures.AssignmentWorkflowTestCase.create_assignment

    def setUp(self):
        fixtures.AssignmentWorkflowTestCase.setUp(self)
        self.store = eagle.app.extensions['eagle_lesson_plan_store']
        self.saved_paths = self.store.base_dir, self.store.catalog_path
        self.store.base_dir = self.root / 'plans'
        self.store.catalog_path = self.store.base_dir / 'catalog.json'
        self.week = normalize_week_start()
        self.endpoint = f'/api/teacher/classes/{self.class_one}/lesson-plans/{self.week}'

    def tearDown(self):
        self.store.base_dir, self.store.catalog_path = self.saved_paths
        fixtures.AssignmentWorkflowTestCase.tearDown(self)

    def image(self, endpoint=None):
        image = io.BytesIO()
        Image.new('RGB', (2300, 120), '#4d8aaa').save(image, 'PNG')
        image.seek(0)
        response = self.client.post((endpoint or self.endpoint) + '/assets', headers=self.teacher_headers,
                                    data={'image': (image, 'camera.png')})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.json['asset']

    def publish(self, day, version=0):
        response = self.client.put(self.endpoint, headers=self.teacher_headers,
                                   json={'expected_version': version, 'days': {'monday': day}})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.json

    def attachment(self):
        root = eagle._get_user_dir(self.teacher_email)
        root.mkdir(parents=True, exist_ok=True)
        path = root / 'example.py'
        path.write_text('print("original")\n', encoding='utf-8')
        response = self.client.post(self.endpoint + '/assets', headers=self.teacher_headers, json={'path': 'example.py'})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return path, response.json['asset']

    def test_image_is_resized_and_requires_class_access_or_revocable_share(self):
        asset = self.image()
        url = f'/api/lesson-plans/{self.class_one}/{self.week}/assets/{asset["id"]}'
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.get(url, headers=self.student_headers).status_code, 404, 'Unpublished images stay private')
        self.publish({'markdown': f'![Example](agenda-image:{asset["id"]})', 'color': '#ee4444'})
        response = self.client.get(url, headers=self.student_headers)
        self.assertEqual(response.status_code, 200)
        with Image.open(io.BytesIO(response.data)) as image:
            self.assertLessEqual(max(image.size), 1920)
        response.close()
        token = self.store.ensure_public_token(self.class_one)
        shared = self.client.get(url, query_string={'share': token})
        self.assertEqual(shared.status_code, 200)
        shared.close()
        self.store.reset_public_token(self.class_one)
        self.assertEqual(self.client.get(url, query_string={'share': token}).status_code, 404)
        catalog = eagle._load_classes()
        catalog['classes'][0]['students'] = []
        eagle._save_classes(catalog)
        users = eagle._load_users()
        for user in users['users']:
            if user['email'] == self.student_email:
                user.update(class_id='', class_ids=[])
        eagle._save_users(users)
        self.assertEqual(self.client.get(url, headers=self.student_headers).status_code, 404)

    def test_file_is_immutable_collision_safe_and_removed_links_cannot_be_copied(self):
        path, asset = self.attachment()
        self.publish({'attachment_ids': [asset['id']]})
        path.write_text('print("changed")', encoding='utf-8')
        url = f'/api/classes/{self.class_one}/lesson-plans/{self.week}/files/{asset["id"]}/open'
        self.assertEqual(self.client.post(url).status_code, 404)
        first = self.client.post(url, headers=self.student_headers)
        second = self.client.post(url, headers=self.student_headers)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(first.json['path'], second.json['path'])
        for copy in [first.json, second.json]:
            target = eagle._get_user_dir(self.student_email) / copy['path']
            self.assertEqual(target.parent, eagle._get_user_dir(self.student_email))
            self.assertEqual(target.read_text(encoding='utf-8'), 'print("original")\n')
        self.publish({}, version=1)
        self.assertEqual(self.client.post(url, headers=self.student_headers).status_code, 404)
        self.assertTrue((eagle._get_user_dir(self.student_email) / first.json['path']).is_file())

    def test_paths_other_classes_and_storage_quotas_are_enforced(self):
        self.assertEqual(self.client.post(self.endpoint + '/assets', headers=self.teacher_headers, json={'path': '../config.txt'}).status_code, 400)
        path, asset = self.attachment()
        self.publish({'attachment_ids': [asset['id']]})
        other = f'/api/classes/{self.class_two}/lesson-plans/{self.week}/files/{asset["id"]}/open'
        self.assertEqual(self.client.post(other, headers=self.student_headers).status_code, 404)
        url = f'/api/classes/{self.class_one}/lesson-plans/{self.week}/files/{asset["id"]}/open'
        with patch.object(eagle, '_get_user_storage_used', return_value=10**12):
            self.assertEqual(self.client.post(url, headers=self.student_headers).status_code, 413)
        catalog = eagle._load_classes()
        catalog['classes'][0]['settings']['student_ide_access_enabled'] = False
        eagle._save_classes(catalog)
        self.assertEqual(self.client.post(url, headers=self.student_headers).status_code, 403)

    def test_media_limits_and_foreign_week_assets_are_rejected(self):
        oversized = self.client.post(self.endpoint + '/assets', headers=self.teacher_headers,
            data={'image': (io.BytesIO(b'x' * (5 * 1024 * 1024 + 1)), 'large.png')})
        self.assertEqual(oversized.status_code, 413)
        invalid = self.client.post(self.endpoint + '/assets', headers=self.teacher_headers,
            data={'image': (io.BytesIO(b'<svg onload="alert(1)"/>'), 'fake.png')})
        self.assertEqual(invalid.status_code, 400)
        with patch('lesson_plan_resources.MAX_WEEK_BYTES', 1):
            root = eagle._get_user_dir(self.teacher_email)
            root.mkdir(parents=True, exist_ok=True)
            (root / 'example.py').write_text('print(1)')
            self.assertEqual(self.client.post(self.endpoint + '/assets', headers=self.teacher_headers, json={'path':'example.py'}).status_code, 400)
        asset = self.image()
        future = (date.fromisoformat(self.week) + timedelta(days=7)).isoformat()
        wrong_week = self.client.put(self.endpoint.replace(self.week, future), headers=self.teacher_headers,
            json={'days': {'monday': {'markdown': f'![Foreign](agenda-image:{asset["id"]})'}}})
        self.assertEqual(wrong_week.status_code, 400)

    def test_simultaneous_file_opens_preserve_every_copy(self):
        _, asset = self.attachment()
        self.publish({'attachment_ids': [asset['id']]})
        url = f'/api/classes/{self.class_one}/lesson-plans/{self.week}/files/{asset["id"]}/open'
        def copy(_):
            with eagle.app.test_client() as client:
                response = client.post(url, headers=self.student_headers)
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                return response.json['path']
        with ThreadPoolExecutor(max_workers=4) as pool:
            paths = list(pool.map(copy, range(4)))
        self.assertEqual(len(set(paths)), 4)

    def test_future_media_is_hidden_except_for_teacher_and_short_lived_print(self):
        future = (date.fromisoformat(self.week) + timedelta(days=7)).isoformat()
        endpoint = self.endpoint.replace(self.week, future)
        asset = self.image(endpoint)
        response = self.client.put(endpoint, headers=self.teacher_headers, json={'days': {'monday': {'markdown': f'![Image](agenda-image:{asset["id"]})'}}})
        self.assertEqual(response.status_code, 200)
        url = f'/api/lesson-plans/{self.class_one}/{future}/assets/{asset["id"]}'
        self.assertEqual(self.client.get(url, headers=self.student_headers).status_code, 404)
        self.assertEqual(self.client.get(url, query_string={'share': self.store.ensure_public_token(self.class_one)}).status_code, 404)
        printed = self.client.post(endpoint + '/print', headers=self.teacher_headers).json
        token = printed['print_path'].rsplit('/', 1)[-1]
        image = self.client.get(url, query_string={'print': token})
        self.assertEqual(image.status_code, 200)
        image.close()

    def test_linked_class_images_use_target_membership_and_source_storage(self):
        asset = self.image()
        self.publish({'markdown': f'![Image](agenda-image:{asset["id"]})'})
        self.store.set_plan_source(self.class_two, self.class_one)
        users = eagle._load_users()
        for user in users['users']:
            if user['email'] == self.student_email:
                user.update(class_id=self.class_two, class_ids=[self.class_two])
        eagle._save_users(users)
        data = self.client.get(f'/api/classes/{self.class_two}/lesson-plans', headers=self.student_headers).json
        url = data['plan']['days']['monday']['images'][0]['url']
        self.assertIn(f'/{self.class_two}/', url)
        image = self.client.get(url, headers=self.student_headers)
        self.assertEqual(image.status_code, 200)
        image.close()

    def test_assignments_are_class_scoped_released_and_have_only_personal_deadlines(self):
        assignment = self.create_assignment(active=True)
        due = datetime.combine(date.fromisoformat(self.week), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=20)
        assignment = eagle._load_assignment(assignment['id'])
        assignment['dueAt'] = due.isoformat()
        eagle._save_assignment(assignment)
        catalog = eagle._load_classes()
        catalog['classes'][0]['settings']['assignment_submission_window'] = {'timeZone': 'America/Chicago'}
        catalog['classes'][0]['accommodations'] = {self.student_email: {'extendedWeekdays': 1}}
        eagle._save_classes(catalog)
        self.publish({'assignment_ids': [assignment['id']]})
        response = self.client.get(f'/api/classes/{self.class_one}/lesson-plans', headers=self.student_headers)
        data = response.json
        self.assertEqual(data['plan']['days']['tuesday']['due_assignments'][0]['id'], assignment['id'])
        self.assertIn('accommodation', data['plan']['days']['monday']['assignments'][0]['accommodationNote'])
        self.assertNotIn('accommodations', str(data))
        public = self.client.get(f'/api/lesson-plans/public/{self.store.ensure_public_token(self.class_one)}').json
        self.assertEqual(public['plan']['days']['monday']['assignments'], [])
        other = self.create_assignment(class_id=self.class_two, active=True)
        denied = self.client.put(self.endpoint, headers=self.teacher_headers, json={'days': {'monday': {'assignment_ids': [other['id']]}}})
        self.assertEqual(denied.status_code, 400)
        extended = self.client.post('/api/assignments/extend-student', headers=self.teacher_headers,
            json={'assignmentId': assignment['id'], 'studentEmail': self.student_email, 'days': 3})
        self.assertEqual(extended.status_code, 200)
        student = self.client.get(f'/api/classes/{self.class_one}/lesson-plans', headers=self.student_headers).json
        personal = student['plan']['days']['monday']['assignments'][0]
        self.assertEqual(personal['accommodationNote'], 'Deadline adjusted by your teacher')
        self.assertNotIn('studentExtensions', str(student))


if __name__ == '__main__':
    unittest.main()
