import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractToolResultImages, sessionProjectionEvents, type AgentEvent } from '@verity/events';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  backfillInlineAttachments,
  backfillToolResultImages,
  backfillToolResultText,
  type MessageSearchInput,
  type MessageSearchResult,
  PROJECT_MEMORY_MAX_CHARS,
  ProjectMemoryTooLargeError,
  waitForPendingMessageProjections,
} from './store.js';
import { createIsolatedTestDb, createTestDb, truncateAll, type TestDb } from './testing.js';

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

const session = { sessionId: 's1', worktree: '/wt/agent-s1', model: 'claude-opus-4-8' };

const sampleEvents: AgentEvent[] = [
  { t: 'session', id: 's1', model: 'claude-opus-4-8', worktree: '/wt/agent-s1' },
  { t: 'text', delta: 'hello' },
  { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
  { t: 'raw', backend: 'claude-code', payload: { nested: { a: 1 }, list: [1, 2] } },
];

describe('EventStore — attachments', () => {
  // base64 of "hello" → known sha256 of the decoded bytes.
  const helloB64 = Buffer.from('hello').toString('base64');

  it('stores a blob content-addressed by SHA-256 and reads it back', async () => {
    const hash = await ctx.store.putAttachment('image/png', helloB64);
    expect(hash).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', // sha256("hello")
    );
    const blob = await ctx.store.getAttachment(hash);
    expect(blob?.mediaType).toBe('image/png');
    expect(blob?.bytes.toString('utf8')).toBe('hello');
  });

  it('dedupes identical bytes to one row (idempotent put)', async () => {
    const a = await ctx.store.putAttachment('image/png', helloB64);
    const b = await ctx.store.putAttachment('image/png', helloB64);
    expect(a).toBe(b);
    const count = await ctx.db
      .selectFrom('attachments')
      .select((eb) => eb.fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('returns undefined for an unknown hash', async () => {
    expect(await ctx.store.getAttachment('deadbeef')).toBeUndefined();
  });

  it('back-fills inline prompt attachments into refs (idempotently)', async () => {
    await ctx.store.createSession(session);
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/x' });
    await ctx.store.appendEvent('s1', {
      t: 'prompt',
      text: 'old inline image',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: helloB64 }],
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'plain, no image' });

    const migrated = await backfillInlineAttachments(ctx.db);
    expect(migrated).toBe(1);

    const events = await ctx.store.getEvents('s1');
    const prompt = events.find((e) => e.t === 'prompt' && e.text === 'old inline image');
    const ref = prompt?.t === 'prompt' ? prompt.attachments?.[0] : undefined;
    expect(ref).toMatchObject({ kind: 'image', mediaType: 'image/png', id: expect.any(String) });
    expect(ref && 'data' in ref).toBe(false); // inline base64 stripped
    const blob = await ctx.store.getAttachment(ref?.id ?? '');
    expect(blob?.bytes.toString('utf8')).toBe('hello');

    // Idempotent: a second run finds nothing left to migrate.
    expect(await backfillInlineAttachments(ctx.db)).toBe(0);
  });
});

describe('EventStore — message search projection', () => {
  it('never reports canonical append failure when projection maintenance fails', async () => {
    // Isolated for real: this drops a table, which on the shared instance would
    // break every file that runs after it in this worker.
    const isolated = await createIsolatedTestDb();
    try {
      await isolated.store.createSession(session);
      await isolated.db.schema.dropTable('messages').execute();
      isolated.store.scheduleMessageProjection = () => undefined;
      await expect(
        isolated.store.appendEvent('s1', {
          t: 'prompt',
          text: 'durable despite projection failure',
        }),
      ).resolves.toEqual({ seq: expect.any(Number), ts: expect.any(Number) });
      await waitForPendingMessageProjections(isolated.db);
      expect(await isolated.store.getEvents('s1')).toContainEqual({
        t: 'prompt',
        text: 'durable despite projection failure',
      });
    } finally {
      await isolated.close();
    }
  });

  // `searchMessages` gives the live projector a 50 ms budget and then answers from
  // whatever is already indexed, on purpose — a search must not block behind a slow
  // projection. In-process pglite always wins that race, so these tests used to pass
  // without ever saying so; a socket-backed PostgreSQL under CI load does not, and
  // the projection of four events arrived after the read. What is asserted below is
  // *what* search returns, never how fast the projector is, so drain it explicitly.
  // Draining here does not weaken the assertions: a projection that never lands
  // fails them either way, it just no longer depends on winning a 50 ms race.
  const search = async (input: MessageSearchInput): Promise<MessageSearchResult[]> => {
    await ctx.store.waitForMessageProjectionIdle();
    return ctx.store.searchMessages(input);
  };

  it('searches complete visible messages across text delta boundaries', async () => {
    await ctx.store.createSession(session);
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'Find the deployment notes' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'The data' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'base migration is resumable.' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      permissionDenials: [],
    });

    const results = await search({ query: 'database migration' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionId: 's1',
      role: 'agent',
      kind: 'text',
      text: 'The database migration is resumable',
    });
  });

  it('does not expose tool, thinking, or sub-agent text', async () => {
    await ctx.store.createSession(session);
    await ctx.store.appendEvent('s1', {
      t: 'thinking',
      blockId: 'b1',
      delta: 'private-search-token',
    });
    await ctx.store.appendEvent('s1', {
      t: 'tool_call',
      id: 'tool1',
      name: 'Bash',
      input: { command: 'secret-tool-token' },
    });
    await ctx.store.appendEvent('s1', {
      t: 'text',
      delta: 'subagent-search-token',
      parentToolId: 'tool1',
    });
    expect(await search({ query: 'private-search-token' })).toEqual([]);
    expect(await search({ query: 'secret-tool-token' })).toEqual([]);
    expect(await search({ query: 'subagent-search-token' })).toEqual([]);
  });

  it('paginates by rank, timestamp, and id without duplicates', async () => {
    await ctx.store.createSession(session);
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'needle first' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'needle second' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'needle third' });
    const first = await search({ query: 'needle', limit: 1 });
    expect(first).toHaveLength(1);
    const row = first[0];
    expect(row).toBeDefined();
    const second = await search({
      query: 'needle',
      limit: 2,
      cursor: { rank: row!.rank, createdAt: row!.createdAt, id: row!.id },
    });
    expect(second).toHaveLength(2);
    expect(new Set([row!.id, ...second.map((item) => item.id)]).size).toBe(3);
  });

  it('returns a bounded snippet instead of the complete message body', async () => {
    await ctx.store.createSession(session);
    const padding = Array.from({ length: 300 }, (_, index) => `word${index}`).join(' ');
    await ctx.store.appendEvent('s1', { t: 'prompt', text: `${padding} unique-needle ${padding}` });
    const results = await search({ query: 'unique-needle' });
    expect(results[0]?.text).toContain('unique-needle');
    expect(results[0]?.text.length).toBeLessThan(500);
  });

  it('rebuilds a projection whose stored version is stale', async () => {
    await ctx.store.createSession(session);
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'versioned needle' });
    expect(await search({ query: 'versioned' })).toHaveLength(1);
    await ctx.db
      .updateTable('message_projection_state')
      .set({ projection_version: 0 })
      .where('session_id', '=', 's1')
      .execute();
    await ctx.db
      .updateTable('messages')
      .set({ text: 'stale content' })
      .where('session_id', '=', 's1')
      .execute();
    // The stale-version rebuild is kicked off by the search call itself, so this one
    // stays unbuffered — draining first would prove nothing about what triggers it.
    await ctx.store.searchMessages({ query: 'versioned' });
    expect(await search({ query: 'versioned' })).toHaveLength(1);
    expect(await search({ query: 'stale' })).toEqual([]);
  });
});

