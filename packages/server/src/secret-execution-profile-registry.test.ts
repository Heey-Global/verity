import type { ExecutionProfileRecord } from '@verity/secret-contracts';
import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresSecretExecutionProfileRegistry,
  SecretExecutionProfileRegistryError,
} from './secret-execution-profile-registry.js';

const PROJECT = 'project-1';
const HASH = 'a'.repeat(64);
const profile: ExecutionProfileRecord = {
  id: 'fixed-api',
  projectId: PROJECT,
  version: 1,
  policyHash: HASH,
  state: 'active',
  trustMode: 'restricted',
  requiresApproval: true,
  limits: {
    timeoutSeconds: 60,
    cpuMillis: 500,
    memoryMiB: 128,
    maxProcesses: 4,
    maxOutputBytes: 65_536,
  },
  imageDigest: 'b'.repeat(64),
  executablePath: '/usr/local/bin/verity-secret-job-pilot',
  executableDigest: 'c'.repeat(64),
  parameterSchemaHash: 'd'.repeat(64),
  snapshotPolicyHash: 'e'.repeat(64),
  egressPolicyHash: 'f'.repeat(64),
  resultSchemaHash: '1'.repeat(64),
  allowDescendants: false,
};

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

async function seedProject(): Promise<void> {
  await new EventStore(ctx.db).upsertProject({
    id: PROJECT,
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-heey-global--verity',
    state: 'active',
  });
}

describe('Postgres Secret execution profile registry', () => {
  it('stores immutable versions idempotently and resolves exact active policy', async () => {
    await seedProject();
    const registry = createPostgresSecretExecutionProfileRegistry(ctx.db);
    await registry.provision(profile);
    await expect(registry.provision(profile)).resolves.toBeUndefined();
    await expect(
      registry.resolve(
        { id: profile.id, version: profile.version, policyHash: profile.policyHash },
        PROJECT,
      ),
    ).resolves.toEqual(profile);
    await expect(
      registry.provision({ ...profile, imageDigest: '2'.repeat(64) }),
    ).rejects.toBeInstanceOf(SecretExecutionProfileRegistryError);
  });

  it('fails closed for project/hash mismatches and later disabled versions', async () => {
    await seedProject();
    const registry = createPostgresSecretExecutionProfileRegistry(ctx.db);
    await registry.provision(profile);
    await expect(
      registry.resolve({ id: profile.id, version: 1, policyHash: '9'.repeat(64) }, PROJECT),
    ).resolves.toBeUndefined();
    await expect(
      registry.resolve(
        { id: profile.id, version: 1, policyHash: profile.policyHash },
        'other-project',
      ),
    ).resolves.toBeUndefined();
    await registry.provision({ ...profile, version: 2, state: 'disabled' });
    await expect(
      registry.resolve({ id: profile.id, version: 1, policyHash: profile.policyHash }, PROJECT),
    ).resolves.toBeUndefined();
    await expect(registry.list(PROJECT)).resolves.toEqual([
      profile,
      { ...profile, version: 2, state: 'disabled' },
    ]);
  });

  it('rejects malformed references and inconsistent stored state', async () => {
    await seedProject();
    const registry = createPostgresSecretExecutionProfileRegistry(ctx.db);
    await registry.provision(profile);
    await expect(
      registry.resolve({ id: 'bad/id', version: 0, policyHash: 'bad' }, PROJECT),
    ).resolves.toBeUndefined();
    await ctx.db
      .updateTable('secret_execution_profiles')
      .set({ profile_json: JSON.stringify({ ...profile, state: 'disabled' }) })
      .where('project_id', '=', PROJECT)
      .where('id', '=', profile.id)
      .where('version', '=', profile.version)
      .execute();
    await expect(
      registry.resolve(
        { id: profile.id, version: profile.version, policyHash: profile.policyHash },
        PROJECT,
      ),
    ).resolves.toBeUndefined();
    await expect(registry.provision(profile)).rejects.toBeInstanceOf(
      SecretExecutionProfileRegistryError,
    );
    await ctx.db
      .updateTable('secret_execution_profiles')
      .set({ profile_json: '{not-json' })
      .where('project_id', '=', PROJECT)
      .where('id', '=', profile.id)
      .where('version', '=', profile.version)
      .execute();
    await expect(
      registry.resolve(
        { id: profile.id, version: profile.version, policyHash: profile.policyHash },
        PROJECT,
      ),
    ).resolves.toBeUndefined();
    await ctx.db
      .updateTable('secret_execution_profiles')
      .set({ profile_json: JSON.stringify({ ...profile, projectId: 'other-project' }) })
      .where('project_id', '=', PROJECT)
      .where('id', '=', profile.id)
      .where('version', '=', profile.version)
      .execute();
    await expect(
      registry.resolve(
        { id: profile.id, version: profile.version, policyHash: profile.policyHash },
        PROJECT,
      ),
    ).resolves.toBeUndefined();
    await expect(registry.list(PROJECT)).rejects.toBeInstanceOf(
      SecretExecutionProfileRegistryError,
    );
  });
});
