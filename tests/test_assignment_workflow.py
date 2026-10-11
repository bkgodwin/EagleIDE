"""Deadline, attachment, history, and role-boundary regressions."""
import copy
import io
import json
import threading
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import test_assignments as fixtures
import assignment_workflow as workflow

eagle = fixtures.eagle


class AssignmentSubmissionTestCase(unittest.TestCase):
    def setUp(self):
        fixtures.AssignmentWorkflowTestCase.setUp(self)
        eagle._get_user_dir(self.student_email).mkdir(parents=True, exist_ok=True)
    tearDown = fixtures.AssignmentWorkflowTestCase.tearDown
    teacher_headers = fixtures.AssignmentWorkflowTestCase.teacher_headers
    student_headers = fixtures.AssignmentWorkflowTestCase.student_headers
    create_assignment = fixtures.AssignmentWorkflowTestCase.create_assignment
    submit_code = fixtures.AssignmentWorkflowTestCase.submit_code

    def update(self, assignment, **values):
        response = self.client.post('/api/assignments/update', headers=self.teacher_headers,
                                    json={'assignmentId': assignment['id'], **values})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return eagle._load_assignment(assignment['id'])

    def configure_class(self, support=None, window=None):
        catalog = eagle._load_classes()
        cls = catalog['classes'][0]
        if support is not None:
            cls['accommodations'] = {self.student_email: support}
        if window is not None:
            cls['settings']['assignment_submission_window'] = window
        eagle._save_classes(catalog)

    def state(self, a, time, email=None):
        return workflow.student_state(eagle, a, email or self.student_email,
                                      now=datetime.fromisoformat(time.replace('Z', '+00:00')))

    def bundle(self, a, files=None):
        root = eagle._get_user_dir(self.student_email)
        root.mkdir(parents=True, exist_ok=True)
        files = files or {'one.py': 'print("one")', 'two.js': 'console.log("two")', 'data.csv': 'x,y\n1,2\n'}
        for name, content in files.items():
            (root / name).write_text(content, encoding='utf-8')
        response = self.client.post('/api/assignments/submit', headers=self.student_headers,
                                    json={'assignmentId': a['id'], 'filePaths': list(files)})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return eagle._load_assignment(a['id'])['submissions'][0]

    def preview(self, a, sub, file=0, teacher=False, **params):
        args = {'assignmentId': a['id'], 'fileId': workflow.files_for(sub)[file]['id'], **params}
        if teacher:
            args['studentEmail'] = self.student_email
        return self.client.get('/api/assignments/submission-file', query_string=args,
                               headers=self.teacher_headers if teacher else self.student_headers)

    def test_weekday_extension_private_deadline_and_current_placement(self):
        a = self.update(self.create_assignment(active=True), dueAt='2026-10-09T20:00:00Z')
        self.configure_class({'extendedWeekdays': 2, 'noDueDate': False}, {'timeZone': 'America/Chicago'})
        state = self.state(a, '2026-10-12T20:00:00Z')
        self.assertEqual(state['dueAt'], '2026-10-13T20:00:00.000Z')
        self.assertFalse(state['isPast'])
        self.assertTrue(state['canSubmit'])
        self.assertEqual(state['accommodationNote'], 'Extended deadline provided per accommodation')
        other = self.state(a, '2026-10-12T20:00:00Z', self.missing_email)
        self.assertTrue(other['isPast'])
        self.assertEqual(other['accommodationNote'], '')
        self.assertTrue(self.state(a, '2026-10-13T20:00:01Z')['isPast'])

    def test_extension_preserves_local_time_over_dst(self):
        a = self.update(self.create_assignment(active=True), dueAt='2026-10-30T20:00:00Z')
        self.configure_class({'extendedWeekdays': 1}, {'timeZone': 'America/Chicago'})
        self.assertEqual(self.state(a, '2026-10-31T20:00:00Z')['dueAt'], '2026-11-02T21:00:00.000Z')

    def test_no_due_date_stays_past_but_allows_late_until_manual_lock(self):
        a = self.update(self.create_assignment(active=True), dueAt='2000-01-01T12:00:00Z')
        self.configure_class({'noDueDate': True})
        state = self.state(a, '2026-10-12T20:00:00Z')
        self.assertTrue(state['isPast'])
        self.assertTrue(state['canSubmit'])
        self.assertEqual(state['dueAt'], '')
        self.submit_code(a)
        a = self.update(a, active=False)
        self.assertFalse(self.state(a, '2026-10-12T20:00:00Z')['canSubmit'])

    def test_class_window_weekday_timezone_boundaries_and_override(self):
        a = self.create_assignment(active=True)
        self.configure_class(window={'enabled': True, 'start': '08:00', 'end': '15:00', 'timeZone': 'America/Chicago'})
        for time, allowed in [('2026-10-12T12:59:59Z', False), ('2026-10-12T13:00:00Z', True),
                              ('2026-10-12T19:59:59Z', True), ('2026-10-12T20:00:00Z', False),
                              ('2026-10-10T16:00:00Z', False)]:
            self.assertEqual(self.state(a, time)['canSubmit'], allowed, time)
        weekend = self.state(a, '2026-10-10T16:00:00Z')
        self.assertEqual(weekend['nextWindowChangeAt'], '2026-10-12T13:00:00.000Z')
        a = self.update(a, allowSubmissionAnyTime=True)
        self.assertTrue(self.state(a, '2026-10-10T16:00:00Z')['canSubmit'])
        a = self.update(a, active=False)
        self.assertFalse(self.state(a, '2026-10-10T16:00:00Z')['canSubmit'])

    def test_files_and_questions_enforce_identical_window(self):
        a = self.create_assignment(active=True)
        denied = {**workflow.student_state(eagle, a, self.student_email), 'canSubmit': False,
                  'submissionWindowOpen': False, 'submissionWindowMessage': 'School hours only'}
        with patch.object(workflow, 'student_state', return_value=denied):
            for url, body in [('/api/assignments/submit', {'filePath': 'answer.py'}),
                              ('/api/quiz/submit', {'responses': []})]:
                response = self.client.post(url, headers=self.student_headers, json={'assignmentId': a['id'], **body})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.get_json()['error'], 'School hours only')

    def test_roster_support_owner_only_and_never_in_student_class_catalog(self):
        endpoint = f'/api/teacher/classes/{self.class_one}/accommodations'
        body = {'studentEmail': self.student_email, 'accommodations': {'extendedWeekdays': 2, 'noDueDate': False}}
        self.assertEqual(self.client.post(endpoint, headers=self.student_headers, json=body).status_code, 401)
        self.assertEqual(self.client.post(endpoint, headers=self.teacher_headers, json=body).status_code, 200)
        catalog = self.client.get('/api/teacher/classes', headers=self.teacher_headers).get_json()
        student = next(s for s in catalog['classes'][0]['students'] if s['email'] == self.student_email)
        self.assertEqual(student['accommodations']['extendedWeekdays'], 2)
        summary = eagle._serialize_class_summary(eagle._find_class_by_id(self.class_one))
        self.assertNotIn('accommodations', summary)
        for bad in [1.5, -1, True, 366]:
            body['accommodations']['extendedWeekdays'] = bad
            self.assertEqual(self.client.post(endpoint, headers=self.teacher_headers, json=body).status_code, 400)

    def test_window_validation_and_legacy_defaults(self):
        endpoint = f'/api/teacher/classes/{self.class_one}/submission-window'
        for window in [{'start':'15:00','end':'08:00'}, {'timeZone':'Mars/School'}, {'enabled':'yes'}]:
            self.assertEqual(self.client.post(endpoint, headers=self.teacher_headers, json={'window':window}).status_code, 400)
        a = self.create_assignment(active=True)
        self.assertFalse(a['allowMultiFileSubmission'])
        self.assertFalse(a['allowSubmissionAnyTime'])
        self.assertEqual(a['maxFileSubmissions'], 0)
        for value in [-1, 1.5, True, 101, None]:
            r = self.client.post('/api/assignments/create', headers=self.teacher_headers,
                                 json={'name':'Bad', 'task':'Task', 'classId':self.class_one, 'maxFileSubmissions':value})
            self.assertEqual(r.status_code, 400)

    def test_all_sources_bundled_but_only_python_and_js_graded(self):
        a = self.update(self.create_assignment(active=True), allowMultiFileSubmission=True)
        sub = self.bundle(a)
        parents = {(self.submissions_dir / f['path']).parent for f in sub['files']}
        self.assertEqual(len(parents), 1)
        self.assertIn('print("one")', sub['code'])
        self.assertIn('console.log("two")', sub['code'])
        self.assertNotIn('1,2', sub['code'])
        self.assertTrue(workflow.has_gradable_files(sub))
        anon = eagle._external_grading_submission_code(a, sub)
        for private in ['one.py', 'two.js', 'Student One', self.student_email, '# Submitted']:
            self.assertNotIn(private, anon)
        self.assertIn('Source file 2 (.js)', anon)
        self.assertEqual(self.preview(a, sub, 2).get_json()['kind'], 'csv')
        self.assertEqual(self.preview(a, sub, 2).get_json()['rows'], [['1','2']])

    def test_any_type_upload_download_is_safe_and_js_keeps_valid_syntax(self):
        a = self.update(self.create_assignment(active=True), allowMultiFileSubmission=True)
        response = self.client.post('/api/assignments/submit', headers=self.student_headers,
            data={'payload': json.dumps({'assignmentId':a['id'], 'filePaths':[]}),
                  'files':[(io.BytesIO(b'console.log("valid")'), 'answer.js'),
                           (io.BytesIO(b'\x00\xff\x01'), 'report.pdf'),
                           (io.BytesIO(b'<script>alert(1)</script>'), 'page.html')]})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        sub = eagle._load_assignment(a['id'])['submissions'][0]
        self.assertEqual((self.submissions_dir / sub['files'][0]['path']).read_text(), 'console.log("valid")')
        self.assertEqual(self.preview(a,sub,1).get_json()['kind'], 'download')
        download = self.preview(a,sub,2,download='1')
        self.assertEqual(download.mimetype, 'application/octet-stream')
        self.assertIn('attachment;', download.headers['Content-Disposition'])
        self.assertEqual(download.headers['X-Content-Type-Options'], 'nosniff')
        download.close()
        self.assertEqual(self.preview(a,sub,2).get_json()['kind'], 'text')

    def test_single_file_mode_and_invalid_paths_and_quiz_bypass(self):
        a = self.create_assignment(active=True)
        root = eagle._get_user_dir(self.student_email)
        (root / 'one.py').write_text('print(1)')
        (root / 'two.py').write_text('print(2)')
        for values in [{'filePaths':['one.py','two.py']}, {'filePaths':['one.py','one.py']},
                       {'filePaths':['../secret.py']}, {'filePaths':['.eagleide/trash.json']},
                       {'filePaths':['Trash/answer.py']}, {'filePath':'one.py','quizResponses':[{'questionId':'q'}]}]:
            r = self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],**values})
            self.assertEqual(r.status_code,400, values)
        self.assertEqual(eagle._load_assignment(a['id'])['submissions'], [])

    def test_bundle_size_and_code_encoding_rejected_without_partial_storage(self):
        a = self.update(self.create_assignment(active=True), allowMultiFileSubmission=True)
        with patch.object(workflow,'MAX_BUNDLE_BYTES',5):
            r = self.client.post('/api/assignments/submit',headers=self.student_headers,
                data={'payload':json.dumps({'assignmentId':a['id']}),'files':(io.BytesIO(b'123456'),'data.bin')})
            self.assertEqual(r.status_code,400)
        r = self.client.post('/api/assignments/submit',headers=self.student_headers,
            data={'payload':json.dumps({'assignmentId':a['id']}),'files':(io.BytesIO(b'\xff'),'code.py')})
        self.assertEqual(r.status_code,400)
        self.assertEqual(list(self.submissions_dir.rglob('*.py')), [])

    def test_latest_plus_three_immutable_revisions_and_pruned_files(self):
        a = self.update(self.create_assignment(active=True),allowMultiFileSubmission=True)
        revisions = [self.bundle(a, {'one.py':f'print({i})','two.js':f'console.log({i})'}) for i in range(5)]
        current = eagle._load_assignment(a['id'])['submissions'][0]
        self.assertEqual(len(current['history']),3)
        self.assertEqual([s['revisionId'] for s in current['history']], [s['revisionId'] for s in revisions[3:0:-1]])
        self.assertFalse((self.submissions_dir / revisions[0]['files'][0]['path']).exists())
        for i in range(1,5):
            self.assertIn(f'print({i})',(self.submissions_dir / revisions[i]['files'][0]['path']).read_text())
        self.assertEqual(len(list(self.submissions_dir.rglob('*.py'))),4)

    def test_history_is_teacher_only_and_other_student_cannot_read_files(self):
        a = self.create_assignment(active=True)
        old = self.bundle(a,{'answer.py':'print(1)'})
        latest = self.bundle(a,{'answer.py':'print(2)'})
        self.assertEqual(self.preview(a,old,revisionId=old['revisionId']).status_code,403)
        self.assertEqual(self.preview(a,old,teacher=True,revisionId=old['revisionId']).status_code,200)
        self.assertEqual(self.preview(a,latest,studentEmail=self.missing_email).status_code,403)
        self.assertEqual(self.preview(a,latest,fileId='../../secret').status_code,404)
        r = self.client.get('/api/assignments/submission-files',headers=self.student_headers,query_string={'assignmentId':a['id']}).get_json()
        self.assertEqual(r['history'],[])
        self.assertNotIn('path',r['files'][0])

    def test_attempt_limit_unsubmit_restores_one_and_keeps_evidence(self):
        a = self.update(self.create_assignment(active=True),maxFileSubmissions=1)
        old = self.bundle(a,{'answer.py':'print(1)'})
        body = {'assignmentId':a['id'],'studentEmail':self.student_email}
        r = self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePath':'answer.py'})
        self.assertEqual(r.status_code,403)
        self.assertEqual(self.client.post('/api/assignments/unsubmit',headers=self.student_headers,json=body).status_code,401)
        self.assertEqual(self.client.post('/api/assignments/unsubmit',headers=self.teacher_headers,json=body).status_code,200)
        self.assertEqual(self.client.post('/api/assignments/unsubmit',headers=self.teacher_headers,json=body).status_code,409)
        sub = eagle._load_assignment(a['id'])['submissions'][0]
        self.assertTrue(sub['withdrawn'])
        self.assertEqual(sub['fileSubmissionCount'],0)
        with patch.object(eagle,'_enqueue_assignment_ai_grade') as queue:
            self.assertEqual(self.client.post('/api/assignments/grade-ai',headers=self.teacher_headers,json=body).status_code,400)
            queue.assert_not_called()
        new = self.bundle(a,{'answer.py':'print(2)'})
        self.assertEqual(new['fileSubmissionCount'],1)
        self.assertFalse(new['withdrawn'])
        self.assertEqual(new['history'][0]['revisionId'],old['revisionId'])

    def test_feedback_private_shared_edit_clear_and_stale_version(self):
        a = self.create_assignment(active=True)
        sub = self.bundle(a,{'answer.py':'print(1)'})
        body = {'assignmentId':a['id'],'studentEmail':self.student_email,'revisionId':sub['revisionId'],'feedback':'Good progress'}
        self.assertEqual(self.client.post('/api/assignments/feedback',headers=self.student_headers,json=body).status_code,401)
        self.assertEqual(self.client.post('/api/assignments/feedback',headers=self.teacher_headers,json=body).status_code,200)
        stored = eagle._load_assignment(a['id'])['submissions'][0]
        self.assertEqual(workflow.student_feedback(a,stored),'')
        a = self.update(a,shareAiFeedback=True)
        self.assertEqual(workflow.student_feedback(a,stored),'Good progress')
        body['feedback']=''
        self.assertEqual(self.client.post('/api/assignments/feedback',headers=self.teacher_headers,json=body).status_code,200)
        stored = eagle._load_assignment(a['id'])['submissions'][0]
        stored['aiFeedback']='Older AI feedback'
        self.assertEqual(workflow.student_feedback(a,stored),'')
        self.bundle(a,{'answer.py':'print(2)'})
        self.assertEqual(self.client.post('/api/assignments/feedback',headers=self.teacher_headers,json=body).status_code,409)

    def test_multifile_edit_route_cannot_overwrite_bundle(self):
        a = self.update(self.create_assignment(active=True),allowMultiFileSubmission=True)
        sub = self.bundle(a)
        r = self.client.post('/api/assignments/submission',headers=self.teacher_headers,
                            json={'assignmentId':a['id'],'studentEmail':self.student_email,'content':'oops'})
        self.assertEqual(r.status_code,400)
        self.assertIn('print("one")',(self.submissions_dir/sub['files'][0]['path']).read_text())

    def test_attachment_only_is_not_ai_gradeable(self):
        a = self.create_assignment(active=True)
        sub = self.bundle(a,{'notes.json':'{"answer":123}'})
        self.assertEqual(sub['code'],'')
        self.assertFalse(workflow.has_gradable_files(sub))
        with patch.object(eagle,'_enqueue_assignment_ai_grade') as queue:
            r = self.client.post('/api/assignments/grade-ai',headers=self.teacher_headers,json={'assignmentId':a['id'],'studentEmail':self.student_email})
            self.assertEqual(r.status_code,400)
            queue.assert_not_called()

    def test_concurrent_limited_submissions_admit_one(self):
        a = self.update(self.create_assignment(active=True),maxFileSubmissions=1)
        (eagle._get_user_dir(self.student_email)/'answer.py').write_text('print(1)')
        statuses=[]
        barrier=threading.Barrier(2)
        def send():
            with eagle.app.test_client() as client:
                barrier.wait()
                r=client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePath':'answer.py'})
                statuses.append(r.status_code)
        threads=[threading.Thread(target=send) for _ in range(2)]
        for t in threads: t.start()
        for t in threads: t.join(10)
        self.assertEqual(sorted(statuses),[200,403])

    def test_metadata_failure_cleans_its_bundle(self):
        a = self.create_assignment(active=True)
        (eagle._get_user_dir(self.student_email)/'answer.py').write_text('print(1)')
        with patch.object(eagle,'_save_assignment',return_value=False):
            r=self.client.post('/api/assignments/submit',headers=self.student_headers,json={'assignmentId':a['id'],'filePath':'answer.py'})
            self.assertEqual(r.status_code,500)
        self.assertEqual(list(self.submissions_dir.rglob('*.py')),[])

    def test_mixed_sources_are_syntax_checked_individually(self):
        a=self.update(self.create_assignment(active=True),allowMultiFileSubmission=True)
        sub=self.bundle(a,{'one.py':'from __future__ import annotations\nprint(1)',
                           'two.py':'from __future__ import annotations\nprint(2)',
                           'web.js':'const x = 1;\nconsole.log(x)'})
        self.assertEqual(workflow.python_syntax(eagle,a,sub),'')
        sub=self.bundle(a,{'one.py':'print(', 'web.js':'console.log(1)'})
        self.assertIn('one.py: an error',workflow.python_syntax(eagle,a,sub))
        self.assertNotIn('web.js',workflow.python_syntax(eagle,a,sub))

    def test_quiz_resubmission_preserves_file_and_answer_history(self):
        a=self.update(self.create_assignment(active=True),quiz={'questions':[{'id':'q','type':'multiple_choice',
            'question':'Choose','options':['A','B'],'correctAnswer':1,'points':2}]},quizSettings={'maxSubmissions':3})
        original=self.bundle(a,{'answer.py':'print(1)'})
        for answer in [0,1]:
            r=self.client.post('/api/quiz/submit',headers=self.student_headers,
                json={'assignmentId':a['id'],'quizResponses':[{'questionId':'q','answer':answer}]})
            self.assertEqual(r.status_code,200,r.get_data(as_text=True))
        sub=eagle._load_assignment(a['id'])['submissions'][0]
        self.assertEqual(sub['quizSubmissionCount'],2)
        self.assertEqual(sub['quizScore'],2)
        self.assertEqual(sub['history'][0]['quizResponses'][0]['answer'],0)
        self.assertEqual(sub['history'][1]['revisionId'],original['revisionId'])
        self.assertEqual(len({r['files'][0]['path'] for r in [sub,*sub['history']]}),3)
        for r in [sub,*sub['history']]:
            self.assertIn('print(1)',(self.submissions_dir/r['files'][0]['path']).read_text())

    def test_coteacher_feedback_and_history_allowed_class_management_denied(self):
        r=self.client.post('/api/teacher/classes/coteacher',headers=self.teacher_headers,
            json={'classId':self.class_one,'email':self.student_email,'enabled':True})
        self.assertEqual(r.status_code,200,r.get_data(as_text=True))
        a=self.create_assignment(active=True)
        self.bundle(a,{'answer.py':'print(1)'})
        self.bundle(a,{'answer.py':'print(2)'})
        headers={'X-Teacher-Token':self.student_token}
        body={'assignmentId':a['id'],'studentEmail':self.student_email,'feedback':'CoTeacher feedback'}
        self.assertEqual(self.client.post('/api/assignments/feedback',headers=headers,json=body).status_code,200)
        self.assertEqual(self.client.post('/api/assignments/unsubmit',headers=headers,json=body).status_code,403)
        self.assertIn(self.client.post(f'/api/teacher/classes/{self.class_one}/accommodations',headers=headers,json=body).status_code,(401,403,404))
        query={'assignmentId':a['id'],'studentEmail':self.student_email}
        self.assertEqual(len(self.client.get('/api/assignments/submission-files',headers=headers,query_string=query).get_json()['history']),1)
        other=self.create_assignment(class_id=self.class_two,active=True)
        query['assignmentId']=other['id']
        self.assertEqual(self.client.get('/api/assignments/submission-files',headers=headers,query_string=query).status_code,403)

    def test_stale_ai_failure_cannot_overwrite_same_second_new_revision(self):
        a=self.create_assignment(active=True)
        with patch.object(eagle,'_current_timestamp',return_value='2026-10-11 12:00:00'):
            old=self.bundle(a,{'answer.py':'print(1)'})
            latest=self.bundle(a,{'answer.py':'print(1)'})
        saved=eagle._load_assignment(a['id']); saved['submissions'][0]['aiGradingStatus']='queued';eagle._save_assignment(saved)
        eagle._set_assignment_ai_failure(a['id'],self.student_email,'Old failure',old['submittedAt'],old['revisionId'])
        current=eagle._load_assignment(a['id'])['submissions'][0]
        self.assertEqual(current['aiGradingStatus'],'queued')
        self.assertEqual(current['revisionId'],latest['revisionId'])

    def test_assignment_lists_do_not_eagerly_load_large_source_bundles(self):
        a=self.update(self.create_assignment(active=True),allowMultiFileSubmission=True)
        sub=self.bundle(a,{'one.py':'#'+'x'*100000+'\nprint(1)','two.js':'//'+'y'*100000+'\nconsole.log(2)'})
        r=self.client.get('/api/assignments',headers=self.teacher_headers)
        self.assertLess(len(r.data),10000)
        row=r.get_json()['assignments'][0]['submissions'][0]
        self.assertTrue(row['hasGradableFiles'])
        self.assertNotIn('code',row)
        self.assertEqual(len(row['files']),2)
        self.assertIn('print(1)',self.preview(a,sub,teacher=True).get_json()['content'])

    def test_ai_receives_all_latest_code_files_and_rejects_old_result(self):
        a=self.update(self.create_assignment(active=True),allowMultiFileSubmission=True)
        old=self.bundle(a)
        def submit_new(*args,**kwargs):
            self.assertIn('print("one")',args[2]);self.assertIn('console.log("two")',args[2])
            self.assertNotIn('x,y',args[2])
            self.assertIn('Language: Python and JavaScript',args[2])
            self.bundle(a,{'new.py':'print("replacement")'})
            return {'ok':True,'text':json.dumps({'effort':'clear','strength':'The source meets the stated assignment requirements.','deductions':[]})}
        with patch.object(eagle,'call_ollama_generate',side_effect=submit_new):
            eagle._run_assignment_ai_grading(a['id'],self.student_email)
        latest=eagle._load_assignment(a['id'])['submissions'][0]
        self.assertIsNone(latest['codeScore'])
        self.assertNotEqual(latest['revisionId'],old['revisionId'])
