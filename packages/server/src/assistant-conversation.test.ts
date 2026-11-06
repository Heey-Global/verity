import Fastify from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assistantConversationSchema,
  assistantMessagePrompt,
  type AgentEvent,
  type AssistantConversation,
} from '@verity/events';
import type { SequencedEvent } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';

import {
  projectAssistantConversation,
  type AssistantSessionFacts,
} from './assistant-conversation.js';
import {
  registerAssistantConversationRoutes,
  type AssistantConversationRouteDeps,
  type AssistantDispatchResult,
} from './assistant-conversation-routes.js';

const idle: AssistantSessionFacts = {
  status: 'completed',
  busy: false,
  choicesOpen: false,
  approvals: [],
};

function sequenced(events: AgentEvent[], from = 1): SequencedEvent[] {
  return events.map((event, index) => ({ seq: from + index, ts: 1_000 + index, event }));
}

const choices: AgentEvent = {
  t: 'choices',
  question: 'Which client?',
  options: [{ label: 'Hansen', recommended: true }, { label: 'Müller' }],
};

describe('assistant conversation projection', () => {
  it('shows what the user said, what Verity filed and what she replied', () => {
    const projection = projectAssistantConversation(
      sequenced([
        {
          t: 'prompt',
          text: assistantMessagePrompt('Remember the Hansen offer', {
            device: 'watch',
            input: 'voice',
            project: 'team/site',
          }),
          initiatedBy: { userId: 'u1' },
        },
        { t: 'text', delta: 'Filing ' },
        {
          t: 'tool_call',
          id: 'call-1',
          name: 'mcp__verity__verity_assistant',
          input: { action: 'add_task', projectId: 'p1', title: 'Update Hansen offer' },
        },
        { t: 'tool_result', id: 'call-1', output: '{}', isError: false },
        {
          t: 'tool_call',
          id: 'call-2',
          name: 'verity_session_handoff',
          input: {
            target: { newSession: { project: 'team/site' } },
            title: 'Research Hansen',
            briefing: 'b',
          },
        },
        { t: 'tool_result', id: 'call-2', output: 'refused', isError: true },
        { t: 'text', delta: 'Saved.' },
      ]),
      idle,
    );
    expect(projection.items).toEqual([
      // The device and project line is context for Verity, not the user's words.
      {
        kind: 'message',
        id: 'm-1',
        at: 1_000,
        text: 'Remember the Hansen offer',
        timing: { firstMs: 1 },
      },
      { kind: 'reply', id: 'r-2', at: 1_001, text: 'Filing' },
      {
        kind: 'task',
        id: 't-3',
        at: 1_002,
        title: 'Update Hansen offer',
        projectId: 'p1',
        state: 'saved',
      },
      {
        kind: 'assignment',
        id: 't-5',
        at: 1_004,
        title: 'Research Hansen',
        project: 'team/site',
        state: 'failed',
      },
      { kind: 'reply', id: 'r-7', at: 1_006, text: 'Saved.' },
    ]);
    expect(projection).toMatchObject({ revision: 7, state: 'idle', question: null });
  });

  it('shows a meeting Verity prepared or joined, and only her listing call is hidden', () => {
    const projection = projectAssistantConversation(
      sequenced([
        { t: 'prompt', text: 'Join my next meeting' },
        {
          t: 'tool_call',
          id: 'list',
          name: 'mcp__verity__verity_assistant',
          input: { action: 'meetings' },
        },
        { t: 'tool_result', id: 'list', output: '{}', isError: false },
        {
          t: 'tool_call',
          id: 'prep',
          name: 'mcp__verity__verity_assistant',
          input: { action: 'prepare_meeting', mode: 'in_person', title: 'Standup' },
        },
        { t: 'tool_result', id: 'prep', output: '{}', isError: false },
        {
          t: 'tool_call',
          id: 'join',
          name: 'verity_assistant',
          input: { action: 'join_meeting', eventKey: 'ev-1', title: 'Hansen call' },
        },
        { t: 'tool_result', id: 'join', output: 'starts later', isError: true },
      ]),
      idle,
    );
    expect(projection.items.slice(1)).toEqual([
      {
        kind: 'meeting',
        id: 't-4',
        at: 1_003,
        action: 'prepare',
        mode: 'in_person',
        eventKey: null,
        title: 'Standup',
        state: 'ready',
      },
      {
        kind: 'meeting',
        id: 't-6',
        at: 1_005,
        action: 'join',
        mode: 'online',
        eventKey: 'ev-1',
        title: 'Hansen call',
        state: 'failed',
      },
    ]);
    // Devices read the projection through this schema; a card it rejected would vanish.
    expect(
      assistantConversationSchema.parse({
        availability: 'ready',
        sessionId: 'assistant',
        ...projection,
      }).items,
    ).toEqual(projection.items);
  });

  it('keeps the conversation readable when a newer server sends an unknown item', () => {
    const read = assistantConversationSchema.parse({
      availability: 'ready',
      sessionId: 'assistant',
      revision: 2,
      state: 'idle',
      items: [
        { kind: 'hologram', id: 'x-1', at: 1 },
        { kind: 'reply', id: 'r-2', at: 2, text: 'Done.' },
      ],
      question: null,
      approvals: [],
    });
    expect(read.items).toEqual([{ kind: 'reply', id: 'r-2', at: 2, text: 'Done.' }]);
  });

  it('offers the open question under an id that names its event', () => {
    const events = sequenced([
      { t: 'prompt', text: 'Set up the new client' },
      {
        t: 'text',
        delta: 'Which one?\n\n```verity:choices\n{"options":[{"label":"Hansen"}]}\n```',
      },
      choices,
    ]);
    const open = projectAssistantConversation(events, { ...idle, choicesOpen: true });
    expect(open.state).toBe('needs_you');
    expect(open.question).toEqual({
      id: 'q-3',
      question: 'Which client?',
      options: [{ label: 'Hansen', recommended: true }, { label: 'Müller' }],
      multiSelect: false,
    });
    // The machine block never reaches a device as prose.
    expect(open.items.at(-1)).toMatchObject({ kind: 'reply', text: 'Which one?' });
    // Answered (the summary no longer reports it): no question, whatever the log holds.
    expect(projectAssistantConversation(events, idle).question).toBeNull();
  });

  it('reports work, approvals and failures as the conversation state', () => {
    const events = sequenced([{ t: 'prompt', text: 'Draft a reply' }]);
    expect(projectAssistantConversation(events, { ...idle, busy: true }).state).toBe('working');
    expect(
      projectAssistantConversation(events, {
        ...idle,
        busy: true,
        approvals: [{ toolUseId: 'perm-1', tool: 'verity_gmail' }],
      }),
    ).toMatchObject({ state: 'needs_you', approvals: [{ id: 'perm-1', tool: 'verity_gmail' }] });
    const failed = projectAssistantConversation(
      sequenced([
        ...[{ t: 'prompt', text: 'x' } as AgentEvent],
        { t: 'error', kind: 'spawn', message: 'Agent stopped' },
      ]),
      idle,
    );
    expect(failed.state).toBe('failed');
    expect(failed.items.at(-1)).toMatchObject({ kind: 'error', text: 'Agent stopped' });
  });

  it('times each message to the first reaction and the end of its turn', () => {
    const events: SequencedEvent[] = [
      { seq: 1, ts: 10_000, event: { t: 'prompt', text: 'What is open?' } },
      // A subagent's text is not something the user sees.
      { seq: 2, ts: 10_400, event: { t: 'text', delta: 'x', parentToolId: 'task-1' } },
      {
        seq: 3,
        ts: 11_200,
        event: { t: 'tool_call', id: 'c', name: 'verity_tasks', input: {} },
      },
      { seq: 4, ts: 12_000, event: { t: 'text', delta: 'Two offers.' } },
      {
        seq: 5,
        ts: 13_500,
        event: {
          t: 'result',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        },
      },
      { seq: 6, ts: 20_000, event: { t: 'prompt', text: 'And Hansen?' } },
    ];
    const { items } = projectAssistantConversation(events, idle);
    expect(items[0]).toMatchObject({ timing: { firstMs: 1_200, doneMs: 3_500 } });
    expect(items.at(-1)).toMatchObject({ kind: 'message', text: 'And Hansen?' });
    expect(items.at(-1)).not.toHaveProperty('timing');
  });

  it('leaves out messages from linked sessions and keeps only the newest items', () => {
    const events = sequenced([
      {
        t: 'prompt',
        text: 'from a peer',
        peer: { sessionId: 's', projectId: 'p', label: 'l', message: 'm' },
      },
      ...Array.from({ length: 5 }, (_, i): AgentEvent => ({ t: 'prompt', text: `n${String(i)}` })),
    ]);
    const projection = projectAssistantConversation(events, idle, 3);
    expect(projection.items.map((item) => (item.kind === 'message' ? item.text : ''))).toEqual([
      'n2',
      'n3',
      'n4',
    ]);
  });
});

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'site',
    owner: 'team',
    repo: 'site',
    containerName: 'site',
    state: 'active',
  });
});

