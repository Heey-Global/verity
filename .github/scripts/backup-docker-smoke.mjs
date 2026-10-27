import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDockerClient, DockerError } from '/app/packages/server/dist/docker.js';
import { checkProbeDatabaseSpace } from '/app/packages/server/dist/backup/probe-space.js';

// Run inside the candidate Server image against the CI daemon, with no live data mounts.
const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
const image = process.env.VERITY_CI_BACKUP_POSTGRES;
assert.match(image ?? '', /^postgres:.*@sha256:[a-f0-9]{64}$/);
assert.equal(process.arch, 'x64');
await docker.pullImage(image);
const prefix = `verity-ci-backup-${randomUUID()}`;
const options = { docker, image, architecture: 'amd64', resourcePrefix: prefix };
async function assertClean() {
  await assert.rejects(
    docker.inspectContainer(prefix + '-space'),
    (error) => error instanceof DockerError && error.kind === 'container_not_found',
  );
}
try {
  await checkProbeDatabaseSpace({ ...options, requiredBytes: 1024n });
  await assertClean();
  await assert.rejects(
    checkProbeDatabaseSpace({ ...options, requiredBytes: 9223372036854775807n * 1024n }),
    /Insufficient or unverifiable/,
  );
  await assertClean();
  const controller = new AbortController();
  const cancellableDocker = {
    ...docker,
    async startContainer(id) {
      await docker.startContainer(id);
      controller.abort();
    },
  };
  await assert.rejects(
    checkProbeDatabaseSpace({
      ...options,
      docker: cancellableDocker,
      requiredBytes: 1024n,
      signal: controller.signal,
    }),
    /abort/i,
  );
  await assertClean();
  console.log('Backup Docker capacity, failure and cancellation cleanup passed.');
} finally {
  try {
    await docker.removeContainer(prefix + '-space');
  } catch (error) {
    if (!(error instanceof DockerError && error.kind === 'container_not_found')) throw error;
  }
}
