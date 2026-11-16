"""Exercise the shipped wrapper with an isolated filesystem and a direct-only manager."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


WRAPPER = Path(__file__).resolve().parents[3] / 'deploy/host/verity-egress-provision'
IDENTIFIER = 'c' * 24

MOCK = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
root = Path(os.environ['WRAPPER_FIXTURE'])
stage = root / 'state/provision' / ('c' * 24)
command = Path(sys.argv[0]).name
args = sys.argv[1:]
mode = (root / 'mode').read_text()
with (root / 'calls').open('a') as calls:
    calls.write(command + ' ' + ' '.join(args) + '\n')
if command == 'id':
    print(0)
elif command == 'stat':
    if args[:2] == ['-c', '%u']:
        print(0)
    else:
        sys.exit(subprocess.call(['/usr/bin/stat', *args]))
elif command == 'node':
    config = Path(args[-1])
    config.mkdir()
    for name in ['relay.json', 'authority.json', 'database.json']:
        (config / name).write_text('{}')
elif command == 'host-python':
    status = root / 'runtime/status.json'
    status.parent.mkdir(exist_ok=True)
    status.write_text(json.dumps({'state': 'ready', 'reason': 'ready'}
        if mode != 'unavailable' else {'state': 'unsupported', 'reason': 'runtime_unsupported'}))
    if mode == 'host-failure':
        print(json.dumps({'available': False, 'reason': 'relay_runtime_mismatch', 'step': 'prerequisites'}))
    elif mode == 'private-diagnostic':
        print(json.dumps({'available': False, 'reason': 'postgres://secret@database', 'step': 'private-secret'}))
    elif mode == 'nonstring-diagnostic':
        print(json.dumps({'available': False, 'reason': [], 'step': []}))
    elif mode == 'stderr-outcome':
        print('private secret on stderr', file=sys.stderr)
        print(json.dumps({'available': False, 'reason': 'relay_runtime_mismatch', 'step': 'prerequisites'}))
    elif mode == 'oversized-outcome':
        print(json.dumps({'available': False, 'reason': 'relay_runtime_mismatch', 'step': 'prerequisites', 'private': 'secret' * 1000}))
    elif mode == 'malformed-outcome':
        print('private secret not-json')
    elif mode == 'multiple-outcomes':
        print('{"available":true,"reason":"ready"}\n{"available":false,"reason":"provisioning_failed"}')
    elif mode != 'silent-outcome':
        print(json.dumps({'available': mode != 'unavailable', 'reason': 'runtime_unsupported' if mode == 'unavailable' else 'ready'}))
    sys.exit(7 if mode in ['host-failure', 'private-diagnostic', 'nonstring-diagnostic', 'malformed-outcome', 'multiple-outcomes', 'silent-outcome', 'oversized-outcome', 'stderr-outcome'] else 0)
elif command == 'systemd-run':
    # v252 --wait uses the full system bus; the authorized helper only mounts the manager socket.
    if '--wait' in args:
        print('Failed to connect to bus: No such file or directory', file=sys.stderr)
        sys.exit(1)
    if mode == 'reject':
        print('private postgres://secret@database', file=sys.stderr)
        sys.exit(1)
    (root / 'submitted').touch()
    if mode in ['disconnect', 'timeout']:
        (root / 'active').touch()
        sys.exit(124 if mode == 'disconnect' else 0)
    if mode == 'forged-diagnostics':
        (stage / 'result.json').write_text(json.dumps({'version': 1, 'operationId': 'c' * 24,
            'attempt': (stage / 'attempt').read_text().strip(), 'exitCode': 7, 'available': False,
            'reason': 'postgres://secret@database', 'step': ['secret']}))
    elif mode in ['invalid', 'stale', 'missing', 'failed-missing']:
        if mode != 'missing' and mode != 'failed-missing':
            result = {'version': 1, 'operationId': 'c' * 24,
                      'attempt': 'old-attempt', 'exitCode': 0, 'available': True}
            (stage / 'result.json').write_text('not json' if mode == 'invalid' else json.dumps(result))
        if mode == 'failed-missing':
            (root / 'failed').touch()
    else:
        # Simulate a short-lived exec service completing before the submitter returns.
        with (root / 'journal').open('a') as journal:
            result = subprocess.call(['bash', args[-1]], stdout=journal, stderr=journal)
        if result:
            (root / 'failed').touch()
elif command == 'systemctl':
    if args[0] != 'show' or '--wait' in args:
        sys.exit('Unexpected manager mutation or full-bus wait')
    if mode == 'observe-failure':
        print('private host failure', file=sys.stderr)
        sys.exit(1)
    if mode == 'not-found' and not (root / 'submitted').exists():
        print('LoadState=not-found\nActiveState=inactive')
        sys.exit(4)
    if (root / 'active').exists():
        count = root / 'observations'
        value = int(count.read_text()) + 1 if count.exists() else 1
        count.write_text(str(value))
        if mode == 'adopt' and value >= 2:
            subprocess.check_call(['bash', str(stage / 'apply.sh')])
            (root / 'active').unlink()
    print('LoadState=loaded')
    print('ActiveState=' + ('active' if (root / 'active').exists()
          else 'failed' if (root / 'failed').exists() else 'inactive'))
else:
    sys.exit('Unexpected mock command ' + command)
'''


class ProvisionWrapperTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='egress-wrapper-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for path in ['bin', 'payload/egress-release', 'payload/scripts', 'runtime']:
            (self.root / path).mkdir(parents=True)
        for script in ['project-egress-install.py', 'project-egress-managed.py']:
            (self.root / 'payload/scripts' / script).write_text('# fixture\n')
        self.stage = self.root / 'state/provision' / IDENTIFIER
        (self.root / 'lock').touch(mode=0o600)
        for command in ['id', 'stat', 'node', 'systemctl', 'systemd-run', 'host-python']:
            path = self.root / 'bin' / command
            path.write_text(MOCK)
            path.chmod(0o700)
        source = WRAPPER.read_text()
        # Only relocate fixed paths; no test bypasses are exposed by the production helper.
        for before, after in [
            ('/var/lib/verity-egress', str(self.root / 'state')),
            ('/opt/verity-install', str(self.root / 'payload')),
            ('/run/verity-egress', str(self.root / 'runtime')),
            ('/usr/bin/python3', str(self.root / 'bin/host-python')),
        ]:
            source = source.replace(before, after)
        self.source = source
        self.wrapper = self.root / 'wrapper'
        self.wrapper.write_text(source)
        self.env = {**os.environ, 'WRAPPER_FIXTURE': str(self.root),
                    'VERITY_INSTALL_LOCK': str(self.root / 'lock'),
                    'VERITY_EGRESS_PROVISION_ID': IDENTIFIER,
                    'PATH': str(self.root / 'bin') + ':' + os.environ['PATH']}

    def run_wrapper(self, mode='success'):
        (self.root / 'mode').write_text(mode)
        return subprocess.run(['bash', str(self.wrapper)], env=self.env,
                              text=True, capture_output=True, timeout=15)

    def diagnostic(self, result, code):
        self.assertNotEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(report['kind'], 'egress-provisioning')
        self.assertEqual(report['operationId'], IDENTIFIER)
        self.assertEqual(report['code'], code)
        self.assertEqual(report['exitCode'], result.returncode)
        self.assertNotIn('secret', result.stdout + result.stderr)
        return report

    def test_direct_only_manager_completes_and_reuses_bound_ready_result(self):
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        completed = json.loads((self.stage / 'result.json').read_text())
        self.assertTrue(completed['available'])
        self.assertEqual(completed['attempt'], (self.stage / 'attempt').read_text().strip())
        self.assertEqual(self.run_wrapper().returncode, 0)
        calls = (self.root / 'calls').read_text()
        self.assertEqual(calls.count('systemd-run '), 1)
        self.assertNotIn('--wait', calls)

    def test_adopts_disconnected_host_work_without_rewriting_or_starting_it(self):
        self.diagnostic(self.run_wrapper('disconnect'), 'start_unverified')
        before = {name: (self.stage / name).read_bytes() for name in ['attempt', 'apply.sh', 'ready']}
        result = self.run_wrapper('adopt')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(before, {name: (self.stage / name).read_bytes() for name in before})
        self.assertEqual((self.root / 'calls').read_text().count('systemd-run '), 1)

    def test_start_rejection_reports_only_fixed_diagnostics(self):
        report = self.diagnostic(self.run_wrapper('reject'), 'start_unverified')
        self.assertEqual(report['phase'], 'submit')

    def test_a_missing_unit_can_be_submitted_without_hiding_transport_errors(self):
        result = self.run_wrapper('not-found')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_old_active_job_without_launch_identity_is_not_rewritten(self):
        self.diagnostic(self.run_wrapper('disconnect'), 'start_unverified')
        (self.stage / 'attempt').unlink()
        before = (self.stage / 'apply.sh').read_bytes()
        self.diagnostic(self.run_wrapper('timeout'), 'attempt_missing')
        self.assertTrue((self.root / 'active').exists())
        self.assertEqual(before, (self.stage / 'apply.sh').read_bytes())
        self.assertEqual((self.root / 'calls').read_text().count('systemd-run '), 1)

    def test_missing_invalid_and_stale_results_cannot_report_success(self):
        for mode, code in [('missing', 'result_missing'), ('failed-missing', 'host_failed'),
                           ('invalid', 'result_invalid'), ('stale', 'result_invalid')]:
            with self.subTest(mode=mode):
                self.diagnostic(self.run_wrapper(mode), code)

    def test_host_failure_preserves_exit_status(self):
        result = self.run_wrapper('host-failure')
        self.diagnostic(result, 'host_failed')
        self.assertEqual(result.returncode, 7)

    def test_failure_reason_survives_launcher_result_and_observer(self):
        report = self.diagnostic(self.run_wrapper('host-failure'), 'host_failed')
        completed = json.loads((self.stage / 'result.json').read_text())
        for value in (report, completed):
            self.assertEqual(value['reason'], 'relay_runtime_mismatch')
            self.assertEqual(value['step'], 'prerequisites')
        self.assertFalse(completed['available'])

    def test_unknown_malformed_and_missing_outcomes_never_reuse_runtime_status(self):
        for mode in ('private-diagnostic', 'nonstring-diagnostic', 'malformed-outcome', 'multiple-outcomes', 'silent-outcome', 'oversized-outcome', 'stderr-outcome'):
            with self.subTest(mode=mode):
                report = self.diagnostic(self.run_wrapper(mode), 'host_failed')
                completed = json.loads((self.stage / 'result.json').read_text())
                self.assertFalse(completed['available'])
                self.assertNotIn('reason', report)
                self.assertNotIn('step', report)
                self.assertNotIn('secret', json.dumps(completed))
                self.assertFalse((self.stage / 'outcome.json').exists())
                self.assertNotIn('secret', (self.root / 'journal').read_text())

    def test_observer_rejects_private_diagnostics_in_bound_result(self):
        report = self.diagnostic(self.run_wrapper('forged-diagnostics'), 'host_failed')
        self.assertEqual(report['exitCode'], 7)
        self.assertNotIn('reason', report)
        self.assertNotIn('step', report)

    def test_retry_does_not_reuse_previous_failure_diagnostics(self):
        self.diagnostic(self.run_wrapper('host-failure'), 'host_failed')
        before = (self.stage / 'attempt').read_text()
        report = self.diagnostic(self.run_wrapper('silent-outcome'), 'host_failed')
        self.assertNotEqual(before, (self.stage / 'attempt').read_text())
        self.assertNotIn('reason', report)
        self.assertNotIn('step', report)

    def test_unavailable_completion_is_not_cached_as_ready(self):
        self.assertEqual(self.run_wrapper('unavailable').returncode, 0)
        before = (self.stage / 'attempt').read_text()
        self.assertFalse(json.loads((self.stage / 'result.json').read_text())['available'])
        self.assertEqual(self.run_wrapper().returncode, 0)
        self.assertNotEqual(before, (self.stage / 'attempt').read_text())
        self.assertEqual((self.root / 'calls').read_text().count('systemd-run '), 2)

    def test_wait_deadline_leaves_host_work_running(self):
        self.assertIn('SECONDS + 725', self.source)
        self.wrapper.write_text(self.source.replace('SECONDS + 725', 'SECONDS + 0'))
        self.diagnostic(self.run_wrapper('timeout'), 'wait_timeout')
        self.assertTrue((self.root / 'active').exists())
        self.assertNotIn('systemctl stop', (self.root / 'calls').read_text())

    def test_observation_failure_never_submits_work(self):
        self.diagnostic(self.run_wrapper('observe-failure'), 'observation_failed')
        self.assertNotIn('systemd-run ', (self.root / 'calls').read_text())

    def test_retry_cannot_use_an_old_success_instead_of_the_new_result(self):
        self.assertEqual(self.run_wrapper('unavailable').returncode, 0)
        # A stopped previous attempt can have a valid result; submission must clear it.
        self.diagnostic(self.run_wrapper('missing'), 'result_missing')

    def test_cached_success_must_match_this_operation_and_attempt(self):
        self.assertEqual(self.run_wrapper().returncode, 0)
        result = json.loads((self.stage / 'result.json').read_text())
        result['operationId'] = 'd' * 24
        (self.stage / 'result.json').write_text(json.dumps(result))
        self.assertEqual(self.run_wrapper().returncode, 0)
        self.assertEqual((self.root / 'calls').read_text().count('systemd-run '), 2)


if __name__ == '__main__':
    unittest.main()
