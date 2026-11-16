"""Execute the wrapper's authorization reader against controlled channel files."""
import os
import importlib.util
from pathlib import Path
import re
import sys
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import json

WRAPPER = Path(__file__).resolve().parents[3] / 'deploy/host/verity-egress-provision'
PROGRAM = WRAPPER.read_text().split("<<'ASSESSMENT'\n", 1)[1].split('\nASSESSMENT\n', 1)[0]


class StagingWrapperTests(unittest.TestCase):
    def authorize(self, channel='staging', owner=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            channel_path = root / 'update-channel.json'
            channel_path.write_text(json.dumps(channel))
            channel_path.chmod(0o600)
            output = root / 'authorization.json'
            env = {'VERITY_EGRESS_ASSESSMENT_' + key: value for key, value in {
                'DEPLOYMENT_ID': 'ubuntu-ac986397',
                'INSTALLED_DIGEST': 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a' * 64,
                'TARGET_DIGEST': 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'b' * 64,
                'CHANNEL_PATH': '/var/lib/docker/volumes/verity-managed-deployment/_data/update-channel.json',
                'OPERATION_ID': 'c' * 24, 'CHANNEL_OWNER_UID': '0'}.items()}
            def metadata(fd):
                actual = os.fstat(fd)
                return SimpleNamespace(st_uid=owner, st_mode=actual.st_mode, st_size=actual.st_size)
            def open_channel(path, flags):
                self.assertEqual(str(path), '/run/verity-egress-updater-state/update-channel.json')
                self.assertTrue(flags & os.O_NOFOLLOW)
                return os.open(channel_path, flags)
            adapter = SimpleNamespace(open=open_channel, fstat=metadata, fdopen=os.fdopen,
                O_RDONLY=os.O_RDONLY, O_NOFOLLOW=os.O_NOFOLLOW, environ=env)
            with patch.dict(sys.modules, {'os': adapter}), patch.object(sys, 'argv', ['authorization', str(output)]):
                exec(compile(PROGRAM, str(WRAPPER), 'exec'), {})
            return json.loads(output.read_text())

    def test_read_only_updater_channel_grants_only_explicit_unaccepted_assessment(self):
        value = self.authorize()
        self.assertEqual(value['scope'], 'staging-assessment')
        self.assertIs(value['productionAccepted'], False)
        self.assertEqual(value['channelOwnerUid'], 0)
        self.assertEqual(value['operationId'], 'c' * 24)

    def test_installer_id_round_trips_from_wrapper_into_host_authorization(self):
        source = WRAPPER.parents[2] / 'scripts/project-egress-install.py'
        spec = importlib.util.spec_from_file_location('wrapper_installer', source)
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        authorization = self.authorize()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            channel = root / authorization['channelPath'].lstrip('/')
            channel.parent.mkdir(parents=True)
            channel.write_text(json.dumps('staging'))
            channel.chmod(0o600)
            self.assertEqual(installer.staging_authorization(root, authorization)['deploymentId'], 'ubuntu-ac986397')

    def test_stable_and_foreign_owner_are_rejected(self):
        for options in ({'channel': 'stable'}, {'channel': {'channel': 'staging'}}, {'owner': 1000}):
            with self.subTest(options=options), self.assertRaises(SystemExit):
                self.authorize(**options)

    def test_cached_unsupported_install_cannot_suppress_retry(self):
        predicate = re.search(r"jq -e '([^']+)'", WRAPPER.read_text()).group(1)
        for available, expected in ((False, 1), (True, 0)):
            result = subprocess.run(['jq', '-e', predicate],
                input=json.dumps({'version': 1, 'exitCode': 0, 'available': available}),
                text=True, capture_output=True)
            self.assertEqual(result.returncode, expected)


if __name__ == '__main__':
    unittest.main()
