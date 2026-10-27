import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = new URL('../../../deploy/buildkit/', import.meta.url).pathname;
test('storage service preserves custom diagnostic paths and escapes systemd specifiers', () => {
  const render = (path) =>
    spawnSync(
      'bash',
      [
        join(directory, 'storage-service.sh'),
        join(directory, 'verity-build-storage.service'),
        path,
      ],
      { encoding: 'utf8' },
    );
  const result = render('/var/lib/evidence "custom"%');
  assert.equal(result.status, 0, result.stderr);
  assert(
    result.stdout.includes(
      'Environment="VERITY_HOST_DIAGNOSTIC_DIR=/var/lib/evidence \\"custom\\"%%"',
    ),
  );
  assert(result.stdout.includes('ReadWritePaths="/var/lib/evidence \\"custom\\"%%"'));
  assert.doesNotMatch(result.stdout, /@[A-Z_]+@/);
  for (const path of ['relative', '/', '/data/../other', '/data//other', '/data\nother']) {
    const invalid = render(path);
    assert.notEqual(invalid.status, 0, path);
    assert.equal(invalid.stdout, '');
  }
});

test('read-only report attributes real filesystems and preserves unavailable evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-report-'));
  try {
    const client = join(root, 'buildctl');
    writeFileSync(
      client,
      '#!/bin/sh\nprintf \'[{"Labels":{"org.mobyproject.buildkit.worker.snapshotter":"native"}}]\\n\'\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      'bash',
      [join(directory, 'storage-report.sh'), root, root, root, root, join(root, 'missing')],
      {
        env: { ...process.env, VERITY_BUILDCTL: client, VERITY_STORAGE_REPORT_USAGE: '0' },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert(report.roots.slice(0, 3).every((entry) => entry.state === 'available'));
    assert(Number.isFinite(Date.parse(report.roots[0].observedAt)));
    assert.equal(new Set(report.roots.slice(0, 3).map((entry) => entry.filesystemId)).size, 1);
    assert.equal(report.roots[0].totalBytes, statfsSync(root).blocks * statfsSync(root).bsize);
    assert(report.roots[0].freeInodes > 0);
    assert.equal(report.roots[0].physicalTreeBytes, null);
    assert.equal(report.roots[4].state, 'unavailable');
    assert.equal(report.worker.state, 'available');
    assert.equal(
      report.worker.records[0].Labels['org.mobyproject.buildkit.worker.snapshotter'],
      'native',
    );
    assert.equal(report.activeSolves.state, 'unavailable');
    assert.match(report.accounting, /Do not sum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed worker collection cannot become an overlayfs assertion or an empty success', () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-report-failed-'));
  try {
    const client = join(root, 'buildctl');
    writeFileSync(client, '#!/bin/sh\necho partial-output\nexit 1\n', { mode: 0o755 });
    const result = spawnSync(
      'bash',
      [join(directory, 'storage-report.sh'), root, root, root, root, root],
      {
        env: { ...process.env, VERITY_BUILDCTL: client },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).worker, { state: 'unavailable', records: null });
    assert.equal(readFileSync(client, 'utf8').includes('exit 1'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer delivers bounded collection and updater rollback includes both storage units', () => {
  const installer = readFileSync(join(directory, 'install.sh'), 'utf8');
  const service = readFileSync(join(directory, 'verity-build-storage.service'), 'utf8');
  const timer = readFileSync(join(directory, 'verity-build-storage.timer'), 'utf8');
  const updater = readFileSync(
    new URL('../../../deploy/host/verity-host-builder', import.meta.url),
    'utf8',
  );
  for (const file of [
    'storage-report.sh',
    'publish-storage-report.sh',
    'verity-build-storage.service',
    'verity-build-storage.timer',
  ])
    assert(installer.includes(file), file);
  assert.match(service, /TimeoutStartSec=60/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(timer, /OnUnitInactiveSec=15s/);
  assert.match(updater, /VERITY_BUILD_STORAGE_UNIT_FILE/);
  assert.match(updater, /VERITY_BUILD_STORAGE_TIMER_FILE/);
  assert.match(updater, /systemctl disable --now verity-build-storage.timer/);
});
