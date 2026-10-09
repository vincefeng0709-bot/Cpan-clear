import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import storage_audit as audit


class AuditTests(unittest.TestCase):
    def test_epoch_timestamp(self):
        self.assertEqual(audit.modified_time(0), "1970-01-01T00:00:00+00:00")
        self.assertEqual(audit.modified_time(float('inf')), "时间不可解析")

    def test_aggregation_exclusion_and_top_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "nested").mkdir()
            (root / "ignored").mkdir()
            (root / "a").write_bytes(b"a" * 3)
            (root / "nested" / "b").write_bytes(b"b" * 7)
            (root / "ignored" / "c").write_bytes(b"c" * 100)
            data = audit.scan([str(root)], [str(root / "ignored")], top=1)
            record = data["directories"][0]
            self.assertEqual((record["bytes"], record["files"], record["incomplete"]), (10, 2, 1))
            self.assertEqual(data["largest"][0]["bytes"], 7)
            self.assertEqual(audit.normalize_roots([str(root), str(root / "nested")]), [audit.key(root)])

    def test_permission_error_propagates_to_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            blocked = root / "blocked"
            blocked.mkdir()
            original = os.scandir
            def fake(path):
                if Path(path) == blocked:
                    raise PermissionError("test denied")
                return original(path)
            with patch("storage_audit.os.scandir", side_effect=fake):
                data = audit.scan([str(root)])
            self.assertEqual(data["directories"][0]["incomplete"], 1)
            self.assertEqual(data["issue_counts"]["unreadable"], 1)

    def test_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "file").write_bytes(b"test")
            try:
                os.symlink(root, root / "loop", target_is_directory=True)
            except OSError:
                self.skipTest("Symlinks require permission on this Windows host")
            data = audit.scan([str(root)])
            self.assertEqual(data["files_scanned"], 1)
            self.assertEqual(data["issue_counts"]["link_or_cloud"], 1)
            with self.assertRaises(ValueError):
                audit.normalize_roots([str(root / "loop")])

    def test_comparison_rejects_incomplete_or_different_scope(self):
        row = {"path": os.path.abspath("example"), "bytes": 10, "incomplete": 0}
        old = {"version": 1, "roots": ["x"], "directories": [row]}
        new = dict(old, directories=[dict(row, bytes=30)])
        self.assertEqual(audit.compare(new, old)["rows"][0]["delta"], 20)
        new["directories"][0]["incomplete"] = 1
        self.assertEqual(audit.compare(new, old)["rows"], [])
        self.assertEqual(audit.compare(dict(new, roots=["y"]), old)["rows"], [])

    def test_html_data_cannot_close_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "report.html"
            audit.write_report({"directories": [], "example": "</script><img src=x>"}, output)
            content = output.read_text(encoding="utf-8")
            self.assertNotIn("</script><img", content)
            payload = content.split("const data=", 1)[1].split(";\nconst $", 1)[0]
            self.assertEqual(json.loads(payload)["example"], "</script><img src=x>")


if __name__ == "__main__":
    unittest.main()
