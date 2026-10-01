import { InMemoryEventBus, type Conductor } from '@verity/session';
import { EventStore, createSealableSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { startProjectInternalUnixListener } from './internal-listener.js';
import { createMcpGatewayTokens } from './mcp-gateway-tokens.js';
import { createGoogleCalendarTool } from './google-calendar-tool.js';

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

const deletion = {
  action: 'delete_event',
  calendarId: 'primary',
  eventId: 'event',
  expectedEtag: '"etag"',
};

async function harness(
  run: (h: {
    store: EventStore;
    calendar: ReturnType<typeof vi.fn>;
    approvals: ReturnType<typeof vi.fn>;
    call: (
      args: unknown,
      projectId?: string,
    ) => Promise<{ result?: { isError?: boolean }; error?: unknown }>;
  }) => Promise<void>,
  onApproval?: (store: EventStore) => Promise<void>,
) {
  const cipher = createSealableSecretCipher();
  cipher.unlock('ab'.repeat(32));
  const store = new EventStore(ctx.db, cipher);
  for (const id of ['p1', 'p2'])
    await store.createProject({
      id,
      kind: 'local',
      owner: '__local__',
      repo: id,
      cloneDir: id,
      containerName: `verity-${id}`,
      state: 'active',
    });
  await store.createSession({
    sessionId: 's1',
    projectId: 'p1',
    worktree: '/tmp/calendar-gateway-s1',
    model: 'claude-opus-5',
  });
  await store.updateVeritySettings({
    calendarAuthorized: true,
    googleDriveRefreshToken: 'refresh',
    googleDriveAccountEmail: 'me@example.test',
  });
  await store.enableSessionCalendar('s1', 'me@example.test');
  const calendar = vi.fn().mockResolvedValue({ id: 'event' });
  const tool = createGoogleCalendarTool({
    eventStore: store,
    calendar,
    googleAccessToken: async () => 'token',
  });
  const approvals = vi.fn(async () => {
    await onApproval?.(store);
    return { decision: { behavior: 'allow' }, decidedBy: 'card' };
  });
  const tokens = createMcpGatewayTokens();
  const app = buildServer({
    eventStore: store,
    bus: new InMemoryEventBus(),
    secretCipher: cipher,
    conductor: { requestExternalPermission: approvals } as unknown as Conductor,
    mcpGateway: {
      servedTools: ['verity_google_calendar'],
      resolveCaller: async (input) => tokens.resolve(input),
      invokeTool: (input) => tool.invoke(input),
      recordCall: async () => {},
      requestMac: async ({ request: input }) => ({
        requestMac: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        macKeyId: 'key-1',
      }),
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'verity-calendar-gateway-'));
  await app.ready();
  const listener = await startProjectInternalUnixListener(app, {
    socketRoot: dir,
    identity: { projectId: 'p1', containerGeneration: 'generation-1' },
    ownerUid: process.getuid?.() ?? 1000,
    relayGid: process.getgid?.() ?? 1000,
  });
  let id = 0;
  try {
    await run({
      store,
      calendar,
      approvals,
      call: async (args, projectId = 'p1') => {
        const token = tokens.issue({ projectId, sessionId: 's1', turnId: 't1' });
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: { name: 'verity_google_calendar', arguments: args },
        });
        return new Promise((resolve, reject) => {
          const req = request(
            {
              socketPath: listener.socketPath,
              method: 'POST',
              path: '/internal/mcp',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => chunks.push(chunk));
              res.on('end', () => {
                try {
                  resolve(
                    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                      result?: { isError?: boolean };
                      error?: unknown;
                    },
                  );
                } catch (error) {
                  reject(error instanceof Error ? error : new Error(String(error)));
                }
              });
            },
          );
          req.on('error', reject);
          req.end(payload);
        });
      },
    });
  } finally {
    await listener.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

it('uses the server standing authorization only for Calendar reads', async () => {
  await harness(async ({ call, approvals, calendar }) => {
    for (const args of [
      { action: 'list_calendars' },
      {
        action: 'list_events',
        calendarId: 'primary',
        timeMin: '2026-10-01T00:00:00Z',
        timeMax: '2026-10-02T00:00:00Z',
      },
      { action: 'read_event', calendarId: 'primary', eventId: 'event' },
    ])
      expect((await call(args)).result).toBeDefined();
    expect(approvals).not.toHaveBeenCalled();
    // A session grant must never silently authorize event changes without a card.
    for (const args of [
      {
        action: 'create_event',
        calendarId: 'primary',
        event: { summary: 'Meeting', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
      },
      {
        action: 'update_event',
        calendarId: 'primary',
        eventId: 'event',
        expectedEtag: '"etag"',
        event: { summary: 'Changed' },
      },
      deletion,
    ])
      expect((await call(args)).result).toBeDefined();
    expect(approvals).toHaveBeenCalledTimes(3);
    expect(calendar).toHaveBeenCalledTimes(6);
  });
});

it('blocks a Calendar change if the session connection is removed while its card is pending', async () => {
  await harness(
    async ({ call, approvals, calendar }) => {
      expect((await call(deletion)).result?.isError).toBe(true);
      expect(approvals).toHaveBeenCalledTimes(1);
      expect(calendar).not.toHaveBeenCalled();
    },
    async (store) => {
      await store.disableSessionCalendar('s1');
    },
  );
});

it('rejects project and Google account mismatches before raising a Calendar card', async () => {
  await harness(async ({ call, store, approvals, calendar }) => {
    await store.setSessionProject('s1', 'p2');
    const wrongProject = await call(deletion);
    expect(wrongProject.error !== undefined || wrongProject.result?.isError === true).toBe(true);
    await store.setSessionProject('s1', 'p1');
    await store.enableSessionCalendar('s1', 'other@example.test');
    const wrongAccount = await call(deletion);
    expect(wrongAccount.error !== undefined || wrongAccount.result?.isError === true).toBe(true);
    expect(approvals).not.toHaveBeenCalled();
    expect(calendar).not.toHaveBeenCalled();
  });
});
