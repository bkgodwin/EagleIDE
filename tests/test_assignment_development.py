"""Controlled file identity, private playback, retry safety, and retention."""
import io
import json
import sqlite3
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import test_assignment_workflow as fixtures
import assignment_development as development

eagle = fixtures.eagle


class DevelopmentTests(unittest.TestCase):
    setUp = fixtures.AssignmentSubmissionTestCase.setUp
    tearDown = fixtures.AssignmentSubmissionTestCase.tearDown
    teacher_headers = fixtures.AssignmentSubmissionTestCase.teacher_headers
    student_headers = fixtures.AssignmentSubmissionTestCase.student_headers

    def create(self, **options):
        response = self.client.post('/api/assignments/create', headers=self.teacher_headers, json={
            'name':'Loop project', 'task':'Write a loop', 'classId':self.class_one,
            'fileControl':True, 'fileControlExtension':'.py', **options})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assignment = response.get_json()['assignment']
        assignment.update(active=True, releasedAt='2026-01-01 00:00:00', createdAt='2026-01-01T00:00:00+00:00')
        eagle._save_assignment(assignment)
        result = self.client.get('/api/assignments', headers=self.student_headers).get_json()
        visible = next(a for a in result['assignments'] if a['id'] == assignment['id'])
        self.assertTrue(visible.get('controlledFilePath'), visible)
        return assignment, visible['controlledFilePath']

    def record(self, a, frames, version=0, batch=None, headers=None):
        return self.client.post('/api/assignments/development/record', headers=headers or self.student_headers,
                                json={'assignmentId':a['id'], 'frames':frames, 'version':version, 'batchId':batch or uuid.uuid4().hex})

    def frame(self, before, after, at=None):
        return {**development.splice(before, after), 'at':at or datetime.now(timezone.utc).isoformat(timespec='milliseconds')}

    def playback(self, a, **args):
        return self.client.get('/api/assignments/development', headers=self.teacher_headers,
                               query_string={'assignmentId':a['id'], 'studentEmail':self.student_email, **args})

    def test_new_file_does_not_overwrite_existing_work_or_recreate_binding(self):
        root = eagle._get_user_dir(self.student_email)
        (root/'Loop project.py').write_text('keep this', encoding='utf-8')
        a, path = self.create()
        self.assertEqual(path, 'Loop project (2).py')
        self.assertEqual((root/'Loop project.py').read_text(), 'keep this')
        self.assertEqual((root/path).read_text(), '')
        self.assertIsNone(development.binding(eagle, a['id'], self.missing_email))
        (root/path).unlink()
        self.client.get('/api/assignments', headers=self.student_headers)
        self.assertFalse((root/path).exists())

    def test_options_strict_and_fixed_and_copy_gets_new_recording_identity(self):
        for value in ['true', 1, [], None]:
            r = self.client.post('/api/assignments/create', headers=self.teacher_headers,
                                 json={'name':'Bad', 'classId':self.class_one,'fileControl':value})
            self.assertEqual(r.status_code, 400)
        a, path = self.create()
        for change in [{'fileControl':False}, {'fileControlExtension':'.js'}, {'allowMultiFileSubmission':True}, {'allowFileSubmission':False}, {'classId':self.class_two}]:
            r = self.client.post('/api/assignments/update', headers=self.teacher_headers, json={'assignmentId':a['id'], **change})
            self.assertIn(r.status_code, (400,409), change)
        copied = self.client.post('/api/assignments/copy-to-class', headers=self.teacher_headers,
                                 json={'assignmentId':a['id'], 'targetClassId':self.class_two}).get_json()['assignment']
        self.assertTrue(copied['fileControl'])
        self.assertNotEqual(copied['id'], a['id'])
        self.assertIsNone(development.binding(eagle, copied['id'], self.student_email))

    def test_active_file_cannot_move_delete_rename_or_be_replaced_by_upload(self):
        a, path = self.create()
        root = eagle._get_user_dir(self.student_email)
        (root/'folder').mkdir()
        for url, method, body in [('rename','post',{'old_path':path,'new_name':'cheat.py'}),
                                  ('move','post',{'src':path,'dest':'folder'}), ('delete','delete',{'path':path})]:
            r = getattr(self.client,method)('/api/files/'+url, headers=self.student_headers,json=body)
            self.assertEqual(r.status_code,403,r.get_data(as_text=True))
        r = self.client.post('/api/files/upload', headers=self.student_headers,
                             data={'file':(io.BytesIO(b'cheat'),path)}, content_type='multipart/form-data')
        self.assertEqual(r.status_code,403)
        r = self.client.post('/api/files/upload', headers=self.student_headers,
                             data={'file':(io.BytesIO(b'cheat'),'C:fakepath'+path)}, content_type='multipart/form-data')
        self.assertEqual(r.status_code,403)
        self.assertIn(str((root/path).resolve()), development.protected_paths(eagle,root))
        a['dueAt']='2000-01-01T00:00:00Z'; eagle._save_assignment(a)
        r=self.client.post('/api/files/move',headers=self.student_headers,json={'src':path,'dest':'folder'})
        self.assertEqual(r.status_code,200)
        self.client.get('/api/assignments', headers=self.student_headers)
        self.assertFalse((root/path).exists())

    def test_effective_deadline_and_makeup_keep_file_protected(self):
        a,path=self.create()
        a['dueAt']='2000-01-01T00:00:00Z'
        a['studentExtensions']={self.student_email:{'until':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}}
        eagle._save_assignment(a)
        r=self.client.delete('/api/files/delete',headers=self.student_headers,json={'path':path})
        self.assertEqual(r.status_code,403)

    def test_manual_reopen_after_due_date_still_records_new_work(self):
        a,path=self.create()
        a.update(dueAt='2026-01-02T00:00:00Z',dueLockOverride=True,active=True)
        eagle._save_assignment(a)
        response=self.record(a,[self.frame('','print("retest")')])
        self.assertEqual(response.status_code,200,response.get_data(as_text=True))
        self.assertEqual(response.get_json()['version'],1)
        self.assertFalse(response.get_json()['stopped'])

    def test_only_bound_file_is_submittable_and_uploads_rejected(self):
        a,path=self.create()
        root=eagle._get_user_dir(self.student_email)
        (root/'other.py').write_text('print(1)',encoding='utf-8')
        for paths in [['other.py'],[path,'other.py'],['../'+path]]:
            r=self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePaths':paths})
            self.assertEqual(r.status_code,400)
        r=self.client.post('/api/assignments/submit',headers=self.student_headers,
                           data={'payload':json.dumps({'assignmentId':a['id'],'filePaths':[path]}),'files':(io.BytesIO(b'print(1)'),path)},content_type='multipart/form-data')
        self.assertEqual(r.status_code,400)
        r=self.client.post('/api/files/write',headers=self.student_headers,json={'path':path,'content':'print(2)','require_existing':True})
        self.assertEqual(r.status_code,200,r.get_data(as_text=True))
        r=self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePaths':[path]})
        self.assertEqual(r.status_code,200,r.get_data(as_text=True))
        self.assertEqual(len(r.get_json()['submission']['files']),1)

    def test_unicode_deltas_changed_only_durable_and_idempotent(self):
        a,path=self.create()
        values=['print("😀")','print("😀!")','print("😀!")','print("done")']
        before=''; frames=[]
        for value in values:
            frames.append(self.frame(before,value)); before=value
        batch=uuid.uuid4().hex
        r=self.record(a,frames,batch=batch)
        self.assertEqual(r.status_code,200,r.get_data(as_text=True))
        self.assertEqual(r.get_json()['version'],3)
        self.assertEqual(self.record(a,frames,batch=batch).get_json()['version'],3)
        data=self.playback(a).get_json()
        content=data['base']
        for f in data['frames']: content=development.apply_patch(content,f)
        self.assertEqual(content,values[-1])
        self.assertEqual(data['total'],3)
        self.assertTrue(all(f['receivedAt'] for f in data['frames']))
        read=self.client.get('/api/files/read',headers=self.student_headers,query_string={'path':path}).get_json()
        self.assertEqual(read['development']['version'],3)
        self.assertEqual(read['development']['content'],values[-1])
        conflict=self.record(a,[self.frame('','bad')])
        self.assertEqual(conflict.status_code,409)
        self.assertEqual(conflict.get_json()['content'],values[-1])

    def test_checkpoint_seek_storage_and_bad_batch_rollback(self):
        a,_=self.create()
        content='x'*20000; version=0
        for i in range(0,150,30):
            frames=[]
            for j in range(30):
                new=content+str(i+j)
                frames.append(self.frame('' if i+j==0 else content,new)); content=new
            r=self.record(a,frames,version)
            self.assertEqual(r.status_code,200,r.get_data(as_text=True));version=r.get_json()['version']
        data=self.playback(a,cursor=148).get_json()
        result=data['base']
        for f in data['frames']:result=development.apply_patch(result,f)
        self.assertEqual(result,content)
        self.assertLess(development._path(eagle,a['id']).stat().st_size,300000)
        bad=[self.frame(content,'good'),{'at':datetime.now(timezone.utc).isoformat(),'from':999999,'delete':0,'insert':'bad'}]
        self.assertEqual(self.record(a,bad,version).status_code,400)
        self.assertEqual(self.playback(a,index='1').get_json()['total'],version)

    def test_private_history_authorization_caps_and_cleanup_releases_disk(self):
        a,path=self.create()
        self.assertEqual(self.record(a,[self.frame('','hello')]).status_code,200)
        args={'assignmentId':a['id'],'studentEmail':self.student_email}
        self.assertEqual(self.client.get('/api/assignments/development',headers=self.student_headers,query_string=args).status_code,401)
        token='other-history-teacher';eagle._teacher_tokens[token]={'email':'other@example.com','role':'teacher'}
        users = eagle._load_users(); users['users'].append({'email':'other@example.com','role':'teacher'}); eagle._save_users(users)
        try:
            self.assertEqual(self.client.get('/api/assignments/development',headers={'X-Teacher-Token':token},query_string=args).status_code,403)
        finally:eagle._teacher_tokens.pop(token)
        with patch.object(development,'MAX_STREAM_BYTES',1):
            r=self.record(a,[self.frame('hello','world')],1)
            self.assertEqual(r.status_code,400)
        r=self.client.post('/api/files/write',headers=self.student_headers,json={'path':path,'content':'still saved'})
        self.assertTrue(r.get_json()['ok'])
        self.assertEqual(self.client.post('/api/assignments/grading-complete',headers=self.student_headers,json={'assignmentId':a['id']}).status_code,401)
        r=self.client.post('/api/assignments/grading-complete',headers=self.teacher_headers,json={'assignmentId':a['id']})
        self.assertEqual(r.status_code,200,r.get_data(as_text=True))
        self.assertFalse(development._path(eagle,a['id']).exists())
        self.assertEqual(self.playback(a).get_json()['total'],0)
        self.assertEqual(self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePath':path}).status_code,403)
        self.assertEqual(self.client.post('/api/assignments/update',headers=self.teacher_headers,json={'assignmentId':a['id'],'active':True}).status_code,409)
        self.assertTrue(self.record(a,[self.frame('','again')]).get_json()['stopped'])
        self.assertFalse(development._path(eagle,a['id']).exists())
        self.assertEqual(self.client.delete('/api/files/delete',headers=self.student_headers,json={'path':path}).status_code,200)

    def test_clipboard_modes_outstanding_submission_and_unsubmit(self):
        a,path=self.create()
        def configure(mode):
            return self.client.post('/api/teacher/classes/settings',headers=self.teacher_headers,json={'classId':self.class_one,'settings':{'editor_clipboard':mode}})
        def blocked():return self.client.get('/api/editor/policy',headers=self.student_headers).get_json()['clipboardBlocked']
        self.assertFalse(blocked())
        self.assertEqual(configure('invalid').status_code,400)
        self.assertEqual(configure('block').status_code,200);self.assertTrue(blocked())
        self.assertEqual(configure('outstanding').status_code,200);self.assertTrue(blocked())
        self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePaths':[path]})
        self.assertFalse(blocked())
        assignment=eagle._load_assignment(a['id']);assignment['submissions'][0]['withdrawn']=True;eagle._save_assignment(assignment)
        self.assertTrue(blocked())
        assignment['active']=False;eagle._save_assignment(assignment);self.assertFalse(blocked())
        configure('allow');self.assertFalse(blocked())

    def test_coteacher_can_play_but_cannot_purge_and_revocation_is_immediate(self):
        a,_=self.create()
        self.assertEqual(self.record(a,[self.frame('','print(1)')]).status_code,200)
        classes=eagle._load_classes();classes['classes'][0]['coteachers']=[self.missing_email];eagle._save_classes(classes)
        token='development-coteacher'
        eagle._student_tokens[token]={'email':self.missing_email,'role':'student','class_ids':[self.class_one]}
        self.addCleanup(eagle._student_tokens.pop,token,None)
        headers={'X-Teacher-Token':token};args={'assignmentId':a['id'],'studentEmail':self.student_email}
        self.assertEqual(self.client.get('/api/assignments/development',headers=headers,query_string=args).status_code,200)
        self.assertEqual(self.client.post('/api/assignments/grading-complete',headers=headers,json={'assignmentId':a['id']}).status_code,403)
        classes['classes'][0]['coteachers']=[];eagle._save_classes(classes)
        self.assertEqual(self.client.get('/api/assignments/development',headers=headers,query_string=args).status_code,401)

    def test_classroom_policy_cache_excludes_source_and_invalidates_after_save(self):
        a,path=self.create()
        self.client.post('/api/files/write',headers=self.student_headers,json={'path':path,'content':'print("DO_NOT_CACHE_SOURCE")'})
        self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePath':path})
        assignment=eagle._load_assignment(a['id']);assignment['submissions'][0]['withdrawn']=True;eagle._save_assignment(assignment)
        self.client.post('/api/teacher/classes/settings',headers=self.teacher_headers,
                         json={'classId':self.class_one,'settings':{'editor_clipboard':'outstanding'}})
        with patch.object(eagle,'_list_assignments',wraps=eagle._list_assignments) as listings:
            for _ in range(2):
                self.assertTrue(self.client.get('/api/editor/policy',headers=self.student_headers).get_json()['clipboardBlocked'])
            self.assertEqual(listings.call_count,1)
            self.assertNotIn('DO_NOT_CACHE_SOURCE',json.dumps(development._policy_cache[2]))
            assignment['submissions'][0]['withdrawn']=False;eagle._save_assignment(assignment)
            self.assertFalse(self.client.get('/api/editor/policy',headers=self.student_headers).get_json()['clipboardBlocked'])
            self.assertEqual(listings.call_count,2)

    def test_completion_retains_scores_feedback_and_immutable_submission(self):
        a,path=self.create()
        self.client.post('/api/files/write',headers=self.student_headers,json={'path':path,'content':'print(42)'})
        self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePath':path})
        assignment=eagle._load_assignment(a['id']);sub=assignment['submissions'][0]
        sub.update(codeScore=85,totalScore=85,teacherFeedback='Good work',teacherFeedbackEdited=True)
        eagle._save_assignment(assignment)
        snapshot=eagle._assignment_submission_path(assignment,sub['submissionPath']);before=snapshot.read_bytes()
        response=self.client.post('/api/assignments/grading-complete',headers=self.teacher_headers,json={'assignmentId':a['id']})
        self.assertEqual(response.status_code,200)
        saved=eagle._load_assignment(a['id'])['submissions'][0]
        self.assertEqual(saved['codeScore'],85);self.assertEqual(saved['teacherFeedback'],'Good work')
        self.assertEqual(snapshot.read_bytes(),before)
        self.assertTrue((eagle._get_user_dir(self.student_email)/path).exists())
