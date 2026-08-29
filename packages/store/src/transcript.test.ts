import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptStore } from './transcript.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;
let transcript: TranscriptStore;

beforeAll(async () => {
  ctx = await createTestDb();
  transcript = new TranscriptStore(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
});

// Real-shaped raw stream-json/.jsonl lines, including an internal type the
// canonical adapter drops but the verbatim transcript must keep.
const rawLines = [
  '{"type":"system","subtype":"init","session_id":"s1"}',
  '{"type":"queue-operation","op":"enqueue"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
  '{"type":"result","subtype":"success"}',
];

describe('TranscriptStore', () => {
  it('round-trips lines in append order', async () => {
    for (const line of rawLines) await transcript.appendLine('s1', line);
    expect(await transcript.getLines('s1')).toEqual(rawLines);
  });

  it('appends many lines in one call, preserving order', async () => {
    await transcript.appendLines('s1', rawLines);
    expect(await transcript.getLines('s1')).toEqual(rawLines);
  });

  it('treats appendLines([]) as a no-op', async () => {
    await transcript.appendLines('s1', []);
    expect(await transcript.getLines('s1')).toEqual([]);
  });

  it('chunks a large batch (beyond one INSERT) and preserves order', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => `line-${String(i)}`);
    await transcript.appendLines('s1', many);
    const stored = await transcript.getLines('s1');
    expect(stored).toHaveLength(2500);
    expect(stored).toEqual(many);
  });

  it('replaceLines swaps the whole transcript atomically (compaction path)', async () => {
    await transcript.appendLines('s1', ['old1', 'old2', 'old3']);
    await transcript.replaceLines('s1', ['compacted']);
    expect(await transcript.getLines('s1')).toEqual(['compacted']);
  });

  it('replaceLines with [] clears the transcript', async () => {
    await transcript.appendLines('s1', ['x']);
    await transcript.replaceLines('s1', []);
    expect(await transcript.getLines('s1')).toEqual([]);
  });

  it('materializes a line-faithful newline-delimited .jsonl', async () => {
    await transcript.appendLines('s1', rawLines);
    const materialized = await transcript.materialize('s1');
    expect(materialized).toBe(rawLines.map((l) => `${l}\n`).join(''));
    // round-trips: splitting the materialized file back yields the same lines
    expect(materialized.split('\n').slice(0, -1)).toEqual(rawLines);
  });

  it('materializes an empty string for a session with no transcript', async () => {
    expect(await transcript.materialize('s1')).toBe('');
    expect(await transcript.getLines('s1')).toEqual([]);
  });

  it('isolates each session’s transcript', async () => {
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    await transcript.appendLine('s1', 'for-s1');
    await transcript.appendLine('s2', 'for-s2');
    expect(await transcript.getLines('s1')).toEqual(['for-s1']);
    expect(await transcript.getLines('s2')).toEqual(['for-s2']);
  });

  it('rejects appending to a non-existent session (foreign key)', async () => {
    await expect(transcript.appendLine('ghost', 'x')).rejects.toThrow();
  });

  it('refuses to delete a session while its transcript exists (restrict)', async () => {
    await transcript.appendLine('s1', 'durable');
    await expect(
      ctx.db.deleteFrom('sessions').where('session_id', '=', 's1').execute(),
    ).rejects.toThrow();
    expect(await transcript.getLines('s1')).toEqual(['durable']);
  });
});
