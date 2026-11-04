"""Native staging evidence only; never grants a production profile or direct authority."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

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
    source = (assets / 'node') if name == 'node' else (assets / 'units' / name)
    if name == 'project-egress-host-main.mjs':
        source = assets / name
    elif name.endswith('.bpf.o'):
        source = Path('/opt/verity-egress') / name
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
assert before['dockerPid'] == command('systemctl', 'show', '--property=MainPID', '--value', 'docker.service')
assert before['key'] == hashlib.sha256(Path('/etc/verity-egress/control.key').read_bytes()).hexdigest()
assert before['tables'] == json.loads(command('nft', '-j', 'list', 'tables'))
for name, digest in before['units'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest
assert not Path('/etc/verity-egress/authority.json').exists()
assert Path('/etc/verity-egress-server/control.key').read_bytes() == Path('/etc/verity-egress/control.key').read_bytes()
evidence = {
    'version': 1, 'scope': 'native-managed-staging-only',
    'productionAccepted': False, 'directAuthorityConfigured': False,
    'keyPreserved': True, 'dockerProcessPreserved': True,
    'firewallTablesPreserved': True, 'activeUnitsPreserved': True,
    'repeatedPreparationStable': True, 'releaseManifest': manifest,
}
Path('/var/lib/verity-egress-fixture/managed-staging.json').write_text(json.dumps(evidence, sort_keys=True))
print(json.dumps(evidence, sort_keys=True))
