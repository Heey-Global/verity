import { SESSION_SUMMARY_FIELDS, type DomainEvent } from '@verity/events';
import { describe, expect, it } from 'vitest';
import { sessionSummarySchema, type SessionSummary } from '../api.js';
import { inboxItems } from '../ui/inbox.js';
import { applyOverviewEvent, keptWithout, RevisionGate } from './overviewEvents.js';

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function waiting(): SessionSummary {
  return {
    sessionId: 's1',
    worktree: '/wt/s1',
    model: 'm',
    name: null,
    status: 'awaiting_input',
    usage,
    permissionAwaitingInput: true,
    pendingPermissions: ['tool-1'],
    pendingPermissionRequests: [
      { toolUseId: 'tool-1', tool: 'Bash', riskClass: 'secret', detached: true },
    ],
    openChoices: { options: [{ label: 'Ship it' }] },
  };
}

const kinds = (sessions: readonly SessionSummary[]) =>
  inboxItems({ sessions, projects: [], now: 0 }).map((item) => item.kind);

describe('applyOverviewEvent', () => {
  it('removes a decided request from what Home shows', () => {
    const effect = applyOverviewEvent([waiting()], {
      t: 'permission.decided',
      sessionId: 's1',
      toolUseId: 'tool-1',
      rev: 2,
      outcome: 'allowed',
    });
    expect(effect.kind).toBe('local');
    if (effect.kind !== 'local') return;
    expect(kinds(effect.sessions)).not.toContain('permission');
    expect(effect.sessions[0]).toMatchObject({ status: 'running', pendingPermissionRequests: [] });
  });

  it('removes answered Quick Actions', () => {
    const before = kinds([waiting()]);
    expect(before).toContain('question');
    const effect = applyOverviewEvent([waiting()], {
      t: 'choices.answered',
      sessionId: 's1',
      rev: 2,
    });
    expect(effect.kind === 'local' && kinds(effect.sessions)).not.toContain('question');
  });

  it('asks for a read when something new opens, since only the read carries its content', () => {
    for (const event of [
      { t: 'permission.requested', sessionId: 's1', toolUseId: 'tool-2', rev: 3 },
      { t: 'choices.opened', sessionId: 's1', rev: 3 },
    ] satisfies DomainEvent[]) {
      expect(applyOverviewEvent([waiting()], event)).toEqual({ kind: 'reload' });
    }
  });

  it('leaves sessions it does not concern untouched', () => {
    const sessions = [waiting()];
    expect(
      applyOverviewEvent(sessions, { t: 'choices.answered', sessionId: 'other', rev: 1 }),
    ).toEqual({ kind: 'none' });
  });
});

describe('applyOverviewEvent pr.status', () => {
  const merged = {
    number: 7,
    title: 'Add live status',
    url: 'https://example.test/pr/7',
    phase: 'merged',
    pipeline: 'success',
    mergeable: null,
    mergeState: 'clean',
    checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
  };

  it('replaces the full and the compact status, dropping fields the new one lacks', () => {
    const before: SessionSummary = {
      ...waiting(),
      pr: { phase: 'open', pipeline: 'running', mergeable: null, mergeState: 'blocked' },
    };
    const effect = applyOverviewEvent([before], {
      t: 'pr.status',
      sessionId: 's1',
      rev: 1,
      pr: { ...merged, mergeState: undefined },
    });
    expect(effect.kind).toBe('local');
    if (effect.kind !== 'local') return;
    expect(effect.sessions[0]!.pr).toEqual({
      phase: 'merged',
      pipeline: 'success',
      mergeable: null,
    });
    expect(effect.sessions[0]!.pullRequest).toMatchObject({ number: 7, phase: 'merged' });
  });

  it('clears both when the session has no pull request any more', () => {
    const effect = applyOverviewEvent([waiting()], {
      t: 'pr.status',
      sessionId: 's1',
      rev: 1,
      pr: null,
    });
    expect(effect.kind === 'local' && effect.sessions[0]).toMatchObject({
      pr: null,
      pullRequest: null,
    });
  });

  it('leaves a status this app cannot read to the overview read', () => {
    expect(
      applyOverviewEvent([waiting()], {
        t: 'pr.status',
        sessionId: 's1',
        rev: 1,
        pr: { number: 'seven' },
      }).kind,
    ).toBe('reload');
  });

  it('does not read for an unreadable status of a session this view does not hold', () => {
    expect(
      applyOverviewEvent([waiting()], {
        t: 'pr.status',
        sessionId: 's9',
        rev: 1,
        pr: { number: 'seven' },
      }).kind,
    ).toBe('none');
  });

  it('ignores sessions this view does not hold', () => {
    expect(
      applyOverviewEvent([waiting()], { t: 'pr.status', sessionId: 's9', rev: 1, pr: merged }).kind,
    ).toBe('none');
  });
});

describe('keptWithout', () => {
  it('keeps one pull request status per session and every answer', () => {
    const status = (sessionId: string, rev: number): DomainEvent => ({
      t: 'pr.status',
      sessionId,
      rev,
      pr: null,
    });
    const answered: DomainEvent = { t: 'choices.answered', sessionId: 's1', rev: 1 };
    let kept: { event: DomainEvent }[] = [{ event: answered }];
    for (let rev = 2; rev < 10; rev += 1) {
      kept = [...keptWithout(kept, status('s1', rev)), { event: status('s1', rev) }];
    }
    kept = [...keptWithout(kept, status('s2', 10)), { event: status('s2', 10) }];
    expect(kept.map(({ event }) => event)).toEqual([answered, status('s1', 9), status('s2', 10)]);
  });
});

