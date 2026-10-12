"""Independent acceptance probes; offline, no production reads/writes."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from image_watch import anomalies

IMAGE = 'https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2018/10/elongated_cloud_on_mars_annotated/17836422-1-eng-GB/Elongated_cloud_on_Mars_annotated_article.jpg'
PAGE = 'https://www.esa.int/ESA_Multimedia/Images/2018/10/Elongated_cloud_on_Mars_annotated'

def row():
    return {'id':'offline-review-probe', 'title':'offline fixture', 'allowed':True, 'requires_credit':True,
            'source_name':'ESA Space Science', 'url':'https://www.esa.int/Science_Exploration/Space_Science/Mars_Express/Fixture',
            'first':{'url':IMAGE}, 'review':{'url':IMAGE, 'approved':True, 'status':'approved', 'category':'related',
            'reason':'Relevant background observation', 'credit':'ESA/GCP/UPV/EHU Bilbao', 'attributionUrl':PAGE,
            'rightsStatus':'verified', 'license':'ESA Standard Licence',
            'licenseUrl':'https://www.esa.int/ESA_Multimedia/Terms_and_conditions_of_use_of_images_and_videos_available_on_the_esa_website'}}

class Acceptance(unittest.TestCase):
    def test_missing_per_image_rights_is_reported(self):
        r=row(); r['review'].pop('rightsStatus')
        self.assertTrue(anomalies([r]), 'Missing ESA per-image verification must not be reported as healthy')
    def test_missing_licence_is_reported(self):
        r=row(); r['review'].pop('license'); r['review'].pop('licenseUrl')
        self.assertTrue(anomalies([r]), 'ESA DTO rejects missing licence; watchdog must notice the missing image')
    def test_unrelated_canonical_is_reported(self):
        r=row(); r['review']['canonicalUrl']='https://example.org/unrelated.jpg'
        self.assertTrue(anomalies([r]), 'ESA DTO rejects canonical mismatch; watchdog must notice')
    def test_valid_related_but_unsuitable_rejection_is_not_missing_review(self):
        r=row(); r['review'].update(approved=False, status='image-rejected', category='related', reason='Related but unsuitable for a news card')
        self.assertEqual(anomalies([r]), [], 'Completed rejection must not be relabelled as incomplete review')

class EvidenceContract(unittest.TestCase):
    def test_esa_approval_evidence_matches_dto(self):
        for patch in [dict(status='invalid'), dict(reason=' '), dict(reason='x'*401),
                      dict(credit='Other'), dict(credit='ESA'+'x'*2000),
                      dict(attributionUrl='https://www.esa.int/other'),
                      dict(license='CC BY-SA 3.0 IGO'), dict(licenseUrl='https://example.org/terms')]:
            with self.subTest(patch=patch):
                r=row(); r['review'].update(patch)
                self.assertTrue(anomalies([r]))
    def test_exact_canonical_and_source_detection(self):
        r=row(); r['review']['canonicalUrl']=IMAGE.replace('_article.jpg','.jpg')
        self.assertEqual(anomalies([r]), [])
        r.pop('source_name'); r['review'].pop('rightsStatus')
        self.assertIn('逐图许可未核实', anomalies([r])[0]['reasons'])
    def test_non_esa_legacy_evidence_is_not_subject_to_esa_policy(self):
        r=row(); r['source_name']='Other'; r['url']='https://example.org/news'
        r['review'].pop('rightsStatus'); r['review'].pop('license'); r['review'].pop('licenseUrl')
        r['review']['canonicalUrl']='https://example.org/unrelated.jpg'
        self.assertEqual(anomalies([r]), [])
    def test_invalid_rejection_evidence_cannot_suppress_alert(self):
        for patch in [dict(reason=None), dict(reason=' '), dict(reason='x'*401),
                      dict(category='bad'), dict(url='https://example.org/other.jpg'),
                      dict(depiction='bad')]:
            with self.subTest(patch=patch):
                r=row(); r['review'].update(approved=False,status='image-rejected'); r['review'].update(patch)
                self.assertTrue(anomalies([r]))
    def test_completed_rejection_does_not_need_display_licence(self):
        r=row(); r['review']={'url':IMAGE,'approved':False,'category':'related',
                             'status':'image-rejected','reason':'Unsuitable for card'}
        self.assertEqual(anomalies([r]), [])

if __name__ == '__main__': unittest.main()
