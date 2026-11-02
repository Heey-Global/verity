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
                case = {'phase': phase, 'family': family, 'expected': allowed, 'observed': allowed}
                if phase == 'before-admission':
                    case['resolution'] = {'phase': f'{phase}-{family}', 'family': 4 if family == 0 else 6,
                                          'terminal': 'EHOSTUNREACH', 'hostBeforeNs': str(1 + family * 2),
                                          'hostAfterNs': str(2 + family * 2)}
                if allowed:
                    case['connect'] = {'phase': f'{phase}-{family}', 'family': 4 if family == 0 else 6,
                                       'connectNs': '2000000'}
                cases.append(case)
                if allowed:
                    for protocol in ('tcp', 'udp'):
                        records.append({'kind': protocol, 'marker': f'{phase}-{family}-{protocol}', 'boot_ns': '1000000000'})
        records.extend([{'kind': 'tcp', 'marker': 'stream-retained', 'boot_ns': '100000000'},
                        {'kind': 'tcp', 'marker': 'stream-retained', 'boot_ns': '2300000000'}])
        proof = {'live': {'deadline_ns': '2000000000', 'accepted': 10, 'state': {'binding': {'containerId': 'sandbox'}, 'relayRegistration': {'containerId': 'relay'}}},
                 'expired': {'accepted': 12, 'denied': 1, 'clocks': {'bootBeforeNs': '3000000000'}},
                 'attempted': {'accepted': 12, 'denied': 2, 'last_accepted_boot_ns': '1500000000', 'clocks': {'bootBeforeNs': '3300000000'}},
                 'heartbeat': {'attempts': 30, 'boot_ns': '200'}, 'heartbeatBefore': {'attempts': 29, 'boot_ns': '100'},
                 'heartbeatWindowStart': {'clocks': {'bootBeforeNs': '4000000001'}},
                 'heartbeatWindowEnd': {'clocks': {'bootBeforeNs': '4300000001'}}}
        helper = {'afterKillState': 'gone', 'signal': 'SIGKILL', 'helper': {'pid': 123, 'command': '/usr/bin/python3\0/opt/verity-egress/project-egress-deadline.py\0--worker'},
                  'beforeKill': {'clocks': {'bootBeforeNs': '1300000000'}},
                  'live': {'state': proof['live']['state'], 'deadline_ns': '2500000000', 'accepted': 10, 'clocks': {'bootBeforeNs': '1400000000'}},
                  'expired': proof['expired'], 'attempted': proof['attempted']}
        helper['attempted'] = {**proof['attempted'], 'containers': [{'Id': value, 'State': {'Running': False}} for value in ('sandbox', 'relay')]}
        records.append({'kind': 'tcp', 'marker': 'helper-retained', 'boot_ns': '1200000000'})
        (root / 'retired-containers.json').write_text(json.dumps({'sandbox': {'id': 'sandbox', 'running': False}, 'relay': {'id': 'relay', 'running': False}}))
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

    def test_rejects_admitted_connections_that_waited_for_neighbor_retry(self):
        for mutation in ('slow', 'missing', 'mislabeled', 'negative'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fixture(root)
                path = root / 'composed-result.json'
                report = json.loads(path.read_text())
                row = next(r for r in report['cases'] if r['phase'] == 'fresh-after-helper')
                if mutation == 'slow':
                    row['connect']['connectNs'] = '1000000000'
                elif mutation == 'missing':
                    del row['connect']
                elif mutation == 'mislabeled':
                    row['connect']['phase'] = 'admitted-0'
                else:
                    denied = next(r for r in report['cases'] if r['phase'] == 'lease-expired')
                    denied['connect'] = dict(row['connect'])
                path.write_text(json.dumps(report))
                with self.assertRaises((AssertionError, KeyError)):
                    composed.verify(root)

    def test_rejects_missing_running_substituted_or_duplicate_helper_containment(self):
        for mutation in ('missing', 'running', 'substituted', 'duplicate'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fixture(root)
                path = root / 'composed-helper-proof.json'
                report = json.loads(path.read_text())
                rows = report['attempted']['containers']
                if mutation == 'missing':
                    rows.pop()
                elif mutation == 'running':
                    rows[0]['State']['Running'] = True
                elif mutation == 'substituted':
                    rows[0]['Id'] = 'other-generation'
                else:
                    rows.append(rows[0])
                path.write_text(json.dumps(report))
                with self.assertRaises(AssertionError):
                    composed.verify(root)

    def test_requires_both_terminal_results_and_ordered_host_boundaries(self):
        for mutation in ['missing', 'timeout', 'family', 'phase', 'reversed', 'overlap']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fixture(root)
                path = root / 'composed-result.json'
                report = json.loads(path.read_text())
                evidence = report['cases'][1]['resolution']
                if mutation == 'missing':
                    del report['cases'][1]['resolution']
                elif mutation == 'timeout': evidence['terminal'] = 'ETIMEDOUT'
                elif mutation == 'family': evidence['family'] = 4
                elif mutation == 'phase': evidence['phase'] = 'admitted-1'
                elif mutation == 'reversed': evidence['hostAfterNs'] = '1'
                else: evidence['hostBeforeNs'] = '1'
                path.write_text(json.dumps(report))
                with self.assertRaises((AssertionError, KeyError)):
                    composed.verify(root)

    def test_rejects_delayed_initial_udp_even_after_grant(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, records = self.fixture(root)
            records.append({'kind': 'udp', 'marker': 'before-admission-1-udp', 'boot_ns': '1500000000'})
            (root / 'composed-receiver.txt').write_text('\n'.join(map(json.dumps, records)))
            with self.assertRaises(AssertionError): composed.verify(root)

    def test_rejects_missing_controls_unauthorized_receipts_and_late_kernel_acceptance(self):
        for mutation in ['missing-positive', 'unexpected-receipt', 'late-kernel', 'no-attempts', 'late-receipt', 'missing-case', 'frozen-heartbeat', 'early-host-barrier', 'retired-running', 'wrong-retired-id']:
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
                elif mutation == 'frozen-heartbeat':
                    proof['heartbeatBefore']['attempts'] = proof['heartbeat']['attempts']
                elif mutation in ('retired-running', 'wrong-retired-id'):
                    retired = json.loads((root / 'retired-containers.json').read_text())
                    if mutation == 'retired-running':
                        retired['relay']['running'] = True
                    else:
                        retired['sandbox']['id'] = 'other'
                    (root / 'retired-containers.json').write_text(json.dumps(retired))
                elif mutation == 'early-host-barrier':
                    proof['heartbeatWindowStart']['clocks']['bootBeforeNs'] = '3999999999'
                else:
                    report = json.loads((root / 'composed-result.json').read_text())
                    report['cases'].pop()
                    (root / 'composed-result.json').write_text(json.dumps(report))
                (root / 'composed-stream-proof.json').write_text(json.dumps(proof))
                (root / 'composed-receiver.txt').write_text('\n'.join(map(json.dumps, records)))
                with self.assertRaises(AssertionError):
                    composed.verify(root)

    def test_rejects_missing_or_late_helper_receiver_evidence(self):
        for missing in (True, False):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.fixture(root)
                records = [json.loads(line) for line in (root / 'composed-receiver.txt').read_text().splitlines()]
                if missing:
                    records = [row for row in records if row.get('marker') != 'helper-retained']
                else:
                    records.append({'kind': 'tcp', 'marker': 'helper-retained', 'boot_ns': '3300000001'})
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
