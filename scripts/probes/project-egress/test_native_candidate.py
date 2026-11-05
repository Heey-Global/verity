"""Read-only native candidate collection never establishes profile acceptance."""
import importlib.util
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    with patch('sys.dont_write_bytecode', True):
        spec.loader.exec_module(module)
    return module


installer = load('candidate_test_installer', ROOT / 'project-egress-install.py')
collector = load('candidate_collector', Path(__file__).with_name('collect-native-candidate.py'))


class NativeCandidateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'etc').mkdir()
        (self.root / 'etc/os-release').write_text('ID=ubuntu\nVERSION_ID="26.04"\n')
        (self.root / 'proc/1').mkdir(parents=True)
        (self.root / 'proc/1/comm').write_text('systemd\n')
        self.release = self.root / 'opt/verity-egress-releases/fixture'
        self.release.mkdir(parents=True)
        self.expected_artifacts = {}
        for name in collector.ARTIFACT_NAMES:
            file = self.release / name
            file.write_bytes(('artifact-' + name).encode())
            file.chmod(0o444)
            self.expected_artifacts[name] = installer.digest(file.read_bytes())
        self.current = self.root / 'opt/verity-egress'
        self.current.symlink_to(self.release)
        self.runtime_path = '/opt/verity/runsc/release-20261026.0/runsc'
        self.runtime = self.root / self.runtime_path.lstrip('/')
        self.runtime.parent.mkdir(parents=True)
        self.runtime.write_bytes(b'native-reviewed-runtime')
        self.runtime.chmod(0o555)
        self.info = {'OSType': 'linux', 'ServerVersion': '29.9.2', 'LiveRestoreEnabled': False,
                     'SecurityOptions': ['name=seccomp'],
                     'Runtimes': {
                         'runsc-project': {'path': self.runtime_path, 'runtimeArgs': list(installer.PROJECT_RUNTIME_ARGS)},
                         'runsc-relay': {'path': self.runtime_path, 'runtimeArgs': list(installer.RELAY_RUNTIME_ARGS)},
                     }}
        self.versions = {name: '1.0-fixture' for name in installer.NATIVE_PACKAGES}
        self.package_reply = None
        self.calls = []
        for name, value in [('release', '6.17.0-fixture'), ('machine', 'x86_64')]:
            patcher = patch.object(installer.platform, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def command(self, *args):
        self.calls.append(args)
        if args[0] == '/usr/bin/docker':
            return json.dumps(self.info)
        if args[0] == '/usr/bin/dpkg-query':
            return self.package_reply if self.package_reply is not None else '\n'.join(
                name + '=' + version for name, version in sorted(self.versions.items()))
        self.fail('Collector attempted an unexpected command')

    def collect(self):
        return collector.collect(installer, self.root, self.current, self.command)

    def test_collects_exact_metadata_without_changing_files_or_granting_acceptance(self):
        before = {str(path): (path.lstat().st_mode, path.read_bytes())
                  for path in self.root.rglob('*') if path.is_file()}
        allowlist = installer.ACCEPTED_NATIVE_PROFILES
        result = self.collect()
        self.assertEqual(result['artifacts'], self.expected_artifacts)
        self.assertEqual(result['runtimes'], self.info['Runtimes'])
        self.assertEqual(result['runtime']['treeSha256'], installer.runtime_tree_digest(self.runtime.parent))
        self.assertEqual(result['packages'], self.versions)
        self.assertEqual(result['platform'], {'kernel': '6.17.0-fixture', 'architecture': 'x86_64',
                         'os': {'id': 'ubuntu', 'version': '26.04'}, 'docker': '29.9.2'})
        self.assertIs(result['accepted'], False)
        self.assertEqual(result['scope'], 'native-profile-candidate')
        self.assertEqual(result['blockers'], ['native_acceptance_not_performed'])
        self.assertEqual(result['evidenceMissing'], list(collector.EVIDENCE_MISSING))
        self.assertNotIn('evidence', result)
        self.assertNotIn('evidenceDigest', result)
        self.assertIs(installer.ACCEPTED_NATIVE_PROFILES, allowlist)
        self.assertEqual(before, {str(path): (path.lstat().st_mode, path.read_bytes())
                                 for path in self.root.rglob('*') if path.is_file()})
        self.assertEqual([call[0] for call in self.calls], ['/usr/bin/docker', '/usr/bin/dpkg-query'])

    def test_writable_or_symlinked_artifacts_are_not_attested(self):
        node = self.release / 'node'
        node.chmod(0o644)
        result = self.collect()
        self.assertIn('native_release_artifacts_untrusted', result['blockers'])
        self.assertTrue(all(value is None for value in result['artifacts'].values()))
        node.unlink()
        node.symlink_to(self.runtime)
        self.assertIn('native_release_artifacts_untrusted', self.collect()['blockers'])

    def test_untrusted_runtime_tree_and_different_registrations_fail_closed(self):
        extra = self.runtime.parent / 'extra'
        extra.write_bytes(b'changed-helper')
        extra.chmod(0o666)
        self.assertIsNone(self.collect()['runtime'])
        extra.unlink()
        self.info['Runtimes']['runsc-relay']['path'] = '/opt/verity/runsc/release-20261027.0/runsc'
        result = self.collect()
        self.assertIn('native_runtime_registrations_mismatch', result['blockers'])
        self.assertIsNone(result['runtime'])
        self.assertIs(result['accepted'], False)

    def test_missing_packages_and_untrusted_versions_are_explicit_blockers(self):
        self.versions.pop('nftables')
        result = self.collect()
        self.assertIn('native_packages_incomplete', result['blockers'])
        self.assertNotIn('nftables', result['packages'])
        self.package_reply = 'python3=' + 'x' * 129
        result = self.collect()
        self.assertIn('native_package_metadata_invalid', result['blockers'])
        self.assertEqual(result['packages'], {})
        self.package_reply = 'unknown-package=private-secret'
        result = self.collect()
        self.assertNotIn('private-secret', json.dumps(result))
        self.assertIn('native_package_metadata_invalid', result['blockers'])

    def test_missing_package_query_preserves_only_validated_installed_versions(self):
        def command(*args):
            if args[0] == '/usr/bin/dpkg-query':
                raise subprocess.CalledProcessError(1, args, output='python3=3.14.0-1\n',
                                                    stderr='private diagnostic')
            return self.command(*args)

        result = collector.collect(installer, self.root, self.current, command)
        self.assertEqual(result['packages'], {'python3': '3.14.0-1'})
        self.assertIn('native_package_query_incomplete', result['blockers'])
        self.assertIn('native_packages_incomplete', result['blockers'])
        self.assertNotIn('private diagnostic', json.dumps(result))
        self.assertIs(result['accepted'], False)

    def test_runtime_arguments_and_metadata_are_bounded_and_sanitized(self):
        self.info['Runtimes']['runsc-project']['runtimeArgs'] = ['--secret=private-secret']
        result = self.collect()
        self.assertIn('native_runtime_metadata_invalid', result['blockers'])
        self.assertNotIn('private-secret', json.dumps(result))
        with patch.object(installer.platform, 'release', return_value='private-secret/' + 'x' * 200):
            result = self.collect()
        self.assertIn('native_platform_metadata_invalid', result['blockers'])
        self.assertNotIn('private-secret', json.dumps(result))
        self.info['ServerVersion'] = 'x' * 200
        self.assertIn('native_runtime_metadata_invalid', self.collect()['blockers'])

    def test_cli_rejects_arbitrary_release_override_outside_disposable_guest(self):
        with patch.object(collector.os, 'geteuid', return_value=0), \
                patch.object(collector.sys, 'argv', ['collector', '--release', '/arbitrary']), \
                patch.object(collector.Path, 'read_text', side_effect=FileNotFoundError):
            with self.assertRaises(SystemExit) as failure:
                collector.main()
        self.assertEqual(failure.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
