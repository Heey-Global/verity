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
        enabled: false,
      },
    ]);
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
});
