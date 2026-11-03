"""Offline installer orchestration guards; no privileged host commands."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'project-egress-install.py'
spec = importlib.util.spec_from_file_location('egress_install', SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.clean)
        self.controller_loaded = False
        self.controller_running = False
        self.root = Path(self.temp.name) / 'host'
        self.root.mkdir()
        assets = Path(self.temp.name) / 'assets'
        assets.mkdir()
        for name in installer.ASSETS:
            (assets / name).write_bytes(name.encode())
        self.release = Path(self.temp.name) / 'release'
        installer.stage(assets, self.release)
        self.calls = []

    def clean(self):
        for path in Path(self.temp.name).rglob('*'):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o755)
        self.temp.cleanup()

    def execute(self, *args):
        self.calls.append(args)
        if 'show' in args:
            return 'loaded' if args[-1] == 'verity-egress-host.service' and self.controller_loaded else 'not-found'
        if 'daemon-reload' in args:
            self.controller_loaded = (self.root / installer.UNITS['verity-egress-host.service']).exists()
        if args[1:] == ('stop', 'verity-egress-host.service'):
            if not self.controller_loaded:
                raise RuntimeError('Unit verity-egress-host.service not loaded')
            self.controller_running = False
        if args[1:] == ('start', 'verity-egress-host.service'):
            self.controller_running = True
        if args[-1] == 'deny' and self.controller_running:
            raise TimeoutError('service.lock held by running controller')
        return ''

    def apply(self, run=None):
        return installer.install(self.release, self.root, run or self.execute, lambda *_: None)

    def test_corrupt_release_fails_before_commands_or_host_mutation(self):
        (self.release / installer.ASSETS[0]).write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.apply()
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_preflight_failure_never_mutates_host(self):
        with self.assertRaisesRegex(ValueError, 'unsupported'):
            installer.install(self.release, self.root, self.execute,
                              lambda *_: (_ for _ in ()).throw(ValueError('unsupported')))
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_install_fences_before_units_then_uses_notify_readiness(self):
        identity = self.apply()
        current = self.root / 'opt/verity-egress'
        self.assertTrue(current.is_symlink())
        self.assertEqual(current.resolve().name, identity)
        deny_index = next(i for i, args in enumerate(self.calls) if args[-1] == 'deny')
        self.assertTrue(any(args[1:] == ('stop', 'docker.service') for args in self.calls[:deny_index]))
        self.assertFalse(any(args[1:] == ('stop', 'verity-egress-host.service') for args in self.calls[:deny_index]))
        self.assertEqual(self.calls[-1][1:], ('is-active', '--quiet', 'verity-egress-host.service'))
        for name, relative in installer.UNITS.items():
            self.assertEqual((self.root / relative).read_bytes(), (self.release / name).read_bytes())
        self.assertFalse((self.root / 'etc/verity-egress').exists())

    def test_failed_upgrade_restores_previous_files_and_never_restarts_old_controller(self):
        previous = self.apply()
        original_unit = (self.root / installer.UNITS['verity-egress-host.service']).read_bytes()
        manifest = json.loads((self.release / 'manifest.json').read_text())
        changed = b'new controller'
        (self.release / installer.ASSETS[0]).write_bytes(changed)
        manifest[installer.ASSETS[0]] = installer.digest(changed)
        (self.release / 'manifest.json').write_text(json.dumps(manifest))
        self.calls.clear()

        def fail_readiness(*args):
            result = self.execute(*args)
            if 'is-active' in args:
                raise RuntimeError('readiness failed')
            return result

        with self.assertRaisesRegex(RuntimeError, 'readiness failed'):
            self.apply(fail_readiness)
        self.assertEqual((self.root / 'opt/verity-egress').resolve().name, previous)
        self.assertEqual((self.root / installer.UNITS['verity-egress-host.service']).read_bytes(), original_unit)
        failures = [i for i, args in enumerate(self.calls) if 'is-active' in args]
        recovery = [args for args in self.calls[failures[0] + 1:] if 'show' not in args]
        self.assertEqual(recovery[0][1:], ('stop', 'docker.service'))
        self.assertEqual(recovery[1][1:], ('stop', 'verity-egress-host.service'))
        self.assertEqual(recovery[2][-1], 'deny')
        self.assertFalse(any('start' in args for args in recovery))

    def test_failed_first_install_restores_absent_units_and_leaves_fence_closed(self):
        def fail_start(*args):
            result = self.execute(*args)
            if args[1:] == ('start', 'verity-egress-host.service'):
                raise RuntimeError('controller rejected configuration')
            return result
        with self.assertRaises(RuntimeError):
            self.apply(fail_start)
        self.assertFalse((self.root / 'opt/verity-egress').exists())
        self.assertFalse(any((self.root / relative).exists() for relative in installer.UNITS.values()))
        self.assertEqual(sum(args[-1] == 'deny' for args in self.calls), 2)

    def test_unmanaged_install_is_not_overwritten(self):
        (self.root / 'opt/verity-egress').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'unmanaged'):
            self.apply()
        self.assertEqual(self.calls, [])

    def test_preflight_rejects_unsupported_hosts_without_running_mutations(self):
        (self.root / 'proc/1').mkdir(parents=True)
        (self.root / 'proc/1/comm').write_text('systemd')
        good = {'OSType': 'linux', 'ServerVersion': '29.9.2', 'LiveRestoreEnabled': False,
                'SecurityOptions': [], 'Runtimes': {'runsc-project': {}, 'runsc-relay': {}}}
        cases = [
            ('systemd 248', 'v26.12.1', good, 'systemd'),
            ('systemd 259', 'v26.12.0', good, 'Node'),
            ('systemd 259', 'v27.0.0', good, 'Node'),
            ('systemd 259', 'v26.12.1', {**good, 'ServerVersion': '30.0.0'}, 'Docker'),
            ('systemd 259', 'v26.12.1', {**good, 'LiveRestoreEnabled': True}, 'Docker'),
            ('systemd 259', 'v26.12.1', {**good, 'SecurityOptions': ['rootless']}, 'Docker'),
            ('systemd 259', 'v26.12.1', {**good, 'Runtimes': {}}, 'runtimes'),
            ('systemd 259', 'v26.12.1', good, 'native installation profile'),
        ]
        for systemd, node, docker, error in cases:
            with self.subTest(error=error, node=node, docker=docker):
                calls = []
                def readonly(*args):
                    calls.append(args)
                    return systemd if args[0].endswith('systemctl') else node if args[0].endswith('node') else json.dumps(docker)
                with (patch.object(installer.os, 'geteuid', return_value=0),
                      patch.object(installer.sys, 'platform', 'linux'),
                      patch.object(installer.platform, 'machine', return_value='x86_64'),
                      patch.object(installer.sys, 'byteorder', 'little')):
                    with self.assertRaisesRegex(ValueError, error):
                        installer.preflight(self.root, readonly)
                self.assertFalse(any('start' in args or 'stop' in args for args in calls))

    def test_symlinked_parent_is_rejected_before_install_commands(self):
        (self.root / 'opt').symlink_to(self.release, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Untrusted installation directory'):
            self.apply()
        self.assertEqual(self.calls, [])

    def test_docker_socket_activation_is_stopped_with_daemon(self):
        calls = []
        def execute(*args):
            calls.append(args)
            return 'loaded'
        installer.stop_docker(execute)
        self.assertEqual(calls[-1][1:], ('stop', 'docker.service', 'docker.socket'))

    def test_live_upgrade_releases_service_lock_before_independent_deny(self):
        self.apply()
        self.calls.clear()
        self.assertTrue(self.controller_running)
        self.apply()
        deny_index = next(i for i, args in enumerate(self.calls) if args[-1] == 'deny')
        self.assertTrue(any(args[1:] == ('stop', 'verity-egress-host.service') for args in self.calls[:deny_index]))
        self.assertTrue(self.controller_running)

    def test_readonly_release_rejects_replaced_symlink_asset(self):
        self.apply()
        installed = (self.root / 'opt/verity-egress').resolve()
        installed.chmod(0o755)
        asset = installed / installer.ASSETS[0]
        asset.unlink()
        asset.symlink_to(self.release / installer.ASSETS[0])
        installed.chmod(0o555)
        self.calls.clear()
        with self.assertRaisesRegex(ValueError, 'trusted read-only'):
            self.apply()
        self.assertEqual(self.calls, [])

    def test_preflight_rejects_unvalidated_architecture_and_byte_order_before_host_commands(self):
        for machine, byteorder in [('aarch64', 'little'), ('x86_64', 'big')]:
            with self.subTest(machine=machine, byteorder=byteorder):
                with (patch.object(installer.os, 'geteuid', return_value=0),
                      patch.object(installer.sys, 'platform', 'linux'),
                      patch.object(installer.platform, 'machine', return_value=machine),
                      patch.object(installer.sys, 'byteorder', byteorder)):
                    with self.assertRaisesRegex(ValueError, 'x86_64 little-endian'):
                        installer.preflight(self.root, self.execute)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
