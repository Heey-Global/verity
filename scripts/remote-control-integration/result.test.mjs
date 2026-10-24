import { test } from 'node:test';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const revisions = { coreRevision: 'a'.repeat(40), uplinkRevision: 'b'.repeat(40) };
const runner = readFileSync(new URL('./run-apple.sh', import.meta.url), 'utf8');
const verifier = runner.match(/<<'VERIFY'\n([\s\S]*?)\nVERIFY/u)?.[1];
assert.ok(verifier, 'The runner must expose its result verifier');

function verify(
  {
    native = true,
    core = true,
    fixtureExit = 0,
    nativeExit = 0,
    missingCore = false,
    missingProvenance = false,
    provenance = revisions,
    nativeFields = {},
    coreFields = {},
    scenario = '',
  } = {},
  source = verifier,
) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-result-'));
  try {
    const paths = ['native', 'core', 'provenance'].map((name) => join(directory, `${name}.json`));
    writeFileSync(paths[0], JSON.stringify({ success: native, ...nativeFields }));
    if (!missingCore) writeFileSync(paths[1], JSON.stringify({ success: core, ...coreFields }));
    if (!missingProvenance) writeFileSync(paths[2], JSON.stringify(provenance));
    return spawnSync(
      'python3',
      [
        '-c',
        source,
        ...paths,
        String(fixtureExit),
        String(nativeExit),
        ...(scenario ? [scenario] : []),
      ],
      {
        encoding: 'utf8',
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void test('reports both receipts even when the fixture exits unsuccessfully', () => {
  const result = verify({ fixtureExit: 1 });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    success: false,
    native: { success: true },
    core: { success: true },
    provenance: revisions,
    fixtureExit: 1,
    nativeExit: 0,
  });
});

void test('requires both successful receipts and successful processes', () => {
  assert.equal(verify().status, 0);
  for (const input of [
    { native: false },
    { core: false },
    { nativeExit: 1 },
    { missingCore: true },
  ]) {
    assert.equal(verify(input).status, 1);
  }
  assert.match(verify({ missingCore: true }).stdout, /core_result_unavailable/u);
});

void test('detects a verifier that ignores abnormal fixture termination', () => {
  const broken = verifier.replace("and sys.argv[4]=='0'", 'and True');
  assert.notEqual(broken, verifier);
  // Successful receipt files can survive an abnormal exit; ignoring that exit would silently pass CI.
  assert.equal(verify({ fixtureExit: 1 }, broken).status, 0);
  assert.equal(verify({ fixtureExit: 1 }).status, 1);
});

void test('rejects absent or malformed source revisions and catches an omitted provenance gate', () => {
  assert.equal(verify({ missingProvenance: true }).status, 1);
  assert.equal(verify({ provenance: { ...revisions, coreRevision: 'main' } }).status, 1);
  assert.equal(verify({ provenance: { ...revisions, uplinkRevision: '' } }).status, 1);
  const broken = verifier.replace('provenance_valid and ', '');
  assert.notEqual(broken, verifier);
  assert.equal(verify({ missingProvenance: true }, broken).status, 0);
});

void test('requires scenario-specific pooled and partial-frame receipts', () => {
  const scenario = 'frame-release';
  const nativeFields = {
    scenario,
    checks: [
      'pooled_large_digest',
      'pooled_small_receipt',
      'pooled_reuse_receipt',
      'pooled_send_receipt',
      'held_frame_released',
    ],
  };
  const coreFields = {
    scenario,
    largeRequests: 1,
    smallRequests: 2,
    sendRequests: 1,
    proxy: { intercepted: 1, missingBytes: 295, released: 1 },
  };
  assert.equal(verify({ scenario, nativeFields, coreFields }).status, 0);
  assert.equal(verify({ scenario }).status, 1);
  assert.equal(
    verify({ scenario, nativeFields: { ...nativeFields, checks: [] }, coreFields }).status,
    1,
  );
  assert.equal(
    verify({
      scenario,
      nativeFields,
      coreFields: { ...coreFields, proxy: { ...coreFields.proxy, released: 0 } },
    }).status,
    1,
  );
});
