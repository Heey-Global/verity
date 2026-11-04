import importlib.util
from pathlib import Path
import json
import tempfile
import unittest
import unittest.mock

spec = importlib.util.spec_from_file_location('boot_vm', Path(__file__).with_name('boot-vm.py'))
boot_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot_vm)


class BootEvidenceTests(unittest.TestCase):
    def test_guest_upload_does_not_inherit_runner_ownership_or_writable_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'assets.tar'
            archive.write_bytes(b'fixture')
            vm = object.__new__(boot_vm.BootVM)
            vm.ssh = unittest.mock.Mock()
            vm.ssh_command = lambda command: ['fixture-ssh', command]
            with unittest.mock.patch.object(boot_vm.subprocess, 'run') as execute:
                vm.upload(archive)
            command = execute.call_args.args[0][-1]
            self.assertIn('tar --no-same-owner --no-same-permissions -xf -', command)
            self.assertIn('umask 022; exec tar', command)
            self.assertTrue(command.endswith("-C /opt/verity-fixture'"))

    def test_vm_disk_uses_the_runner_reclaimed_filesystem(self):
        with tempfile.TemporaryDirectory() as directory:
            with unittest.mock.patch.dict(boot_vm.os.environ, {'RUNNER_TEMP': directory}):
                vm = boot_vm.BootVM('base.qcow2', 'evidence')
            try:
                self.assertEqual(vm.work.parent, Path(directory))
                self.assertEqual(vm.disk_gib, 12)
            finally:
                vm.close()

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
                            ('mutation-inflight', {'status': 200, 'fencesRemoved': True,
                                                   'fencesRemovedNs': 101_000_000_001}),
                            ('mutation-clock', {'offsetNs': 0, 'uncertaintyNs': 1, 'removalNs': 101_000_000_001,
                                                'controlNs': 100_500_000_000, 'returnedNs': 101_500_000_000})]:
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

    def test_receipts_after_mutation_start_are_not_protected_evidence(self):
        import base64
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            proof, _ = self.fixture(directory)
            path = Path(directory, 'external-receipts.jsonl')
            # Continuous startup emitters reach the receiver as soon as removal returns,
            # before the external probes; that is mutation evidence, not a leak.
            leak = {'kind': 'received', 'time_ns': proof['mutation_started_ns'] + 1,
                    'data': base64.b64encode(b'host-startup-marker').decode()}
            path.write_text(path.read_text() + json.dumps(leak) + '\n')
            self.assertTrue(boot_proof.verify_bundle(directory)['complete'])
            leak['time_ns'] = proof['mutation_started_ns'] - 1
            lines = path.read_text().splitlines()
            path.write_text('\n'.join(lines[:-1] + [json.dumps(leak)]) + '\n')
            with self.assertRaisesRegex(AssertionError, 'Unauthorized external receipt'):
                boot_proof.verify_bundle(directory)

    def test_readmission_before_reported_removal_remains_protected(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            proof, _ = self.fixture(directory)
            # A start that covers the readmission phase instead of the removal is rejected.
            proof['mutation_started_ns'] -= 2_000_000_000
            Path(directory, 'boot-proof.json').write_text(json.dumps(proof))
            with self.assertRaisesRegex(AssertionError, 'reported fence removal'):
                boot_proof.verify_bundle(directory)
        with tempfile.TemporaryDirectory() as directory:
            proof, _ = self.fixture(directory)
            # Consistently moving the removal back over readmission leaves the control bracket.
            moved = 100_000_000_001
            proof['mutation_started_ns'] = moved - 1
            Path(directory, 'boot-proof.json').write_text(json.dumps(proof))
            for name in ('mutation-inflight', 'mutation-clock'):
                path = Path(directory, name + '.json')
                value = json.loads(path.read_text())
                value['fencesRemovedNs' if name == 'mutation-inflight' else 'removalNs'] = moved
                path.write_text(json.dumps(value))
            with self.assertRaisesRegex(AssertionError, 'outside its control'):
                boot_proof.verify_bundle(directory)

    def test_rejects_mutation_evidence_without_reported_fence_removal(self):
        import json
        import tempfile
        for value in ({'status': 200}, {'status': 200, 'fencesRemoved': False}):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                self.fixture(directory)
                Path(directory, 'mutation-inflight.json').write_text(json.dumps(value))
                with self.assertRaises(AssertionError):
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
                return True
            with patch.object(guest, 'ROOT', root), patch.object(guest, 'worktree', return_value=root), \
                    patch.object(guest, 'sandbox', return_value='sandbox'), \
                    patch.object(guest, 'descriptor', return_value={'projectId': 'project'}), \
                    patch.object(guest, 'api', return_value={'token': 'test'}), \
                    patch.object(guest, 'run', side_effect=run), patch.object(guest, 'positive'), \
                    patch.object(guest, 'remove_fences', side_effect=remove), \
                    contextlib.redirect_stdout(io.StringIO()) as printed:
                guest.inflight(phase)
            self.captured = printed.getvalue()
            return calls

    def test_requires_committed_canonical_overview_marker(self):
        self.exercise('positive')
        with self.assertRaisesRegex(AssertionError, 'Actual Server memory'):
            self.exercise('positive', marker=False)

    def test_removed_fence_control_repeats_readmission_before_completion(self):
        calls = self.exercise('removed-fences')
        self.assertEqual(calls[-1], ('remove-fences',))

    def test_inflight_reports_whether_it_removed_fences(self):
        import json
        for phase, removed in (('removed-fences', True), ('positive', False)):
            self.exercise(phase)
            reported = json.loads(self.captured)
            self.assertIs(reported['fencesRemoved'], removed)
            self.assertIs(type(reported['fencesRemovedNs']) is int, removed)


class FenceMutationOrderTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        spec = importlib.util.spec_from_file_location('mutation_proof', Path(__file__).with_name('boot-proof.py'))
        self.proof = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.proof)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.evidence = Path(directory.name)

    def vm(self, offset, inflight):
        from unittest.mock import Mock
        vm, self.calls = Mock(), []
        def ssh(command, **_):
            started = self.proof.time.time_ns()
            self.calls.append((command, started))
            if command == 'date +%s%N':
                return str(started + offset)
            if 'inflight' in command:
                # Readmission with intact fences precedes the guest-reported removal.
                self.proof.time.sleep(0.02)
                return json.dumps(inflight(self.proof.time.time_ns() + offset))
            return ''
        vm.ssh.side_effect = ssh
        return vm

    def test_window_opens_at_reported_removal_after_readmission(self):
        import json
        offset = 7_000_000_000
        result = lambda guest_now: {'status': 200, 'fencesRemoved': True, 'fencesRemovedNs': guest_now}
        vm = self.vm(offset, result)
        started, inflight = self.proof.remove_fences_mutation(vm, 'guest ', self.evidence, 0)
        self.assertEqual([command for command, _ in self.calls],
                         ['date +%s%N'] * 3 + ['guest inflight removed-fences', 'guest external'])
        self.assertEqual(vm.ssh.call_args_list[3].kwargs, {'timeout': 20})
        self.assertEqual(json.loads((self.evidence / 'mutation-inflight.json').read_text()), inflight)
        clock = json.loads((self.evidence / 'mutation-clock.json').read_text())
        self.assertEqual(started, self.proof.mutation_start(clock, inflight['fencesRemovedNs']))
        # The readmission phase of the control stays protected: the window opens after it.
        control_ns, external_ns = self.calls[3][1], self.calls[4][1]
        self.assertGreater(started, control_ns + 10_000_000)
        self.assertLess(started, external_ns)

    def test_rejects_overlap_with_protected_window_and_uncertain_clock(self):
        from unittest.mock import Mock
        result = lambda guest_now: {'status': 200, 'fencesRemoved': True, 'fencesRemovedNs': guest_now}
        with self.assertRaisesRegex(AssertionError, 'overlaps the protected window'):
            self.proof.remove_fences_mutation(self.vm(0, result), 'guest ', self.evidence, 1 << 62)
        ticks = iter(range(0, 60_000_000_000, 3_000_000_000))
        slow = Mock(side_effect=lambda command, **_: '0')
        with unittest.mock.patch.object(self.proof.time, 'time_ns', side_effect=lambda: next(ticks)):
            with self.assertRaisesRegex(AssertionError, 'too uncertain'):
                self.proof.guest_clock(Mock(ssh=slow))

    def test_clock_keeps_the_tightest_sample(self):
        from unittest.mock import Mock, patch
        times = iter([0, 400, 1000, 1010, 2000, 2200])
        vm = Mock(ssh=Mock(side_effect=['100', '1105', '2100']))
        with patch.object(self.proof.time, 'time_ns', side_effect=lambda: next(times)):
            clock = self.proof.guest_clock(vm)
        self.assertEqual(clock, {'offsetNs': 100, 'uncertaintyNs': 6})

    def test_rejects_missing_or_implausible_removal(self):
        import json
        for reported, message in ((lambda now: {'status': 200}, 'did not remove'),
                                  (lambda now: {'status': 200, 'fencesRemoved': False}, 'did not remove'),
                                  (lambda now: {'status': 200, 'fencesRemoved': True}, 'removal time'),
                                  (lambda now: {'status': 200, 'fencesRemoved': True,
                                                'fencesRemovedNs': now - 60_000_000_000}, 'outside its control')):
            (self.evidence / 'mutation-inflight.json').unlink(missing_ok=True)
            with self.subTest(message=message), self.assertRaisesRegex(AssertionError, message):
                self.proof.remove_fences_mutation(self.vm(0, reported), 'guest ', self.evidence, 0)
            # The failing in-flight result is retained as evidence before the verdict.
            retained = json.loads((self.evidence / 'mutation-inflight.json').read_text())
            expected = reported(0)
            if 'fencesRemovedNs' in expected:
                expected['fencesRemovedNs'] = retained['fencesRemovedNs']
            self.assertEqual(retained, expected)


