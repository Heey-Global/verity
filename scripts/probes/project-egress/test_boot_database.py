"""Native database fixture stays private and follows the shipped PostgreSQL pin."""
import importlib.util
import ast
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
    def test_managed_stage_resolves_every_installer_asset(self):
        spec = importlib.util.spec_from_file_location('boot_managed', ROOT / 'scripts/project-egress-managed.py')
        managed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(managed)
        tree = ast.parse(Path(__file__).with_name('boot-managed-stage.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'release_source')
        namespace = {'Path': Path}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<release_source>', 'exec'), namespace)
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory)
            for name in managed.LEGACY_ASSETS:
                target = (assets / name if name in ('node', 'native-runtime-pins.env', 'project-egress-host-main.mjs')
                          else assets / ('objects' if name.endswith('.bpf.o') else 'units') / name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(name.encode())
            # Derive the added payload from the installer's actual closure.
            for name in set(managed.ASSETS) - set(managed.LEGACY_ASSETS):
                target = assets / 'toolchain' / name
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(name.encode())
            for name in managed.ASSETS:
                with self.subTest(name=name):
                    self.assertEqual(namespace['release_source'](assets, name, managed.LEGACY_ASSETS,
                                                               assets / 'objects').read_bytes(), name.encode())
        build = Path(__file__).with_name('boot-build.sh').read_text()
        self.assertIn('--target protected-build-toolchain', build)
        self.assertIn('docker cp "$toolchain:/protected-toolchain" "$assets/toolchain"', build)

    def test_controller_cannot_autostart_before_negative_activation_probe(self):
        units = Path(__file__).with_name('boot-native-install.sh').read_text()
        self.assertIn('ConditionPathExists=/var/lib/verity-egress-fixture/controller-enabled', units)
        source = Path(__file__).with_name('boot-guest.py').read_text()
        setup = source[source.index('def setup():'):source.index('def recover(')]
        self.assertLess(setup.index("Path('/etc/verity-egress/relay.json').write_text"),
                        setup.index("(ROOT / 'controller-enabled').touch()"))
        self.assertLess(setup.index("(ROOT / 'controller-enabled').touch()"),
                        setup.index("run('systemctl', 'restart', 'verity-egress-host.service')"))

    def test_fixture_controller_can_initialize_native_build_state(self):
        installer = Path(__file__).with_name('boot-native-install.sh').read_text()
        dropin = installer.split("packet-fixture.conf <<'UNIT'", 1)[1].split('\nUNIT', 1)[0]
        base = (ROOT / 'deploy/egress/verity-egress-host.service').read_text()
        host = (ROOT / 'packages/server/src/project-egress-build-host.ts').read_text()
        state = re.search(r"const ROOT = '([^']+)'", host).group(1)
        # The state root must be created and writable in the service namespace;
        # creating it elsewhere still fails with ProtectSystem=strict.
        directories = [path for unit in (base, dropin)
                       for line in unit.splitlines() if line.startswith('StateDirectory=')
                       for path in line.split('=', 1)[1].split()]
        self.assertIn(state.removeprefix('/var/lib/'), directories)
        self.assertIn('[Service]', dropin)
        self.assertIn('ProtectSystem=strict', base)
        self.assertIn('StateDirectoryMode=0700', base)

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

    def test_setup_keeps_bootstrap_secret_in_process_memory_and_stores_only_credential(self):
        with patch.object(guest.secrets, 'token_hex', return_value=PASSWORD), patch.object(guest, 'database_image', return_value=PIN), patch.object(guest, 'run') as run, patch.object(guest.subprocess, 'check_output') as process, patch.object(guest, 'store_database_credential') as store, patch.object(guest, 'wait_database') as ready, patch.object(guest, 'database_url', return_value='private-url'):
            guest.setup_database()
            calls = [call.args for call in run.call_args_list]
            self.assertIn(('docker', 'network', 'create', '--internal', guest.DATABASE_NETWORK), calls)
            launch = process.call_args.args[0]
            self.assertFalse(any(arg in ('--publish', '-p', '--network=host', '--env-file') for arg in launch))
            self.assertEqual(launch[launch.index('--memory') + 1], '192m')
            self.assertEqual(launch[launch.index('--memory-swap') + 1], '192m')
            self.assertIn('type=volume,source=verity-boot-postgres-data,target=/var/lib/postgresql', launch)
            self.assertIn(PIN, launch)
            self.assertNotIn(PASSWORD, ' '.join(launch))
            self.assertEqual(process.call_args.kwargs['env']['POSTGRES_PASSWORD'], PASSWORD)
            store.assert_called_once_with('private-url')
            ready.assert_called_once()

    def test_only_encrypted_credential_bytes_reach_disk(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(guest, 'DATABASE_CREDENTIAL', Path(directory) / 'credentials/database-url.cred'), patch.object(guest.subprocess, 'check_output', return_value='encrypted-fixture') as process:
            guest.store_database_credential('private-url')
            self.assertEqual(guest.DATABASE_CREDENTIAL.read_text(), 'encrypted-fixture')
            self.assertEqual(guest.DATABASE_CREDENTIAL.stat().st_mode & 0o777, 0o600)
            self.assertEqual(guest.DATABASE_CREDENTIAL.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(process.call_args.args[0], ['systemd-creds', 'encrypt', '--with-key=host', '--name=database-url', '-', '-'])
            self.assertEqual(process.call_args.kwargs['input'], 'private-url')

    def test_restart_reinspects_endpoint_and_reencrypts_without_plaintext_config(self):
        with patch.object(guest, 'run') as run, patch.object(guest, 'wait_database'), patch.object(guest.subprocess, 'check_output', return_value=f'postgres://verity:{PASSWORD}@172.29.0.1:5432/verity') as decrypt, patch.object(guest, 'store_database_credential') as store, patch.object(guest, 'database_url', return_value='new-private-url') as endpoint:
            guest.recover_database()
            run.assert_called_once_with('docker', 'start', guest.DATABASE)
            endpoint.assert_called_once_with(PASSWORD)
            store.assert_called_once_with('new-private-url')
            self.assertEqual(decrypt.call_args.args[0], ['systemd-creds', 'decrypt', '--name=database-url', str(guest.DATABASE_CREDENTIAL), '-'])

    def test_build_transports_compose_pin_and_server_uses_real_postgres(self):
        build = (ROOT / 'scripts/probes/project-egress/boot-build.sh').read_text()
        self.assertIn('deploy/docker-compose.yml', build)
        self.assertIn('docker pull "$postgres_image"', build)
        self.assertIn('verity-boot-registry:local "$postgres_image"', build)
        server = Path(__file__).with_name('boot-server.ts').read_text()
        self.assertIn('createPostgresDb(databaseUrl)', server)
        self.assertIn('process.env.CREDENTIALS_DIRECTORY', server)
        self.assertIn('`${credentials}/database-url`', server)
        self.assertNotIn('config.databaseUrl', server)
        units = Path(__file__).with_name('boot-native-install.sh').read_text()
        self.assertIn('LoadCredentialEncrypted=database-url:/etc/verity-boot/database-url.cred', units)
        self.assertNotIn('createEmbeddedDb', server)
        self.assertNotIn('buildTestEmbeddedServer', server)
        self.assertLess(server.index('await migrateToLatest'), server.index('await buildEmbeddedServer'))


if __name__ == '__main__':
    unittest.main()
