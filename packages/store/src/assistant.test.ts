import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  for (const id of ['a', 'b'])
    await ctx.store.upsertProject({
      id,
      owner: 'team',
      repo: id,
      containerName: id,
      state: 'active',
    });
});

describe('assistant settings', () => {
  it('starts disabled and bumps the revision on every change', async () => {
    expect(await ctx.store.assistant.settings()).toMatchObject({ enabled: false, revision: 0 });
    await ctx.store.assistant.configure(true, 'admin');
    await ctx.store.assistant.configure(false, 'admin');
    expect(await ctx.store.assistant.settings()).toMatchObject({
      enabled: false,
      revision: 2,
      sponsor_user_id: 'admin',
    });
  });

  it('keeps the first session id when concurrent callers race to create it', async () => {
    await expect(ctx.store.assistant.session('s0')).rejects.toThrow(/not configured/);
    await ctx.store.assistant.configure(true, 'admin');
    const ids = await Promise.all([
      ctx.store.assistant.session('s1'),
      ctx.store.assistant.session('s2'),
    ]);
    expect(new Set(ids).size).toBe(1);
    // Disabling must not forget the session, or re-enabling would orphan its history.
    await ctx.store.assistant.configure(false, 'admin');
    expect((await ctx.store.assistant.settings()).session_id).toBe(ids[0]);
  });

  it('replaces a stale session id only once', async () => {
    await ctx.store.assistant.configure(true, 'admin');
    await ctx.store.assistant.session('old');
    const ids = await Promise.all([
      ctx.store.assistant.replaceSession('old', 'n1'),
      ctx.store.assistant.replaceSession('old', 'n2'),
    ]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe('old');
  });
});

describe('assistant project grants', () => {
  it('stores one grant per project and drops it with the project', async () => {
    expect(await ctx.store.assistant.grant('a')).toBeUndefined();
    await ctx.store.assistant.setGrant('a', 'user', 'tasks');
    await ctx.store.assistant.setGrant('a', 'other', 'delegate');
    expect(await ctx.store.assistant.grant('a')).toMatchObject({
      mode: 'delegate',
      sponsor_user_id: 'other',
      revision: 2,
    });
    await ctx.store.assistant.setGrant('b', 'user', 'off');
    expect((await ctx.store.assistant.grants()).map((grant) => grant.project_id)).toEqual([
      'a',
      'b',
    ]);
    await ctx.store.deleteProject('a');
    expect(await ctx.store.assistant.grant('a')).toBeUndefined();
  });
});

describe('assistant handoff results', () => {
  it('records each publication once and forgets it when the handoff is repeated', async () => {
    for (const sessionId of ['assistant', 't1'])
      await ctx.store.createSession({ sessionId, worktree: `/${sessionId}`, model: 'm' });
    const handOff = (title: string, at: number) =>
      ctx.store.assistant.recordHandoff({
        targetSessionId: 't1',
        assistantSessionId: 'assistant',
        projectId: 'a',
        userId: 'u1',
        title,
        handedOffAt: new Date(at),
      });
    const claim = (seq: number, summary = 'Done.', handedOffAt = 1_000) =>
      ctx.store.assistant.claimResult({
        assistantSessionId: 'assistant',
        targetSessionId: 't1',
        handedOffAt: new Date(handedOffAt),
        seq,
        delivered: true,
        summary,
        at: new Date(2_000),
      });
    await handOff('Backup check', 1_000);
    expect(await ctx.store.assistant.handoff('t1')).toMatchObject({ title: 'Backup check' });
    // Concurrent announcers of one publication: exactly one wins.
    expect((await Promise.all([claim(5), claim(5)])).filter(Boolean)).toHaveLength(1);
    expect(await claim(4)).toBe(false);
    expect(await claim(7, 'x'.repeat(400))).toBe(true);
    const [recorded] = await ctx.store.assistant.recordedResults('assistant', ['t1', 'nope']);
    expect(recorded).toMatchObject({ target_session_id: 't1', delivered: true, blocker: null });
    expect(recorded!.summary).toHaveLength(300);
    expect(await ctx.store.assistant.recordedResults('other', ['t1'])).toEqual([]);
    // A new briefing to the same session starts without the old answer, and a result matched
    // against the earlier briefing cannot land on it.
    await handOff('Second question', 3_000);
    expect(await ctx.store.assistant.recordedResults('assistant', ['t1'])).toEqual([]);
    expect(await claim(9)).toBe(false);
    expect(await claim(9, 'Second answer.', 3_000)).toBe(true);
  });
});

describe('assistant requests', () => {
  const base = { sessionId: 'assistant', userId: 'u1' } as const;
  beforeEach(async () => {
    await ctx.store.createSession({ sessionId: 'assistant', worktree: '/a', model: 'm' });
  });

  it('returns the first delivery when a device replays the same request id', async () => {
    const message = { ...base, requestId: 'r1', kind: 'message' as const };
    expect(await ctx.store.assistant.claimRequest(message)).toEqual({ claimed: true });
    await ctx.store.assistant.acceptRequest('r1');
    // A replay after acceptance must never start a second turn.
    expect(await ctx.store.assistant.claimRequest(message)).toMatchObject({
      claimed: false,
      request: { request_id: 'r1', state: 'accepted', kind: 'message' },
    });
  });

  it('lets only one request answer a question', async () => {
    const answer = { ...base, kind: 'answer' as const, questionId: 'q-7' };
    expect(await ctx.store.assistant.claimRequest({ ...answer, requestId: 'phone' })).toEqual({
      claimed: true,
    });
    expect(
      await ctx.store.assistant.claimRequest({ ...answer, requestId: 'watch', userId: 'u2' }),
    ).toMatchObject({ claimed: false, answeredBy: { request_id: 'phone' } });
    // A different question stays answerable.
    expect(
      await ctx.store.assistant.claimRequest({ ...answer, requestId: 'next', questionId: 'q-9' }),
    ).toEqual({ claimed: true });
  });

  it('frees a refused claim and reclaims one a crashed dispatch left pending', async () => {
    const message = { ...base, requestId: 'r2', kind: 'message' as const };
    await ctx.store.assistant.claimRequest(message);
    await ctx.store.assistant.releaseRequest('r2');
    expect(await ctx.store.assistant.claimRequest(message)).toEqual({ claimed: true });
    // Still fresh: a concurrent replay waits for the first dispatch.
    expect(await ctx.store.assistant.claimRequest(message)).toMatchObject({ claimed: false });
    expect(await ctx.store.assistant.claimRequest({ ...message, staleAfterMs: 0 })).toEqual({
      claimed: true,
    });
    // Another user cannot take over someone else's pending request.
    expect(
      await ctx.store.assistant.claimRequest({ ...message, userId: 'u2', staleAfterMs: 0 }),
    ).toMatchObject({ claimed: false });
  });
});

describe('assistant handoffs', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 21, 12, minutes));
  beforeEach(async () => {
    for (const sessionId of ['t1', 't2', 't3'])
      await ctx.store.createSession({ sessionId, worktree: `/${sessionId}`, model: 'm' });
  });

  it('lists only the turn user’s handoffs, newest first, and replaces a repeated target', async () => {
    const base = { assistantSessionId: 'assistant', projectId: 'a', title: 'Backup' };
    await ctx.store.assistant.recordHandoff({
      ...base,
      targetSessionId: 't1',
      userId: 'u1',
      handedOffAt: at(1),
    });
    await ctx.store.assistant.recordHandoff({
      ...base,
      targetSessionId: 't2',
      userId: 'u2',
      handedOffAt: at(2),
    });
    await ctx.store.assistant.recordHandoff({
      ...base,
      targetSessionId: 't3',
      userId: 'u1',
      handedOffAt: at(3),
    });
    // A second briefing to the same session starts its result window anew.
    await ctx.store.assistant.recordHandoff({
      ...base,
      targetSessionId: 't1',
      userId: 'u1',
      title: 'Again',
      handedOffAt: at(4),
    });
    const listed = await ctx.store.assistant.handoffs({ userId: 'u1', since: at(0), limit: 10 });
    expect(listed.map((row) => [row.target_session_id, row.title])).toEqual([
      ['t1', 'Again'],
      ['t3', 'Backup'],
    ]);
    expect(
      (await ctx.store.assistant.handoffs({ userId: 'u1', since: at(3), limit: 1 })).map(
        (row) => row.target_session_id,
      ),
    ).toEqual(['t1']);
    // Auth off records no user; those rows are not another user's.
    expect(
      await ctx.store.assistant.handoffs({ userId: undefined, since: at(0), limit: 10 }),
    ).toEqual([]);
  });
});
