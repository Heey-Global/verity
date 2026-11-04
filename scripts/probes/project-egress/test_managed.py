"""Managed provisioning guards; native firewall acceptance remains a separate gate."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
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
        if 'show' in args:
            return 'loaded' if self.loaded else 'not-found'
        if 'daemon-reload' in args:
            self.loaded = (self.root / managed.base.UNITS['verity-egress-host.service']).exists()
        return ''

    def provision(self, check=lambda *_: None, run=None, **kwargs):
        return managed.provision(self.source, self.relay, self.authority, CONTROL_GID,
                                 self.root, run or self.execute, check, group_setup=lambda *_: None, **kwargs)

    def unsupported(self, *_):
        raise ValueError('Kernel has no accepted native installation profile')

    def test_unsupported_prepares_usable_mounts_without_firewall_or_units(self):
        result = self.provision(self.unsupported)
        self.assertEqual(result, {'available': False, 'reason': 'runtime_unsupported', 'controlGid': CONTROL_GID})
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / 'opt/verity-egress').exists())
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
        writable = ' '.join(line.partition('=')[2] for line in host.splitlines()
                            if line.startswith('ReadWritePaths='))
        self.assertIn('/etc/verity-egress', writable.split())
        self.assertEqual((self.root / 'usr/local/libexec/verity/project-egress-managed.py').read_bytes(),
                         SOURCE.read_bytes())
        self.assertLess(next(i for i, cmd in enumerate(self.calls) if cmd[-1] == 'deny'),
                        next(i for i, cmd in enumerate(self.calls) if 'daemon-reload' in cmd))
        self.assertEqual((self.root / 'opt/verity-egress/node').stat().st_mode & 0o777, 0o555)

    def test_unmanaged_prefix_collision_never_applies_rules(self):
        (self.root / 'sys/class/net/vep-unrelated').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'collides'):
            self.provision()
        self.assertFalse(any(cmd[-1] == 'deny' for cmd in self.calls))
        self.assertFalse((self.root / 'etc/systemd').exists())

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
            if 'daemon-reload' in args:
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
