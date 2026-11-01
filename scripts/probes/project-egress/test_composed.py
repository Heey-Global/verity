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
                               ('fresh-after-expiry', True), ('direct-revoked', False), ('authority-empty', False)]:
            for family in range(2):
                cases.append({'phase': phase, 'family': family, 'expected': allowed, 'observed': allowed})
                if allowed:
                    for protocol in ('tcp', 'udp'):
                        records.append({'kind': protocol, 'marker': f'{phase}-{family}-{protocol}', 'boot_ns': '1000000000'})
        records.extend([{'kind': 'tcp', 'marker': 'stream-retained', 'boot_ns': '100000000'},
                        {'kind': 'tcp', 'marker': 'stream-retained', 'boot_ns': '2300000000'}])
        proof = {'live': {'deadline_ns': '2000000000', 'accepted': 10, 'state': {'binding': {'containerId': 'sandbox'}, 'relayRegistration': {'containerId': 'relay'}}},
                 'expired': {'accepted': 12, 'denied': 1, 'clocks': {'bootBeforeNs': '3000000000'}},
                 'attempted': {'accepted': 12, 'denied': 2, 'last_accepted_boot_ns': '1500000000', 'clocks': {'bootBeforeNs': '3300000000'}},
                 'heartbeatBefore': {'attempts': 30, 'boot_ns': '1000'},
                 'heartbeat': {'attempts': 32, 'boot_ns': '2000', 'lateAttempts': 25, 'hostBootBeforeNs': '4100000000'},
                 'heartbeatWindowStart': {'clocks': {'bootBeforeNs': '5000000000'}},
                 'heartbeatWindowEnd': {'clocks': {'bootBeforeNs': '5300000000'}}}
        (root / 'retired-containers.json').write_text(json.dumps({role: {'id': role, 'running': False} for role in ['sandbox', 'relay']}))
        (root / 'composed-result.json').write_text(json.dumps({'complete': True, 'cases': cases}))
        (root / 'composed-stream-proof.json').write_text(json.dumps(proof))
        (root / 'composed-receiver.txt').write_text('\n'.join(map(json.dumps, records)))
        return proof, records

    def test_accepts_complete_positive_and_denial_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            self.assertEqual(composed.verify(root)['cases'], 12)

    def test_rejects_missing_controls_unauthorized_receipts_and_late_kernel_acceptance(self):
        for mutation in ['missing-positive', 'unexpected-receipt', 'late-kernel', 'no-attempts', 'late-receipt', 'missing-case', 'stopped-sender', 'stopped-guest-clock', 'early-window', 'short-window', 'frozen-heartbeat', 'early-host-barrier', 'retired-running', 'wrong-retired-id']:
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
                    proof['heartbeat']['lateAttempts'] = proof['heartbeat']['attempts']
                elif mutation in ('retired-running', 'wrong-retired-id'):
                    retired = json.loads((root / 'retired-containers.json').read_text())
                    if mutation == 'retired-running':
                        retired['relay']['running'] = True
                    else:
                        retired['sandbox']['id'] = 'other'
                    (root / 'retired-containers.json').write_text(json.dumps(retired))
                elif mutation == 'early-host-barrier':
                    proof['heartbeat']['hostBootBeforeNs'] = '3999999999'
                elif mutation == 'stopped-sender':
                    proof['heartbeat']['attempts'] = proof['heartbeatBefore']['attempts']
                elif mutation == 'stopped-guest-clock':
                    proof['heartbeat']['boot_ns'] = proof['heartbeatBefore']['boot_ns']
                elif mutation == 'early-window':
                    proof['heartbeatWindowStart']['clocks']['bootBeforeNs'] = '3000000000'
                elif mutation == 'short-window':
                    proof['heartbeatWindowEnd']['clocks']['bootBeforeNs'] = '5000000001'
                else:
                    report = json.loads((root / 'composed-result.json').read_text())
                    report['cases'].pop()
                    (root / 'composed-result.json').write_text(json.dumps(report))
                (root / 'composed-stream-proof.json').write_text(json.dumps(proof))
                (root / 'composed-receiver.txt').write_text('\n'.join(map(json.dumps, records)))
                with self.assertRaises(AssertionError):
                    composed.verify(root)


class StreamLifetime(unittest.TestCase):
    def test_actual_sender_survives_old_nine_second_cutoff_until_explicit_stop(self):
        import runpy
        from unittest.mock import patch
        elapsed, beats = [0], []
        class FixturePath:
            def __init__(self, path):
                self.path = path
            def exists(self):
                return len(beats) >= 2
            def write_text(self, value):
                beats.append(json.loads(value))
            def replace(self, destination):
                pass
        class Channel:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def settimeout(self, value): pass
            def connect(self, target): pass
            def sendall(self, value): pass
            def recv(self, size): return b'ack'
        def sleep(seconds):
            elapsed[0] += 10
        sender = str(Path(__file__).with_name('composed-client.py'))
        with patch('sys.argv', ['composed-client.py', '11.77.106.2', 'stream', 'stream']), \
             patch('socket.socket', return_value=Channel()), patch('pathlib.Path', FixturePath), \
             patch('time.monotonic', side_effect=lambda: elapsed[0]), patch('time.sleep', side_effect=sleep):
            with self.assertRaises(SystemExit) as exited:
                runpy.run_path(sender, run_name='__main__')
        self.assertEqual(exited.exception.code, 0)
        self.assertEqual([beat['attempts'] for beat in beats], [1, 2])


if __name__ == '__main__':
    unittest.main()