function server(options: { admin?: boolean } = {}) {
  vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(options.admin ?? true);
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.localUserId = 'u1';
  });
  const log: AgentEvent[] = [];
  const listeners = new Set<() => void>();
  /** Appends like the session pipeline: persist, then publish. */
  const emit = (event: AgentEvent) => {
    log.push(event);
    for (const listener of listeners) listener();
  };
  let facts: AssistantSessionFacts = idle;
  const dispatch = vi.fn<AssistantConversationRouteDeps['dispatch']>(
    async (_id, prompt): Promise<AssistantDispatchResult> => {
      emit({ t: 'prompt', text: prompt });
      return { ok: true };
    },
  );
  registerAssistantConversationRoutes(app, ctx.store, {
    sessionExists: async (id) => (await ctx.store.getSession(id)) !== undefined,
    recentEvents: async () => sequenced(log),
    facts: async () => facts,
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    projects: async () => [{ projectId: 'site', name: 'team/site', mode: 'delegate' }],
    dispatch,
  });
  return {
    app,
    log,
    emit,
    listeners,
    dispatch,
    setFacts: (next: AssistantSessionFacts) => {
      facts = next;
    },
  };
}

async function enable() {
  await ctx.store.createSession({ sessionId: 'assistant', worktree: '/a', model: 'm' });
  await ctx.store.assistant.configure(true, 'u1');
  await ctx.store.assistant.session('assistant');
}

