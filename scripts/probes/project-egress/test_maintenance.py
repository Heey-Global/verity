"""Independent collection must converge without another provisioning operation."""
import fcntl
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'project-egress-managed.py'
spec = importlib.util.spec_from_file_location('egress_maintenance', SOURCE)
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'var/lib/verity-egress'
        self.state.mkdir(parents=True, mode=0o700)
        self.installer = self.root / '.verity-install.lock'
        self.installer.touch(mode=0o600)
        (self.root / 'proc').mkdir()
        self.observed = []

    def cleanup(self):
        for path in self.root.rglob('*'):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o755)
        self.temp.cleanup()

    def stage(self, index, payload=True):
        stage = self.state / 'provision' / f'{index:024x}'
        stage.mkdir(parents=True)
        (stage / 'attempt').write_text('attempt')
        (stage / 'result.json').write_text('{"exitCode":0}')
        if payload:
            (stage / 'release').mkdir()
            (stage / 'release/node').write_text('large payload')
            (stage / 'ready').touch()
        return stage

    def observe(self, unit):
        self.observed.append(unit)
        return 'LoadState=loaded\nActiveState=inactive'

    def maintain(self, observe=None):
        return managed.maintenance(self.root, observe or self.observe, self.installer)

    def release(self, index):
        release = self.root / managed.RELEASES / f'{index:064x}'
        managed.prepare_release(release, {'node': b'fixture'})
        os.utime(release, (index, index))
        return release

    def test_collects_without_provisioning_and_preserves_receipts(self):
        stage = self.stage(1)
        old = [self.release(i) for i in range(1, 6)]
        current = self.root / 'opt/verity-egress'
        current.symlink_to(old[0])
        result = self.maintain()
        self.assertEqual(result, {'state': 'complete', 'stages': 1, 'releases': 2})
        self.assertEqual(sorted(p.name for p in stage.iterdir()), ['attempt', 'result.json'])
        self.assertTrue(old[0].exists())
        self.assertFalse(old[1].exists())
        self.assertTrue(old[-1].exists())
        self.assertEqual(self.maintain()['stages'], 0)

    def test_active_unknown_and_unobservable_units_keep_payload(self):
        for index, value in enumerate(['active', 'activating', 'deactivating', 'reloading', 'unknown']):
            stage = self.stage(index)
            self.maintain(lambda _: 'LoadState=loaded\nActiveState=' + value)
            self.assertTrue((stage / 'ready').exists())
        stage = self.stage(10)
        def failed(_):
            raise OSError('manager unavailable')
        self.maintain(failed)
        self.assertTrue((stage / 'release/node').exists())

    def test_failed_and_not_found_units_are_terminal(self):
        for index, value in enumerate(['LoadState=loaded\nActiveState=failed',
                                       'LoadState=not-found\nActiveState=inactive']):
            stage = self.stage(index)
            self.maintain(lambda _: value)
            self.assertFalse((stage / 'release').exists())

    def test_installer_native_and_launcher_locks_exclude_collection(self):
        stage = self.stage(1)
        for path in [self.installer, self.state / 'install.lock', self.state / 'provision.lock']:
            with path.open('a') as held:
                path.chmod(0o600)
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    self.maintain()
                self.assertTrue((stage / 'release/node').exists())

    def test_missing_authority_and_transaction_journal_preserve_everything(self):
        stage = self.stage(1)
        self.assertEqual(managed.maintenance(self.root)['state'], 'installer-authority-unavailable')
        (self.root / managed.JOURNAL).write_text('{}')
        self.assertEqual(self.maintain()['state'], 'recovery-held')
        self.assertTrue((stage / 'ready').exists())

    def test_rotation_reaches_payload_after_many_receipts_and_releases_converge(self):
        for index in range(managed.MAINTENANCE_BATCH):
            self.stage(index, payload=False)
        stage = self.stage(managed.MAINTENANCE_BATCH)
        old = [self.release(i) for i in range(1, 7)]
        self.assertEqual(self.maintain()['stages'], 0)
        self.assertFalse(old[0].exists())
        self.assertEqual(self.maintain()['stages'], 1)
        self.assertFalse((stage / 'ready').exists())
        self.assertEqual(len(self.observed), 1)

    def test_pinned_candidates_do_not_starve_later_unused_bundles(self):
        unused = [self.release(index) for index in range(1, managed.MAINTENANCE_BATCH + 5)]
        pinned = [self.release(index) for index in range(100, 100 + managed.MAINTENANCE_BATCH + 4)]
        newest = [self.release(index) for index in (300, 301)]
        process = self.root / 'proc/100'
        process.mkdir()
        (process / 'cmdline').write_bytes(b'\0'.join(str(path / 'node').encode() for path in pinned))
        # Newer pinned candidates precede every removable one in the inventory.
        self.assertEqual(self.maintain()['releases'], managed.MAINTENANCE_BATCH)
        self.assertEqual(sum(path.exists() for path in unused), 4)
        self.assertEqual(self.maintain()['releases'], 4)
        self.assertTrue(all(not path.exists() for path in unused))
        self.assertTrue(all(path.exists() for path in pinned + newest))
        self.assertEqual(self.maintain()['releases'], 0)

    def test_interrupted_removal_backlog_consumes_same_batch_budget(self):
        unused = [self.release(index) for index in range(1, managed.MAINTENANCE_BATCH + 5)]
        newest = [self.release(index) for index in (300, 301)]
        parent = self.root / managed.RELEASES
        for index in range(managed.MAINTENANCE_BATCH + 2):
            retired = parent / f'.retired-{index:016x}'
            retired.mkdir()
            (retired / 'node').write_text('interrupted bundle')
        for _ in range(3):
            before = len(list(parent.iterdir()))
            self.maintain()
            self.assertLessEqual(before - len(list(parent.iterdir())), managed.MAINTENANCE_BATCH)
        self.assertFalse(any(path.name.startswith('.retired-') for path in parent.iterdir()))
        self.assertTrue(all(not path.exists() for path in unused))
        self.assertTrue(all(path.exists() for path in newest))

    def test_symlinked_stage_payload_and_installer_lock_never_followed(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        stage = self.stage(1)
        (stage / 'linked').symlink_to(outside, target_is_directory=True)
        linked = stage.parent / ('f' * 24)
        linked.symlink_to(outside, target_is_directory=True)
        self.maintain()
        self.assertEqual((outside / 'keep').read_text(), 'keep')
        self.assertTrue(linked.is_symlink())
        self.installer.unlink()
        self.installer.symlink_to(outside / 'keep')
        with self.assertRaises((ValueError, OSError)):
            self.maintain()

    def test_interrupted_compaction_leaves_retry_without_readiness(self):
        stage = self.stage(1)
        with patch.object(managed.shutil, 'rmtree', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                self.maintain()
        self.assertFalse((stage / 'ready').exists())
        self.assertTrue((stage / 'attempt').exists())
        self.assertEqual(self.maintain()['stages'], 1)

    def test_timer_uses_immutable_helper_and_does_not_start_controller(self):
        calls = []
        (self.root / 'opt/verity-egress-releases').mkdir(parents=True)
        destination = managed.publish_recovery_helpers(self.root)
        def execute(*args):
            calls.append(args)
            return '259' if '--property=Version' in args else ''
        managed.install_maintenance(self.root, execute, destination, self.installer)
        unit = (self.root / managed.MAINTENANCE_UNIT).read_text()
        self.assertIn(str(destination / 'project-egress-managed.py') + ' maintain', unit)
        self.assertIn('--installer-lock ' + str(self.installer), unit)
        self.assertIn('TimeoutStartSec=30', unit)
        self.assertIn('OnUnitActiveSec=15min', (self.root / managed.MAINTENANCE_TIMER).read_text())
        self.assertEqual(calls, [('/usr/bin/systemctl', 'show', '--property=Version', '--value'),
                                ('/usr/bin/systemctl', 'daemon-reload'),
                                ('/usr/bin/systemctl', 'enable', '--now', 'verity-egress-maintenance.timer')])

    def test_absent_or_unreachable_manager_skips_timer_without_writing_units(self):
        destination = managed.publish_recovery_helpers(self.root)
        for error in (FileNotFoundError('systemctl absent'),
                      subprocess.CalledProcessError(1, 'systemctl', stderr='manager unavailable')):
            calls = []
            def unavailable(*args):
                calls.append(args)
                raise error
            self.assertFalse(managed.install_maintenance(self.root, unavailable, destination, self.installer))
            self.assertEqual(calls, [('/usr/bin/systemctl', 'show', '--property=Version', '--value')])
            self.assertFalse((self.root / managed.MAINTENANCE_UNIT).exists())
            self.assertFalse((self.root / managed.MAINTENANCE_TIMER).exists())

    def test_available_manager_does_not_hide_timer_installation_errors(self):
        destination = managed.publish_recovery_helpers(self.root)
        for failed in ('daemon-reload', 'enable'):
            with self.subTest(failed=failed):
                def execute(*args):
                    if '--property=Version' in args:
                        return '259'
                    if failed in args:
                        raise subprocess.CalledProcessError(1, args)
                    return ''
                with self.assertRaises(subprocess.CalledProcessError):
                    managed.install_maintenance(self.root, execute, destination, self.installer)

    def test_timer_exposes_only_exact_lock_inside_otherwise_hidden_home_paths(self):
        destination = managed.publish_recovery_helpers(self.root)
        for relative in ('root/verity', 'home/owner/verity', 'run/user/1000/verity'):
            with self.subTest(relative=relative):
                installer = self.root / relative / '.verity-install.lock'
                installer.parent.mkdir(parents=True, mode=0o700)
                installer.touch(mode=0o600)
                managed.install_maintenance(self.root, lambda *_: '259', destination, installer)
                lines = (self.root / managed.MAINTENANCE_UNIT).read_text().splitlines()
                # ProtectHome=yes makes nested binds inaccessible; tmpfs keeps
                # unrelated home data hidden while admitting only this file.
                self.assertIn('ProtectHome=tmpfs', lines)
                self.assertEqual([line for line in lines if line.startswith('BindReadOnlyPaths=')],
                                 ['BindReadOnlyPaths=' + str(installer)])
                self.assertFalse(any(line.startswith('BindPaths=') for line in lines))
                self.assertIn('ProtectSystem=strict', lines)
                self.assertIn('ReadWritePaths=/var/lib/verity-egress /opt/verity-egress-releases', lines)


if __name__ == '__main__':
    unittest.main()
