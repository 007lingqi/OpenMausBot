import unittest
import base64
import extractor
from smoke_fixtures import fixtures


class SmokeFixtureTests(unittest.TestCase):
    def test_fixtures_cover_complete_and_partial_formats(self):
        cases = fixtures()
        self.assertEqual(len(cases), 7)
        for case in cases:
            raw = base64.b64decode(case["base64"], validate=True)
            if case.get("reject"):
                with self.assertRaises(Exception):
                    extractor.extract(raw, case["format"])
            else:
                result = extractor.extract(raw, case["format"])
                self.assertEqual(result["truncated"], case["truncated"])
                self.assertTrue(any(case["location"] in record["location"] and case["contains"] in record["text"] for record in result["records"]))
                for warning in case.get("warnings", []):
                    self.assertIn(warning, result["warnings"])


if __name__ == "__main__":
    unittest.main()
