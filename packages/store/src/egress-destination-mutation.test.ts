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

it('updates Matrix poll metadata without fencing while fencing every real endpoint change', async () => {
  const account = {
    id: 'inventory-poll',
    provider: 'matrix' as const,
    endpoint: 'https://matrix.example.org',
    displayName: 'Matrix',
    status: 'online',
  };
  let fenced = 0;
  let available = true;
  ctx.store.setEgressDestinationMutation((action, changesDestinations) =>
    ctx.store.withEgressDestinationTransaction(async () => {
      if (!changesDestinations || (await changesDestinations())) {
        if (!available) throw new Error('host unavailable');
        fenced++;
      }
      return action();
    }),
  );
  await ctx.store.integrations.upsertAccount(account);
  expect(fenced).toBe(1);
  available = false;
  await ctx.store.integrations.upsertAccount(account);
  await ctx.store.integrations.upsertAccount({
    ...account,
    displayName: 'Updated',
    status: 'offline',
    lastError: 'temporary',
  });
  expect(fenced).toBe(1);
  expect(
    (await ctx.store.integrations.listAccounts()).find((row) => row.id === account.id),
  ).toMatchObject({ displayName: 'Updated', status: 'offline' });
  await expect(
    ctx.store.integrations.upsertAccount({ ...account, endpoint: 'https://changed.example.org' }),
  ).rejects.toThrow('host unavailable');
  expect(await ctx.store.readEgressDestinationUrls()).toContain(account.endpoint);
  expect(await ctx.store.readEgressDestinationUrls()).not.toContain('https://changed.example.org');
  available = true;
  await ctx.store.integrations.upsertAccount({
    ...account,
    endpoint: 'https://changed.example.org',
  });
  expect(fenced).toBe(2);
});
