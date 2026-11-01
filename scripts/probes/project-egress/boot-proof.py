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


def verify_receipts(path, start_ns, end_ns, through_ns=None):
    import base64
    records = [json.loads(line) for line in Path(path).read_text().splitlines()]
    if through_ns is not None:
        records = [row for row in records if row['time_ns'] <= through_ns]
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



def remove_fences_mutation(vm, guest, evidence):
    # The in-flight control readmits while the kernel fences are intact and removes
    # them itself. Readmitting an already tampered generation is refused and contained
    # by the TC attestation, so removal must not precede it. The receipt window
    # starts only after that removal has returned.
    inflight = json.loads(vm.ssh(guest + 'inflight removed-fences', timeout=20))
    (evidence / 'mutation-inflight.json').write_text(json.dumps(inflight))
    assert inflight.get('fencesRemoved') is True, 'In-flight control did not remove the kernel fences'
    started_ns = time.time_ns()
    vm.ssh(guest + 'external')
    return started_ns, inflight


def verify_boot_denial(ruleset):
    # Old per-generation label rules may remain, but neither bootstrap chain may
    # contain a bypass before explicit lifecycle recovery.
    rows = ruleset['nftables']
    for family in ('inet', 'bridge'):
        table = 'verity_egress_boot'
        assert sum(row.get('table', {}).get('family') == family and row['table']['name'] == table
                   for row in rows if 'table' in row) == 1, 'Missing bootstrap denial table'
        for hook in ('forward', 'input'):
            chains = [row['chain'] for row in rows if 'chain' in row
                      and row['chain'].get('family') == family and row['chain'].get('table') == table
                      and row['chain'].get('name') == hook]
            assert len(chains) == 1, 'Missing bootstrap denial chain'
            chain = chains[0]
            assert (chain['type'], chain['hook'], chain['prio'], chain['policy']) == (
                'filter', hook, -220, 'accept'), 'Changed bootstrap hook'
            rules = [row['rule'] for row in rows if 'rule' in row
                     and row['rule'].get('family') == family and row['rule'].get('table') == table
                     and row['rule'].get('chain') == hook]
            keys = ('iifname', 'oifname') if family == 'inet' else ('ibrname', 'obrname')
            if hook == 'input':
                keys = keys[:1]
            assert len(rules) == len(keys), 'Bootstrap contains an admission or lacks denial'
            for rule, key in zip(rules, keys):
                expressions = rule['expr']
                assert len(expressions) == 3, 'Changed bootstrap denial expression'
                assert expressions[0] == {'match': {'op': '==', 'left': {'meta': {'key': key}},
                                                   'right': 'vep*'}}, 'Changed bootstrap identity'
                assert set(expressions[1]) == {'counter'} and expressions[2] == {'drop': None}, 'Missing bootstrap drop'


def verify_packet(snapshot):
    spec = importlib.util.spec_from_file_location('deadline_guard', Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py')
    deadline = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deadline)
    packets = snapshot['packet']
    assert len(packets) == 1, 'Missing combined packet guard'
    packet = packets[0]
    raw, program = packet['raw'], packet['program']
    state = raw['state']
    assert raw['identity'] == deadline.binding_key(state['binding'])
    assert state['binding']['containerId'] in {row['id'] for row in snapshot['containers']}
    assert raw['deadline_ns'] == '0', 'Boot recovery unexpectedly admitted direct traffic'
    assert program['type'] == 'sched_cls' and program['id'] == state['program'] and program['id'] > 0
    assert state['relayPolicy'] and raw['clocks']['bootId'] == state['bootId']
    assert set(packet['hooks']) == {'ingress', 'egress'}
    for hooks in packet['hooks'].values():
        deadline.attest_filters(hooks, program['id'])
    tables = [row['table'] for row in snapshot['tables'] if 'table' in row]
    for family in ('inet', 'bridge'):
        assert any(row['family'] == family and row['name'].startswith('verity_start_') for row in tables), 'Missing startup nft fence'


def verify_retained(before, after):
    assert before['projectId'] == after['projectId']
    assert before['registry'] == after['registry'], 'Registry generation or container identities changed'
    prior = {c['id']: c for c in before['containers']}
    current = {c['id']: c for c in after['containers']}
    assert len(prior) == 2 and prior.keys() == current.keys(), 'Actual project topology was replaced'
    for identity, container in current.items():
        assert container['restart'] == 'no' and container['running']
        assert container['mounts'] == prior[identity]['mounts'] and container['image'] == prior[identity]['image']



