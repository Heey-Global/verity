import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('composed', Path(__file__).with_name('composed-proof.py'))
composed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(composed)


class ComposedProof(unittest.TestCase):
    def fixture(self, root):
        cases, records = [], []
        for phase, allowed in [('before-admission', False), ('admitted', True), ('lease-expired', False),
                               ('fresh-after-expiry', True), ('direct-revoked', False), ('authority-empty', False),
                               ('helper-expired', False), ('fresh-after-helper', True)]:
            for family in range(2):
                cases.append({'phase': phase, 'family': family, 'expected': allowed, 'observed': allowed})
                if allowed:
                    for protocol in ('tcp', 'udp'):
                        records.append({'kind': protocol, 'marker': f'{phase}-{family}-{protocol}', 'boot_ns': '1000000000'})
        records.extend([{'kind': 'tcp', 'marker': 'stream-retained', 'boot_ns': '100000000'},
                        {'kind': 'tcp', 'marker': 'stream-retained', 'boot_ns': '2300000000'}])
        proof = {'live': {'deadline_ns': '2000000000', 'accepted': 10},
                 'expired': {'accepted': 12, 'denied': 1, 'clocks': {'bootBeforeNs': '3000000000'}},
                 'attempted': {'accepted': 12, 'denied': 2, 'last_accepted_boot_ns': '1500000000', 'clocks': {'bootBeforeNs': '3300000000'}},
                 'heartbeat': {'attempts': 30, 'boot_ns': '5000000000'}}
        helper = {'afterKillState': 'gone', 'signal': 'SIGKILL', 'helper': {'pid': 123, 'command': '/usr/bin/python3\0/opt/verity-egress/project-egress-deadline.py\0--serve'},
                  'beforeKill': {'clocks': {'bootBeforeNs': '1300000000'}},
                  'live': {'deadline_ns': '2500000000', 'accepted': 10, 'clocks': {'bootBeforeNs': '1400000000'}},
                  'expired': proof['expired'], 'attempted': proof['attempted']}
        (root / 'composed-helper-proof.json').write_text(json.dumps(helper))
        (root / 'composed-result.json').write_text(json.dumps({'complete': True, 'cases': cases}))
        (root / 'composed-stream-proof.json').write_text(json.dumps(proof))
        (root / 'composed-receiver.txt').write_text('\n'.join(map(json.dumps, records)))
        return proof, records

    def test_accepts_complete_positive_and_denial_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            result = composed.verify(root)
            self.assertEqual(result['cases'], 16)
            self.assertEqual(result['receiver_tail_seconds'], 0.3)

    def test_rejects_missing_controls_unauthorized_receipts_and_late_kernel_acceptance(self):
        for mutation in ['missing-positive', 'unexpected-receipt', 'late-kernel', 'no-attempts', 'late-receipt', 'missing-case']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                proof, records = self.fixture(root)
                if mutation == 'missing-positive':
                    records.pop(0)
                elif mutation == 'unexpected-receipt':
                    records.append({'kind': 'udp', 'marker': 'direct-revoked-0-udp', 'boot_ns': '3000000000'})
                elif mutation == 'late-kernel':
                    proof['attempted']['accepted'] += 1
                elif mutation == 'no-attempts':
                    proof['attempted']['denied'] = proof['expired']['denied']
                elif mutation == 'late-receipt':
                    records[-1]['boot_ns'] = '5000000000'
                else:
                    report = json.loads((root / 'composed-result.json').read_text())
                    report['cases'].pop()
                    (root / 'composed-result.json').write_text(json.dumps(report))
                (root / 'composed-stream-proof.json').write_text(json.dumps(proof))
                (root / 'composed-receiver.txt').write_text('\n'.join(map(json.dumps, records)))
                with self.assertRaises(AssertionError):
                    composed.verify(root)

    def test_rejects_missing_or_invalid_helper_failure_evidence(self):
        for field, value in [('afterKillState', 'R'), ('signal', 'SIGTERM'), ('helper', {'pid': 0, 'command': ''}),
                             ('attempted', {'clocks': {'bootBeforeNs': '6000000000'}})]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fixture(root)
                path = root / 'composed-helper-proof.json'
                helper = json.loads(path.read_text())
                helper[field] = value
                path.write_text(json.dumps(helper))
                with self.assertRaises(AssertionError):
                    composed.verify(root)



if __name__ == '__main__':
    unittest.main()