describe('EventStore — tool-result images (#115)', () => {
  const helloB64 = Buffer.from('hello').toString('base64');
  const helloHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  const imageResult = (data: string) => [
    { type: 'text', text: 'the file:' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ];

  it('appendEvent externalizes inline tool_result images to content-addressed refs', async () => {
    await ctx.store.createSession(session);
    const live: AgentEvent = {
      t: 'tool_result',
      id: 'toolu_1',
      isError: false,
      output: imageResult(helloB64),
    };
    await ctx.store.appendEvent('s1', live);

    // The live event object is left untouched (so the fan-out can broadcast the
    // inline bytes the client already has) …
    expect(extractToolResultImages(live.output)).toEqual([
      { mediaType: 'image/png', data: helloB64 },
    ]);
    // … while the PERSISTED copy carries only a ref, and the bytes are in the blob store.
    const events = await ctx.store.getEvents('s1');
    const stored = events.find((e) => e.t === 'tool_result');
    const images = extractToolResultImages(stored?.t === 'tool_result' ? stored.output : undefined);
    expect(images).toEqual([{ mediaType: 'image/png', id: helloHash }]);
    expect(await ctx.store.getAttachment(helloHash)).toMatchObject({ mediaType: 'image/png' });
  });

  it('leaves image-free tool results untouched', async () => {
    await ctx.store.createSession(session);
    const output = [{ type: 'text', text: 'plain output' }];
    await ctx.store.appendEvent('s1', { t: 'tool_result', id: 't', isError: false, output });
    const events = await ctx.store.getEvents('s1');
    const stored = events.find((e) => e.t === 'tool_result');
    expect(stored?.t === 'tool_result' ? stored.output : null).toEqual(output);
  });

  it('back-fills inline images on existing tool_result events (idempotently)', async () => {
    await ctx.store.createSession(session);
    // Simulate a pre-#115 event by inserting inline bytes straight to the row,
    // bypassing appendEvent's externalization.
    await ctx.db
      .insertInto('events')
      .values({
        session_id: 's1',
        type: 'tool_result',
        payload: JSON.stringify({
          t: 'tool_result',
          id: 'toolu_old',
          isError: false,
          output: imageResult(helloB64),
        }),
      })
      .execute();

    expect(await backfillToolResultImages(ctx.db)).toBe(1);

    const events = await ctx.store.getEvents('s1');
    const stored = events.find((e) => e.t === 'tool_result');
    expect(
      extractToolResultImages(stored?.t === 'tool_result' ? stored.output : undefined),
    ).toEqual([{ mediaType: 'image/png', id: helloHash }]);
    expect(await ctx.store.getAttachment(helloHash)).toBeDefined();

    // Idempotent: a second run finds nothing left to migrate.
    expect(await backfillToolResultImages(ctx.db)).toBe(0);
  });
});

describe('EventStore — large text tool results', () => {
  const bigText = 'x'.repeat(5000); // > TOOL_TEXT_EXTERNALIZE_THRESHOLD (4096)
  const sha256Utf8 = (s: string) =>
    createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

  it('appendEvent externalizes a large text output to a truncated preview + outputRef', async () => {
    await ctx.store.createSession(session);
    const live: AgentEvent = { t: 'tool_result', id: 'toolu_1', isError: false, output: bigText };
    await ctx.store.appendEvent('s1', live);

    // Live object untouched (full text still available for the immediate render).
    expect(live.output).toBe(bigText);

    const events = await ctx.store.getEvents('s1');
    const stored = events.find((e) => e.t === 'tool_result');
    if (stored?.t !== 'tool_result') throw new Error('expected a tool_result');
    // Inline output is now a truncated preview, and an outputRef points at the full body.
    expect(typeof stored.output === 'string' && stored.output.length).toBe(1024);
    expect(stored.outputRef).toEqual({
      id: sha256Utf8(JSON.stringify(bigText)),
      bytes: expect.any(Number),
    });

    // The full body is retrievable and round-trips to the original output.
    const blob = await ctx.store.getAttachment(stored.outputRef?.id ?? '');
    expect(blob?.mediaType).toBe('application/json');
    expect(JSON.parse(blob?.bytes.toString('utf8') ?? 'null')).toBe(bigText);
  });

  it('leaves small text outputs inline (no outputRef)', async () => {
    await ctx.store.createSession(session);
    await ctx.store.appendEvent('s1', {
      t: 'tool_result',
      id: 't',
      isError: false,
      output: 'small',
    });
    const events = await ctx.store.getEvents('s1');
    const stored = events.find((e) => e.t === 'tool_result');
    if (stored?.t !== 'tool_result') throw new Error('expected a tool_result');
    expect(stored.output).toBe('small');
    expect(stored.outputRef).toBeUndefined();
  });

  it('back-fills large inline text on existing tool_result events (idempotently)', async () => {
    await ctx.store.createSession(session);
    // Simulate a pre-existing event by inserting the full inline text directly.
    await ctx.db
      .insertInto('events')
      .values({
        session_id: 's1',
        type: 'tool_result',
        payload: JSON.stringify({ t: 'tool_result', id: 'old', isError: false, output: bigText }),
      })
      .execute();

    expect(await backfillToolResultText(ctx.db)).toBe(1);

    const events = await ctx.store.getEvents('s1');
    const stored = events.find((e) => e.t === 'tool_result');
    if (stored?.t !== 'tool_result') throw new Error('expected a tool_result');
    expect(stored.outputRef?.id).toBe(sha256Utf8(JSON.stringify(bigText)));
    const blob = await ctx.store.getAttachment(stored.outputRef?.id ?? '');
    expect(JSON.parse(blob?.bytes.toString('utf8') ?? 'null')).toBe(bigText);

    // Idempotent: a second run finds nothing left to migrate.
    expect(await backfillToolResultText(ctx.db)).toBe(0);
  });
});

describe('EventStore — sessions', () => {
  it('round-trips a session', async () => {
    await ctx.store.createSession(session);
    // A session with no name set reads back with `name: null`.
    expect(await ctx.store.getSession('s1')).toEqual({
      ...session,
      name: null,
      projectId: null,
      kind: 'normal',
      lastSeenEventCount: null,
    });
  });

  it('persists a name supplied at creation', async () => {
    await ctx.store.createSession({ ...session, name: 'Add settings' });
    expect(await ctx.store.getSession('s1')).toEqual({
      ...session,
      name: 'Add settings',
      projectId: null,
      kind: 'normal',
      lastSeenEventCount: null,
    });
  });

  it('setSessionSeen advances the unread mark monotonically; 404s an unknown id', async () => {
    await ctx.store.createSession(session);
    expect((await ctx.store.getSession('s1'))?.lastSeenEventCount).toBeNull();

    expect(await ctx.store.setSessionSeen('s1', 8)).toBe(true);
    expect((await ctx.store.getSession('s1'))?.lastSeenEventCount).toBe(8);

    // A stale mark must not move it backward (would resurrect a cleared dot).
    expect(await ctx.store.setSessionSeen('s1', 3)).toBe(true);
    expect((await ctx.store.getSession('s1'))?.lastSeenEventCount).toBe(8);

    // A fresher mark advances it.
    expect(await ctx.store.setSessionSeen('s1', 20)).toBe(true);
    expect((await ctx.store.getSession('s1'))?.lastSeenEventCount).toBe(20);

    // Unknown session id → false (the server maps this to a 404).
    expect(await ctx.store.setSessionSeen('missing', 1)).toBe(false);
  });

  it('returns undefined for an unknown session', async () => {
    expect(await ctx.store.getSession('missing')).toBeUndefined();
  });

  it('rejects a duplicate session id', async () => {
    await ctx.store.createSession(session);
    await expect(ctx.store.createSession({ ...session, worktree: '/wt/other' })).rejects.toThrow();
  });

  it('enforces the 1:1 session<->worktree invariant (unique worktree)', async () => {
    await ctx.store.createSession(session);
    await expect(
      ctx.store.createSession({ sessionId: 's2', worktree: session.worktree, model: 'm' }),
    ).rejects.toThrow();
  });

  it('lists sessions in creation order, oldest first', async () => {
    // Not only a convenience for the UI. `newestWithinLimit` in the server's session-facts
    // collector caps `verity_list_sessions` by keeping the TAIL of this list, and both the
    // tool description and the approval card promise the caller "the newest ones". Reverse
    // this order and a large install silently gets its oldest sessions instead, with nothing
    // in the answer saying so.
    await ctx.store.createSession(session);
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    const ids = (await ctx.store.listSessions()).map((s) => s.sessionId);
    expect(ids).toEqual(['s1', 's2']);
  });

  it('stores one active backend resume state per session', async () => {
    await ctx.store.createSession(session);
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread_1',
      contextSeq: 12,
    });
    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toMatchObject({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread_1',
      contextSeq: 12,
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread_2',
      contextSeq: 20,
    });
    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toMatchObject({
      backendSessionId: 'thread_2',
      contextSeq: 20,
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'claude_1',
      contextSeq: 30,
    });
    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toBeUndefined();
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'claude_1',
      contextSeq: 30,
    });
    expect(await ctx.store.getSessionBackendStates('s1')).toHaveLength(1);
  });

  it('returns the binding a backend switch displaced, so its files can be reached', async () => {
    // The displaced row is the only thing that names the old backend's transcripts on
    // the runner runtime. Dropping it silently — which is what this used to do — leaks
    // those files past every future delete of the session.
    await ctx.store.createSession(session);
    expect(
      await ctx.store.upsertSessionBackendState({
        sessionId: 's1',
        backend: 'codex',
        backendSessionId: 'thread_1',
        contextSeq: 12,
      }),
    ).toEqual([]);

    // Re-binding the SAME backend replaces the id in place and displaces nothing.
    expect(
      await ctx.store.upsertSessionBackendState({
        sessionId: 's1',
        backend: 'codex',
        backendSessionId: 'thread_2',
        contextSeq: 15,
      }),
    ).toEqual([]);

    const displaced = await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'claude_1',
      contextSeq: 30,
    });

    expect(displaced).toHaveLength(1);
    expect(displaced[0]).toMatchObject({
      sessionId: 's1',
      backend: 'codex',
      // The id it was carrying when it was displaced, not the one it started with.
      backendSessionId: 'thread_2',
    });
  });

  it('lists every id a live session may be known by on disk', async () => {
    // The orphan sweep decides what to delete from this list, so a missing id is a
    // deleted conversation. It must therefore carry BOTH namespaces that name a file:
    // the backend's own id (codex rollouts, claude transcripts written after a resume)
    // and the Verity session id (claude's first transcript, before any binding exists).
    await ctx.store.createSession(session);
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread_1',
      contextSeq: 12,
    });

    expect([...(await ctx.store.listLiveBackendSessionIds())].sort()).toEqual(
      ['s1', 's2', 'thread_1'].sort(),
    );
  });

  it('drops a deleted session’s ids from the live list', async () => {
    await ctx.store.createSession(session);
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread_1',
      contextSeq: 12,
    });
    await ctx.store.deleteSession('s1');

    // Only once both are gone may the sweep touch those files — this is the transition
    // that makes an artifact collectable at all.
    expect(await ctx.store.listLiveBackendSessionIds()).toEqual([]);
  });

  it('lists the worktrees of live sessions and forgets deleted ones', async () => {
    // The sweep protects claude's `projects/<encoded-cwd>` directory of every live
    // session, because a backend switch makes the ids inside it look dead while the
    // session is not. A deleted session must stop protecting anything.
    await ctx.store.createSession(session);
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });

    expect([...(await ctx.store.listSessionWorktrees())].sort()).toEqual(
      [session.worktree, '/wt/s2'].sort(),
    );

    await ctx.store.deleteSession('s2');
    expect(await ctx.store.listSessionWorktrees()).toEqual([session.worktree]);
  });

  it('deletes every backend resume state for one session', async () => {
    await ctx.store.createSession(session);
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread_1',
      contextSeq: 12,
    });
    expect(await ctx.store.deleteSessionBackendStates('s1')).toBe(1);
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toBeUndefined();
    expect(await ctx.store.deleteSessionBackendStates('s1')).toBe(0);
  });

  it('deletes backend resume state for the active backend', async () => {
    await ctx.store.createSession(session);
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread_1',
      contextSeq: 12,
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 's1',
      contextSeq: 13,
    });

    await expect(ctx.store.deleteSessionBackendState('s1', 'codex')).resolves.toBe(false);

    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toBeUndefined();
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 's1',
    });
    await expect(ctx.store.deleteSessionBackendState('s1', 'claude')).resolves.toBe(true);
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toBeUndefined();
  });

  it('deletes backend resume state for every session in a project', async () => {
    await ctx.store.upsertProject({
      id: 'p1',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'p2',
      owner: 'heey-global',
      repo: 'other',
      containerName: 'dev-heey-global-other',
      state: 'active',
    });
    await ctx.store.createSession({ ...session, projectId: 'p1' });
    await ctx.store.createSession({
      sessionId: 's2',
      worktree: '/wt/s2',
      model: 'codex/default',
      projectId: 'p1',
    });
    await ctx.store.createSession({
      sessionId: 's3',
      worktree: '/wt/s3',
      model: 'codex/default',
      projectId: 'p2',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread_1',
      contextSeq: 12,
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's2',
      backend: 'claude',
      backendSessionId: 'thread_2',
      contextSeq: 13,
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's3',
      backend: 'codex',
      backendSessionId: 'thread_3',
      contextSeq: 14,
    });

    await expect(ctx.store.deleteProjectSessionBackendStates('p1')).resolves.toBe(2);

    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toBeUndefined();
    expect(await ctx.store.getSessionBackendState('s2', 'claude')).toBeUndefined();
    expect(await ctx.store.getSessionBackendState('s3', 'codex')).toMatchObject({
      backendSessionId: 'thread_3',
    });
  });

  describe('renameSession', () => {
    it('sets a session name and reads it back', async () => {
      await ctx.store.createSession(session);
      expect(await ctx.store.renameSession('s1', 'Fix login bug')).toBe(true);
      expect((await ctx.store.getSession('s1'))?.name).toBe('Fix login bug');
    });

    it('overwrites an existing name', async () => {
      await ctx.store.createSession({ ...session, name: 'old' });
      expect(await ctx.store.renameSession('s1', 'new')).toBe(true);
      expect((await ctx.store.getSession('s1'))?.name).toBe('new');
    });

    it('clears a name when passed null', async () => {
      await ctx.store.createSession({ ...session, name: 'named' });
      expect(await ctx.store.renameSession('s1', null)).toBe(true);
      expect((await ctx.store.getSession('s1'))?.name).toBeNull();
    });

    it('returns false for an unknown session (no row matched)', async () => {
      expect(await ctx.store.renameSession('missing', 'x')).toBe(false);
    });
  });

  describe('renameSessionIfUnnamed (auto-title guarded write)', () => {
    it('names a session that is still unnamed and reports it did', async () => {
      await ctx.store.createSession(session); // name defaults to null
      expect(await ctx.store.renameSessionIfUnnamed('s1', 'Generated title')).toBe(true);
      expect((await ctx.store.getSession('s1'))?.name).toBe('Generated title');
    });

    it('does NOT clobber a name the operator already set, and reports it did not', async () => {
      await ctx.store.createSession({ ...session, name: 'My Name' });
      expect(await ctx.store.renameSessionIfUnnamed('s1', 'Generated title')).toBe(false);
      expect((await ctx.store.getSession('s1'))?.name).toBe('My Name'); // operator intent preserved
    });
  });

  describe('setSessionModel', () => {
    it('switches the session model and reads it back', async () => {
      await ctx.store.createSession(session);
      expect(await ctx.store.setSessionModel('s1', 'codex/default')).toBe(true);
      expect((await ctx.store.getSession('s1'))?.model).toBe('codex/default');
    });

    it('overwrites the spawn model (Claude → Codex → Claude)', async () => {
      await ctx.store.createSession(session);
      await ctx.store.setSessionModel('s1', 'codex/default');
      expect(await ctx.store.setSessionModel('s1', 'claude-opus-4-8')).toBe(true);
      expect((await ctx.store.getSession('s1'))?.model).toBe('claude-opus-4-8');
    });

    it('keeps the creation model immutable for subsequent session defaults', async () => {
      await ctx.store.createSession({ ...session, model: 'codex/gpt-5.6-terra' });
      await ctx.store.setSessionModel('s1', 'codex/gpt-5.6-sol');

      expect(await ctx.store.getLastCreatedSessionModel(null)).toBe('codex/gpt-5.6-terra');
    });

    it('returns false for an unknown session (no row matched)', async () => {
      expect(await ctx.store.setSessionModel('missing', 'codex/default')).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('deletes a session along with its events and transcript lines (restrict FK notwithstanding)', async () => {
      await ctx.store.createSession(session);
      await ctx.store.appendEvent('s1', {
        t: 'session',
        id: 's1',
        model: 'm',
        worktree: '/wt/agent-s1',
      });
      await ctx.store.appendEvent('s1', { t: 'text', delta: 'hi' });
      // A transcript line shares the restrict FK — it must be cleared too.
      await ctx.db
        .insertInto('transcript_lines')
        .values({ session_id: 's1', line: '{"type":"x"}' })
        .execute();

      expect(await ctx.store.deleteSession('s1')).toBe(true);

      expect(await ctx.store.getSession('s1')).toBeUndefined();
      expect(await ctx.store.getEvents('s1')).toEqual([]);
      const lines = await ctx.db
        .selectFrom('transcript_lines')
        .select((eb) => eb.fn.countAll().as('n'))
        .where('session_id', '=', 's1')
        .executeTakeFirstOrThrow();
      expect(Number(lines.n)).toBe(0);
    });

    it('leaves other sessions and their logs untouched', async () => {
      await ctx.store.createSession(session);
      await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/agent-s2', model: 'm' });
      await ctx.store.appendEvent('s2', { t: 'text', delta: 'keep me' });

      expect(await ctx.store.deleteSession('s1')).toBe(true);

      expect(await ctx.store.getSession('s2')).toBeDefined();
      expect(await ctx.store.getEvents('s2')).toHaveLength(1);
    });

    it('returns false for an unknown session (no row matched)', async () => {
      expect(await ctx.store.deleteSession('missing')).toBe(false);
    });
  });
});

