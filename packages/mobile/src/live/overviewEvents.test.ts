import type { DomainEvent } from '@verity/events';
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../api.js';
import { inboxItems } from '../ui/inbox.js';
import { applyOverviewEvent, RevisionGate } from './overviewEvents.js';

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
