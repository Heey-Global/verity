"""Actual service/daemon/kernel events with observation outside the disposable VM."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('boot_vm', Path(__file__).with_name('boot-vm.py'))
boot_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot_vm)


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def verify_receipts(path, start_ns, end_ns):
    import base64
    records = [json.loads(line) for line in Path(path).read_text().splitlines()]
    beats = [r['time_ns'] for r in records if r['kind'] in ('ready', 'heartbeat', 'stopped')]
    assert beats and beats[0] <= start_ns and beats[-1] >= end_ns, 'Receiver did not cover lifecycle window'
    assert max(b - a for a, b in zip(beats, beats[1:])) <= 2_000_000_000, 'Independent observation paused'
    expected = {f'outer-positive-{phase}-{family}-{protocol}-{port}'.encode()
                for phase in ('before', 'after') for family in (2, 10)
                for protocol, port in [('udp', 53), ('udp', 8080), ('tcp', 443)]}
    seen = set()
    for record in records:
        if record['kind'] == 'received':
            payload = base64.b64decode(record['data'])
            assert payload in expected, 'Unauthorized external receipt'
            seen.add(payload)
    assert seen == expected, 'External dual-stack positive controls incomplete'
    return len(records)


def verify_removed_fences(path, started_ns):
    import base64
    expected = {f'direct-{family}-{protocol}-{port}-own-credential-marker'.encode()
                for family in (2, 10) for protocol, port in [('udp', 53), ('udp', 8080), ('tcp', 443)]}
    expected.update({b'host-startup-marker', b'transferred-startup-marker'})
    observed = set()
    for line in Path(path).read_text().splitlines():
        record = json.loads(line)
        if record['kind'] == 'received' and record['time_ns'] >= started_ns:
            payload = base64.b64decode(record['data'])
            observed.update(marker for marker in expected if marker in payload)
    assert observed == expected, f'Removed fences did not enable every sandbox probe: {expected - observed}'
    return len(observed)


def verify_retained(before, after):
    assert before['projectId'] == after['projectId']
    assert before['registry'] == after['registry'], 'Registry generation or container identities changed'
    prior = {c['id']: c for c in before['containers']}
    current = {c['id']: c for c in after['containers']}
    assert len(prior) == 2 and prior.keys() == current.keys(), 'Actual project topology was replaced'
    for identity, container in current.items():
        assert container['restart'] == 'no' and container['running']
        assert container['mounts'] == prior[identity]['mounts'] and container['image'] == prior[identity]['image']


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable CI only'
    evidence = Path(sys.argv[3]).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    link = f'vebo{os.getpid()}'
    observer = None
    vm = boot_vm.BootVM(sys.argv[1], evidence, link)
    root = Path(__file__).resolve().parent
    ready = evidence / 'observer.pid'
    receipts = evidence / 'external-receipts.jsonl'
    events = []
    try:
        command('sudo', '-n', 'ip', 'tuntap', 'add', 'dev', link, 'mode', 'tap', 'user', str(os.getuid()))
        command('sudo', '-n', 'ip', 'addr', 'add', '172.30.105.2/24', 'dev', link)
        command('sudo', '-n', 'ip', '-6', 'addr', 'add', 'fd42:feed:5::2/64', 'dev', link)
        command('sudo', '-n', 'ip', 'link', 'set', link, 'up')
        observer = subprocess.Popen(['sudo', '-n', 'python3', str(root / 'boot-observer.py'), str(receipts), str(ready)])
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            if observer.poll() is not None:
                raise RuntimeError('External observer failed')
            time.sleep(0.1)
        assert ready.exists(), 'External observer not ready'
        start_ns = time.time_ns()
        vm.start()
        vm.upload(sys.argv[2])
        vm.ssh('sudo env PROJECT_EGRESS_DISPOSABLE=yes bash /opt/verity-fixture/probe/boot-native-install.sh', timeout=600)
        vm.ssh('sudo python3 /opt/verity-fixture/probe/boot-guest.py observer-positive before')
        vm.ssh('sudo python3 /opt/verity-fixture/probe/boot-guest.py setup', timeout=300)
        guest = 'sudo python3 /opt/verity-fixture/probe/boot-guest.py '
        initial = json.loads(vm.ssh(guest + 'snapshot'))
        (evidence / 'topology-before.json').write_text(json.dumps(initial, indent=2))
        # Observe real denial while actual first-instruction inherited/transferred emitters run.
        vm.ssh(guest + 'external')
        time.sleep(2)
        inflight = {phase: json.loads(vm.ssh(guest + f'inflight {phase}', timeout=20)) for phase in ('positive', 'denied')}
        (evidence / 'inflight.json').write_text(json.dumps(inflight))
        for event in ('controller-kill', 'server-kill', 'docker-stop-start', 'docker-crash', 'reboot'):
            vm.ssh(guest + f'stream {event}')
            time.sleep(1)
            stream_before = json.loads(vm.ssh(guest + f'stream-status {event}'))
            assert stream_before['successes'] >= 3 and stream_before['last_receipt_ns'], 'Authenticated polling positive control failed'
            before = vm.facts()
            event_time = int(vm.ssh('date +%s%N').strip())
            if event == 'controller-kill':
                vm.ssh('sudo systemctl kill --kill-whom=main --signal=SIGKILL verity-egress-host.service')
            elif event == 'server-kill':
                vm.ssh('sudo systemctl kill --kill-whom=main --signal=SIGKILL verity-boot-server.service')
            else:
                vm.ssh('sudo systemctl stop verity-boot-server.service')
                if event == 'docker-stop-start':
                    vm.ssh('sudo systemctl stop docker.service; sudo systemctl start docker.service', timeout=90)
                elif event == 'docker-crash':
                    vm.ssh('sudo systemctl kill --kill-whom=main --signal=SIGKILL docker.service')
                else:
                    try:
                        vm.ssh('sudo systemctl reboot')
                    except subprocess.CalledProcessError as error:
                        if error.returncode != 255:
                            raise
                    boot_vm.check_reboot(before, vm.wait_ready(before['boot_id']))
            # No Server process is allowed to count as recovery until a new explicit
            # real lifecycle wake has validated the retained identities and mounted secrets.
            recovery_start = time.monotonic_ns()
            vm.ssh('sudo systemctl reset-failed verity-boot-server.service; sudo systemctl start verity-egress-host.service', timeout=60)
            if event != 'server-kill':
                rules = vm.ssh('sudo nft list ruleset')
                assert 'ct label set' not in rules, 'Controller/daemon restored a prior admission'
            time.sleep(2)
            stream_after = json.loads(vm.ssh(guest + f'stream-status {event}'))
            assert max(stream_after['last_success_ns'], stream_after['last_receipt_ns']) - event_time <= 2_000_000_000, 'Observed revocation exceeded two seconds'
            if event in ('controller-kill', 'server-kill'):
                now = int(vm.ssh('date +%s%N').strip())
                assert now - stream_after['heartbeat_ns'] < 2_000_000_000, 'Project poll stopped attempting authenticated requests'
            vm.ssh(guest + f'stop-poll {event}')
            vm.ssh(guest + 'recover', timeout=240)
            after = json.loads(vm.ssh(guest + 'snapshot'))
            verify_retained(initial, after)
            vm.ssh(guest + 'external')
            events.append({'event': event, 'event_time_ns': event_time, 'before': before, 'after': vm.facts(),
                           'recovery_ns': time.monotonic_ns() - recovery_start, 'retained': after,
                           'stream_before': stream_before, 'stream_after': stream_after})
            (evidence / 'events.json').write_text(json.dumps(events, indent=2))
        faults = json.loads(vm.ssh(guest + 'faults', timeout=180))
        (evidence / 'faults.json').write_text(json.dumps(faults))
        vm.ssh(guest + 'recover', timeout=240)
        verify_retained(initial, json.loads(vm.ssh(guest + 'snapshot')))
        vm.ssh(guest + 'observer-positive after')
        end_ns = time.time_ns()
        time.sleep(0.2)
        protected = evidence / 'protected-receipts.jsonl'
        protected.write_text(receipts.read_text())
        verify_receipts(protected, start_ns, end_ns)
        # Removing the real kernel fences must turn independent receiver silence
        # into a failed verdict; a synthetic verifier test is insufficient here.
        mutation_started_ns = time.time_ns()
        vm.ssh(guest + 'remove-fences')
        vm.ssh(guest + 'external')
        mutation_inflight = json.loads(vm.ssh(guest + 'inflight removed-fences', timeout=20))
        (evidence / 'mutation-inflight.json').write_text(json.dumps(mutation_inflight))
        time.sleep(1)
        verify_removed_fences(receipts, mutation_started_ns)
        try:
            verify_receipts(receipts, start_ns, end_ns)
        except AssertionError as failure:
            assert str(failure) == 'Unauthorized external receipt', failure
        else:
            raise AssertionError('Removing actual kernel fences was not detected')
        (evidence / 'boot-proof.json').write_text(json.dumps({
            'complete': True, 'events': events, 'protected_start_ns': start_ns,
            'protected_end_ns': end_ns, 'removed_fences_detected': True, 'faults': faults,
        }, indent=2))
    finally:
        if vm.process and vm.process.poll() is None:
            for name, shell in [('journal.txt', 'sudo journalctl --no-pager -u docker -u verity-egress-host -u verity-boot-server -u verity-boot-gateway'),
                                ('firewall.txt', 'sudo nft list ruleset'),
                                ('broker-receipts.jsonl', 'sudo cat /var/lib/verity-egress-fixture/broker-receipts.jsonl')]:
                try:
                    (evidence / name).write_text(vm.ssh(shell, timeout=15))
                except subprocess.SubprocessError as error:
                    (evidence / name).write_text(str(error))
        vm.close()
        if observer:
            observer.terminate()
            try:
                observer.wait(timeout=5)
            except subprocess.TimeoutExpired:
                observer.kill()
                observer.wait()
        command('sudo', '-n', 'ip', 'link', 'del', link)


if __name__ == '__main__':
    main()