describe('EventStore — append-only event log', () => {
  beforeEach(async () => {
    await ctx.store.createSession(session);
  });

  it('appends and reads back events in order, preserving payloads', async () => {
    for (const event of sampleEvents) await ctx.store.appendEvent('s1', event);
    expect(await ctx.store.getEvents('s1')).toEqual(sampleEvents);
  });

  it('returns an empty log for a session with no events', async () => {
    expect(await ctx.store.getEvents('s1')).toEqual([]);
  });

  // A NUL in agent output used to fail the INSERT (SQLSTATE 22P05) and take the
  // whole turn down with `run_failed`, unrecoverably: the retry re-read the same
  // bytes and died again. Persisting must survive it — against real PostgreSQL
  // semantics, which is what pglite gives us here.
  it('persists an event carrying a NUL, substituting the replacement character', async () => {
    const nul = String.fromCharCode(0);
    const replacement = String.fromCharCode(0xfffd);

    const { seq } = await ctx.store.appendEvent('s1', {
      t: 'tool_result',
      id: 'toolu_nul',
      output: `key=install${nul}subject`,
      isError: false,
    });
    expect(seq).toBeGreaterThan(0);

    expect(await ctx.store.getEvents('s1')).toEqual([
      {
        t: 'tool_result',
        id: 'toolu_nul',
        output: `key=install${replacement}subject`,
        isError: false,
      },
    ]);
  });

  it('appendEvent returns a monotonic seq; getEventsAfter pages by it', async () => {
    const seqs: number[] = [];
    for (const event of sampleEvents) seqs.push((await ctx.store.appendEvent('s1', event)).seq);
    // strictly increasing
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const all = await ctx.store.getEventsAfter('s1', 0);
    expect(all.map((s) => s.event)).toEqual(sampleEvents);
    expect(all.map((s) => s.seq)).toEqual(seqs);

    // page from a cursor: only events strictly after seqs[1]
    const after = await ctx.store.getEventsAfter('s1', seqs[1] ?? 0);
    expect(after.map((s) => s.event)).toEqual(sampleEvents.slice(2));
  });

  it('surfaces each event’s created_at as ts (epoch ms, non-decreasing with seq)', async () => {
    for (const event of sampleEvents) await ctx.store.appendEvent('s1', event);

    const after = await ctx.store.getEventsAfter('s1', 0);
    // Cross-check the ts against the row's real created_at, read straight from
    // the table — proving ts IS that column (epoch ms), not the seq proxy.
    const rows = await ctx.db
      .selectFrom('events')
      .select(['id', 'created_at'])
      .where('session_id', '=', 's1')
      .orderBy('id', 'asc')
      .execute();
    expect(after.map((s) => s.ts)).toEqual(rows.map((r) => r.created_at.getTime()));
    // Every ts is a finite epoch-ms value and non-decreasing in seq order.
    for (const s of after) expect(Number.isInteger(s.ts) && s.ts > 0).toBe(true);
    const sortedBySeq = [...after].sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < sortedBySeq.length; i++) {
      expect((sortedBySeq[i]?.ts ?? 0) >= (sortedBySeq[i - 1]?.ts ?? 0)).toBe(true);
    }

    // The backward read path surfaces the same ts for the same rows.
    const page = await ctx.store.getEventsBeforeSeq('s1', sampleEvents.length);
    expect(page.events.map((s) => s.ts)).toEqual(rows.map((r) => r.created_at.getTime()));
  });

  it('getEventsBeforeSeq pages backward (newest tail first, then older)', async () => {
    const seqs: number[] = [];
    for (const event of sampleEvents) seqs.push((await ctx.store.appendEvent('s1', event)).seq);

    // Most recent page (no cursor): the last 2 events, ascending, more older exist.
    const tail = await ctx.store.getEventsBeforeSeq('s1', 2);
    expect(tail.events.map((s) => s.event)).toEqual(sampleEvents.slice(-2));
    expect(tail.events.map((s) => s.seq)).toEqual(seqs.slice(-2));
    expect(tail.hasMore).toBe(true);

    // Older page before the tail: the remaining head, and nothing older left.
    const oldestInTail = tail.events[0]?.seq ?? 0;
    const older = await ctx.store.getEventsBeforeSeq('s1', 2, oldestInTail);
    expect(older.events.map((s) => s.event)).toEqual(sampleEvents.slice(0, 2));
    expect(older.hasMore).toBe(false);
  });

  it('isolates each session’s log', async () => {
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'for-s1' });
    await ctx.store.appendEvent('s2', { t: 'text', delta: 'for-s2' });
    expect(await ctx.store.getEvents('s1')).toEqual([{ t: 'text', delta: 'for-s1' }]);
    expect(await ctx.store.getEvents('s2')).toEqual([{ t: 'text', delta: 'for-s2' }]);
  });

  it('preserves insertion order across many appends', async () => {
    for (let i = 0; i < 50; i++) await ctx.store.appendEvent('s1', { t: 'text', delta: String(i) });
    const deltas = (await ctx.store.getEvents('s1')).map((e) => (e.t === 'text' ? e.delta : null));
    expect(deltas).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
  });

  it('refuses to persist an event that violates the canonical contract', async () => {
    const invalid = { t: 'session', id: '', model: 'm', worktree: '/wt' } as unknown as AgentEvent;
    await expect(ctx.store.appendEvent('s1', invalid)).rejects.toThrow(/invalid event/);
  });

  it('persists canonical parsed events without unknown adapter fields', async () => {
    await ctx.store.appendEvent('s1', {
      t: 'text',
      delta: 'safe',
      unexpectedSecret: 'must-not-persist',
    } as AgentEvent);
    expect(await ctx.store.getEvents('s1')).toEqual([{ t: 'text', delta: 'safe' }]);
  });

  it('rejects appending to a non-existent session (foreign key)', async () => {
    await expect(ctx.store.appendEvent('ghost', { t: 'text', delta: 'x' })).rejects.toThrow();
  });

  it('refuses to delete a session while its event log exists (restrict)', async () => {
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'durable' });
    // The durable log must not be deletable out from under a session.
    await expect(
      ctx.db.deleteFrom('sessions').where('session_id', '=', 's1').execute(),
    ).rejects.toThrow();
    expect(await ctx.store.getEvents('s1')).toHaveLength(1);
  });

  it('throws on read if a payload in the log is not a valid canonical event', async () => {
    // Bypass appendEvent's validation to simulate corruption / a bad writer.
    await ctx.db
      .insertInto('events')
      .values({ session_id: 's1', type: 'bogus', payload: JSON.stringify({ t: 'nope' }) })
      .execute();
    await expect(ctx.store.getEvents('s1')).rejects.toThrow(/corrupt event payload/);
  });

  // A row written before a channel was retired is history, not corruption. Reading it must
  // keep working: this read is what the session list and the orphan-prompt recovery run, so
  // a throw here takes the whole session down with it.
  it('reads a permission event whose grantChannel has since been retired', async () => {
    await ctx.db
      .insertInto('events')
      .values({
        session_id: 's1',
        type: 'permission',
        payload: JSON.stringify({
          t: 'permission',
          id: 'p1',
          tool: 'verity_secret_run',
          input: { command: ['/usr/bin/kubectl'] },
          riskClass: 'ask',
          grantChannel: 'native',
        }),
      })
      .execute();

    const [stored] = await ctx.store.getEvents('s1');
    expect(stored?.t).toBe('permission');
    expect(stored?.t === 'permission' && stored.grantChannel).toBe(undefined);
    await expect(ctx.store.getEventsAfter('s1', 0)).resolves.toHaveLength(1);
  });

  // One schema guards both directions, so the tolerance reaches appends as well: a peer still
  // naming the retired channel across a rollout boundary is accepted rather than refused.
  // Persist the canonical parsed shape so retired/unknown fields cannot survive on disk.
  it('accepts an appended event naming a retired grantChannel and drops it before persistence', async () => {
    await ctx.store.appendEvent('s1', {
      t: 'permission',
      id: 'p2',
      tool: 'verity_secret_run',
      input: { command: ['/usr/bin/kubectl'] },
      riskClass: 'ask',
      grantChannel: 'native',
    } as unknown as AgentEvent);

    const rows = await ctx.db.selectFrom('events').select('payload').execute();
    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as { grantChannel?: string }).grantChannel).toBeUndefined();

    const [stored] = await ctx.store.getEvents('s1');
    expect(stored?.t === 'permission' && stored.grantChannel).toBe(undefined);
  });
});

