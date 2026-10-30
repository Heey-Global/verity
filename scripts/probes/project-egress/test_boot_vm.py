import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('boot_vm', Path(__file__).with_name('boot-vm.py'))
boot_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot_vm)


class BootEvidenceTests(unittest.TestCase):
    def test_process_restart_is_not_a_guest_reboot(self):
        before = {'boot_id': '11111111-1111-1111-1111-111111111111', 'init': 'systemd', 'systemd': 249}
        with self.assertRaisesRegex(ValueError, 'did not reboot'):
            boot_vm.check_reboot(before, dict(before))
        after = {**before, 'boot_id': '22222222-2222-2222-2222-222222222222'}
        boot_vm.check_reboot(before, after)

    def test_rejects_container_init_and_old_systemd(self):
        before = {'boot_id': '11111111-1111-1111-1111-111111111111', 'init': 'systemd', 'systemd': 249}
        for changes in ({'init': 'sh'}, {'systemd': 248}, {'boot_id': ''}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                boot_vm.check_reboot(before, {**before, **changes})

proof_spec = importlib.util.spec_from_file_location('boot_proof', Path(__file__).with_name('boot-proof.py'))
boot_proof = importlib.util.module_from_spec(proof_spec)
proof_spec.loader.exec_module(boot_proof)


class RetainedTopologyTests(unittest.TestCase):
    def fixture(self):
        return {'projectId': 'p', 'registry': {'generation': 'g'}, 'containers': [
            {'id': 'sandbox', 'restart': 'no', 'running': True, 'mounts': ['/work'], 'image': 'sandbox-image'},
            {'id': 'relay', 'restart': 'no', 'running': True, 'mounts': ['/socket'], 'image': 'relay-image'}]}

    def test_rejects_recreated_runtime_and_automatic_restart(self):
        import copy
        before = self.fixture()
        boot_proof.verify_retained(before, copy.deepcopy(before))
        for key, value in [('id', 'replacement'), ('restart', 'always'), ('mounts', ['/different']), ('running', False)]:
            after = copy.deepcopy(before)
            after['containers'][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                boot_proof.verify_retained(before, after)

    def test_observer_rejects_leak_or_missing_observation(self):
        import base64
        import json
        import tempfile
        records = [{'kind': 'heartbeat', 'time_ns': n} for n in [0, 1_000_000_000, 2_000_000_000]]
        records += [{'kind': 'received', 'data': base64.b64encode(
            f'outer-positive-{phase}-{family}-{protocol}-{port}'.encode()).decode()}
            for phase in ('before', 'after') for family in (2, 10)
            for protocol, port in [('udp', 53), ('udp', 8080), ('tcp', 443)]]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, 'receipts.jsonl')
            def save(rows):
                path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            save(records)
            boot_proof.verify_receipts(path, 0, 2_000_000_000)
            save(records + [{'kind': 'received', 'data': base64.b64encode(b'host-startup-marker').decode()}])
            with self.assertRaisesRegex(AssertionError, 'Unauthorized'):
                boot_proof.verify_receipts(path, 0, 2_000_000_000)
            save(records[:1])
            with self.assertRaisesRegex(AssertionError, 'cover lifecycle'):
                boot_proof.verify_receipts(path, 0, 3_000_000_000)


class RemovedFenceSensitivityTests(unittest.TestCase):
    def test_requires_all_sandbox_paths_and_inherited_descriptors(self):
        import base64
        import json
        import tempfile
        markers = [f'direct-{family}-{protocol}-{port}-own-credential-marker'.encode()
                   for family in (2, 10) for protocol, port in [('udp', 53), ('udp', 8080), ('tcp', 443)]]
        markers += [b'host-startup-marker', b'transferred-startup-marker']
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, 'receipts.jsonl')
            rows = [{'kind': 'received', 'time_ns': 2, 'data': base64.b64encode(marker).decode()} for marker in markers]
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
            self.assertEqual(boot_proof.verify_removed_fences(path, 1), len(markers))
            path.write_text(''.join(json.dumps(row) + '\n' for row in rows[1:]))
            with self.assertRaisesRegex(AssertionError, 'every sandbox probe'):
                boot_proof.verify_removed_fences(path, 1)