describe('RevisionGate', () => {
  it('applies each entity revision once and in order, until a resync', () => {
    const gate = new RevisionGate();
    const answered = (rev: number): DomainEvent => ({
      t: 'choices.answered',
      sessionId: 's1',
      rev,
    });
    expect(gate.accept(answered(5))).toBe(true);
    expect(gate.accept(answered(5))).toBe(false);
    expect(gate.accept(answered(4))).toBe(false);
    // Another entity keeps its own order.
    expect(gate.accept({ t: 'choices.answered', sessionId: 's2', rev: 1 })).toBe(true);
    gate.reset();
    expect(gate.accept(answered(4))).toBe(true);
  });

  it('keeps an entity that keeps changing when the gate is full', () => {
    // Evicting by first insertion would let a stale replay of the busiest
    // session through.
    const gate = new RevisionGate();
    const answered = (sessionId: string, rev: number): DomainEvent => ({
      t: 'choices.answered',
      sessionId,
      rev,
    });
    gate.accept(answered('busy', 1));
    for (let i = 0; i < 2_048; i += 1) {
      gate.accept(answered(`other-${i}`, 1));
      if (i === 1_000) gate.accept(answered('busy', 2));
    }
    expect(gate.accept(answered('busy', 2))).toBe(false);
  });
});

describe('applyOverviewEvent with session.summary', () => {
  /** The whole shared row a server publishes for `session`, changed by `change`. */
  const summary = (session: SessionSummary, change: Record<string, unknown>): DomainEvent => {
    const row: Record<string, unknown> = {};
    for (const key of SESSION_SUMMARY_FIELDS) if (key in session) row[key] = session[key];
    return { t: 'session.summary', sessionId: 's1', rev: 1, patch: { ...row, ...change } };
  };

  it("replaces the session's shared fields and keeps what each viewer sees", () => {
    const session = { ...waiting(), lastActivityAt: 5, inboxDismissed: ['x'] } as SessionSummary;
    const effect = applyOverviewEvent(
      [session],
      summary(session, { status: 'idle', eventCount: 9 }),
    );
    expect(effect.kind).toBe('local');
    const [next] = (effect as { sessions: SessionSummary[] }).sessions;
    expect(next).toMatchObject({ status: 'idle', eventCount: 9, inboxDismissed: ['x'] });
    // Owned by permission events, not by the row.
    expect(next!.pendingPermissions).toEqual(['tool-1']);
  });

  it('drops a shared field the row lacks, and keeps null where null is a value', () => {
    const session = { ...waiting(), backgroundWorking: true, lastActivityAt: 5 } as SessionSummary;
    const event = summary(session, { lastActivityAt: null });
    delete (event as { patch: Record<string, unknown> }).patch.backgroundWorking;
    const effect = applyOverviewEvent([session], event);
    const [next] = (effect as { sessions: SessionSummary[] }).sessions;
    expect(next).not.toHaveProperty('backgroundWorking');
    expect(next!.lastActivityAt).toBeNull();
  });

  it('asks for a read when the row is not one this app can read', () => {
    expect(applyOverviewEvent([waiting()], summary(waiting(), { status: 42 })).kind).toBe('reload');
  });

  it('leaves sessions it does not list to their list read', () => {
    expect(applyOverviewEvent([], summary(waiting(), { status: 'idle' })).kind).toBe('none');
  });

  // An unclassified field would either never reach Home live, or reach every
  // viewer of the project although it is someone's own: each must be decided.
  it('classifies every overview field as shared or as kept from the read', () => {
    const kept = new Set([
      // Identity and placement; a move or rename is hinted as `session`.
      'sessionId',
      'worktree',
      'projectId',
      // What each person sees differently.
      'favorite',
      'lastSeenEventCount',
      'inboxDismissed',
      'addressedToViewer',
      'changeSubmission',
      'linked',
      'sortOrder',
      // Owned by `permission.*`, `choices.*` and `pr.status`.
      'pendingPermissions',
      'permissionAwaitingInput',
      'pendingPermissionRequests',
      'openChoices',
      'pr',
      'pullRequest',
    ]);
    const shared = new Set<string>(SESSION_SUMMARY_FIELDS);
    const fields = Object.keys(sessionSummarySchema.shape);
    expect(fields.filter((field) => !kept.has(field) && !shared.has(field))).toEqual([]);
    expect([...shared].filter((field) => kept.has(field))).toEqual([]);
  });
});

describe('keptWithout with session.summary', () => {
  // A streaming session publishes a row every two seconds; only the newest
  // one matters to a read still on its way.
  it("keeps only a session's newest row", () => {
    const row = (sessionId: string, rev: number) => ({
      event: { t: 'session.summary', sessionId, rev, patch: {} } as DomainEvent,
    });
    const kept = keptWithout([row('s1', 1), row('s2', 1)], row('s1', 2).event);
    expect(kept.map(({ event }) => 'sessionId' in event && event.sessionId)).toEqual(['s2']);
  });
});
