import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./ci.sh', import.meta.url), 'utf8');
const helper = source.match(/^expect_failure\(\) \{[\s\S]*?^\}/m)?.[0];
const expected = source.match(/^expect_failure "\$stopped_image" "[^"\n]+" (.+)$/m)?.[1];
assert(helper && expected, 'Missing stopped-builder failure check');

for (const { status, message, imageExists, accepted } of [
  {
    status: 1,
    message: 'ERROR: failed to build: context deadline exceeded',
    imageExists: false,
    accepted: true,
  },
  { status: 0, message: 'context deadline exceeded', imageExists: false, accepted: false },
  { status: 124, message: 'context deadline exceeded', imageExists: false, accepted: false },
  { status: 137, message: 'context deadline exceeded', imageExists: false, accepted: false },
  { status: 1, message: 'unrelated failure', imageExists: false, accepted: false },
  { status: 1, message: 'context deadline exceeded', imageExists: true, accepted: false },
]) {
  test(`stopped-builder evidence: status=${status}, message=${message}, image=${imageExists}`, () => {
    const script = `set -euo pipefail
${helper}
build_probe() { printf '%s\\n' "$SAMPLE"; return "$STATUS"; }
docker() { if [[ $IMAGE_EXISTS == true ]]; then return 0; else return 1; fi; }
log=$(mktemp)
trap 'rm -f "$log"' EXIT
expect_failure test-image "$log" ${expected}
`;
    const result = spawnSync('bash', ['-c', script], {
      env: {
        ...process.env,
        SAMPLE: message,
        STATUS: String(status),
        IMAGE_EXISTS: String(imageExists),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status === 0, accepted, result.stderr);
  });
}
