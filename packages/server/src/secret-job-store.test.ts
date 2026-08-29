import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresSecretJobStore } from './secret-job-store.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

describe('postgres secret job store', () => {
  it('atomically reserves job ids and survives service reconstruction', async () => {
    const first = createPostgresSecretJobStore(ctx.db);
    await expect(
      first.reserve('job-1', { actorId: 'device-1', authorizationHash: 'a'.repeat(64) }),
    ).resolves.toBe(true);
    await expect(
      first.reserve('job-1', { actorId: 'device-2', authorizationHash: 'b'.repeat(64) }),
    ).resolves.toBe(false);
    await first.update('job-1', 'running');

    const reconstructed = createPostgresSecretJobStore(ctx.db);
    await expect(reconstructed.get('job-1')).resolves.toEqual({
      jobId: 'job-1',
      actorId: 'device-1',
      authorizationHash: 'a'.repeat(64),
      state: 'running',
    });
  });

  it('persists a redaction-safe terminal result', async () => {
    const store = createPostgresSecretJobStore(ctx.db);
    await store.reserve('job-1', {
      actorId: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await store.update('job-1', 'reaped', {
      protocolVersion: 1,
      jobId: 'job-1',
      outcome: 'failed',
      finishedAt: '2026-07-22T12:00:00.000Z',
    });
    // A concurrent cleanup state write without a result must never clear the terminal outcome.
    await store.update('job-1', 'reaped');
    await expect(store.get('job-1')).resolves.toMatchObject({
      actorId: 'device-1',
      state: 'reaped',
      result: { outcome: 'failed' },
    });
  });

  it('terminalizes jobs interrupted by a process restart', async () => {
    const store = createPostgresSecretJobStore(ctx.db);
    await store.reserve('job-1', {
      actorId: 'device-1',
      authorizationHash: 'a'.repeat(64),
    });
    await store.update('job-1', 'running');
    await expect(
      store.recoverInterrupted('2026-07-22T12:01:00.000Z', '2020-01-01T00:00:00.000Z'),
    ).resolves.toBe(0);
    await expect(
      store.recoverInterrupted('2027-07-22T12:01:00.000Z', '2027-07-22T12:00:00.000Z'),
    ).resolves.toBe(1);
    await expect(store.get('job-1')).resolves.toMatchObject({
      state: 'reaped',
      result: { outcome: 'failed', finishedAt: '2027-07-22T12:01:00.000Z' },
    });
  });
});
