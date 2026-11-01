"""Private worker framing, per-operation locking and denied-state cold work."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py'
spec = importlib.util.spec_from_file_location('deadline_worker_host', source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class WorkerProtocolTests(unittest.TestCase):
    def frames(self, requests):
        return io.BytesIO(b''.join(json.dumps(item).encode() + b'\n' for item in requests))

    def test_reuses_executor_but_locks_every_request_and_flushes_each_reply(self):
        class Output(io.BytesIO):
            flushes = 0
            def flush(self):
                self.flushes += 1
        output = Output()
        with patch.object(host, 'locked_execute', side_effect=[{'first': True}, {'second': True}]) as execute:
            host.serve_worker(self.frames([{'id': 1, 'request': {'operation': 'clock'}},
                                          {'id': 2, 'request': {'operation': 'clock'}}]), output)
        self.assertEqual(execute.call_count, 2)
        replies = [json.loads(row) for row in output.getvalue().splitlines()]
        self.assertEqual([r['result'] for r in replies], [{'first': True}, {'second': True}])
        self.assertEqual(output.flushes, 2)
        for reply in replies:
            self.assertGreaterEqual(int(reply['finishedBootNs']), int(reply['startedBootNs']))

    def test_mutation_error_is_reported_once_without_reexecution(self):
        output = io.BytesIO()
        with patch.object(host, 'locked_execute', side_effect=[ValueError('partial commit'), {'state': 'denied'}]) as execute, patch.object(host.sys, 'stderr', io.StringIO()):
            host.serve_worker(self.frames([{'id': 1, 'request': {'operation': 'arm'}},
                                          {'id': 2, 'request': {'operation': 'revoke'}}]), output)
        replies = [json.loads(row) for row in output.getvalue().splitlines()]
        self.assertTrue(replies[0]['error'])
        self.assertEqual(replies[1]['result'], {'state': 'denied'})
        self.assertEqual(execute.call_count, 2)

    def test_rejects_incomplete_oversized_malformed_and_replayed_frames(self):
        bad = [b'{}', b'x' * 65537, b'\xff\n', b'{\n', b'[]\n',
               b'{"id":true,"request":{}}\n', b'{"id":1,"request":{},"extra":1}\n',
               b'{"id":1,"request":{}}\n{"id":1,"request":{}}\n']
        for data in bad:
            with self.subTest(data=data[:60]), patch.object(host, 'locked_execute', return_value={}) as execute:
                with self.assertRaises((ValueError, UnicodeError)):
                    host.serve_worker(io.BytesIO(data), io.BytesIO())
                self.assertLessEqual(execute.call_count, 1 if data.count(b'\n') == 2 else 0)

    def test_rejects_oversized_reply(self):
        with patch.object(host, 'locked_execute', return_value={'value': 'x' * 16384}):
            with self.assertRaisesRegex(ValueError, 'Oversized deadline reply'):
                host.serve_worker(self.frames([{'id': 1, 'request': {}}]), io.BytesIO())

    @unittest.skipUnless(os.geteuid() == 0, 'Trusted state lock requires root ownership')
    def test_state_lock_is_held_only_while_executing_each_operation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(host, 'STATE', Path(directory)):
            def execute(request):
                with open(Path(directory) / 'lock') as other:
                    with self.assertRaises(BlockingIOError):
                        host.fcntl.flock(other, host.fcntl.LOCK_EX | host.fcntl.LOCK_NB)
                return request
            with patch.object(host, 'execute', side_effect=execute):
                self.assertEqual(host.locked_execute({'operation': 'clock'}), {'operation': 'clock'})
            with open(Path(directory) / 'lock') as other:
                host.fcntl.flock(other, host.fcntl.LOCK_EX | host.fcntl.LOCK_NB)


def process_exited(pid):
    try:
        return Path('/proc', str(pid), 'stat').read_text().split(') ')[1].startswith('Z')
    except (FileNotFoundError, ProcessLookupError):
        # procfs can lose the task after open and before read when reaping wins.
        return True


class ControllerLifetimeTests(unittest.TestCase):
    def test_reaping_during_procfs_read_counts_as_exited(self):
        for error in (FileNotFoundError(), ProcessLookupError()):
            with self.subTest(error=error), patch.object(Path, 'read_text', side_effect=error):
                self.assertTrue(process_exited(123))
        with patch.object(Path, 'read_text', return_value='123 (worker) S 1'):
            self.assertFalse(process_exited(123))
        with patch.object(Path, 'read_text', side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                process_exited(123)

    @unittest.skipUnless(host.sys.platform == 'linux', 'Parent death signal requires Linux')
    def test_worker_dies_when_its_controller_is_killed(self):
        import subprocess
        import time
        worker_code = ("import importlib.util,time; s=importlib.util.spec_from_file_location('host', "
                       + repr(str(source)) + "); h=importlib.util.module_from_spec(s); s.loader.exec_module(h); "
                       "h.bind_controller(); print('ready',flush=True); time.sleep(30)")
        owner_code = ("import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c',"
                      + repr(worker_code) + "],stdout=subprocess.PIPE,text=True); "
                      "assert p.stdout.readline().strip()=='ready'; print(p.pid,flush=True); time.sleep(30)")
        owner = subprocess.Popen([host.sys.executable, '-c', owner_code], stdout=subprocess.PIPE, text=True)
        worker_pid = None
        try:
            worker_pid = int(owner.stdout.readline())
            owner.kill()
            owner.wait(timeout=2)
            limit = time.monotonic() + 2
            while time.monotonic() < limit:
                if process_exited(worker_pid):
                    break
                time.sleep(0.01)
            else:
                self.fail('Worker survived controller death')
        finally:
            if owner.poll() is None:
                owner.kill()
            owner.wait(timeout=2)
            owner.stdout.close()
            if worker_pid:
                try:
                    os.kill(worker_pid, host.signal.SIGKILL)
                except ProcessLookupError:
                    pass


class RenewalPreparationTests(unittest.TestCase):
    def test_preparation_reuses_the_exact_deadline_map_and_validates_program_identity(self):
        from types import SimpleNamespace
        root = Path('/fixed/pins')
        replies = [json.dumps({'type': 'socket_filter', 'map_ids': [7]}), json.dumps({'id': 7})]
        with patch.object(Path, 'exists', return_value=False), patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0o100644, st_uid=0)), patch.object(host, 'run', side_effect=['', *replies]) as run:
            host.prepare_renewal(root)
        self.assertIn(('map', 'name', 'deadline', 'pinned', str(root / 'maps/deadline')), [call.args[-5:] for call in run.call_args_list])

    def test_preparation_rejects_a_program_bound_to_another_map(self):
        replies = [json.dumps({'type': 'socket_filter', 'map_ids': [8]}), json.dumps({'id': 7})]
        with patch.object(Path, 'exists', return_value=True), patch.object(Path, 'lstat', return_value=type('Stat', (), {'st_mode': 0o100644, 'st_uid': 0})()), patch.object(host, 'run', side_effect=replies):
            with self.assertRaisesRegex(ValueError, 'not bound'):
                host.prepare_renewal(Path('/fixed/pins'))

    def test_live_renewal_never_loads_a_missing_program(self):
        with patch.object(host, 'bpf', side_effect=FileNotFoundError('missing pin')), patch.object(host, 'run') as run:
            with self.assertRaises(FileNotFoundError):
                host.renew_deadline(Path('/missing'), 3, 100, 200)
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
