import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import unittest


class StartupEmitterTests(unittest.TestCase):
    def test_inherited_and_transferred_descriptors_reach_real_receiver(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(('127.0.0.1', 0))
            receiver.settimeout(0.2)
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).with_name('startup-emitter.py')),
                 '127.0.0.1', str(receiver.getsockname()[1])],
                stdout=subprocess.DEVNULL, start_new_session=True,
            )
            try:
                observed = set()
                deadline = time.monotonic() + 3
                while len(observed) < 2 and time.monotonic() < deadline:
                    try:
                        observed.add(receiver.recv(1024))
                    except TimeoutError:
                        pass
                self.assertEqual(observed, {
                    b'host-startup-marker', b'transferred-startup-marker',
                })
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=3)
