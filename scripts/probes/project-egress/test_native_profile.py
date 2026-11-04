"""Release-owned native profile admission and bounded prerequisite preparation."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
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
        with self.assertRaisesRegex(RuntimeError, 'reload failed'):
            installer.prepare_managed_prerequisites(self.root, fail, str(self.release / 'node'))
        self.assertEqual((self.root / 'etc/docker/daemon.json').read_bytes(), original)
        self.assertFalse(any('restart' in call or 'stop' in call for call in self.calls))


if __name__ == '__main__':
    unittest.main()
