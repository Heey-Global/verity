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



class BootstrapDenialTests(unittest.TestCase):
    def fixture(self):
        rows = []
        for family in ('inet', 'bridge'):
            base = {'family': family, 'table': 'verity_egress_boot'}
            rows.append({'table': {'family': family, 'name': base['table']}})
            for hook in ('forward', 'input'):
                rows.append({'chain': {**base, 'name': hook, 'type': 'filter', 'hook': hook,
                                       'prio': -220, 'policy': 'accept'}})
                keys = ('iifname', 'oifname') if family == 'inet' else ('ibrname', 'obrname')
                for key in keys[:1] if hook == 'input' else keys:
                    rows.append({'rule': {**base, 'chain': hook, 'expr': [
                        {'match': {'op': '==', 'left': {'meta': {'key': key}}, 'right': 'vep*'}},
                        {'counter': {'packets': 1, 'bytes': 60}}, {'drop': None}]}})
        # A stale table cannot bypass the earlier authoritative bootstrap denial.
        rows.append({'rule': {'family': 'inet', 'table': 'verity_start_old', 'chain': 'forward',
                              'expr': [{'mangle': {'key': {'ct': {'key': 'label'}}, 'value': 0}}]}})
        return {'nftables': rows}

    def test_requires_complete_bootstrap_denial_and_rejects_bypasses(self):
        import copy
        original = self.fixture()
        boot_proof.verify_boot_denial(original)
        for index, row in enumerate(original['nftables'][:-1]):
            altered = copy.deepcopy(original)
            del altered['nftables'][index]
            with self.subTest(index=index), self.assertRaises(AssertionError):
                boot_proof.verify_boot_denial(altered)
        for expr in ([{'accept': None}], [{'return': None}]):
            altered = copy.deepcopy(original)
            altered['nftables'][2]['rule']['expr'] = expr
            with self.assertRaises(AssertionError):
                boot_proof.verify_boot_denial(altered)
        altered = copy.deepcopy(original)
        altered['nftables'][1]['chain']['prio'] = 0
        with self.assertRaises(AssertionError):
            boot_proof.verify_boot_denial(altered)


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


def replace_topology(before, suffix):
    import copy
    import hashlib
    import json
    after = copy.deepcopy(before)
    binding = after['packet'][0]['raw']['state']['binding']
    old_generation = binding['generation']
    binding.update(generation='generation-' + suffix, networkId=suffix * 64,
                   endpointId=suffix * 64, containerId=suffix * 64)
    after['containers'][0]['id'] = binding['containerId']
    after['containers'][1]['id'] = suffix.upper() * 64
    after['packet'][0]['raw']['identity'] = hashlib.sha256(json.dumps(list(binding.values()), separators=(',', ':')).encode()).hexdigest()
    for row in after['registry']['records']:
        if row['binding']['generation'] == old_generation:
            row['retired'] = True
    after['registry']['records'].append({'binding': {'projectId': after['projectId'], 'generation': binding['generation']},
                                         'retired': False, 'containers': {str(i): row['id'] for i, row in enumerate(after['containers'])}})
    return after


