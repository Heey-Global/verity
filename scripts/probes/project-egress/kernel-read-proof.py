"""Disposable-only comparison against the CLI validators; never a runtime fallback."""
import importlib.util
import hashlib
import time
import json
import os
from pathlib import Path
import subprocess

assert os.environ.get('PROJECT_EGRESS_DISPOSABLE') == 'yes'
spec = importlib.util.spec_from_file_location('deadline', '/opt/verity-egress/project-egress-deadline.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def cli(*args):
    return json.loads(subprocess.check_output(args, timeout=5, text=True))


def links(values):
    return sorted((row['ifindex'], row['ifname'], row.get('link_index'), row.get('address'),
                   row.get('linkinfo', {}).get('info_kind')) for row in values)


checks = []
timings = []
def measured(stage, operation):
    started = time.monotonic()
    try:
        return operation()
    finally:
        timings.append({'stage': stage, 'durationMs': (time.monotonic() - started) * 1000})

assert links(measured('host-links', host.kernel_links)) == links(cli('/sbin/ip', '-j', '-d', 'link', 'show'))
checks.append('host-links')
# Comparing the security-relevant flowtable declaration avoids changing packet counters.
def flowtables(value):
    return [row['flowtable'] for row in value['nftables'] if 'flowtable' in row]
assert flowtables(measured('ruleset', host.nft_read)) == flowtables(cli('/usr/sbin/nft', '-j', 'list', 'ruleset'))
checks.append('flow-offload')
for path in host.STATE.glob('*.json'):
    state = json.loads(path.read_text())
    binding = state['binding']
    root = host.PINS / host.binding_key(binding)
    namespace = host.docker_inspect('container', binding['containerId'])
    namespace = json.loads(namespace)[0]['NetworkSettings']['SandboxKey']
    assert links(measured('namespace-links', lambda: host.namespace_links(namespace))) == links(cli('/usr/bin/nsenter', '--net=' + namespace, '/sbin/ip', '-j', '-d', 'link', 'show'))
    checks.append('namespace-links')
    program = measured('bpf-program', lambda: host.kernel_program(root))
    previous = cli('/usr/sbin/bpftool', '-j', 'prog', 'show', 'pinned', str(root / 'guard'))
    if isinstance(previous, list):
        previous = previous[0]
    assert program == {key: previous[key] for key in ('id', 'type')}
    checks.append('bpf-identity')
    table = 'verity_egress_' + hashlib.sha256((binding['projectId'] + ':' + binding['generation']).encode()).hexdigest()[:24]
    def expiry_sets(value):
        return sorted((row['set']['name'], json.dumps(row['set'].get('elem', []), sort_keys=True))
                      for row in value['nftables'] if 'set' in row and row['set']['name'].startswith('expired'))
    assert expiry_sets(measured('expiry-sets', lambda: host.nft_read(table))) == expiry_sets(cli('/usr/sbin/nft', '-j', 'list', 'table', 'inet', table))
    checks.append('expiry-sets')
    for direction in ('ingress', 'egress'):
        host.attest_filters(measured('tc-' + direction, lambda: host.kernel_filters(state['peer']['index'], direction)), program['id'])
        host.attest_filters(cli('/sbin/tc', '-j', 'filter', 'show', 'dev', state['peer']['device'], direction), program['id'])
        checks.append('tc-' + direction)
assert len(checks) >= 6
print(json.dumps({'complete': True, 'checks': checks, 'timings': timings}))
