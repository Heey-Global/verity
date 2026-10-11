import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/remote-control-soak.yml', 'utf8'));
const steps = workflow.jobs.soak.steps;
const validation = steps.find((step) => step.env?.SOAK_SECONDS)?.run;

test('the dispatched soak cannot pass with a skipped or malformed duration', () => {
  assert.equal(typeof validation, 'string');
  // A skipped soak would leave transport regressions green without any traffic.
  for (const value of ['0', '10', '29', '601', '180 ', '1e2', '0180', '']) {
    const result = spawnSync('bash', ['-c', validation], {
      env: { ...process.env, SOAK_SECONDS: value },
    });
    assert.notEqual(result.status, 0, value);
  }
  for (const value of ['30', '180', '600']) {
    const result = spawnSync('bash', ['-c', validation], {
      env: { ...process.env, SOAK_SECONDS: value },
    });
    assert.equal(result.status, 0, value);
  }
});

test('live inputs are environment values and the production probe runs in app mode', () => {
  const probe = steps.find((step) => step.run?.includes('remote-control-staging/run.sh'));
  assert.equal(probe.env.VERITY_REMOTE_PROBE_MODE, 'app');
  assert.equal(probe.env.VERITY_REMOTE_PROBE_SOAK_SECONDS, '${{ inputs.soak_seconds }}');
  assert.equal(probe.env.VERITY_REMOTE_PROBE_SOAK_STREAMS, '6');
  for (const step of steps) assert(!step.run?.includes('${{'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
});