class FullBundleTests(unittest.TestCase):
    def fixture(self, directory):
        import base64
        import copy
        import json
        initial = RetainedTopologyTests().fixture()
        import hashlib
        binding = dict(zip(('projectId', 'generation', 'containerId', 'networkId', 'endpointId', 'bridge', 'ipv4', 'ipv6'),
                           ['p', 'g', 'sandbox', 'b' * 64, 'c' * 64, 've-test', '172.30.1.2', 'fd42::2']))
        # The test topology uses the same wire identity structure as the raw helper evidence.
        binding['containerId'] = 'a' * 64
        initial['containers'][0]['id'] = binding['containerId']
        identity = hashlib.sha256(json.dumps(list(binding.values()), separators=(',', ':')).encode()).hexdigest()
        hooks = [{'kind': 'bpf', 'pref': 1, 'protocol': 'all', 'options': {'id': 42, 'direct-action': True, 'skip_hw': True}}]
        initial['packet'] = [{'raw': {'identity': identity, 'deadline_ns': '0', 'clocks': {'bootId': 'boot'},
                                    'state': {'binding': binding, 'program': 42, 'relayPolicy': '01', 'bootId': 'boot'}},
                              'program': {'id': 42, 'type': 'sched_cls'}, 'hooks': {'ingress': hooks, 'egress': hooks}}]
        initial['tables'] = [{'table': {'family': family, 'name': 'verity_start_test'}} for family in ('inet', 'bridge')]

        initial['containers'][0]['mounts'] = [{'Source': '/data/project', 'Destination': '/work'}, {'Source': '/data/knowledge', 'Destination': '/knowledge'}]
        initial['registry'] = {'records': [{'binding': {'projectId': 'p', 'generation': 'g'}, 'retired': False,
                                           'containers': {'sandbox': initial['containers'][0]['id'], 'relay': initial['containers'][1]['id']}}]}
        previous = initial
        facts = {'boot_id': '11111111-1111-1111-1111-111111111111', 'init': 'systemd', 'systemd': 259}
        events = []
        broker = []
        for name in ('controller-kill', 'docker-stop-start', 'docker-crash', 'reboot'):
            Path(directory, name + '-denied-rules.json').write_text(json.dumps(BootstrapDenialTests().fixture()))
        for index, name in enumerate(['controller-kill', 'server-kill', 'docker-stop-start', 'docker-crash', 'reboot']):
            when = (index + 1) * 10_000_000_000
            after = copy.deepcopy(facts)
            if name == 'reboot':
                after['boot_id'] = '22222222-2222-2222-2222-222222222222'
            topology = replace_topology(previous, str(index)) if name in ('docker-stop-start', 'docker-crash', 'reboot') else copy.deepcopy(previous)
            previous = topology
            events.append({'event': name, 'before': facts, 'after': after, 'event_time_ns': when,
                           'retained': topology, 'recovery_ns': 1,
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

    def test_replacement_requires_fresh_generation_retirement_and_preserved_data(self):
        import copy
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            self.fixture(directory)
            before = json.loads(Path(directory, 'topology-before.json').read_text())
            after = replace_topology(before, '9')
            boot_proof.verify_replacement(before, after)
            with self.assertRaises(AssertionError):
                boot_proof.verify_replacement(before, before)
            for mutation in ('generation', 'network', 'endpoint', 'retirement', 'data', 'image', 'running'):
                changed = copy.deepcopy(after)
                binding = changed['packet'][0]['raw']['state']['binding']
                old = before['packet'][0]['raw']['state']['binding']
                if mutation in ('generation', 'network', 'endpoint'):
                    key = {'generation': 'generation', 'network': 'networkId', 'endpoint': 'endpointId'}[mutation]
                    binding[key] = old[key]
                elif mutation == 'retirement':
                    changed['registry']['records'][0]['retired'] = False
                elif mutation == 'data':
                    changed['containers'][0]['mounts'][0]['Source'] = '/lost-data'
                elif mutation == 'image':
                    changed['containers'][0]['image'] = 'untrusted-image'
                else:
                    changed['containers'][0]['running'] = False
                with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                    boot_proof.verify_replacement(before, changed)

    def test_rejects_boot_evidence_without_both_kernel_hooks_and_nft_fences(self):
        import json
        import tempfile
        for change in ('missing-packet', 'wrong-hook', 'direct-admission', 'missing-nft'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                proof, _ = self.fixture(directory)
                snapshot = proof['events'][0]['retained']
                if change == 'missing-packet':
                    snapshot['packet'] = []
                elif change == 'wrong-hook':
                    snapshot['packet'][0]['hooks']['ingress'][0]['options']['id'] = 43
                elif change == 'direct-admission':
                    snapshot['packet'][0]['raw']['deadline_ns'] = '1000'
                else:
                    snapshot['tables'] = []
                Path(directory, 'boot-proof.json').write_text(json.dumps(proof))
                with self.assertRaises((AssertionError, ValueError)):
                    boot_proof.verify_bundle(directory)



class ActualMemoryPersistenceTests(unittest.TestCase):
    def exercise(self, phase, marker=True):
        import contextlib
        import io
        import json
        import tempfile
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('boot_guest', Path(__file__).with_name('boot-guest.py'))
        guest = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guest)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'config.json').write_text(json.dumps({'dataRoot': temp}))
            overview = root / 'knowledge' / 'project' / 'overview.md'
            overview.parent.mkdir(parents=True)
            overview.write_text(f'boot-inflight-{phase}' if marker else 'other memory')
            (root / f'.boot-inflight-{phase}-ready').touch()
            (root / f'.boot-inflight-{phase}-result').write_text(json.dumps({
                'started_ns': 1, 'finished_ns': 2, 'status': 200}))
            calls = []
            def run(*args):
                calls.append(args)
            def remove():
                self.assertEqual(calls[-1][-1], 'readmit')
                self.assertFalse((root / f'.boot-inflight-{phase}-finish').exists())
                calls.append(('remove-fences',))
            with patch.object(guest, 'ROOT', root), patch.object(guest, 'worktree', return_value=root), \
                    patch.object(guest, 'sandbox', return_value='sandbox'), \
                    patch.object(guest, 'descriptor', return_value={'projectId': 'project'}), \
                    patch.object(guest, 'api', return_value={'token': 'test'}), \
                    patch.object(guest, 'run', side_effect=run), patch.object(guest, 'positive'), \
                    patch.object(guest, 'remove_fences', side_effect=remove), contextlib.redirect_stdout(io.StringIO()):
                guest.inflight(phase)
            return calls

    def test_requires_committed_canonical_overview_marker(self):
        self.exercise('positive')
        with self.assertRaisesRegex(AssertionError, 'Actual Server memory'):
            self.exercise('positive', marker=False)

    def test_removed_fence_control_repeats_readmission_before_completion(self):
        calls = self.exercise('removed-fences')
        self.assertEqual(calls[-1], ('remove-fences',))


class ReplacementRecoveryTests(unittest.TestCase):
    def test_stopped_packet_generation_uses_authenticated_replacement(self):
        import json
        import tempfile
        from unittest.mock import Mock, patch
        spec = importlib.util.spec_from_file_location('replacement_guest', Path(__file__).with_name('boot-guest.py'))
        guest = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guest)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config.json').write_text(json.dumps({'dataRoot': directory}))
            (root / 'boot-retained-marker').write_text('retained actual project data')
            api = Mock(return_value={'token': 'disposable-token'})
            with patch.object(guest, 'ROOT', root), patch.object(guest, 'api', api), patch.object(guest, 'wait'), patch.object(guest, 'run') as run, patch.object(guest, 'descriptor', return_value={'projectId': 'p'}):
                guest.recover(replace=True)
            api.assert_any_call('/verity-control/projects/p/recreate-container', {'confirmWarnings': True}, token='disposable-token', timeout=180)
            run.assert_any_call('docker', 'start', 'verity-boot-registry')
            self.assertFalse(any('readmit' in call.args for call in run.call_args_list))


class ApiReadinessTests(unittest.TestCase):
    def test_http_failure_keeps_bounded_details_and_remains_retryable(self):
        import io
        import urllib.error
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location('api_guest', Path(__file__).with_name('boot-guest.py'))
        guest = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guest)
        error = urllib.error.HTTPError('http://127.0.0.1/healthz', 503, 'not ready', {}, io.BytesIO(b'{"error":"not ready"}'))
        with patch.object(guest.urllib.request, 'urlopen', side_effect=[error, io.BytesIO(b'{"ready":true}')]), patch.object(guest.time, 'sleep') as sleep:
            self.assertEqual(guest.wait(lambda: guest.api('/healthz')), {'ready': True})
            sleep.assert_called_once()
        error = urllib.error.HTTPError('http://127.0.0.1/action', 409, 'conflict', {}, io.BytesIO(b'conflict-detail'))
        with patch.object(guest.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaisesRegex(ValueError, '409.*conflict-detail'):
                guest.api('/action')
