import re
import unittest
from unittest.mock import patch

from lesson_plan_pdf import render_week_pdf


class LessonPlanPdfTests(unittest.TestCase):
    def plans(self):
        return [{'class':{'name':name},'source_id':'shared','plan':{'days':{
            'monday':{'markdown':'# A lesson\n\n- Trace a loop\n- Write your own\n\n[Notes](/wiki/loops)','color':'#ff4444'}},
            'notes_markdown':'Bring headphones.'}} for name in ('First class','Second class')]

    def test_pdf_has_separate_landscape_pages_for_every_class(self):
        output=render_week_pdf(self.plans(),'2026-10-19',{})
        self.assertTrue(output.startswith(b'%PDF-'))
        self.assertEqual(len(re.findall(rb'/Type\s*/Page\b',output)),2)
        self.assertIn(b'792 612',output)

    def test_long_days_continue_onto_more_pages_instead_of_being_truncated(self):
        plans=self.plans()[:1]
        plans[0]['plan']['days']['monday']['markdown']='\n'.join(f'- Activity {index}: trace a loop and explain what each step does.' for index in range(100))
        output=render_week_pdf(plans,'2026-10-19',{})
        self.assertGreater(len(re.findall(rb'/Type\s*/Page\b',output)),1)

    def test_export_limits_reject_oversized_input(self):
        with patch('lesson_plan_pdf.MAX_CLASSES',1),self.assertRaises(ValueError):
            render_week_pdf(self.plans(),'2026-10-19',{})
        with patch('lesson_plan_pdf.MAX_IMAGE_BYTES',1),self.assertRaises(ValueError):
            render_week_pdf(self.plans(),'2026-10-19',{('shared','image'):b'too large'})


if __name__=='__main__':
    unittest.main()
