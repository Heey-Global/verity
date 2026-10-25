import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const source = (name) =>
  readFileSync(new URL(`../../../deploy/buildkit/${name}`, import.meta.url), 'utf8');
test('production worker preserves snapshots and delegates only to gVisor', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-builder-'));
  try {
    const runtime = join(root, 'runsc-real');
    writeFileSync(
      runtime,
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(runtime, 0o755);
    const adapter = join(root, 'runsc-buildkit-args.sh');
    writeFileSync(adapter, source('runsc-buildkit-args.sh'));
    chmodSync(adapter, 0o755);
    const wrapper = join(root, 'runsc');
    writeFileSync(wrapper, source('runsc').replaceAll('/usr/local/libexec/verity-buildkit', root));
    const result = spawnSync('sh', [wrapper, 'run', '--bundle', '/bundle path', '--keep', 'id'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      '--platform=systrap',
      '--network=sandbox',
      '--overlay2=none',
      'run',
      '--bundle',
      '/bundle path',
      'id',
    ]);
    rmSync(runtime);
    assert.equal(spawnSync('sh', [wrapper, 'run', 'id']).status, 127);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('host configuration restricts worker authority and bounds service resources', () => {
  const config = source('buildkitd.toml');
  assert.match(config, /^insecure-entitlements = \[\]$/m);
  assert.match(config, /^ {2}address = \["unix:\/\/\/run\/verity-buildkit\/buildkitd.sock"\]$/m);
  assert.match(
    config,
    /\[worker\.oci\][\s\S]*binary = "\/usr\/local\/libexec\/verity-buildkit\/runsc"/,
  );
  assert.match(config, /max-parallelism = 1/);
  assert.match(config, /noProcessSandbox = false/);
  assert.match(config, /\[worker\.containerd\]\s+enabled = false/);
  const unit = source('verity-buildkit.service');
  for (const constraint of [
    'MemoryMax=2G',
    'MemorySwapMax=0',
    'CPUQuota=100%',
    'TasksMax=512',
    'ProtectSystem=strict',
    'RuntimeDirectoryPreserve=yes',
    'NoNewPrivileges=yes',
  ])
    assert(unit.includes(constraint), constraint);
  assert.match(unit, /^InaccessiblePaths=.*\/run\/docker.sock.*\/var\/run\/docker.sock/m);
});
