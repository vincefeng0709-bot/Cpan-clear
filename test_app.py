import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import app


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent / '.test-tmp')
        self.root = Path(self.tmp.name).resolve()
        assert self.root.is_relative_to(Path(__file__).parent.resolve() / '.test-tmp')
        self.source = self.root / 'personal'
        self.target = self.root / 'destination'
        self.source.mkdir()
        self.target.mkdir()
        self.patcher = patch.object(app, 'BASE', self.root / 'managed')
        self.patcher.start()
        self.manager = app.Manager(self.root / 'reports', self.root / 'state', allowed=[self.source])

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def plan(self, source=None):
        with patch.object(app, 'same_volume', return_value=False):
            return self.manager.plan(str(source or self.source), str(self.target), 'move')

    def finish(self):
        deadline = time.monotonic() + 15
        while self.manager.job['status'] == 'running' and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertNotEqual(self.manager.job['status'], 'running')

    def test_transfer_and_restore_bytes_and_history(self):
        (self.source / 'nested').mkdir()
        data = bytes(range(256)) * 2000
        p = self.source / 'nested' / '中文.bin'
        p.write_bytes(data)
        plan = self.plan()
        self.manager.execute(plan['id'])
        self.finish()
        self.assertEqual(self.manager.job['status'], 'done', self.manager.job)
        self.assertFalse(p.exists())
        destination = Path(plan['target']) / 'nested' / '中文.bin'
        self.assertEqual(destination.read_bytes(), data)
        self.assertEqual(self.manager.history()[0]['completed'], 1)
        self.manager.restore(plan['id'])
        self.finish()
        self.assertEqual(self.manager.job['status'], 'done', self.manager.job)
        self.assertEqual(p.read_bytes(), data)
        self.assertFalse(destination.exists())
        self.assertEqual(self.manager.history()[0]['status'], 'restored')

    def test_changed_source_is_preserved(self):
        p = self.source / 'a.txt'
        p.write_text('before')
        plan = self.plan()
        p.write_text('changed after preview')
        self.manager.execute(plan['id'])
        self.finish()
        self.assertEqual(self.manager.job['status'], 'error')
        self.assertEqual(p.read_text(), 'changed after preview')

    def test_restore_conflict_preserves_both_files(self):
        p = self.source / 'a.txt'
        p.write_text('original')
        plan = self.plan()
        self.manager.execute(plan['id'])
        self.finish()
        p.write_text('new file')
        self.manager.restore(plan['id'])
        self.finish()
        self.assertEqual(self.manager.job['status'], 'error')
        self.assertEqual(p.read_text(), 'new file')
        self.assertEqual((Path(plan['target']) / 'a.txt').read_text(), 'original')

    def test_destination_change_blocks_restore(self):
        p = self.source / 'a.txt'
        p.write_text('original')
        plan = self.plan()
        self.manager.execute(plan['id'])
        self.finish()
        (Path(plan['target']) / 'a.txt').write_text('edited target')
        self.manager.restore(plan['id'])
        self.finish()
        self.assertEqual(self.manager.job['status'], 'error')
        self.assertFalse(p.exists())

    def test_protected_file_and_same_drive_blocked(self):
        (self.source / 'data.sqlite').write_text('database')
        with self.assertRaises(ValueError):
            self.plan()
        self.assertFalse(self.manager.policy(self.target)['allowed'])
        with self.assertRaises(ValueError):
            self.manager.plan(str(self.source), str(self.target), 'clean')

    def test_recent_cache_blocked(self):
        self.manager.caches = [self.source]
        (self.source / 'active.tmp').write_text('recent')
        with self.assertRaisesRegex(ValueError, '7 天'):
            self.plan()

    def test_cancel_leaves_unprocessed_source(self):
        (self.source / 'a.txt').write_text('original')
        plan = self.plan()
        original = self.manager.append_event
        def cancel_after_copy(*args):
            original(*args)
            self.manager.cancel.set()
        (self.source / 'b.txt').write_text('second')
        plan = self.plan()
        with patch.object(self.manager, 'append_event', side_effect=cancel_after_copy):
            self.manager.execute(plan['id'])
            self.finish()
        self.assertEqual(self.manager.job['status'], 'cancelled')
        self.assertEqual(len(list(self.source.glob('*.txt'))), 1)
        self.manager.restore(plan['id'])
        self.finish()
        self.assertEqual(len(list(self.source.glob('*.txt'))), 2)

    def test_short_copy_failure_keeps_source(self):
        p = self.source / 'a.txt'
        p.write_text('original')
        plan = self.plan()
        with patch.object(app, 'verified_copy', side_effect=OSError('disk full')):
            self.manager.execute(plan['id'])
            self.finish()
        self.assertEqual(self.manager.job['status'], 'error')
        self.assertEqual(p.read_text(), 'original')

    def test_windows_copy_preserves_download_origin_stream(self):
        if os.name != 'nt':
            self.skipTest('NTFS streams require Windows')
        p = self.source / 'download.txt'
        p.write_text('main content')
        stream = Path(str(p) + ':Zone.Identifier')
        stream.write_text('[ZoneTransfer]\nZoneId=3\n')
        plan = self.plan()
        self.manager.execute(plan['id'])
        self.finish()
        self.assertEqual(self.manager.job['status'], 'done', self.manager.job)
        dest = Path(plan['target']) / 'download.txt'
        self.assertEqual(Path(str(dest) + ':Zone.Identifier').read_text(), '[ZoneTransfer]\nZoneId=3\n')
        self.manager.restore(plan['id'])
        self.finish()
        self.assertEqual(stream.read_text(), '[ZoneTransfer]\nZoneId=3\n')

    def test_scan_creates_complete_snapshot(self):
        (self.source / 'a.txt').write_text('scan fixture')
        self.manager.start_scan([str(self.source)])
        self.finish()
        self.assertEqual(self.manager.job['status'], 'done', self.manager.job)
        self.assertEqual(self.manager.data['files_scanned'], 1)
        self.assertEqual(len(list((self.root / 'reports').glob('scan-*.json'))), 1)

    def test_preview_expiration_and_busy(self):
        (self.source / 'a.txt').write_text('test')
        plan = self.plan()
        self.manager.plans[plan['id']]['created'] = 0
        with self.assertRaises(ValueError):
            self.manager.execute(plan['id'])
        self.manager.job['status'] = 'running'
        with self.assertRaises(ValueError):
            self.manager.begin('scan', lambda: None)

    def test_no_links_rejects_windows_special_paths(self):
        if os.name != 'nt':
            self.skipTest('Windows paths')
        for path in ['\\\\server\\share', 'C:\\file.txt:secret', '\\\\?\\C:\\Windows']:
            with self.assertRaises(ValueError):
                app.no_links(path, False)


