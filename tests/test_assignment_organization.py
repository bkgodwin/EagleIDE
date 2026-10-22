"""Class folder permissions, atomic organization, and finalized submission retention."""
import concurrent.futures
import json
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import test_assignments as fixtures
import assignment_development as development
import assignment_organization as organization

eagle = fixtures.eagle


class AssignmentOrganizationTests(unittest.TestCase):
    setUp = fixtures.AssignmentWorkflowTestCase.setUp
    tearDown = fixtures.AssignmentWorkflowTestCase.tearDown
    teacher_headers = fixtures.AssignmentWorkflowTestCase.teacher_headers
    student_headers = fixtures.AssignmentWorkflowTestCase.student_headers
    create_assignment = fixtures.AssignmentWorkflowTestCase.create_assignment
    submit_code = fixtures.AssignmentWorkflowTestCase.submit_code

    def folders(self, **data):
        return self.client.post('/api/assignments/folders', headers=self.teacher_headers, json={'classId':self.class_one, **data})

    def catalog(self, class_id=None):
        return self.client.get('/api/assignments/folders', headers=self.teacher_headers, query_string={'classId':class_id or self.class_one}).get_json()

    def new_folder(self, name='Quarter 1'):
        response = self.folders(action='create', name=name)
        self.assertEqual(response.status_code,200,response.get_data(as_text=True))
        return response.get_json()['folders'][-1]['id']

    def finalize(self, assignment, headers=None):
        return self.client.post('/api/assignments/grading-complete',headers=headers or self.teacher_headers,json={'assignmentId':assignment['id']})

    def test_folders_persist_names_and_never_become_assignment_metadata_or_student_data(self):
        name = 'Quarter "1" / <Functions>'
        folder = self.new_folder(name)
        self.assertEqual(self.catalog()['folders'],[{'id':folder,'name':name}])
        self.assertEqual(eagle._list_assignments(),[])
        fresh = eagle.app.test_client().get('/api/assignments/folders',headers=self.teacher_headers,query_string={'classId':self.class_one})
        self.assertEqual(fresh.get_json()['folders'][0]['name'],name)
        self.assertEqual(self.client.get('/api/assignments/folders',headers=self.student_headers,query_string={'classId':self.class_one}).status_code,401)
        self.assertNotIn(name,self.client.get('/api/assignments',headers=self.student_headers).get_data(as_text=True))

    def test_move_rename_and_folder_delete_keep_assignment_and_all_submitted_files(self):
        assignment = self.create_assignment(active=True); self.submit_code(assignment)
        before = eagle._load_assignment(assignment['id'])
        snapshot = eagle._assignment_submission_path(before,before['submissions'][0]['submissionPath'])
        content = snapshot.read_bytes(); folder = self.new_folder()
        self.assertEqual(self.folders(action='move',assignmentId=assignment['id'],folderId=folder).status_code,200)
        self.assertEqual(self.catalog()['assignments'],{assignment['id']:folder})
        self.assertEqual(self.folders(action='rename',folderId=folder,name='Unit 2').status_code,200)
        self.assertEqual(self.folders(action='delete',folderId=folder).status_code,200)
        self.assertEqual(self.catalog()['assignments'],{})
        self.assertEqual(eagle._load_assignment(assignment['id']),before)
        self.assertEqual(snapshot.read_bytes(),content)

    def test_folders_require_owner_and_reject_cross_class_moves_and_revoked_coteachers(self):
        folder = self.new_folder(); assignment = self.create_assignment(self.class_two)
        self.assertEqual(self.folders(action='move',assignmentId=assignment['id'],folderId=folder).status_code,403)
        other = self.client.post('/api/assignments/folders',headers=self.teacher_headers,json={'classId':self.class_two,'action':'create','name':'Other'}).get_json()['folders'][0]['id']
        own = self.create_assignment()
        self.assertEqual(self.folders(action='move',assignmentId=own['id'],folderId=other).status_code,404)
        token = 'folder-other-teacher'; eagle._teacher_tokens[token]={'email':'other@example.com','role':'teacher'}
        self.addCleanup(eagle._teacher_tokens.pop,token,None)
        self.assertEqual(self.client.get('/api/assignments/folders',headers={'X-Teacher-Token':token},query_string={'classId':self.class_one}).status_code,403)
        self.assertEqual(self.finalize(own,{'X-Teacher-Token':token}).status_code,403)
        classes=eagle._load_classes(); classes['classes'][0]['coteachers']=[self.student_email]; eagle._save_classes(classes)
        headers={'X-Teacher-Token':self.student_token}
        response=self.client.get('/api/assignments/folders',headers=headers,query_string={'classId':self.class_one})
        self.assertEqual(response.status_code,200); self.assertFalse(response.get_json()['canOrganize'])
        self.assertEqual(self.client.post('/api/assignments/folders',headers=headers,json={'classId':self.class_one,'action':'create','name':'No'}).status_code,403)
        self.assertEqual(self.finalize(own,headers).status_code,403)
        classes['classes'][0]['coteachers']=[]; eagle._save_classes(classes)
        self.assertEqual(self.client.get('/api/assignments/folders',headers=headers,query_string={'classId':self.class_one}).status_code,401)

    def test_invalid_folder_mutations_and_failed_writes_leave_catalog_unchanged(self):
        folder=self.new_folder(); before=self.catalog()
        for payload in ({'action':[]},{'action':'create','name':''},{'action':'create','name':'a'*81},
                        {'action':'create','name':'Bad\nName'},{'action':'create','name':False},{'action':'move','folderId':[]},
                        {'action':'move','assignmentId':'../../users.json','folderId':folder}):
            self.assertEqual(self.folders(**payload).status_code,400,payload)
        self.assertEqual(self.folders(action='create',name='QUARTER 1',folderId=folder).status_code,409)
        with patch.object(eagle,'_write_json_file_atomic',side_effect=OSError('disk full')):
            self.assertEqual(self.folders(action='rename',folderId=folder,name='Lost rename').status_code,503)
        self.assertEqual(self.catalog(),before)
        path=organization._path(eagle,self.class_one); path.write_text('{broken',encoding='utf-8')
        self.assertEqual(self.folders(action='create',name='Do not overwrite').status_code,503)
        self.assertEqual(path.read_text(encoding='utf-8'),'{broken')

    def test_simultaneous_moves_preserve_both_assignments(self):
        first=self.create_assignment(name='First'); second=self.create_assignment(name='Second'); folder=self.new_folder()
        def move(assignment):
            return eagle.app.test_client().post('/api/assignments/folders',headers=self.teacher_headers,
                json={'classId':self.class_one,'action':'move','folderId':folder,'assignmentId':assignment['id']}).status_code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(move,[first,second])),[200,200])
        self.assertEqual(self.catalog()['assignments'],{first['id']:folder,second['id']:folder})

    def test_finalize_regular_assignment_keeps_latest_and_history_until_assignment_delete(self):
        assignment=self.create_assignment(active=True); self.submit_code(assignment); self.submit_code(assignment)
        saved=eagle._load_assignment(assignment['id']); sub=saved['submissions'][0]
        sub.update(codeScore=8,totalScore=8,teacherFeedback='Keep feedback',teacherFeedbackEdited=True,quizResponses=[{'questionId':'q','answer':'Keep answer'}])
        saved['studentExtensions']={self.student_email:{'until':'2099-01-01T00:00:00Z'}}; eagle._save_assignment(saved)
        paths=[eagle._assignment_submission_path(saved,record['path']) for version in [sub,*sub['history']] for record in version['files']]
        contents=[path.read_bytes() for path in paths]
        first=self.finalize(saved); self.assertEqual(first.status_code,200)
        self.assertEqual(self.finalize(saved).get_json()['gradingCompletedAt'],first.get_json()['gradingCompletedAt'])
        finalized=eagle._load_assignment(saved['id']); self.assertFalse(finalized['active'])
        self.assertEqual(finalized['submissions'],eagle._normalize_assignment_schema(saved)['submissions'])
        self.assertEqual([path.read_bytes() for path in paths],contents)
        self.assertFalse(fixtures.eagle.assignment_workflow.student_state(eagle,finalized,self.student_email)['canSubmit'])
        self.assertEqual(self.client.post('/api/assignments/update',headers=self.teacher_headers,json={'assignmentId':saved['id'],'active':True}).status_code,409)
        self.assertEqual(self.client.post('/api/assignments/extend-student',headers=self.teacher_headers,json={'assignmentId':saved['id'],'studentEmail':self.student_email,'days':2}).status_code,409)
        folder=self.new_folder(); self.folders(action='move',assignmentId=saved['id'],folderId=folder)
        self.assertEqual(self.client.post('/api/assignments/delete',headers=self.teacher_headers,json={'assignmentId':saved['id']}).status_code,200)
        self.assertTrue(all(not path.exists() for path in paths)); self.assertEqual(self.catalog()['assignments'],{})
        self.assertTrue((eagle._get_user_dir(self.student_email)/'answer.py').exists())

    def test_finalize_deletes_recordings_and_obsolete_bindings_but_not_submission_or_workspace(self):
        response=self.client.post('/api/assignments/create',headers=self.teacher_headers,json={
            'name':'Controlled','task':'Print','classId':self.class_one,'fileControl':True})
        assignment=response.get_json()['assignment']; assignment.update(active=True,releasedAt='2026-01-01T00:00:00Z'); eagle._save_assignment(assignment)
        visible=next(row for row in self.client.get('/api/assignments',headers=self.student_headers).get_json()['assignments'] if row['id']==assignment['id'])
        path=visible['controlledFilePath']; code='print(42)'
        recorded=self.client.post('/api/assignments/development/record',headers=self.student_headers,json={
            'assignmentId':assignment['id'],'batchId':uuid.uuid4().hex,'version':0,
            'frames':[{**development.splice('',code),'at':datetime.now(timezone.utc).isoformat()}]})
        self.assertEqual(recorded.status_code,200)
        self.client.post('/api/files/write',headers=self.student_headers,json={'path':path,'content':code})
        self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':assignment['id'],'filePath':path})
        saved=eagle._load_assignment(assignment['id']); snapshot=eagle._assignment_submission_path(saved,saved['submissions'][0]['submissionPath'])
        before=snapshot.read_bytes(); self.assertTrue(development._path(eagle,assignment['id']).exists())
        self.assertEqual(self.finalize(assignment).status_code,200)
        self.assertFalse(development._path(eagle,assignment['id']).exists()); self.assertIsNone(development.binding(eagle,assignment['id'],self.student_email))
        self.assertEqual(snapshot.read_bytes(),before); self.assertTrue((eagle._get_user_dir(self.student_email)/path).exists())

    def test_finalize_waits_for_pending_grading_and_cleanup_failure_can_be_retried(self):
        assignment=self.create_assignment(active=True); self.submit_code(assignment)
        assignment=eagle._load_assignment(assignment['id']); assignment['submissions'][0]['aiGradingStatus']='queued'; eagle._save_assignment(assignment)
        self.assertEqual(self.finalize(assignment).status_code,409); self.assertFalse(eagle._load_assignment(assignment['id'])['gradingCompletedAt'])
        assignment['submissions'][0]['aiGradingStatus']=''; eagle._save_assignment(assignment)
        with patch.object(development,'purge',side_effect=OSError('locked')):
            self.assertEqual(self.finalize(assignment).status_code,503)
        self.assertFalse(eagle._load_assignment(assignment['id'])['active'])
        self.assertEqual(self.finalize(assignment).status_code,200)
        self.assertEqual(self.finalize(assignment,self.student_headers).status_code,401)

    def test_class_delete_cleans_only_its_assignments_and_keeps_student_workspaces(self):
        first=self.create_assignment(active=True); self.submit_code(first)
        second=self.create_assignment(self.class_two,name='Other class',active=True)
        users=eagle._load_users(); user=next(user for user in users['users'] if user['email']==self.student_email)
        user['class_ids']=[self.class_one,self.class_two]; eagle._save_users(users)
        classes=eagle._load_classes(); classes['classes'][1]['students']=[self.student_email]; eagle._save_classes(classes)
        self.submit_code(second); folder=self.new_folder(); self.folders(action='move',folderId=folder,assignmentId=first['id'])
        first_dir=eagle._assignment_submission_directory(first); second_dir=eagle._assignment_submission_directory(second)
        response=self.client.post('/api/teacher/classes/delete',headers=self.teacher_headers,json={'classId':self.class_one})
        self.assertEqual(response.status_code,200,response.get_data(as_text=True))
        self.assertIsNone(eagle._load_assignment(first['id'])); self.assertFalse(first_dir.exists()); self.assertFalse(organization._path(eagle,self.class_one).exists())
        self.assertIsNotNone(eagle._load_assignment(second['id'])); self.assertTrue(second_dir.exists())
        self.assertTrue((eagle._get_user_dir(self.student_email)/'answer.py').exists())

    def test_class_cleanup_failure_keeps_class_and_assignment_metadata_for_retry(self):
        assignment=self.create_assignment(active=True); self.submit_code(assignment); self.new_folder()
        before=self.catalog()
        with patch.object(eagle.shutil,'rmtree',side_effect=OSError('locked')):
            response=self.client.post('/api/teacher/classes/delete',headers=self.teacher_headers,json={'classId':self.class_one})
        self.assertEqual(response.status_code,503)
        self.assertIsNotNone(eagle._find_class_by_id(self.class_one)); self.assertIsNotNone(eagle._load_assignment(assignment['id']))
        self.assertEqual(self.catalog(),before)
        response=self.client.post('/api/teacher/classes/delete',headers=self.teacher_headers,json={'classId':self.class_one})
        self.assertEqual(response.status_code,200)

    def test_public_plan_cleanup_failure_does_not_silently_delete_the_class(self):
        store = eagle.app.extensions.get('eagle_lesson_plan_store')
        with patch.object(store, 'delete_class', side_effect=OSError('fixture unavailable')):
            response = self.client.post('/api/teacher/classes/delete', headers=self.teacher_headers, json={'classId': self.class_one})
        self.assertEqual(response.status_code, 503)
        self.assertIsNotNone(eagle._find_class_by_id(self.class_one))
