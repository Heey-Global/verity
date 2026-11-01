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


def report_failed_command(kind, error, trace):
    # Only an uncaught failure reaches the SSH evidence: the outer side merges stderr
    # into stdout, so expected, handled failures must never print here.
    cause, seen = error, set()
    while cause is not None and id(cause) not in seen and not isinstance(cause, subprocess.CalledProcessError):
        seen.add(id(cause))
        cause = cause.__cause__ or cause.__context__
    if cause is not None and not isinstance(cause, subprocess.CalledProcessError):
        cause = None
    if cause is not None:
        print((cause.output or '')[-4096:], file=sys.stderr)
    sys.__excepthook__(kind, error, trace)


def api(path, body=None, token=None, timeout=15):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    request = urllib.request.Request('http://127.0.0.1:9000' + path,
                                     data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read(4096).decode('utf-8', errors='replace')
        raise ValueError(f'Guest API {path} failed ({error.code}): {detail}') from error


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
    ids = [value for record in registry['records'] if not record['retired'] and record['binding']['projectId'] == project
           for value in record['containers'].values()]
    return json.loads(run('docker', 'inspect', *ids)) if ids else []


def sandbox():
    registry = json.loads(Path('/var/lib/verity-egress/registry.json').read_text())
    records = [record for record in registry['records'] if record['binding']['projectId'] == descriptor()['projectId']]
    record = next((record for record in records if not record['retired']), records[-1])
    return record['containers']['sandbox']


def positive():
    value = run('docker', 'exec', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'positive')
    assert 'authenticated-memory-positive' in value
    return value


def registry_ready():
    with urllib.request.urlopen('http://127.0.0.1:5000/v2/', timeout=2) as response:
        return response.status == 200


def setup():
    assert os.getuid() == 0 and Path('/var/lib/cloud/data/instance-id').read_text().strip() == 'verity-boot-probe'
    run('docker', 'run', '-d', '--name', 'verity-boot-registry', '--network', 'host', '--restart', 'no',
        '-e', 'REGISTRY_HTTP_ADDR=127.0.0.1:5000', 'verity-boot-registry:local')
    wait(registry_ready, 30)
    refs = {}
    for role, image in [('runner', 'verity-boot-observed-runner:local'), ('relay', 'verity-boot-relay:local')]:
        target = f'127.0.0.1:5000/verity-boot-{role}:fixture'
        run('docker', 'tag', image, target)
        run('docker', 'push', target)
        run('docker', 'pull', target)
        refs[role] = json.loads(run('docker', 'image', 'inspect', target))[0]['RepoDigests'][0]
    data_root = json.loads(run('docker', 'volume', 'inspect', 'verity-boot-data'))[0]['Mountpoint']
    config = {'runnerImage': refs['runner'], 'relayImage': refs['relay'], 'dataRoot': data_root, 'gatewayKey': secrets.token_hex(32),
              'controlToken': Path('/etc/verity-egress/control.key').read_text().strip()}
    (ROOT / 'config.json').write_text(json.dumps(config))
    os.chmod(ROOT / 'config.json', 0o600)
    os.chown(ROOT / 'config.json', 1000, 1000)
    policy = {'packetEnforcement': True, 'image': refs['relay'], 'dataVolume': 'verity-boot-data', 'socketOwnerUid': 1000,
              'relayGid': 1102, 'brokerSubpath': 'relay/broker', 'claudeSubpath': 'relay/claude', 'codexSubpath': 'relay/codex'}
    Path('/etc/verity-egress/relay.json').write_text(json.dumps(policy))
    os.chmod('/etc/verity-egress/relay.json', 0o600)
    with open('/etc/hosts', 'a') as hosts:
        hosts.write('\n127.0.0.1 verity-agent-gateway\n')
    run('systemctl', 'restart', 'verity-egress-host.service')
    run('systemctl', 'start', 'verity-boot-gateway.service', 'verity-boot-server.service')
    wait(lambda: api('/healthz'))
    token = api('/secret/init', {'password': PASSWORD, 'deviceLabel': 'boot fixture'})['token']
    # Adopt the actual first-boot project; creating another would double the
    # native Runner footprint and leave an unobserved protected generation.
    project = wait(lambda: next((p for p in api('/projects', token=token)
                                if p.get('repo') == 'getting-started'), None), 30)
    (ROOT / 'topology.json').write_text(json.dumps({'projectId': project['id']}))
    wait(positive, 180)
    Path(data_root, 'boot-retained-marker').write_text('retained actual project data')


def recover(replace=False):
    run('systemctl', 'start', 'verity-boot-gateway.service', 'verity-boot-server.service')
    wait(lambda: api('/healthz'))
    token = api('/secret/unlock', {'password': PASSWORD, 'deviceLabel': 'boot recovery'})['token']
    # The real watchdog resumes the retained generation. A passing HTTP health route
    # alone never counts as project transport readiness.
    # Explicit trusted host readmission keeps the original sandbox process alive.
    # Actual Server listeners/capabilities are recovered by its normal project poll.
    if replace:
        # The disposable registry deliberately has no automatic restart policy.
        # Image retrieval is a real part of replacement, so restore its fixture
        # dependency explicitly after Docker restart and host reboot.
        run('docker', 'start', 'verity-boot-registry')
        wait(registry_ready, 30)
        # Stopped packet registrations are immutable. Use the actual authenticated
        # replacement lifecycle rather than restarting an attested old endpoint.
        api('/verity-control/projects/' + descriptor()['projectId'] + '/recreate-container',
            {'confirmWarnings': True}, token=token, timeout=180)
    else:
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
    api('/secret/unlock', {'password': PASSWORD, 'deviceLabel': 'inflight proof'})
    directory = worktree()
    run('docker', 'exec', '-d', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'inflight', phase)
    wait(lambda: (directory / f'.boot-inflight-{phase}-ready').exists(), 5)
    if phase in ('denied', 'removed-fences'):
        run('env', 'PROJECT_EGRESS_DISPOSABLE=yes', '/usr/bin/node', '/opt/verity-fixture/boot-server.mjs', 'readmit')
    removed = remove_fences() if phase == 'removed-fences' else False
    (directory / f'.boot-inflight-{phase}-finish').touch()
    result = wait(lambda: json.loads((directory / f'.boot-inflight-{phase}-result').read_text())
                  if (directory / f'.boot-inflight-{phase}-result').exists() else None, 5)
    assert result['finished_ns'] - result['started_ns'] < 10_000_000_000, 'Natural relay timeout invalidated old-flow proof'
    expected = phase != 'denied'
    assert (result['status'] == 200) == expected, result
    positive()
    config = json.loads((ROOT / 'config.json').read_text())
    memory = Path(config['dataRoot'], 'knowledge', descriptor()['projectId'], 'overview.md').read_text()
    assert (f'boot-inflight-{phase}' in memory) == expected, 'Actual Server memory disagrees with in-flight verdict'
    # Observed by remove_fences(); the outer proof requires it before its receipt window.
    print(json.dumps({**result, 'fencesRemoved': removed}))


def snapshot():
    registry = json.loads(Path('/var/lib/verity-egress/registry.json').read_text())
    facts = []
    live_containers = containers()
    endpoints = {net['EndpointID'] for container in live_containers for net in container['NetworkSettings']['Networks'].values()}
    for container in live_containers:
        facts.append({'id': container['Id'], 'image': container['Image'], 'running': container['State']['Running'],
                      'restart': container['HostConfig']['RestartPolicy']['Name'],
                      'mounts': [{k: mount[k] for k in ('Source', 'Destination')} for mount in container['Mounts']]})
    packet = []
    identities = {container['id'] for container in facts}
    for path in Path('/var/lib/verity-egress/deadline').glob('*.json'):
        state = json.loads(path.read_text())
        if state['binding']['containerId'] not in identities or state['binding']['endpointId'] not in endpoints:
            continue
        raw = json.loads(run('env', 'PROJECT_EGRESS_DISPOSABLE=yes', 'python3',
            '/opt/verity-fixture/probe/deadline-observe.py', json.dumps(state['binding'])))
        program = json.loads(run('bpftool', '-j', 'prog', 'show', 'pinned',
            '/sys/fs/bpf/verity_egress_deadline/' + raw['identity'] + '/guard'))
        if isinstance(program, list):
            program = program[0]
        hooks = {direction: json.loads(run('tc', '-j', 'filter', 'show', 'dev', raw['state']['peer']['device'], direction))
                 for direction in ('ingress', 'egress')}
        packet.append({'raw': raw, 'program': program, 'hooks': hooks})
    assert len(packet) == 1, 'Missing combined TC/nft packet evidence'
    assert json.loads(Path('/etc/verity-egress/relay.json').read_text())['packetEnforcement'] is True
    return {'projectId': descriptor()['projectId'], 'registry': registry, 'containers': facts, 'packet': packet,
            'tables': json.loads(run('nft', '-j', 'list', 'tables'))['nftables']}


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
    packet = snapshot()['packet']
    tables = json.loads(run('nft', '--json', 'list', 'tables'))['nftables']
    names = [entry['table'] for entry in tables if 'table' in entry and
             (entry['table']['name'].startswith(('verity_egress_', 'verity_start_')))]
    assert len(names) >= 4
    for table in names:
        run('nft', 'delete', 'table', table['family'], table['name'])
    # Both layers must be removed for the destructive positive control.
    devices = []
    for guard in packet:
        device = guard['raw']['state']['peer']['device']
        assert device and all(c.isalnum() or c in '_-.' for c in device)
        run('tc', 'qdisc', 'del', 'dev', device, 'clsact')
        devices.append(device)
    # Report the observed kernel state, not the requested mutation.
    remaining = [entry['table']['name'] for entry in json.loads(run('nft', '--json', 'list', 'tables'))['nftables']
                 if 'table' in entry and entry['table']['name'].startswith(('verity_egress_', 'verity_start_'))]
    qdiscs = [q for device in devices for q in json.loads(run('tc', '-j', 'qdisc', 'show', 'dev', device))
              if q.get('kind') == 'clsact']
    return not remaining and not qdiscs and bool(devices)


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
    sys.excepthook = report_failed_command
    operation = sys.argv[1]
    if operation == 'setup':
        setup()
    elif operation == 'recover':
        recover(sys.argv[2:] == ['replace'])
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
    elif operation == 'process-facts':
        print(json.dumps({key: int(run('systemctl', 'show', unit, '--property=MainPID', '--value'))
                          for key, unit in [('docker', 'docker.service'), ('controller', 'verity-egress-host.service'),
                                            ('server', 'verity-boot-server.service')]}))
    elif operation == 'snapshot':
        print(json.dumps(snapshot()))
    elif operation == 'stream-status':
        status = json.loads((worktree() / f'.boot-stream-{sys.argv[2]}.json').read_text())
        receipts = ROOT / 'broker-receipts.jsonl'
        rows = [json.loads(line) for line in receipts.read_text().splitlines()] if receipts.exists() else []
        status['observed_ns'] = time.time_ns()
        status['last_receipt_ns'] = max((int(row['time_ns']) for row in rows if row['phase'] == sys.argv[2]), default=0)
        print(json.dumps(status))
    elif operation == 'stop-poll':
        directory = worktree()
        (directory / f'.boot-stop-{sys.argv[2]}').touch()
        if json.loads(run('docker', 'inspect', sandbox()))[0]['State']['Running']:
            wait(lambda: (directory / f'.boot-poll-{sys.argv[2]}-stopped').exists(), 5)
    elif operation == 'inflight':
        inflight(sys.argv[2])
    elif operation == 'stream':
        run('docker', 'exec', '-d', '--user', '1000:1000', sandbox(), 'python3', '/opt/verity-boot/boot-client.py', 'poll', sys.argv[2])
    else:
        raise ValueError(operation)