class ServerTests(unittest.TestCase):
    def test_host_origin_and_token_guards(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent / '.test-tmp') as tmp:
            manager = app.Manager(Path(tmp) / 'reports', Path(tmp) / 'state')
            server = app.make_server(0, manager)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(path, headers=None, method='GET', body=None):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
                conn.request(method, path, body=body, headers=headers or {})
                response = conn.getresponse()
                result = response.status, response.read()
                conn.close()
                return result
            try:
                code, body = request('/')
                self.assertEqual(code, 200)
                self.assertIn(server.token.encode(), body)
                self.assertEqual(request('/api/summary')[0], 403)
                auth = {'X-Spacewell-Token': server.token}
                self.assertEqual(request('/api/summary', auth)[0], 200)
                self.assertEqual(request('/api/summary', dict(auth, Origin='https://attacker.example'))[0], 403)
                self.assertEqual(request('/', {'Host':'attacker.example'})[0], 403)
                self.assertEqual(request('/api/execute', dict(auth, **{'Content-Type':'application/json'}), 'POST', '{"id":"bad"}')[0], 400)
                self.assertEqual(request('/../app.py')[0], 404)
                self.assertEqual(request('/app.js')[0], 200)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    Path(__file__).parent.joinpath('.test-tmp').mkdir(exist_ok=True)
    unittest.main()
