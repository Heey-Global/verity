"""Host admission contract tests; these do not substitute for native BPF proof."""
import importlib.util
import ctypes
import json
import io
import os
import struct
from pathlib import Path
import tempfile
import unittest
import unittest.mock
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py'
spec = importlib.util.spec_from_file_location('deadline_host', source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


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
        self.refresh = self.enter(patch.object(host, 'neighbor_refresh', return_value=[b'probe']))
        self.send = self.enter(patch.object(host, 'send_neighbor_refresh'))

    def arm(self):
        return host.execute({'operation': 'arm', 'binding': self.binding, 'lease': self.lease})

    def test_delayed_commit_preserves_expired_absolute_value(self):
        self.assertEqual(self.arm()['bootDeadlineNs'], '1000000020')
        self.assertEqual([c.args[-1] for c in self.write.call_args_list], [0, 1000000020])

    def test_neighbor_refresh_follows_the_armed_kernel_deadline_on_the_bound_veth(self):
        order = []
        self.write.side_effect = lambda *args: order.append(('write', args[-1]))
        self.send.side_effect = lambda *args: order.append(('send',) + args)
        self.arm()
        self.assertEqual(order, [('write', 0), ('write', 1000000020), ('send', 'vtest', [b'probe'])])

    def test_neighbor_refresh_failure_keeps_the_decided_lease(self):
        self.send.side_effect = OSError('transmit failed')
        with patch.object(host.sys, 'stderr', io.StringIO()):
            self.assertEqual(self.arm()['state'], 'armed')
        self.assertEqual(self.write.call_args.args[-1], 1000000020)

    def test_invalid_refresh_facts_fail_before_any_kernel_admission(self):
        self.refresh.side_effect = ValueError('Invalid inspected neighbor gateway')
        with self.assertRaisesRegex(ValueError, 'neighbor gateway'):
            self.arm()
        self.assertEqual([c.args[-1] for c in self.write.call_args_list], [0])
        self.send.assert_not_called()

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
        self.network = {'Id': self.binding['networkId'], 'Containers': {identity: {'MacAddress': net['MacAddress'],
                            'IPv4Address': net['IPAddress'] + '/24'}
                        for identity, net in ((self.binding['containerId'], self.sandbox),
                                              (self.registration['containerId'], self.relay))}}
        def daemon(*args):
            if args[1] == 'network':
                return json.dumps([self.network])
            return json.dumps([{'Id': identity, 'NetworkSettings': {'Networks': {'project':
                self.sandbox if identity == self.binding['containerId'] else self.relay}}}
                for identity in args[3:]])
        self.enterContext(patch.object(host, 'run', side_effect=daemon))
        self.inspector = self.enterContext(patch.object(host, 'endpoint', side_effect=lambda binding, facts=None:
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


class InspectionFactsTests(unittest.TestCase):
    def setUp(self):
        self.binding = dict(zip(host.BINDING_FIELDS, ['project', 'generation', 'a' * 64,
                            'b' * 64, 'c' * 64, 've-test', '172.30.106.2', 'fd42:feed::2']))
        self.registration = {'containerId': 'd' * 64, 'endpointId': 'e' * 64, 'codex': False}
        self.containers = []
        self.links = []
        for index, identity, endpoint, address, address6, mac in (
            (5, self.binding['containerId'], self.binding['endpointId'], '172.30.106.2', 'fd42:feed::2', '02:01:02:03:04:05'),
            (6, self.registration['containerId'], self.registration['endpointId'], '172.30.106.3', 'fd42:feed::3', '02:06:07:08:09:0a')):
            self.containers.append({'Id': identity, 'State': {'Running': True}, 'NetworkSettings': {
                'SandboxKey': '/var/run/docker/netns/ns' + str(index), 'Networks': {'project': {
                    'NetworkID': self.binding['networkId'], 'EndpointID': endpoint, 'IPAddress': address,
                    'GlobalIPv6Address': address6, 'MacAddress': mac}}}})
            self.links.append({'ifindex': index, 'ifname': 'veth' + str(index), 'linkinfo': {'info_kind': 'veth'}})
        self.network = {'Id': self.binding['networkId'], 'Driver': 'bridge',
            'Options': {'com.docker.network.bridge.name': 've-test'},
            'Containers': {container['Id']: {'MacAddress': net['MacAddress'], 'IPv4Address': net['IPAddress'] + '/24'}
                for container in self.containers for net in container['NetworkSettings']['Networks'].values()}}
        def run(*args):
            if args[0] == '/usr/bin/docker':
                if args[1] == 'network': return json.dumps([self.network])
                return json.dumps([container for container in self.containers if container['Id'] in args[3:]])
            if args[0] == '/sbin/ip': return json.dumps(self.links)
            if args[0] == '/usr/bin/nsenter':
                index = int(args[1][-1])
                return json.dumps([{'ifname': 'eth0', 'ifindex': index + 10, 'link_index': index,
                    'address': self.containers[index - 5]['NetworkSettings']['Networks']['project']['MacAddress']}])
            raise AssertionError(args)
        self.run = self.enterContext(patch.object(host, 'run', side_effect=run))
        self.enterContext(patch.object(Path, 'read_text', lambda path: str(int(path.parent.name[4:]) + 10)))
        self.enterContext(patch.object(Path, 'resolve', lambda path: Path('/sys/class/net/ve-test')))

    def test_one_phase_batches_exact_containers_and_reuses_each_inventory(self):
        facts = host.InspectionFacts(self.binding, self.registration['containerId'])
        peer = host.endpoint(self.binding, facts)
        host.relay_policy(self.binding, peer, self.registration, facts)
        self.assertEqual(peer, {'device': 'veth5', 'index': 5})
        calls = [call.args for call in self.run.call_args_list]
        self.assertEqual(calls.count(('/usr/bin/docker', 'container', 'inspect', self.binding['containerId'], self.registration['containerId'])), 1)
        self.assertEqual(calls.count(('/usr/bin/docker', 'network', 'inspect', self.binding['networkId'])), 1)
        self.assertEqual(calls.count(('/sbin/ip', '-j', '-d', 'link', 'show')), 1)
        self.assertEqual(sum(call[0] == '/usr/bin/nsenter' for call in calls), 2)

    def test_next_phase_rejects_changed_endpoint_and_does_not_reuse_facts(self):
        peer = host.endpoint(self.binding)
        host.relay_policy(self.binding, peer, self.registration)
        self.containers[1]['NetworkSettings']['Networks']['project']['EndpointID'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'attachment changed'):
            host.relay_policy(self.binding, peer, self.registration)

    def test_next_phase_rejects_changed_host_inventory(self):
        peer = host.endpoint(self.binding)
        host.relay_policy(self.binding, peer, self.registration)
        self.links[1]['linkinfo']['info_kind'] = 'dummy'
        with self.assertRaisesRegex(ValueError, 'software veth'):
            host.relay_policy(self.binding, peer, self.registration)

    def test_aliased_missing_or_duplicate_batch_identity_is_rejected(self):
        for identities in ([self.containers[0]], [self.containers[0], self.containers[0]],
                           [{**self.containers[0], 'Id': 'f' * 64}, self.containers[1]]):
            with self.subTest(ids=[value['Id'] for value in identities]):
                with patch.object(host, 'run', return_value=json.dumps(identities)):
                    with self.assertRaisesRegex(ValueError, 'container identity mismatch'):
                        host.InspectionFacts(self.binding, self.registration['containerId']).container(self.binding['containerId'])

    def test_phase_rejects_foreign_container_and_network_queries(self):
        facts = host.InspectionFacts(self.binding, self.registration['containerId'])
        with self.assertRaisesRegex(ValueError, 'outside inspected phase'):
            facts.container('f' * 64)
        with self.assertRaisesRegex(ValueError, 'outside inspected phase'):
            facts.network('f' * 64)
        self.run.assert_not_called()


class NeighborRefreshTests(unittest.TestCase):
    def setUp(self):
        self.binding = dict(zip(host.BINDING_FIELDS, ['project', 'generation', 'a' * 64,
                            'b' * 64, 'c' * 64, 've-test', '172.30.106.2', 'fd42:feed::2']))
        self.net = {'MacAddress': '02:01:02:03:04:05', 'Gateway': '172.30.106.1', 'IPPrefixLen': 24,
                    'IPv6Gateway': 'fd42:feed::1', 'GlobalIPv6PrefixLen': 64}
        self.links = [{'ifindex': 3, 'ifname': 've-test', 'address': '02:aa:bb:cc:dd:ee'},
                      {'ifindex': 4, 'ifname': 'other', 'address': '02:11:11:11:11:11'}]
        self.facts = unittest.mock.Mock()
        self.facts.container.return_value = {'NetworkSettings': {'Networks': {'project': self.net}}}
        self.facts.host_links.return_value = self.links

    def frames(self):
        return host.neighbor_refresh(self.binding, self.facts)

    def test_arp_probe_carries_gateway_link_address_to_the_sandbox_only(self):
        frame = self.frames()[0]
        self.facts.container.assert_called_once_with('a' * 64)
        self.assertEqual(len(frame), 60)
        self.assertEqual(frame[:14], bytes.fromhex('020102030405' '02aabbccddee' '0806'))
        self.assertEqual(frame[14:42], bytes.fromhex('0001080006040001' '02aabbccddee' 'ac1e6a01'
                                                     '000000000000' 'ac1e6a02'))

    def test_ipv6_solicitation_is_valid_and_carries_source_link_address(self):
        import ipaddress
        frame = self.frames()[1]
        self.assertEqual(frame[:14], bytes.fromhex('020102030405' '02aabbccddee' '86dd'))
        header, icmp = frame[14:54], frame[54:]
        self.assertEqual(header[:8], bytes.fromhex('60000000' '0020' '3a' 'ff'))
        self.assertEqual(header[8:24], ipaddress.IPv6Address('fd42:feed::1').packed)
        self.assertEqual(header[24:40], ipaddress.IPv6Address('fd42:feed::2').packed)
        self.assertEqual((icmp[0], icmp[1]), (135, 0))
        self.assertEqual(icmp[8:24], ipaddress.IPv6Address('fd42:feed::2').packed)
        self.assertEqual(icmp[24:], bytes.fromhex('0101' '02aabbccddee'))
        data = header[8:40] + struct.pack('!I3xB', len(icmp), 58) + icmp
        total = sum(struct.unpack(f'!{len(data) // 2}H', data))
        while total >> 16:
            total = (total & 0xffff) + (total >> 16)
        self.assertEqual(total, 0xffff)

    def test_family_without_inspected_gateway_is_skipped(self):
        self.net['IPv6Gateway'] = ''
        self.assertEqual([frame[12:14] for frame in self.frames()], [b'\x08\x06'])

    def test_inconsistent_or_ambiguous_facts_are_rejected(self):
        for field, value in (('Gateway', '10.0.0.1'), ('Gateway', '172.30.106.2'),
                             ('IPv6Gateway', 'ff02::1'), ('MacAddress', '01:00:00:00:00:01'),
                             ('MacAddress', '00:00:00:00:00:00')):
            with self.subTest(field=field, value=value), patch.dict(self.net, {field: value}):
                with self.assertRaises(ValueError):
                    self.frames()
        self.links[1]['ifname'] = 've-test'
        with self.assertRaisesRegex(ValueError, 'inspected bridge'):
            self.frames()

    def test_transmission_is_bound_to_the_given_device(self):
        with patch.object(host.socket, 'socket') as factory:
            host.send_neighbor_refresh('vtest', [b'one', b'two'])
        factory.assert_called_once_with(host.socket.AF_PACKET, host.socket.SOCK_RAW, 0)
        channel = factory.return_value.__enter__.return_value
        channel.bind.assert_called_once_with(('vtest', 0))
        self.assertEqual([c.args[0] for c in channel.send.call_args_list], [b'one', b'two'])


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




if __name__ == '__main__':
    unittest.main()