describe('EventStore — durable queued turns (#80)', () => {
  beforeEach(async () => {
    await ctx.store.createSession(session);
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/agent-s2', model: 'm' });
  });

  it('enqueues, lists in FIFO order, and round-trips opts', async () => {
    await ctx.store.enqueueTurn({
      id: 'a',
      sessionId: 's1',
      prompt: 'first',
      opts: { model: 'opus', displayPrompt: 'Merged PR #119' },
    });
    await ctx.store.enqueueTurn({ id: 'b', sessionId: 's1', prompt: 'second', opts: {} });
    await ctx.store.enqueueTurn({ id: 'c', sessionId: 's2', prompt: 'other', opts: {} });

    const all = await ctx.store.listQueuedTurns();
    // Ordered by seq (insert order) across sessions — recovery replays them in order.
    expect(all.map((r) => [r.sessionId, r.prompt, r.id])).toEqual([
      ['s1', 'first', 'a'],
      ['s1', 'second', 'b'],
      ['s2', 'other', 'c'],
    ]);
    expect(all[0]?.opts).toMatchObject({ model: 'opus', displayPrompt: 'Merged PR #119' });
  });

  it('persists attachment refs on a queued turn', async () => {
    await ctx.store.enqueueTurn({
      id: 'a',
      sessionId: 's1',
      prompt: '',
      opts: { attachments: [{ kind: 'image', mediaType: 'image/png', id: 'deadbeef' }] },
    });
    const [row] = await ctx.store.listQueuedTurns();
    expect(row?.opts.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', id: 'deadbeef' },
    ]);
  });

  it('deleteQueuedTurn removes by id and reports whether it matched', async () => {
    await ctx.store.enqueueTurn({ id: 'a', sessionId: 's1', prompt: 'x', opts: {} });
    expect(await ctx.store.deleteQueuedTurn('a')).toBe(true);
    expect(await ctx.store.listQueuedTurns()).toHaveLength(0);
    // Idempotent: deleting an already-gone id is a no-op, reported as false.
    expect(await ctx.store.deleteQueuedTurn('a')).toBe(false);
  });

  it('deleteQueuedTurns removes a backlog snapshot together', async () => {
    await ctx.store.enqueueTurn({ id: 'a', sessionId: 's1', prompt: 'one', opts: {} });
    await ctx.store.enqueueTurn({ id: 'b', sessionId: 's1', prompt: 'two', opts: {} });
    await ctx.store.enqueueTurn({ id: 'c', sessionId: 's2', prompt: 'other', opts: {} });

    await ctx.store.deleteQueuedTurns(['a', 'b']);

    expect((await ctx.store.listQueuedTurns()).map((row) => row.id)).toEqual(['c']);
  });

  it('cascades: deleting a session drops its queued turns', async () => {
    await ctx.store.enqueueTurn({ id: 'a', sessionId: 's1', prompt: 'x', opts: {} });
    await ctx.store.enqueueTurn({ id: 'b', sessionId: 's2', prompt: 'y', opts: {} });
    expect(await ctx.store.deleteSession('s1')).toBe(true);
    expect((await ctx.store.listQueuedTurns()).map((r) => r.id)).toEqual(['b']);
  });

  it('drainQueuedTurn atomically drops the row and appends the prompt (SR-5)', async () => {
    await ctx.store.enqueueTurn({ id: 'a', sessionId: 's1', prompt: 'run me', opts: {} });
    const persisted = await ctx.store.drainQueuedTurn('a', 's1', { t: 'prompt', text: 'run me' });
    expect(persisted?.seq).toBeGreaterThan(0);
    // Row gone AND the prompt is now in the durable event log — both, in one txn.
    expect(await ctx.store.listQueuedTurns()).toHaveLength(0);
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).toEqual(['prompt']);
    await ctx.store.waitForMessageProjectionIdle();
    expect(await ctx.store.searchMessages({ query: 'run me' })).toMatchObject([
      { sessionId: 's1', role: 'user', kind: 'prompt', text: 'run me' },
    ]);
  });

  it('drainQueuedTurn is a run-once latch: a second drain persists nothing', async () => {
    await ctx.store.enqueueTurn({ id: 'a', sessionId: 's1', prompt: 'once', opts: {} });
    await ctx.store.drainQueuedTurn('a', 's1', { t: 'prompt', text: 'once' });
    // The row is already gone — a racing/duplicate drain must NOT re-append the prompt.
    const second = await ctx.store.drainQueuedTurn('a', 's1', { t: 'prompt', text: 'once' });
    expect(second).toBeUndefined();
    expect((await ctx.store.getEvents('s1')).filter((e) => e.t === 'prompt')).toHaveLength(1);
  });
});

