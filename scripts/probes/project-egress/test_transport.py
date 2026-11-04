import selectors
import socket
import subprocess
import sys
import threading
import unittest
from pathlib import Path

CLIENT = Path(__file__).with_name('transport-client.py')


class TransportClientTests(unittest.TestCase):
    def setUp(self):
        self.listeners = []
        self.selector = selectors.DefaultSelector()
        self.done = threading.Event()
        self.wrong = False
        for port in (8080, 8443, 8444):
            listener = socket.socket()
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.2', port))
            listener.listen(4)
            self.listeners.append(listener)
            self.selector.register(listener, selectors.EVENT_READ, port)
        self.worker = threading.Thread(target=self.receive)
        self.worker.start()

    def receive(self):
        while not self.done.is_set():
            for key, _ in self.selector.select(0.05):
                channel, _ = key.fileobj.accept()
                channel.settimeout(1)
                try:
                    request = channel.recv(4096)
                    if request:
                        reply = {8080: b'project-bound-fixture', 8443: b'claude.sock', 8444: b'codex.sock'}[key.data]
                        channel.sendall(b'wrong-receiver' if self.wrong else reply)
                except OSError:
                    pass
                finally:
                    channel.close()

    def tearDown(self):
        self.done.set()
        self.worker.join(timeout=2)
        self.selector.close()
        for listener in self.listeners:
            listener.close()

    def run_client(self, *arguments):
        return subprocess.run([sys.executable, str(CLIENT), '127.0.0.2', *arguments], capture_output=True, timeout=10)

    def test_requires_all_three_real_receivers(self):
        result = self.run_client('positive')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'transport-positive', result.stdout)

    def test_rejects_wrong_receiver_reply(self):
        self.wrong = True
        self.assertNotEqual(self.run_client('positive').returncode, 0)

    def test_negative_control_fails_when_connection_succeeds(self):
        self.assertNotEqual(self.run_client('negative', '8080').returncode, 0)


class TransportReceiverTests(unittest.TestCase):
    def test_received_bytes_survive_reply_failure(self):
        import importlib.util
        from unittest.mock import Mock
        path = Path(__file__).with_name('transport-receiver.py')
        spec = importlib.util.spec_from_file_location('transport_receiver', path)
        receiver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(receiver)
        channel = Mock()
        channel.recv.return_value = b'external-delivered'
        channel.sendall.side_effect = BrokenPipeError('peer closed')
        self.assertEqual(receiver.receive_tcp(channel), b'external-delivered')
        channel.close.assert_called_once()


class RetainedStreamTests(unittest.TestCase):
    def test_reset_keeps_attempting_original_sockets_and_publishes_heartbeat(self):
        import runpy
        from unittest.mock import Mock, mock_open, patch

        class StopLoop(Exception):
            pass

        broker, claude, codex = Mock(), Mock(), Mock()
        broker.recv.side_effect = [ConnectionResetError('revoked'), b'']
        claude.sendall.side_effect = BrokenPipeError('revoked')
        files = mock_open()
        with (patch.object(sys, 'argv', [str(CLIENT), '127.0.0.2', 'stream', 'reset']),
              patch('socket.create_connection', side_effect=[broker, claude, codex]) as connect,
              patch('select.select', return_value=([broker], [], [])),
              patch('builtins.open', files),
              patch('os.replace') as replace,
              patch('time.sleep', side_effect=[None, StopLoop])):
            with self.assertRaises(StopLoop):
                runpy.run_path(str(CLIENT), run_name='__main__')
        # Revocation must not kill the witness or turn it into a fresh connection.
        self.assertEqual(connect.call_count, 3)
        self.assertEqual(claude.sendall.call_count, 2)
        self.assertEqual(codex.sendall.call_count, 2)
        self.assertEqual(replace.call_count, 2)
        replace.assert_called_with('/work/stream-alive-reset.tmp', '/work/stream-alive-reset')
