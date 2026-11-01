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
                                       ('direct-revoked', False), ('authority-empty', False)]
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
    for key, allowed in expected.items():
        for protocol in ('tcp', 'udp'):
            assert any(r.get('kind') == protocol and r.get('marker') == key + '-' + protocol for r in records) is allowed, key
    markers = {key + '-' + protocol for key, allowed in expected.items() if allowed for protocol in ('tcp', 'udp')}
    markers.add('stream-retained')
    assert all(row.get('marker') in markers for row in records if 'marker' in row), 'Unauthorized receipt'
    live, expired, attempted = (proof[k] for k in ('live', 'expired', 'attempted'))
    deadline = int(live['deadline_ns'])
    assert deadline > 0 and live['accepted'] > 0
    assert int(expired['clocks']['bootBeforeNs']) >= deadline
    assert int(attempted['clocks']['bootBeforeNs']) > int(expired['clocks']['bootBeforeNs'])
    assert expired['accepted'] == attempted['accepted'] and attempted['denied'] > expired['denied']
    assert int(attempted['last_accepted_boot_ns']) < deadline
    retained = [int(row['boot_ns']) for row in records if row.get('marker') == 'stream-retained']
    assert retained and max(retained) - min(retained) >= 2_000_000_000
    assert max(retained) - deadline <= 2_000_000_000
    start = int(proof['heartbeatWindowStart']['clocks']['bootBeforeNs'])
    end = int(proof['heartbeatWindowEnd']['clocks']['bootBeforeNs'])
    assert start > deadline + 2_000_000_000 and end - start >= 200_000_000
    before, after = proof['heartbeatBefore'], proof['heartbeat']
    assert before['attempts'] > 10 and after['attempts'] > before['attempts']
    # Compare guest timestamps only with guest timestamps, never host BOOTTIME.
    assert int(after['boot_ns']) > int(before['boot_ns'])
    return {'complete': True, 'cases': len(cases), 'kernel_late_acceptance': False,
            'receiver_tail_seconds': max(0, (max(retained) - deadline) / 1_000_000_000)}


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1])))
