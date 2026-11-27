"""Activation rollback returns Docker to the runtimes the restored release was assessed with."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'project-egress-managed.py'
spec = importlib.util.spec_from_file_location('egress_managed_restore', SOURCE)
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

OLD = '/opt/verity/runsc/release-20261109.0/runsc'
NEW = '/opt/verity/runsc/release-20261116.0/runsc'


class RuntimeRestoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.previous = self.root / 'opt/verity-egress-releases/previous'
        self.previous.mkdir(parents=True)
        (self.previous / 'native-runtime-pins.env').write_text('RUNSC_RELEASE=release-20261109.0\n')
        binary = self.root / OLD.lstrip('/')
        (binary.parent / 'gvisor-bin').mkdir(parents=True)
        binary.write_bytes(b'old-runsc')
        binary.chmod(0o755)
        (binary.parent / 'gvisor-bin/gvisor_sentry').write_bytes(b'old-sentry')
        self.runtime = {'path': OLD, 'sha512': hashlib.sha512(b'old-runsc').hexdigest(),
                        'treeSha256': managed.base.runtime_tree_digest(binary.parent)}
        config = self.root / 'etc/verity-egress'
        config.mkdir(parents=True)
        (config / 'assessment.json').write_text(json.dumps({'profile': {'runtime': self.runtime}}))
        (config / 'assessment.json').chmod(0o600)
        (config / 'relay-runtime.json').write_text(json.dumps({'version': 1, 'runtime': {'path': NEW}}))
        (self.root / 'etc/docker').mkdir(parents=True)
        self.daemon = self.root / 'etc/docker/daemon.json'
        self.daemon.write_text(json.dumps({'runtimes': {
            'runsc': {'path': NEW, 'runtimeArgs': ['--platform=systrap', '--network=none']},
            'runsc-project': {'path': NEW, 'runtimeArgs': managed.base.PROJECT_RUNTIME_ARGS},
            'runsc-relay': {'path': NEW, 'runtimeArgs': managed.base.RELAY_RUNTIME_ARGS}}}))
        (self.root / managed.HOST_RUNTIME_PRIVATE).mkdir(parents=True, mode=0o700)
        self.calls = []
        self.converges = True

    def run_command(self, *args):
        self.calls.append(args)
        if args[0] == '/usr/bin/docker':
            runtimes = json.loads(self.daemon.read_text())['runtimes']
            if not self.converges:
                runtimes = {name: {**value, 'path': NEW} for name, value in runtimes.items()}
            return json.dumps({'Runtimes': runtimes})
        return ''

    def restore(self):
        return managed.restore_previous_runtime(self.root, self.run_command, str(self.previous))

    # The 4.99.3 rollback left both registrations on the renewed gVisor release, so the
    # restored controller's preflight refused to start until they were reverted by hand.
    def test_restores_project_and_relay_registrations_and_authority(self):
        self.assertTrue(self.restore())
        runtimes = json.loads(self.daemon.read_text())['runtimes']
        self.assertEqual(runtimes['runsc-project'], {'path': OLD, 'runtimeArgs': managed.base.PROJECT_RUNTIME_ARGS})
        self.assertEqual(runtimes['runsc-relay'], {'path': OLD, 'runtimeArgs': managed.base.RELAY_RUNTIME_ARGS})
        # The host runtime service owns the plain runsc entry.
        self.assertEqual(runtimes['runsc']['path'], NEW)
        authority = json.loads((self.root / managed.base.RELAY_RUNTIME_AUTHORITY).read_text())
        self.assertEqual(authority, {'version': 1, 'runtime': self.runtime})
        validate = self.calls.index(('/usr/bin/dockerd', '--validate', '--config-file',
                                     str(self.daemon.with_name('.verity-egress-daemon.json'))))
        self.assertLess(validate, self.calls.index(('/usr/bin/systemctl', 'reload', 'docker.service')))
        self.assertFalse(self.daemon.with_name('.verity-egress-daemon.json').exists())

    def test_matching_registrations_are_not_reloaded(self):
        self.restore()
        self.calls.clear()
        # A rollback without a renewed host runtime needs no lock, check or write.
        # Key order and whitespace are not part of the identity.
        (self.root / managed.base.RELAY_RUNTIME_AUTHORITY).write_text(
            json.dumps({'runtime': self.runtime, 'version': 1}, indent=1))
        authority = (self.root / managed.base.RELAY_RUNTIME_AUTHORITY).stat().st_mtime_ns
        shutil.rmtree(self.root / managed.HOST_RUNTIME_PRIVATE)
        self.assertFalse(self.restore())
        self.assertEqual(self.calls, [])
        self.assertEqual((self.root / managed.base.RELAY_RUNTIME_AUTHORITY).stat().st_mtime_ns, authority)

    def test_unverified_previous_runtime_changes_nothing(self):
        before = self.daemon.read_bytes()
        (self.root / OLD.lstrip('/')).write_bytes(b'replaced')
        with self.assertRaisesRegex(ValueError, 'assessed identity'):
            self.restore()
        self.assertEqual(self.daemon.read_bytes(), before)
        self.assertEqual(self.calls, [])

    def test_pending_host_runtime_transaction_is_not_overridden(self):
        pending = self.root / managed.HOST_RUNTIME_PRIVATE / 'daemon-install/pending'
        pending.parent.mkdir()
        pending.touch()
        before = self.daemon.read_bytes()
        with self.assertRaisesRegex(ValueError, 'recovery is pending'):
            self.restore()
        self.assertEqual(self.daemon.read_bytes(), before)

    def test_unconverged_reload_restores_the_original_registrations(self):
        before = self.daemon.read_bytes()
        self.converges = False
        with patch.object(managed.time, 'sleep'), \
                patch.object(managed.time, 'monotonic', side_effect=[0, 0, 31, 31]):
            with self.assertRaisesRegex(ValueError, 'did not register'):
                self.restore()
        self.assertEqual(self.daemon.read_bytes(), before)
        self.assertEqual(sum(call == ('/usr/bin/systemctl', 'reload', 'docker.service') for call in self.calls), 2)
        self.assertEqual(json.loads((self.root / managed.base.RELAY_RUNTIME_AUTHORITY).read_text())['runtime']['path'], NEW)

    def test_missing_host_runtime_service_state_is_refused(self):
        (self.root / managed.HOST_RUNTIME_PRIVATE).rmdir()
        before = self.daemon.read_bytes()
        with self.assertRaisesRegex(ValueError, 'service state is missing'):
            self.restore()
        self.assertEqual(self.daemon.read_bytes(), before)
        self.assertFalse((self.root / managed.HOST_RUNTIME_PRIVATE).exists())

    def test_daemon_file_mode_is_preserved(self):
        self.daemon.chmod(0o600)
        self.restore()
        self.assertEqual(self.daemon.stat().st_mode & 0o777, 0o600)

    def test_failed_revert_is_reported_instead_of_the_convergence_error(self):
        self.converges = False
        def run(*args):
            if args == ('/usr/bin/systemctl', 'reload', 'docker.service') and \
                    sum(call == args for call in self.calls) == 1:
                raise RuntimeError('reload failed')
            return self.run_command(*args)
        with patch.object(managed.time, 'sleep'), \
                patch.object(managed.time, 'monotonic', side_effect=[0, 0, 31, 31]):
            with self.assertRaisesRegex(ValueError, 'could not be reverted'):
                managed.restore_previous_runtime(self.root, run, str(self.previous))

    def test_matching_registrations_still_restore_a_renewed_authority(self):
        value = json.loads(self.daemon.read_text())
        for name in ('runsc-project', 'runsc-relay'):
            value['runtimes'][name]['path'] = OLD
        self.daemon.write_text(json.dumps(value))
        # Rewriting only the authority never needs the host runtime lock.
        shutil.rmtree(self.root / managed.HOST_RUNTIME_PRIVATE)
        self.assertTrue(self.restore())
        self.assertEqual(self.calls, [])
        authority = json.loads((self.root / managed.base.RELAY_RUNTIME_AUTHORITY).read_text())
        self.assertEqual(authority['runtime'], self.runtime)

    def test_other_runtime_keys_are_kept(self):
        value = json.loads(self.daemon.read_text())
        value['runtimes']['runsc-project']['options'] = {'kept': True}
        self.daemon.write_text(json.dumps(value))
        self.restore()
        project = json.loads(self.daemon.read_text())['runtimes']['runsc-project']
        self.assertEqual(project['options'], {'kept': True})
        self.assertEqual(project['path'], OLD)

    def test_release_without_assessed_runtime_is_left_alone(self):
        before = self.daemon.read_bytes()
        for profile in ({}, {'runtime': {'path': OLD}}):
            (self.root / managed.ASSESSMENT_CONFIG).write_text(json.dumps({'profile': profile}))
            self.assertFalse(self.restore())
        (self.root / managed.ASSESSMENT_CONFIG).unlink()
        self.assertFalse(self.restore())
        self.assertEqual(self.calls, [])
        self.assertEqual(self.daemon.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
