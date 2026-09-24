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

it('does not ingest an invitation before it is connected, and retries one event id safely', async () => {
  const projectId = randomUUID();
  await ctx.store.upsertProject({
    id: projectId,
    owner: 'example',
    repo: 'matrix-test',
    containerName: `matrix-test-${projectId}`,
    state: 'absent',
  });
  const integrations = ctx.store.integrations;
  await integrations.upsertAccount({
    id: '@verity:example.test',
    provider: 'matrix',
    endpoint: 'https://matrix.example.test',
    displayName: 'Matrix',
    status: 'online',
  });
  await integrations.discoverSource({
    accountId: '@verity:example.test',
    sourceId: '!room:example.test',
    displayName: 'Project chat',
  });
  const event = {
    accountId: '@verity:example.test',
    sourceId: '!room:example.test',
    eventId: '$message',
    targetEventId: null,
    kind: 'message' as const,
    sender: '@person:example.test',
    occurredAt: new Date(Date.now() + 1_000),
    body: 'Decision B',
  };
  await expect(integrations.ingestEvent(event)).rejects.toThrow(/not connected/u);
  expect(
    await integrations.listEventsForDay(
      event.accountId,
      event.sourceId,
      event.occurredAt.toISOString().slice(0, 10),
    ),
  ).toEqual([]);

  await integrations.setSourceBinding(event.accountId, event.sourceId, projectId);
  expect(await integrations.ingestEvent(event)).toEqual({ projectId, inserted: true });
  expect(await integrations.ingestEvent(event)).toEqual({ projectId, inserted: false });
  expect(
    await integrations.listEventsForDay(
      event.accountId,
      event.sourceId,
      event.occurredAt.toISOString().slice(0, 10),
    ),
  ).toHaveLength(1);

  await integrations.setSourceBinding(event.accountId, event.sourceId, null);
  await expect(integrations.ingestEvent({ ...event, eventId: '$new' })).rejects.toThrow(
    /not connected/u,
  );

  await integrations.setSourceBinding(event.accountId, event.sourceId, projectId);
  await ctx.store.deleteProject(projectId);
  expect(await integrations.listSources()).toEqual([]);
});

it('encrypts Matrix credentials and exposes only a redacted summary', async () => {
  const { createSecretCipher } = await import('./crypto.js');
  const { IntegrationStore } = await import('./integrations.js');
  const integrations = new IntegrationStore(ctx.db, createSecretCipher('a'.repeat(64)));
  await integrations.saveMatrixConfig({
    endpoint: 'https://matrix.example.test',
    username: '@verity:example.test',
    password: 'private-password',
  });
  const stored = await ctx.db
    .selectFrom('matrix_connector_config')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(stored.password_secret).not.toContain('private-password');
  expect(await integrations.matrixConfigSummary()).toEqual({
    endpoint: 'https://matrix.example.test',
    username: '@verity:example.test',
    passwordConfigured: true,
  });
  expect(await integrations.matrixConfigForWorker()).toEqual({
    endpoint: 'https://matrix.example.test',
    username: '@verity:example.test',
    password: 'private-password',
  });
  await expect(
    integrations.saveMatrixConfig({
      endpoint: 'https://other.example.test',
      username: '@other:example.test',
      password: 'new',
    }),
  ).rejects.toThrow(/Changing the Matrix account/u);
});
