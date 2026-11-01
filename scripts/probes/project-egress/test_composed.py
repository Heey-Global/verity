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
                case = {'phase': phase, 'family': family, 'expected': allowed, 'observed': allowed}
                if phase == 'before-admission':
                    case['resolution'] = {'phase': f'{phase}-{family}', 'family': 4 if family == 0 else 6,
                                          'terminal': 'EHOSTUNREACH', 'hostBeforeNs': str(1 + family * 2),
                                          'hostAfterNs': str(2 + family * 2)}
                cases.append(case)
                if allowed:
                    for protocol in ('tcp', 'udp'):
                        records.append({'kind': protocol, 'marker': f'{phase}-{family}-{protocol}', 'boot_ns': '1000000000'})
        records.extend([{'kind': 'tcp', 'marker': 'stream-retained', 'boot_ns': '100000000'},
                        {'kind': 'tcp', 'marker': 'stream-retained', 'boot_ns': '2300000000'}])
        proof = {'live': {'deadline_ns': '2000000000', 'accepted': 10},
                 'expired': {'accepted': 12, 'denied': 1, 'clocks': {'bootBeforeNs': '3000000000'}},
                 'attempted': {'accepted': 12, 'denied': 2, 'last_accepted_boot_ns': '1500000000', 'clocks': {'bootBeforeNs': '3300000000'}},
                 'heartbeatBefore': {'attempts': 30, 'boot_ns': '1000'},
                 'heartbeat': {'attempts': 32, 'boot_ns': '2000'},
                 'heartbeatWindowStart': {'clocks': {'bootBeforeNs': '5000000000'}},
                 'heartbeatWindowEnd': {'clocks': {'bootBeforeNs': '5300000000'}}}
        (root / 'composed-result.json').write_text(json.dumps({'complete': True, 'cases': cases}))
        (root / 'composed-stream-proof.json').write_text(json.dumps(proof))
        (root / 'composed-receiver.txt').write_text('\n'.join(map(json.dumps, records)))
        return proof, records

    def test_accepts_complete_positive_and_denial_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            self.assertEqual(composed.verify(root)['cases'], 12)

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
        for mutation in ['missing-positive', 'unexpected-receipt', 'late-kernel', 'no-attempts', 'late-receipt', 'missing-case', 'stopped-sender', 'stopped-guest-clock', 'early-window', 'short-window']:
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


class InitialResolution(unittest.TestCase):
    def test_actual_sender_requires_terminal_host_unreachable_in_both_families(self):
        import errno
        import runpy
        import socket
        from unittest.mock import patch, MagicMock
        for target in ['11.77.106.2', '2001:4860:feed:106::2']:
            for outcome in [OSError(errno.EHOSTUNREACH, 'unreachable'), TimeoutError(),
                            OSError(errno.ECONNREFUSED, 'refused'), None]:
                with self.subTest(target=target, outcome=outcome):
                    channel = MagicMock()
                    channel.__enter__.return_value = channel
                    channel.connect.side_effect = outcome
                    channel.recv.return_value = b'external-positive'
                    with patch('sys.argv', ['composed-client.py', target, 'before-admission-0', 'negative']), \
                         patch('socket.socket', return_value=channel), patch('builtins.print') as printed:
                        if isinstance(outcome, OSError) and outcome.errno == errno.EHOSTUNREACH:
                            runpy.run_path(str(Path(__file__).with_name('composed-client.py')), run_name='__main__')
                            result = json.loads(printed.call_args.args[0])
                            self.assertEqual(result['terminal'], 'EHOSTUNREACH')
                            self.assertEqual(result['family'], 6 if ':' in target else 4)
                        else:
                            with self.assertRaises(RuntimeError):
                                runpy.run_path(str(Path(__file__).with_name('composed-client.py')), run_name='__main__')
                            printed.assert_not_called()
                    channel.settimeout.assert_called_once_with(4)


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
