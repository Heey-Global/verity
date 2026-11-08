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
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'team',
    repo: 'site',
    containerName: 'site',
    state: 'active',
  });
});

it('keeps the description beside the other settings and clears it when emptied', async () => {
  await ctx.store.updateProjectSettings('p', { memory: 'notes' });
  await ctx.store.updateProjectSettings('p', { description: '  Self-hosted agent workspace  ' });
  const written = await ctx.store.getProjectSettings('p');
  expect(written?.description).toBe('Self-hosted agent workspace');
  // A patch of another field must not erase the description.
  expect(written?.memory).toBe('notes');
  await ctx.store.updateProjectSettings('p', { designLevel: 'off' });
  expect((await ctx.store.getProjectSettings('p'))?.description).toBe(
    'Self-hosted agent workspace',
  );
  await ctx.store.updateProjectSettings('p', { description: '   ' });
  expect((await ctx.store.getProjectSettings('p'))?.description).toBeNull();
});

it('refuses a description longer than one line under the name allows', async () => {
  await expect(
    ctx.store.updateProjectSettings('p', { description: 'x'.repeat(201) }),
  ).rejects.toThrow();
});
