"""Host admission contract tests; these do not substitute for native BPF proof."""
import importlib.util
import ctypes
import http.client
import json
import os
import struct
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py'
spec = importlib.util.spec_from_file_location('deadline_host', source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


real_endpoint = host.endpoint

class DeadlineHostTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.binding = dict(zip(host.BINDING_FIELDS, ['project', 'generation', 'a' * 64,
                            'b' * 64, 'c' * 64, 've-test', '172.30.106.2', 'fd42:feed::2']))
        self.key = host.binding_key(self.binding)
        self.peer = {'device': 'vtest', 'index': 5}
        self.path = self.root / (self.key + '.json')
        host.save(self.path, {'binding': self.binding, 'peer': self.peer, 'bootId': 'boot',
                             'revision': 1, 'program': 7, 'invalidBeforeNs': '10', 'lastCapturedNs': '0',
                             'authorityExpiresAt': None, 'expiredAuthorities': [], 'uncertainExpiry': False,
                             'seenAuthorities': [None], 'authorityBootDeadlines': {}, 'nftAuthorities': [None]})
        self.lease = {'bootId': 'boot', 'binding': self.key, 'revision': 1, 'nonce': 'd' * 32,
                      'capturedBootNs': '20', 'bootDeadlineNs': '1000000020', 'authorityExpiresAt': None,
                      'authorityBootDeadlines': {}}
        self.enter = self.enterContext
        original_lstat = Path.lstat
        registration = self.path
        def registered_lstat(path, *args, **kwargs):
            value = original_lstat(path, *args, **kwargs)
            if path == registration:
                fields = list(value)
                fields[4] = 0  # Model a trusted root-owned registration without requiring root tests.
                return os.stat_result(fields)
            return value
        self.enter(patch.object(Path, 'lstat', registered_lstat))
        self.enter(patch.object(host, 'STATE', self.root))
        self.enter(patch.object(host, 'clocks', return_value={
            'bootId': 'boot', 'bootBeforeNs': '2000000000', 'bootAfterNs': '2000000001', 'realNs': '1'}))
        self.enter(patch.object(host, 'endpoint', return_value=self.peer))
        self.enter(patch.object(host, 'attest'))
        self.listing = self.enter(patch.object(host, 'run', return_value=json.dumps({'nftables': [
            {'set': {'name': name}} for name in host.expiry_set_names(None)]})))
        self.write = self.enter(patch.object(host, 'write_deadline'))
        self.relay_write = self.enter(patch.object(host, 'write_relay'))

    def arm(self):
        return host.execute({'operation': 'arm', 'binding': self.binding, 'lease': self.lease})

    def test_delayed_commit_preserves_expired_absolute_value(self):
        self.assertEqual(self.arm()['bootDeadlineNs'], '1000000020')
        self.assertEqual([c.args[-1] for c in self.write.call_args_list], [0, 1000000020])

    def test_replayed_admission_starts_denied_and_cannot_rearm(self):
        self.arm()
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_revoke_invalidates_previously_captured_admission(self):
        host.execute({'operation': 'revoke', 'binding': self.binding})
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)
        self.assertEqual(json.loads(self.path.read_text())['invalidBeforeNs'], '2000000001')

    def test_only_exact_staged_admission_survives_its_own_revoke(self):
        host.execute({'operation': 'revoke', 'binding': self.binding, 'lease': self.lease})
        altered = dict(self.lease)
        self.lease['nonce'] = 'e' * 32
        with self.assertRaises(ValueError):
            self.arm()
        self.lease = altered
        self.assertEqual(self.arm()['bootDeadlineNs'], '1000000020')
        with self.assertRaises(ValueError):
            self.arm()

    def test_staged_admission_can_only_narrow_its_kernel_deadline(self):
        host.execute({'operation': 'revoke', 'binding': self.binding, 'lease': self.lease})
        self.lease['bootDeadlineNs'] = '500000020'
        self.assertEqual(self.arm()['bootDeadlineNs'], '500000020')
        with self.assertRaises(ValueError):
            self.arm()

    def test_staged_deadline_cannot_expand_even_within_controller_lifetime(self):
        self.lease['bootDeadlineNs'] = '500000020'
        host.execute({'operation': 'revoke', 'binding': self.binding, 'lease': self.lease})
        self.lease['bootDeadlineNs'] = '600000020'
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_delayed_executor_cannot_rebase_lifetime(self):
        self.lease['bootDeadlineNs'] = '3000000000'
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_kernel_overflow_stays_denied(self):
        self.lease['bootDeadlineNs'] = str(1 << 64)
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_observed_wall_expiry_survives_replacing_nft_tombstone(self):
        self.lease['authorityExpiresAt'] = 5000
        self.lease['authorityBootDeadlines'] = {'5000': '5000000020'}
        self.arm()
        a, b = host.expiry_set_names(5000)
        self.listing.return_value = json.dumps({'nftables': [
            {'set': {'name': a, 'elem': ['172.30.106.2']}}, {'set': {'name': b}},
            *[{'set': {'name': name}} for name in host.expiry_set_names(None)]]})
        host.execute({'operation': 'revoke', 'binding': self.binding})
        self.lease['capturedBootNs'] = '2000000002'
        self.lease['bootDeadlineNs'] = '2000000002'
        host.clocks.return_value = {'bootId': 'boot', 'bootBeforeNs': '2000000010',
                                   'bootAfterNs': '2000000011', 'realNs': '1'}
        with self.assertRaisesRegex(ValueError, 'already observed expired'):
            self.arm()
        self.assertEqual(json.loads(self.path.read_text())['expiredAuthorities'], [5000])

    def test_lost_tombstone_evidence_prevents_later_admission(self):
        self.listing.side_effect = OSError('nft failure')
        with self.assertRaises(OSError):
            host.execute({'operation': 'revoke', 'binding': self.binding})
        with self.assertRaisesRegex(ValueError, 'fresh generation'):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_quiet_expiry_cannot_be_rebased_after_wall_clock_rollback(self):
        self.lease.update({'authorityExpiresAt': 5000, 'authorityBootDeadlines': {'5000': '3000000000'}})
        self.arm()
        host.clocks.return_value = {'bootId': 'boot', 'bootBeforeNs': '4000000010',
                                   'bootAfterNs': '4000000011', 'realNs': '0'}
        self.lease.update({'capturedBootNs': '4000000000', 'bootDeadlineNs': '5000000000',
                           'authorityBootDeadlines': {'5000': '9000000000'}})
        with self.assertRaisesRegex(ValueError, 'Original authority clock budget exhausted'):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_renewal_preserves_first_authority_mapping_and_can_only_shorten_it(self):
        self.lease.update({'authorityExpiresAt': 5000, 'authorityBootDeadlines': {'5000': '3000000000'}})
        self.arm()
        self.lease.update({'capturedBootNs': '1000000000', 'bootDeadlineNs': '2000000000',
                           'authorityBootDeadlines': {'5000': '9000000000'}})
        self.arm()
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved['authorityBootDeadlines']['5000'], '3000000000')
        self.lease.update({'capturedBootNs': '1000000001', 'bootDeadlineNs': '2000000001',
                           'authorityBootDeadlines': {'5000': '2500000000'}})
        self.arm()
        self.assertEqual(json.loads(self.path.read_text())['authorityBootDeadlines']['5000'],
                         '2500000000')

    def test_overlapping_authority_keeps_its_original_budget_after_earlier_grant_is_removed(self):
        self.lease.update({'authorityExpiresAt': 5000,
                           'authorityBootDeadlines': {'5000': '3000000000', '7000': '5000000000'}})
        self.arm()
        host.clocks.return_value = {'bootId': 'boot', 'bootBeforeNs': '6000000010',
                                   'bootAfterNs': '6000000011', 'realNs': '0'}
        self.lease.update({'authorityExpiresAt': 7000, 'capturedBootNs': '6000000000',
                           'bootDeadlineNs': '7000000000',
                           'authorityBootDeadlines': {'7000': '13000000000'}})
        with self.assertRaisesRegex(ValueError, 'Original authority clock budget exhausted'):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_later_authority_tombstone_is_read_even_when_earlier_expiry_was_selected(self):
        self.lease.update({'authorityExpiresAt': 5000,
                           'authorityBootDeadlines': {'5000': '3000000000', '7000': '9000000000'}})
        self.arm()
        sets = [{'set': {'name': name, **({'elem': ['172.30.106.2']} if expiry == 7000 else {})}}
                for expiry in (None, 5000, 7000) for name in host.expiry_set_names(expiry)]
        self.listing.return_value = json.dumps({'nftables': sets})
        host.execute({'operation': 'revoke', 'binding': self.binding})
        self.assertEqual(json.loads(self.path.read_text())['expiredAuthorities'], [7000])
        self.lease.update({'authorityExpiresAt': 7000, 'capturedBootNs': '2000000002',
                           'bootDeadlineNs': '3000000002',
                           'authorityBootDeadlines': {'7000': '9000000000'}})
        host.clocks.return_value = {'bootId': 'boot', 'bootBeforeNs': '3000000010',
                                   'bootAfterNs': '3000000011', 'realNs': '0'}
        with self.assertRaisesRegex(ValueError, 'already observed expired'):
            self.arm()

    def configure_relay(self):
        return host.execute({'operation': 'configure-relay', 'binding': self.binding,
                             'relay': self.registration})

    def relay_fixture(self):
        self.registration = {'containerId': 'd' * 64, 'endpointId': 'e' * 64, 'codex': False}
        self.policy = struct.pack('<II', 1, 0) + bytes([172, 30, 106, 2, 172, 30, 106, 3]) + bytes.fromhex('02010203040502060708090a')
        return self.enter(patch.object(host, 'relay_policy', return_value=self.policy))

    def test_relay_configuration_clears_before_inspection_and_checks_after_write(self):
        inspector = self.relay_fixture()
        events = []
        self.relay_write.side_effect = lambda *args: events.append(('write', args[-1] if len(args) > 1 else None))
        inspector.side_effect = lambda *args: events.append(('inspect', None)) or self.policy
        self.assertEqual(self.configure_relay(), {'state': 'relay-configured'})
        self.assertEqual(events, [('write', None), ('inspect', None), ('write', self.policy), ('inspect', None)])
        self.assertEqual(json.loads(self.path.read_text())['relayRegistration'], self.registration)

    def test_relay_replacement_or_codex_change_requires_new_generation(self):
        self.relay_fixture()
        self.configure_relay()
        for name, value in (('containerId', 'f' * 64), ('endpointId', 'f' * 64), ('codex', True)):
            original = self.registration[name]
            self.registration[name] = value
            with self.assertRaisesRegex(ValueError, 'fresh generation'):
                self.configure_relay()
            self.assertEqual(len(self.relay_write.call_args.args), 1)
            self.registration[name] = original

    def test_relay_endpoint_changes_cannot_reuse_registration(self):
        inspector = self.relay_fixture()
        self.configure_relay()
        inspector.return_value = bytes(28)
        with self.assertRaisesRegex(ValueError, 'fresh generation'):
            self.configure_relay()
        self.assertEqual(len(self.relay_write.call_args.args), 1)

    def test_relay_change_during_installation_clears_policy(self):
        inspector = self.relay_fixture()
        inspector.side_effect = [self.policy, bytes(28)]
        with self.assertRaisesRegex(ValueError, 'during configuration'):
            self.configure_relay()
        self.assertEqual([len(c.args) for c in self.relay_write.call_args_list], [1, 2, 1])

    def test_relay_attestation_failure_after_installation_clears_policy(self):
        self.relay_fixture()
        host.attest.side_effect = [None, ValueError('changed hook')]
        with self.assertRaisesRegex(ValueError, 'changed hook'):
            self.configure_relay()
        self.assertEqual([len(c.args) for c in self.relay_write.call_args_list], [1, 2, 1])

    def test_relay_clear_preserves_immutable_registration(self):
        self.relay_fixture()
        self.configure_relay()
        state = json.loads(self.path.read_text())
        self.assertEqual(host.execute({'operation': 'clear-relay', 'binding': self.binding}),
                         {'state': 'relay-denied'})
        self.assertEqual(json.loads(self.path.read_text()), state)
        self.assertEqual(len(self.relay_write.call_args.args), 1)

    def test_direct_revoke_does_not_clear_system_transport(self):
        self.relay_fixture()
        self.configure_relay()
        self.relay_write.reset_mock()
        host.execute({'operation': 'revoke', 'binding': self.binding})
        self.relay_write.assert_not_called()
        self.assertEqual(self.write.call_args.args[-1], 0)

    def test_direct_arm_rechecks_registered_relay(self):
        inspector = self.relay_fixture()
        self.configure_relay()
        inspector.return_value = bytes(28)
        with self.assertRaisesRegex(ValueError, 'endpoints changed'):
            self.arm()
        self.assertEqual(self.write.call_args.args[-1], 0)
        self.assertEqual(len(self.relay_write.call_args.args), 1)

    def test_failed_relay_inspection_never_writes_enabled_policy(self):
        inspector = self.relay_fixture()
        inspector.side_effect = ValueError('foreign project')
        with self.assertRaisesRegex(ValueError, 'foreign project'):
            self.configure_relay()
        self.assertEqual([len(c.args) for c in self.relay_write.call_args_list], [1])


    def test_attestation_accepts_only_one_software_program_with_matching_headers(self):
        header = {'kind': 'bpf', 'pref': 1, 'chain': 0, 'protocol': 'all'}
        concrete = {**header, 'options': {'id': 7, 'not_in_hw': True,
                                            'direct-action': True, 'skip_hw': True}}
        host.attest_filters([header, concrete], 7)
        nested = {**concrete['options'], 'prog': {'id': 7}}
        del nested['id']
        host.attest_filters([header, {**concrete, 'options': nested}], 7)
        for options in ({**nested, 'prog': {'id': 8}}, {**nested, 'id': 8}):
            with self.assertRaises(ValueError):
                host.attest_filters([{**concrete, 'options': options}], 7)
        for option in ('direct-action', 'skip_hw'):
            missing = {**concrete['options']}
            del missing[option]
            with self.assertRaises(ValueError):
                host.attest_filters([{**concrete, 'options': missing}], 7)
        for filters in ([header], [concrete, concrete], [{**concrete, 'protocol': 'ip'}],
                        [{**concrete, 'options': {**concrete['options'], 'id': 8}}],
                        [{**concrete, 'options': {**concrete['options'], 'in_hw': True}}],
                        [{**concrete, 'options': {**concrete['options'], 'actions': [{'kind': 'mirred'}]}}]):
            with self.assertRaises(ValueError): host.attest_filters(filters, 7)

    def test_continuous_renewal_uses_kernel_handoff_without_zeroing_a_live_lease(self):
        self.arm()
        previous = self.lease['bootDeadlineNs']
        candidate = {**self.lease, 'capturedBootNs': '30', 'bootDeadlineNs': '1000000030'}
        self.write.reset_mock()
        with patch.object(host, 'renew_deadline') as renew:
            result = host.execute({'operation': 'renew', 'binding': self.binding,
                                   'lease': candidate, 'previousBootDeadlineNs': previous})
        self.assertEqual(result['bootDeadlineNs'], candidate['bootDeadlineNs'])
        renew.assert_called_once_with(host.PINS / self.key, 5, int(previous), int(candidate['bootDeadlineNs']))
        self.write.assert_not_called()

    def test_failed_kernel_continuity_is_an_error_not_a_userspace_rearm(self):
        self.arm()
        previous = self.lease['bootDeadlineNs']
        candidate = {**self.lease, 'capturedBootNs': '30', 'bootDeadlineNs': '1000000030'}
        self.write.reset_mock()
        with patch.object(host, 'renew_deadline', side_effect=ValueError('Kernel continuity expired')):
            with self.assertRaisesRegex(ValueError, 'continuity expired'):
                host.execute({'operation': 'renew', 'binding': self.binding,
                              'lease': candidate, 'previousBootDeadlineNs': previous})
        self.write.assert_not_called()

    def test_wrong_previous_deadline_cannot_select_continuous_handoff(self):
        self.arm()
        with patch.object(host, 'renew_deadline') as renew:
            with self.assertRaises(ValueError):
                host.execute({'operation': 'renew', 'binding': self.binding,
                              'lease': self.lease, 'previousBootDeadlineNs': '1000000000'})
        renew.assert_not_called()

    def test_preparation_loads_renewal_only_after_closing_access(self):
        def prepare(root):
            self.assertEqual(self.write.call_args.args[-1], 0)
            self.assertTrue(json.loads(self.path.read_text())['uncertainExpiry'])
        with patch.object(host, 'prepare_renewal', side_effect=prepare) as load:
            self.assertEqual(host.execute({'operation': 'prepare', 'binding': self.binding}), {'state': 'denied'})
            load.assert_called_once()

    def test_failed_preload_remains_denied_and_uncertain(self):
        with patch.object(host, 'prepare_renewal', side_effect=ValueError('load failed')):
            with self.assertRaisesRegex(ValueError, 'load failed'):
                host.execute({'operation': 'prepare', 'binding': self.binding})
        self.assertEqual(self.write.call_args.args[-1], 0)
        self.assertTrue(json.loads(self.path.read_text())['uncertainExpiry'])


