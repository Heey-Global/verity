import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  analyzeProjectRelayCutover,
  normalizeDockerInspect,
} from './verity-project-relay-cutover-check.mjs';

const control = {
  name: 'deploy-verity-1',
  running: true,
  labels: {
    'com.docker.compose.project': 'deploy',
    'com.docker.compose.service': 'verity',
  },
  networks: ['verity-net'],
};
const sandbox = {
  name: 'verity-project-a',
  running: true,
  labels: { 'verity.project-id': 'a', 'verity.container-generation': 'g1' },
  networks: ['verity-proj-a'],
};
const relay = {
  name: 'verity-relay-a',
  running: true,
  labels: {
    'verity.component': 'project-relay',
    'verity.project-id': 'a',
    'verity.container-generation': 'g1',
  },
  networks: ['verity-proj-a'],
};

test('accepts a matched, isolated sandbox and relay', () => {
  assert.deepEqual(analyzeProjectRelayCutover([control, sandbox, relay]), {
    ready: true,
    controls: 1,
    sandboxes: 1,
    relays: 1,
    failures: [],
    warnings: [],
  });
});

test('reports a pre-ADR-0013 relay as a stale relay, not as a sandbox', () => {
  // Before the component label was recognised, this relay failed the
  // `!== project-relay` test and was counted as a sandbox — so the cutover read
  // as two sandboxes and one relay, and the real problem never appeared.
  const legacyRelay = {
    ...relay,
    labels: { ...relay.labels, 'verity.component': 'project-broker-relay' },
  };
  const result = analyzeProjectRelayCutover([control, sandbox, legacyRelay]);
  assert.equal(result.ready, false);
  assert.equal(result.sandboxes, 1);
  assert.equal(result.relays, 1);
  assert.ok(result.failures.some((failure) => failure.includes('pre-ADR-0013')));
});

test('rejects legacy sandboxes and direct control-plane attachments', () => {
  const result = analyzeProjectRelayCutover([
    { ...control, networks: ['verity-net', 'verity-proj-a'] },
    { ...sandbox, labels: { 'verity.project-id': 'a' }, networks: ['verity-net'] },
  ]);
  assert.equal(result.ready, false);
  assert.ok(result.failures.some((failure) => failure.includes('control plane')));
  assert.ok(result.failures.some((failure) => failure.includes('is legacy')));
});

test('rejects mismatched generations, extra attachments, and orphan relays', () => {
  const result = analyzeProjectRelayCutover([
    control,
    sandbox,
    { ...relay, labels: { ...relay.labels, 'verity.container-generation': 'g2' } },
    { name: 'foreign', running: true, labels: {}, networks: ['verity-proj-a'] },
  ]);
  assert.equal(result.ready, false);
  assert.ok(result.failures.some((failure) => failure.includes('matching relays')));
  assert.ok(result.failures.some((failure) => failure.includes('matching sandboxes')));
  assert.ok(result.failures.some((failure) => failure.includes('generation-matched')));
});

test('rejects the wrong Compose project and an empty deployment', () => {
  const wrongProject = analyzeProjectRelayCutover([
    {
      ...control,
      labels: { ...control.labels, 'com.docker.compose.project': 'unrelated' },
    },
    sandbox,
    relay,
  ]);
  assert.equal(wrongProject.ready, false);
  assert.ok(wrongProject.failures.some((failure) => failure.includes('expected exactly one')));
  // The mismatch names where the control plane actually runs, so the operator
  // fixes COMPOSE_PROJECT_NAME instead of hunting a phantom outage.
  assert.ok(
    wrongProject.failures.some((failure) =>
      failure.includes('a verity service exists in Compose project(s): unrelated'),
    ),
  );

  const empty = analyzeProjectRelayCutover([control]);
  assert.equal(empty.ready, false);
  assert.ok(empty.failures.includes('no project sandboxes were found'));
});

test('accepts an explicitly allowed empty deployment for pre-upgrade checks', () => {
  assert.equal(analyzeProjectRelayCutover([control], 'deploy', { allowEmpty: true }).ready, true);
});

test('rejects foreign-only project networks and relay markers without ownership', () => {
  const result = analyzeProjectRelayCutover([
    control,
    sandbox,
    relay,
    { name: 'foreign-a', running: true, labels: {}, networks: ['verity-proj-foreign'] },
    { name: 'foreign-b', running: true, labels: {}, networks: ['verity-proj-foreign'] },
    {
      name: 'unowned-relay',
      running: true,
      labels: { 'verity.component': 'project-relay' },
      networks: ['unrelated'],
    },
  ]);
  assert.equal(result.ready, false);
  assert.ok(result.failures.some((failure) => failure.includes('verity-proj-foreign')));
  assert.ok(result.failures.some((failure) => failure.includes('missing verity.project-id')));
});

test('rejects stopped project components and normalizes raw Docker inspect data', () => {
  const stoppedRelay = { ...relay, running: false };
  const result = analyzeProjectRelayCutover([control, sandbox, stoppedRelay]);
  assert.equal(result.ready, false);
  assert.ok(result.failures.some((failure) => failure.includes('is stopped')));

  assert.deepEqual(
    normalizeDockerInspect({
      Id: 'abcdef1234567890',
      Name: '/raw-container',
      State: { Running: true },
      Config: { Labels: { example: 'yes' } },
      NetworkSettings: { Networks: { first: {}, second: {} } },
    }),
    {
      name: 'raw-container',
      running: true,
      labels: { example: 'yes' },
      networks: ['first', 'second'],
    },
  );
});

test('rejects stopped or duplicate control-plane containers', () => {
  const stopped = analyzeProjectRelayCutover([{ ...control, running: false }, sandbox, relay]);
  assert.equal(stopped.ready, false);
  assert.ok(stopped.failures.some((failure) => failure.includes('control plane')));

  const duplicate = analyzeProjectRelayCutover([
    control,
    { ...control, name: 'deploy-verity-old', running: false },
    sandbox,
    relay,
  ]);
  assert.equal(duplicate.ready, false);
  assert.ok(duplicate.failures.some((failure) => failure.includes('expected exactly one')));
});