describe('EventStore — in-flight turn markers (lifecycle Phase 1)', () => {
  beforeEach(async () => {
    await ctx.store.createSession(session);
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/agent-s2', model: 'm' });
  });

  it('marks a turn running and lists it with its prompt anchor', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 7 });
    const all = await ctx.store.listRunningTurns();
    expect(all).toHaveLength(1);
    expect(all[0]?.sessionId).toBe('s1');
    expect(all[0]?.promptSeq).toBe(7);
    expect(all[0]?.startedAt).toBeInstanceOf(Date);
    // ADR 0006 Stage 4: a fresh marker carries no turn identity until an attempt binds it.
    expect(all[0]?.turnId).toBeNull();
    expect(all[0]?.startCommandId).toBeNull();
  });

  it('bindTurnIdentity attaches turn_id + start_command_id to the in-flight marker (Stage 4)', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 7 });
    await ctx.store.bindTurnIdentity('s1', { turnId: 'turn-abc', startCommandId: 'start-abc' });
    const marker = (await ctx.store.listRunningTurns())[0];
    expect(marker?.promptSeq).toBe(7); // identity bind leaves the anchor intact
    expect(marker?.turnId).toBe('turn-abc');
    expect(marker?.startCommandId).toBe('start-abc');
  });

  it('re-anchoring the marker (resume-retry) drops the prior attempt bound identity (Stage 4)', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 3 });
    await ctx.store.bindTurnIdentity('s1', { turnId: 'turn-1', startCommandId: 'start-1' });
    // A resume-retry re-marks the marker before launching a FRESH agent; the stale
    // identity must reset to null so recovery can't discover the superseded turn.
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 9 });
    const marker = (await ctx.store.listRunningTurns())[0];
    expect(marker?.promptSeq).toBe(9);
    expect(marker?.turnId).toBeNull();
    expect(marker?.startCommandId).toBeNull();
  });

  it('bindTurnIdentity is a no-op when no marker is present', async () => {
    await expect(
      ctx.store.bindTurnIdentity('missing', { turnId: 't', startCommandId: 's' }),
    ).resolves.toBeUndefined();
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('upserts: one marker per session, re-marking replaces the prompt anchor AND refreshes started_at', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 3 });
    const first = (await ctx.store.listRunningTurns())[0]?.startedAt;
    // Small real delay so the wall clock advances past ms truncation — makes the
    // started_at refresh on the onConflict branch observable (a regression that drops
    // `started_at: sql`now()`` would leave the second timestamp equal to the first).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 9 });
    const all = await ctx.store.listRunningTurns();
    expect(all).toHaveLength(1);
    expect(all[0]?.promptSeq).toBe(9);
    expect(all[0]!.startedAt.getTime()).toBeGreaterThan(first!.getTime());
  });

  it('clearRunningTurn removes the marker and is idempotent', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 1 });
    await ctx.store.clearRunningTurn('s1');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
    // No marker present — a no-op, not an error.
    await expect(ctx.store.clearRunningTurn('s1')).resolves.toBeUndefined();
  });

  it('clearRunningTurn scoped by promptSeq only clears its own anchor (settle-vs-next-turn race)', async () => {
    // Turn A (seq 3) settles and issues a LATE scoped clear, but turn B (seq 9) has
    // already replaced the marker. A's clear must NOT wipe B's marker.
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 9 });
    await ctx.store.clearRunningTurn('s1', 3); // A's stale anchor — no match
    expect((await ctx.store.listRunningTurns())[0]?.promptSeq).toBe(9); // B's marker survives
    await ctx.store.clearRunningTurn('s1', 9); // B's own anchor — clears
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('appendEventForRunningTurn writes only while the marker still anchors that turn', async () => {
    const notice: AgentEvent = { t: 'notice', role: 'agent', text: 'runner is gone' };
    const { seq: promptSeq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq });
    await ctx.store.bindTurnIdentity('s1', { turnId: 't-a', startCommandId: 'c-a' });
    const anchor = { promptSeq, turnId: 't-a', silentSinceSeq: promptSeq };

    // Wrong anchor, wrong identity, wrong session: each writes nothing at all.
    expect(
      await ctx.store.appendEventForRunningTurn(
        's1',
        { ...anchor, promptSeq: promptSeq + 1 },
        notice,
      ),
    ).toBeNull();
    expect(
      await ctx.store.appendEventForRunningTurn('s1', { ...anchor, turnId: 't-other' }, notice),
    ).toBeNull();
    expect(await ctx.store.appendEventForRunningTurn('s2', anchor, notice)).toBeNull();
    expect(await ctx.store.getEvents('s1')).toHaveLength(1); // the prompt, nothing else
    expect(await ctx.store.getEvents('s2')).toHaveLength(0);

    const written = await ctx.store.appendEventForRunningTurn('s1', anchor, notice);
    expect(written).toEqual({ seq: expect.any(Number), ts: expect.any(Number) });
    expect(await ctx.store.getEvents('s1')).toEqual([{ t: 'prompt', text: 'go' }, notice]);

    // The turn settles: its marker is gone, and so is the right to write in its name.
    await ctx.store.clearRunningTurn('s1', promptSeq);
    expect(
      await ctx.store.appendEventForRunningTurn(
        's1',
        { ...anchor, silentSinceSeq: written?.seq ?? 0 },
        notice,
      ),
    ).toBeNull();
    expect(await ctx.store.getEvents('s1')).toHaveLength(2);
  });

  it('appendEventForRunningTurn drops a verdict the turn has already spoken past', async () => {
    // The marker outlives the turn's terminal event by design (terminal first, clear
    // after), so an observer whose verdict predates that event would otherwise land a
    // "your Runner is gone" notice directly behind a successful result.
    const { seq: promptSeq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq });
    await ctx.store.bindTurnIdentity('s1', { turnId: 't-a', startCommandId: 'c-a' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      permissionDenials: [],
    });
    expect(
      await ctx.store.appendEventForRunningTurn(
        's1',
        { promptSeq, turnId: 't-a', silentSinceSeq: promptSeq },
        { t: 'notice', role: 'agent', text: 'runner is gone' },
      ),
    ).toBeNull();
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).toEqual(['prompt', 'result']);
  });

  it('appendEventForRunningTurn never lands behind an append that raced it', async () => {
    // The predicate only sees what had COMMITTED when the statement began, so against a
    // real PostgreSQL an overlapping append could be invisible to it and still take the
    // lower id — putting the notice after words the turn had already said. Appends for
    // one session are serialized for that reason: an in-process tail, plus the advisory
    // lock every append takes so overlapping Server generations are ordered too. PGlite
    // is single-connection and models neither the overlap nor the lock contention, so
    // what this pins is the invariant itself: whatever order the two land in, the
    // conditional write is either dropped or ahead of the event that raced it.
    const { seq: promptSeq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq });
    await ctx.store.bindTurnIdentity('s1', { turnId: 't-a', startCommandId: 'c-a' });

    const racing = ctx.store.appendEvent('s1', { t: 'notice', role: 'agent', text: 'still here' });
    const verdict = await ctx.store.appendEventForRunningTurn(
      's1',
      { promptSeq, turnId: 't-a', silentSinceSeq: promptSeq },
      { t: 'notice', role: 'agent', text: 'runner is gone' },
    );
    const spoke = await racing;
    if (verdict !== null) expect(verdict.seq).toBeLessThan(spoke.seq);
  });

  it('appendEventForRunningTurn matches an unbound marker by its null identity', async () => {
    // A resume-retry re-anchors the SAME prompt_seq and drops the bound identity, so
    // an observer holding the previous attempt's turn id must not write through it.
    const { seq: promptSeq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq });
    await ctx.store.bindTurnIdentity('s1', { turnId: 't-a', startCommandId: 'c-a' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq }); // retry: turn_id → null
    const notice: AgentEvent = { t: 'notice', role: 'agent', text: 'runner is gone' };
    expect(
      await ctx.store.appendEventForRunningTurn(
        's1',
        { promptSeq, turnId: 't-a', silentSinceSeq: promptSeq },
        notice,
      ),
    ).toBeNull();
    expect(
      await ctx.store.appendEventForRunningTurn(
        's1',
        { promptSeq, turnId: null, silentSinceSeq: promptSeq },
        notice,
      ),
    ).not.toBeNull();
  });

  it('scopes markers per session', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 2 });
    await ctx.store.markTurnRunning({ sessionId: 's2', promptSeq: 5 });
    const byId = Object.fromEntries(
      (await ctx.store.listRunningTurns()).map((r) => [r.sessionId, r.promptSeq]),
    );
    expect(byId).toEqual({ s1: 2, s2: 5 });
  });

  it('cascades: deleting a session drops its in-flight marker', async () => {
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: 1 });
    await ctx.store.markTurnRunning({ sessionId: 's2', promptSeq: 1 });
    expect(await ctx.store.deleteSession('s1')).toBe(true);
    expect((await ctx.store.listRunningTurns()).map((r) => r.sessionId)).toEqual(['s2']);
  });
});

