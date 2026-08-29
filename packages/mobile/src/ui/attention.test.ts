import { describe, expect, it } from 'vitest';
import type { SessionPr, SessionStatus, SessionSummary } from '../api.js';
import {
  attentionCount,
  attentionQueue,
  markerAttention,
  sessionAttention,
  type AttentionInput,
  type AttentionKind,
} from './attention.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function session(id: string, status: SessionStatus, pr?: SessionPr | null): SessionSummary {
  return {
    sessionId: id,
    worktree: `/wt/${id}`,
    model: 'm',
    name: null,
    status,
    usage: ZERO_USAGE,
    ...(pr !== undefined ? { pr } : {}),
  };
}

const openPr = (over: Partial<SessionPr> = {}): SessionPr => ({
  phase: 'open',
  pipeline: 'running',
  mergeable: false,
  ...over,
});

describe('attentionQueue', () => {
  it('surfaces attention sessions first, preserving order within each group', () => {
    const sessions = [
      session('a', 'running'),
      session('b', 'awaiting_input'),
      session('c', 'completed'),
      session('d', 'crashed'),
      session('e', 'idle'),
    ];
    expect(attentionQueue(sessions).map((s) => s.sessionId)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('leaves the order unchanged when nothing needs attention', () => {
    const sessions = [session('a', 'running'), session('b', 'completed'), session('c', 'idle')];
    expect(attentionQueue(sessions).map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for no sessions', () => {
    expect(attentionQueue([])).toEqual([]);
  });

  it('surfaces a CI-failed PR but leaves merge-ready/unread in place', () => {
    const sessions = [
      session('a', 'idle', openPr({ mergeable: true, pipeline: 'success' })), // merge-ready: stays
      session('b', 'idle', openPr({ pipeline: 'failure' })), // ci_failed: blocking, floats up
      session('c', 'running'),
    ];
    expect(attentionQueue(sessions).map((s) => s.sessionId)).toEqual(['b', 'a', 'c']);
  });

  it('surfaces a merge-blocked PR ahead of non-blocking rows', () => {
    const sessions = [
      session('a', 'idle', openPr({ mergeable: true, pipeline: 'success' })),
      session('b', 'idle', openPr({ mergeable: false, pipeline: 'success' })),
      session('c', 'running'),
    ];
    expect(attentionQueue(sessions).map((s) => s.sessionId)).toEqual(['b', 'a', 'c']);
  });
});

describe('attentionCount', () => {
  it('counts only awaiting_input and crashed sessions', () => {
    const sessions = [
      session('a', 'awaiting_input'),
      session('b', 'crashed'),
      session('c', 'running'),
      session('d', 'completed'),
      session('e', 'awaiting_dependency'),
    ];
    expect(attentionCount(sessions)).toBe(2);
  });

  it('is 0 when nothing needs attention', () => {
    expect(attentionCount([session('a', 'running'), session('b', 'idle')])).toBe(0);
  });

  it('counts a CI-failed PR as blocking even on an idle session', () => {
    const sessions = [
      session('a', 'idle', openPr({ pipeline: 'failure' })),
      session('b', 'idle', openPr({ mergeable: true, pipeline: 'success' })),
      session('c', 'idle'),
    ];
    expect(attentionCount(sessions)).toBe(1);
  });

  it('counts a merge-blocked PR as blocking even when checks passed', () => {
    const sessions = [
      session('a', 'idle', openPr({ mergeable: false, pipeline: 'success' })),
      session('b', 'idle', openPr({ mergeable: true, pipeline: 'success' })),
    ];
    expect(attentionCount(sessions)).toBe(1);
  });
});

describe('sessionAttention', () => {
  it('returns no flags for a plain running/idle session', () => {
    expect(sessionAttention({ status: 'running' })).toEqual([]);
    expect(sessionAttention({ status: 'idle' })).toEqual([]);
  });

  it('flags an awaiting_input session as a blocking question', () => {
    const flags = sessionAttention({ status: 'awaiting_input' });
    expect(flags.map((f) => f.kind)).toEqual(['question']);
    expect(flags[0]).toMatchObject({ tone: 'attention', blocking: true });
  });

  it('flags a crashed session', () => {
    expect(sessionAttention({ status: 'crashed' }).map((f) => f.kind)).toEqual(['crashed']);
  });

  it('marks an open PR whose pipeline failed as ci_failed (blocking, danger)', () => {
    const flags = sessionAttention({ status: 'idle', pr: openPr({ pipeline: 'failure' }) });
    expect(flags.map((f) => f.kind)).toEqual(['ci_failed']);
    expect(flags[0]).toMatchObject({ tone: 'danger', blocking: true });
  });

  it('marks a mergeable open PR as merge_ready (non-blocking, done)', () => {
    const flags = sessionAttention({
      status: 'idle',
      pr: openPr({ mergeable: true, pipeline: 'success' }),
    });
    expect(flags.map((f) => f.kind)).toEqual(['merge_ready']);
    expect(flags[0]).toMatchObject({ tone: 'done', blocking: false });
  });

  it('marks an open PR with passed checks but blocked merge as merge_blocked', () => {
    const flags = sessionAttention({
      status: 'idle',
      pr: openPr({ mergeable: false, pipeline: 'success' }),
    });
    expect(flags.map((f) => f.kind)).toEqual(['merge_blocked']);
    expect(flags[0]).toMatchObject({ tone: 'danger', blocking: true });
  });

  it('marks a conflicted PR as merge_conflict even though it has no pipeline at all', () => {
    // The conflict trap: GitHub builds no merge ref for a dirty PR, so no
    // `pull_request` checks run and the pipeline stays `unknown` — which used to
    // leave the session with NO marker despite being hard-blocked.
    const flags = sessionAttention({
      status: 'idle',
      pr: openPr({ pipeline: 'unknown', mergeable: false, mergeState: 'dirty' }),
    });
    expect(flags.map((f) => f.kind)).toEqual(['merge_conflict']);
    expect(flags[0]).toMatchObject({ tone: 'danger', blocking: true });
  });

  it('ranks merge_conflict above ci_failed and never doubles it with merge_blocked', () => {
    expect(
      sessionAttention({
        status: 'idle',
        pr: openPr({ pipeline: 'failure', mergeState: 'dirty' }),
      }).map((f) => f.kind),
    ).toEqual(['merge_conflict', 'ci_failed']);
    expect(
      sessionAttention({
        status: 'idle',
        pr: openPr({ pipeline: 'success', mergeable: false, mergeState: 'dirty' }),
      }).map((f) => f.kind),
    ).toEqual(['merge_conflict']);
  });

  it('floats a conflicted session to the top of the attention queue', () => {
    const sessions = [
      session('a', 'idle', openPr({ mergeable: true, pipeline: 'success' })),
      session('b', 'idle', openPr({ pipeline: 'unknown', mergeable: false, mergeState: 'dirty' })),
    ];
    expect(attentionQueue(sessions).map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(attentionCount(sessions)).toBe(1);
  });

  it('emits no flag for a non-dirty merge state', () => {
    // `behind`/`blocked`/`unstable` are ordinary states the pipeline + mergeable
    // tri-state already describe; only `dirty` means an actual conflict.
    for (const mergeState of ['behind', 'blocked', 'unstable', 'draft', 'clean'] as const) {
      expect(
        sessionAttention({ status: 'idle', pr: openPr({ pipeline: 'unknown', mergeState }) }),
      ).toEqual([]);
    }
  });

  it('emits no PR flag when checks passed but mergeability is still unknown (null)', () => {
    // GitHub returns mergeable=null for a few seconds after a push. This must NOT
    // read as merge_blocked (red, blocking) — the row would flash red the moment a
    // fix goes green. No flag until the next poll resolves it to ready/blocked.
    const flags = sessionAttention({
      status: 'idle',
      pr: openPr({ mergeable: null, pipeline: 'success' }),
    });
    expect(flags).toEqual([]);
  });

  it('does not surface an unknown-mergeability PR in the attention queue', () => {
    const sessions = [
      session('a', 'idle', openPr({ mergeable: null, pipeline: 'success' })),
      session('b', 'idle', openPr({ mergeable: false, pipeline: 'success' })),
    ];
    // Only the genuinely-blocked PR (b) floats up; the still-computing one (a) stays put.
    expect(attentionQueue(sessions).map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(attentionCount(sessions)).toBe(1);
  });

  it('marks an open PR with checks still running as ci_running (non-blocking, attention)', () => {
    for (const pipeline of ['pending', 'running'] as const) {
      const flags = sessionAttention({ status: 'idle', pr: openPr({ pipeline }) });
      expect(flags.map((f) => f.kind)).toEqual(['ci_running']);
      expect(flags[0]).toMatchObject({ tone: 'attention', blocking: false });
    }
  });

  it('emits no PR flag for an unknown pipeline or a non-open PR', () => {
    expect(sessionAttention({ status: 'idle', pr: openPr({ pipeline: 'unknown' }) })).toEqual([]);
    const merged = openPr({ phase: 'merged', mergeable: false, pipeline: 'success' });
    expect(sessionAttention({ status: 'idle', pr: merged })).toEqual([]);
  });

  it('adds an unread flag from the client-local bit', () => {
    expect(sessionAttention({ status: 'idle', unread: true }).map((f) => f.kind)).toEqual([
      'unread',
    ]);
  });

  it('carries several flags at once, in priority order', () => {
    const flags = sessionAttention({
      status: 'awaiting_input',
      pr: openPr({ mergeable: true, pipeline: 'success' }),
      unread: true,
    });
    expect(flags.map((f) => f.kind)).toEqual(['question', 'merge_ready', 'unread']);
  });

  it('orders ci_failed above merge_ready regardless of input order', () => {
    // (Not a real combination — mergeable ⇒ success — but the ORDER must hold.)
    const flags = sessionAttention({ status: 'crashed', pr: openPr({ pipeline: 'failure' }) });
    expect(flags.map((f) => f.kind)).toEqual(['crashed', 'ci_failed']);
  });

  it('orders merge_blocked above merge_ready regardless of input order', () => {
    const flags = sessionAttention({
      status: 'awaiting_input',
      pr: openPr({ mergeable: false, pipeline: 'success' }),
      unread: true,
    });
    expect(flags.map((f) => f.kind)).toEqual(['question', 'merge_blocked', 'unread']);
  });
});

describe('markerAttention', () => {
  it('drops question/crashed (already shown by the status pill)', () => {
    expect(markerAttention({ status: 'awaiting_input' })).toEqual([]);
    expect(markerAttention({ status: 'crashed' })).toEqual([]);
  });

  it('keeps the PR + unread flags the pill does not convey, in priority order', () => {
    const flags = markerAttention({
      status: 'crashed', // pill shows this; not a marker
      pr: openPr({ pipeline: 'failure' }),
      unread: true,
    });
    expect(flags.map((f) => f.kind)).toEqual(['ci_failed', 'unread']);
  });

  it('surfaces merge_ready as a marker on an idle session', () => {
    const flags = markerAttention({
      status: 'idle',
      pr: openPr({ mergeable: true, pipeline: 'success' }),
    });
    expect(flags.map((f) => f.kind)).toEqual(['merge_ready']);
  });

  it('surfaces merge_blocked as a marker on an idle session', () => {
    const flags = markerAttention({
      status: 'idle',
      pr: openPr({ mergeable: false, pipeline: 'success' }),
    });
    expect(flags.map((f) => f.kind)).toEqual(['merge_blocked']);
  });
});

describe('sandbox_disconnected (server-reported)', () => {
  const cutOff = [{ code: 'sandbox_disconnected', message: 'Sandbox lost its connection' }];

  it('flags a session the server says has lost its sandbox connection', () => {
    const flags = sessionAttention({ status: 'idle', attention: cutOff });
    expect(flags.map((f) => f.kind)).toEqual(['sandbox_disconnected']);
    expect(flags[0]?.blocking).toBe(true);
  });

  it('outranks every PR verdict — none of them is actionable from a dead sandbox', () => {
    const flags = sessionAttention({
      status: 'idle',
      pr: openPr({ pipeline: 'failure' }),
      attention: cutOff,
      unread: true,
    });
    expect(flags.map((f) => f.kind)).toEqual(['sandbox_disconnected', 'ci_failed', 'unread']);
  });

  it('ignores a condition code this build has never heard of', () => {
    // The message still renders through the notice line; inventing a marker for
    // an unknown code would mean guessing its tone and label.
    expect(
      sessionAttention({
        status: 'idle',
        attention: [{ code: 'future_condition', message: 'Something new' }],
      }),
    ).toEqual([]);
  });

  // It outranks every marker kind and only the FIRST marker is drawn, so leaving
  // it in the marker list would blank the slot AND hide the row's real PR marker
  // behind a kind the marker component has no glyph for.
  it('is not a marker — the row states it in words instead', () => {
    expect(markerAttention({ status: 'idle', attention: cutOff })).toEqual([]);
    expect(
      markerAttention({
        status: 'idle',
        attention: cutOff,
        pr: openPr({ pipeline: 'failure' }),
      }).map((f) => f.kind),
    ).toEqual(['ci_failed']);
  });

  // The guard behind that exclusion: every kind `markerAttention` can return must
  // be one `AttentionMarkers` has a branch for. Keep in sync with
  // apps/mobile/components/AttentionMarkers.tsx.
  it('only ever returns kinds the marker component can draw', () => {
    const drawable: readonly AttentionKind[] = [
      'merge_conflict',
      'ci_failed',
      'merge_blocked',
      'merge_ready',
      'ci_running',
      'unread',
    ];
    const everyKind: AttentionInput[] = [
      { status: 'awaiting_input' },
      { status: 'crashed' },
      { status: 'idle', attention: cutOff },
      { status: 'idle', pr: openPr({ mergeState: 'dirty' }) },
      { status: 'idle', pr: openPr({ pipeline: 'failure' }) },
      { status: 'idle', pr: openPr({ pipeline: 'success', mergeable: true }) },
      { status: 'idle', pr: openPr({ pipeline: 'success', mergeable: false }) },
      { status: 'idle', pr: openPr({ pipeline: 'running' }) },
      { status: 'idle', unread: true },
    ];
    for (const input of everyKind)
      for (const flag of markerAttention(input)) expect(drawable).toContain(flag.kind);
  });

  it('floats the affected session to the top of the queue and counts it', () => {
    const sessions = [
      session('a', 'idle'),
      { ...session('b', 'idle'), attention: cutOff },
      session('c', 'running'),
    ];
    expect(attentionQueue(sessions).map((s) => s.sessionId)).toEqual(['b', 'a', 'c']);
    expect(attentionCount(sessions)).toBe(1);
  });
});
