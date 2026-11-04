"""Private helper framing and lifetime tests, independent of kernel admission proof."""
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py'
spec = importlib.util.spec_from_file_location('channel_host', source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class DeadlineChannelTests(unittest.TestCase):
    def exchange(self, frames):
        source = io.BytesIO(b''.join((json.dumps(v) + '\n').encode() for v in frames))
        sink = io.BytesIO()
        with tempfile.TemporaryFile() as held:
            host.serve(source, sink, held)
        return [{k: value for k, value in json.loads(v).items() if k not in ('startedBootNs', 'finishedBootNs')} for v in sink.getvalue().splitlines()]

    def test_fresh_execution_and_lock_per_operation(self):
        with patch.object(host, 'clocks', side_effect=[{'sample': 1}, {'sample': 2}]), patch.object(host.fcntl, 'flock') as lock:
            values = self.exchange([{'id': n, 'input': {'operation': 'clock'}} for n in [1, 2]])
        self.assertEqual(values, [{'id': 1, 'result': {'sample': 1}}, {'id': 2, 'result': {'sample': 2}}])
        self.assertEqual([v.args[1] for v in lock.call_args_list], [host.fcntl.LOCK_EX, host.fcntl.LOCK_UN] * 2)

    def test_semantic_refusal_releases_lock_and_allows_containment(self):
        with patch.object(host, 'execute', side_effect=[ValueError('denied'), {'state': 'denied'}]):
            values = self.exchange([{'id': 1, 'input': 'renew'}, {'id': 2, 'input': 'revoke'}])
        self.assertEqual(values, [{'id': 1, 'error': 'denied'}, {'id': 2, 'result': {'state': 'denied'}}])

    def test_rejects_malformed_duplicate_or_unbounded_frames_before_execution(self):
        for data in [b'{}\n', b'{"id":true,"input":{}}\n', b'{"id":0,"input":{}}\n',
                     b'{"id":1,"input":{}}', b'x' * 65537,
                     b'{"id":1,"input":{}}\n{"id":1,"input":{}}\n']:
            with self.subTest(data=data[:60]), tempfile.TemporaryFile() as held, patch.object(host, 'execute', return_value={}) as execute:
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    host.serve(io.BytesIO(data), io.BytesIO(), held)
                self.assertLessEqual(execute.call_count, 1 if data.count(b'\n') == 2 else 0)

    def test_response_limit(self):
        with patch.object(host, 'execute', return_value='x' * 16384):
            with self.assertRaisesRegex(ValueError, 'Oversized deadline response'):
                self.exchange([{'id': 1, 'input': {}}])

    def test_parent_binding_checks_identity_and_death_race(self):
        with patch.object(host.os, 'getppid', side_effect=[42, 43]), patch.object(host.ctypes, 'CDLL') as library:
            library.return_value.prctl.return_value = 0
            with self.assertRaisesRegex(ValueError, 'parent changed'):
                host.bind_parent(42)
            self.assertEqual(library.return_value.prctl.call_args.args[:2], (1, signal.SIGKILL))
        with patch.object(host.os, 'getppid', return_value=43):
            with self.assertRaisesRegex(ValueError, 'Missing'):
                host.bind_parent(42)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux parent-death signal')
    def test_parent_death_kills_even_a_blocked_operation(self):
        # The child writes readiness only after installing the real kernel signal.
        child = ("import importlib.util,os,time;"
                 f"s=importlib.util.spec_from_file_location('h',{str(source)!r});"
                 "h=importlib.util.module_from_spec(s);s.loader.exec_module(h);"
                 "h.bind_parent(int(__import__('sys').argv[1]));"
                 "print(os.getpid(),flush=True);time.sleep(30)")
        parent_code = ("import subprocess,os,sys,time;"
                       f"p=subprocess.Popen([sys.executable,'-c',{child!r},str(os.getpid())]);"
                       "time.sleep(30)")
        parent = subprocess.Popen([sys.executable, '-u', '-c', parent_code], stdout=subprocess.PIPE)
        pid = None
        try:
            import select
            self.assertTrue(select.select([parent.stdout], [], [], 5)[0], 'helper readiness')
            pid = int(parent.stdout.readline())
            parent.kill()
            parent.wait(timeout=5)
            for _ in range(100):
                status = Path(f'/proc/{pid}/stat')
                if not status.exists() or status.read_text().split()[2] == 'Z':
                    break
                time.sleep(.01)
            else:
                self.fail('helper survived controller death')
        finally:
            if parent.poll() is None:
                parent.kill()
            parent.wait(timeout=5)
            parent.stdout.close()
            if pid:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == '__main__':
    unittest.main()
