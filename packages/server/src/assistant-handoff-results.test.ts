import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ASSISTANT_HANDOFF_CLOSING_REQUEST } from '@verity/events';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import {
  assistantHandoff,
  executeAssistantTool,
  type AssistantToolDeps,
} from './assistant-tool.js';
import { SESSION_HANDOFF_TRANSCRIPT_LABEL } from './session-handoff-tool.js';

/** The transcript line a delivered assistant briefing leaves in its target. */
const briefingPrompt = {
  t: 'prompt' as const,
  text: [
    SESSION_HANDOFF_TRANSCRIPT_LABEL,
    'Title: Backup check',
    'Check it.',
    ASSISTANT_HANDOFF_CLOSING_REQUEST,
  ].join('\n\n'),
};

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});

const ADMIN = '00000000-0000-4000-8000-000000000001';
const call = { sessionId: 'assistant', turnId: 'turn-1' };

function deps(
  readable: readonly string[] = ['a', 'b'],
  status: AssistantToolDeps['sessionStatus'] = () => 'idle',
): AssistantToolDeps {
  return {
    eventStore: ctx.store,
    initiator: async () => ({ userId: ADMIN }),
    permitted: async (_user, projectId) => readable.includes(projectId),
    sessionStatus: status,
  };
}

/** Hands off to `target` the way the gateway route does, returning what the target was sent. */
async function handOff(target: string, from = 'assistant', title = 'Backup check') {
  let sent: { closingRequest?: string } | undefined;
  await assistantHandoff(
    { eventStore: ctx.store },
    { ...call, sessionId: from, request: { title } },
    {
      handoff: async (input) => {
        sent = input;
        return { sessionId: target };
      },
    },
  );
  return sent;
}

const results = async (request: Record<string, unknown> = {}, rights = deps()) =>
  (await executeAssistantTool(rights, {
    ...call,
    request: { action: 'handoff_results', ...request },
  })) as { handoffs: Record<string, unknown>[] };

beforeEach(async () => {
  await truncateAll(ctx.db);
  for (const id of ['a', 'b'])
    await ctx.store.upsertProject({
      id,
      owner: 'team',
      repo: id,
      containerName: id,
      state: 'active',
    });
  await ctx.store.assistant.configure(true, ADMIN);
  await ctx.store.assistant.session('assistant');
  await ctx.store.assistant.setGrant('a', ADMIN, 'delegate');
  await ctx.store.assistant.setGrant('b', ADMIN, 'delegate');
  await ctx.store.createSession({ sessionId: 'assistant', worktree: '/assistant', model: 'm' });
  await ctx.store.createSession({ sessionId: 'control', worktree: '/control', model: 'm' });
  await ctx.store.createSession({ sessionId: 't1', worktree: '/t1', model: 'm', projectId: 'a' });
  await ctx.store.createSession({ sessionId: 't2', worktree: '/t2', model: 'm', projectId: 'b' });
  await ctx.store.appendEvent('t1', { t: 'prompt', text: 'Earlier work' });
});

describe('assistant handoff results', () => {
  it('asks the target for an outcome only when the assistant hands off', async () => {
    expect((await handOff('t1'))?.closingRequest).toBe(ASSISTANT_HANDOFF_CLOSING_REQUEST);
    // Another Control session's handoff is delivered unchanged and not remembered for the
    // assistant: its targets must stay unreadable through "handoff_results".
    expect((await handOff('t2', 'control'))?.closingRequest).toBeUndefined();
    // Nor can another caller's input carry one through to the delivery.
    let forwarded: object | undefined;
    await assistantHandoff(
      { eventStore: ctx.store },
      { ...call, sessionId: 'control', closingRequest: 'Smuggled' },
      {
        handoff: async (input) => {
          forwarded = input;
          return { sessionId: 't2' };
        },
      },
    );
    expect(forwarded).not.toHaveProperty('closingRequest');
    expect((await results()).handoffs.map((h) => h.sessionId)).toEqual(['t1']);
  });

  it('returns the outcome published after the handoff, not an earlier turn’s', async () => {
    // Published before the briefing arrived: it answers some other request.
    await ctx.store.appendEvent('t1', {
      t: 'session_progress',
      summary: 'Old answer',
      outcomeDelivered: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handOff('t1');
    expect((await results()).handoffs[0]).toMatchObject({
      sessionId: 't1',
      project: 'team/a',
      title: 'Backup check',
      state: 'idle',
      result: null,
    });
    // Queued behind a running turn: that turn's own outcome is not the briefing's answer.
    await ctx.store.appendEvent('t1', {
      t: 'session_progress',
      summary: 'Answer to the running turn',
      outcomeDelivered: true,
    });
    expect((await results()).handoffs[0]).toMatchObject({ result: null });
    await ctx.store.appendEvent('t1', briefingPrompt);
    expect((await results()).handoffs[0]).toMatchObject({ result: null });
    await ctx.store.appendEvent('t1', {
      t: 'session_progress',
      summary: 'Documents are excluded from the backup since the last release.',
      outcomeDelivered: true,
      requiredDecision: 'Keep the exclusion?',
    });
    expect((await results({ sessionId: 't1' })).handoffs).toEqual([
      expect.objectContaining({
        result: {
          outcomeDelivered: true,
          summary: 'Documents are excluded from the backup since the last release.',
          requiredDecision: 'Keep the exclusion?',
          publishedAt: expect.any(String),
        },
      }),
    ]);
    // A later prompt in that session starts a new request; its answer is no longer current.
    await ctx.store.appendEvent('t1', { t: 'prompt', text: 'Something else' });
    expect((await results()).handoffs[0]).toMatchObject({ result: null });
  });

  it('reports working and waiting sessions and never returns transcript text', async () => {
    await handOff('t1');
    const working = await results(
      {},
      deps(['a'], () => 'running'),
    );
    expect(working.handoffs[0]).toMatchObject({ state: 'working', result: null });
    expect(JSON.stringify(working)).not.toContain('Earlier work');
    const waiting = await results(
      {},
      deps(['a'], () => 'awaiting_input'),
    );
    expect(waiting.handoffs[0]).toMatchObject({ state: 'needs_input' });
  });

  it('refuses sessions it did not brief and drops projects whose access was withdrawn', async () => {
    await handOff('t1');
    await handOff('t2');
    await expect(results({ sessionId: 'control' })).rejects.toThrow(/not one of your handoffs/);
    expect((await results({}, deps(['a']))).handoffs.map((h) => h.sessionId)).toEqual(['t1']);
    await ctx.store.assistant.setGrant('a', ADMIN, 'off');
    expect((await results({}, deps(['a', 'b']))).handoffs.map((h) => h.sessionId)).toEqual(['t2']);
    await expect(
      executeAssistantTool(deps(), {
        ...call,
        sessionId: 'control',
        request: { action: 'handoff_results' },
      }),
    ).rejects.toThrow(/belongs to the Verity assistant/);
  });
});