describe('EventStore — pending notes (post-merge agent context)', () => {
  beforeEach(async () => {
    await ctx.store.createSession(session);
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/agent-s2', model: 'm' });
  });

  it('consumes appended notes oldest-first and empties the queue (consume-once)', async () => {
    await ctx.store.appendPendingNote('s1', 'first');
    await ctx.store.appendPendingNote('s1', 'second');
    expect(await ctx.store.consumePendingNotes('s1')).toEqual(['first', 'second']);
    // Consumed: a second read finds nothing.
    expect(await ctx.store.consumePendingNotes('s1')).toEqual([]);
  });

  it('returns an empty array when there are no notes', async () => {
    expect(await ctx.store.consumePendingNotes('s1')).toEqual([]);
  });

  it('scopes notes per session', async () => {
    await ctx.store.appendPendingNote('s1', 'for-s1');
    await ctx.store.appendPendingNote('s2', 'for-s2');
    expect(await ctx.store.consumePendingNotes('s1')).toEqual(['for-s1']);
    // s2's note is untouched by consuming s1's.
    expect(await ctx.store.consumePendingNotes('s2')).toEqual(['for-s2']);
  });

  it('cascades: deleting a session drops its pending notes', async () => {
    await ctx.store.appendPendingNote('s1', 'gone');
    await ctx.store.appendPendingNote('s2', 'kept');
    expect(await ctx.store.deleteSession('s1')).toBe(true);
    expect(await ctx.store.consumePendingNotes('s2')).toEqual(['kept']);
  });
});

