import { test } from 'node:test';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(new URL('./run-apple.sh', import.meta.url), 'utf8');
const suite = runner.match(/case "\$scenario" in\n([\s\S]*?)\nesac/u)?.[0];
assert.ok(suite, 'The runner must select the integration scenarios');

function run(source = suite, fail = '') {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -e
scenario=suite
platform=macos
uplink_root=/fixture
bash() { printf '%s\\n' "$4"; [[ "$4" != "$FAIL_SCENARIO" ]]; }
${source}`,
    ],
    { encoding: 'utf8', env: { ...process.env, FAIL_SCENARIO: fail } },
  );
}

void test('runs loss before a separate recovery invocation and propagates either failure', () => {
  const success = run();
  assert.equal(success.status, 0);
  assert.deepEqual(success.stdout.trim().split('\n'), ['loss', 'recovery']);
  const loss = run(suite, 'loss');
  assert.notEqual(loss.status, 0);
  assert.equal(loss.stdout.trim(), 'loss');
  assert.notEqual(run(suite, 'recovery').status, 0);
});

void test('detects silently omitting the fault scenario', () => {
  const broken = suite.replace(/^.*bash .* loss\n/mu, '');
  assert.notEqual(broken, suite);
  // Recovery alone would stay green even if the preceding fault never ran.
  assert.equal(run(broken).status, 0);
  assert.notDeepEqual(run(broken).stdout.trim().split('\n'), ['loss', 'recovery']);
});
