"""Persistent guest setup/probes, separated from outer lifecycle orchestration."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/var/lib/verity-egress-fixture')
PASSWORD = 'disposable-boot-proof-password'


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def api(path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    request = urllib.request.Request('http://127.0.0.1:9000' + path,
                                     data=None if body is None else json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def wait(check, timeout=120):
    deadline = time.monotonic() + timeout
    error = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, subprocess.SubprocessError, ValueError, AssertionError) as failure:
            error = failure
        time.sleep(0.5)
    raise RuntimeError(f'Guest readiness failed: {error}')


def descriptor():
    return json.loads((ROOT / 'topology.json').read_text())


def containers():
    project = descriptor()['projectId']
    registry = json.loads(Path('/var/lib/verity-egress/registry.json').read_text())
    ids = [value for record in registry['records'] if record['binding']['projectId'] == project
           for value in record['containers'].values()]
    return json.loads(run('docker', 'inspect', *ids)) if ids else []


def sandbox():
    registry = json.loads(Path('/var/lib/verity-egress/registry.json').read_text())
    record = next(record for record in registry['records'] if record['binding']['projectId'] == descriptor()['projectId'])
    return record['containers']['sandbox']


def positive():
    value = run('docker', 'exec', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'positive')
    assert 'authenticated-memory-positive' in value
    return value


def setup():
    assert os.getuid() == 0 and Path('/var/lib/cloud/data/instance-id').read_text().strip() == 'verity-boot-probe'
    run('docker', 'run', '-d', '--name', 'verity-boot-registry', '--network', 'host', '--restart', 'no',
        '-e', 'REGISTRY_HTTP_ADDR=127.0.0.1:5000', 'verity-boot-registry:local')
    refs = {}
    for role, image in [('runner', 'verity-boot-observed-runner:local'), ('relay', 'verity-boot-relay:local')]:
        target = f'127.0.0.1:5000/verity-boot-{role}:fixture'
        run('docker', 'tag', image, target)
        run('docker', 'push', target)
        run('docker', 'pull', target)
        refs[role] = json.loads(run('docker', 'image', 'inspect', target))[0]['RepoDigests'][0]
    data_root = json.loads(run('docker', 'volume', 'inspect', 'verity-boot-data'))[0]['Mountpoint']
    config = {'runnerImage': refs['runner'], 'relayImage': refs['relay'], 'dataRoot': data_root, 'gatewayKey': secrets.token_hex(32)}
    (ROOT / 'config.json').write_text(json.dumps(config))
    os.chmod(ROOT / 'config.json', 0o600)
    policy = {'image': refs['relay'], 'dataVolume': 'verity-boot-data', 'socketOwnerUid': 0,
              'relayGid': 1102, 'brokerSubpath': 'relay/broker', 'claudeSubpath': 'relay/claude', 'codexSubpath': 'relay/codex'}
    Path('/etc/verity-egress/relay.json').write_text(json.dumps(policy))
    os.chmod('/etc/verity-egress/relay.json', 0o600)
    with open('/etc/hosts', 'a') as hosts:
        hosts.write('\n127.0.0.1 verity-agent-gateway\n')
    run('systemctl', 'restart', 'verity-egress-host.service')
    run('systemctl', 'start', 'verity-boot-gateway.service', 'verity-boot-server.service')
    wait(lambda: api('/health'))
    token = api('/secret/init', {'password': PASSWORD, 'deviceLabel': 'boot fixture'})['token']
    created = api('/projects', {'kind': 'local', 'name': 'Boot fixture'}, token)
    project = created.get('project', created)
    (ROOT / 'topology.json').write_text(json.dumps({'projectId': project['id']}))
    api(f"/projects/{project['id']}/repair", {'confirmWarnings': True}, token)
    wait(positive, 180)
    Path(data_root, 'boot-retained-marker').write_text('retained actual project data')


def recover():
    run('systemctl', 'start', 'verity-boot-gateway.service', 'verity-boot-server.service')
    wait(lambda: api('/health'))
    token = api('/secret/unlock', {'password': PASSWORD, 'deviceLabel': 'boot recovery'})['token']
    # The real watchdog resumes the retained generation. A passing HTTP health route
    # alone never counts as project transport readiness.
    project = descriptor()['projectId']
    api(f'/projects/{project}/sleep', {}, token)
    api(f'/projects/{project}/wake', {}, token)
    wait(positive, 180)
    config = json.loads((ROOT / 'config.json').read_text())
    assert Path(config['dataRoot'], 'boot-retained-marker').read_text() == 'retained actual project data'
    return token


def snapshot():
    registry = json.loads(Path('/var/lib/verity-egress/registry.json').read_text())
    facts = []
    for container in containers():
        facts.append({'id': container['Id'], 'image': container['Image'], 'running': container['State']['Running'],
                      'restart': container['HostConfig']['RestartPolicy']['Name'],
                      'mounts': [{k: mount[k] for k in ('Source', 'Destination')} for mount in container['Mounts']]})
    return {'projectId': descriptor()['projectId'], 'registry': registry, 'containers': facts}


def faults():
    run('systemctl', 'stop', 'verity-boot-server.service')
    run('systemctl', 'stop', 'docker.service')
    registry = Path('/var/lib/verity-egress/registry.json')
    original = registry.read_bytes()
    results = []
    try:
        registry.write_text('{broken-registry')
        result = subprocess.run(['systemctl', 'start', 'docker.service'], capture_output=True)
        assert result.returncode != 0, 'Corrupt registry did not block Docker start'
        assert subprocess.run(['systemctl', 'is-active', '--quiet', 'verity-egress-host.service']).returncode != 0
        results.append('corrupt-registry-denied')
    finally:
        registry.write_bytes(original)
        run('systemctl', 'reset-failed')
    nft = Path('/usr/sbin/nft')
    hidden = Path('/usr/sbin/nft.boot-proof-disabled')
    nft.rename(hidden)
    try:
        result = subprocess.run(['systemctl', 'start', 'docker.service'], capture_output=True)
        assert result.returncode != 0, 'Unavailable nftables did not block Docker start'
        results.append('nftables-failure-denied')
    finally:
        hidden.rename(nft)
        run('systemctl', 'reset-failed')
    daemon = Path('/etc/docker/daemon.json')
    supported = daemon.read_bytes()
    unsupported = json.loads(supported)
    unsupported['live-restore'] = True
    daemon.write_text(json.dumps(unsupported))
    try:
        run('systemctl', 'start', 'docker.service')
        time.sleep(3)
        assert subprocess.run(['systemctl', 'is-active', '--quiet', 'verity-egress-host.service']).returncode != 0, 'Unsupported live restore was accepted'
        assert all(not c['State']['Running'] for c in containers()), 'Protected containers restarted automatically'
        results.append('unsupported-live-restore-denied')
    finally:
        run('systemctl', 'stop', 'docker.service')
        daemon.write_bytes(supported)
        run('systemctl', 'reset-failed')
        run('systemctl', 'start', 'docker.service')
    print(json.dumps(results))


if __name__ == '__main__':
    operation = sys.argv[1]
    if operation == 'setup':
        setup()
    elif operation == 'recover':
        recover()
    elif operation == 'positive':
        positive()
    elif operation == 'faults':
        faults()
    elif operation == 'external':
        run('docker', 'exec', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'external')
    elif operation == 'snapshot':
        print(json.dumps(snapshot()))
    elif operation == 'stream-status':
        container = json.loads(run('docker', 'inspect', sandbox()))[0]
        mount = next(m for m in container['HostConfig']['Mounts'] if m['Target'] == '/work')
        assert mount['Source'] == 'verity-boot-data'
        config = json.loads((ROOT / 'config.json').read_text())
        directory = Path(config['dataRoot'], mount['VolumeOptions']['Subpath']).resolve()
        assert directory.is_relative_to(Path(config['dataRoot']).resolve())
        print((directory / f'.boot-stream-{sys.argv[2]}.json').read_text())
    elif operation == 'stream':
        run('docker', 'exec', '-d', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'stream', sys.argv[2])
    else:
        raise ValueError(operation)