def verify_replacement(before, after):
    assert before['projectId'] == after['projectId']
    old = before['packet'][0]['raw']['state']['binding']
    new = after['packet'][0]['raw']['state']['binding']
    assert old['generation'] != new['generation'] and old['networkId'] != new['networkId']
    assert old['containerId'] != new['containerId'] and old['endpointId'] != new['endpointId']
    records = after['registry']['records']
    assert any(row['retired'] and row['binding']['generation'] == old['generation'] for row in records)
    active = [row for row in records if not row['retired'] and row['binding']['projectId'] == after['projectId']]
    assert len(active) == 1 and active[0]['binding']['generation'] == new['generation']
    prior = before['containers']
    current = after['containers']
    assert len(prior) == len(current) == 2
    assert {c['id'] for c in prior}.isdisjoint(c['id'] for c in current)
    assert set(active[0]['containers'].values()) == {c['id'] for c in current}
    # Generation-specific credentials and sockets must change. Project data stays
    # mounted from the same source and both trusted image identities are retained.
    assert sorted(c['image'] for c in prior) == sorted(c['image'] for c in current)
    for container in current:
        assert container['restart'] == 'no' and container['running']
    def data_mounts(rows):
        return sorted((m['Destination'], m['Source']) for row in rows for m in row['mounts']
                      if isinstance(m, dict) and m['Destination'] in ('/work', '/knowledge'))
    assert data_mounts(prior) and data_mounts(prior) == data_mounts(current)


