import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { buildServer } from './server.js';

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

// `createMemberRevocation` revokes a sandbox's authority only with what the
// server composition hands it. Left unwired, every registry is optional, so the
// unit tests stay green while a removed member's capabilities, certificate and
// turn badges all survive their removal.
it("revokes a removed member's sandbox authority through the composed server", async () => {
  await ctx.store.createProject({
    id: 'p',
    owner: '__local__',
    repo: 'p',
    kind: 'local',
    cloneDir: 'p',
    containerName: 'verity-p',
    state: 'active',
  });
  await sql`insert into users (id, role, status) values ('lena', 'member', 'active')`.execute(
    ctx.db,
  );
  await sql`insert into project_memberships (project_id, user_id, can_read, can_execute, can_manage)
    values ('p', 'lena', true, true, false)`.execute(ctx.db);
  const revoked: string[] = [];
  const app = buildServer({
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    conductor: {} as unknown as Conductor,
    turnCredentials: {
      resolve: () => undefined,
      revokeUser: (projectId, userId) => void revoked.push(`badges ${projectId} ${userId}`),
    },
    signingCapabilities: {
      revokeSandbox: vi.fn(async (projectId: string, userId: string) => {
        revoked.push(`signing ${projectId} ${userId}`);
      }),
    } as never,
    ghTokenCapabilities: {
      revokeSandbox: vi.fn(async (projectId: string, userId: string) => {
        revoked.push(`github ${projectId} ${userId}`);
      }),
    } as never,
    claudeEgressIdentity: {
      revokeSandbox: async ({ projectId, userId }) =>
        void revoked.push(`egress ${projectId} ${userId}`),
    },
  });
  try {
    await app.ready();
    const removed = await app.inject({ method: 'DELETE', url: '/projects/p/members/lena' });
    expect(removed.statusCode).toBe(204);
    expect(revoked).toEqual(['badges p lena', 'signing p lena', 'github p lena', 'egress p lena']);
  } finally {
    await app.close();
  }
});