class RelayIdentityTests(unittest.TestCase):
    def setUp(self):
        self.binding = dict(zip(host.BINDING_FIELDS, ['project', 'generation', 'a' * 64,
                            'b' * 64, 'c' * 64, 've-test', '172.30.106.2', 'fd42:feed::2']))
        self.registration = {'containerId': 'd' * 64, 'endpointId': 'e' * 64, 'codex': False}
        self.peer = {'device': 'vtest', 'index': 5}
        self.sandbox = {'MacAddress': '02:01:02:03:04:05', 'IPAddress': '172.30.106.2',
                        'GlobalIPv6Address': 'fd42:feed::2'}
        self.relay = {'MacAddress': '02:06:07:08:09:0a', 'IPAddress': '172.30.106.3',
                      'GlobalIPv6Address': 'fd42:feed::3'}
        self.network = {'Containers': {identity: {'MacAddress': net['MacAddress'],
                            'IPv4Address': net['IPAddress'] + '/24'}
                        for identity, net in ((self.binding['containerId'], self.sandbox),
                                              (self.registration['containerId'], self.relay))}}
        def daemon(*args):
            if args[1] == 'network':
                return json.dumps([self.network])
            net = self.sandbox if args[-1] == self.binding['containerId'] else self.relay
            return json.dumps([{'NetworkSettings': {'Networks': {'project': net}}}])
        self.enterContext(patch.object(host, 'run', side_effect=daemon))
        self.inspector = self.enterContext(patch.object(host, 'endpoint', side_effect=lambda binding, **_facts:
            self.peer if binding['containerId'] == self.binding['containerId'] else {'device': 'vrelay', 'index': 6}))

    def policy(self):
        return host.relay_policy(self.binding, self.peer, self.registration)

    def test_exact_policy_encoding_and_both_inspected_bindings(self):
        value = self.policy()
        self.assertEqual(value, struct.pack('<II', 1, 0) + bytes([172, 30, 106, 2, 172, 30, 106, 3])
                         + bytes.fromhex('02010203040502060708090a'))
        checked = self.inspector.call_args_list[1].args[0]
        self.assertEqual(checked, {**self.binding, 'containerId': self.registration['containerId'],
                         'endpointId': self.registration['endpointId'], 'ipv4': '172.30.106.3', 'ipv6': 'fd42:feed::3'})
        self.registration['codex'] = True
        self.assertEqual(struct.unpack('<II', self.policy()[:8]), (1, 1))

    def test_shared_daemon_snapshot_still_checks_both_actual_namespace_peers(self):
        self.network.update({'Id': self.binding['networkId'], 'Driver': 'bridge',
                             'Options': {'com.docker.network.bridge.name': self.binding['bridge']}})
        containers = {}
        for identity, net, endpoint, device in [
                (self.binding['containerId'], self.sandbox, self.binding['endpointId'], 'sandbox'),
                (self.registration['containerId'], self.relay, self.registration['endpointId'], 'relay')]:
            net.update({'NetworkID': self.binding['networkId'], 'EndpointID': endpoint})
            containers[identity] = {'Id': identity, 'State': {'Running': True},
                'NetworkSettings': {'Networks': {'project': net},
                                    'SandboxKey': '/var/run/docker/netns/' + device}}
        calls = []
        def daemon(*args):
            calls.append(args)
            if args[0] == '/usr/bin/docker':
                return json.dumps([self.network if args[1] == 'network' else containers[args[-1]]])
            if args[0] == '/usr/bin/nsenter':
                sandbox = args[1].endswith('/sandbox')
                return json.dumps([{'ifname': 'eth0', 'address': (self.sandbox if sandbox else self.relay)['MacAddress'],
                                    'ifindex': 2, 'link_index': 5 if sandbox else 6}])
            return json.dumps([{'ifindex': index, 'ifname': name, 'linkinfo': {'info_kind': 'veth'}}
                               for index, name in [(5, 'vtest'), (6, 'vrelay')]])
        original_read, original_resolve = Path.read_text, Path.resolve
        def read(path, *args, **kwargs):
            return '2' if str(path).startswith('/sys/class/net/') else original_read(path, *args, **kwargs)
        def resolve(path, *args, **kwargs):
            return Path('/sys/class/net/' + self.binding['bridge']) if path.name == 'master' else original_resolve(path, *args, **kwargs)
        with patch.object(host, 'endpoint', wraps=real_endpoint), patch.object(host, 'run', side_effect=daemon), \
                patch.object(Path, 'read_text', read), patch.object(Path, 'resolve', resolve):
            self.policy()
            self.assertEqual(sum(args[0] == '/usr/bin/docker' for args in calls), 3)
            for container, field, value in [(containers[self.binding['containerId']], 'Id', 'f' * 64),
                                            (self.relay, 'EndpointID', 'f' * 64)]:
                previous = container[field]
                container[field] = value
                with self.assertRaisesRegex(ValueError, 'identity mismatch|attachment changed'):
                    self.policy()
                container[field] = previous
            with patch.object(Path, 'read_text', lambda path: '99'):
                with self.assertRaisesRegex(ValueError, 'bridge peer changed'):
                    self.policy()

    def test_caller_cannot_supply_destinations_or_non_boolean_codex(self):
        for changed in ({**self.registration, 'ipv4': '1.1.1.1'},
                        {**self.registration, 'codex': 1},
                        {**self.registration, 'endpointId': '--help'},
                        {**self.registration, 'containerId': self.binding['containerId']}):
            with self.assertRaises(ValueError):
                host.relay_policy(self.binding, self.peer, changed)
        self.inspector.assert_not_called()

    def test_extra_or_missing_project_endpoint_is_rejected(self):
        self.network['Containers']['f' * 64] = {}
        with self.assertRaisesRegex(ValueError, 'registered project pair'):
            self.policy()
        del self.network['Containers']['f' * 64]
        del self.network['Containers'][self.registration['containerId']]
        with self.assertRaisesRegex(ValueError, 'registered project pair'):
            self.policy()

    def test_daemon_disagreement_and_invalid_hardware_are_rejected(self):
        for mac in ('02:01:02:03:04:05', '00:00:00:00:00:00', '03:06:07:08:09:0a', 'invalid'):
            self.relay['MacAddress'] = mac
            self.network['Containers'][self.registration['containerId']]['MacAddress'] = mac
            with self.assertRaises(ValueError):
                self.policy()
        self.relay['MacAddress'] = '02:06:07:08:09:0a'
        with self.assertRaisesRegex(ValueError, 'disagreement'):
            self.policy()

    def test_changed_veth_is_rejected(self):
        self.inspector.side_effect = None
        self.inspector.return_value = {'device': 'different', 'index': 9}
        with self.assertRaisesRegex(ValueError, 'interface changed'):
            self.policy()