describe('EventStore — session automation markers', () => {
  beforeEach(async () => {
    await ctx.store.createSession(session);
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/agent-s2', model: 'm' });
  });

  it('marks a session automation only once per marker', async () => {
    await expect(ctx.store.hasSessionAutomationMarker('s1', 'ci:119:abc123')).resolves.toBe(false);
    await expect(ctx.store.markSessionAutomation('s1', 'ci:119:abc123')).resolves.toBe(true);
    await expect(ctx.store.hasSessionAutomationMarker('s1', 'ci:119:abc123')).resolves.toBe(true);
    await expect(ctx.store.markSessionAutomation('s1', 'ci:119:abc123')).resolves.toBe(false);
    await expect(ctx.store.deleteSessionAutomationMarker('s1', 'ci:119:abc123')).resolves.toBe(
      true,
    );
    await expect(ctx.store.hasSessionAutomationMarker('s1', 'ci:119:abc123')).resolves.toBe(false);
    await expect(ctx.store.markSessionAutomation('s1', 'ci:119:abc123')).resolves.toBe(true);
    await expect(ctx.store.markSessionAutomation('s1', 'ci:119:def456')).resolves.toBe(true);
    await expect(ctx.store.markSessionAutomation('s2', 'ci:119:abc123')).resolves.toBe(true);
  });

  it('cascades: deleting a session drops its automation markers', async () => {
    expect(await ctx.store.markSessionAutomation('s1', 'ci:119:abc123')).toBe(true);
    expect(await ctx.store.deleteSession('s1')).toBe(true);
    await ctx.store.createSession(session);
    expect(await ctx.store.markSessionAutomation('s1', 'ci:119:abc123')).toBe(true);
  });
});

