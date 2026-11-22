"""Exercise the shipped wrapper with an isolated filesystem and a direct-only manager."""
import fcntl
import json
import os
import re
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
    if mode == 'config-failure':
        sys.exit(1)
    config = Path(args[-1])
    config.mkdir()
    for name in ['relay.json', 'authority.json', 'database.json']:
        (config / name).write_text('{}')
elif command == 'host-python' and args[0] == '-':
    from types import SimpleNamespace
    actual_fstat = os.fstat
    def root_owned(fd):
        info = actual_fstat(fd)
        return SimpleNamespace(st_uid=0, st_mode=info.st_mode, st_size=info.st_size)
    os.fstat = root_owned
    sys.argv = args
    exec(compile(sys.stdin.read(), '<assessment>', 'exec'))
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
    # Per-unit states for stages of other operations.
    other = root / 'units' / args[-1]
    if other.exists():
        state = other.read_text()
        if state == 'unobservable':
            sys.exit(1)
        print('LoadState=loaded\nActiveState=' + state)
        sys.exit(0)
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

    def test_maintenance_fence_prevents_staging_and_submission(self):
        state = self.root / 'state'
        state.mkdir()
        with (state / 'provision.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('stage maintenance is running', result.stderr)
        self.assertFalse(self.stage.exists())
        self.assertFalse((self.root / 'submitted').exists())

    def test_host_installer_authority_is_forwarded_without_shell_evaluation(self):
        self.env['VERITY_INSTALL_LOCK_HOST_PATH'] = str(self.root / 'lock')
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--installer-lock ' + str(self.root / 'lock'), (self.root / 'calls').read_text())

    def test_unsafe_host_installer_authority_is_refused_before_submission(self):
        self.env['VERITY_INSTALL_LOCK_HOST_PATH'] = '/host/$(invalid)/lock'
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsafe host installer lock path', result.stderr)
        self.assertFalse((self.root / 'submitted').exists())

    def test_path_failures_name_preflight_without_claiming_an_unchanged_host(self):
        (self.root / 'state').mkdir()
        (self.root / 'elsewhere').mkdir()
        (self.root / 'state/provision').symlink_to(self.root / 'elsewhere')
        report = self.diagnostic(self.run_wrapper(), 'command_failed')
        self.assertEqual(report['phase'], 'staging')
        self.assertEqual(report['step'], 'preflight')
        self.assertNotIn('hostUnchanged', report)
        self.assertNotIn('reason', report)
        self.assertFalse((self.root / 'submitted').exists())

    def test_staging_reasons_stay_within_the_vocabulary_of_older_updaters(self):
        # Updaters that predate staging step names drop unknown reasons silently.
        # Every Updater release since 4.90.0 relays exactly these two, and only as text.
        emitted = set(re.findall(r'\{reason: "([a-z_]+)"\}', WRAPPER.read_text()))
        self.assertEqual(emitted, {'assessment_authorization_invalid', 'provisioning_failed'})

    def diagnostic(self, result, code):
        self.assertNotEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(report['kind'], 'egress-provisioning')
        self.assertEqual(report['operationId'], IDENTIFIER)
        self.assertEqual(report['code'], code)
        self.assertEqual(report['exitCode'], result.returncode)
        self.assertNotIn('secret', result.stdout + result.stderr)
        return report

    def test_assessment_checks_channel_before_preparing_database_role(self):
        channel = self.root / 'runtime-updater-state/update-channel.json'
        channel.parent.mkdir()
        channel.touch(mode=0o600)
        self.env.update({'VERITY_EGRESS_ASSESSMENT_' + key: value for key, value in {
            'CHANNEL_PATH': str(channel), 'CHANNEL_OWNER_UID': '0',
            'DEPLOYMENT_ID': 'deployment-1', 'OPERATION_ID': IDENTIFIER,
            'INSTALLED_DIGEST': 'sha256:' + 'a' * 64,
            'TARGET_DIGEST': 'sha256:' + 'b' * 64,
        }.items()})
        channel.write_text(json.dumps('stable'))
        report = self.diagnostic(self.run_wrapper(), 'command_failed')
        self.assertEqual(report['phase'], 'staging')
        self.assertEqual(report['step'], 'assessment_authorization')
        self.assertEqual(report['reason'], 'assessment_authorization_invalid')
        self.assertIs(report['hostUnchanged'], True)
        self.assertNotIn('node ', (self.root / 'calls').read_text())
        self.assertFalse((self.root / 'submitted').exists())
        self.assertFalse(self.stage.exists())
        report = self.diagnostic(self.run_wrapper(), 'command_failed')
        self.assertIs(report['hostUnchanged'], True)

        channel.write_text(json.dumps('staging'))
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('--assessment-authorization ' + str(self.stage / 'assessment-authorization.json'),
                      (self.root / 'calls').read_text())

    def test_an_empty_legacy_stage_cannot_prove_the_host_is_unchanged(self):
        self.stage.mkdir(parents=True)
        (self.root / 'payload/egress-release').rmdir()
        report = self.diagnostic(self.run_wrapper(), 'command_failed')
        self.assertEqual(report['step'], 'release_copy')
        self.assertNotIn('hostUnchanged', report)

    def test_early_failure_after_configuration_attempt_requires_recovery(self):
        report = self.diagnostic(self.run_wrapper('config-failure'), 'command_failed')
        self.assertEqual(report['step'], 'config')
        self.assertEqual(report['reason'], 'provisioning_failed')
        self.assertNotIn('hostUnchanged', report)
        # An older maintenance timer retains only the attempt and result.
        for entry in self.stage.iterdir():
            if entry.name not in ('attempt', 'result.json'):
                if entry.is_dir():
                    entry.rmdir()
                else:
                    entry.unlink()
        (self.root / 'payload/egress-release').rmdir()
        report = self.diagnostic(self.run_wrapper(), 'command_failed')
        self.assertEqual(report['step'], 'release_copy')
        self.assertNotIn('hostUnchanged', report)

    def test_staging_failure_after_a_previous_submission_requires_recovery(self):
        self.assertEqual(self.run_wrapper('unavailable').returncode, 0)
        # The first retry discards the old payload. A later failure before
        # configuration must still account for the previously submitted unit.
        report = self.diagnostic(self.run_wrapper('config-failure'), 'command_failed')
        self.assertEqual(report['step'], 'config')
        self.assertNotIn('hostUnchanged', report)
        (self.root / 'payload/egress-release').rmdir()
        report = self.diagnostic(self.run_wrapper(), 'command_failed')
        self.assertEqual(report['phase'], 'staging')
        self.assertEqual(report['step'], 'release_copy')
        self.assertNotIn('hostUnchanged', report)
        self.assertTrue((self.stage / 'attempt').exists())

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
        attempt = (self.stage / 'attempt').read_text().strip()
        result = self.run_wrapper('adopt')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # A rewritten launcher would carry a new attempt; the adopted one completed.
        self.assertEqual((self.stage / 'attempt').read_text().strip(), attempt)
        self.assertEqual(json.loads((self.stage / 'result.json').read_text())['attempt'], attempt)
        self.assertEqual((self.root / 'calls').read_text().count('systemd-run '), 1)

    def test_running_host_work_keeps_its_staged_payload(self):
        self.diagnostic(self.run_wrapper('disconnect'), 'start_unverified')
        before = {name: (self.stage / name).read_bytes() for name in ['attempt', 'apply.sh', 'ready']}
        # Another operation's launcher must not touch a stage whose job still runs.
        other = dict(self.env, VERITY_EGRESS_PROVISION_ID='a' * 24)
        (self.root / 'units').mkdir()
        (self.root / 'units' / ('verity-egress-provision-' + 'a' * 24 + '.service')).write_text('inactive')
        (self.root / 'mode').write_text('timeout')
        result = subprocess.run(['bash', str(self.wrapper)], env=other, text=True,
                                capture_output=True, timeout=15)
        # It staged and swept (then found no result for its own simulated job).
        self.assertTrue((self.root / 'state/provision' / ('a' * 24) / 'ready').exists())
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, {name: (self.stage / name).read_bytes() for name in before})
        self.assertTrue((self.stage / 'release').is_dir())

    def stage_of(self, identifier, payload=True, result=True):
        stage = self.root / 'state/provision' / identifier
        (stage / 'release').mkdir(parents=True)
        (stage / 'release/asset').write_bytes(b'x' * 1024)
        (stage / 'config').mkdir()
        (stage / 'config/database.json').write_text('{"private":"secret"}')
        for name in ['ready', 'apply.sh', 'project-egress-managed.py']:
            (stage / name).write_text('payload')
        if result:
            (stage / 'attempt').write_text('A' * 12 + '\n')
            (stage / 'result.json').write_text(json.dumps({'version': 1, 'exitCode': 0}))
        return stage

    def receipt_only(self, stage):
        return sorted(path.name for path in stage.iterdir()) == ['attempt', 'result.json']

    def test_completed_stage_keeps_only_its_receipt_and_stays_idempotent(self):
        self.assertEqual(self.run_wrapper().returncode, 0)
        self.assertTrue(self.receipt_only(self.stage))
        self.assertEqual(self.run_wrapper().returncode, 0)
        self.assertEqual((self.root / 'calls').read_text().count('systemd-run '), 1)
        self.assertTrue(self.receipt_only(self.stage))

    def test_a_retry_after_compaction_stages_a_complete_payload_again(self):
        self.assertEqual(self.run_wrapper('unavailable').returncode, 0)
        self.assertFalse((self.stage / 'ready').exists())
        self.assertEqual(self.run_wrapper().returncode, 0)
        self.assertEqual((self.root / 'calls').read_text().count('systemd-run '), 2)
        self.assertTrue(json.loads((self.stage / 'result.json').read_text())['available'])

    def test_failed_host_work_keeps_payload_for_its_retry(self):
        self.diagnostic(self.run_wrapper('host-failure'), 'host_failed')
        self.assertTrue((self.stage / 'ready').exists())
        self.assertTrue((self.stage / 'release').is_dir())

    def test_stopped_stages_of_other_operations_lose_only_their_payload(self):
        units = self.root / 'units'
        units.mkdir()
        stopped = self.stage_of('a' * 24)
        unreceipted = self.stage_of('b' * 24, result=False)
        running = self.stage_of('d' * 24)
        unobservable = self.stage_of('e' * 24)
        (units / ('verity-egress-provision-' + 'a' * 24 + '.service')).write_text('inactive')
        (units / ('verity-egress-provision-' + 'b' * 24 + '.service')).write_text('failed')
        (units / ('verity-egress-provision-' + 'd' * 24 + '.service')).write_text('active')
        (units / ('verity-egress-provision-' + 'e' * 24 + '.service')).write_text('unobservable')
        self.assertEqual(self.run_wrapper().returncode, 0)
        self.assertTrue(self.receipt_only(stopped))
        self.assertEqual(sorted(path.name for path in unreceipted.iterdir()), [])
        for kept in (running, unobservable):
            self.assertTrue((kept / 'ready').exists())
            self.assertTrue((kept / 'release/asset').exists())
            self.assertTrue((kept / 'config/database.json').exists())

    def test_stage_compaction_never_follows_links_or_foreign_names(self):
        outside = self.root / 'outside'
        (outside / 'release').mkdir(parents=True)
        (outside / 'ready').write_text('keep')
        provision = self.root / 'state/provision'
        provision.mkdir(parents=True)
        (provision / ('f' * 24)).symlink_to(outside)
        foreign = self.stage_of('not-an-operation')
        inner = self.stage_of('9' * 24)
        (inner / 'release/asset').unlink()
        (inner / 'release/linked').symlink_to(outside / 'ready')
        self.assertEqual(self.run_wrapper().returncode, 0)
        self.assertEqual((outside / 'ready').read_text(), 'keep')
        self.assertTrue((outside / 'release').is_dir())
        self.assertTrue((foreign / 'ready').exists())
        self.assertTrue(self.receipt_only(inner))

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
