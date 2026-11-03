"""Kernel deadline feasibility on an actual disposable KVM guest."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time

spec = importlib.util.spec_from_file_location('boot_vm', Path(__file__).with_name('boot-vm.py'))
boot_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot_vm)


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def verify(directory):
    root = Path(directory)
    result = json.loads((root / 'deadline-proof.json').read_text())
    assert result['complete'] is True
    expected = {'expired', 'delayed-commit', 'suspend', 'vm-pause', 'wall-forward', 'wall-backward', 'wall-forward-backward'}
    assert {c['name'] for c in result['cases']} == expected
    for case in result['cases']:
        if not case['name'].startswith('wall-forward'):
            assert case['after']['denied'] > case['before']['denied'], 'No attempted post-expiry traffic'
        if case['name'].startswith('wall-forward'):
            assert case['wall_expired_after'] > case['wall_expired_before'], 'Absolute nft deadline did not deny'
        else:
            assert case['after']['accepted'] == case['before']['accepted'], 'Kernel admitted post-deadline traffic'
        assert case['after']['last_accepted_boot_ns'] < case['lease']['deadline_ns']
        assert case['positive']['accepted'] > case['baseline']['accepted'], 'Missing kernel positive control'
        if case['name'].startswith('wall-'):
            assert case['wall_positive_after']['accepted'] > case['wall_positive_before']['accepted'], 'No positive through absolute nft guard'
        if case['name'] == 'suspend':
            a, b = case['clocks_before'], case['after']['clocks']
            assert (b['boot_ns'] - a['boot_ns']) - (b['mono_ns'] - a['mono_ns']) >= 2_000_000_000, 'No actual guest suspend'
        if case['name'] == 'vm-pause':
            assert case['outer_pause_ns'] >= 3_000_000_000
        if case['name'] == 'delayed-commit':
            assert case['lease']['committed']['boot_ns'] > case['lease']['deadline_ns']
        if case['name'] == 'wall-forward-backward':
            assert case['latch_after'] > case['latch_before'], 'Expired authority revived after wall rollback'
            assert case['rollback_clocks']['real_ns'] < case['wall_deadline_real_ns']
            assert case['after']['clocks']['boot_ns'] < case['lease']['deadline_ns'], 'BOOTTIME masked missing expiry latch'
    records = [json.loads(line) for line in (root / 'external-receipts.jsonl').read_text().splitlines()]
    beats = [r['monotonic_ns'] for r in records if r['kind'] in ('heartbeat', 'ready', 'stopped')]
    assert beats[0] <= result['started_mono_ns'] and beats[-1] >= result['finished_mono_ns']
    assert max(b - a for a, b in zip(beats, beats[1:])) <= 2_000_000_000
    payloads = [base64.b64decode(r['data']).decode() for r in records if r['kind'] == 'received']
    expected_payloads = {f'positive-{c["name"]}' for c in result['cases']}
    expected_payloads.update(f'wall-live-{c["name"]}' for c in result['cases'] if c['name'].startswith('wall-'))
    expected_payloads.update({'positive-zero', 'positive-mutation-wall', 'mutation-removed-wall', 'mutation-removed-guard'})
    assert set(payloads) == expected_payloads, 'Unexpected or absent external payload'
    for case in result['cases']:
        assert f'positive-{case["name"]}' in payloads
        assert f'expired-{case["name"]}' not in payloads
    inbound = [json.loads(line) for line in (root / 'inbound-receipts.jsonl').read_text().splitlines()]
    markers = {row['marker'] for row in inbound if row['kind'] == 'received'}
    expected_inbound = {'inbound-' + marker for marker in expected_payloads}
    assert markers == expected_inbound, 'Unexpected or absent inbound payload'
    zero = result['zero']
    assert zero['map']['deadline_ns'] == 0 and zero['map']['index'] > 0
    assert zero['positive']['accepted'] > zero['baseline']['accepted']
    assert zero['after']['accepted'] == zero['before']['accepted']
    assert zero['after']['denied'] > zero['before']['denied']
    wall = result['mutations']['wall']
    assert wall['protected_after'] > wall['protected_before']
    assert wall['after']['accepted'] > wall['before']['accepted']
    assert wall['after']['clocks']['real_ns'] >= wall['real_deadline_ns']
    assert wall['after']['last_accepted_boot_ns'] < wall['lease']['deadline_ns']
    guard = result['mutations']['guard']
    assert guard['map']['deadline_ns'] == 0
    assert not any(q['kind'] in ('clsact', 'ingress') for q in guard['removed']['qdiscs'])
    assert guard['before']['accepted'] == guard['removed']['stats']['accepted']
    assert guard['removed']['stats']['accepted'] == guard['after']['accepted']
    assert guard['removed']['stats']['denied'] == guard['after']['denied']
    return {'cases': len(expected), 'complete': True}


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable CI only'
    root = Path(sys.argv[2]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    link = f'vedl{os.getpid()}'
    vm = boot_vm.BootVM(sys.argv[1], root, observation_link=link)
    observer = None
    probe = Path(__file__).resolve().parent
    cases = []
    ready = root / 'observer.pid'
    guest = 'sudo env PROJECT_EGRESS_DISPOSABLE=yes python3 /opt/verity-fixture/deadline-guest.py '
    def call(command, timeout=30):
        return json.loads(vm.ssh(guest + command, timeout=timeout))
    def send(marker):
        vm.ssh('sudo ip netns exec deadline-project env PROJECT_EGRESS_DISPOSABLE=yes '
               'python3 /opt/verity-fixture/deadline-guest.py send ' + marker)
    def send_inbound(marker):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as channel:
            channel.sendto(('inbound-' + marker).encode(), ('172.30.106.2', 8081))
    try:
        run('sudo', '-n', 'ip', 'tuntap', 'add', 'dev', link, 'mode', 'tap', 'user', str(os.getuid()))
        run('sudo', '-n', 'ip', 'addr', 'add', '172.30.105.2/24', 'dev', link)
        run('sudo', '-n', 'ip', '-6', 'addr', 'add', 'fd42:feed:5::2/64', 'nodad', 'dev', link)
        run('sudo', '-n', 'ip', 'link', 'set', link, 'up')
        run('sudo', '-n', 'ip', 'route', 'add', '172.30.106.0/24', 'via', '172.30.105.3', 'dev', link)
        observer = subprocess.Popen(['sudo', '-n', 'python3', str(probe / 'boot-observer.py'),
                                     str(root / 'external-receipts.jsonl'), str(ready)])
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            assert observer.poll() is None
            time.sleep(0.1)
        assert ready.exists()
        started = time.monotonic_ns()
        vm.start()
        with tempfile.NamedTemporaryFile(suffix='.tar') as archive:
            with tarfile.open(archive.name, 'w') as bundle:
                bundle.add(probe / 'deadline-guest.py', arcname='deadline-guest.py')
                for filename in ('deadline-relay-kernel.py', 'test_deadline_relay.py'):
                    bundle.add(probe / filename, arcname=filename)
                bundle.add(probe.parents[2] / 'deploy/egress/project-egress-deadline.bpf.c', arcname='project-egress-deadline.bpf.c')
                bundle.add(probe.parents[2] / 'deploy/egress/project-egress-deadline.py', arcname='project-egress-deadline.py')
            vm.upload(archive.name)
        vm.ssh('sudo apt-get update && sudo apt-get install -y --no-install-recommends clang llvm libbpf-dev bpftool nftables iproute2 util-linux', timeout=300)
        setup = call('setup', timeout=60)
        (root / 'setup.json').write_text(json.dumps(setup))
        try:
            relay = vm.ssh('sudo env PROJECT_EGRESS_DISPOSABLE=yes python3 '
                           '/opt/verity-fixture/deadline-relay-kernel.py', timeout=180)
        except subprocess.CalledProcessError as error:
            (root / 'relay-kernel.txt').write_text(error.output)
            raise
        (root / 'relay-kernel.txt').write_text(relay)
        zero = {'baseline': call('stats')}
        call('arm 3000')
        send('positive-zero')
        send_inbound('positive-zero')
        zero['positive'] = call('stats')
        zero['map'] = call('disarm')
        zero['before'] = call('stats')
        send('zero-denied')
        send_inbound('zero-denied')
        zero['after'] = call('stats')
        for name in ('expired', 'delayed-commit', 'suspend', 'vm-pause', 'wall-forward', 'wall-backward', 'wall-forward-backward'):
            baseline = call('stats')
            # Longer prototype positives isolate capability from a one-second
            # production renewal budget; integration must impose the latter.
            lease = call('arm 3000')
            send('positive-' + name)
            send_inbound('positive-' + name)
            positive = call('stats')
            assert positive['accepted'] > baseline['accepted']
            before_clocks = positive['clocks']
            extra = {}
            if name == 'delayed-commit':
                time.sleep(3.1)
                lease = call('arm 1000 2000')
            elif name == 'suspend':
                vm.ssh('sudo rtcwake -m mem -s 5', timeout=45)
            elif name == 'vm-pause':
                pause_start = time.monotonic_ns()
                os.kill(vm.process.pid, signal.SIGSTOP)
                try:
                    time.sleep(4)
                finally:
                    os.kill(vm.process.pid, signal.SIGCONT)
                extra['outer_pause_ns'] = time.monotonic_ns() - pause_start
            elif name.startswith('wall-'):
                # An unexpired BOOTTIME lease isolates nft's wall-clock guard.
                lease = call('arm 10000')
                real = positive['clocks']['real_ns'] // 1_000_000_000
                extra['wall_deadline_real_ns'] = call('nft ' + str(real + 5))['deadline_real_ns']
                extra['wall_positive_before'] = call('stats')
                send('wall-live-' + name)
                send_inbound('wall-live-' + name)
                extra['wall_positive_after'] = call('stats')
                offset = 10 if name.startswith('wall-forward') else -10
                vm.ssh(f'sudo date -u -s "@{real + offset}"')
                if name == 'wall-backward':
                    # Backward wall-clock movement must never extend BOOTTIME.
                    time.sleep(10.1)
            else:
                time.sleep(3.1)
            if name.startswith('wall-forward'):
                extra['wall_expired_before'] = next(r['counter']['packets'] for r in call('nft-stats')['nftables'] if 'counter' in r)
            before = call('stats')
            send('expired-' + name)
            send_inbound('expired-' + name)
            after = call('stats')
            if name.startswith('wall-forward'):
                extra['wall_expired_after'] = next(r['counter']['packets'] for r in call('nft-stats')['nftables'] if 'counter' in r)
            if name == 'wall-forward-backward':
                vm.ssh(f'sudo date -u -s "@{real - 10}"')
                extra['rollback_clocks'] = call('stats')['clocks']
                extra['latch_before'] = extra['wall_expired_after']
                send('expired-rollback')
                send_inbound('expired-rollback')
                extra['latch_after'] = next(r['counter']['packets'] for r in call('nft-stats')['nftables'] if 'counter' in r)
            case = {'name': name, 'baseline': baseline, 'positive': positive, 'before': before,
                    'after': after, 'lease': lease, 'clocks_before': before_clocks, **extra}
            cases.append(case)
            (root / 'cases.json').write_text(json.dumps(cases, indent=2))
            if name.startswith('wall-forward'):
                assert extra['wall_expired_after'] > extra['wall_expired_before']
            else:
                assert after['accepted'] == before['accepted'], f'Post-deadline kernel acceptance: {name}'
                assert after['denied'] > before['denied'], f'No expiry attempt: {name}'
            if name.startswith('wall-'):
                vm.ssh('sudo nft delete table inet deadline_probe')
        wall = {'lease': call('arm 10000')}
        real = call('stats')['clocks']['real_ns'] // 1_000_000_000
        wall['real_deadline_ns'] = call('nft ' + str(real + 5))['deadline_real_ns']
        send('positive-mutation-wall')
        send_inbound('positive-mutation-wall')
        vm.ssh(f'sudo date -u -s "@{real + 10}"')
        wall['protected_before'] = next(r['counter']['packets'] for r in call('nft-stats')['nftables'] if 'counter' in r)
        send('mutation-wall-protected')
        send_inbound('mutation-wall-protected')
        wall['protected_after'] = next(r['counter']['packets'] for r in call('nft-stats')['nftables'] if 'counter' in r)
        vm.ssh('sudo nft delete table inet deadline_probe')
        wall['before'] = call('stats')
        send('mutation-removed-wall')
        send_inbound('mutation-removed-wall')
        wall['after'] = call('stats')
        guard = {'map': call('disarm'), 'before': call('stats'), 'removed': call('remove-guard')}
        send('mutation-removed-guard')
        send_inbound('mutation-removed-guard')
        guard['after'] = call('stats')
        finished = time.monotonic_ns()
        result = {'complete': True, 'cases': cases, 'zero': zero, 'mutations': {'wall': wall, 'guard': guard},
                  'started_mono_ns': started, 'finished_mono_ns': finished}
        (root / 'deadline-proof.json').write_text(json.dumps(result, indent=2))
    finally:
        if vm.process is not None and vm.process.poll() is None:
            try:
                (root / 'inbound-receipts.jsonl').write_text(vm.ssh('sudo cat /opt/verity-fixture/inbound.jsonl', timeout=20))
                (root / 'journal.txt').write_text(vm.ssh('sudo journalctl -b --no-pager', timeout=20))
            except (subprocess.SubprocessError, OSError):
                pass
        vm.close()
        if ready.exists():
            run('sudo', '-n', 'kill', '-TERM', ready.read_text().strip())
        if observer is not None:
            observer.wait(timeout=10)
        subprocess.run(['sudo', '-n', 'ip', 'link', 'delete', link], check=False)
    print(json.dumps(verify(root)))


if __name__ == '__main__':
    if sys.argv[1:2] == ['verify']:
        print(json.dumps(verify(sys.argv[2])))
    else:
        main()
