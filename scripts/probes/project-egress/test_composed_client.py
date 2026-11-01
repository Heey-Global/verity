"""Negative observation must finish the pinned netstack's queued resolution."""
import errno
from pathlib import Path
import runpy
import socket
import unittest
from unittest.mock import MagicMock, patch

SOURCE = Path(__file__).with_name('composed-client.py')


class ComposedClientTests(unittest.TestCase):
    def probe(self, phase, expectation, error):
        channel = MagicMock()
        channel.__enter__.return_value = channel
        channel.connect.side_effect = error
        with patch('socket.socket', return_value=channel), patch('sys.argv', [str(SOURCE), '11.77.106.2', phase, expectation]):
            runpy.run_path(str(SOURCE), run_name='__main__')
        return channel

    def test_initial_denial_requires_terminal_resolution_failure(self):
        channel = self.probe('before-admission-0', 'negative', OSError(errno.EHOSTUNREACH, 'No route'))
        channel.settimeout.assert_called_once_with(4)
        for error in [TimeoutError('timed out'), OSError(errno.ECONNREFUSED, 'Refused')]:
            with self.subTest(error=error), self.assertRaisesRegex(RuntimeError, 'neighbor resolution'):
                self.probe('before-admission-1', 'negative', error)

    def test_positive_and_later_denials_keep_short_connection_bound(self):
        channel = self.probe('lease-expired-0', 'negative', TimeoutError('timed out'))
        channel.settimeout.assert_called_once_with(0.4)
        with self.assertRaises(TimeoutError):
            self.probe('admitted-0', 'positive', TimeoutError('timed out'))
