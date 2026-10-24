import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { registerConnectionUsageRoutes } from './connection-usage-routes.js';
let ctx: TestDb;
const app = Fastify();
let defaultModel: string | undefined;
beforeAll(async () => {
  ctx = await createTestDb();
  registerConnectionUsageRoutes(app, ctx.store, async () =>
    defaultModel === undefined ? undefined : { models: [defaultModel], default: defaultModel },
  );
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});
it('counts project bindings and explicit agent choices without exposing secrets or inflating duplicates', async () => {
  await ctx.store.upsertProject({
    id: 'usage-p',
    kind: 'local',
    owner: 'local',
    repo: 'test',
    containerName: 'test',
    state: 'active',
  });
  await ctx.store.updateProjectSettings('usage-p', {
    defaultModel: 'codex/default',
    dopplerProject: 'app',
    dopplerConfig: 'dev',
    googleDriveFolderId: 'folder',
  });
  await ctx.store.enableProjectGoogleConnection('usage-p', 'gmail', 'test@example.test');
  expect((await app.inject('/connections/usage')).json()).toEqual({
    github: 0,
    claude: 0,
    codex: 1,
    opencode: 0,
    google: 1,
    matrix: 0,
    doppler: 1,
    mcp: 0,
    forgejo: {},
  });
  await ctx.store.upsertProject({
    id: 'usage-hidden',
    kind: 'local',
    owner: 'local',
    repo: 'hidden',
    containerName: 'hidden',
    state: 'active',
    archived: true,
  });
  await ctx.store.updateProjectSettings('usage-hidden', {
    defaultModel: 'claude-sonnet-4',
    googleDriveFolderId: 'hidden-folder',
  });
  expect((await app.inject('/connections/usage')).json()).toMatchObject({ claude: 0, google: 1 });
});

it('counts effective provider defaults using the session model routing contract', async () => {
  defaultModel = 'deepinfra/provider-model';
  await ctx.store.upsertProject({
    id: 'usage-default',
    kind: 'local',
    owner: 'local',
    repo: 'default',
    containerName: 'default',
    state: 'active',
  });
  const usage = (await app.inject('/connections/usage')).json();
  expect(usage).toMatchObject({ opencode: 1, codex: 1, claude: 0 });
});

it('counts Forgejo projects per connection so each instance shows its own usage', async () => {
  await ctx.store.forgeConnections.upsert({
    id: 'usage-forgejo',
    provider: 'forgejo',
    baseUrl: 'https://forge.test',
    label: 'Forge',
    personalToken: 'fixture',
    githubAppId: null,
    githubAppInstallationId: null,
    githubAppPrivateKey: null,
  });
  await ctx.store.upsertProject({
    id: 'usage-forgejo-project',
    kind: 'forgejo',
    forgeConnectionId: 'usage-forgejo',
    owner: 'team',
    repo: 'site',
    containerName: 'forgejo-team-site',
    state: 'active',
  });
  const usage = (await app.inject('/connections/usage')).json<{
    github: number;
    forgejo: Record<string, number>;
  }>();
  // A Forgejo project must not inflate the GitHub count.
  expect(usage.forgejo).toEqual({ 'usage-forgejo': 1 });
  expect(usage.github).toBe(0);
});