describe('EventStore — project memory (ADR 0008)', () => {
  beforeEach(async () => {
    await ctx.store.upsertProject({
      id: 'p1',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
  });

  it('appends notes, creating the settings row and concatenating with a newline', async () => {
    const first = await ctx.store.appendProjectMemory('p1', 'prefers vitest over jest');
    expect(first?.memory).toBe('prefers vitest over jest');
    const second = await ctx.store.appendProjectMemory('p1', 'deploy is GitOps-only');
    expect(second?.memory).toBe('prefers vitest over jest\ndeploy is GitOps-only');
  });

  it('trims the note and no-ops on empty/whitespace input', async () => {
    await ctx.store.appendProjectMemory('p1', '  spaced  ');
    const settings = await ctx.store.appendProjectMemory('p1', '   \n  ');
    expect(settings?.memory).toBe('spaced');
  });

  it('returns undefined for an unknown project', async () => {
    await expect(ctx.store.appendProjectMemory('nope', 'x')).resolves.toBeUndefined();
  });

  it('accepts an append landing exactly on the size cap', async () => {
    const settings = await ctx.store.appendProjectMemory(
      'p1',
      'x'.repeat(PROJECT_MEMORY_MAX_CHARS),
    );
    expect(settings?.memory?.length).toBe(PROJECT_MEMORY_MAX_CHARS);
  });

  it('creates the settings row and returns it for a no-op append on a settings-less project', async () => {
    // The project exists but has no settings row yet — an empty note must not be
    // mistaken for a missing project (it maps to a clean 200, not a 404).
    const settings = await ctx.store.appendProjectMemory('p1', '   ');
    expect(settings).toBeDefined();
    expect(settings?.memory ?? null).toBeNull();
  });

  it('rejects an append that would exceed the size cap, leaving memory unchanged', async () => {
    await ctx.store.appendProjectMemory('p1', 'keep me');
    const huge = 'x'.repeat(PROJECT_MEMORY_MAX_CHARS + 1);
    await expect(ctx.store.appendProjectMemory('p1', huge)).rejects.toBeInstanceOf(
      ProjectMemoryTooLargeError,
    );
    const settings = await ctx.store.getProjectSettingsRaw('p1');
    expect(settings?.memory).toBe('keep me');
  });

  it('round-trips memory through updateProjectSettings and clears it with null', async () => {
    await ctx.store.updateProjectSettings('p1', { memory: 'operator note' });
    expect((await ctx.store.getProjectSettingsRaw('p1'))?.memory).toBe('operator note');
    await ctx.store.updateProjectSettings('p1', { memory: null });
    expect((await ctx.store.getProjectSettingsRaw('p1'))?.memory).toBeNull();
  });

  it('rejects an over-cap operator write', async () => {
    await expect(
      ctx.store.updateProjectSettings('p1', { memory: 'x'.repeat(PROJECT_MEMORY_MAX_CHARS + 1) }),
    ).rejects.toBeInstanceOf(ProjectMemoryTooLargeError);
  });

  it('does not touch memory when the patch omits it', async () => {
    await ctx.store.appendProjectMemory('p1', 'sticky');
    await ctx.store.updateProjectSettings('p1', { defaultBranch: 'main' });
    const settings = await ctx.store.getProjectSettingsRaw('p1');
    expect(settings?.memory).toBe('sticky');
    expect(settings?.defaultBranch).toBe('main');
  });
});

describe('EventStore — session projection facts', () => {
  const other = { sessionId: 's2', worktree: '/wt/agent-s2', model: 'claude-opus-5' };
  // Both status-bearing and neutral kinds, so the filter has something to drop.
  const projected: AgentEvent[] = [
    { t: 'prompt', text: 'go' },
    { t: 'task', id: 'bg1', phase: 'started' },
    { t: 'rate_limit', status: 'allowed', resetsAt: 1, window: 'five_hour', usedPercent: 12 },
    {
      t: 'result',
      usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    },
  ];

  beforeEach(async () => {
    await ctx.store.createSession(session);
    await ctx.store.createSession(other);
  });

  it('writes a `type` column that always equals the payload discriminant', async () => {
    // The filter is a SQL predicate on the DENORMALIZED column, while every
    // projection downstream reads `payload.t`. The two agreeing is what makes the
    // narrowed read equivalent to the full log; a writer that ever set one
    // without the other would drop those events from the overview silently, and
    // only for the sessions that happened to contain them.
    for (const event of [...sampleEvents, ...projected]) await ctx.store.appendEvent('s1', event);

    const mismatched = await ctx.db
      .selectFrom('events')
      .select(['id', 'type'])
      .where('session_id', '=', 's1')
      .where((eb) => eb('type', '!=', sql<string>`payload->>'t'`))
      .execute();
    expect(mismatched).toEqual([]);
    // …and no row can be missing one: the column is NOT NULL from the migration
    // that created the table, so there are no pre-denormalization rows to miss.
    const rows = await ctx.db
      .selectFrom('events')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('session_id', '=', 's1')
      .executeTakeFirstOrThrow();
    expect(Number(rows.n)).toBe(sampleEvents.length + projected.length);
  });

  it('has no writer into `events` that sources `type` anywhere but the parsed payload', async () => {
    // The test above proves the invariant for rows THIS suite wrote through
    // `appendEvent`. It cannot see the writer added next week. So read the
    // writers out of the source instead of listing them: every insert into
    // `events` anywhere in the repo has to take its `type` from the discriminant
    // of the payload it is storing in the same statement, because the overview's
    // SQL filter believes the column and every projection downstream believes
    // `payload.t`. A writer that disagreed would not fail — those events would
    // just stop existing as far as the badge, the token total and the limit
    // banner are concerned.
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    const sources = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts'],
      { encoding: 'utf8', cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
    )
      .split('\n')
      .filter((path) => path.length > 0 && !path.endsWith('.test.ts'));

    // The two spellings the repo uses: Kysely's builder and a raw statement.
    const insertPattern = /insertInto\(\s*'events'\s*\)|insert\s+into\s+events\b/g;
    // `event.t` and `eventRow.type` are read off a `parseAgentEvent` result;
    // `${type}` is the destructured half of `prepareEventRow`, which is the only
    // producer of both (asserted below). Anything else has to justify itself here.
    const fromPayload = /type:\s*(?:eventRow\.type|event\.t)\b|,\s*\$\{type\},/;
    let writers = 0;
    for (const path of sources) {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      for (const match of source.matchAll(insertPattern)) {
        writers += 1;
        const statement = source.slice(match.index, match.index + 400);
        expect(statement, `${path} writes \`events.type\` from something else`).toMatch(
          fromPayload,
        );
      }
    }
    // The scan finding nothing would pass vacuously, which is the one way a
    // pattern-based guard rots without saying so.
    expect(writers).toBeGreaterThanOrEqual(3);

    // …and the expressions above are only trustworthy because one function mints
    // them, right after `parseAgentEvent` succeeds.
    const storeSource = readFileSync(join(repoRoot, 'packages/store/src/store.ts'), 'utf8');
    for (const binding of storeSource.matchAll(/const (?:eventRow|\{ type, payload \}) =\s*/g)) {
      expect(storeSource.slice(binding.index, binding.index + 200)).toContain('prepareEventRow');
    }
  });

  it('answers one query for many sessions, matching each full log’s projection', async () => {
    for (const event of [...sampleEvents, ...projected]) await ctx.store.appendEvent('s1', event);
    for (const event of sampleEvents) await ctx.store.appendEvent('s2', event);

    const facts = await ctx.store.listSessionProjectionFacts(['s1', 's2']);

    for (const sessionId of ['s1', 's2']) {
      const full = await ctx.store.getEventsAfter(sessionId, 0);
      const entry = facts.get(sessionId);
      // Expectations come from the same filter the server applies in memory, so a
      // divergence between the SQL `type in (…)` and the projection set fails here
      // rather than quietly serving a short log to the overview.
      const expected = full.filter((row) => sessionProjectionEvents([row.event]).length === 1);
      expect(entry?.events).toEqual(expected);
      expect(entry?.eventCount).toBe(full.length);
      expect(entry?.lastActivityAt).toBe(full.at(-1)?.ts);
    }
    // s2 holds none of the projected kinds — the count still separates it from an
    // empty log, which is the whole reason it travels alongside the events.
    expect(facts.get('s2')?.events).toEqual([]);
    expect(facts.get('s2')?.eventCount).toBe(sampleEvents.length);
  });

  it('returns a zeroed entry for a session with no events and for an unknown id', async () => {
    const facts = await ctx.store.listSessionProjectionFacts(['s1', 'nope']);
    for (const sessionId of ['s1', 'nope']) {
      expect(facts.get(sessionId)).toEqual({
        eventCount: 0,
        lastActivityAt: null,
        events: [],
      });
    }
    expect(await ctx.store.listSessionProjectionFacts([])).toEqual(new Map());
  });

  it('answers for more sessions than one statement can bind', async () => {
    // `GET /sessions` passes EVERY session of a deployment in one call, and each
    // id is a bind parameter. Postgres refuses a statement carrying more than
    // 65535 of them outright, so an unchunked `in (…)` turns a large install into
    // a route that throws — a failure mode the per-session reads this replaced
    // did not have, and one that only appears once the install is big enough.
    const ids = Array.from({ length: 70_000 }, (_, at) => `absent-${String(at)}`);
    const facts = await ctx.store.listSessionProjectionFacts(ids);
    expect(facts.size).toBe(ids.length);
    expect(facts.get('absent-69999')).toEqual({
      eventCount: 0,
      lastActivityAt: null,
      events: [],
    });
  });

  it('takes lastActivityAt from the newest seq, not the newest timestamp', async () => {
    // `created_at` defaults to the TRANSACTION start, so two overlapping appends
    // can land timestamps ordered opposite to their ids. The overview's
    // "last activity" has always been the newest event's timestamp — reading a
    // `max(created_at)` instead would silently change that to a different row's.
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-01-01T00:05:00.000Z');
    await ctx.db
      .insertInto('events')
      .values([
        {
          session_id: 's1',
          type: 'prompt',
          payload: JSON.stringify({ t: 'prompt', text: 'a' }),
          created_at: newer.toISOString(),
        },
        {
          session_id: 's1',
          type: 'prompt',
          payload: JSON.stringify({ t: 'prompt', text: 'b' }),
          created_at: older.toISOString(),
        },
      ])
      .execute();

    // Read the ids back rather than assuming the multi-row VALUES assigned them
    // in listed order, and assert the premise: the newest row by seq and the
    // newest by timestamp must actually differ, or this guard is a tautology
    // that would keep passing against a `max(created_at)` implementation.
    const rows = await ctx.db
      .selectFrom('events')
      .select(['id', 'created_at'])
      .where('session_id', '=', 's1')
      .orderBy('id', 'asc')
      .execute();
    const newestBySeq = rows.at(-1);
    const newestByTimestamp = [...rows].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime(),
    );
    expect(newestBySeq?.created_at.getTime()).not.toBe(
      newestByTimestamp.at(-1)?.created_at.getTime(),
    );

    const facts = await ctx.store.listSessionProjectionFacts(['s1']);
    expect(facts.get('s1')?.lastActivityAt).toBe(newestBySeq?.created_at.getTime());
    expect(facts.get('s1')?.lastActivityAt).toBe(older.getTime());
    expect(facts.get('s1')?.eventCount).toBe(2);
  });

  it('reads the same slice with and without the counters', async () => {
    // Two entry points, one filter. Derive the expectation from the counting read
    // rather than restating the slice: a filter that drifted in only one of them
    // would leave the activity poll deciding "still busy" from a different set of
    // events than the badge next to it.
    for (const event of [...sampleEvents, ...projected]) await ctx.store.appendEvent('s1', event);
    await ctx.store.appendEvent('s2', { t: 'text', delta: 'nothing projected' });

    const ids = ['s1', 's2', 'nope'];
    const facts = await ctx.store.listSessionProjectionFacts(ids);
    const slices = await ctx.store.listSessionProjectionEvents(ids);
    expect([...slices.keys()]).toEqual(ids);
    for (const id of ids) expect(slices.get(id)).toEqual(facts.get(id)?.events);
    expect(slices.get('s1')?.length).toBeGreaterThan(0);
    expect(await ctx.store.listSessionProjectionEvents([])).toEqual(new Map());
  });

  it('fails the whole list rather than projecting from a log it could not read', async () => {
    // Batching widened the blast radius on purpose: one bad row now fails every
    // requested session instead of one. Events are validated on the way IN, so a
    // payload that fails on the way OUT means the database no longer holds what
    // the server wrote — and a badge quietly derived from the rows that did
    // survive is exactly how that stays invisible.
    await ctx.store.appendEvent('s2', { t: 'prompt', text: 'intact' });
    await ctx.db
      .insertInto('events')
      .values({
        session_id: 's1',
        // In the projection slice, so the read reaches it — and missing the
        // required `text`, so the schema rejects it.
        type: 'prompt',
        payload: JSON.stringify({ t: 'prompt' }),
      })
      .execute();
    await expect(ctx.store.listSessionProjectionFacts(['s1', 's2'])).rejects.toThrow(
      /corrupt event payload in session s1/,
    );
  });
});
