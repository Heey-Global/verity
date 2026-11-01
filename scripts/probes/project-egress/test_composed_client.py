"""Initial denial must finish neighbor resolution before authority can change."""
import errno
from pathlib import Path
import runpy
import socket
import unittest
from unittest.mock import MagicMock, patch


class InitialDenialTests(unittest.TestCase):
    def run_client(self, error, expectation='negative', phase='before-admission-0'):
        channel = MagicMock()
        channel.__enter__.return_value = channel
        channel.connect.side_effect = error
        with patch('socket.socket', return_value=channel), patch('sys.argv', [
                'composed-client.py', '11.77.106.2', phase, expectation]):
            runpy.run_path(str(Path(__file__).with_name('composed-client.py')))
        return channel

    def test_requires_terminal_unreachable_instead_of_application_timeout(self):
        channel = self.run_client(OSError(errno.EHOSTUNREACH, 'unreachable'))
        channel.settimeout.assert_called_once_with(4)
        with self.assertRaisesRegex(RuntimeError, 'finish neighbor resolution'):
            self.run_client(TimeoutError('application deadline'))
        with self.assertRaisesRegex(RuntimeError, 'finish neighbor resolution'):
            self.run_client(OSError(errno.ECONNREFUSED, 'refused'))

    def test_positive_control_still_fails_on_timeout(self):
        with self.assertRaises(TimeoutError):
            self.run_client(TimeoutError('application deadline'), 'positive', 'admitted-0')


if __name__ == '__main__':
    unittest.main()
