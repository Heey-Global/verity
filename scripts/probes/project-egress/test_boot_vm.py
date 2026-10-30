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
