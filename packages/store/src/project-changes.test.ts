import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectChangeFeed } from './project-changes.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

async function project(): Promise<string> {
  const id = randomUUID();
  await ctx.store.upsertProject({
    id,
    owner: 'heey-global',
    repo: `repo-${id.slice(0, 8)}`,
    containerName: `dev-${id}`,
    state: 'absent',
  });
  return id;
}

describe('EventStore project change announcements', () => {
  // A write that does not announce leaves every live view on the old sandbox
  // state until its next read, with nothing failing.
  it('announces every write of state, image, name and setup status once it is visible', async () => {
    const id = await project();
    // The listener reads the row as it is announced; the write must already
    // be visible to that read.
    let read: Promise<unknown> | undefined;
    const stop = ctx.store.projectChanges.observe((projectId) => {
      read = ctx.store.getProject(projectId);
    });
    const announced = async (write: Promise<unknown>) => {
      read = undefined;
      await write;
      return read;
    };
    await expect(announced(ctx.store.updateProjectState(id, 'cloning'))).resolves.toMatchObject({
      state: 'cloning',
    });
    await expect(
      announced(
        ctx.store.updateProjectSleepState(id, 'active', {
          sleepCompatibilityFingerprint: null,
          sleepingSince: null,
          wakeStartedAt: null,
        }),
      ),
    ).resolves.toMatchObject({ state: 'active' });
    await expect(
      announced(ctx.store.recordProjectImageRef(id, 'ghcr.io/example/image:1', null)),
    ).resolves.toMatchObject({ imageRef: 'ghcr.io/example/image:1' });
    await expect(announced(ctx.store.renameProject(id, 'Renamed'))).resolves.toMatchObject({
      name: 'Renamed',
    });
    await expect(announced(ctx.store.setProjectSetupStatus(id, 'complete'))).resolves.toMatchObject(
      { setupStatus: 'complete' },
    );
    stop();
  });

  it('stays quiet for a project that does not exist', async () => {
    const seen: string[] = [];
    const stop = ctx.store.projectChanges.observe((projectId) => seen.push(projectId));
    await ctx.store.renameProject(randomUUID(), 'Nobody');
    expect(seen).toEqual([]);
    stop();
  });
});

describe('ProjectChangeFeed', () => {
  it('keeps announcing to the other listeners when one throws', () => {
    const feed = new ProjectChangeFeed();
    const seen: string[] = [];
    feed.observe(() => {
      throw new Error('listener failed');
    });
    const stop = feed.observe((projectId) => seen.push(projectId));
    feed.announce('p1');
    stop();
    feed.announce('p2');
    expect(seen).toEqual(['p1']);
  });
});
