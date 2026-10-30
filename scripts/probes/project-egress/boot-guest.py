"""Persistent guest setup/probes, separated from outer lifecycle orchestration."""
import json
import os
from pathlib import Path
import secrets
import socket
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
    def registry_ready():
        with urllib.request.urlopen('http://127.0.0.1:5000/v2/', timeout=2) as response:
            return response.status == 200
    wait(registry_ready, 30)
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
    wait(lambda: api('/healthz'))
    token = api('/secret/init', {'password': PASSWORD, 'deviceLabel': 'boot fixture'})['token']
    created = api('/projects', {'kind': 'local', 'name': 'Boot fixture'}, token)
    project = created.get('project', created)
    (ROOT / 'topology.json').write_text(json.dumps({'projectId': project['id']}))
    api(f"/projects/{project['id']}/repair", {'confirmWarnings': True}, token)
    wait(positive, 180)
    Path(data_root, 'boot-retained-marker').write_text('retained actual project data')


def recover():
    run('systemctl', 'start', 'verity-boot-gateway.service', 'verity-boot-server.service')
    wait(lambda: api('/healthz'))
    token = api('/secret/unlock', {'password': PASSWORD, 'deviceLabel': 'boot recovery'})['token']
    # The real watchdog resumes the retained generation. A passing HTTP health route
    # alone never counts as project transport readiness.
    # Explicit trusted host readmission keeps the original sandbox process alive.
    # Actual Server listeners/capabilities are recovered by its normal project poll.
    run('env', 'PROJECT_EGRESS_DISPOSABLE=yes', '/usr/bin/node', '/opt/verity-fixture/boot-server.mjs', 'readmit')
    api('/projects', token=token)
    wait(positive, 180)
    config = json.loads((ROOT / 'config.json').read_text())
    assert Path(config['dataRoot'], 'boot-retained-marker').read_text() == 'retained actual project data'
    return token


def worktree():
    container = json.loads(run('docker', 'inspect', sandbox()))[0]
    mount = next(m for m in container['HostConfig']['Mounts'] if m['Target'] == '/work')
    assert mount['Source'] == 'verity-boot-data'
    config = json.loads((ROOT / 'config.json').read_text())
    directory = Path(config['dataRoot'], mount['VolumeOptions']['Subpath']).resolve()
    assert directory.is_relative_to(Path(config['dataRoot']).resolve())
    return directory


def inflight(phase):
    token = api('/secret/unlock', {'password': PASSWORD, 'deviceLabel': 'inflight proof'})['token']
    directory = worktree()
    run('docker', 'exec', '-d', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'inflight', phase)
    wait(lambda: (directory / f'.boot-inflight-{phase}-ready').exists(), 5)
    if phase == 'denied':
        run('env', 'PROJECT_EGRESS_DISPOSABLE=yes', '/usr/bin/node', '/opt/verity-fixture/boot-server.mjs', 'readmit')
    (directory / f'.boot-inflight-{phase}-finish').touch()
    result = wait(lambda: json.loads((directory / f'.boot-inflight-{phase}-result').read_text())
                  if (directory / f'.boot-inflight-{phase}-result').exists() else None, 5)
    assert result['finished_ns'] - result['started_ns'] < 10_000_000_000, 'Natural relay timeout invalidated old-flow proof'
    expected = phase != 'denied'
    assert (result['status'] == 200) == expected, result
    positive()
    detail = api('/projects/' + descriptor()['projectId'], token=token)
    memory = (detail.get('settings') or {}).get('memory') or ''
    assert (f'boot-inflight-{phase}' in memory) == expected, 'Actual Server memory disagrees with in-flight verdict'
    print(json.dumps(result))


def snapshot():
    registry = json.loads(Path('/var/lib/verity-egress/registry.json').read_text())
    facts = []
    for container in containers():
        facts.append({'id': container['Id'], 'image': container['Image'], 'running': container['State']['Running'],
                      'restart': container['HostConfig']['RestartPolicy']['Name'],
                      'mounts': [{k: mount[k] for k in ('Source', 'Destination')} for mount in container['Mounts']]})
    return {'projectId': descriptor()['projectId'], 'registry': registry, 'containers': facts}


def observer_positive(phase):
    for family, address in [(socket.AF_INET, '172.30.105.2'), (socket.AF_INET6, 'fd42:feed:5::2')]:
        for port in (53, 8080):
            with socket.socket(family, socket.SOCK_DGRAM) as channel:
                channel.sendto(f'outer-positive-{phase}-{family}-udp-{port}'.encode(), (address, port))
        with socket.socket(family, socket.SOCK_STREAM) as channel:
            channel.settimeout(2)
            channel.connect((address, 443))
            channel.sendall(f'outer-positive-{phase}-{family}-tcp-443'.encode())
            assert b'external-positive' in channel.recv(1024)


def remove_fences():
    # Destructive mutation is restricted to this disposable guest's own tables.
    assert Path('/var/lib/cloud/data/instance-id').read_text().strip() == 'verity-boot-probe'
    tables = json.loads(run('nft', '--json', 'list', 'tables'))['nftables']
    names = [entry['table'] for entry in tables if 'table' in entry and
             (entry['table']['name'] == 'verity_egress_boot' or entry['table']['name'].startswith('verity_start_'))]
    assert len(names) >= 4
    for table in names:
        run('nft', 'delete', 'table', table['family'], table['name'])


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
    elif operation == 'observer-positive':
        observer_positive(sys.argv[2])
    elif operation == 'remove-fences':
        remove_fences()
    elif operation == 'faults':
        faults()
    elif operation == 'external':
        run('docker', 'exec', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'external')
    elif operation == 'snapshot':
        print(json.dumps(snapshot()))
    elif operation == 'stream-status':
        status = json.loads((worktree() / f'.boot-stream-{sys.argv[2]}.json').read_text())
        receipts = ROOT / 'broker-receipts.jsonl'
        rows = [json.loads(line) for line in receipts.read_text().splitlines()] if receipts.exists() else []
        status['last_receipt_ns'] = max((int(row['time_ns']) for row in rows if row['phase'] == sys.argv[2]), default=0)
        print(json.dumps(status))
    elif operation == 'stop-poll':
        (worktree() / f'.boot-stop-{sys.argv[2]}').touch()
    elif operation == 'inflight':
        inflight(sys.argv[2])
    elif operation == 'stream':
        run('docker', 'exec', '-d', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'poll', sys.argv[2])
    else:
        raise ValueError(operation)
