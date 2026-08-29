import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSigningCapabilityRegistry } from './signing-capability.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'acme/one',
    owner: 'acme',
    repo: 'one',
    containerName: 'dev-acme-one',
    state: 'active',
  });
});

describe('signing capability registry', () => {
  it('persists only a hash and resolves the project/container generation binding', async () => {
    const registry = createSigningCapabilityRegistry(ctx.db);
    const capability = await registry.issue({
      projectId: 'acme/one',
      containerGeneration: 'generation-1',
    });

    await expect(registry.resolve(capability)).resolves.toEqual({
      projectId: 'acme/one',
      containerGeneration: 'generation-1',
    });
    const row = await ctx.db
      .selectFrom('signing_capabilities')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.cap_hash).not.toBe(capability);
  });

  it('rotates on reissue and revokes independently', async () => {
    const registry = createSigningCapabilityRegistry(ctx.db);
    const oldCapability = await registry.issue({
      projectId: 'acme/one',
      containerGeneration: 'generation-1',
    });
    const newCapability = await registry.issue({
      projectId: 'acme/one',
      containerGeneration: 'generation-2',
    });

    await expect(registry.resolve(oldCapability)).resolves.toBeUndefined();
    await expect(registry.resolve(newCapability)).resolves.toEqual({
      projectId: 'acme/one',
      containerGeneration: 'generation-2',
    });
    await registry.revokeProject('acme/one');
    await expect(registry.resolve(newCapability)).resolves.toBeUndefined();
  });
});
