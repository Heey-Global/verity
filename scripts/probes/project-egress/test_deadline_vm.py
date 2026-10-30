"""Acceptance verifier regressions; synthetic evidence cannot certify runtime."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deadline_vm', Path(__file__).with_name('deadline-vm.py'))
deadline_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deadline_vm)


def evidence():
    cases = []
    for name in ('expired', 'delayed-commit', 'suspend', 'vm-pause', 'wall-forward', 'wall-backward', 'wall-forward-backward'):
        cases.append({'name': name, 'baseline': {'accepted': 0}, 'positive': {'accepted': 1},
                      'before': {'accepted': 1, 'denied': 0},
                      'after': {'accepted': 1, 'denied': 1, 'last_accepted_boot_ns': 1,
                                'clocks': {'boot_ns': 5_000_000_001, 'mono_ns': 1}},
                      'lease': {'deadline_ns': 2, 'committed': {'boot_ns': 3}},
                      'clocks_before': {'boot_ns': 1, 'mono_ns': 1},
                      'wall_positive_before': {'accepted': 0}, 'wall_positive_after': {'accepted': 1},
                      'latch_before': 0, 'latch_after': 1, 'rollback_clocks': {'real_ns': 0},
                      'wall_deadline_real_ns': 1, 'outer_pause_ns': 4_000_000_000, 'wall_expired_before': 0, 'wall_expired_after': 1})
    cases[-1]['lease']['deadline_ns'] = 6_000_000_000
    zero = {'map': {'deadline_ns': 0, 'index': 5}, 'baseline': {'accepted': 0},
            'positive': {'accepted': 1}, 'before': {'accepted': 1, 'denied': 0},
            'after': {'accepted': 1, 'denied': 2}}
    mutations = {'wall': {'protected_before': 0, 'protected_after': 2,
                         'before': {'accepted': 1}, 'after': {'accepted': 3, 'last_accepted_boot_ns': 5,
                         'clocks': {'real_ns': 10}}, 'real_deadline_ns': 9, 'lease': {'deadline_ns': 6}},
                 'guard': {'map': {'deadline_ns': 0}, 'removed': {'qdiscs': [{'kind': 'noqueue'}]},
                           'before': {'accepted': 3, 'denied': 2}, 'after': {'accepted': 3, 'denied': 2}}}
    return {'complete': True, 'cases': cases, 'zero': zero, 'mutations': mutations,
            'started_mono_ns': 1, 'finished_mono_ns': 2}


class DeadlineVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.proof = evidence()
        self.payloads = [f'positive-{c["name"]}' for c in self.proof['cases']]
        self.payloads += [f'wall-live-{c["name"]}' for c in self.proof['cases'] if c['name'].startswith('wall-')]
        self.payloads += ['positive-zero', 'positive-mutation-wall', 'mutation-removed-wall', 'mutation-removed-guard']
        self.inbound = ['inbound-' + marker for marker in self.payloads]

    def verify(self):
        (self.root / 'deadline-proof.json').write_text(json.dumps(self.proof))
        records = [{'kind': 'ready', 'monotonic_ns': 0}, {'kind': 'stopped', 'monotonic_ns': 3}]
        records += [{'kind': 'received', 'data': base64.b64encode(p.encode()).decode()} for p in self.payloads]
        (self.root / 'external-receipts.jsonl').write_text('\n'.join(map(json.dumps, records)))
        (self.root / 'inbound-receipts.jsonl').write_text('\n'.join(json.dumps({
            'kind': 'received', 'marker': payload, 'boot_ns': 1,
        }) for payload in self.inbound))
        return deadline_vm.verify(self.root)

    def test_complete_contract(self):
        self.assertEqual(self.verify(), {'cases': 7, 'complete': True})

    def test_rejects_wall_rollback_revival(self):
        self.proof['cases'][-1]['latch_after'] = 0
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_boot_expiry_masking_latch(self):
        self.proof['cases'][-1]['after']['clocks']['boot_ns'] = 6_000_000_000
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_late_kernel_acceptance(self):
        self.proof['cases'][0]['after']['accepted'] += 1
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_no_post_expiry_attempt(self):
        self.proof['cases'][0]['after']['denied'] = 0
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_monotonic_clock_as_suspend_proof(self):
        case = next(c for c in self.proof['cases'] if c['name'] == 'suspend')
        case['after']['clocks']['mono_ns'] = case['after']['clocks']['boot_ns']
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_commit_before_deadline_as_delay_proof(self):
        case = next(c for c in self.proof['cases'] if c['name'] == 'delayed-commit')
        case['lease']['committed']['boot_ns'] = 1
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_absent_absolute_time_denial(self):
        case = next(c for c in self.proof['cases'] if c['name'] == 'wall-forward')
        case['wall_expired_after'] = 0
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_missing_wall_positive(self):
        self.proof['cases'][-1]['wall_positive_after']['accepted'] = 0
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_external_late_receipt(self):
        self.payloads.append('expired-suspend')
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_missing_positive(self):
        self.payloads.pop()
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_missing_case(self):
        self.proof['cases'].pop()
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rejects_expired_inbound_receipt(self):
        self.inbound.append('inbound-expired-suspend')
        with self.assertRaises(AssertionError): self.verify()

    def test_rejects_missing_inbound_positive(self):
        self.inbound.pop()
        with self.assertRaises(AssertionError): self.verify()

    def test_rejects_zero_deadline_permission(self):
        self.proof['zero']['after']['accepted'] += 1
        with self.assertRaises(AssertionError): self.verify()

    def test_rejects_unremoved_kernel_guard_as_mutation(self):
        self.proof['mutations']['guard']['removed']['qdiscs'] = [{'kind': 'clsact'}]
        with self.assertRaises(AssertionError): self.verify()

    def test_rejects_wall_mutation_after_boot_expiry(self):
        self.proof['mutations']['wall']['after']['last_accepted_boot_ns'] = 6
        with self.assertRaises(AssertionError): self.verify()


if __name__ == '__main__':
    unittest.main()
