"""Managed provisioning guards; native firewall acceptance remains a separate gate."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'project-egress-managed.py'
spec = importlib.util.spec_from_file_location('egress_managed', SOURCE)
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)


CONTROL_GID = os.getgid()


class ManagedTests(unittest.TestCase):
    def setUp(self):
        self.chown = patch.object(managed.os, 'chown')
        self.chown.start()
        self.addCleanup(self.chown.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.clean)
        self.root = Path(self.temp.name) / 'host'
        self.root.mkdir()
        self.source = Path(self.temp.name) / 'release'
        self.source.mkdir()
        self.manifest = {}
        for name in managed.ASSETS:
            data = name.encode()
            if name in managed.base.UNITS:
                data = (SOURCE.parents[1] / 'deploy/egress' / name).read_bytes()
            (self.source / name).write_bytes(data)
            self.manifest[name] = managed.base.digest(data)
        self.save_manifest()
        self.relay = Path(self.temp.name) / 'relay.json'
        self.relay.write_text('{"packetEnforcement":true}')
        self.authority = Path(self.temp.name) / 'authority.json'
        self.authority.write_text('{"databaseUrl":"postgres://u:password@postgres/verity"}')
        self.calls = []
        self.loaded = False

    def clean(self):
        for path in Path(self.temp.name).rglob('*'):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o755)
        self.temp.cleanup()

    def save_manifest(self):
        (self.source / 'manifest.json').write_text(json.dumps(self.manifest))

    def execute(self, *args):
        self.calls.append(args)
        if '--property=ActiveState' in args:
            return 'inactive'
        if 'show' in args:
            return 'loaded' if self.loaded else 'not-found'
        if 'daemon-reload' in args:
            self.loaded = (self.root / managed.base.UNITS['verity-egress-host.service']).exists()
        return ''

    def provision(self, check=lambda *_: None, run=None, **kwargs):
        return managed.provision(self.source, self.relay, self.authority, CONTROL_GID,
                                 self.root, run or self.execute, check, group_setup=lambda *_: None, **kwargs)

    def test_protected_toolchain_is_immutable_and_helper_is_transactional(self):
        self.assertTrue(self.provision()['available'])
        release = (self.root / 'opt/verity-egress').resolve()
        for name in ('node', 'devcontainer.js', 'docker-buildx', 'protected-build-toolchain.json'):
            self.assertEqual((release / name).read_bytes(), name.encode())
            self.assertEqual((release / name).stat().st_mode & 0o222, 0)
        helper = self.root / 'usr/local/libexec/verity-buildkit/protected-build-attempt'
        self.assertEqual(helper.read_bytes(), b'protected-build-attempt')
        self.assertEqual(helper.stat().st_mode & 0o777, 0o755)
        self.assertIn('Slice=verity-buildkit.slice', (self.root / managed.BUILD_DROPIN).read_text())
        self.assertIn('MemoryMax=', (self.root / managed.BUILD_SLICE).read_text())
        self.assertIn('usr/local/libexec/verity-buildkit/protected-build-attempt', managed.TRANSACTION_FILES)

    def test_controller_needs_no_ephemeral_cni_mounts_after_reboot(self):
        self.assertTrue(self.provision()['available'])
        unit = (self.root / managed.base.UNITS['verity-egress-host.service']).read_text()
        writable = next(line for line in unit.splitlines() if line.startswith('ReadWritePaths='))
        self.assertNotIn('/run/netns', writable)
        self.assertNotIn('/run/verity-buildkit', writable)

    def test_existing_smaller_builder_budget_bounds_protected_attempts(self):
        unit = self.root / 'etc/systemd/system/verity-buildkit.service'
        unit.parent.mkdir(parents=True)
        unit.write_text('[Service]\nCPUQuota=50%\nMemoryMax=512M\n')
        self.assertTrue(self.provision()['available'])
        budget = (self.root / managed.BUILD_SLICE).read_text()
        self.assertIn('CPUQuota=50%', budget)
        self.assertIn('MemoryMax=512M', budget)

    def test_protected_export_can_write_only_the_managed_data_volume(self):
        self.relay.write_text('{"packetEnforcement":true,"dataVolume":"verity-data"}')
        parent = self.root / 'var/lib/docker/volumes/verity-data/_data'
        parent.mkdir(parents=True)
        storage = parent / 'build-storage'
        self.assertFalse(storage.exists())
        def execute(*args):
            if args == ('/usr/bin/systemctl', 'start', managed.SERVICE):
                self.assertTrue(storage.is_dir())
                self.assertEqual(storage.stat().st_uid, parent.stat().st_uid)
                self.assertEqual(storage.stat().st_mode & 0o777, 0o700)
            return self.execute(*args)
        self.assertTrue(self.provision(run=execute)['available'])
        (storage / 'preserved').write_text('existing build')
        self.assertTrue(self.provision(run=execute)['available'])
        self.assertEqual((storage / 'preserved').read_text(), 'existing build')
        unit = (self.root / managed.base.UNITS['verity-egress-host.service']).read_text()
        self.assertIn('-/var/lib/docker/volumes/verity-data/_data/build-storage ', unit)
        self.assertNotIn('ReadWritePaths=/var/lib/docker/volumes ', unit)
        self.relay.write_text('{"packetEnforcement":true,"dataVolume":"../foreign"}')
        with self.assertRaises(ValueError):
            self.provision()

    def test_build_storage_rejects_symlink_before_controller_start(self):
        parent = self.root / 'var/lib/docker/volumes/verity-data/_data'
        parent.mkdir(parents=True)
        (parent / 'build-storage').symlink_to(self.source, target_is_directory=True)
        self.relay.write_text('{"packetEnforcement":true,"dataVolume":"verity-data"}')
        with self.assertRaises((OSError, ValueError)):
            self.provision()
        self.assertNotIn(('/usr/bin/systemctl', 'start', managed.SERVICE), self.calls)

    def test_prior_release_without_protected_assets_remains_recoverable(self):
        files = {name: self.source.joinpath(name).read_bytes() for name in managed.LEGACY_ASSETS}
        identity = managed.base.digest(b''.join(name.encode() + files[name] for name in managed.LEGACY_ASSETS))
        release = self.root / 'opt/verity-egress-releases' / identity
        managed.prepare_release(release, files)
        self.assertEqual(managed.verified_release(self.root, str(release)), release)
        (release / 'node').chmod(0o644)
        with self.assertRaises(ValueError):
            managed.verified_release(self.root, str(release))

    def unsupported(self, *_):
        raise ValueError('Kernel has no accepted native installation profile')

    def test_staging_descriptor_is_private_transactional_and_never_production_evidence(self):
        authorization = self.source.parent / 'assessment-authorization.json'
        authorization.write_text('{"operation":"fixed-updater-test"}')
        authorization.chmod(0o600)
        descriptor = {'scope': 'staging-assessment', 'productionAccepted': False,
                      'authorization': {'operation': 'fixed-updater-test'}, 'profile': {}}
        with patch.object(managed.base, 'prepare_staging_assessment', return_value=descriptor) as prepare, patch.object(managed.base, 'runtime_preflight') as verify:
            result = self.provision(assessment_authorization=authorization)
        self.assertTrue(result['available'])
        prepare.assert_called_once()
        self.assertEqual(prepare.call_args.args[-1], {'operation': 'fixed-updater-test'})
        self.assertEqual(verify.call_args.kwargs, {'assessment': descriptor})
        stored = self.root / managed.ASSESSMENT_CONFIG
        self.assertEqual(json.loads(stored.read_text()), descriptor)
        self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
        self.assertIs(json.loads((self.root / managed.ASSESSMENT_NOTICE).read_text())['productionAccepted'], False)
        self.assertEqual(managed.base.ACCEPTED_NATIVE_PROFILES, ())

    def test_precondition_codes_are_persisted_without_raw_errors(self):
        for reason in ('assessment_authorization_invalid', 'docker_host_unsupported',
                       'native_package_unavailable', 'relay_runtime_missing'):
            def fail(*_):
                raise managed.base.PreflightError(reason)
            result = self.provision(fail)
            self.assertFalse(result['available'])
            self.assertEqual(result['reason'], reason)
            for relative in ('run/verity-egress/status.json', 'etc/verity-egress-server/status.json'):
                self.assertEqual(json.loads((self.root / relative).read_text())['reason'], reason)

    def test_unclassified_assessment_failure_identifies_step_without_raw_error(self):
        authorization = self.source.parent / 'authorization.json'
        authorization.write_text('{}')
        authorization.chmod(0o600)
        with patch.object(managed.base, 'prepare_staging_assessment', side_effect=ValueError('private diagnostic')):
            result = self.provision(assessment_authorization=authorization)
        self.assertEqual(result['reason'], 'native_prerequisites_failed')
        self.assertEqual(result['step'], 'prerequisites')
        self.assertEqual(json.loads((self.root / 'run/verity-egress/status.json').read_text())['reason'], 'provisioning_failed')
        self.assertNotIn('private diagnostic', (self.root / 'run/verity-egress/status.json').read_text())

    def test_cli_preserves_only_safe_failure_codes_and_steps(self):
        for error, reason, step in (
                (managed.base.PreflightError('relay_runtime_mismatch', 'prerequisites'), 'relay_runtime_mismatch', 'prerequisites'),
                (managed.base.PreflightError('postgres://private', 'private-path'), 'provisioning_failed', 'validation'),
                (managed.base.PreflightError(['private'], ['private']), 'provisioning_failed', 'validation'),
                (RuntimeError('postgres://private'), 'provisioning_failed', 'validation')):
            output = io.StringIO()
            with self.subTest(reason=reason), patch.object(sys, 'argv', ['managed', 'provision', str(self.source)]), \
                    patch.object(managed, 'provision', side_effect=error), patch('sys.stdout', output):
                with self.assertRaises(SystemExit) as exited:
                    managed.main()
            self.assertEqual(exited.exception.code, 1)
            result = json.loads(output.getvalue())
            self.assertEqual(result['reason'], reason)
            self.assertEqual(result['step'], step)
            self.assertFalse(result['available'])
            self.assertNotIn('private', output.getvalue())

    def test_recovery_and_activation_exceptions_retain_safe_step(self):
        for function, reason, step in (('recover_transaction', 'recovery_failed', 'recovery'),
                                       ('activate', 'activation_failed', 'activation')):
            with self.subTest(step=step), patch.object(managed, function, side_effect=RuntimeError('private error')):
                with self.assertRaises(RuntimeError) as failed:
                    self.provision()
            self.assertEqual(managed.base.failure_diagnostic(failed.exception), {'reason': reason, 'step': step})
            status = json.loads((self.root / 'run/verity-egress/status.json').read_text())
            self.assertEqual(status['reason'], 'controller_failed')

    def test_cli_rejects_unverified_relay_rollback_without_assessment(self):
        provision = managed.provision

        def failed_rollback(*_):
            raise managed.base.PreflightError('relay_rollback_failed', 'prerequisites')

        def provision_fixture(*args, **kwargs):
            return provision(self.source, self.relay, self.authority, CONTROL_GID,
                             self.root, self.execute, failed_rollback, group_setup=lambda *_: None)

        output = io.StringIO()
        with patch.object(sys, 'argv', ['managed', 'provision', str(self.source)]), \
                patch.object(managed, 'provision', side_effect=provision_fixture), patch('sys.stdout', output):
            with self.assertRaises(SystemExit) as exited:
                managed.main()
        self.assertEqual(exited.exception.code, 1)
        result = json.loads(output.getvalue())
        self.assertFalse(result['available'])
        self.assertEqual(result['reason'], 'relay_rollback_failed')
        self.assertEqual(result['step'], 'prerequisites')
        self.assertEqual(json.loads((self.root / 'run/verity-egress/status.json').read_text())['reason'], 'provisioning_failed')
        self.assertFalse((self.root / managed.INVENTORY_CONTRACT).exists())

    def test_cli_reports_failed_assessment_as_failure(self):
        authorization = self.source.parent / 'authorization.json'
        argv = ['managed', 'provision', str(self.source), '--relay-config', str(self.relay),
                '--authority-config', str(self.authority), '--assessment-authorization', str(authorization)]
        for available in (False, True):
            with patch.object(sys, 'argv', argv), patch.object(managed, 'provision',
                    return_value={'available': available, 'reason': 'ready' if available else 'docker_host_unsupported'}):
                if available:
                    managed.main()
                else:
                    with self.assertRaises(SystemExit) as error:
                        managed.main()
                    self.assertEqual(error.exception.code, 1)

    def test_runtime_verifier_uses_private_assessment_only_after_production_rejection(self):
        self.provision()
        path = self.root / managed.ASSESSMENT_CONFIG
        managed.base.atomic_file(path, b'{"scope":"staging-assessment"}', 0o600)
        with patch.object(managed.base, 'runtime_preflight', side_effect=[ValueError('not accepted'), None]) as verify:
            managed.verify_runtime(self.root, self.execute)
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(verify.call_args.kwargs, {'assessment': {'scope': 'staging-assessment'}})
        path.chmod(0o644)
        with patch.object(managed.base, 'runtime_preflight', side_effect=ValueError('not accepted')):
            with self.assertRaises(ValueError):
                managed.verify_runtime(self.root, self.execute)
        with patch.object(managed.base, 'runtime_preflight') as verify:
            managed.verify_runtime(self.root, self.execute)
        verify.assert_called_once()
        self.assertEqual(verify.call_args.kwargs, {})

    def test_default_activation_rejects_unaccepted_profile_on_every_retry(self):
        # A synthetic unsupported callback would miss skipped production preflight.
        self.assertEqual(managed.base.ACCEPTED_NATIVE_PROFILES, ())
        (self.root / 'proc/1').mkdir(parents=True)
        (self.root / 'proc/1/comm').write_text('systemd\n')
        with patch.object(managed.base, 'accepted_native_profile',
                          wraps=managed.base.accepted_native_profile) as gate:
            results = [managed.provision(self.source, self.relay, self.authority,
                       CONTROL_GID, self.root, self.execute,
                       group_setup=lambda *_: None) for _ in range(2)]
        self.assertEqual(gate.call_count, 2)
        self.assertEqual(results, [{'available': False, 'reason': 'runtime_unsupported',
                                   'controlGid': CONTROL_GID}] * 2)
        self.assertFalse((self.root / managed.INVENTORY_CONTRACT).exists())
        self.assertFalse((self.root / managed.JOURNAL).exists())
        self.assertFalse((self.root / 'opt/verity-egress').exists())
        self.assertEqual(self.calls, [])

    def test_unsupported_activation_preserves_preparation_outcome_contract(self):
        # Native boot staging compares ordinary rejection with prepare-only output.
        prepared = self.provision(prepare_only=True)
        rejected = self.provision(self.unsupported)
        self.assertEqual(rejected, prepared)
        self.assertFalse(rejected['available'])
        self.assertFalse((self.root / managed.INVENTORY_CONTRACT).exists())
        self.assertFalse((self.root / 'opt/verity-egress').is_symlink())

    def test_unsupported_prepares_usable_mounts_without_firewall_or_units(self):
        result = self.provision(self.unsupported)
        self.assertEqual(result, {'available': False, 'reason': 'runtime_unsupported',
                                 'controlGid': CONTROL_GID})
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / 'opt/verity-egress').exists())
        self.assertFalse((self.root / managed.INVENTORY_CONTRACT).exists())
        self.assertFalse((self.root / 'etc/systemd').exists())
        for relative in ['etc/verity-egress/control.key', 'etc/verity-egress/authority.json']:
            self.assertEqual((self.root / relative).stat().st_mode & 0o777, 0o600)
        projection = self.root / 'etc/verity-egress-server/control.key'
        self.assertEqual(projection.stat().st_gid, CONTROL_GID)
        self.assertEqual(projection.stat().st_mode & 0o777, 0o640)
        self.assertEqual(projection.read_bytes(), (self.root / 'etc/verity-egress/control.key').read_bytes())
        status = json.loads((self.root / 'run/verity-egress/status.json').read_text())
        self.assertEqual(status, {'version': 1, 'state': 'unavailable', 'reason': 'runtime_unsupported'})
        tmpfiles = (self.root / 'etc/tmpfiles.d/verity-egress.conf').read_text()
        self.assertIn(f'd /run/verity-egress 0750 0 {CONTROL_GID}', tmpfiles)
        self.assertIn('/etc/verity-egress-server/status.json', tmpfiles)

    def test_inventory_contract_precedes_controller_and_survives_failed_upgrade(self):
        observed = []

        def run(*args):
            if 'start' in args and args[-1] == managed.SERVICE:
                contract = self.root / managed.INVENTORY_CONTRACT
                self.assertEqual(json.loads(contract.read_text()), {'version': 1, 'required': True})
                self.assertEqual(contract.stat().st_mode & 0o777, 0o640)
                self.assertEqual(contract.stat().st_gid, CONTROL_GID)
                observed.append(True)
            return self.execute(*args)

        self.provision(run=run)
        self.assertTrue(observed)
        self.crash_upgrade()
        self.assertTrue((self.root / managed.INVENTORY_CONTRACT).is_file())
        self.assertNotIn(managed.INVENTORY_CONTRACT, managed.TRANSACTION_FILES)

    def test_prepare_requires_no_database_or_configuration_and_never_checks_runtime(self):
        result = managed.provision(self.source, gid=CONTROL_GID, root=self.root, run=self.execute,
                                   check=lambda *_: self.fail('prepare called preflight'), prepare_only=True,
                                   group_setup=lambda *_: None)
        self.assertFalse(result['available'])
        self.assertTrue((self.root / 'etc/verity-egress/control.key').exists())
        self.assertFalse((self.root / 'etc/verity-egress/authority.json').exists())
        self.assertEqual(self.calls, [])

    def test_repeated_prepare_preserves_key_projection_and_directory_inodes(self):
        self.provision(self.unsupported)
        paths = [self.root / relative for relative in ['etc/verity-egress/control.key',
                 'etc/verity-egress-server/control.key', 'run/verity-egress']]
        before = [(path.stat().st_ino, path.read_bytes() if path.is_file() else None) for path in paths]
        self.provision(self.unsupported)
        self.assertEqual(before, [(path.stat().st_ino, path.read_bytes() if path.is_file() else None)
                                  for path in paths])

    def test_relay_created_after_config_snapshot_is_retained_before_replacement_starts(self):
        old_image, new_image = 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64
        relay_id = 'c' * 64
        self.relay.write_text(json.dumps({'image': old_image, 'packetEnforcement': True}))
        self.provision()
        self.relay.write_text(json.dumps({'image': new_image, 'packetEnforcement': True}))
        observed = []

        def run(*args):
            if 'stop' in args and args[-1] == managed.SERVICE:
                registry = self.root / 'var/lib/verity-egress/registry.json'
                managed.base.atomic_file(registry, json.dumps({'version': 1, 'records': [
                    {'retired': False, 'containers': {'relay': relay_id}}]}).encode(), 0o600)
            if 'container' in args and 'inspect' in args:
                self.calls.append(args)
                return json.dumps([{'Id': relay_id, 'Config': {'Image': old_image}}])
            if 'start' in args and args[-1] == managed.SERVICE:
                policy = json.loads((self.root / 'etc/verity-egress/relay.json').read_text())
                self.assertEqual(policy['previousImage'], old_image)
                observed.append(policy)
            return self.execute(*args)

        self.provision(run=run)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0]['image'], new_image)
        stop = max(i for i, args in enumerate(self.calls) if 'stop' in args and args[-1] == managed.SERVICE)
        inspect = max(i for i, args in enumerate(self.calls) if 'container' in args and 'inspect' in args)
        self.assertLess(stop, inspect)

    def test_stopped_relay_reconciliation_rejects_unknown_third_or_changed_contract(self):
        old, older, target, foreign = ['sha256:' + c * 64 for c in 'abcd']
        self.relay.write_text(json.dumps({'image': old, 'packetEnforcement': True}))
        self.provision()
        managed.base.atomic_file(self.root / 'etc/verity-egress/relay.json',
            json.dumps({'image': old, 'previousImage': older, 'packetEnforcement': True}).encode(), 0o600)
        for images, extra, reason in [([foreign], {}, 'outside installed'),
                                     ([old, older], {}, 'more than one'),
                                     ([old], {'relayGid': 42}, 'contract cannot change')]:
            records = [{'containers': {'relay': str(i + 1) * 64}} for i in range(len(images))]
            managed.base.atomic_file(self.root / 'var/lib/verity-egress/registry.json',
                json.dumps({'version': 1, 'records': records}).encode(), 0o600)
            def run(*args):
                index = int(args[-1][0]) - 1
                return json.dumps([{'Id': args[-1], 'Config': {'Image': images[index]}}])
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                managed.reconcile_stopped_relay_policy(self.root, run,
                    json.dumps({'image': target, 'packetEnforcement': True, **extra}).encode())

    def test_corrupt_assets_never_touch_host(self):
        (self.source / 'node').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.provision()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_group_collision_rejected_before_key_projection(self):
        unrelated = SimpleNamespace(gr_name='unrelated', gr_gid=65531, gr_mem=[])
        with patch.object(managed.grp, 'getgrgid', return_value=unrelated), \
                patch.object(managed.grp, 'getgrnam', side_effect=KeyError), \
                patch.object(managed.pwd, 'getpwall', return_value=[]):
            with self.assertRaisesRegex(ValueError, 'unrelated'):
                managed.provision(self.source, gid=65531, root=self.root,
                                  run=self.execute, prepare_only=True)
        self.assertFalse((self.root / 'etc/verity-egress-server/control.key').exists())
        self.assertEqual(self.calls, [])

    def test_named_group_with_primary_host_member_is_rejected(self):
        group = SimpleNamespace(gr_name='verity-egress-control', gr_gid=65531, gr_mem=[])
        user = SimpleNamespace(pw_gid=65531, pw_uid=1001)
        with patch.object(managed.grp, 'getgrgid', return_value=group), \
                patch.object(managed.grp, 'getgrnam', return_value=group), \
                patch.object(managed.pwd, 'getpwall', return_value=[user]):
            with self.assertRaisesRegex(ValueError, 'host members'):
                managed.ensure_control_group(65531, self.execute)
        self.assertEqual(self.calls, [])

    def test_missing_group_is_created_and_verified(self):
        group = SimpleNamespace(gr_name='verity-egress-control', gr_gid=65531, gr_mem=[])
        with patch.object(managed.grp, 'getgrgid', side_effect=KeyError), \
                patch.object(managed.grp, 'getgrnam', side_effect=[KeyError(), group]):
            managed.ensure_control_group(65531, self.execute)
        self.assertEqual(self.calls, [('/usr/sbin/groupadd', '--system', '--gid',
                                       '65531', 'verity-egress-control')])

    def test_unsafe_key_symlink_and_state_directory_are_rejected(self):
        self.provision(self.unsupported)
        key = self.root / 'etc/verity-egress/control.key'
        key.unlink()
        key.symlink_to(self.relay)
        with self.assertRaisesRegex(ValueError, 'Untrusted'):
            self.provision(self.unsupported)
        self.assertEqual(self.relay.read_text(), '{"packetEnforcement":true}')

    def test_accepted_install_never_stops_or_restarts_docker(self):
        self.assertTrue(self.provision()['available'])
        docker_mutations = [args for args in self.calls if any(
            unit in args for unit in ('docker.service', 'docker.socket'))]
        self.assertEqual(docker_mutations, [])
        host = (self.root / managed.base.UNITS['verity-egress-host.service']).read_text()
        docker = (self.root / managed.base.UNITS['docker-egress.conf']).read_text()
        self.assertNotIn('Upholds=', docker)
        self.assertIn('Wants=verity-egress-host.service', docker)
        self.assertIn('ExecStartPre=', docker)
        self.assertIn(f'Group={CONTROL_GID}', host)
        self.assertIn('/opt/verity-egress/node ', host)
        self.assertIn('project-egress-managed.py refresh-authority', host)
        self.assertLess(host.index('project-egress-managed.py verify-runtime'),
                        host.index('project-egress-managed.py refresh-authority'))
        self.assertNotIn('not installed by verity-install', host)
        writable = ' '.join(line.partition('=')[2] for line in host.splitlines()
                            if line.startswith('ReadWritePaths='))
        self.assertIn('/etc/verity-egress', writable.split())
        self.assertEqual((self.root / 'usr/local/libexec/verity/project-egress-managed.py').read_bytes(),
                         SOURCE.read_bytes())
        self.assertLess(next(i for i, cmd in enumerate(self.calls) if cmd[-1] == 'deny'),
                        max(i for i, cmd in enumerate(self.calls) if 'daemon-reload' in cmd))
        self.assertEqual((self.root / 'opt/verity-egress/node').stat().st_mode & 0o777, 0o555)

    def test_unmanaged_prefix_collision_never_applies_rules(self):
        for prefix in ('vep', 'veb'):
            with self.subTest(prefix=prefix):
                bridge = self.root / ('sys/class/net/' + prefix + '-unrelated')
                bridge.mkdir(parents=True)
                try:
                    with self.assertRaisesRegex(ValueError, 'collides'):
                        self.provision()
                    self.assertFalse(any(cmd[-1] == 'deny' for cmd in self.calls))
                    self.assertFalse((self.root / 'etc/systemd').exists())
                finally:
                    bridge.rmdir()

    def test_build_bridge_ownership_requires_private_checkpoint_and_live_network_identity(self):
        bridge = 'veb' + 'a' * 12
        (self.root / 'sys/class/net' / bridge).mkdir(parents=True)
        request = {'projectId': 'project-one', 'attemptId': 'attempt-one'}
        state = self.root / 'var/lib/verity/protected-build'
        state.mkdir(parents=True)
        controller = state / 'controller.json'
        controller.write_text(json.dumps({'request': request}))
        controller.chmod(0o600)
        key = managed.base.digest((request['projectId'] + '\0' + request['attemptId']).encode())
        checkpoint = state / 'attempts' / key / 'checkpoint.json'
        checkpoint.parent.mkdir(parents=True)
        binding = {'projectId': request['projectId'], 'bridge': bridge, 'networkId': 'b' * 64}
        checkpoint.write_text(json.dumps({'binding': binding, 'attemptId': request['attemptId']}))
        checkpoint.chmod(0o600)
        network = {'Id': binding['networkId'], 'Driver': 'bridge',
                   'Options': {'com.docker.network.bridge.name': bridge}}
        managed.reject_bridge_collisions(self.root, lambda *_: json.dumps([network]))
        network['Id'] = 'c' * 64
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            managed.reject_bridge_collisions(self.root, lambda *_: json.dumps([network]))
        binding['networkName'] = 'verity-build-intent'
        point = {'binding': binding, 'attemptId': request['attemptId'], 'pending': True}
        checkpoint.write_text(json.dumps(point))
        network.update(Name=binding['networkName'], EnableIPv6=True,
                       Labels={'io.verity.build-intent': binding['networkId']})
        managed.reject_bridge_collisions(self.root, lambda *_: json.dumps([network]))
        network['Labels']['io.verity.build-intent'] = 'd' * 64
        with self.assertRaisesRegex(ValueError, 'intent changed'):
            managed.reject_bridge_collisions(self.root, lambda *_: json.dumps([network]))
        checkpoint.chmod(0o666)
        with self.assertRaises(ValueError):
            managed.reject_bridge_collisions(self.root, lambda *_: json.dumps([network]))

    def test_failed_upgrade_restores_bundle_and_config_without_touching_docker(self):
        self.provision()
        previous = (self.root / 'opt/verity-egress').resolve()
        config = (self.root / 'etc/verity-egress/authority.json').read_bytes()
        (self.source / 'node').write_bytes(b'updated node')
        self.manifest['node'] = managed.base.digest(b'updated node')
        self.save_manifest()
        self.authority.write_text('{"databaseUrl":"postgres://changed@postgres/verity"}')
        self.calls.clear()

        def fail(*args):
            self.execute(*args)
            if 'is-active' in args:
                raise RuntimeError('Readiness failed')
            return 'loaded' if 'show' in args else ''

        with self.assertRaisesRegex(RuntimeError, 'Readiness'):
            self.provision(run=fail)
        self.assertEqual((self.root / 'opt/verity-egress').resolve(), previous)
        self.assertEqual((self.root / 'etc/verity-egress/authority.json').read_bytes(), config)
        failure = next(i for i, cmd in enumerate(self.calls) if 'is-active' in cmd)
        self.assertFalse(any('start' in cmd for cmd in self.calls[failure + 1:]))
        self.assertFalse(any('docker.service' in cmd or 'docker.socket' in cmd for cmd in self.calls))
        self.assertTrue(any(cmd[-1] == 'deny' for cmd in self.calls[failure + 1:]))

    def crash_upgrade(self):
        self.provision()
        previous = (self.root / 'opt/verity-egress').resolve()
        config = (self.root / 'etc/verity-egress/authority.json').read_bytes()
        key = (self.root / 'etc/verity-egress/control.key').read_bytes()
        (self.source / 'node').write_bytes(b'updated node')
        self.manifest['node'] = managed.base.digest(b'updated node')
        self.save_manifest()
        self.authority.write_text('{"databaseUrl":"postgres://changed@postgres/verity"}')

        def crash(*args):
            self.execute(*args)
            if 'is-active' in args:
                raise KeyboardInterrupt('simulated process death')
            return 'loaded' if 'show' in args else ''

        with self.assertRaises(KeyboardInterrupt):
            self.provision(run=crash)
        journal = self.root / managed.JOURNAL
        self.assertTrue(journal.exists())
        self.assertEqual(journal.stat().st_mode & 0o777, 0o600)
        value = json.loads(journal.read_text())
        self.assertEqual(value['previous'], str(previous))
        self.assertEqual((self.root / 'opt/verity-egress').resolve(), Path(value['target']))
        self.assertNotEqual((self.root / 'etc/verity-egress/authority.json').read_bytes(), config)
        return previous, config, key

    def test_interrupted_upgrade_recovers_before_unsupported_preflight(self):
        previous, config, key = self.crash_upgrade()
        self.calls.clear()
        # No in-memory activation stack survives; the next invocation reads the journal.
        self.provision(self.unsupported)
        self.assertEqual((self.root / 'opt/verity-egress').resolve(), previous)
        self.assertEqual((self.root / 'etc/verity-egress/authority.json').read_bytes(), config)
        self.assertEqual((self.root / 'etc/verity-egress/control.key').read_bytes(), key)
        self.assertFalse((self.root / managed.JOURNAL).exists())
        self.assertTrue(any(cmd[-1] == 'deny' for cmd in self.calls))
        self.assertFalse(any('start' in cmd or 'docker.service' in cmd for cmd in self.calls))
        before = list(self.calls)
        self.provision(self.unsupported)
        self.assertEqual(self.calls, before)

    def test_recovery_denial_failure_preserves_journal_and_changed_authority(self):
        self.crash_upgrade()
        current = (self.root / 'opt/verity-egress').resolve()
        config = (self.root / 'etc/verity-egress/authority.json').read_bytes()

        def fail(*args):
            self.execute(*args)
            if args[-1] == 'deny':
                raise RuntimeError('denial unavailable')
            return 'loaded' if 'show' in args else ''

        with self.assertRaisesRegex(RuntimeError, 'denial unavailable'):
            self.provision(self.unsupported, run=fail)
        self.assertTrue((self.root / managed.JOURNAL).exists())
        self.assertEqual((self.root / 'opt/verity-egress').resolve(), current)
        self.assertEqual((self.root / 'etc/verity-egress/authority.json').read_bytes(), config)
        self.assertEqual(json.loads((self.root / 'run/verity-egress/status.json').read_text())['reason'],
                         'controller_failed')
        self.provision(self.unsupported)
        self.assertFalse((self.root / managed.JOURNAL).exists())

    def test_failed_controller_stop_still_attempts_denial_without_restoration(self):
        self.crash_upgrade()
        current = (self.root / 'opt/verity-egress').resolve()
        config = (self.root / 'etc/verity-egress/authority.json').read_bytes()
        journal = (self.root / managed.JOURNAL).read_bytes()
        for deny_fails in (False, True):
            with self.subTest(deny_fails=deny_fails):
                self.calls.clear()

                def fail(*args):
                    self.execute(*args)
                    if 'stop' in args:
                        raise RuntimeError('controller stop failed')
                    if args[-1] == 'deny' and deny_fails:
                        raise RuntimeError('denial failed')
                    return 'loaded' if 'show' in args else ''

                with self.assertRaisesRegex(RuntimeError,
                        'denial failed' if deny_fails else 'controller stop failed'):
                    self.provision(self.unsupported, run=fail)
                stop = next(i for i, cmd in enumerate(self.calls) if 'stop' in cmd)
                deny = next(i for i, cmd in enumerate(self.calls) if cmd[-1] == 'deny')
                self.assertLess(stop, deny)
                self.assertFalse(any('daemon-reload' in cmd or 'start' in cmd for cmd in self.calls))
                self.assertEqual((self.root / managed.JOURNAL).read_bytes(), journal)
                self.assertEqual((self.root / 'opt/verity-egress').resolve(), current)
                self.assertEqual((self.root / 'etc/verity-egress/authority.json').read_bytes(), config)
        self.provision(self.unsupported)
        self.assertFalse((self.root / managed.JOURNAL).exists())

    def test_recovery_rejects_journal_paths_outside_fixed_destinations(self):
        self.crash_upgrade()
        journal = self.root / managed.JOURNAL
        value = json.loads(journal.read_text())
        value['snapshots']['etc/unrelated'] = b'mutated'.hex()
        managed.base.atomic_file(journal, json.dumps(value).encode(), 0o600)
        self.calls.clear()
        with self.assertRaisesRegex(ValueError, 'Invalid managed transaction'):
            self.provision(self.unsupported)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / 'etc/unrelated').exists())
        self.assertTrue(journal.exists())

    def test_interrupted_first_install_removes_partial_units_after_denial(self):
        def crash(*args):
            self.execute(*args)
            if 'daemon-reload' in args and (self.root / managed.JOURNAL).exists():
                raise KeyboardInterrupt('simulated process death')
            return 'loaded' if self.loaded else 'not-found'

        with self.assertRaises(KeyboardInterrupt):
            self.provision(run=crash)
        self.calls.clear()
        self.provision(self.unsupported)
        self.assertFalse((self.root / 'opt/verity-egress').is_symlink())
        self.assertFalse((self.root / managed.base.UNITS['verity-egress-host.service']).exists())
        self.assertFalse((self.root / managed.JOURNAL).exists())
        self.assertTrue(any(cmd[-1] == 'deny' for cmd in self.calls))
        self.assertFalse(any('start' in cmd for cmd in self.calls))

    def test_recovery_dependency_is_durable_before_first_activation_journal(self):
        observed = []

        def run(*args):
            self.execute(*args)
            if args[-1] == 'verity-egress-recovery.service':
                self.assertFalse((self.root / managed.JOURNAL).exists())
                unit = (self.root / managed.RECOVERY_UNIT).read_text()
                writable = next(line.partition('=')[2].split() for line in unit.splitlines()
                                if line.startswith('ReadWritePaths='))
                for absolute in writable:
                    self.assertTrue((self.root / absolute.lstrip('/')).is_dir(), absolute)
                entry = next(line.split(' ', 2)[2].rsplit(' ', 1)[0]
                             for line in unit.splitlines() if line.startswith('ExecStart='))
                helper = Path(entry)
                self.assertTrue(helper.is_file())
                self.assertEqual(helper.stat().st_mode & 0o777, 0o444)
                self.assertEqual(helper.parent.stat().st_mode & 0o777, 0o555)
                self.assertIn('Before=verity-egress-bootstrap.service docker.service', unit)
                for relative in (managed.RECOVERY_DROPIN, managed.RECOVERY_DOCKER_DROPIN):
                    dropin = (self.root / relative).read_text()
                    self.assertIn('Requires=verity-egress-recovery.service', dropin)
                    self.assertIn('After=verity-egress-recovery.service', dropin)
                observed.append(helper)
            return 'loaded' if self.loaded else 'not-found'

        self.provision(run=run)
        self.assertEqual(len(observed), 1)
        self.assertNotIn(managed.RECOVERY_UNIT, managed.TRANSACTION_FILES)
        self.assertNotIn(managed.RECOVERY_DOCKER_DROPIN, managed.TRANSACTION_FILES)

    def test_boot_recovery_uses_immutable_helper_after_mutable_helper_replacement(self):
        self.crash_upgrade()
        unit = (self.root / managed.RECOVERY_UNIT).read_text()
        entry = next(line.split(' ', 2)[2].rsplit(' ', 1)[0]
                     for line in unit.splitlines() if line.startswith('ExecStart='))
        helper = Path(entry)
        mutable = self.root / 'usr/local/libexec/verity/project-egress-managed.py'
        mutable.write_text('raise RuntimeError("incomplete helper replacement")')
        copy_spec = importlib.util.spec_from_file_location('immutable_recovery', helper)
        copy = importlib.util.module_from_spec(copy_spec)
        with patch.object(sys, 'dont_write_bytecode', True):
            copy_spec.loader.exec_module(copy)
        self.assertTrue(copy.recover_boot(self.root, self.execute))
        self.assertFalse((self.root / managed.JOURNAL).exists())
        self.assertNotIn('incomplete helper replacement', mutable.read_text())
        status = json.loads((self.root / 'run/verity-egress/status.json').read_text())
        self.assertEqual(status['reason'], 'controller_failed')
        self.assertEqual(status['state'], 'unavailable')

    def test_boot_recovery_needs_no_source_or_runtime_admission_and_is_locked(self):
        previous, config, key = self.crash_upgrade()
        lock = self.root / 'var/lib/verity-egress/install.lock'
        with lock.open('a') as owner:
            managed.fcntl.flock(owner, managed.fcntl.LOCK_EX | managed.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                managed.recover_boot(self.root, self.execute)
        self.calls.clear()
        self.assertTrue(managed.recover_boot(self.root, self.execute))
        self.assertFalse(any('stop' in cmd for cmd in self.calls))
        self.assertEqual((self.root / 'opt/verity-egress').resolve(), previous)
        self.assertEqual((self.root / 'etc/verity-egress/authority.json').read_bytes(), config)
        self.assertEqual((self.root / 'etc/verity-egress/control.key').read_bytes(), key)
        self.assertFalse((self.root / managed.JOURNAL).exists())
        self.assertFalse(any('start' in cmd for cmd in self.calls))
        self.calls.clear()
        self.assertFalse(managed.recover_boot(self.root, self.execute))
        self.assertEqual(self.calls, [])

    def test_boot_recovery_stops_a_live_controller_before_independent_denial(self):
        self.crash_upgrade()
        self.calls.clear()

        def active(*args):
            result = self.execute(*args)
            return 'active' if '--property=ActiveState' in args else result

        self.assertTrue(managed.recover_boot(self.root, active))
        stop = next(i for i, cmd in enumerate(self.calls) if 'stop' in cmd)
        deny = next(i for i, cmd in enumerate(self.calls) if cmd[-1] == 'deny')
        self.assertLess(stop, deny)
        self.assertFalse(any('start' in cmd for cmd in self.calls))

    def test_unknown_boot_controller_state_denies_but_retains_journal(self):
        self.crash_upgrade()
        self.calls.clear()

        def unknown(*args):
            result = self.execute(*args)
            return 'unknown' if '--property=ActiveState' in args else result

        with self.assertRaisesRegex(ValueError, 'boot controller state'):
            managed.recover_boot(self.root, unknown)
        self.assertTrue((self.root / managed.JOURNAL).exists())
        self.assertTrue(any(cmd[-1] == 'deny' for cmd in self.calls))
        self.assertFalse(any('daemon-reload' in cmd for cmd in self.calls))

    def test_unsupported_upgrade_preserves_running_bundle_units_and_config(self):
        self.provision()
        previous = (self.root / 'opt/verity-egress').resolve()
        config = (self.root / 'etc/verity-egress/authority.json').read_bytes()
        self.authority.write_text('{"databaseUrl":"changed"}')
        self.calls.clear()
        self.provision(self.unsupported)
        self.assertEqual((self.root / 'opt/verity-egress').resolve(), previous)
        self.assertEqual((self.root / 'etc/verity-egress/authority.json').read_bytes(), config)
        self.assertEqual(self.calls, [])

    def test_database_refresh_requires_unique_sealed_identity_and_preserves_credentials(self):
        self.provision(self.unsupported)
        locator = self.root / 'etc/verity-egress/database.json'
        managed.base.atomic_file(locator, json.dumps({'version': 1, 'network': 'verity_default',
                                                      'service': 'postgres', 'database': 'verity'}).encode(), 0o600)
        identity = 'a' * 64

        def inspect(*args):
            if 'ps' in args:
                return identity
            return json.dumps([{'Id': identity, 'State': {'Running': True},
                                'Config': {'Labels': {'com.docker.compose.service': 'postgres'}},
                                'NetworkSettings': {'Networks': {'verity_default': {'IPAddress': '172.25.0.2'}}}}])

        managed.refresh_authority(self.root, inspect)
        self.assertEqual(json.loads((self.root / 'etc/verity-egress/authority.json').read_text())['databaseUrl'],
                         'postgres://u:password@172.25.0.2:5432/verity')
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            managed.refresh_authority(self.root, lambda *_: identity + '\n' + identity)


if __name__ == '__main__':
    unittest.main()
