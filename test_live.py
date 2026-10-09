import ctypes
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

import app
import storage_audit as audit
import windows_integration


class LiveTests(unittest.TestCase):
    def setUp(self):
        base = Path(__file__).parent.resolve() / '.test-tmp'
        base.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=base)
        self.root = Path(self.tmp.name).resolve()
        assert self.root.is_relative_to(base)
        self.scope = self.root / '选中的目录'
        self.scope.mkdir()
        self.nested = self.scope / 'nested'
        self.nested.mkdir()
        (self.scope / 'one.txt').write_bytes(b'a'*10)
        (self.nested / 'two.txt').write_bytes(b'b'*20)
        self.manager = app.Manager(self.root/'reports', self.root/'state')
        data = audit.scan([str(self.scope)])
        data['recommendations'] = audit.recommendations(data)
        self.manager.set_data(data, 'scan-fixture.json')

    def tearDown(self):
        self.manager.stop_monitor()
        for watcher in self.manager.watchers:
            watcher.thread.join(2)
        self.tmp.cleanup()

    def test_recycle_preview_deduplicates_nested_paths(self):
        with patch.object(self.manager, 'policy', return_value={'allowed': True}):
            plan = self.manager.recycle_plan([str(self.nested), str(self.nested/'two.txt')])
        self.assertEqual(len(plan['items']), 1)
        self.assertEqual(plan['bytes'], 20)

    def test_recycle_changed_file_is_not_deleted(self):
        with patch.object(self.manager, 'policy', return_value={'allowed': True}), patch.object(app.windows_integration, 'recycle') as recycle:
            plan = self.manager.recycle_plan([str(self.scope/'one.txt')])
            (self.scope/'one.txt').write_bytes(b'changed')
            self.manager.recycle_execute(plan['id'])
            deadline=time.time()+3
            while self.manager.job['status']=='running' and time.time()<deadline:
                time.sleep(.02)
            recycle.assert_not_called()
            self.assertEqual(self.manager.job['status'], 'error')
            self.assertTrue((self.scope/'one.txt').exists())

    def test_recycle_success_updates_statistics(self):
        # The adapter is mocked; only our explicitly disposable fixture is removed.
        with patch.object(self.manager, 'policy', return_value={'allowed': True}), patch.object(app.windows_integration, 'recycle', side_effect=lambda p: Path(p).unlink()):
            plan = self.manager.recycle_plan([str(self.scope/'one.txt')])
            self.manager.recycle_execute(plan['id'])
            deadline=time.time()+3
            while self.manager.job['status']=='running' and time.time()<deadline:
                time.sleep(.02)
            self.assertEqual(self.manager.job['status'], 'done')
            self.assertEqual(self.manager.summary()['scopes'][0]['bytes'],20)
            with self.assertRaises(ValueError):
                self.manager.recycle_execute(plan['id'])

    def test_recycle_rejects_protected_paths(self):
        with self.assertRaises(ValueError):
            self.manager.recycle_plan([str(self.scope/'one.txt')])

    def test_scope_summary_is_selected_folder(self):
        result = self.manager.summary()
        self.assertEqual(result['roots'], [str(self.scope)])
        self.assertEqual(result['scopes'][0]['bytes'], 30)
        self.assertEqual(result['scopes'][0]['files'], 2)

    def test_external_delete_updates_parent_counts_and_ranking(self):
        (self.nested/'two.txt').unlink()
        self.manager.reconcile_directory(self.nested)
        result = self.manager.summary()
        self.assertEqual(result['scopes'][0]['bytes'], 10)
        self.assertEqual(result['files'], 1)
        self.assertEqual([Path(r['path']).name for r in self.manager.data['largest']], ['one.txt'])
        revision = self.manager.revision
        self.manager.reconcile_directory(self.nested)
        self.assertEqual(self.manager.revision, revision)

    def test_new_and_deleted_subtree_propagate_without_double_counting(self):
        new = self.scope/'new'
        new.mkdir()
        (new/'big.txt').write_bytes(b'c'*100)
        self.manager.reconcile_directory(self.scope)
        self.assertEqual(self.manager.summary()['scopes'][0]['bytes'], 130)
        (self.nested/'two.txt').unlink()
        self.nested.rmdir()
        self.manager.reconcile_directory(self.scope)
        self.assertEqual(self.manager.summary()['scopes'][0]['bytes'], 110)
        self.assertNotIn(audit.key(self.nested), self.manager.index)
        self.assertEqual(self.manager.summary()['files'], 2)

    def test_rename_same_size_updates_file_list(self):
        (self.scope/'one.txt').rename(self.scope/'new-name.txt')
        self.manager.reconcile_directory(self.scope)
        self.assertEqual(self.manager.summary()['scopes'][0]['bytes'], 30)
        self.assertIn('new-name.txt', [Path(r['path']).name for r in self.manager.data['largest']])
        self.assertNotIn('one.txt', [Path(r['path']).name for r in self.manager.data['largest']])

    def test_permission_failure_does_not_zero_existing_data(self):
        with patch('app.os.scandir', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                self.manager.reconcile_directory(self.scope)
        self.assertEqual(self.manager.summary()['scopes'][0]['bytes'], 30)

    def test_native_notification_updates_automatically(self):
        if os.name != 'nt':
            self.skipTest('Windows notifications')
        self.manager.start_monitor()
        time.sleep(.15)
        (self.nested/'two.txt').unlink()
        deadline = time.monotonic()+8
        while self.manager.summary()['scopes'][0]['bytes'] != 10 and time.monotonic()<deadline:
            time.sleep(.1)
        self.assertEqual(self.manager.summary()['scopes'][0]['bytes'], 10, self.manager.monitor)
        self.assertEqual(self.manager.summary()['files'], 1)

    def test_selected_root_removal_clears_old_data(self):
        (self.nested/'two.txt').unlink()
        self.nested.rmdir()
        (self.scope/'one.txt').unlink()
        self.scope.rmdir()
        self.manager.reconcile_directory(self.scope)
        result = self.manager.summary()['scopes'][0]
        self.assertTrue(result['missing'])
        self.assertEqual(result['bytes'], 0)
        self.assertEqual(self.manager.data['largest'], [])


class ExplorerTests(unittest.TestCase):
    def test_native_shell_selects_exact_unicode_item_and_frees_pidl(self):
        shell, ole = MagicMock(), MagicMock()
        ole.CoInitializeEx.return_value = 0
        def parse(path, context, pidl, flags, attrs):
            ctypes.cast(pidl, ctypes.POINTER(ctypes.c_void_p))[0] = 12345
            return 0
        shell.SHParseDisplayName.side_effect = parse
        shell.SHOpenFolderAndSelectItems.return_value = 0
        path = 'C:\\Users\\Example\\Downloads\\中文 文件, (1).zip'
        with patch('windows_integration.ctypes.WinDLL', side_effect=[shell,ole]):
            windows_integration.reveal(path)
        self.assertEqual(shell.SHParseDisplayName.call_args.args[0], path)
        args = shell.SHOpenFolderAndSelectItems.call_args.args
        self.assertEqual(args[0].value, 12345)
        self.assertEqual(args[1:], (0,None,0))
        ole.CoTaskMemFree.assert_called_once()
        ole.CoUninitialize.assert_called_once()


if __name__=='__main__':
    unittest.main()