class GuestCommandEvidenceTests(unittest.TestCase):
    def guest(self):
        spec = importlib.util.spec_from_file_location('evidence_guest', Path(__file__).with_name('boot-guest.py'))
        guest = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guest)
        return guest

    def test_uncaught_command_failure_output_reaches_ssh_evidence(self):
        import contextlib
        import io
        import subprocess
        from unittest.mock import patch
        guest = self.guest()
        error = subprocess.CalledProcessError(1, ['node'], output='Deadline hook identity changed')
        try:
            try:
                raise error
            except subprocess.CalledProcessError as failure:
                raise TimeoutError('wrapped') from failure
        except TimeoutError as wrapped:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), patch.object(guest.sys, '__excepthook__') as default:
                guest.report_failed_command(TimeoutError, wrapped, None)
        self.assertIn('Deadline hook identity changed', stderr.getvalue())
        default.assert_called_once()

    def test_fence_removal_reports_observed_kernel_state(self):
        import json
        from unittest.mock import patch
        guest = self.guest()
        tables = [{'table': {'family': family, 'name': name}} for family, name in
                  [('inet', 'verity_egress_a'), ('bridge', 'verity_egress_b'), ('inet', 'verity_start_a'),
                   ('bridge', 'verity_start_b'), ('inet', 'docker')]]
        for leftover_table, leftover_qdisc, expected in ((False, False, True), (True, False, False), (False, True, False)):
            listings = [tables, [tables[0]] if leftover_table else [tables[4]]]
            def run(*args):
                if args[:4] == ('nft', '--json', 'list', 'tables'):
                    return json.dumps({'nftables': listings.pop(0)})
                if args[:4] == ('tc', '-j', 'qdisc', 'show'):
                    return json.dumps([{'kind': 'clsact'}] if leftover_qdisc else [{'kind': 'noqueue'}])
                return ''
            with self.subTest(table=leftover_table, qdisc=leftover_qdisc), \
                    patch.object(guest, 'run', side_effect=run), \
                    patch.object(guest, 'snapshot', return_value={'packet': [{'raw': {'state': {'peer': {'device': 'veth1'}}}}]}), \
                    patch.object(guest.Path, 'read_text', return_value='verity-boot-probe'):
                self.assertIs(guest.remove_fences(), expected)

    def test_handled_command_failures_print_nothing(self):
        import contextlib
        import io
        import subprocess
        from unittest.mock import patch
        guest = self.guest()
        stderr = io.StringIO()
        error = subprocess.CalledProcessError(1, ['node'], output='expected denial')
        with patch.object(guest.subprocess, 'check_output', side_effect=error), contextlib.redirect_stderr(stderr):
            with self.assertRaises(subprocess.CalledProcessError):
                guest.run('node')
        self.assertEqual(stderr.getvalue(), '')


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