def verify_bundle(directory):
    directory = Path(directory)
    proof = json.loads((directory / 'boot-proof.json').read_text())
    assert proof['complete'] is True and proof['removed_fences_detected'] is True
    initial = json.loads((directory / 'topology-before.json').read_text())
    verify_packet(initial)
    events = proof['events']
    assert [event['event'] for event in events] == ['controller-kill', 'server-kill', 'docker-stop-start', 'docker-crash', 'reboot']
    previous = initial
    for event in events:
        assert proof['protected_start_ns'] <= event['event_time_ns'] <= proof['protected_end_ns']
        if event['event'] in ('docker-stop-start', 'docker-crash', 'reboot'):
            verify_replacement(previous, event['retained'])
        else:
            verify_retained(previous, event['retained'])
        previous = event['retained']
        verify_packet(event['retained'])
        if event['event'] != 'server-kill':
            verify_boot_denial(json.loads((directory / (event['event'] + '-denied-rules.json')).read_text()))
        assert event['recovery_ns'] > 0
        before = event['stream_before']
        after = event['stream_after']
        assert before['successes'] >= 3 and before['attempts'] >= before['successes']
        for key in ('last_success_ns', 'last_receipt_ns', 'heartbeat_ns'):
            assert 0 <= event['event_time_ns'] - before[key] <= 2_000_000_000, 'Polling positive was stale before disruption'
        if event['event'] in ('controller-kill', 'server-kill'):
            assert after['attempts'] > before['attempts'], 'Polling stopped before disruption'
            assert after['observed_ns'] - event['event_time_ns'] >= 2_000_000_000, 'Revocation window was not observed'
            assert 0 <= after['observed_ns'] - after['heartbeat_ns'] < 2_000_000_000, 'Polling did not continue after disruption'
        process = {'controller-kill': 'controller', 'server-kill': 'server', 'docker-stop-start': 'docker', 'docker-crash': 'docker'}.get(event['event'])
        if process:
            assert event['process_before'][process] > 0 and event['process_after'][process] > 0
            assert event['process_before'][process] != event['process_after'][process], 'Required process was not restarted'
        for key in ('last_success_ns', 'last_receipt_ns'):
            assert event['stream_after'][key] - event['event_time_ns'] <= 2_000_000_000
        if event['event'] == 'reboot':
            boot_vm.check_reboot(event['before'], event['after'])
    verify_receipts(directory / 'protected-receipts.jsonl', proof['protected_start_ns'], proof['protected_end_ns'])
    full = (directory / 'external-receipts.jsonl').read_text()
    assert full.startswith((directory / 'protected-receipts.jsonl').read_text()), 'Protected evidence is not an original observation prefix'
    verify_receipts(directory / 'external-receipts.jsonl', proof['protected_start_ns'], proof['protected_end_ns'], proof['mutation_started_ns'])
    verify_removed_fences(directory / 'external-receipts.jsonl', proof['mutation_started_ns'])
    receipts = [json.loads(line) for line in (directory / 'broker-receipts.jsonl').read_text().splitlines()]
    for event in events:
        matching = [int(row['time_ns']) for row in receipts if row['phase'] == event['event']]
        assert matching, 'No actual authenticated handler positive control'
        assert event['stream_before']['last_receipt_ns'] in matching, 'Fresh polling receipt has no actual handler evidence'
        assert max(matching) - event['event_time_ns'] <= 2_000_000_000, 'Actual handler committed after revocation bound'
    inflight = json.loads((directory / 'inflight.json').read_text())
    for phase, result in inflight.items():
        assert (result['status'] == 200) == (phase == 'positive')
        assert result['finished_ns'] - result['started_ns'] < 10_000_000_000
    assert set(inflight) == {'positive', 'denied'}
    mutation = json.loads((directory / 'mutation-inflight.json').read_text())
    assert mutation['status'] == 200 and mutation.get('fencesRemoved') is True
    assert set(proof['faults']) == {'corrupt-registry-denied', 'nftables-failure-denied', 'unsupported-live-restore-denied'}
    return {'events': len(events), 'removed_fence_paths': 8, 'complete': True}


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable CI only'
    evidence = Path(sys.argv[3]).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    link = f'vebo{os.getpid()}'
    observer = None
    vm = boot_vm.BootVM(sys.argv[1], evidence, link, disk_gib=32)
    root = Path(__file__).resolve().parent
    ready = evidence / 'observer.pid'
    receipts = evidence / 'external-receipts.jsonl'
    events = []
    try:
        command('sudo', '-n', 'ip', 'tuntap', 'add', 'dev', link, 'mode', 'tap', 'user', str(os.getuid()))
        command('sudo', '-n', 'ip', 'addr', 'add', '172.30.105.2/24', 'dev', link)
        command('sudo', '-n', 'ip', '-6', 'addr', 'add', 'fd42:feed:5::2/64', 'nodad', 'dev', link)
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
        previous = initial
        for event in ('controller-kill', 'server-kill', 'docker-stop-start', 'docker-crash', 'reboot'):
            vm.ssh(guest + f'stream {event}')
            time.sleep(1)
            stream_before = json.loads(vm.ssh(guest + f'stream-status {event}'))
            assert stream_before['successes'] >= 3 and stream_before['last_receipt_ns'], 'Authenticated polling positive control failed'
            before = vm.facts()
            process_before = json.loads(vm.ssh(guest + 'process-facts'))
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
            vm.ssh('sudo systemctl reset-failed verity-boot-server.service; sudo systemctl start verity-egress-host.service', timeout=60)
            if event != 'server-kill':
                rules = vm.ssh('sudo nft -j list ruleset')
                (evidence / (event + '-denied-rules.json')).write_text(rules)
                verify_boot_denial(json.loads(rules))
            time.sleep(2)
            stream_after = json.loads(vm.ssh(guest + f'stream-status {event}'))
            assert max(stream_after['last_success_ns'], stream_after['last_receipt_ns']) - event_time <= 2_000_000_000, 'Observed revocation exceeded two seconds'
            if event in ('controller-kill', 'server-kill'):
                now = int(vm.ssh('date +%s%N').strip())
                assert now - stream_after['heartbeat_ns'] < 2_000_000_000, 'Project poll stopped attempting authenticated requests'
            vm.ssh(guest + f'stop-poll {event}')
            recovery_start = time.monotonic_ns()
            try:
                replace = event in ('docker-stop-start', 'docker-crash', 'reboot')
                vm.ssh(guest + ('recover replace' if replace else 'recover'), timeout=240)
            except subprocess.CalledProcessError as error:
                (evidence / (event + '-recovery-error.txt')).write_text(str(error.output))
                raise
            after = json.loads(vm.ssh(guest + 'snapshot'))
            if replace:
                verify_replacement(previous, after)
            else:
                verify_retained(previous, after)
            previous = after
            vm.ssh(guest + 'external')
            events.append({'event': event, 'event_time_ns': event_time, 'before': before, 'after': vm.facts(),
                           'recovery_ns': time.monotonic_ns() - recovery_start, 'retained': after,
                           'process_before': process_before, 'process_after': json.loads(vm.ssh(guest + 'process-facts')),
                           'stream_before': stream_before, 'stream_after': stream_after})
            (evidence / 'events.json').write_text(json.dumps(events, indent=2))
        faults = json.loads(vm.ssh(guest + 'faults', timeout=180))
        (evidence / 'faults.json').write_text(json.dumps(faults))
        vm.ssh(guest + 'recover replace', timeout=240)
        verify_replacement(previous, json.loads(vm.ssh(guest + 'snapshot')))
        vm.ssh(guest + 'observer-positive after')
        end_ns = time.time_ns()
        time.sleep(0.2)
        protected = evidence / 'protected-receipts.jsonl'
        protected.write_text(receipts.read_text())
        verify_receipts(protected, start_ns, end_ns)
        # Removing the real kernel fences must turn independent receiver silence
        # into a failed verdict; a synthetic verifier test is insufficient here.
        mutation_started_ns, _ = remove_fences_mutation(vm, guest, evidence)
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
            'protected_end_ns': end_ns, 'mutation_started_ns': mutation_started_ns,
            'removed_fences_detected': True, 'faults': faults,
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
    if len(sys.argv) == 3 and sys.argv[1] == 'verify':
        print(json.dumps(verify_bundle(sys.argv[2])))
    else:
        main()
