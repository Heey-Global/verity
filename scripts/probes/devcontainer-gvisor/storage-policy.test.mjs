import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = new URL('../../../deploy/buildkit/', import.meta.url).pathname;
function render(policy, previous) {
  const root = mkdtempSync(join(tmpdir(), 'storage-policy-'));
  try {
    if (policy !== undefined) writeFileSync(join(root, 'policy'), policy);
    if (previous !== undefined) writeFileSync(join(root, 'previous'), previous);
    return spawnSync(
      'bash',
      [
        join(directory, 'storage-policy.sh'),
        join(directory, 'buildkitd.toml'),
        join(root, 'previous'),
        join(root, 'policy'),
        '1202',
      ],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('default storage policy bounds cache and age without changing runtime authority', () => {
  const result = render();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gid = 1202/);
  assert.match(result.stdout, /snapshotter = "auto"/);
  assert.match(result.stdout, /maxUsedSpace = "10737418240"/);
  assert.match(result.stdout, /keepDuration = "72h"/);
  assert.match(result.stdout, /binary = ".*\/runsc"/);
  assert.match(result.stdout, /\[worker.containerd\]\s+enabled = false/);
});

test('policy survives rendering repeatedly and retains the configured OCI snapshotter', () => {
  const policy = 'version=1\nreservedGiB=2\nbudgetGiB=20\nfreeGiB=12\nageHours=48\n';
  const first = render(
    policy,
    'root = "/var/lib/verity-buildkit"\n[worker.oci]\nsnapshotter = "native"\n',
  );
  assert.equal(first.status, 0, first.stderr);
  const second = render(policy, first.stdout);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(second.stdout, /snapshotter = "native"/);
  assert.match(second.stdout, /maxUsedSpace = "21474836480"/);
  assert.match(second.stdout, /minFreeSpace = "12884901888"/);
  assert.match(second.stdout, /keepDuration = "48h"/);
});

test('invalid policy and ambiguous previous snapshotters fail before producing configuration', () => {
  for (const policy of [
    'version=2',
    'budgetGiB=0',
    'budgetGiB=01',
    'reservedGiB=11',
    'ageHours=999999',
    'unknown=1',
    'budgetGiB=$(touch /invalid)',
  ]) {
    const result = render(policy);
    assert.notEqual(result.status, 0, policy);
    assert.equal(result.stdout, '', policy);
  }
  for (const previous of [
    'root = "/custom/state"\n[worker.oci]\nsnapshotter = "native"',
    '[worker.containerd]\nsnapshotter = "native"',
    '[worker.oci]\nsnapshotter = "unknown"',
    '[worker.oci]\nsnapshotter = "native"\nsnapshotter = "overlayfs"',
  ]) {
    assert.notEqual(render(undefined, previous).status, 0, previous);
  }
});

test('installer preserves snapshotter state and renders configuration before replacing it', () => {
  const installer = readFileSync(join(directory, 'install.sh'), 'utf8');
  assert.doesNotMatch(installer, /rm\s+-rf\s+\/var\/lib\/verity-buildkit/);
  const renderAt = installer.indexOf('bash "$source_dir/storage-policy.sh"');
  const replaceAt = installer.indexOf('mv /etc/verity-buildkit/buildkitd.toml.new');
  assert(renderAt > 0 && replaceAt > renderAt);
});
