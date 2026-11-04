"""Native database fixture stays private and follows the shipped PostgreSQL pin."""
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('boot_guest_database', Path(__file__).with_name('boot-guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
ROOT = Path(__file__).resolve().parents[3]
PIN = re.findall(r'^\s*image:\s*(postgres:[^\s]+@sha256:[a-f0-9]{64})\s*$',
                 (ROOT / 'deploy/docker-compose.yml').read_text(), re.MULTILINE)[0]
PASSWORD = 'a' * 64


def container():
    return {'Name': '/' + guest.DATABASE, 'State': {'Running': True},
            'Config': {'Image': PIN, 'Labels': {'com.docker.compose.service': 'postgres'}},
            'HostConfig': {'PortBindings': {}},
            'NetworkSettings': {'Networks': {guest.DATABASE_NETWORK: {'IPAddress': '172.29.0.2'}}}}


class NativeDatabaseTests(unittest.TestCase):
    def test_readiness_requires_final_tcp_listener_not_initdb_socket(self):
        with patch.object(guest, 'run', side_effect=['/var/run/postgresql:5432 - accepting connections',
                                                  '127.0.0.1:5432 - accepting connections']) as run:
            guest.wait_database()
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.args, ('docker', 'exec', guest.DATABASE, 'pg_isready',
                                            '-h', '127.0.0.1', '-U', 'verity', '-d', 'verity'))

    def test_host_endpoint_requires_private_unpublished_correct_service(self):
        with patch.object(guest, 'database_image', return_value=PIN), patch.object(guest, 'run', return_value=json.dumps([container()])):
            self.assertEqual(guest.database_url(PASSWORD), f'postgres://verity:{PASSWORD}@172.29.0.2:5432/verity')
        changes = [lambda c: c['HostConfig'].update(PortBindings={'5432/tcp': [{'HostPort': '5432'}]}),
                   lambda c: c['NetworkSettings']['Networks'][guest.DATABASE_NETWORK].update(IPAddress='8.8.8.8'),
                   lambda c: c['Config'].update(Image='postgres:latest'),
                   lambda c: c['Config']['Labels'].update({'com.docker.compose.service': 'foreign'}),
                   lambda c: c['NetworkSettings']['Networks'].update(other={'IPAddress': '172.28.0.2'}),
                   lambda c: c['State'].update(Running=False)]
        for change in changes:
            value = container()
            change(value)
            with self.subTest(value=value), patch.object(guest, 'database_image', return_value=PIN), patch.object(guest, 'run', return_value=json.dumps([value])):
                with self.assertRaises(AssertionError):
                    guest.database_url(PASSWORD)

    def test_setup_uses_private_bounded_persistent_database_and_keeps_password_off_argv(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(guest, 'ROOT', Path(directory)), patch.object(guest.secrets, 'token_hex', return_value=PASSWORD), patch.object(guest, 'database_image', return_value=PIN), patch.object(guest, 'run') as run, patch.object(guest, 'wait_database') as ready, patch.object(guest, 'database_url', return_value='private-url'):
            self.assertEqual(guest.setup_database(), 'private-url')
            calls = [call.args for call in run.call_args_list]
            self.assertIn(('docker', 'network', 'create', '--internal', guest.DATABASE_NETWORK), calls)
            launch = next(args for args in calls if args[:2] == ('docker', 'run'))
            self.assertFalse(any(arg in ('--publish', '-p', '--network=host') for arg in launch))
            self.assertEqual(launch[launch.index('--memory') + 1], '192m')
            self.assertEqual(launch[launch.index('--memory-swap') + 1], '192m')
            self.assertIn('type=volume,source=verity-boot-postgres-data,target=/var/lib/postgresql', launch)
            self.assertIn(PIN, launch)
            self.assertNotIn(PASSWORD, ' '.join(launch))
            environment = Path(directory) / 'postgres.env'
            self.assertEqual(environment.stat().st_mode & 0o777, 0o600)
            self.assertIn('POSTGRES_PASSWORD=' + PASSWORD, environment.read_text())
            ready.assert_called_once()

    def test_restart_reinspects_endpoint_before_rewriting_existing_private_config(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(guest, 'ROOT', Path(directory)), patch.object(guest, 'run') as run, patch.object(guest, 'wait_database'), patch.object(guest, 'database_url', return_value='new-private-url') as endpoint:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps({'databaseUrl': f'postgres://verity:{PASSWORD}@172.29.0.1:5432/verity', 'retained': True}))
            config.chmod(0o600)
            guest.recover_database()
            run.assert_called_once_with('docker', 'start', guest.DATABASE)
            endpoint.assert_called_once_with(PASSWORD)
            self.assertEqual(json.loads(config.read_text()), {'databaseUrl': 'new-private-url', 'retained': True})
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)

    def test_build_transports_compose_pin_and_server_uses_real_postgres(self):
        build = (ROOT / 'scripts/probes/project-egress/boot-build.sh').read_text()
        self.assertIn('deploy/docker-compose.yml', build)
        self.assertIn('docker pull "$postgres_image"', build)
        self.assertIn('verity-boot-registry:local "$postgres_image"', build)
        server = Path(__file__).with_name('boot-server.ts').read_text()
        self.assertIn('createPostgresDb(config.databaseUrl)', server)
        self.assertNotIn('createEmbeddedDb', server)
        self.assertNotIn('buildTestEmbeddedServer', server)
        self.assertLess(server.index('await migrateToLatest'), server.index('await buildEmbeddedServer'))


if __name__ == '__main__':
    unittest.main()
