"""Release-owned native profile admission and bounded prerequisite preparation."""
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'project-egress-install.py'
spec = importlib.util.spec_from_file_location('native_install', SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class NativeProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'etc/docker').mkdir(parents=True)
        (self.root / 'etc/os-release').write_text('ID=ubuntu\nVERSION_ID="26.04"\n')
        (self.root / 'proc').mkdir()
        (self.root / 'proc/1').mkdir()
        (self.root / 'proc/1/comm').write_text('systemd')
        (self.root / 'proc/mounts').write_text('bpf /sys/fs/bpf bpf rw 0 0\n')
        (self.root / 'sys/fs/bpf').mkdir(parents=True)
        self.release = self.root / 'opt/verity-egress'
        self.release.mkdir(parents=True)
        self.artifacts = {}
        for name in ('node', 'project-egress-host-main.mjs', 'project-egress-deadline.bpf.o', 'project-egress-renew.bpf.o'):
            path = self.release / name
            path.write_bytes(name.encode())
            path.chmod(0o444)
            self.artifacts[name] = installer.digest(path.read_bytes())
        self.runtime_path = '/opt/verity/runsc/release-20261026.0/runsc'
        runtime = self.root / self.runtime_path.lstrip('/')
        runtime.parent.mkdir(parents=True)
        runtime.write_bytes(b'reviewed-runtime')
        runtime.chmod(0o555)
        self.profile = {
            'platform': {'kernel': 'accepted-fixture-kernel', 'architecture': 'x86_64',
                         'os': {'id': 'ubuntu', 'version': '26.04'}, 'docker': '29.9.2'},
            'artifacts': self.artifacts,
            'runtime': {'path': self.runtime_path, 'sha512': hashlib.sha512(runtime.read_bytes()).hexdigest(),
                        'treeSha256': installer.runtime_tree_digest(runtime.parent)},
            'packages': {name: '1.0-fixture' for name in installer.NATIVE_PACKAGES},
            'evidence': 'e' * 64,
        }
        self.project = {'path': self.runtime_path, 'runtimeArgs': installer.PROJECT_RUNTIME_ARGS}
        self.relay = {'path': self.runtime_path, 'runtimeArgs': installer.RELAY_RUNTIME_ARGS}
        (self.root / 'etc/docker/daemon.json').write_text(json.dumps({'runtimes': {'runsc-project': self.project}}))
        self.calls = []
        self.packages_installed = False
        for name, value in [('release', 'accepted-fixture-kernel'), ('machine', 'x86_64')]:
            patcher = patch.object(installer.platform, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.accepted = patch.object(installer, 'ACCEPTED_NATIVE_PROFILES', (self.profile,))
        self.accepted.start()
        self.addCleanup(self.accepted.stop)

    def execute(self, *args):
        self.calls.append(args)
        if args[0] == '/usr/bin/docker':
            config = json.loads((self.root / 'etc/docker/daemon.json').read_text())
            return json.dumps({'OSType': 'linux', 'ServerVersion': '29.9.2', 'LiveRestoreEnabled': False,
                               'SecurityOptions': [], 'Runtimes': config['runtimes']})
        if args[0] == '/usr/bin/dpkg-query':
            return '\n'.join(name + '=' + version for name, version in sorted(self.profile['packages'].items())) if self.packages_installed else ''
        if '/usr/bin/apt-get' in args and 'install' in args:
            self.packages_installed = True
        return ''

    def prepare(self):
        return installer.prepare_managed_prerequisites(self.root, self.execute, str(self.release / 'node'))

    def fresh_managed_release(self):
        spec = importlib.util.spec_from_file_location('fresh_managed', SOURCE.with_name('project-egress-managed.py'))
        managed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(managed)
        ownership = patch.object(managed.os, 'chown')
        ownership.start()
        self.addCleanup(ownership.stop)
        # Source assets are not an already-installed controller or current-release link.
        source = self.root / 'release-input'
        self.release.rename(source)
        self.release = source
        for name in managed.ASSETS:
            if not (source / name).exists():
                (source / name).write_bytes(name.encode())
        (source / 'manifest.json').write_text(json.dumps({
            name: installer.digest((source / name).read_bytes()) for name in managed.ASSETS}))
        relay = self.root / 'relay.json'
        relay.write_text('{"packetEnforcement":true}')
        authority = self.root / 'authority.json'
        authority.write_text('{}')
        self.assertFalse((self.root / 'opt/verity-egress').exists())
        self.assertFalse((self.root / 'sys/fs/bpf/verity_egress_deadline').exists())
        return managed, source, relay, authority

    def test_first_managed_install_prepares_pin_and_staged_node_before_real_preflight(self):
        managed, source, relay, authority = self.fresh_managed_release()
        for relative in ('usr/sbin/nft', 'usr/sbin/bpftool', 'sbin/tc', 'sbin/ip',
                         'usr/bin/flock', 'usr/bin/nsenter', 'usr/bin/python3'):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'fixture executable')
            path.chmod(0o555)
        observations = []
        stale = True
        reload_requested = False

        def execute(*args):
            nonlocal stale, reload_requested
            if args == ('/usr/bin/systemctl', '--version'):
                return 'systemd 259'
            if args[0].endswith('/node'):
                node = Path(args[0])
                self.assertNotEqual(node, self.root / 'opt/verity-egress/node')
                self.assertEqual(node.parent.parent, self.root / 'opt/verity-egress-releases')
                self.assertTrue(node.is_file())
                pin = self.root / 'sys/fs/bpf/verity_egress_deadline'
                self.assertEqual(pin.stat().st_mode & 0o777, 0o700)
                self.assertFalse((self.root / 'opt/verity-egress').exists())
                observations.append(node)
                return 'v26.13.0'
            result = self.execute(*args)
            if args == ('/usr/bin/systemctl', 'reload', 'docker.service'):
                reload_requested = True
            if args[0] == '/usr/bin/docker' and reload_requested and stale:
                stale = False
                info = json.loads(result)
                info['Runtimes'].pop('runsc-relay', None)
                return json.dumps(info)
            return result

        def activate(root, run, release, files, configs, gid):
            self.assertEqual(observations, [release / 'node'])
            self.assertTrue((root / 'sys/fs/bpf/verity_egress_deadline').is_dir())

        real_preflight = installer.runtime_preflight
        real_stat = Path.stat
        fixture_uid = os.geteuid()

        def preflight(*args, **kwargs):
            def host_stat(path, *stat_args, **stat_kwargs):
                metadata = real_stat(path, *stat_args, **stat_kwargs)
                if path == self.root / 'sys/fs/bpf/verity_egress_deadline':
                    values = list(metadata)
                    values[4] = 0
                    return os.stat_result(values)
                return metadata

            # The sandbox fixture is unprivileged; only the host-root entry check
            # and pin owner need emulation, not artifact admission or prerequisites.
            with patch.object(installer.os, 'geteuid', side_effect=itertools.chain([0], itertools.repeat(fixture_uid))), \
                    patch.object(Path, 'stat', host_stat):
                return real_preflight(*args, **kwargs)

        with patch.object(managed, 'base', installer), patch.object(managed, 'activate', side_effect=activate) as activation, \
                patch.object(installer, 'runtime_preflight', side_effect=preflight) as check, \
                patch.object(installer.os, 'setns', create=True), \
                patch.object(installer.ctypes, 'CDLL', return_value=SimpleNamespace(nft_ctx_buffer_output=True)), \
                patch.object(installer.time, 'sleep'):
            result = managed.provision(source, relay, authority, os.getgid(), self.root, execute,
                                       check=check, group_setup=lambda *_: None)
        self.assertTrue(result['available'])
        activation.assert_called_once()
        self.assertFalse(stale)
        self.assertEqual(self.calls.count(('/usr/bin/systemctl', 'reload', 'docker.service')), 1)
        self.assertFalse(any('restart' in call or 'stop' in call for call in self.calls))

    def test_first_managed_install_does_not_activate_after_failed_relay_convergence(self):
        managed, source, relay, authority = self.fresh_managed_release()
        daemon = self.root / 'etc/docker/daemon.json'
        before = daemon.read_bytes()

        def execute(*args):
            result = self.execute(*args)
            if args[0] == '/usr/bin/docker':
                info = json.loads(result)
                info['Runtimes'].pop('runsc-relay', None)
                return json.dumps(info)
            return result

        with patch.object(managed, 'base', installer), patch.object(managed, 'activate') as activation, \
                patch.object(installer.time, 'monotonic', side_effect=[0, 31, 32]):
            result = managed.provision(source, relay, authority, os.getgid(), self.root, execute,
                                       check=installer.runtime_preflight, group_setup=lambda *_: None)
        self.assertFalse(result['available'])
        self.assertEqual(result['reason'], 'relay_runtime_mismatch')
        activation.assert_not_called()
        self.assertEqual(daemon.read_bytes(), before)
        self.assertFalse((self.root / 'sys/fs/bpf/verity_egress_deadline').exists())
        self.assertFalse((self.root / 'opt/verity-egress').exists())
        self.assertFalse((self.root / installer.RELAY_RUNTIME_AUTHORITY).exists())

    def test_native_workflows_follow_the_managed_provisioning_inputs(self):
        root = SOURCE.parent.parent
        for workflow in ('project-egress.yml', 'project-egress-boot.yml'):
            text = (root / '.github/workflows' / workflow).read_text()
            for path in ('scripts/project-egress-managed.py', 'scripts/project-egress-install.py',
                         'scripts/build-project-egress-release.mjs', 'deploy/host/verity-egress-provision'):
                with self.subTest(workflow=workflow, path=path):
                    self.assertIn("      - '" + path + "'", text)

    def test_unaccepted_hosts_never_run_mutations(self):
        with patch.object(installer, 'ACCEPTED_NATIVE_PROFILES', ()):
            with self.assertRaisesRegex(ValueError, 'accepted native'):
                self.prepare()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / 'etc/systemd').exists())

    def test_current_release_link_is_checked_against_immutable_artifacts(self):
        current = self.root / 'opt/current-egress'
        current.symlink_to(self.release)
        selected = installer.accepted_native_profile(self.root, self.execute, str(current / 'node'))
        self.assertEqual(selected, self.profile)

    def test_same_kernel_does_not_admit_changed_artifacts_or_runtime(self):
        node = self.release / 'node'
        node.chmod(0o644)
        node.write_bytes(b'other-node')
        node.chmod(0o444)
        with self.assertRaisesRegex(ValueError, 'accepted native'):
            self.prepare()
        node.chmod(0o644)
        node.write_bytes(b'node')
        node.chmod(0o444)
        runtime = self.root / self.runtime_path.lstrip('/')
        runtime.chmod(0o755)
        runtime.write_bytes(b'other-runtime')
        runtime.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'runtime does not match'):
            self.prepare()
        self.assertFalse(any('/usr/bin/apt-get' in call or 'reload' in call for call in self.calls))

    def test_same_runtime_binary_does_not_admit_changed_sidecars(self):
        sidecar = self.root / self.runtime_path.lstrip('/')
        sidecar = sidecar.parent / 'gvisor-bin/gvisor_sentry'
        sidecar.parent.mkdir()
        sidecar.write_bytes(b'changed-sentry')
        sidecar.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'runtime does not match'):
            self.prepare()
        self.assertFalse(any('/usr/bin/apt-get' in call for call in self.calls))

    def test_prepares_exact_packages_relay_and_persistent_bpffs_without_restart(self):
        self.prepare()
        install = next(call for call in self.calls if '/usr/bin/apt-get' in call and 'install' in call)
        self.assertIn('--no-remove', install)
        self.assertIn('SYSTEMD_OFFLINE=1', install)
        self.assertIn('NEEDRESTART_MODE=l', install)
        self.assertTrue(all(name + '=' + version in install for name, version in self.profile['packages'].items()))
        self.assertEqual(json.loads((self.root / 'etc/docker/daemon.json').read_text())['runtimes']['runsc-relay'], self.relay)
        self.assertTrue(any('reload' in call and 'docker.service' in call for call in self.calls))
        self.assertFalse(any('restart' in call or 'stop' in call for call in self.calls))
        self.assertEqual((self.root / 'etc/systemd/system/sys-fs-bpf.mount').read_bytes(), installer.BPFFS_UNIT)
        self.assertEqual((self.root / 'sys/fs/bpf/verity_egress_deadline').stat().st_mode & 0o777, 0o700)
        self.calls.clear()
        self.prepare()
        self.assertFalse(any('/usr/bin/apt-get' in call or 'reload' in call for call in self.calls))

    def test_first_install_waits_for_signal_driven_relay_reload(self):
        # systemctl reload returns after sending SIGHUP, before dockerd publishes runtimes.
        observed = 0

        def delayed(*args):
            nonlocal observed
            result = self.execute(*args)
            if args[0] == '/usr/bin/docker' and ('reload', 'docker.service') in [call[1:] for call in self.calls]:
                observed += 1
                if observed < 3:
                    info = json.loads(result)
                    info['Runtimes'].pop('runsc-relay', None)
                    return json.dumps(info)
            return result

        pin = self.root / 'sys/fs/bpf/verity_egress_deadline'
        self.assertFalse(pin.exists())
        with patch('time.sleep'):
            installer.prepare_managed_prerequisites(self.root, delayed, str(self.release / 'node'))
        self.assertGreaterEqual(observed, 3)
        self.assertEqual(pin.stat().st_mode & 0o777, 0o700)
        self.assertEqual(sum(call == ('/usr/bin/systemctl', 'reload', 'docker.service') for call in self.calls), 1)
        self.assertFalse(any('stop' in call or 'restart' in call for call in self.calls))

    def renew_project_runtime(self):
        renewed = '/opt/verity/runsc/release-20261104.0/runsc'
        binary = self.root / renewed.lstrip('/')
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b'reviewed-new-runtime')
        binary.chmod(0o555)
        self.profile['runtime'] = {'path': renewed,
            'sha512': hashlib.sha512(binary.read_bytes()).hexdigest(),
            'treeSha256': installer.runtime_tree_digest(binary.parent)}
        self.project = {'path': renewed, 'runtimeArgs': installer.PROJECT_RUNTIME_ARGS}
        self.relay = {'path': renewed, 'runtimeArgs': installer.RELAY_RUNTIME_ARGS}
        daemon = self.root / 'etc/docker/daemon.json'
        value = json.loads(daemon.read_bytes())
        value['runtimes']['runsc-project'] = self.project
        daemon.write_text(json.dumps(value))
        self.calls.clear()

    def test_migrates_admitted_relay_after_project_runtime_renewal(self):
        self.prepare()
        authority = self.root / installer.RELAY_RUNTIME_AUTHORITY
        previous = authority.read_bytes()
        self.renew_project_runtime()
        self.prepare()
        self.assertEqual(json.loads((self.root / 'etc/docker/daemon.json').read_bytes())['runtimes']['runsc-relay'], self.relay)
        self.assertEqual(json.loads(authority.read_bytes())['runtime'], self.profile['runtime'])
        self.assertNotEqual(authority.read_bytes(), previous)
        self.assertEqual(authority.stat().st_mode & 0o777, 0o600)
        self.assertTrue(any('reload' in call and 'docker.service' in call for call in self.calls))
        self.assertFalse(any('restart' in call or 'stop' in call or '/usr/bin/apt-get' in call for call in self.calls))

    def test_foreign_relay_cannot_migrate_without_private_prior_authority(self):
        self.prepare()
        authority = self.root / installer.RELAY_RUNTIME_AUTHORITY
        authority.unlink()
        self.renew_project_runtime()
        before = (self.root / 'etc/docker/daemon.json').read_bytes()
        self.packages_installed = False
        with self.assertRaisesRegex(ValueError, 'Unmanaged relay runtime'):
            self.prepare()
        self.assertEqual((self.root / 'etc/docker/daemon.json').read_bytes(), before)
        self.assertFalse(authority.exists())
        self.assertFalse(any('/usr/bin/apt-get' in call or 'reload' in call for call in self.calls))

    def test_rejects_changed_prior_registration_and_runtime_before_mutations(self):
        self.prepare()
        authority = self.root / installer.RELAY_RUNTIME_AUTHORITY
        old_runtime = self.root / self.runtime_path.lstrip('/')
        self.renew_project_runtime()
        self.packages_installed = False
        daemon = self.root / 'etc/docker/daemon.json'
        before = daemon.read_bytes()
        value = json.loads(before)
        value['runtimes']['runsc-relay']['runtimeArgs'] = ['--network=host']
        daemon.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'Unmanaged relay runtime'):
            self.prepare()
        daemon.write_bytes(before)
        old_runtime.chmod(0o755)
        old_runtime.write_bytes(b'changed-old-runtime')
        old_runtime.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'runtime identity changed'):
            self.prepare()
        authority.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'Untrusted managed relay'):
            self.prepare()
        self.assertFalse(any('/usr/bin/apt-get' in call or 'reload' in call for call in self.calls))
        self.assertEqual(daemon.read_bytes(), before)

    def test_prior_relay_sidecar_drift_cannot_authorize_migration(self):
        self.prepare()
        self.renew_project_runtime()
        sidecar = (self.root / self.runtime_path.lstrip('/')).parent / 'unexpected-sidecar'
        sidecar.write_bytes(b'changed-tree')
        sidecar.chmod(0o555)
        self.packages_installed = False
        with self.assertRaisesRegex(ValueError, 'runtime identity changed'):
            self.prepare()
        self.assertFalse(any('/usr/bin/apt-get' in call or 'reload' in call for call in self.calls))

    def test_failed_relay_reload_preserves_previous_config_and_authority(self):
        import subprocess
        self.prepare()
        authority = self.root / installer.RELAY_RUNTIME_AUTHORITY
        previous = authority.read_bytes()
        self.renew_project_runtime()
        daemon = self.root / 'etc/docker/daemon.json'
        before = daemon.read_bytes()
        reloads = 0
        def fail_first_reload(*args):
            nonlocal reloads
            if args == ('/usr/bin/systemctl', 'reload', 'docker.service'):
                reloads += 1
                if reloads == 1:
                    raise subprocess.CalledProcessError(1, args)
            return self.execute(*args)
        with self.assertRaisesRegex(installer.PreflightError, 'relay_reload_failed'):
            installer.prepare_managed_prerequisites(self.root, fail_first_reload, str(self.release / 'node'))
        self.assertEqual(daemon.read_bytes(), before)
        self.assertEqual(authority.read_bytes(), previous)
        self.assertEqual(reloads, 2)

    def test_permanent_relay_mismatch_or_inspection_failure_rolls_back_before_pin_creation(self):
        for reason in ('relay_runtime_mismatch', 'relay_inspection_failed'):
            with self.subTest(reason=reason):
                daemon = self.root / 'etc/docker/daemon.json'
                original = daemon.read_bytes()
                reloads = 0

                def execute(*args):
                    nonlocal reloads
                    result = self.execute(*args)
                    if args == ('/usr/bin/systemctl', 'reload', 'docker.service'):
                        reloads += 1
                    if args[0] == '/usr/bin/docker' and reloads == 1:
                        if reason == 'relay_inspection_failed':
                            return '{malformed'
                        info = json.loads(result)
                        info['Runtimes']['runsc-relay']['runtimeArgs'] = ['--network=host']
                        return json.dumps(info)
                    return result

                with patch.object(installer.time, 'monotonic', side_effect=itertools.count(0, 31)), \
                        self.assertRaisesRegex(installer.PreflightError, reason):
                    installer.prepare_managed_prerequisites(self.root, execute, str(self.release / 'node'))
                self.assertEqual(reloads, 2)
                self.assertEqual(daemon.read_bytes(), original)
                self.assertFalse((self.root / installer.RELAY_RUNTIME_AUTHORITY).exists())
                self.assertFalse((self.root / 'sys/fs/bpf/verity_egress_deadline').exists())

    def test_bpffs_pin_creation_never_uses_disk_directory_fsync(self):
        original = installer.sync_directory

        def sync(path):
            if str(path).startswith(str(self.root / 'sys/fs/bpf')):
                raise OSError(22, 'bpffs directory fsync is unsupported')
            return original(path)

        with patch.object(installer, 'sync_directory', side_effect=sync):
            self.prepare()
        self.assertTrue((self.root / 'sys/fs/bpf/verity_egress_deadline').is_dir())

    def test_relay_collision_preserves_unrelated_runtime(self):
        daemon = self.root / 'etc/docker/daemon.json'
        daemon.write_text(json.dumps({'runtimes': {'runsc-project': self.project, 'runsc-relay': {'path': '/unrelated'}}}))
        original = daemon.read_bytes()
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.prepare()
        self.assertEqual(daemon.read_bytes(), original)
        self.assertFalse(any('reload' in call for call in self.calls))

    def test_failed_reload_restores_daemon_configuration_without_restart(self):
        original = (self.root / 'etc/docker/daemon.json').read_bytes()
        def fail(*args):
            result = self.execute(*args)
            if 'reload' in args:
                raise RuntimeError('reload failed')
            return result
        with self.assertRaisesRegex(installer.PreflightError, 'relay_rollback_failed'):
            installer.prepare_managed_prerequisites(self.root, fail, str(self.release / 'node'))
        self.assertEqual((self.root / 'etc/docker/daemon.json').read_bytes(), original)
        self.assertFalse(any('restart' in call or 'stop' in call for call in self.calls))


if __name__ == '__main__':
    unittest.main()