class ManagedStagingEvidenceTests(unittest.TestCase):
    def test_requires_real_safety_observations_without_claiming_production_acceptance(self):
        evidence = {'version': 1, 'scope': 'native-managed-staging-only',
                    'productionAccepted': False, 'directAuthorityConfigured': False,
                    'keyPreserved': True, 'dockerProcessPreserved': True,
                    'firewallTablesPreserved': True, 'activeUnitsPreserved': True,
                    'repeatedPreparationStable': True, 'releaseManifest': {
                        name: 'a' * 64 for name in ('node', 'project-egress-host-main.mjs',
                            'project-egress-deadline.bpf.o', 'project-egress-renew.bpf.o')},
                    'nativeCandidate': {'version': 1, 'scope': 'native-profile-candidate',
                        'accepted': False, 'blockers': [], 'evidenceMissing': ['signed-managed-updater'],
                        'artifacts': {name: 'a' * 64 for name in ('node', 'project-egress-host-main.mjs',
                            'project-egress-deadline.bpf.o', 'project-egress-renew.bpf.o')}}}
        boot_proof.verify_managed_staging(evidence)
        for key in evidence:
            if key == 'releaseManifest':
                continue
            changed = dict(evidence)
            del changed[key]
            with self.subTest(missing=key), self.assertRaises((AssertionError, KeyError)):
                boot_proof.verify_managed_staging(changed)
        for key in ('productionAccepted', 'directAuthorityConfigured'):
            with self.subTest(claim=key), self.assertRaises(AssertionError):
                boot_proof.verify_managed_staging({**evidence, key: True})

    def test_candidate_metadata_cannot_replace_acceptance_or_drift_from_release(self):
        artifacts = {name: 'a' * 64 for name in ('node', 'project-egress-host-main.mjs',
            'project-egress-deadline.bpf.o', 'project-egress-renew.bpf.o')}
        evidence = {'version': 1, 'scope': 'native-managed-staging-only',
                    'productionAccepted': False, 'directAuthorityConfigured': False,
                    'keyPreserved': True, 'dockerProcessPreserved': True,
                    'firewallTablesPreserved': True, 'activeUnitsPreserved': True,
                    'repeatedPreparationStable': True, 'releaseManifest': artifacts,
                    'nativeCandidate': {'version': 1, 'scope': 'native-profile-candidate',
                        'accepted': False, 'blockers': [], 'evidenceMissing': ['signed-managed-updater'],
                        'artifacts': dict(artifacts)}}
        boot_proof.verify_managed_staging(evidence)
        for field, replacement in [('accepted', True), ('evidenceMissing', []),
                                   ('artifacts', {**artifacts, 'node': 'b' * 64})]:
            changed = {**evidence, 'nativeCandidate': {**evidence['nativeCandidate'], field: replacement}}
            with self.subTest(field=field), self.assertRaises(AssertionError):
                boot_proof.verify_managed_staging(changed)
