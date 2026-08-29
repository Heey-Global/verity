import assert from 'node:assert/strict';

import { createDockerClient } from '../../packages/server/dist/docker.js';
import {
  CONTAINER_GENERATION_LABEL,
  PROJECT_ID_LABEL,
  classifyProjectContainer,
  decideMigrationAction,
} from '../../packages/server/dist/project-relay-migration.js';

// Stage 5 real-Docker gate (Temporary Public Previews spike §8): prove that a
// legacy shared-network sandbox is DETECTED and REPLACED — never silently reused —
// and that a foreign container is left untouched. Unit mocks can fabricate any
// inspect shape; this drives the production docker.ts client and the production
// classifier against a real daemon, so it also validates that real
// `docker inspect` output (labels + networks-by-name) feeds the classifier the
// way the provisioner assumes.

const [image, suffix] = process.argv.slice(2);
assert(image, 'migration smoke requires a sandbox image argument');
assert(suffix, 'migration smoke requires a suffix argument');

// The project id is already lowercase/clean, so its isolation network name is
// exactly `verity-proj-<id>` (matches provisioner.projectNetworkName).
const projectId = `migration-${suffix}`;
const projectNetwork = `verity-proj-${projectId}`;
const sharedNetwork = `verity-shared-${suffix}`;
const sandboxName = `dev-${projectId}`;
const foreignName = `foreign-${suffix}`;
const smokeLabel = { 'verity.migration-smoke': suffix };
// Keep-alive command that needs no shell (works on the minimal node image).
const idleCommand = ['node', '-e', 'setInterval(() => {}, 1 << 30)'];

const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
assert(typeof docker.ensureNetwork === 'function', 'real docker client must expose ensureNetwork');

async function inspectOrNull(name) {
  try {
    return await docker.inspectContainer(name);
  } catch {
    return null;
  }
}

function classify(inspect) {
  return classifyProjectContainer({ inspect, projectId, projectNetwork });
}

async function main() {
  await docker.ensureNetwork(sharedNetwork, { labels: smokeLabel });
  await docker.ensureNetwork(projectNetwork, {
    labels: { ...smokeLabel, [PROJECT_ID_LABEL]: projectId },
  });

  // 1) A real legacy sandbox: our project label, on the shared network, NO
  //    generation stamp. It must classify as `legacy` and, when idle, migrate —
  //    but when busy it must DEFER, never be force-recreated under a live turn.
  const legacy = await docker.createContainer({
    image,
    name: sandboxName,
    network: sharedNetwork,
    labels: { ...smokeLabel, [PROJECT_ID_LABEL]: projectId },
    command: idleCommand,
    restartPolicy: 'no',
  });
  await docker.startContainer(legacy.id);
  assert.equal(
    classify(await docker.inspectContainer(sandboxName)),
    'legacy',
    'a shared-network sandbox with no generation label must classify as legacy',
  );
  assert.equal(decideMigrationAction({ classification: 'legacy', busy: false }), 'migrate');
  assert.equal(decideMigrationAction({ classification: 'legacy', busy: true }), 'defer');

  // 2) A foreign container (no verity.project-id) that migration must never touch.
  const foreign = await docker.createContainer({
    image,
    name: foreignName,
    network: sharedNetwork,
    labels: { ...smokeLabel },
    command: idleCommand,
    restartPolicy: 'no',
  });
  await docker.startContainer(foreign.id);
  assert.equal(
    classify(await docker.inspectContainer(foreignName)),
    'foreign',
    'a container without our project-id label must classify as foreign',
  );

  // 3) Execute the migration EFFECT through the production docker client: retire
  //    the legacy container and recreate the sandbox single-homed on its project
  //    network with a generation stamp. This is the fail-closed shape the
  //    provisioner drives (stop → remove → recreate on the project network).
  await docker.stopContainer(sandboxName);
  await docker.removeContainer(sandboxName);
  assert.equal(
    await inspectOrNull(sandboxName),
    null,
    'the legacy container must be gone after migration, not reused',
  );

  const generation = `gen-${suffix}`;
  const migrated = await docker.createContainer({
    image,
    name: sandboxName,
    network: projectNetwork,
    labels: {
      ...smokeLabel,
      [PROJECT_ID_LABEL]: projectId,
      [CONTAINER_GENERATION_LABEL]: generation,
    },
    command: idleCommand,
    restartPolicy: 'no',
  });
  await docker.startContainer(migrated.id);
  assert.notEqual(
    migrated.id,
    legacy.id,
    'migration must create a NEW container, never reuse the legacy one',
  );
  assert.equal(
    classify(await docker.inspectContainer(sandboxName)),
    'migrated',
    'the recreated sandbox must be single-homed on its project network with a generation stamp',
  );
  assert.equal(
    decideMigrationAction({ classification: 'migrated', busy: false }),
    'none',
    'a migrated sandbox must not be migrated again (no reuse churn)',
  );

  // 4) The foreign container must still be present and running — untouched.
  const foreignAfter = await inspectOrNull(foreignName);
  assert(
    foreignAfter && foreignAfter.running,
    'migration must never stop or remove a foreign container',
  );

  console.log('relay migration smoke: legacy detected → migrated; foreign untouched — OK');
}

await main();
