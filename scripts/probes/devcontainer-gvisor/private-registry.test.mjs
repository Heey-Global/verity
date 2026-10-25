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

for (const { status, message, imageExists, accepted } of [
  {
    status: 1,
    message:
      "[httpOci] ERR: No basic auth credentials to send for registry service 'registry.verity.test:5443'",
    imageExists: false,
    accepted: true,
  },
  { status: 1, message: 'unexpected status: 401 Unauthorized', imageExists: false, accepted: true },
  { status: 0, message: '401 Unauthorized', imageExists: false, accepted: false },
  { status: 124, message: '401 Unauthorized', imageExists: false, accepted: false },
  { status: 137, message: '401 Unauthorized', imageExists: false, accepted: false },
  { status: 1, message: 'connection refused', imageExists: false, accepted: false },
  {
    status: 1,
    message: "No basic auth credentials to send for registry service 'unrelated.test'",
    imageExists: false,
    accepted: false,
  },
  { status: 1, message: '401 Unauthorized', imageExists: true, accepted: false },
]) {
  test(`anonymous rejection: status=${status}, image=${imageExists}, message=${message}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'registry-rejection-'));
    try {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
set -euo pipefail
source "$1"
registry_address=registry.verity.test:5443
build_probe() { printf '%s\\n' "$SAMPLE"; return "$STATUS"; }
docker() { [[ $IMAGE_EXISTS == true ]]; }
expect_auth_failure probe:test "$2"
`,
          'test',
          helperPath,
          join(root, 'negative.log'),
        ],
        {
          env: {
            ...process.env,
            SAMPLE: message,
            STATUS: String(status),
            IMAGE_EXISTS: String(imageExists),
          },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status === 0, accepted, result.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of ['dns-recovers', 'dns-persists', 'tls-failure', 'auth-failure']) {
  test(`registry login readiness: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'registry-login-'));
    try {
      mkdirSync(join(root, 'publisher'));
      // A fake daemon has the same first-read host cache miss as the CI daemon.
      writeFileSync(
        join(root, 'docker'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.COUNTER;
const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
fs.writeFileSync(file, String(count));
const scenario = process.env.SCENARIO;
if (scenario === 'dns-recovers' && count > 1) process.exit(0);
console.error(scenario.startsWith('dns-') ? 'lookup registry.verity.test on 127.0.0.53:53: no such host' : scenario === 'tls-failure' ? 'x509: unknown authority' : '401 Unauthorized');
process.exit(1);
`,
        { mode: 0o755 },
      );
      writeFileSync(join(root, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = spawnSync(
        'bash',
        ['-c', 'set -euo pipefail; source "$1"; registry_login', 'test', helperPath],
        {
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            work: root,
            registry_password: 'synthetic-test-value',
            registry_address: 'registry.verity.test:5443',
            COUNTER: join(root, 'count'),
            SCENARIO: scenario,
          },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status === 0, scenario === 'dns-recovers', result.stderr);
      assert.equal(
        Number(readFileSync(join(root, 'count'), 'utf8')),
        scenario === 'dns-recovers' ? 2 : scenario === 'dns-persists' ? 10 : 1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
