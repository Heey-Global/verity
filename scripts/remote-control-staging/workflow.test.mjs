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

test('a test entry route only accepts a dotted IPv4 and a bare https Uplink host', () => {
  const check = steps.find((step) => step.name === 'Validate test entry')?.run;
  assert.equal(typeof check, 'string');
  const run = (ip, origin = 'https://uplink.verity.build') =>
    spawnSync('bash', ['-c', check], {
      env: { ...process.env, UPLINK_TEST_IP: ip, UPLINK_ORIGIN: origin },
    }).status;
  for (const ip of ['', '203.0.113.7', '10.0.0.1', '255.255.255.255']) assert.equal(run(ip), 0, ip);
  for (const ip of ['1.2.3', '256.1.1.1', '01.2.3.4', '1.2.3.4 evil.example', '1.2.3.4\n', '::1']) {
    assert.notEqual(run(ip), 0, ip);
  }
  assert.equal(run('203.0.113.7', 'https://uplink.verity.build/'), 0);
  for (const origin of [
    'https://uplink.verity.build:8443',
    'https://a b',
    'http://uplink.verity.build',
  ]) {
    assert.notEqual(run('203.0.113.7', origin), 0, origin);
  }
});

test('the test entry route is opt-in and always removed', () => {
  const route = steps.find((step) => step.name === 'Route the Uplink host to the test entry');
  const cleanup = steps.find((step) => step.name === 'Remove the test entry route');
  assert.equal(route.if, "inputs.uplink_test_ip != ''");
  assert.equal(cleanup.if, "always() && inputs.uplink_test_ip != ''");
  assert(steps.indexOf(route) < steps.findIndex((step) => step.run?.includes('run.sh')));
  assert.equal(steps.at(-1), cleanup);
});
