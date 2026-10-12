import unittest
from image_watch import anomalies, changed_report

class ImageWatchTests(unittest.TestCase):
    def base(self):
        return {'id':'x','title':'news','allowed':True,'requires_credit':True,'first':{'url':'https://example.org/image.jpg'},'review':{'url':'https://example.org/image.jpg','approved':True,'category':'related','credit':'Example','attributionUrl':'https://example.org/page'}}
    def test_intentional_source_denial_silent(self):
        row=self.base();row['allowed']=False
        self.assertEqual(anomalies([row]),[])
    def test_missing_review_reported(self):
        row=self.base();row['review']={'status':'missing','approved':False}
        self.assertIn('审核未完成',anomalies([row])[0]['reasons'])
    def test_valid_rejection_silent(self):
        row=self.base();row['review']={'url':row['first']['url'],'status':'image-rejected','approved':False,'category':'unrelated','reason':'Unrelated to the article'}
        self.assertEqual(anomalies([row]),[])
    def test_credit_and_unsafe_attribution_reported(self):
        row=self.base();row['review']['attributionUrl']='javascript:alert(1)'
        self.assertIn('署名或图源缺失',anomalies([row])[0]['reasons'])
    def test_no_collected_candidate_not_claim_source_no_image(self):
        row=self.base();row['first']=None
        self.assertEqual(anomalies([row])[0]['reasons'],['未采集到候选图（不代表原文无图）'])
    def test_stable_report_deduplicates(self):
        rows=anomalies([{'id':'x','title':'news','allowed':True,'first':None}])
        digest,text=changed_report(rows,None)
        self.assertTrue(text)
        self.assertEqual(changed_report(rows,digest)[1],'')
    def test_ready_is_silent(self):
        self.assertEqual(anomalies([self.base()]),[])
    def test_rights_denial_is_not_missing_suitability(self):
        row=self.base();row['review'].update(approved=False,status='rights-unverified',suitabilityStatus='approved',rightsStatus='unverified')
        reasons=anomalies([row])[0]['reasons']
        self.assertIn('逐图许可未核实',reasons)
        self.assertNotIn('审核未完成',reasons)
    def test_rejection_without_reason_does_not_suppress_alert(self):
        row=self.base();row['review'].update(approved=False,status='image-rejected',category='related')
        self.assertIn('审核未完成',anomalies([row])[0]['reasons'])
    def test_credit_flag_must_be_literal_true(self):
        row=self.base();row['requires_credit']='false';row['review'].pop('credit')
        self.assertEqual(anomalies([row]),[])
    def test_download_and_no_vision_operational_states(self):
        for status in ['download-failed','no-vision','provider-rejected']:
            row=self.base();row['review'].update(approved=False,status=status)
            self.assertIn('审核未完成',anomalies([row])[0]['reasons'])
    def test_rights_unverified_reported(self):
        row=self.base();row['review']['rightsStatus']='unverified'
        self.assertIn('逐图许可未核实',anomalies([row])[0]['reasons'])

if __name__=='__main__':unittest.main()