const message = {
  requestId: 'req-00000001',
  text: 'Remember the Hansen offer',
  input: 'voice',
  device: 'watch',
  projectId: 'site',
} as const;

describe('assistant conversation routes', () => {
  it('keeps the conversation with administrators, like the assistant itself', async () => {
    await enable();
    const { app, dispatch } = server({ admin: false });
    try {
      expect((await app.inject({ url: '/assistant/conversation' })).statusCode).toBe(403);
      const sent = await app.inject({
        method: 'POST',
        url: '/assistant/conversation/messages',
        payload: message,
      });
      expect(sent.statusCode).toBe(403);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reports a switched-off assistant instead of filing the note as a task', async () => {
    const { app, dispatch } = server();
    try {
      const read = await app.inject({ url: '/assistant/conversation' });
      expect(assistantConversationSchema.parse(read.json())).toMatchObject({
        availability: 'disabled',
        items: [],
      });
      const sent = await app.inject({
        method: 'POST',
        url: '/assistant/conversation/messages',
        payload: message,
      });
      expect(sent.statusCode).toBe(409);
      expect(sent.json()).toMatchObject({ code: 'disabled' });
      expect(dispatch).not.toHaveBeenCalled();
      // No silent fallback: nothing is filed when Verity cannot take the note.
      const tasks = await sql<{ n: number }>`select count(*)::int as n from tasks`.execute(ctx.db);
      expect(tasks.rows[0]?.n).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('delivers a message once however often a device replays it', async () => {
    await enable();
    const { app, dispatch, log } = server();
    try {
      const send = () =>
        app.inject({ method: 'POST', url: '/assistant/conversation/messages', payload: message });
      expect((await send()).json()).toEqual({ requestId: message.requestId, delivered: true });
      expect((await send()).json()).toEqual({ requestId: message.requestId, delivered: false });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]![2]).toEqual({ userId: 'u1', requestId: message.requestId });
      expect(log[0]).toMatchObject({
        text: expect.stringContaining(
          'Apple Watch, dictated, while project "team/site" was open. ' +
            'Projects you may use: "team/site" (id site, delegate).',
        ),
      });
      const read = assistantConversationSchema.parse(
        (await app.inject({ url: '/assistant/conversation' })).json(),
      );
      expect(read).toMatchObject({
        availability: 'ready',
        sessionId: 'assistant',
        items: [{ kind: 'message', text: 'Remember the Hansen offer' }],
      });
    } finally {
      await app.close();
    }
  });

  it('refuses a request id reused for an answer instead of reporting it delivered', async () => {
    await enable();
    const { app, log, setFacts } = server();
    try {
      log.push({ t: 'prompt', text: 'Set up the new client' }, choices);
      setFacts({ ...idle, choicesOpen: true });
      await app.inject({
        method: 'POST',
        url: '/assistant/conversation/messages',
        payload: message,
      });
      const reused = await app.inject({
        method: 'POST',
        url: '/assistant/conversation/answers',
        payload: {
          requestId: message.requestId,
          questionId: 'q-2',
          labels: ['Hansen'],
          device: 'watch',
        },
      });
      expect(reused.json()).toMatchObject({ code: 'conflict' });
    } finally {
      await app.close();
    }
  });

  it('lets a refused delivery be retried under the same id', async () => {
    await enable();
    const { app, dispatch } = server();
    try {
      dispatch.mockResolvedValueOnce({ ok: false, status: 429, error: 'busy' });
      const send = () =>
        app.inject({ method: 'POST', url: '/assistant/conversation/messages', payload: message });
      expect((await send()).statusCode).toBe(429);
      expect((await send()).json()).toEqual({ requestId: message.requestId, delivered: true });
    } finally {
      await app.close();
    }
  });

  it('accepts one answer per question and refuses stale or invented ones', async () => {
    await enable();
    const { app, dispatch, log, setFacts } = server();
    try {
      log.push({ t: 'prompt', text: 'Set up the new client' }, choices);
      setFacts({ ...idle, choicesOpen: true });
      const conversation = (
        await app.inject({ url: '/assistant/conversation' })
      ).json<AssistantConversation>();
      expect(conversation.question?.id).toBe('q-2');
      const answer = (requestId: string, labels: string[], questionId = 'q-2') =>
        app.inject({
          method: 'POST',
          url: '/assistant/conversation/answers',
          payload: { requestId, questionId, labels, device: 'watch' },
        });

      expect((await answer('watch-0001', ['Schmidt'])).statusCode).toBe(400);
      expect((await answer('watch-0001', ['Hansen', 'Müller'])).statusCode).toBe(400);
      expect((await answer('watch-0001', ['Hansen'], 'q-1')).json()).toMatchObject({
        code: 'stale_question',
      });
      expect((await answer('watch-0001', ['Hansen'])).statusCode).toBe(202);
      expect(log.at(-1)).toEqual({ t: 'prompt', text: 'Hansen' });
      // The phone answered the same question at the same moment.
      expect((await answer('phone-00001', ['Müller'])).json()).toMatchObject({ code: 'answered' });
      // The Watch replays its own answer after the question closed: still its success.
      setFacts(idle);
      expect((await answer('watch-0001', ['Hansen'])).json()).toEqual({
        requestId: 'watch-0001',
        delivered: false,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('holds a read until Verity writes, then answers with the change', async () => {
    await enable();
    const { app, emit, listeners } = server();
    try {
      emit({ t: 'prompt', text: 'What is open?' });
      const pending = app.inject({ url: '/assistant/conversation?after=1&waitMs=20000' });
      await vi.waitFor(() => expect(listeners.size).toBe(1));
      emit({ t: 'text', delta: 'Two ' });
      emit({ t: 'text', delta: 'offers.' });
      const read = assistantConversationSchema.parse((await pending).json());
      expect(read.revision).toBe(3);
      expect(read.items.at(-1)).toMatchObject({ kind: 'reply', text: 'Two offers.' });
      expect(listeners.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('answers a read at once when the device is behind, and unchanged after the wait', async () => {
    await enable();
    const { app, emit } = server();
    try {
      emit({ t: 'prompt', text: 'What is open?' });
      const started = Date.now();
      const behind = await app.inject({ url: '/assistant/conversation?after=0&waitMs=20000' });
      expect(behind.json<AssistantConversation>().revision).toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);
      const unchanged = await app.inject({ url: '/assistant/conversation?after=1&waitMs=50' });
      expect(unchanged.json<AssistantConversation>().revision).toBe(1);
    } finally {
      await app.close();
    }
  });
});
