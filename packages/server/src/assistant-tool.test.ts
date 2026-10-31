import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { gatewayToolNameSchema } from '@verity/secret-contracts';
import {
  ASSISTANT_TOOLS,
  assistantToolRefusal,
  executeAssistantTool,
  requireAssistantGrant,
  type AssistantToolDeps,
} from './assistant-tool.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});

const ADMIN = '00000000-0000-4000-8000-000000000001';
const call = { sessionId: 'assistant', turnId: 'turn-1' };

/** Deps whose permission answers come from a plain map, so each test states exactly which
 *  projects the turn's user may read or execute in. */
function deps(
  rights: Record<string, ('read' | 'execute')[]> = {},
  userId: string | undefined = ADMIN,
): AssistantToolDeps {
  return {
    eventStore: ctx.store,
    initiator: async () => (userId === undefined ? undefined : { userId }),
    permitted: async (_user, projectId, permission) =>
      rights[projectId]?.includes(permission) ?? false,
  };
}

beforeEach(async () => {
  await truncateAll(ctx.db);
  for (const id of ['a', 'b', 'c'])
    await ctx.store.upsertProject({
      id,
      owner: 'team',
      repo: id,
      containerName: id,
      state: 'active',
    });
  await ctx.store.assistant.configure(true, ADMIN);
  await ctx.store.assistant.session('assistant');
});

describe('verity_assistant', () => {
  it('refuses every session except the enabled assistant session', async () => {
    await expect(
      executeAssistantTool(deps(), {
        ...call,
        sessionId: 'other',
        request: { action: 'projects' },
      }),
    ).rejects.toThrow(/belongs to the Verity assistant/);
    await ctx.store.assistant.configure(false, ADMIN);
    await expect(
      executeAssistantTool(deps(), { ...call, request: { action: 'projects' } }),
    ).rejects.toThrow(/disabled/);
  });

  it('lists only granted projects the turn user can still read', async () => {
    await ctx.store.assistant.setGrant('a', ADMIN, 'tasks');
    await ctx.store.assistant.setGrant('b', ADMIN, 'delegate');
    await ctx.store.assistant.setGrant('c', ADMIN, 'off');
    const result = await executeAssistantTool(deps({ a: ['read'], c: ['read'] }), {
      ...call,
      request: { action: 'projects' },
    });
    // b is granted but this user lost access; c is readable but not granted.
    expect(result).toEqual({ projects: [{ projectId: 'a', name: 'team/a', mode: 'tasks' }] });
  });

  it('files a task into a granted project for the turn user, never elsewhere', async () => {
    const add = (projectId: string, rights: AssistantToolDeps) =>
      executeAssistantTool(rights, {
        ...call,
        request: { action: 'add_task', projectId, title: 'Contact form', detail: 'From a note' },
      });
    await expect(add('a', deps({ a: ['read', 'execute'] }))).rejects.toThrow(/no access/);
    await ctx.store.assistant.setGrant('a', ADMIN, 'tasks');
    await expect(add('a', deps({}))).rejects.toThrow(/no access/);
    const result = (await add('a', deps({ a: ['read'] }))) as {
      added: { id: string; project: string };
    };
    expect(result.added.project).toBe('team/a');
    const task = await ctx.store.tasks.get(result.added.id, ADMIN);
    expect(task).toMatchObject({
      projectId: 'a',
      sessionId: null,
      sourceSessionId: 'assistant',
      origin: 'agent',
    });
  });

  it('lets the administrator who enabled it own tasks when auth is off', async () => {
    await ctx.store.assistant.setGrant('a', ADMIN, 'tasks');
    const result = (await executeAssistantTool(deps({ a: ['read'] }, undefined), {
      ...call,
      request: { action: 'add_task', projectId: 'a', title: 'Call Jonas' },
    })) as { added: { id: string } };
    expect(await ctx.store.tasks.get(result.added.id, ADMIN)).toBeDefined();
  });
});

