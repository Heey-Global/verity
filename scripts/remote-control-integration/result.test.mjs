import { test } from 'node:test';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(new URL('./run-apple.sh', import.meta.url), 'utf8');
const verifier = runner.match(/<<'VERIFY'\n([\s\S]*?)\nVERIFY/u)?.[1];
assert.ok(verifier, 'The runner must expose its result verifier');

function verify(
  { native = true, core = true, fixtureExit = 0, nativeExit = 0, missingCore = false } = {},
  source = verifier,
) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-result-'));
  try {
    const paths = ['native', 'core', 'provenance'].map((name) => join(directory, `${name}.json`));
    writeFileSync(paths[0], JSON.stringify({ success: native }));
    if (!missingCore) writeFileSync(paths[1], JSON.stringify({ success: core }));
    writeFileSync(paths[2], JSON.stringify({ coreRevision: 'test', uplinkRevision: 'test' }));
    return spawnSync('python3', ['-c', source, ...paths, String(fixtureExit), String(nativeExit)], {
      encoding: 'utf8',
    });
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
    provenance: { coreRevision: 'test', uplinkRevision: 'test' },
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
