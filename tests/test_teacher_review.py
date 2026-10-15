"""Make-up access, bounded grading, and submitted paste provenance."""
import copy
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import test_assignment_workflow as fixtures
import assignment_workflow as workflow
import file_provenance

eagle = fixtures.eagle


class TeacherReviewTestCase(unittest.TestCase):
    setUp = fixtures.AssignmentSubmissionTestCase.setUp
    tearDown = fixtures.AssignmentSubmissionTestCase.tearDown
    teacher_headers = fixtures.AssignmentSubmissionTestCase.teacher_headers
    student_headers = fixtures.AssignmentSubmissionTestCase.student_headers
    create_assignment = fixtures.AssignmentSubmissionTestCase.create_assignment
    update = fixtures.AssignmentSubmissionTestCase.update
    configure_class = fixtures.AssignmentSubmissionTestCase.configure_class
    bundle = fixtures.AssignmentSubmissionTestCase.bundle
    preview = fixtures.AssignmentSubmissionTestCase.preview
    def extend(self, a, days=3, email=None, headers=None):
        return self.client.post('/api/assignments/extend-student', headers=headers or self.teacher_headers,
                                json={'assignmentId': a['id'], 'studentEmail': email or self.student_email, 'days': days})

    def quiz(self, a):
        return self.update(a, quiz={'questions': [
            {'id':'one', 'type':'written', 'question':'Explain a loop', 'points':3},
            {'id':'two', 'type':'written_code', 'question':'What prints?', 'codeSnippet':'print(2)', 'points':4}]},
            quizSettings={'maxSubmissions':1})

    def answer(self, a):
        return self.client.post('/api/quiz/submit', headers=self.student_headers,
                                json={'assignmentId':a['id'], 'quizResponses':[{'questionId':'one','answer':'It repeats'}, {'questionId':'two','answer':'2'}]})

    def test_makeup_reopens_only_selected_student_and_expires(self):
        a = self.update(self.create_assignment(active=True), active=False, dueAt='2000-01-01T00:00:00Z')
        self.configure_class(window={'enabled':True,'start':'01:00','end':'01:01','timeZone':'UTC'})
        self.assertEqual(self.extend(a).status_code, 200)
        a = eagle._load_assignment(a['id'])
        now = datetime.now(timezone.utc)
        until = datetime.fromisoformat(a['studentExtensions'][self.student_email]['until'].replace('Z','+00:00'))
        self.assertAlmostEqual((until-now).total_seconds(),3*86400,delta=3)
        selected = workflow.student_state(eagle,a,self.student_email,now=now)
        other = workflow.student_state(eagle,a,self.missing_email,now=now)
        self.assertTrue(selected['canSubmit'])
        self.assertFalse(selected['isPast'])
        self.assertFalse(other['canSubmit'])
        self.assertFalse(workflow.student_state(eagle,a,self.student_email,now=until)['canSubmit'])
        payload = eagle._student_assignment_payload(a,self.student_email)
        self.assertNotIn('studentExtensions',payload)
        self.assertEqual(payload['dueAt'],a['studentExtensions'][self.student_email]['until'])
        self.assertEqual(self.extend(a,0).status_code,200)
        self.assertFalse(workflow.student_state(eagle,eagle._load_assignment(a['id']),self.student_email)['canSubmit'])

    def test_makeup_restores_one_attempt_without_erasing_evidence(self):
        a = self.quiz(self.update(self.create_assignment(active=True),maxFileSubmissions=1))
        self.bundle(a,{'answer.py':'print(1)'})
        self.assertEqual(self.answer(a).status_code,200)
        previous = copy.deepcopy(eagle._load_assignment(a['id'])['submissions'][0])
        a = self.update(a,active=False,dueAt='2000-01-01T00:00:00Z')
        self.assertEqual(self.extend(a).status_code,200)
        a = eagle._load_assignment(a['id'])
        self.assertEqual(a['submissions'][0]['revisionId'],previous['revisionId'])
        self.assertEqual(a['submissions'][0]['quizSubmissionCount'],1)
        self.assertEqual(self.client.get('/api/quiz/'+a['id'],headers=self.student_headers).get_json()['remainingSubmissions'],1)
        self.assertTrue(eagle._student_assignment_payload(a,self.student_email)['canSubmitFiles'])
        self.assertEqual(self.answer(a).status_code,200)
        self.bundle(a,{'answer.py':'print(2)'})
        self.assertEqual(self.answer(a).status_code,403)
        payload = eagle._student_assignment_payload(eagle._load_assignment(a['id']),self.student_email)
        self.assertFalse(payload['canSubmitFiles'])
        self.assertTrue(eagle._load_assignment(a['id'])['submissions'][0]['history'])

    def test_extension_validation_and_roles(self):
        a = self.create_assignment(active=True)
        for value in [True,-1,366,1.5,'3',None]:
            self.assertEqual(self.extend(a,value).status_code,400,value)
        self.assertEqual(self.extend(a,email='outsider@example.com').status_code,404)
        self.assertEqual(self.extend(a,headers=self.student_headers).status_code,401)
        other = {'role':'teacher','email':'other@example.com'}
        with unittest.mock.patch.object(eagle,'_assignment_actor',return_value=other):
            self.assertEqual(self.extend(a).status_code,403)
        with unittest.mock.patch.object(eagle,'_assignment_actor',return_value={'is_coteacher':True,'email':self.student_email,'role':'teacher'}):
            self.assertEqual(self.extend(a).status_code,403)
        draft=self.create_assignment(name='Draft')
        self.assertEqual(self.extend(draft).status_code,409)
        a=self.update(a,active=False)
        a['studentExtensions']={self.student_email:{'until':'invalid'}}
        eagle._save_assignment(a)
        self.assertFalse(workflow.student_state(eagle,eagle._load_assignment(a['id']),self.student_email)['canSubmit'])

    def score(self,a,score,**extra):
        return self.client.post('/api/quiz/override-score',headers=self.teacher_headers,
                                json={'assignmentId':a['id'],'studentEmail':self.student_email,'questionId':'one','manualScore':score,**extra})

    def test_fractional_question_scoring_validation_and_revision_guards(self):
        a=self.quiz(self.create_assignment(active=True)); self.assertEqual(self.answer(a).status_code,200)
        revision=eagle._load_assignment(a['id'])['submissions'][0]['revisionId']
        self.assertEqual(self.score(a,1.5,revisionId=revision).get_json()['quizScore'],1.5)
        self.assertEqual(self.score(a,0).get_json()['totalScore'],0)
        self.assertEqual(self.score(a,3).get_json()['quizScore'],3)
        for value in [-1,3.1,True,'2',float('inf'),float('nan')]:
            self.assertEqual(self.score(a,value).status_code,400,value)
        self.assertEqual(self.score(a,2,revisionId='old').status_code,409)
        self.assertEqual(self.score(a,None).get_json()['quizScore'],0)
        self.assertEqual(self.score(a,2,questionId='missing').status_code,404)
        with unittest.mock.patch.object(eagle,'_assignment_actor',return_value=None):
            self.assertEqual(self.score(a,2).status_code,401)

    def test_concurrent_question_scores_do_not_overwrite_other_questions(self):
        a=self.quiz(self.create_assignment(active=True)); self.answer(a)
        def save(question):
            with eagle.app.test_client() as client:
                return client.post('/api/quiz/score-question',headers=self.teacher_headers,json={
                    'assignmentId':a['id'],'studentEmail':self.student_email,'questionId':question,'manualScore':1.5}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(save,['one','two'])),[200,200])
        self.assertEqual(eagle._load_assignment(a['id'])['submissions'][0]['quizScore'],3)

    def test_slow_ai_question_result_preserves_manual_scores_and_rejects_new_revisions(self):
        a=self.quiz(self.create_assignment(active=True)); self.answer(a)
        def model(*args,**kwargs):
            self.assertEqual(self.score(a,3).status_code,200)
            self.assertIn('It repeats',args[2])
            self.assertNotIn('forged browser answer',args[2])
            return {'ok':True,'text':'1'}
        body={'assignmentId':a['id'],'studentEmail':self.student_email,'questionId':'one','answer':'forged browser answer','maxPoints':100}
        with unittest.mock.patch.object(eagle,'_effective_ai_enabled',return_value=(True,'')), unittest.mock.patch.object(eagle,'call_ollama_generate',side_effect=model):
            result=self.client.post('/api/quiz/grade-written',headers=self.teacher_headers,json=body)
        self.assertEqual(result.status_code,200,result.get_data(as_text=True))
        self.assertEqual(eagle._load_assignment(a['id'])['submissions'][0]['quizScore'],3)
        def changed(*args,**kwargs):
            latest=eagle._load_assignment(a['id']); latest['submissions'][0]['revisionId']='new-revision'; eagle._save_assignment(latest)
            return {'ok':True,'text':'0'}
        with unittest.mock.patch.object(eagle,'_effective_ai_enabled',return_value=(True,'')), unittest.mock.patch.object(eagle,'call_ollama_generate',side_effect=changed):
            result=self.client.post('/api/quiz/grade-written',headers=self.teacher_headers,json=body)
        self.assertEqual(result.status_code,409)
        self.assertEqual(eagle._load_assignment(a['id'])['submissions'][0]['quizScore'],3)

    def test_duplicate_unknown_and_malformed_student_answers_are_rejected(self):
        a=self.quiz(self.create_assignment(active=True))
        for values in [[{'questionId':'one','answer':'a'}]*2,[{'questionId':'missing','answer':'a'}],['bad'],{},[{'questionId':'one','answer':5}]]:
            r=self.client.post('/api/quiz/submit',headers=self.student_headers,json={'assignmentId':a['id'],'quizResponses':values})
            self.assertEqual(r.status_code,400)

    def write(self,content,ranges,path='answer.py'):
        response=self.client.post('/api/files/write',headers=self.student_headers,json={'path':path,'content':content,'pasteRanges':ranges})
        self.assertEqual(response.status_code,200,response.get_data(as_text=True))

    def test_paste_ranges_persist_in_immutable_submission_and_teacher_previews_only(self):
        a=self.create_assignment(active=True)
        text='x = 1\nprint("🙂")\n'
        start=file_provenance.length('x = 1\n'); end=file_provenance.length(text)-1
        self.write(text,[[start,end]])
        root=eagle._get_user_dir(self.student_email)
        self.assertFalse((root/'file_provenance').exists())
        response=self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePaths':['answer.py']})
        self.assertEqual(response.status_code,200)
        self.assertNotIn('pasteRanges',json.dumps(response.get_json()))
        a=eagle._load_assignment(a['id']); sub=a['submissions'][0]
        teacher=self.preview(a,sub,teacher=True).get_json()
        ranges=teacher['pasteRanges']; self.assertTrue(ranges)
        raw=teacher['content'].encode('utf-16-le')
        self.assertEqual(raw[ranges[0][0]*2:ranges[0][1]*2].decode('utf-16-le'),'print("🙂")')
        self.assertNotIn('pasteRanges',self.preview(a,sub).get_json())
        self.assertTrue(workflow.teacher_payload(eagle,a)['submissions'][0]['hasPastedText'])
        opened=self.client.get('/api/assignments/submission',headers=self.teacher_headers,query_string={'assignmentId':a['id'],'studentEmail':self.student_email}).get_json()
        self.assertEqual(opened['pasteRanges'],ranges)
        self.write('x = 2',[])
        self.assertEqual(self.preview(a,sub,teacher=True).get_json()['pasteRanges'],ranges)

    def test_paste_ranges_follow_rename_trash_restore_and_api_writes(self):
        self.write('before\npasted\nafter\n',[[7,13]])
        root=eagle._get_user_dir(self.student_email)
        rename=self.client.post('/api/files/rename',headers=self.student_headers,json={'old_path':'answer.py','new_name':'renamed.py'})
        self.assertEqual(rename.status_code,200)
        target=root/'renamed.py'
        self.assertEqual(file_provenance.read(eagle,root,target,target.read_text()),[[7,13]])
        destination,_=eagle._move_workspace_item_to_trash(root,target)
        self.assertEqual(file_provenance.read(eagle,root,destination,destination.read_text()),[[7,13]])
        restored=eagle._restore_workspace_item(root,destination)
        self.assertEqual(file_provenance.read(eagle,root,restored,restored.read_text()),[[7,13]])
        response=self.client.post('/api/files/write',headers=self.student_headers,json={'path':'renamed.py','content':'!before\npasted\nafter\n'})
        self.assertEqual(response.status_code,200)
        self.assertEqual(file_provenance.read(eagle,root,restored,restored.read_text()),[[8,14]])
        duplicated=self.client.post('/api/files/duplicate',headers=self.student_headers,json={'src':'renamed.py'})
        self.assertEqual(duplicated.status_code,200)
        copy_path=root/duplicated.get_json()['new_path']
        self.assertEqual(file_provenance.read(eagle,root,copy_path,copy_path.read_text()),[[8,14]])
        self.assertEqual(file_provenance.read(eagle,root,restored,restored.read_text()),[[8,14]])
        trashed,_=eagle._move_workspace_item_to_trash(root,copy_path)
        private,_=file_provenance.location(eagle,root,trashed)
        eagle._permanently_delete_trash_item(root,trashed)
        self.assertFalse(private.exists())

    def test_invalid_ranges_do_not_write_source(self):
        for ranges in [[[0,999]],[[True,2]],[[-1,2]],'bad',[[1,2]]*513]:
            response=self.client.post('/api/files/write',headers=self.student_headers,json={'path':'answer.py','content':'abc','pasteRanges':ranges})
            self.assertEqual(response.status_code,400)
        self.assertFalse((eagle._get_user_dir(self.student_email)/'answer.py').exists())

    def test_account_deletion_removes_private_workspace_provenance(self):
        self.write('pasted',[[0,6]])
        root=eagle._get_user_dir(self.student_email)
        private=file_provenance.directory(eagle,root)
        self.assertTrue(private.exists())
        self.assertTrue(eagle._delete_user_by_email(self.student_email))
        self.assertFalse(private.exists())


if __name__ == '__main__':
    unittest.main()
