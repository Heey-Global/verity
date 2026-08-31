import type { AgentEvent } from '@verity/events';
import type { SequencedEvent } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryEventBus } from './bus.js';
import { SessionWriter, type IngestHooks } from './ingest.js';

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

const sessionEvent = (id = 's1', model = 'claude-opus-4-8', worktree = '/wt/a'): AgentEvent => ({
  t: 'session',
  id,
  model,
  worktree,
});
const textEvent = (delta: string): AgentEvent => ({ t: 'text', delta });
const resultEvent = (): AgentEvent => ({
  t: 'result',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  stopReason: 'end_turn',
});
const errorEvent = (message: string): AgentEvent => ({
  t: 'error',
  kind: 'claude_result_error',
  message,
});

/**
 * Drive a whole turn's canonical events through one writer, the way every backend
 * does: write in stream order, then `finish()`. Returns the bound session id.
 *
 * Backends normalize their own transport into {@link AgentEvent}s before they get
 * here (ACP's adapter, Codex's, OpenCode's) — the writer itself is transport-free,
 * so these tests are too.
 */
async function ingest(
  events: AgentEvent[],
  hooks: IngestHooks = {},
  storeSessionId?: string,
): Promise<string | undefined> {
  const writer = new SessionWriter(ctx.store, hooks, storeSessionId);
  for (const event of events) await writer.write(event);
  await writer.finish();
  return writer.currentSessionId;
}

function textDeltas(events: { t: string; delta?: string }[]): (string | undefined)[] {
  return events.filter((e) => e.t === 'text').map((e) => e.delta);
}

