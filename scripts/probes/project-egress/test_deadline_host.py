"""Host admission contract tests; these do not substitute for native BPF proof."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py'
spec = importlib.util.spec_from_file_location('deadline_host', source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class DeadlineHostTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.binding = dict(zip(host.BINDING_FIELDS, ['project', 'generation', 'a' * 64,
                            'b' * 64, 'c' * 64, 've-test', '172.30.106.2', 'fd42:feed::2']))
        self.key = host.binding_key(self.binding)
        self.peer = {'device': 'vtest', 'index': 5}
        self.path = self.root / (self.key + '.json')
        host.save(self.path, {'binding': self.binding, 'peer': self.peer, 'bootId': 'boot',
                             'revision': 1, 'program': 7, 'invalidBeforeNs': '10', 'lastCapturedNs': '0',
                             'authorityExpiresAt': None, 'expiredAuthorities': [], 'uncertainExpiry': False,
                             'seenAuthorities': [None], 'authorityBootDeadlines': {}})
        self.lease = {'bootId': 'boot', 'binding': self.key, 'revision': 1, 'nonce': 'd' * 32,
                      'capturedBootNs': '20', 'bootDeadlineNs': '1000000020', 'authorityExpiresAt': None,
                      'authorityBootDeadlineNs': None}
        self.enter = self.enterContext
        original_lstat = Path.lstat
        registration = self.path
        def registered_lstat(path, *args, **kwargs):
            value = original_lstat(path, *args, **kwargs)
            if path == registration:
                fields = list(value)
                fields[4] = 0  # Model a trusted root-owned registration without requiring root tests.
                return os.stat_result(fields)
            return value
        self.enter(patch.object(Path, 'lstat', registered_lstat))
        self.enter(patch.object(host, 'STATE', self.root))
        self.enter(patch.object(host, 'clocks', return_value={
            'bootId': 'boot', 'bootBeforeNs': '2000000000', 'bootAfterNs': '2000000001', 'realNs': '1'}))
        self.enter(patch.object(host, 'endpoint', return_value=self.peer))
        self.enter(patch.object(host, 'attest'))
        self.listing = self.enter(patch.object(host, 'run', return_value=json.dumps({'nftables': [
            {'set': {'name': name}} for name in host.expiry_set_names(None)]})))
        self.write = self.enter(patch.object(host, 'write_deadline'))

    def arm(self):
        return host.execute({'operation': 'arm', 'binding': self.binding, 'lease': self.lease})

    def test_delayed_commit_preserves_expired_absolute_value(self):
        self.assertEqual(self.arm()['bootDeadlineNs'], '1000000020')
        self.assertEqual([c.args[-1] for c in self.write.call_args_list], [0, 1000000020])

    def test_replayed_admission_starts_denied_and_cannot_rearm(self):
        self.arm()
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_revoke_invalidates_previously_captured_admission(self):
        host.execute({'operation': 'revoke', 'binding': self.binding})
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)
        self.assertEqual(json.loads(self.path.read_text())['invalidBeforeNs'], '2000000001')

    def test_only_exact_staged_admission_survives_its_own_revoke(self):
        host.execute({'operation': 'revoke', 'binding': self.binding, 'lease': self.lease})
        altered = dict(self.lease)
        self.lease['nonce'] = 'e' * 32
        with self.assertRaises(ValueError):
            self.arm()
        self.lease = altered
        self.assertEqual(self.arm()['bootDeadlineNs'], '1000000020')
        with self.assertRaises(ValueError):
            self.arm()

    def test_delayed_executor_cannot_rebase_lifetime(self):
        self.lease['bootDeadlineNs'] = '3000000000'
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_kernel_overflow_stays_denied(self):
        self.lease['bootDeadlineNs'] = str(1 << 64)
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_observed_wall_expiry_survives_replacing_nft_tombstone(self):
        self.lease['authorityExpiresAt'] = 5000
        self.lease['authorityBootDeadlineNs'] = '5000000020'
        self.arm()
        a, b = host.expiry_set_names(5000)
        self.listing.return_value = json.dumps({'nftables': [
            {'set': {'name': a, 'elem': ['172.30.106.2']}}, {'set': {'name': b}}]})
        host.execute({'operation': 'revoke', 'binding': self.binding})
        self.lease['capturedBootNs'] = '2000000002'
        self.lease['bootDeadlineNs'] = '2000000002'
        host.clocks.return_value = {'bootId': 'boot', 'bootBeforeNs': '2000000010',
                                   'bootAfterNs': '2000000011', 'realNs': '1'}
        with self.assertRaisesRegex(ValueError, 'already observed expired'):
            self.arm()
        self.assertEqual(json.loads(self.path.read_text())['expiredAuthorities'], [5000])

    def test_lost_tombstone_evidence_prevents_later_admission(self):
        self.listing.side_effect = OSError('nft failure')
        with self.assertRaises(OSError):
            host.execute({'operation': 'revoke', 'binding': self.binding})
        with self.assertRaisesRegex(ValueError, 'fresh generation'):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_quiet_expiry_cannot_be_rebased_after_wall_clock_rollback(self):
        self.lease.update({'authorityExpiresAt': 5000, 'authorityBootDeadlineNs': '3000000000'})
        self.arm()
        host.clocks.return_value = {'bootId': 'boot', 'bootBeforeNs': '4000000010',
                                   'bootAfterNs': '4000000011', 'realNs': '0'}
        self.lease.update({'capturedBootNs': '4000000000', 'bootDeadlineNs': '5000000000',
                           'authorityBootDeadlineNs': '9000000000'})
        with self.assertRaisesRegex(ValueError, 'Original authority clock budget exhausted'):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_renewal_preserves_first_authority_mapping_and_can_only_shorten_it(self):
        self.lease.update({'authorityExpiresAt': 5000, 'authorityBootDeadlineNs': '3000000000'})
        self.arm()
        self.lease.update({'capturedBootNs': '1000000000', 'bootDeadlineNs': '2000000000',
                           'authorityBootDeadlineNs': '9000000000'})
        self.arm()
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved['authorityBootDeadlines']['5000'], '3000000000')
        self.lease.update({'capturedBootNs': '1000000001', 'bootDeadlineNs': '2000000001',
                           'authorityBootDeadlineNs': '2500000000'})
        self.arm()
        self.assertEqual(json.loads(self.path.read_text())['authorityBootDeadlines']['5000'],
                         '2500000000')

    def test_attestation_accepts_only_one_software_program_with_matching_headers(self):
        header = {'kind': 'bpf', 'pref': 1, 'chain': 0, 'protocol': 'all'}
        concrete = {**header, 'options': {'id': 7, 'not_in_hw': True}}
        host.attest_filters([header, concrete], 7)
        for filters in ([header], [concrete, concrete], [{**concrete, 'protocol': 'ip'}],
                        [{**concrete, 'options': {'id': 8}}],
                        [{**concrete, 'options': {'id': 7, 'in_hw': True}}],
                        [{**concrete, 'options': {'id': 7, 'actions': [{'kind': 'mirred'}]}}]):
            with self.assertRaises(ValueError): host.attest_filters(filters, 7)


if __name__ == '__main__':
    unittest.main()
