"""Independently verify actual-adapter raw maps and receiver records."""
import json
from pathlib import Path
import re
import sys


def verify(directory):
    root = Path(directory)
    report = json.loads((root / 'adapter-result.json').read_text())
    proof = json.loads((root / 'adapter-deadline-proof.json').read_text())
    assert report['complete'] is True and proof['complete'] is True
    required = {}
    for phase, expected in [('positive-a', True), ('positive-b', True), ('allowed-a', True),
                            ('denied-b', False), ('lease-expiry', False), ('before-revoke', True),
                            ('revoked', False), ('removed-fence', True)]:
        for kind in ('tcp', 'udp'):
            for address in ('11.77.3.2', '2001:4860:feed:3::2'):
                required[f'{phase}-{kind}-{address}'] = expected
    required.update({'peer-positive': True, 'peer-denied': False, 'deadline-fresh-after-renewal': True})
    cases = report['cases']
    assert len(cases) == len(required) and {c['case'] for c in cases} == required.keys()
    records = [json.loads(line) for line in (root / 'adapter-receiver.jsonl').read_text().splitlines()]
    peer = [json.loads(line) for line in (root / 'adapter-peer.jsonl').read_text().splitlines()]
    for case in cases:
        expected = required[case['case']]
        assert case['expected'] is expected and case['observed'] is expected
        marker = re.sub('[^a-z0-9]', '-', case['case'], flags=re.I)
        source = peer if case['case'].startswith('peer-') else records
        assert any(r.get('marker') == marker for r in source) is expected, case['case']
    baseline, positive, before, after = (proof[k] for k in ('baseline', 'positive', 'expiredBefore', 'expiredAfter'))
    deadline = int(positive['deadline_ns'])
    assert deadline > 0 and positive['accepted'] > baseline['accepted']
    assert 0 < deadline - int(positive['state']['lastCapturedNs']) <= 1_000_000_000
    for observation in (positive, before, after):
        assert observation['identity'] == positive['identity']
        assert observation['state']['program'] == positive['state']['program'] > 0
        assert observation['state']['peer'] == positive['state']['peer']
        assert int(observation['deadline_ns']) == deadline
        assert int(observation['last_accepted_boot_ns']) < deadline, 'Kernel accepted after expiry'
    assert int(before['clocks']['bootBeforeNs']) >= deadline
    assert int(after['clocks']['bootBeforeNs']) >= int(before['clocks']['bootBeforeNs'])
    assert after['accepted'] == before['accepted'], 'Kernel admitted attempted expired traffic'
    assert after['denied'] > before['denied'], 'No kernel-observed expired attempts'
    assert int(after['last_denied_boot_ns']) >= deadline
    retained = [json.loads(line) for line in (root / 'adapter-deadline-receiver.jsonl').read_text().splitlines()]
    markers = {r.get('marker') for r in retained}
    assert 'deadline-retained-live' in markers and 'deadline-fresh-after-renewal' in markers
    assert not {'deadline-retained-expired', 'deadline-retained-renewed'} & markers
    stream = [r for r in retained if r.get('marker', '').startswith('deadline-stream-')]
    assert len(stream) >= 2, 'Missing continuous retained-stream positive control'
    last_receipt = max(int(r['boot_ns']) for r in stream)
    tail = (last_receipt - deadline) / 1_000_000_000
    assert tail <= 2, 'Observed receiver closure exceeded two seconds'
    return {'cases': len(cases), 'complete': True, 'kernel_late_acceptance': False,
            'last_receiver_offset_seconds': tail, 'observed_closure_seconds': max(0, tail)}


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1])))
