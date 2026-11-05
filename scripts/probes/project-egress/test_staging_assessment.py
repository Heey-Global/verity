"""Staging admission remains distinct from production native acceptance."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('staging_native', Path(__file__).resolve().parents[2] / 'project-egress-install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class StagingAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ('etc/docker', 'proc/1', 'sys/fs/bpf', 'state', 'opt/verity-egress'):
            (self.root / name).mkdir(parents=True)
        (self.root / 'proc/1/comm').write_text('systemd')
        (self.root / 'proc/mounts').write_text('bpf /sys/fs/bpf bpf rw 0 0\n')
        (self.root / 'etc/os-release').write_text('ID=ubuntu\nVERSION_ID=26.04\n')
        self.channel = self.root / 'state/update-channel.json'
        self.channel.write_text(json.dumps('staging'))
        self.release = self.root / 'opt/verity-egress'
        for name in ('node', 'project-egress-host-main.mjs', 'project-egress-deadline.bpf.o', 'project-egress-renew.bpf.o'):
            (self.release / name).write_bytes(name.encode())
            (self.release / name).chmod(0o444)
        self.runtime_name = '/opt/verity/runsc/release-20261026.0/runsc'
        self.runtime = self.root / self.runtime_name.lstrip('/')
        self.runtime.parent.mkdir(parents=True)
        self.runtime.write_bytes(b'fixture-runtime')
        self.runtime.chmod(0o555)
        self.sidecar = self.runtime.parent / 'gvisor-bin/gvisor_sentry'
        self.sidecar.parent.mkdir()
        self.sidecar.write_bytes(b'fixture-sidecar')
        self.sidecar.chmod(0o555)
        archive = 'a' * 128
        (self.runtime.parent / '.verity-archive-sha512').write_text(archive + '\n')
        (self.runtime.parent / '.verity-files.sha512').write_text(''.join(
            hashlib.sha512(path.read_bytes()).hexdigest() + '  ' + str(path.relative_to(self.runtime.parent)) + '\n'
            for path in (self.runtime, self.sidecar)))
        pins = self.release / 'native-runtime-pins.env'
        pins.write_text('RUNSC_RELEASE=release-20261026.0\nRUNSC_SHA512_X86_64=' + hashlib.sha512(self.runtime.read_bytes()).hexdigest() + '\nRUNSC_ARCHIVE_SHA512_X86_64=' + archive + '\n')
        pins.chmod(0o444)
        self.project = {'path': self.runtime_name, 'runtimeArgs': installer.PROJECT_RUNTIME_ARGS}
        (self.root / 'etc/docker/daemon.json').write_text(json.dumps({'runtimes': {'runsc-project': self.project}}))
        self.packages = {name: '1.0-fixture' for name in installer.NATIVE_PACKAGES}
        self.calls = []
        self.authorization = {'scope': 'staging-assessment', 'productionAccepted': False,
            'deploymentId': '11111111-1111-4111-8111-111111111111',
            'targetDigest': 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a' * 64,
            'installedDigest': 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'b' * 64,
            'operationId': 'c' * 24, 'channelPath': '/state/update-channel.json', 'channelOwnerUid': 0}
        for name, value in [('machine', 'x86_64'), ('release', 'fixture-kernel')]:
            replacement = patch.object(installer.platform, name, return_value=value)
            replacement.start()
            self.addCleanup(replacement.stop)

    def execute(self, *args):
        self.calls.append(args)
        if args[0] == '/usr/bin/docker':
            config = json.loads((self.root / 'etc/docker/daemon.json').read_text())
            return json.dumps({'OSType': 'linux', 'ServerVersion': '29.9.2', 'LiveRestoreEnabled': False,
                               'Runtimes': config['runtimes'], 'SecurityOptions': []})
        if args[0] == '/usr/bin/dpkg-query':
            return '\n'.join(name + '=' + value for name, value in sorted(self.packages.items()))
        if args[0] == '/usr/bin/apt-cache':
            return '  Candidate: 2.0-fixture\n'
        if '/usr/bin/apt-get' in args and 'install' in args:
            self.packages = dict(part.split('=', 1) for part in args if '=' in part and part.split('=', 1)[0] in installer.NATIVE_PACKAGES)
        return ''

    def prepare(self, authorization=None):
        return installer.prepare_staging_assessment(self.root, self.execute, str(self.release / 'node'),
                                                     authorization or self.authorization)

    def validate(self, descriptor):
        return installer.validate_staging_assessment(self.root, self.execute, str(self.release / 'node'), descriptor)

    def test_staging_snapshot_never_grants_production_acceptance_or_restarts_docker(self):
        self.assertEqual(installer.ACCEPTED_NATIVE_PROFILES, ())
        descriptor = self.prepare()
        self.assertIs(descriptor['productionAccepted'], False)
        self.assertNotIn('evidence', descriptor['profile'])
        self.assertEqual(self.validate(descriptor), descriptor['profile'])
        self.assertFalse(any('restart' in call or 'stop' in call for call in self.calls))
        with self.assertRaisesRegex(ValueError, 'accepted native'):
            installer.accepted_native_profile(self.root, self.execute, str(self.release / 'node'))

    def test_requires_explicit_durable_staging_channel_before_any_mutation(self):
        for channel in ('stable', {}, None):
            self.channel.write_text(json.dumps(channel))
            self.calls.clear()
            with self.subTest(channel=channel), self.assertRaises(ValueError):
                self.prepare()
            self.assertEqual(self.calls, [])
        self.channel.unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()
        self.assertEqual(self.calls, [])

    def test_rejects_forged_authorization_and_untrusted_channel(self):
        for field, value in [('productionAccepted', True), ('targetDigest', 'example.com/a:latest'),
                             ('operationId', 'anything'), ('channelPath', '/state/../state/update-channel.json'),
                             ('channelOwnerUid', True)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.prepare({**self.authorization, field: value})
        self.channel.chmod(0o666)
        with self.assertRaises(ValueError):
            self.prepare()
        self.channel.chmod(0o644)
        destination = self.channel.with_name('real-channel')
        self.channel.rename(destination)
        self.channel.symlink_to(destination)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.calls, [])

    def test_stable_channel_revokes_existing_descriptor(self):
        descriptor = self.prepare()
        self.channel.write_text(json.dumps('stable'))
        with self.assertRaisesRegex(ValueError, 'durable staging'):
            self.validate(descriptor)

    def test_rejects_platform_artifact_runtime_and_package_drift(self):
        descriptor = self.prepare()
        for key in ('kernel', 'docker'):
            changed = copy.deepcopy(descriptor)
            changed['profile']['platform'][key] = 'other'
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(changed)
        changed = copy.deepcopy(descriptor)
        changed['productionAccepted'] = True
        with self.assertRaises(ValueError):
            self.validate(changed)
        node = self.release / 'node'
        original = node.read_bytes()
        node.chmod(0o644)
        node.write_bytes(b'other-node')
        node.chmod(0o444)
        with self.assertRaisesRegex(ValueError, 'identities changed'):
            self.validate(descriptor)
        node.chmod(0o644)
        node.write_bytes(original)
        node.chmod(0o444)
        self.packages['python3'] = 'different'
        with self.assertRaisesRegex(ValueError, 'identities changed'):
            self.validate(descriptor)
        self.packages['python3'] = '1.0-fixture'
        self.sidecar.chmod(0o755)
        self.sidecar.write_bytes(b'changed-sidecar')
        self.sidecar.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'runtime file changed'):
            self.validate(descriptor)

    def test_foreign_relay_collision_precedes_package_metadata_mutations(self):
        daemon = self.root / 'etc/docker/daemon.json'
        value = json.loads(daemon.read_bytes())
        value['runtimes']['runsc-relay'] = {'path': '/opt/foreign/runsc', 'runtimeArgs': installer.RELAY_RUNTIME_ARGS}
        daemon.write_text(json.dumps(value))
        before = daemon.read_bytes()
        del self.packages['bpftool']
        with self.assertRaisesRegex(ValueError, 'Unmanaged relay runtime'):
            self.prepare()
        self.assertEqual(daemon.read_bytes(), before)
        self.assertFalse((self.root / installer.RELAY_RUNTIME_AUTHORITY).exists())
        self.assertFalse(any('/usr/bin/apt-get' in call or '/usr/bin/apt-cache' in call or 'reload' in call for call in self.calls))

    def test_missing_packages_are_snapshotted_and_installed_by_exact_version(self):
        del self.packages['bpftool']
        descriptor = self.prepare()
        install = next(call for call in self.calls if '/usr/bin/apt-get' in call and 'install' in call)
        self.assertIn('bpftool=2.0-fixture', install)
        self.assertIn('SYSTEMD_OFFLINE=1', install)
        self.assertEqual(descriptor['profile']['packages']['bpftool'], '2.0-fixture')


if __name__ == '__main__':
    unittest.main()
