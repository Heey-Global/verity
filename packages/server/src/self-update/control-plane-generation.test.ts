import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createControlPlaneGenerationFence,
  GenerationFenceLostError,
} from './control-plane-generation.js';

describe('control-plane generation fence', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await createIsolatedTestDb();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.db.deleteFrom('control_plane_generation').execute();
  });

  it('allows exactly one initial generation owner', async () => {
    const fence = createControlPlaneGenerationFence(ctx.db);
    const [first, second] = await Promise.all([
      fence.initialize('server-a', 'bootstrap'),
      fence.initialize('server-b', 'bootstrap'),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await fence.read()).toMatchObject({ generation: 1, state: 'active' });
  });

  it('requires the exact owner to quiesce and CAS-acquires one newer generation', async () => {
    const fence = createControlPlaneGenerationFence(ctx.db);
    expect(await fence.initialize('server-a', 'bootstrap')).toBe(true);
    const active = await fence.read();
    expect(active).not.toBeNull();
    expect(await fence.quiesce(active!)).toBe(true);
    const [a, b] = await Promise.all([
      fence.acquire({ expectedGeneration: 1, holderId: 'server-c', operationId: 'update-1' }),
      fence.acquire({ expectedGeneration: 1, holderId: 'server-d', operationId: 'update-1' }),
    ]);
    expect([a, b].filter((value) => value !== null)).toHaveLength(1);
    expect(await fence.read()).toMatchObject({ generation: 2, state: 'active' });
  });

  it('rejects stale generations after a forward-fenced rollback', async () => {
    const fence = createControlPlaneGenerationFence(ctx.db);
    expect(await fence.initialize('server-a', 'bootstrap')).toBe(true);
    const active = await fence.read();
    await fence.assertActive({
      generation: active!.generation,
      holderId: active!.holderId!,
      operationId: active!.operationId!,
    });
    expect(await fence.quiesce(active!)).toBe(true);
    const rollback = await fence.acquire({
      expectedGeneration: active!.generation,
      holderId: 'server-a',
      operationId: 'rollback-1',
    });
    expect(rollback?.generation).toBe(active!.generation + 1);
    await expect(
      fence.assertActive({
        generation: active!.generation,
        holderId: active!.holderId!,
        operationId: active!.operationId!,
      }),
    ).rejects.toBeInstanceOf(GenerationFenceLostError);
    await expect(
      fence.runActive(
        {
          generation: active!.generation,
          holderId: active!.holderId!,
          operationId: active!.operationId!,
        },
        () => Promise.resolve('must-not-run'),
      ),
    ).rejects.toBeInstanceOf(GenerationFenceLostError);
  });

  it('runs an admitted mutation inside the generation-locking transaction', async () => {
    const fence = createControlPlaneGenerationFence(ctx.db);
    expect(await fence.initialize('server-a', 'bootstrap')).toBe(true);
    const active = await fence.read();
    const result = await fence.runActive(
      {
        generation: active!.generation,
        holderId: active!.holderId!,
        operationId: active!.operationId!,
      },
      async (transaction) =>
        await transaction
          .selectFrom('control_plane_generation')
          .select('generation')
          .executeTakeFirstOrThrow(),
    );
    expect(result.generation).toBe(active!.generation);
  });
});