describe('SessionWriter (turn ingestion)', () => {
  it('persists the session and its events', async () => {
    const id = await ingest([sessionEvent(), textEvent('hi'), resultEvent()]);
    expect(id).toBe('s1');
    expect(await ctx.store.getSession('s1')).toEqual({
      sessionId: 's1',
      worktree: '/wt/a',
      model: 'claude-opus-4-8',
      name: null,
      projectId: null,
      kind: 'normal',
      lastSeenEventCount: null,
    });
    const events = await ctx.store.getEvents('s1');
    expect(events.map((e) => e.t)).toEqual(['session', 'text', 'result']);
    expect(events[1]).toEqual({ t: 'text', delta: 'hi' });
  });

  it('tracks currentSessionId once the session event is seen', async () => {
    const writer = new SessionWriter(ctx.store);
    expect(writer.currentSessionId).toBeUndefined();
    await writer.write(sessionEvent());
    expect(writer.currentSessionId).toBe('s1');
  });

  it('throws if the turn ends without ever establishing a session', async () => {
    await expect(ingest([textEvent('orphan')])).rejects.toThrow(/no session init/);
  });

  it('throws if an empty turn ends without establishing a session', async () => {
    await expect(ingest([])).rejects.toThrow(/no session init/);
  });

  it('persists terminal resume errors into the known Verity session even without init', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session',
      worktree: '/wt/a',
      model: 'claude-opus-4-8',
    });

    const id = await ingest(
      [errorEvent('No conversation found with session ID: old-claude-id'), resultEvent()],
      {},
      'verity-session',
    );

    expect(id).toBe('verity-session');
    expect((await ctx.store.getEvents('verity-session')).map((e) => e.t)).toEqual([
      'error',
      'result',
    ]);
    expect(await ctx.store.getEvents('verity-session')).toContainEqual({
      t: 'error',
      kind: 'claude_result_error',
      message: 'No conversation found with session ID: old-claude-id',
    });
  });

  it('persists any pre-init terminal turn into a known Verity session', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session',
      worktree: '/wt/a',
      model: 'claude-opus-4-8',
    });

    const id = await ingest([textEvent('early output'), resultEvent()], {}, 'verity-session');

    expect(id).toBe('verity-session');
    expect((await ctx.store.getEvents('verity-session')).map((e) => e.t)).toEqual([
      'text',
      'result',
    ]);
  });

  it('buffers a leading pre-init event and still establishes the session', async () => {
    // A backend that surfaces a corrupt line as a non-throwing `error` event must
    // not abort ingestion with it — the event is buffered, then flushed in order.
    const id = await ingest([errorEvent('corrupt'), sessionEvent(), textEvent('hi')]);
    expect(id).toBe('s1');
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).toEqual(['error', 'session', 'text']);
  });

  it('resumes an existing session without duplicating it, appending more events', async () => {
    await ingest([sessionEvent(), textEvent('first')]);
    await ingest([sessionEvent(), textEvent('second')]);
    expect(await ctx.store.listSessions()).toHaveLength(1);
    expect(textDeltas(await ctx.store.getEvents('s1'))).toEqual(['first', 'second']);
    // Resuming appends a second `session` event — consumers must not assume
    // exactly one session event at index 0.
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).toEqual([
      'session',
      'text',
      'session',
      'text',
    ]);
  });

  it('refuses to rebind a session id to a different worktree (§5a 1:1)', async () => {
    await ingest([sessionEvent()]);
    await expect(ingest([sessionEvent('s1', 'claude-opus-4-8', '/wt/b')])).rejects.toThrow(
      /refusing to rebind/,
    );
  });

  it('remaps the backend session id onto the Verity session id, reporting the backend one to onSession', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session',
      worktree: '/wt/a',
      model: 'claude-opus-4-8',
    });
    const seen: string[] = [];
    const id = await ingest(
      [sessionEvent('backend-sid'), textEvent('hi')],
      {
        onSession: (bound) => {
          seen.push(bound);
        },
      },
      'verity-session',
    );
    expect(id).toBe('verity-session');
    // The hook gets the id the BACKEND minted (what a `--resume` has to be given
    // back), while everything persists under the Verity session id.
    expect(seen).toEqual(['backend-sid']);
    expect((await ctx.store.getEvents('verity-session')).map((e) => e.t)).toEqual([
      'session',
      'text',
    ]);
  });

  it('fires onSession exactly once, with the bound session id', async () => {
    const seen: string[] = [];
    await ingest([sessionEvent(), textEvent('hi'), resultEvent()], {
      onSession: (id) => {
        seen.push(id);
      },
    });
    expect(seen).toEqual(['s1']);
  });

  it('publishes each persisted event to the bus AFTER it lands (persist-then-publish)', async () => {
    const published: SequencedEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribe('s1', (e) => published.push(e));
    await ingest([sessionEvent(), textEvent('hi'), resultEvent()], { bus });
    // the bus broadcasts exactly the events that durably landed, in order, with
    // the same seq the store assigned
    expect(published.map((p) => p.event)).toEqual(await ctx.store.getEvents('s1'));
    expect(published.map((p) => p.event.t)).toEqual(['session', 'text', 'result']);
    expect(published.map((p) => p.seq)).toEqual(
      (await ctx.store.getEventsAfter('s1', 0)).map((s) => s.seq),
    );
  });

  it('publishes buffered pre-init events once the session binds', async () => {
    const published: SequencedEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribe('s1', (e) => published.push(e));
    await ingest([errorEvent('corrupt'), sessionEvent(), textEvent('hi')], { bus });
    expect(published.map((p) => p.event.t)).toEqual(['error', 'session', 'text']);
  });
});

describe('SessionWriter.writePermission (#27)', () => {
  it('persists the prompt with its grant channel, so the transcript records the ask', async () => {
    const writer = new SessionWriter(ctx.store);
    await writer.write(sessionEvent());
    await writer.writePermission(
      { requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_x' },
      'acp',
    );
    await writer.write(resultEvent());
    await writer.finish();

    const events = await ctx.store.getEvents('s1');
    expect(events.map((e) => e.t)).toEqual(['session', 'permission', 'result']);
    expect(events[1]).toEqual({
      t: 'permission',
      id: 'toolu_x',
      tool: 'Bash',
      input: { command: 'ls' },
      riskClass: 'ask',
      // Recorded from the CALLER's transport (ADR 0014 D3), never read off the
      // prompt itself — the agent wrote that.
      grantChannel: 'acp',
    });
  });
});
