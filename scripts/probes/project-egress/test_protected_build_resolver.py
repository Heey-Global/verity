"""Exercise the installed helper without changing the host resolver or mounting."""
import errno
import base64
import io
import os
from pathlib import Path
import runpy
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[3] / 'deploy/buildkit/protected-build-attempt'


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.runtime = self.root / 'run'
        self.runtime.mkdir()
        (self.root / 'etc').mkdir()
        self.resolver = self.root / 'etc/resolv.conf'
        self.attempt = self.root / 'attempt'
        self.attempt.mkdir()
        self.g = runpy.run_path(str(HELPER))['run'].__globals__
        self.g['RUN'] = self.runtime
        self.g['RESOLVER'] = self.resolver
        # Production requires root-owned files. Only fixture lstat ownership is
        # substituted; mode, link and file-type checks run against real files.
        original_lstat = Path.lstat
        def fixture_lstat(path):
            values = list(original_lstat(path))
            values[4] = 0
            return os.stat_result(values)
        self.addCleanup(patch.stopall)
        patch.object(Path, 'lstat', fixture_lstat).start()
        original_read = Path.read_text
        self.mountinfo = f'1 0 0:1 / {self.runtime} rw - tmpfs tmpfs rw\n'
        def read_text(path, *args, **kwargs):
            if str(path) == '/proc/self/mountinfo':
                return self.mountinfo
            return original_read(path, *args, **kwargs)
        patch.object(Path, 'read_text', read_text).start()
        self.commands = []
        patch.object(subprocess, 'run', lambda command, **kwargs: self.commands.append(command)).start()

    def test_regular_resolver_is_not_written(self):
        self.resolver.write_text('host resolver unchanged\n')
        self.g['mount_resolver'](self.attempt)
        self.assertEqual(self.resolver.read_text(), 'host resolver unchanged\n')
        self.assertEqual(self.commands[-1], ['/usr/bin/mount', '-o', 'remount,bind,ro', str(self.resolver)])
        self.assertEqual((self.attempt / 'resolv.conf').read_text(), 'nameserver 127.0.0.1\noptions ndots:0\n')

    def test_dangling_private_run_target_is_created_before_mount(self):
        target = self.runtime / 'systemd/resolve/stub-resolv.conf'
        self.resolver.symlink_to('../run/systemd/resolve/stub-resolv.conf')
        self.assertFalse(target.exists())
        def mount(command, **kwargs):
            self.assertTrue(Path(command[-1]).is_file(), 'original dangling mount failure')
            self.commands.append(command)
        with patch.object(subprocess, 'run', mount):
            self.g['mount_resolver'](self.attempt)
        self.assertEqual(os.readlink(self.resolver), '../run/systemd/resolve/stub-resolv.conf')
        self.assertEqual(self.commands[0][-1], str(target))
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    def test_all_supported_targets_and_existing_private_file(self):
        for index, name in enumerate([
            'systemd/resolve/stub-resolv.conf', 'systemd/resolve/resolv.conf',
            'NetworkManager/resolv.conf', 'NetworkManager/no-stub-resolv.conf',
            'resolvconf/resolv.conf',
        ]):
            target = self.runtime / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('private fixture')
            target.chmod(0o600)
            self.resolver.symlink_to(target)
            attempt = self.root / ('attempt-' + str(index))
            attempt.mkdir()
            self.g['mount_resolver'](attempt)
            self.assertEqual(target.read_text(), 'private fixture')
            self.assertEqual(self.commands[-1][-1], str(target))
            self.resolver.unlink()

    def test_unsafe_target_and_parent_symlinks_are_rejected(self):
        for target in ['/etc/shadow', '/tmp/resolv.conf', str(self.runtime / 'other/resolv.conf')]:
            self.resolver.symlink_to(target)
            with self.assertRaises(ValueError):
                self.g['mount_resolver'](self.attempt)
            self.resolver.unlink()
        self.resolver.symlink_to(self.runtime / 'systemd/resolve/resolv.conf')
        outside = self.root / 'outside'
        outside.mkdir()
        (self.runtime / 'systemd').symlink_to(outside)
        with self.assertRaises(ValueError):
            self.g['mount_resolver'](self.attempt)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(self.commands, [])

    def test_missing_or_shared_private_tmpfs_is_rejected_before_creation(self):
        self.resolver.symlink_to(self.runtime / 'systemd/resolve/resolv.conf')
        for mountinfo in ['', self.mountinfo.replace('tmpfs', 'ext4'), self.mountinfo.replace('rw -', 'rw shared:1 -')]:
            self.mountinfo = mountinfo
            with self.assertRaises(ValueError):
                self.g['mount_resolver'](self.attempt)
            self.assertFalse((self.runtime / 'systemd').exists())
        self.assertEqual(self.commands, [])

    def test_early_mount_failure_is_bounded_and_has_no_exception_secrets(self):
        self.resolver.write_text('unchanged')
        original_readlink = os.readlink
        def readlink(path, *args, **kwargs):
            if str(path) == '/proc/self/ns/net':
                return 'net:[fixture]'
            return original_readlink(path, *args, **kwargs)
        self.g['load'] = lambda path: {'identity': 'net:[fixture]'}
        def mount(command, **kwargs):
            if str(self.resolver) == command[-1]:
                raise subprocess.CalledProcessError(32, ['secret-argv'], stderr='secret-stderr')
        with patch.object(os, 'readlink', readlink), patch.object(subprocess, 'run', mount):
            with self.assertRaises(subprocess.CalledProcessError):
                self.g['run_attempt'](self.attempt, self.root, self.root, {}, '', {})
        log = self.attempt / 'build.log'
        self.assertEqual(log.read_text(), 'Protected build phase=resolver_mount failed: command_exit=32\n')
        self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)
        self.assertIn('failed', (self.attempt / 'result.json').read_text())
        self.assertEqual(self.resolver.read_text(), 'unchanged')
        self.g['record_failure'](self.attempt, 'resolver_mount', OSError(errno.ENOENT, 'secret-message'))
        self.assertNotIn('secret', log.read_text())
        self.assertIn('os_errno=2', log.read_text())

    def test_diagnostics_are_bounded_and_reject_linked_output(self):
        path = self.attempt / 'build.log'
        path.write_bytes(b'x' * 300000)
        self.g['record_failure'](self.attempt, 'resolver_mount', ValueError('secret-message'))
        self.assertEqual(path.stat().st_size, 262144)
        self.assertTrue(path.read_text().startswith('Protected build phase=resolver_mount'))
        self.assertNotIn('secret', path.read_text())
        path.unlink()
        outside = self.root / 'outside.log'
        outside.write_text('unchanged')
        path.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.g['record_failure'](self.attempt, 'resolver_mount', ValueError())
        self.assertEqual(outside.read_text(), 'unchanged')

    def test_daemon_cleanup_and_redacted_build_failure_after_resolver_setup(self):
        self.resolver.write_text('host unchanged')
        secret = 'fixture-private-registry-token'
        encoded = base64.b64encode(('x-access-token:' + secret).encode()).decode()
        namespace = {'identity': 'net:[fixture]'}
        cni = {'cniVersion': '1.0.0', 'name': 'verity-protected-build', 'plugins': [
            {'type': 'bridge', 'bridge': 'vbki0', 'isGateway': True, 'ipMasq': True,
             'ipam': {'type': 'host-local', 'subnet': '10.215.0.0/24', 'routes': [{'dst': '0.0.0.0/0'}], 'dataDir': str(self.attempt / 'cni-state')}},
            {'type': 'loopback'}]}
        (self.attempt / 'registry.json').write_text('{}')
        def load(path):
            if path.name == 'namespace.json': return namespace
            if path.name == 'cni.json': return cni
            if path.name == 'registry.json': return {'auths': {'ghcr.io': {'auth': encoded}}}
            raise AssertionError(path)
        self.g['load'] = load
        self.g['start_dns'] = lambda path: []
        class Child:
            def __init__(self, client):
                self.client = client
                self.stdout = io.BytesIO(('build error ' + encoded + ' ' + secret).encode())
                self.stopped = False
            def poll(self): return 1 if self.client or self.stopped else None
            def terminate(self): self.stopped = True
            def wait(self, **kwargs): return 1 if self.client else 0
        children = []
        def popen(command, **kwargs):
            child = Child('devcontainer.js' in str(command))
            children.append(child)
            return child
        with patch.object(os, 'readlink', lambda path: 'net:[fixture]'), \
             patch.object(Path, 'is_socket', lambda path: True), \
             patch.object(subprocess, 'Popen', popen):
            with self.assertRaises(RuntimeError):
                self.g['run_attempt'](self.attempt, self.root, self.root,
                    {'image': 'fixture', 'noCache': False}, 'feature',
                    {'nodeFeature': 'node', 'nodeOptions': {}, 'toolkitOptions': {}})
        log = (self.attempt / 'build.log').read_text()
        self.assertIn('phase=image_build', log)
        self.assertIn('build error', log)
        self.assertNotIn(secret, log)
        self.assertNotIn(encoded, log)
        self.assertTrue(all(child.stopped for child in children[:2]))
        self.assertFalse((self.attempt / 'registry.json').exists())
        self.assertFalse((self.attempt / 'docker-config/config.json').exists())



if __name__ == '__main__':
    unittest.main()
