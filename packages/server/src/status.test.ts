import {
  aggregateUsage,
  agentEventSchema,
  latestRateLimits,
  parseAgentEvent,
  SESSION_PROJECTION_EVENT_TYPES,
  sessionProjectionEvents,
  turnFailureErrorKind,
  type AgentEvent,
  type AgentEventType,
} from '@verity/events';
import type { ProjectRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import { ensureProjectSandboxReadyForTurn } from './project-auto-wake.js';
import {
  deriveSessionStatus,
  deriveSessionStatusFromProjection,
  permissionEventAwaitsInput,
  projectionTailIsSelfContained,
} from './status.js';

const text: AgentEvent = { t: 'text', delta: 'hi' };
const running: AgentEvent = { t: 'status', state: 'running' };
const awaitingDep: AgentEvent = { t: 'status', state: 'awaiting_dependency' };
const result: AgentEvent = {
  t: 'result',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  stopReason: 'end_turn',
};
const error: AgentEvent = { t: 'error', kind: 'boom', message: 'x' };
const taskStarted: AgentEvent = { t: 'task', id: 'bg1', phase: 'started' };
const taskEnded: AgentEvent = { t: 'task', id: 'bg1', phase: 'ended', status: 'completed' };
const permission: AgentEvent = {
  t: 'permission',
  id: 'p1',
  tool: 'Bash',
  input: {},
  riskClass: 'ask',
};

it('attributes awaiting input to a permission across later steered prompts', () => {
  expect(
    permissionEventAwaitsInput([permission, { t: 'prompt', text: 'extra context', steered: true }]),
  ).toBe(true);
  expect(permissionEventAwaitsInput([permission, { t: 'status', state: 'awaiting_input' }])).toBe(
    false,
  );
});

describe('deriveSessionStatus', () => {
  it('is idle for an empty log', () => {
    expect(deriveSessionStatus([])).toBe('idle');
  });

  it('returns the most recent explicit status state', () => {
    expect(deriveSessionStatus([running])).toBe('running');
    expect(deriveSessionStatus([running, awaitingDep])).toBe('awaiting_dependency');
  });

  it('maps result -> completed, error -> crashed, permission -> awaiting_input', () => {
    expect(deriveSessionStatus([text, result])).toBe('completed');
    expect(deriveSessionStatus([text, error])).toBe('crashed');
    expect(deriveSessionStatus([text, permission])).toBe('awaiting_input');
  });

  it('does not freeze a session on `crashed` when only the Sandbox was asleep', async () => {
    // The whole chain in one guard, because each link fails silently on its own:
    // the readiness check stops marking its refusal as transient, the conductor
    // writes the marked failure under another kind, or this projection's
    // non-crashing set drifts away from that kind. Any one of them and a session
    // whose Sandbox came back a minute later still badges red — and since the
    // backward scan settles on that event, it stays red until the operator sends
    // another message by hand.
    const sleeping = { id: 'p1', state: 'sleeping' } as ProjectRecord;
    const failure = await ensureProjectSandboxReadyForTurn({
      project: sleeping,
      getProject: async () => sleeping,
      // A background resolution — an auto-title, or the reattach after a server
      // restart. Those never wait out a wake; they fail fast, by design.
      canWait: false,
      waitingOn: vi.fn(),
      ensureAwake: async () => ({ id: 'p1', state: 'active' }) as ProjectRecord,
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/sleeping/);

    const turn: AgentEvent[] = [{ t: 'prompt', text: 'go' }, text];
    const persisted: AgentEvent = {
      t: 'error',
      kind: turnFailureErrorKind(failure),
      message: failure?.message ?? '',
    };
    expect(deriveSessionStatus([...turn, persisted])).toBe('idle');
    // …and the premise: a failure that is NOT the transient class still crashes
    // the session, so the assertion above is not passing because the projection
    // stopped badging `crashed` altogether.
    const ranAndFailed: AgentEvent = {
      t: 'error',
      kind: turnFailureErrorKind(new Error('the agent died')),
      message: 'the agent died',
    };
    expect(deriveSessionStatus([...turn, ranAndFailed])).toBe('crashed');

    // The other direction, which is the dangerous one: a session that really did
    // crash, then a background resolution that fails fast against the sleeping
    // Sandbox behind it. Settling on the newest event would clear the red badge
    // and leave a broken session reading `idle` — a false green nobody goes
    // looking for. The transient event is walked past, so the crash survives it.
    expect(deriveSessionStatus([...turn, ranAndFailed, persisted])).toBe('crashed');
    expect(deriveSessionStatus([...turn, result, persisted])).toBe('completed');
    // A live or waiting status belonged to the turn this error just ended. It
    // must not remain stuck after the terminal transient failure.
    expect(deriveSessionStatus([running, persisted])).toBe('idle');
    expect(deriveSessionStatus([awaitingDep, persisted])).toBe('idle');
    expect(deriveSessionStatus([permission, persisted])).toBe('idle');
    expect(
      deriveSessionStatus([
        { t: 'task', id: 'background', phase: 'started', description: 'Background task' },
        result,
        persisted,
      ]),
    ).toBe('completed');
    // Nothing older to speak for the session: still `idle`, never `running`.
    expect(deriveSessionStatus([text, persisted])).toBe('idle');
  });

  it('treats an interrupted turn as terminal and non-crashed', () => {
    expect(deriveSessionStatus([text, { t: 'interrupted' }])).toBe('completed');
    expect(
      deriveSessionStatus([
        { t: 'prompt', text: 'old turn' },
        error,
        { t: 'prompt', text: 'resume' },
        { t: 'interrupted' },
      ]),
    ).toBe('completed');
  });

  it('lets the most recent status-bearing event win', () => {
    // a later running status overrides an earlier result
    expect(deriveSessionStatus([result, running])).toBe('running');
  });

  it('treats a log of only neutral events as running', () => {
    expect(deriveSessionStatus([text, text])).toBe('running');
  });

  it('stays running when a `result` fires while a background task is still open', () => {
    // A run_in_background dispatch: the turn's first `result` lands while the task
    // runs on. The session is not done — the backend re-invokes once it finishes.
    expect(deriveSessionStatus([taskStarted, result])).toBe('running');
  });

  it('completes once the background task ends and the final result lands', () => {
    expect(deriveSessionStatus([taskStarted, result, taskEnded, result])).toBe('completed');
  });

  it('an unfinished background task keeps the session running regardless of result order', () => {
    // Two tasks open, only one closed → still outstanding work.
    const other: AgentEvent = { t: 'task', id: 'bg2', phase: 'started' };
    expect(deriveSessionStatus([taskStarted, other, taskEnded, result])).toBe('running');
  });

  it('does not let an orphaned task from an older turn poison a later completion', () => {
    expect(
      deriveSessionStatus([
        { t: 'prompt', text: 'first' },
        taskStarted,
        result,
        { t: 'prompt', text: 'second' },
        result,
      ]),
    ).toBe('completed');
  });

  it('keeps a task open across a prompt steered into the current turn', () => {
    expect(
      deriveSessionStatus([
        { t: 'prompt', text: 'first' },
        taskStarted,
        result,
        { t: 'prompt', text: 'more context', steered: true },
        result,
      ]),
    ).toBe('running');
  });

  it('does not inherit a terminal status across a fresh prompt boundary', () => {
    expect(deriveSessionStatus([result, { t: 'prompt', text: 'new turn' }, text])).toBe('running');
    expect(deriveSessionStatus([error, { t: 'prompt', text: 'new turn' }])).toBe('running');
  });
});

describe('projectionTailIsSelfContained', () => {
  it('accepts a tail at a fresh prompt boundary and preserves the full-log status', () => {
    const oldTurn: AgentEvent[] = [{ t: 'prompt', text: 'old' }, taskStarted, result];
    const tail: AgentEvent[] = [{ t: 'prompt', text: 'new' }, text, result];
    expect(projectionTailIsSelfContained(tail)).toBe(true);
    expect(deriveSessionStatus(tail)).toBe(deriveSessionStatus([...oldTurn, ...tail]));
  });

  it('rejects a tail whose only prompt was steered into an earlier turn', () => {
    const tail: AgentEvent[] = [{ t: 'prompt', text: 'more context', steered: true }, result];
    expect(projectionTailIsSelfContained(tail)).toBe(false);
    expect(deriveSessionStatus(tail)).not.toBe(
      deriveSessionStatus([{ t: 'prompt', text: 'start' }, taskStarted, ...tail]),
    );
  });

  it('licenses the permission reader over the same boundary', () => {
    // The overview runs BOTH derivations over the same tail, so the predicate is
    // only a licence if it covers both. `permissionEventAwaitsInput` stops at a
    // non-steered `prompt` for its own reasons; if it ever reads past one, a tail
    // accepted here starts answering a question about the previous turn — an
    // answered permission card reappearing on a session that has moved on.
    const earlier: AgentEvent[] = [{ t: 'prompt', text: 'old' }, permission];
    const tail: AgentEvent[] = [{ t: 'prompt', text: 'new' }, text];
    expect(projectionTailIsSelfContained(tail)).toBe(true);
    expect(permissionEventAwaitsInput(tail)).toBe(
      permissionEventAwaitsInput([...earlier, ...tail]),
    );
    // …and the premise: the earlier turn really does hold a permission event, so
    // the agreement above is not two `false`s meeting by accident.
    expect(permissionEventAwaitsInput(earlier)).toBe(true);
  });
});

/**
 * One representative event per {@link AgentEvent} kind. The coverage assertion
 * below derives the kind list from `agentEventSchema` itself, so adding an event
 * kind to the union fails here until it gets a sample — which is what makes the
 * projection guards below cover the whole union rather than whatever was
 * interesting on the day they were written.
 */
const SAMPLES: Record<AgentEventType, AgentEvent> = {
  session: { t: 'session', id: 's1', model: 'claude-opus-5', worktree: '/wt/s1' },
  status: running,
  text,
  notice: { t: 'notice', text: 'transcribing…' },
  prompt: { t: 'prompt', text: 'do the thing' },
  thinking: { t: 'thinking', blockId: 'b1', delta: 'hmm' },
  skill: { t: 'skill', text: '/code-review' },
  tool_call_start: { t: 'tool_call_start', id: 'toolu_1', name: 'Bash' },
  tool_call: { t: 'tool_call', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
  tool_result: { t: 'tool_result', id: 'toolu_1', output: 'ok', isError: false },
  permission,
  result,
  // `usedPercent` on purpose: `latestRateLimits` DROPS an `allowed` state without
  // one, so a sample missing it would leave the rate-limit guards below asserting
  // nothing at all — the projection's answer would be empty either way.
  rate_limit: {
    t: 'rate_limit',
    status: 'limited',
    resetsAt: 1,
    window: 'five_hour',
    usedPercent: 87,
  },
  task: taskStarted,
  choices: { t: 'choices', options: [{ label: 'yes' }] },
  agent_loop_proposal: {
    t: 'agent_loop_proposal',
    proposal: {
      loopId: '8d2b7f16-3a2e-4a29-9f0c-7b6b1c5a0d11',
      name: 'nightly sweep',
      script: 'run the sweep',
      schedule: { kind: 'interval', everyMinutes: 60 },
    },
  },
  interrupted: { t: 'interrupted' },
  merged: { t: 'merged', number: 7 },
  compaction: { t: 'compaction', boundary: true },
  error,
  session_progress: { t: 'session_progress', summary: 'halfway', outcomeDelivered: false },
  raw: { t: 'raw', backend: 'claude-code', payload: { a: 1 } },
};

describe('the session-overview projection slice', () => {
  const kinds = agentEventSchema.options.map((option) => option.shape.t.value);

  it('has a sample for every event kind in the union', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...kinds].sort());
    // Samples are real events, not shapes that merely satisfy the TS type: a
    // sample the store could never persist would prove nothing about the filter.
    for (const sample of Object.values(SAMPLES)) {
      expect(parseAgentEvent(sample).success).toBe(true);
    }
  });

  it('lists every event kind the usage and rate-limit projections read', () => {
    // The overview runs THREE projections over this slice, not one. Status is
    // covered below; these two are the ones that would fail quietly — an
    // under-reported token total or a missing limit banner looks like a real
    // answer. Same derivation as the status guard: if inserting an event changes
    // the projection's output, the filter must not drop that kind.
    for (const [kind, sample] of Object.entries(SAMPLES) as [AgentEventType, AgentEvent][]) {
      const withSample = [sample];
      const movesUsage =
        JSON.stringify(aggregateUsage(withSample)) !== JSON.stringify(aggregateUsage([]));
      const movesLimits =
        JSON.stringify(latestRateLimits(withSample)) !== JSON.stringify(latestRateLimits([]));
      if (movesUsage || movesLimits) expect(SESSION_PROJECTION_EVENT_TYPES).toContain(kind);
    }
  });

  it('lists every event kind that can move the derived status', () => {
    // The set is what the store filters on. Anything the derivation reacts to and
    // the filter drops would silently badge sessions wrong, so derive the
    // requirement from the derivation: if removing an event from a log can change
    // the answer, that kind MUST survive the filter.
    // Contexts are non-empty on purpose — over an EMPTY log every kind changes the
    // answer (idle → running), which is precisely the one thing the filter cannot
    // carry and why the event count is passed to the projection variant separately.
    const contexts: AgentEvent[][] = [
      [text],
      [running],
      [result],
      [{ t: 'prompt', text: 'turn' }, taskStarted, result],
      [error, { t: 'prompt', text: 'turn' }],
    ];
    for (const [kind, sample] of Object.entries(SAMPLES) as [AgentEventType, AgentEvent][]) {
      const influences = contexts.some((context) =>
        context.some((_, at) => {
          const withSample = [...context.slice(0, at), sample, ...context.slice(at)];
          return deriveSessionStatus(withSample) !== deriveSessionStatus(context);
        }),
      );
      if (influences) expect(SESSION_PROJECTION_EVENT_TYPES).toContain(kind);
    }
  });

  it('derives the same status, usage and limits from the filtered slice as from the whole log', () => {
    // Deterministic pseudo-random logs (a fixed LCG, so a failure is reproducible)
    // over every event kind: the property under guard is that narrowing the log to
    // the projection slice cannot change what the overview shows — the badge
    // (given the total event count), the token totals, or the limit states.
    let seed = 0x2f6e2b1;
    const nextIndex = (bound: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % bound;
    };
    // Logs run to ~2x the union size on purpose. The single-event guards above
    // cannot see a projection that reacts to a COMBINATION — a boundary event
    // resetting a running total, say — and only logs long enough to hold several
    // kinds at once put those pairs in front of it.
    const pool = Object.values(SAMPLES);
    for (let run = 0; run < 500; run += 1) {
      const log = Array.from({ length: nextIndex(40) }, () => pool[nextIndex(pool.length)]!);
      const slice = sessionProjectionEvents(log);
      expect(deriveSessionStatusFromProjection(slice, log.length)).toBe(deriveSessionStatus(log));
      expect(aggregateUsage(slice)).toEqual(aggregateUsage(log));
      expect(latestRateLimits(slice)).toEqual(latestRateLimits(log));
    }
  });

  it('reads an empty log as idle and an unprojected-only log as running', () => {
    // The one case the filter genuinely loses: a session whose log holds nothing
    // the projection reads still HAS events, so it is running, not idle.
    const log = [text, { t: 'raw' as const, backend: 'claude-code', payload: {} }];
    expect(sessionProjectionEvents(log)).toEqual([]);
    expect(deriveSessionStatusFromProjection([], log.length)).toBe('running');
    expect(deriveSessionStatusFromProjection([], 0)).toBe('idle');
  });
});
