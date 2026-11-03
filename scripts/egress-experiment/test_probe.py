"""Harness checks: no namespace privilege or external network required."""
import socket
import unittest
import probe


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.receiver = probe.Receiver('127.0.0.1')
        self.broker = probe.Broker(self.receiver.port)
        self.a, a_server = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.b, b_server = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.broker.attach('A', a_server)
        self.broker.attach('B', b_server)
        self.broker.start()

    def tearDown(self):
        self.broker.close()
        self.a.close()
        self.b.close()
        self.receiver.close()

    def send(self, channel, token, **values):
        channel.settimeout(1)
        channel.send(probe.json.dumps({'token': token, **values}).encode())
        return probe.json.loads(channel.recv(4096))

    def test_peer_identity_cannot_be_replaced_by_request_fields(self):
        self.broker.policy(['A'])
        self.assertFalse(self.send(self.b, 'denied-b', identity='A', generation=1)['admitted'])
        self.assertFalse(self.receiver.saw('denied-b'))
        self.assertTrue(self.send(self.a, 'allowed-a')['admitted'])
        self.assertTrue(self.receiver.saw('allowed-a'))
        self.broker.policy(['B'])
        self.assertTrue(self.send(self.b, 'allowed-b')['admitted'])
        self.assertTrue(self.receiver.saw('allowed-b'))

    def test_revocation_closes_the_observed_stream_and_blocks_new_payload(self):
        self.broker.policy(['A'])
        self.send(self.a, 'before-revoke')
        self.assertTrue(self.receiver.saw('before-revoke'))
        self.broker.policy([])
        self.assertTrue(self.receiver.saw('before-revoke', timeout=1, closed=True))
        self.assertFalse(self.send(self.a, 'after-revoke')['admitted'])
        self.assertFalse(self.receiver.saw('after-revoke'))

    def test_old_channel_does_not_acquire_new_generation(self):
        self.broker.policy(['A'])
        self.send(self.a, 'old-generation')
        self.assertTrue(self.receiver.saw('old-generation'))
        self.broker.policy(['A'], rotate=True)
        self.assertFalse(self.send(self.a, 'forged-generation', generation=2)['admitted'])
        self.assertFalse(self.receiver.saw('forged-generation'))
        self.assertTrue(self.receiver.saw('old-generation', closed=True))

    def test_outage_and_policy_reset_do_not_restore_a_grant(self):
        self.broker.policy(['A'], available=False)
        self.assertFalse(self.send(self.a, 'outage')['admitted'])
        self.broker.policy([], rotate=True)
        self.assertFalse(self.send(self.a, 'reset')['admitted'])
        self.assertFalse(self.receiver.saw('outage'))
        self.assertFalse(self.receiver.saw('reset'))

    def test_observer_distinguishes_sent_data_from_absence(self):
        self.assertFalse(self.receiver.saw('not-sent', timeout=0.01))
        probe.transmit('127.0.0.1', self.receiver.port, 'observed')
        self.assertTrue(self.receiver.saw('observed'))
        self.assertTrue(self.receiver.saw('observed', closed=True))


if __name__ == '__main__':
    unittest.main()
