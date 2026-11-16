"""Build-only namespace exception; this is contract testing, not native BPF proof."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py'
spec = importlib.util.spec_from_file_location('build_deadline_host', source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class ProtectedBuildEndpointTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.binding = dict(zip(host.BINDING_FIELDS, ['project', 'generation', 'a' * 64,
                            'b' * 64, 'c' * 64, 'veb123456789abc', '172.30.106.2', 'fd42:feed::2']))
        self.directory = self.root / 'build-anchors'
        self.directory.mkdir(mode=0o700)
        self.path = self.directory / (host.binding_key(self.binding) + '.json')
        self.record = {'version': 1, 'binding': self.binding, 'namespace': 'net:[1234]',
                       'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
        self.mac = '02:42:ac:1e:6a:02'
        self.links = [{'ifname': 'eth0', 'ifindex': 2, 'address': self.mac,
                       'linkinfo': {'info_kind': 'veth'}},
                      {'ifname': 'vbki0', 'ifindex': 3, 'linkinfo': {'info_kind': 'bridge'}},
                      {'ifname': 'veth123', 'ifindex': 4, 'master': 3,
                       'linkinfo': {'info_kind': 'veth'}}]
        self.enterContext(patch.object(host, 'STATE', self.root / 'deadline'))
        # Model root-owned records without requiring a privileged test runner.
        original_lstat, original_fstat = Path.lstat, os.fstat
        def root_stat(value):
            fields = list(value)
            fields[4] = 0
            return os.stat_result(fields)
        self.enterContext(patch.object(Path, 'lstat', lambda path, *a, **kw: root_stat(original_lstat(path, *a, **kw))))
        self.enterContext(patch.object(os, 'fstat', lambda fd: root_stat(original_fstat(fd))))
        self.write()

    def write(self):
        self.path.write_text(json.dumps(self.record))
        self.path.chmod(0o600)

    def inspect(self, links=None):
        return host.protected_build_endpoint(self.binding, 'net:[1234]',
                                              self.links if links is None else links, self.mac)

    def test_exact_registered_anchor_allows_only_fixed_inner_bridge_and_its_veths(self):
        self.assertEqual(self.inspect(), self.links[0])

    def test_missing_or_changed_registration_never_relaxes_sandbox_invariant(self):
        self.path.unlink()
        with self.assertRaises(OSError):
            self.inspect()
        for key, value in [('version', 2), ('namespace', 'net:[4321]'), ('bootId', 'old-boot'),
                           ('binding', {**self.binding, 'projectId': 'foreign-project'})]:
            with self.subTest(key=key):
                saved = copy.deepcopy(self.record)
                self.record[key] = value
                self.write()
                with self.assertRaises(ValueError):
                    self.inspect()
                self.record = saved

    def test_foreign_link_or_unenslaved_veth_is_rejected(self):
        for extra in [
            {'ifname': 'tun0', 'ifindex': 5, 'linkinfo': {'info_kind': 'tun'}},
            {'ifname': 'veth-other', 'ifindex': 5, 'master': 99, 'linkinfo': {'info_kind': 'veth'}},
            {'ifname': 'eth1', 'ifindex': 5},
        ]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.inspect(self.links + [extra])
        with self.assertRaises(ValueError):
            self.inspect(self.links[:1])
        with self.assertRaises(ValueError):
            self.inspect([{**self.links[0], 'address': '00:00:00:00:00:00'}] + self.links[1:])

    def test_symlink_hardlink_and_readable_state_are_rejected(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.inspect()
        self.path.chmod(0o600)
        os.link(self.path, self.directory / 'second-link')
        with self.assertRaises(ValueError):
            self.inspect()
        (self.directory / 'second-link').unlink()
        original = self.path.with_suffix('.original')
        self.path.rename(original)
        self.path.symlink_to(original)
        with self.assertRaises(OSError):
            self.inspect()


if __name__ == '__main__':
    unittest.main()
