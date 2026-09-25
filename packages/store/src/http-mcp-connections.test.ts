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
  it('persists administrator-owned connections and updates them by id', async () => {
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
        ownerUserId: '00000000-0000-4000-8000-000000000001',
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

  it('lists a user’s connections without revealing another user’s credentials', async () => {
    const memberId = randomUUID();
    await ctx.db
      .insertInto('users')
      .values({ id: memberId, role: 'member', status: 'active' })
      .execute();
    await ctx.store.upsertHttpMcpConnection({
      id: 'private-member',
      ownerUserId: memberId,
      name: 'Private Member',
      url: 'https://mcp.example.test/member',
      authorization: 'Bearer private',
      enabled: true,
    });
    await ctx.store.upsertHttpMcpConnection({
      id: 'admin',
      name: 'Admin',
      url: 'https://mcp.example.test/admin',
      authorization: 'Bearer admin',
      enabled: true,
    });

    expect((await ctx.store.listHttpMcpConnections(memberId)).map((item) => item.id)).toEqual([
      'private-member',
    ]);
    expect(
      (await ctx.store.listHttpMcpConnections('00000000-0000-4000-8000-000000000001')).map(
        (item) => item.id,
      ),
    ).toEqual(['admin']);
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