describe('assistant scheduling overview', () => {
  /** A sent request in `projectId`, prepared in `sessionId`, in the given end state. */
  async function request(
    id: string,
    projectId: string | null,
    sessionId: string,
    state: 'open' | 'booked' | 'revoked' = 'open',
    bookedStart = new Date(Date.now() + 86_400_000),
  ) {
    await ctx.store.scheduling.createDraft({
      id,
      sessionId,
      projectId,
      googleAccountId: 'acct',
      calendarId: 'primary',
      timeZone: 'Europe/Berlin',
      language: 'en',
      title: `Call ${id}`,
      durationMinutes: 30,
      addMeet: true,
      organizerName: 'Sam',
      organizerEmail: 'sam@example.test',
      guestEmail: `${id}@example.test`,
      guestName: null,
      colleagues: [],
      emailSubject: 'Pick a time',
      emailBody: 'Hi {link}',
      closesAt: new Date(Date.now() + 7 * 86_400_000),
      windows: [
        {
          start: new Date(Date.now() + 86_400_000),
          end: new Date(Date.now() + 90_000_000),
          eventId: `ev-${id}`,
        },
      ],
    });
    await ctx.store.scheduling.approve(id, 'digest');
    await ctx.store.scheduling.transition(id, ['provisioning'], 'open');
    if (state !== 'open')
      await ctx.store.scheduling.transition(
        id,
        ['open'],
        state,
        state === 'booked'
          ? { bookedStart, bookedEnd: new Date(bookedStart.getTime() + 1_800_000) }
          : {},
      );
  }

  it('lists what is still open in granted projects and its own session, without guest links', async () => {
    await ctx.store.assistant.setGrant('a', ADMIN, 'tasks');
    await ctx.store.assistant.setGrant('b', ADMIN, 'off');
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000005',
      '10000000-0000-4000-8000-000000000006',
    ] as const;
    await request(ids[0], 'a', 'session-in-a');
    await request(ids[1], 'b', 'session-in-b'); // project not granted
    await request(ids[2], null, 'assistant'); // the assistant's own
    await request(ids[3], 'a', 'session-in-a', 'revoked'); // closed
    await request(ids[4], 'a', 'session-in-a', 'booked'); // meeting still ahead
    await request(ids[5], 'a', 'session-in-a', 'booked', new Date(Date.now() - 86_400_000));
    const result = (await executeAssistantTool(deps({ a: ['read', 'execute'] }), {
      ...call,
      request: { action: 'scheduling' },
    })) as { requests: { requestId: string; project: string | null; state: string }[] };
    expect(result.requests.map((r) => r.requestId).sort()).toEqual([ids[0], ids[2], ids[4]].sort());
    expect(result.requests.find((r) => r.requestId === ids[0])).toMatchObject({
      project: 'team/a',
      state: 'open',
    });
    expect(JSON.stringify(result)).not.toContain('pin');
  });

  it('drops a granted project whose requests the turn user may not steer', async () => {
    // The app's overview needs execute access; read access alone must not reveal guests
    // through the assistant either.
    await ctx.store.assistant.setGrant('a', ADMIN, 'delegate');
    await request('20000000-0000-4000-8000-000000000001', 'a', 'session-in-a');
    for (const rights of [{}, { a: ['read' as const] }])
      expect(
        await executeAssistantTool(deps(rights), { ...call, request: { action: 'scheduling' } }),
      ).toEqual({ requests: [] });
  });
});

describe('assistant handoff grant', () => {
  it('needs a delegate grant and execute permission', async () => {
    const check = (rights: AssistantToolDeps) =>
      requireAssistantGrant(rights, { ...call, projectId: 'a' }, 'delegate');
    await ctx.store.assistant.setGrant('a', ADMIN, 'tasks');
    await expect(check(deps({ a: ['read', 'execute'] }))).rejects.toThrow(/may not hand work/);
    await ctx.store.assistant.setGrant('a', ADMIN, 'delegate');
    await expect(check(deps({ a: ['read'] }))).rejects.toThrow(/may not hand work/);
    await expect(check(deps({ a: ['read', 'execute'] }))).resolves.toMatchObject({
      projectName: 'team/a',
    });
  });
});

describe('assistant tool policy', () => {
  const on = { enabled: true, revision: 1, sponsor_user_id: ADMIN, session_id: 'assistant' };
  it('closes every gateway tool not listed, including ones added later', () => {
    // Derived from the gateway's own tool list, so a new Control tool is checked here
    // without anyone remembering to add it.
    for (const tool of gatewayToolNameSchema.options) {
      const refusal = assistantToolRefusal(on, 'assistant', tool);
      expect(refusal === undefined).toBe(ASSISTANT_TOOLS.has(tool));
    }
    for (const tool of [
      'verity_diagnostics',
      'verity_list_sessions',
      'verity_recent_session_messages',
      'verity_secret_run',
      'verity_http_request',
      'verity_knowledge',
      'verity_google_drive',
      'verity_google_docs',
    ])
      expect(assistantToolRefusal(on, 'assistant', tool)).toMatch(/only through/);
  });

  it('leaves only app help while switched off and never restricts other sessions', () => {
    const off = { ...on, enabled: false };
    expect(assistantToolRefusal(off, 'assistant', 'verity_gmail')).toMatch(/disabled/);
    expect(assistantToolRefusal(off, 'assistant', 'verity_app_help')).toBeUndefined();
    expect(assistantToolRefusal(on, 'control', 'verity_diagnostics')).toBeUndefined();
  });
});
