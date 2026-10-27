// Disposable CI runner only: use the built Server collector against the real Engine.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { createTestDb } from '@verity/store/testing';
import { createDockerClient } from '../../../packages/server/dist/docker.js';
import { runDockerGc } from '../../../packages/server/dist/docker-gc.js';
import { createProjectImageReferences } from '../../../packages/server/dist/derived-image-references.js';
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const source = process.argv[2];
assert(source, 'A built fixture image is required');
const name = `verity-devc-lifetime-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const ref = `${name}:fixture`;
const cli = (...args) => execFileSync('docker', args, { encoding: 'utf8' });
const db = await createTestDb();
const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
const log = { info: console.log, warn: console.warn };
try {
  cli('tag', source, ref);
  for (const id of ['first', 'shared']) {
    await db.store.upsertProject({
      id,
      owner: 'fixture',
      repo: id,
      containerName: `${name}-${id}`,
      state: 'absent',
    });
    await db.db.updateTable('projects').set({ image_ref: ref }).where('id', '=', id).execute();
  }
  // Recreate the registry to prove protection comes from durable selections.
  const references = createProjectImageReferences(db.db);
  const deps = {
    docker: {
      ...docker,
      listImages: async () =>
        (await docker.listImages()).filter((image) => image.repoTags.includes(ref)),
    },
    imageReferences: references,
    imagesOnly: true,
    log,
  };
  const retained = async () => {
    const result = await runDockerGc(deps);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.imagesRemoved, []);
    assert.equal(await docker.imageExists(ref), true);
  };
  await db.store.hideProject('first');
  await retained(); // Shared project still selects this image.
  await references.reserve('building', ref);
  await db.store.hideProject('shared');
  await retained(); // No project selects it, but import/provisioning still owns it.
  cli('create', '--name', name, ref);
  await references.releaseProject('building');
  await retained(); // A stopped container is a reference too.
  cli('rm', name);
  const remove = deps.docker.removeImage;
  deps.docker.removeImage = async () => {
    throw new Error('fixture transient removal failure');
  };
  assert.equal((await runDockerGc(deps)).errors.length, 1);
  assert.equal(await docker.imageExists(ref), true);
  deps.docker.removeImage = remove;
  assert.deepEqual((await runDockerGc(deps)).imagesRemoved, [ref]);
  assert.equal(await docker.imageExists(ref), false);
  console.log(
    'PASS: durable/shared project, in-flight build, stopped container, and retryable image deletion',
  );
} finally {
  try {
    cli('rm', '-f', name);
  } catch {
    /* Fixture may already be removed. */
  }
  try {
    cli('image', 'rm', ref);
  } catch {
    /* Fixture may already be collected. */
  }
  await db.close();
}
