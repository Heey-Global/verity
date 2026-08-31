import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createBrokeredHttpTool } from './brokered-http-tool.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.store.upsertProject({
    id: 'project-1',
    owner: 'acme',
    repo: 'app',
    containerName: 'verity-acme-app',
    state: 'active',
  });
  await ctx.store.createSession({
    sessionId: 'session-1',
    worktree: '/tmp/brokered-http-tool',
    model: 'codex/default',
    projectId: 'project-1',
  });
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

describe('brokered HTTP tool integration', () => {
  it('bounds the complete serialized relay result for escape-heavy bodies', async () => {
    const brokeredTool = createBrokeredHttpTool({
      getProjectBinding: async () => ({
        dopplerProject: 'acme-api',
        dopplerConfig: 'prod',
      }),
      resolveSecret: async () => Buffer.from('doppler-secret-marker'),
      consumeApproval: async () => true,
      transport: async (input) => {
        await input.authorizeRequest();
        return { status: 200, body: JSON.stringify('"\\'.repeat(100_000)) };
      },
    });
    const result = await brokeredTool('project-1', 'session-1', 'turn-1', {
      id: 'call-large',
      name: 'verity_http_request',
      input: {
        method: 'GET',
        url: 'https://api.example.com/v1/large',
        secretAlias: 'API_TOKEN',
        auth: { header: 'authorization', scheme: 'Bearer' },
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.body).toBeNull();
    expect(result.note).toBe('body withheld (truncated)');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });
});
