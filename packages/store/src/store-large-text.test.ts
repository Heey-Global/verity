import { createHash } from 'node:crypto';
import { type AgentEvent } from '@verity/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backfillToolResultText, EventStore } from './store.js';
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

const ADMIN = '00000000-0000-4000-8000-000000000001';

const session = { sessionId: 's1', worktree: '/wt/agent-s1', model: 'claude-opus-4-8' };

const sampleEvents: AgentEvent[] = [
  { t: 'session', id: 's1', model: 'claude-opus-4-8', worktree: '/wt/agent-s1' },
  { t: 'text', delta: 'hello' },
  { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
  { t: 'raw', backend: 'claude-code', payload: { nested: { a: 1 }, list: [1, 2] } },
];

/** Comfortably longer than any log the fact tests write, so the tail IS the whole
 *  slice and they keep asking what they were written to ask. The tail bound
 *  itself is exercised against a log built to exceed it. */
const WHOLE_LOG = 1_000;

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