class FullBundleTests(unittest.TestCase):
    def fixture(self, directory):
        import base64
        import copy
        import json
        initial = RetainedTopologyTests().fixture()
        facts = {'boot_id': '11111111-1111-1111-1111-111111111111', 'init': 'systemd', 'systemd': 259}
        events = []
        broker = []
        for index, name in enumerate(['controller-kill', 'server-kill', 'docker-stop-start', 'docker-crash', 'reboot']):
            when = (index + 1) * 10_000_000_000
            after = copy.deepcopy(facts)
            if name == 'reboot':
                after['boot_id'] = '22222222-2222-2222-2222-222222222222'
            events.append({'event': name, 'before': facts, 'after': after, 'event_time_ns': when,
                           'retained': copy.deepcopy(initial), 'recovery_ns': 1,
                           'process_before': {'docker': 10, 'controller': 20, 'server': 30},
                           'process_after': {'docker': 11, 'controller': 21, 'server': 31},
                           'stream_before': {'attempts': 4, 'successes': 3, 'last_success_ns': when - 1,
                                             'last_receipt_ns': when - 1, 'heartbeat_ns': when - 1},
                           'stream_after': {'attempts': 5, 'last_success_ns': when - 1, 'last_receipt_ns': when - 1,
                                            'heartbeat_ns': when + 2_000_000_000, 'observed_ns': when + 2_000_000_001}})
            broker.append({'phase': name, 'time_ns': str(when - 1)})
        proof = {'complete': True, 'removed_fences_detected': True, 'events': events,
                 'protected_start_ns': 0, 'protected_end_ns': 100_000_000_000, 'mutation_started_ns': 101_000_000_000,
                 'faults': ['corrupt-registry-denied', 'nftables-failure-denied', 'unsupported-live-restore-denied']}
        rows = [{'kind': 'heartbeat', 'time_ns': n * 1_000_000_000} for n in range(101)]
        rows += [{'kind': 'received', 'time_ns': 1, 'data': base64.b64encode(
            f'outer-positive-{phase}-{family}-{protocol}-{port}'.encode()).decode()}
            for phase in ('before', 'after') for family in (2, 10)
            for protocol, port in [('udp', 53), ('udp', 8080), ('tcp', 443)]]
        protected = ''.join(json.dumps(row) + '\n' for row in rows)
        markers = [f'direct-{family}-{protocol}-{port}-own-credential-marker'.encode() for family in (2, 10)
                   for protocol, port in [('udp', 53), ('udp', 8080), ('tcp', 443)]]
        markers += [b'host-startup-marker', b'transferred-startup-marker']
        full = protected + ''.join(json.dumps({'kind': 'received', 'time_ns': 102_000_000_000,
            'data': base64.b64encode(marker).decode()}) + '\n' for marker in markers)
        for name, value in [('boot-proof', proof), ('topology-before', initial),
                            ('inflight', {'positive': {'status': 200, 'started_ns': 1, 'finished_ns': 2},
                                          'denied': {'status': None, 'started_ns': 1, 'finished_ns': 2}}),
                            ('mutation-inflight', {'status': 200})]:
            Path(directory, name + '.json').write_text(json.dumps(value))
        Path(directory, 'protected-receipts.jsonl').write_text(protected)
        Path(directory, 'external-receipts.jsonl').write_text(full)
        Path(directory, 'broker-receipts.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in broker))
        return proof, broker

    def test_recomputes_delivery_bound_from_actual_handler_receipts(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            proof, broker = self.fixture(directory)
            self.assertTrue(boot_proof.verify_bundle(directory)['complete'])
            broker.append({'phase': broker[0]['phase'], 'time_ns': proof['events'][0]['event_time_ns'] + 2_000_000_001})
            Path(directory, 'broker-receipts.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in broker))
            with self.assertRaisesRegex(AssertionError, 'Actual handler committed'):
                boot_proof.verify_bundle(directory)

    def test_rejects_a_missing_event_even_when_complete_is_true(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            proof, _ = self.fixture(directory)
            proof['events'].pop()
            Path(directory, 'boot-proof.json').write_text(json.dumps(proof))
            with self.assertRaises(AssertionError):
                boot_proof.verify_bundle(directory)


    def test_rejects_stopped_poller_and_unrestarted_process(self):
        import json
        import tempfile
        for change in ('stopped-poller', 'unchanged-process'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                proof, _ = self.fixture(directory)
                event = proof['events'][0]
                if change == 'stopped-poller':
                    event['stream_after']['attempts'] = event['stream_before']['attempts']
                else:
                    event['process_after'] = event['process_before']
                Path(directory, 'boot-proof.json').write_text(json.dumps(proof))
                with self.assertRaises(AssertionError):
                    boot_proof.verify_bundle(directory)


    def test_rejects_unsupported_fresh_receipt_claim(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            proof, broker = self.fixture(directory)
            broker[0]['time_ns'] = proof['events'][0]['event_time_ns'] - 3_000_000_000
            Path(directory, 'broker-receipts.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in broker))
            with self.assertRaisesRegex(AssertionError, 'no actual handler evidence'):
                boot_proof.verify_bundle(directory)
