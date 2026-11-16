"""Native staging evidence only; never grants a production profile or direct authority."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

def release_source(assets, name, legacy_assets, objects=Path('/opt/verity-egress')):
    if name == 'node':
        return assets / 'node'
    if name in ('native-runtime-pins.env', 'project-egress-host-main.mjs'):
        return assets / name
    if name.endswith('.bpf.o'):
        return objects / name
    if name not in legacy_assets:
        return assets / 'toolchain' / name
    return assets / 'units' / name


assert os.getuid() == 0
assert Path('/var/lib/cloud/data/instance-id').read_text().strip() == 'verity-boot-probe'
assets = Path('/opt/verity-fixture')
spec = importlib.util.spec_from_file_location('managed_native_stage', assets / 'installer/project-egress-managed.py')
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)
release = assets / 'managed-release'
release.mkdir(mode=0o700)
manifest = {}
for name in managed.ASSETS:
    source = release_source(assets, name, managed.LEGACY_ASSETS)
    shutil.copyfile(source, release / name)
    os.chmod(release / name, 0o555 if name == 'node' else 0o444)
    manifest[name] = hashlib.sha256((release / name).read_bytes()).hexdigest()
(release / 'manifest.json').write_text(json.dumps(manifest))

def command(*args):
    return subprocess.check_output(args, text=True).strip()

before = {
    'dockerPid': command('systemctl', 'show', '--property=MainPID', '--value', 'docker.service'),
    'units': {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in
              [Path('/etc/systemd/system/verity-egress-host.service'),
               Path('/etc/systemd/system/verity-egress-bootstrap.service'),
               Path('/etc/systemd/system/docker.service.d/egress.conf')]},
    'key': hashlib.sha256(Path('/etc/verity-egress/control.key').read_bytes()).hexdigest(),
    'tables': json.loads(command('nft', '-j', 'list', 'tables')),
}
gid = int(command('getent', 'group', 'verity-egress-control').split(':')[2])
first = managed.provision(release, gid=gid, prepare_only=True)
second = managed.provision(release, gid=gid, prepare_only=True)
assert first == second == {'available': False, 'reason': 'runtime_unsupported', 'controlGid': gid}
# Exercise the shipped rejection path, rather than stopping at prepare_only.
# This guest has not started its Server/controller; remove only fixture inputs
# after observing rejection so later experimental lifecycle tests stay separate.
assert not managed.base.ACCEPTED_NATIVE_PROFILES
config_paths = [Path('/etc/verity-egress/relay.json'), Path('/etc/verity-egress/authority.json')]
assert all(not path.exists() and not path.is_symlink() for path in config_paths)
assert command('systemctl', 'show', '--property=MainPID', '--value', 'verity-egress-host.service') == '0'
with tempfile.TemporaryDirectory(prefix='verity-managed-rejection-') as temporary:
    os.chmod(temporary, 0o700)
    relay = Path(temporary) / 'relay.json'
    authority = Path(temporary) / 'authority.json'
    relay.write_text(json.dumps({'packetEnforcement': True}))
    authority.write_text(json.dumps({'databaseUrl': 'postgres://fixture@127.0.0.1/unused'}))
    try:
        results = [json.loads(command(sys.executable, str(assets / 'installer/project-egress-managed.py'),
                   'provision', str(release), '--relay-config', str(relay),
                   '--authority-config', str(authority), '--control-gid', str(gid))) for _ in range(2)]
        assert results == [first, first], 'Unaccepted native activation was not rejected'
        assert not Path('/etc/verity-egress-server/inventory-contract.json').exists()
        assert not Path('/opt/verity-egress').is_symlink()
        assert not (Path('/') / managed.JOURNAL).exists()
        assert not managed.base.ACCEPTED_NATIVE_PROFILES
    finally:
        for path in config_paths:
            path.unlink(missing_ok=True)
assert command('systemctl', 'show', '--property=MainPID', '--value', 'verity-egress-host.service') == '0'
assert before['dockerPid'] == command('systemctl', 'show', '--property=MainPID', '--value', 'docker.service')
assert before['key'] == hashlib.sha256(Path('/etc/verity-egress/control.key').read_bytes()).hexdigest()
assert before['tables'] == json.loads(command('nft', '-j', 'list', 'tables'))
for name, digest in before['units'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest
assert not Path('/etc/verity-egress/authority.json').exists()
assert Path('/etc/verity-egress-server/control.key').read_bytes() == Path('/etc/verity-egress/control.key').read_bytes()
candidate_spec = importlib.util.spec_from_file_location(
    'native_candidate', assets / 'probe/collect-native-candidate.py')
candidate = importlib.util.module_from_spec(candidate_spec)
candidate_spec.loader.exec_module(candidate)
native_candidate = candidate.collect(managed.base, release=release)
evidence = {
    'version': 1, 'scope': 'native-managed-staging-only',
    'productionAccepted': False, 'directAuthorityConfigured': False,
    'keyPreserved': True, 'dockerProcessPreserved': True,
    'firewallTablesPreserved': True, 'activeUnitsPreserved': True,
    'repeatedPreparationStable': True, 'unacceptedActivationRejected': True,
    'repeatedActivationRejectionStable': True, 'controllerNeverStarted': True, 'releaseManifest': manifest,
    'nativeCandidate': native_candidate,
}
Path('/var/lib/verity-egress-fixture/managed-staging.json').write_text(json.dumps(evidence, sort_keys=True))
print(json.dumps(evidence, sort_keys=True))