class RelayMapWriterTests(unittest.TestCase):
    def test_enabled_and_disabled_map_values_use_the_kernel_layout(self):
        writes = []
        def syscall(command, attr):
            if command == 7:
                self.assertEqual(ctypes.string_at(attr.pathname), b'/pins/maps/relay_transport')
                return 42
            self.assertEqual(command, 2)
            self.assertEqual(attr.fd, 42)
            self.assertEqual(ctypes.c_uint32.from_address(attr.key).value, 0)
            writes.append(ctypes.string_at(attr.value, 28))
            return 0
        with patch.object(host, 'bpf', side_effect=syscall), patch.object(host.os, 'close') as close:
            host.write_relay(Path('/pins'), bytes(range(28)))
            host.write_relay(Path('/pins'))
        self.assertEqual(writes, [bytes(range(28)), bytes(28)])
        self.assertEqual([c.args for c in close.call_args_list], [(42,), (42,)])




class DockerInspectionTests(unittest.TestCase):
    def test_rejects_untrusted_identity_before_connecting(self):
        with patch.object(host, 'DockerInspectionSocket') as connect:
            for kind, identity in [('container', '../info'), ('exec', 'a' * 64)]:
                with self.assertRaises(ValueError):
                    host.docker_read(kind, identity)
            connect.assert_not_called()

    def test_trickling_cannot_restart_budget(self):
        with host.DockerInspectionSocket() as connection:
            with patch.object(host.time, 'monotonic', return_value=connection.deadline + 1), patch.object(host.socket.socket, 'recv_into', return_value=1) as read:
                with self.assertRaises(TimeoutError):
                    connection.recv_into(bytearray(1))
                read.assert_not_called()

    def test_read_keeps_fixed_endpoint_and_cli_shape(self):
        from unittest.mock import MagicMock
        connection = MagicMock()
        response = connection.getresponse.return_value
        response.status = 200
        response.read.return_value = b'{"Id":"current"}'
        with patch.object(http.client, 'HTTPConnection', return_value=connection), patch.object(host, 'DockerInspectionSocket') as sock:
            self.assertEqual(json.loads(host.docker_read('container', 'a' * 64)), [{'Id': 'current'}])
            sock.return_value.connect.assert_called_once_with('/var/run/docker.sock')
            connection.request.assert_called_once_with('GET', '/v1.52/containers/' + 'a' * 64 + '/json')
            connection.close.assert_called_once()

    def test_bad_daemon_response_fails_closed(self):
        from unittest.mock import MagicMock
        for status, body in [(404, b'{}'), (200, b'invalid'), (200, b'x' * (2 * 1024 * 1024 + 1))]:
            connection = MagicMock()
            connection.getresponse.return_value.status = status
            connection.getresponse.return_value.read.return_value = body
            with patch.object(http.client, 'HTTPConnection', return_value=connection), patch.object(host, 'DockerInspectionSocket'):
                with self.assertRaises(ValueError):
                    host.docker_read('network', 'b' * 64)
                connection.close.assert_called_once()


class ProgramIdentityTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(Path, 'read_text', return_value='prog_type: 3\nprog_id: 42\n'))

    def inspect(self, kind=3, identity=42, fail=False):
        def syscall(command, attr):
            if command == 7:
                self.assertTrue(ctypes.string_at(attr.pathname).endswith(b'/guard'))
                return 17
            self.assertEqual(command, 15)
            self.assertEqual(attr.fd, 17)
            self.assertEqual(attr.info_len, 8)
            if fail:
                raise OSError('inspection failed')
            info = host.ProgramInfo.from_address(attr.info)
            info.type, info.id = kind, identity
            return 0
        return syscall

    def test_reads_current_pinned_identity_without_external_process(self):
        with patch.object(host, 'bpf', side_effect=self.inspect()), patch.object(host.os, 'close') as close, patch.object(host, 'run') as external:
            self.assertEqual(host.program_identity(Path('/pins')), {'id': 42, 'type': 'sched_cls'})
            external.assert_not_called()
            close.assert_called_once_with(17)

    def test_wrong_type_missing_identity_and_failed_inspection_fail_closed(self):
        for kind, identity, fail in [(6, 42, False), (3, 0, False), (3, 42, True)]:
            with self.subTest(kind=kind, identity=identity, fail=fail), patch.object(host, 'bpf', side_effect=self.inspect(kind, identity, fail)), patch.object(Path, 'read_text', return_value=f'prog_type: {kind}\nprog_id: {identity}\n'), patch.object(host.os, 'close') as close:
                with self.assertRaises((ValueError, OSError)):
                    host.program_identity(Path('/pins'))
                close.assert_called_once_with(17)

    def test_map_descriptor_with_colliding_prefix_is_rejected(self):
        with patch.object(host, 'bpf', side_effect=self.inspect()), patch.object(Path, 'read_text', return_value='map_type: 3\nmap_id: 42\n'), patch.object(host.os, 'close') as close:
            with self.assertRaisesRegex(ValueError, 'not the inspected program'):
                host.program_identity(Path('/pins'))
            close.assert_called_once_with(17)

    def test_attestation_rejects_replaced_pinned_program(self):
        with patch.object(host, 'run', return_value='{"nftables":[]}'), patch.object(host, 'program_identity', return_value={'id': 99, 'type': 'sched_cls'}):
            with self.assertRaisesRegex(ValueError, 'identity changed'):
                host.attest(Path('/pins'), {'device': 'vtest'}, 42)


if __name__ == '__main__':
    unittest.main()
