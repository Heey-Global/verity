import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './testing.js';
import { EventStore } from './store.js';
import { createSealableSecretCipher } from './crypto.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});

it('fences every authoritative endpoint source before SQL and keeps metadata readable while sealed', async () => {
  const sources: string[] = [];
  ctx.store.setEgressDestinationMutation(async (action) => {
    sources.push('fenced');
    const value = await action();
    sources.push('snapshot');
    return value;
  });
  await ctx.store.updateVeritySettings({
    opencodeBaseUrl: 'https://model.example.org',
    transcribeBaseUrl: 'https://audio.example.org',
  });
  await ctx.store.upsertHttpMcpConnection({
    id: 'inventory-mcp',
    name: 'MCP',
    url: 'https://mcp.example.org/resource',
    authorization: 'private',
    enabled: true,
    oauthAuthorizationEndpoint: 'https://auth.example.org/authorize',
    oauthTokenEndpoint: 'https://tokens.example.org/token',
  });
  await ctx.store.forgeConnections.upsert({
    id: 'inventory-forge',
    provider: 'forgejo',
    baseUrl: 'https://forge.example.org',
    label: 'Forge',
    personalToken: 'private',
    githubAppId: null,
    githubAppInstallationId: null,
    githubAppPrivateKey: null,
  });
  await ctx.store.integrations.saveMatrixConfig({
    endpoint: 'https://matrix.example.org',
    username: 'verity',
    password: 'private',
  });
  expect(sources).toEqual([
    'fenced',
    'snapshot',
    'fenced',
    'snapshot',
    'fenced',
    'snapshot',
    'fenced',
    'snapshot',
  ]);
  const sealed = new EventStore(ctx.db, createSealableSecretCipher());
  expect(await sealed.readEgressDestinationUrls()).toEqual(
    expect.arrayContaining([
      'https://model.example.org',
      'https://audio.example.org',
      'https://mcp.example.org/resource',
      'https://auth.example.org/authorize',
      'https://tokens.example.org/token',
      'https://forge.example.org',
      'https://matrix.example.org',
    ]),
  );
  expect((await sealed.readEgressDestinationUrls()).join(' ')).not.toContain('private');
});

it('does not make endpoint writes visible when the synchronized transaction fails', async () => {
  const before = await ctx.store.readEgressDestinationUrls();
  ctx.store.setEgressDestinationMutation((action) =>
    ctx.store.withEgressDestinationTransaction(async () => {
      await action();
      expect(await ctx.store.readEgressDestinationUrls()).toContain(
        'https://replacement.example.org',
      );
      throw new Error('host acknowledgement failed');
    }),
  );
  await expect(
    ctx.store.updateVeritySettings({ opencodeBaseUrl: 'https://replacement.example.org' }),
  ).rejects.toThrow('host acknowledgement failed');
  expect(await ctx.store.readEgressDestinationUrls()).toEqual(before);
});

it('rejects additions and removals before persistence when fencing is unavailable', async () => {
  const before = await ctx.store.readEgressDestinationUrls();
  ctx.store.setEgressDestinationMutation(async () => {
    throw new Error('fencing unavailable');
  });
  await expect(
    ctx.store.upsertHttpMcpConnection({
      id: 'unfenced',
      name: 'MCP',
      url: 'https://unfenced.example.org',
      authorization: null,
      enabled: true,
    }),
  ).rejects.toThrow('fencing unavailable');
  await expect(ctx.store.deleteHttpMcpConnection('inventory-mcp')).rejects.toThrow(
    'fencing unavailable',
  );
  await expect(ctx.store.forgeConnections.delete('inventory-forge')).rejects.toThrow(
    'fencing unavailable',
  );
  expect(await ctx.store.readEgressDestinationUrls()).toEqual(before);
});
