import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
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

it('allocates distinct local names for concurrent disconnects and skips occupied fallback names', async () => {
  const first = randomUUID();
  const second = randomUUID();
  for (const repo of ['code', `code-${first}`]) {
    await ctx.store.createProject({
      id: randomUUID(),
      owner: '__local__',
      repo,
      kind: 'local',
      containerName: `local-${randomUUID()}`,
      state: 'absent',
    });
  }
  for (const [id, owner] of [
    [first, 'org-a'],
    [second, 'org-b'],
  ] as const) {
    await ctx.store.upsertProject({
      id,
      owner,
      repo: 'code',
      kind: 'github',
      containerName: `remote-${id}`,
      state: 'active',
    });
  }
  const results = await Promise.all([
    ctx.store.disconnectProjectFromGitHub(first),
    ctx.store.disconnectProjectFromGitHub(second),
  ]);
  expect(results[0]).toMatchObject({
    id: first,
    kind: 'local',
    repo: `code-${first}-2`,
    cloneDir: 'org-a-code',
  });
  expect(results[1]).toMatchObject({
    id: second,
    kind: 'local',
    repo: `code-${second}`,
    cloneDir: 'org-b-code',
  });
});
