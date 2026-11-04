import io
import tempfile
import types
import unittest
from pathlib import Path

from flask import Flask
from PIL import Image

from lab_report_media import register


class LabReportMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.assignment = {'assignmentType':'lab_report', 'targetClassId':'class-a', 'task':'', 'quiz':{'questions':[]}}
        self.enrolled = True
        self.app = Flask(__name__)
        def teacher(req, **_):
            token = req.headers.get('X-Teacher-Token')
            return {'email':token} if token in {'teacher', 'other'} else None
        eagle = types.SimpleNamespace(
            _require_admin=lambda req: req.headers.get('X-Admin-Token') == 'admin',
            _require_teacher=teacher,
            _class_dashboard_access=lambda email, cid: (email,cid) in {('teacher','class-a'),('other','class-b')},
            _require_user=lambda req: {'email':'student'} if req.headers.get('X-User-Token') == 'student' else None,
            _find_user=lambda email: {'email':email},
            _user_in_class=lambda user,cid: self.enrolled and cid == 'class-a',
            _load_assignment=lambda aid: self.assignment if aid == 'report' else None,
        )
        register(self.app, eagle, base_dir=Path(self.temp.name))
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def upload(self, payload=None, headers=None, class_id='class-a'):
        if payload is None:
            stream=io.BytesIO()
            image=Image.new('RGB',(2200,100),'red')
            image.save(stream,'PNG',pnginfo=None)
            payload=stream.getvalue()
        return self.client.post('/api/lab-reports/images?class_id='+class_id,
            headers=headers or {'X-Teacher-Token':'teacher'}, data={'image':(io.BytesIO(payload),'picture.png')})

    def test_upload_limits_decode_and_class_authority(self):
        self.assertEqual(self.upload(headers={'X-User-Token':'student'}).status_code,403)
        self.assertEqual(self.upload(class_id='class-b').status_code,403)
        self.assertEqual(self.upload(b'<svg onload="alert(1)"></svg>').status_code,400)
        self.assertEqual(self.upload(b'x'*(5*1024*1024+1)).status_code,413)
        response=self.upload()
        self.assertEqual(response.status_code,201)
        image_id=response.json['data']['id']
        image=self.client.get('/api/lab-reports/images/'+image_id+'?class_id=class-a',headers={'X-Teacher-Token':'teacher'})
        self.assertEqual(image.status_code,200)
        self.assertEqual(image.headers['Cache-Control'],'private, no-store')
        with Image.open(io.BytesIO(image.data)) as decoded:
            self.assertEqual(decoded.format,'JPEG')
            self.assertLessEqual(max(decoded.size),1920)
            self.assertFalse(decoded.getexif())
        image.close()

    def test_images_require_references_current_membership_and_original_class(self):
        image_id=self.upload().json['data']['id']
        url='/api/lab-reports/images/'+image_id+'?assignment_id=report'
        student={'X-User-Token':'student'}
        self.assertEqual(self.client.get(url,headers=student).status_code,404)
        self.assignment['quiz']['questions']=[{'question':'Look at ![Example](lab-image:'+image_id+')'}]
        self.assertEqual(self.client.get(url).status_code,403)
        with self.client.get(url,headers=student) as response:
            self.assertEqual(response.status_code,200)
        self.enrolled=False
        self.assertEqual(self.client.get(url,headers=student).status_code,403)
        self.enrolled=True
        self.assignment['targetClassId']='class-b'
        self.assertEqual(self.client.get(url,headers={'X-Teacher-Token':'other'}).status_code,404)

    def test_per_author_count_quota(self):
        self.upload()
        folder=next(Path(self.temp.name).iterdir())
        for index in range(100):
            (folder/f'{index:032x}.jpg').write_bytes(b'fixture')
        self.assertEqual(self.upload().status_code,413)


if __name__ == '__main__':
    unittest.main()
