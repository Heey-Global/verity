"""Independently check receipts and raw TC observations for the composed host path."""
import json
from pathlib import Path
import sys


def verify(directory):
    root = Path(directory)
    report = json.loads((root / 'composed-result.json').read_text())
    proof = json.loads((root / 'composed-stream-proof.json').read_text())
    records = [json.loads(line) for line in (root / 'composed-receiver.txt').read_text().splitlines()]
    expected = {f'{phase}-{family}': allowed
                for phase, allowed in [('before-admission', False), ('admitted', True),
                                       ('lease-expired', False), ('fresh-after-expiry', True),
                                       ('direct-revoked', False), ('authority-empty', False),
                                       ('helper-expired', False), ('fresh-after-helper', True)]
                for family in range(2)}
    cases = report['cases']
    assert report['complete'] is True and len(cases) == len(expected)
    assert {f'{row["phase"]}-{row["family"]}' for row in cases} == expected.keys()
    initial = [row for row in cases if row['phase'] == 'before-admission']
    for row in initial:
        evidence = row['resolution']
        assert evidence['phase'] == f"before-admission-{row['family']}"
        assert evidence['family'] == (4 if row['family'] == 0 else 6)
        assert evidence['terminal'] == 'EHOSTUNREACH'
        assert 0 < int(evidence['hostBeforeNs']) < int(evidence['hostAfterNs'])
    assert int(initial[0]['resolution']['hostAfterNs']) <= int(initial[1]['resolution']['hostBeforeNs'])
    # Admitted connections must not wait for the netstack's next 1-second neighbor
    # probe: the host refresh after arming has to complete denied resolution at once.
    for row in cases:
        key = f'{row["phase"]}-{row["family"]}'
        if expected[key]:
            connect = row['connect']
            assert connect['phase'] == key and connect['family'] == (4 if row['family'] == 0 else 6)
            assert 0 < int(connect['connectNs']) < 500_000_000, key
        else:
            assert 'connect' not in row, key
    for key, allowed in expected.items():
        for protocol in ('tcp', 'udp'):
            assert any(r.get('kind') == protocol and r.get('marker') == key + '-' + protocol for r in records) is allowed, key
    markers = {key + '-' + protocol for key, allowed in expected.items() if allowed for protocol in ('tcp', 'udp')}
    markers.update(('stream-retained', 'helper-retained'))
    assert all(row.get('marker') in markers for row in records if 'marker' in row), 'Unauthorized receipt'
    live, expired, attempted = (proof[k] for k in ('live', 'expired', 'attempted'))
    stream_deadline = int(live['deadline_ns'])
    assert stream_deadline > 0 and live['accepted'] > 0
    assert int(expired['clocks']['bootBeforeNs']) >= stream_deadline
    assert int(attempted['clocks']['bootBeforeNs']) > int(expired['clocks']['bootBeforeNs'])
    assert expired['accepted'] == attempted['accepted'] and attempted['denied'] > expired['denied']
    assert int(attempted['last_accepted_boot_ns']) < stream_deadline
    retained = [int(row['boot_ns']) for row in records if row.get('marker') == 'stream-retained']
    assert retained and max(retained) - min(retained) >= 2_000_000_000
    assert max(retained) - stream_deadline <= 2_000_000_000
    retired = json.loads((root / 'retired-containers.json').read_text())
    assert set(retired) == {'sandbox', 'relay'}
    for role, identity in [('sandbox', live['state']['binding']['containerId']),
                           ('relay', live['state']['relayRegistration']['containerId'])]:
        assert retired[role]['id'] == identity and retired[role]['running'] is False
    start = int(proof['heartbeatWindowStart']['clocks']['bootBeforeNs'])
    end = int(proof['heartbeatWindowEnd']['clocks']['bootBeforeNs'])
    assert start > stream_deadline + 2_000_000_000 and end - start >= 200_000_000
    before, after = proof['heartbeatBefore'], proof['heartbeat']
    assert before['attempts'] > 10 and after['attempts'] > before['attempts']
    # Compare guest timestamps only with guest timestamps, never host BOOTTIME.
    assert int(after['boot_ns']) > int(before['boot_ns'])
    helper = json.loads((root / 'composed-helper-proof.json').read_text())
    assert helper['afterKillState'] in ('gone', 'Z')
    assert helper['signal'] == 'SIGKILL' and helper['helper']['pid'] > 1
    assert '/opt/verity-egress/project-egress-deadline.py\0--worker' in helper['helper']['command']
    live, expired, attempted = (helper[k] for k in ('live', 'expired', 'attempted'))
    deadline = int(live['deadline_ns'])
    assert live['accepted'] > 0 and deadline > int(live['clocks']['bootBeforeNs'])
    assert int(expired['clocks']['bootBeforeNs']) >= deadline
    assert int(attempted['clocks']['bootBeforeNs']) > int(expired['clocks']['bootBeforeNs'])
    assert int(attempted['clocks']['bootBeforeNs']) - int(helper['beforeKill']['clocks']['bootBeforeNs']) <= 2_000_000_000
    assert attempted['accepted'] == expired['accepted']
    stopped = attempted['containers']
    assert {row['Id'] for row in stopped} == {live['state']['binding']['containerId'], live['state']['relayRegistration']['containerId']}
    assert len(stopped) == 2 and all(row['State']['Running'] is False for row in stopped)
    assert int(attempted['last_accepted_boot_ns']) < deadline
    helper_receipts = [int(row['boot_ns']) for row in records if row.get('marker') == 'helper-retained']
    assert helper_receipts and min(helper_receipts) <= int(helper['beforeKill']['clocks']['bootBeforeNs'])
    assert max(helper_receipts) - int(helper['beforeKill']['clocks']['bootBeforeNs']) <= 2_000_000_000
    return {'complete': True, 'cases': len(cases), 'kernel_late_acceptance': False,
            'receiver_tail_seconds': max(0, (max(retained) - stream_deadline) / 1_000_000_000)}


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1])))
