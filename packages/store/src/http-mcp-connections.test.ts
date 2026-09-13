import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('EventStore — HTTP MCP connections', () => {
  it('persists global connections and updates them by id', async () => {
    await ctx.store.upsertHttpMcpConnection({
      id: 'gmail',
      name: 'Gmail',
      url: 'https://mcp.example.test/gmail',
      authorization: 'Bearer first',
      enabled: true,
    });
    await ctx.store.upsertHttpMcpConnection({
      id: 'gmail',
      name: 'Work Gmail',
      url: 'https://proxy.example.test/gmail',
      authorization: null,
      enabled: false,
    });

    expect(await ctx.store.listHttpMcpConnections()).toEqual([
      {
        id: 'gmail',
        name: 'Work Gmail',
        url: 'https://proxy.example.test/gmail',
        authorization: null,
        authType: 'none',
        oauthClientId: null,
        oauthClientSecret: null,
        oauthAuthorizationEndpoint: null,
        oauthTokenEndpoint: null,
        oauthScopes: null,
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthExpiresAt: null,
        enabled: false,
      },
    ]);
  });

  it('persists OAuth credentials and tokens at the trusted store boundary', async () => {
    await ctx.store.upsertHttpMcpConnection({
      id: 'gmail-oauth',
      name: 'OAuth Gmail',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      authorization: null,
      authType: 'oauth',
      oauthClientId: 'public-client-id',
      oauthClientSecret: 'client-secret',
      oauthAuthorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      oauthTokenEndpoint: 'https://oauth2.googleapis.com/token',
      oauthScopes: 'gmail.readonly gmail.compose',
      oauthAccessToken: 'access-token',
      oauthRefreshToken: 'refresh-token',
      oauthExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
      enabled: true,
    });
    expect(
      (await ctx.store.listHttpMcpConnections()).find((item) => item.id === 'gmail-oauth'),
    ).toMatchObject({
      oauthClientSecret: 'client-secret',
      oauthAccessToken: 'access-token',
      oauthRefreshToken: 'refresh-token',
    });
  });

  it('persists project bindings and cascades them with either parent', async () => {
    const projectId = randomUUID();
    await ctx.store.upsertProject({
      id: projectId,
      owner: 'example',
      repo: 'mcp-test',
      containerName: `mcp-test-${projectId}`,
      state: 'absent',
    });
    await ctx.store.upsertHttpMcpConnection({
      id: 'gmail',
      name: 'Gmail',
      url: 'https://mcp.example.test/gmail',
      authorization: null,
      enabled: true,
    });
    await ctx.store.upsertProjectMcpBinding({
      projectId,
      connectionId: 'gmail',
      enabled: true,
    });

    expect(await ctx.store.listProjectMcpBindings(projectId)).toEqual([
      {
        projectId,
        connectionId: 'gmail',
        enabled: true,
      },
    ]);

    await ctx.store.deleteHttpMcpConnection('gmail');
    expect(await ctx.store.listProjectMcpBindings(projectId)).toEqual([]);
  });

  it('enforces the per-project enabled connection limit at the store boundary', async () => {
    const projectId = randomUUID();
    await ctx.store.upsertProject({
      id: projectId,
      owner: 'example',
      repo: 'mcp-limit',
      containerName: `mcp-limit-${projectId}`,
      state: 'absent',
    });
    for (let index = 0; index < 17; index += 1) {
      const id = `connection-${String(index)}`;
      await ctx.store.upsertHttpMcpConnection({
        id,
        name: `MCP ${String(index)}`,
        url: `https://mcp-${String(index)}.example.test`,
        authorization: null,
        enabled: true,
      });
      const binding = { projectId, connectionId: id, enabled: true };
      if (index < 16)
        await expect(ctx.store.upsertProjectMcpBinding(binding)).resolves.toBeUndefined();
      else
        await expect(ctx.store.upsertProjectMcpBinding(binding)).rejects.toThrow(/limit exceeded/u);
    }
  });
});
