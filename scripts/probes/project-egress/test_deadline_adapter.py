"""Synthetic rejection tests for actual-adapter evidence, not runtime proof."""
import copy
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('adapter_proof', Path(__file__).with_name('deadline-adapter-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class AdapterDeadlineProofTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        cases = []
        for phase, expected in [('positive-a', True), ('positive-b', True), ('allowed-a', True),
                                ('denied-b', False), ('lease-expiry', False), ('before-revoke', True),
                                ('revoked', False), ('removed-fence', True)]:
            for kind in ('tcp', 'udp'):
                for address in ('11.77.3.2', '2001:4860:feed:3::2'):
                    cases.append({'case': f'{phase}-{kind}-{address}', 'expected': expected, 'observed': expected})
        cases += [{'case': name, 'expected': expected, 'observed': expected}
                  for name, expected in [('peer-positive', True), ('peer-denied', False), ('deadline-fresh-after-renewal', True)]]
        self.report = {'complete': True, 'cases': cases}
        positive = {'identity': 'binding', 'deadline_ns': '2000000000', 'accepted': 5, 'denied': 0,
                    'last_accepted_boot_ns': '1500000000', 'last_denied_boot_ns': '0',
                    'clocks': {'bootBeforeNs': '1800000000'},
                    'state': {'lastCapturedNs': '1000000000', 'program': 7, 'peer': {'index': 5}}}
        before, after = copy.deepcopy(positive), copy.deepcopy(positive)
        before['clocks']['bootBeforeNs'] = '2100000000'
        after.update({'denied': 2, 'last_denied_boot_ns': '2200000000', 'clocks': {'bootBeforeNs': '4000000000'}})
        self.evidence = {'complete': True, 'baseline': {'accepted': 0}, 'positive': positive,
                         'expiredBefore': before, 'expiredAfter': after}
        self.retained = [{'marker': marker, 'boot_ns': instant} for marker, instant in [
            ('deadline-stream-0', 1400000000), ('deadline-stream-1', 1600000000),
            ('deadline-retained-live', 1700000000), ('deadline-fresh-after-renewal', 5000000000)]]

    def verify(self):
        (self.root / 'adapter-result.json').write_text(json.dumps(self.report))
        (self.root / 'adapter-deadline-proof.json').write_text(json.dumps(self.evidence))
        for name, rows in [('adapter-deadline-receiver.jsonl', self.retained),
                           ('adapter-receiver.jsonl', [{'marker': re.sub('[^a-z0-9]', '-', c['case'])}
                            for c in self.report['cases'] if c['expected'] and not c['case'].startswith('peer-')]),
                           ('adapter-peer.jsonl', [{'marker': 'peer-positive'}])]:
            (self.root / name).write_text('\n'.join(map(json.dumps, rows)))
        return proof.verify(self.root)

    def test_complete_evidence(self):
        self.assertEqual(self.verify()['cases'], 35)

    def test_late_kernel_decision(self):
        self.evidence['expiredAfter']['last_accepted_boot_ns'] = '2000000000'
        with self.assertRaises(AssertionError): self.verify()

    def test_missing_expiry_attempt(self):
        self.evidence['expiredAfter']['denied'] = 0
        with self.assertRaises(AssertionError): self.verify()

    def test_old_stream_revival(self):
        self.retained.append({'marker': 'deadline-retained-renewed', 'boot_ns': 5000000000})
        with self.assertRaises(AssertionError): self.verify()

    def test_late_receiver_closure(self):
        self.retained.append({'marker': 'deadline-stream-2', 'boot_ns': 4000000001})
        with self.assertRaises(AssertionError): self.verify()

    def test_missing_continuous_positive(self):
        self.retained.pop(0)
        with self.assertRaises(AssertionError): self.verify()

    def test_missing_case(self):
        self.report['cases'].pop()
        with self.assertRaises(AssertionError): self.verify()


if __name__ == '__main__':
    unittest.main()
