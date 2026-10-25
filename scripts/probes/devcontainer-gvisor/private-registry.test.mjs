import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const helperPath = new URL('./private-registry.sh', import.meta.url).pathname;
test('artifact boundary redacts password and encoded Docker auth recursively', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-redaction-'));
  try {
    mkdirSync(join(root, 'runtime'));
    const password = 'synthetic-secret-for-test';
    const encoded = Buffer.from(`probe:${password}`).toString('base64');
    const file = join(root, 'runtime', 'debug.log');
    writeFileSync(file, `password=${password}; auth=${encoded}; other=evidence`);
    const result = spawnSync(
      'bash',
      ['-c', 'set -euo pipefail; source "$1"; registry_scrub_evidence', 'test', helperPath],
      {
        env: { ...process.env, registry_password: password, PROBE_EVIDENCE: root },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(file, 'utf8');
    assert(!output.includes(password));
    assert(!output.includes(encoded));
    assert(output.includes('other=evidence'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('redaction failure propagates even from conditional cleanup with errexit disabled', () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
set -euo pipefail
source "$1"
registry_password=synthetic-test
PROBE_EVIDENCE=/unused
node() { return 42; }
if registry_scrub_evidence; then exit 0; else exit "$?"; fi
`,
      'test',
      helperPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 42, result.stderr);
});
