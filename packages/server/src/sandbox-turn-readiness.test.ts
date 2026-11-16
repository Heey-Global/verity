import { isSandboxNotReadyError } from '@verity/events';
import { describe, expect, it, vi } from 'vitest';

import {
  EGRESS_HOPS,
  classifyProbeError,
  TURN_READINESS_WAITING_MESSAGE,
  parseEgressReadiness,
  pendingEgressHops,
  requiredEgressHops,
  waitForSandboxTurnReadiness,
  type EgressHopState,
  type SandboxEgressProbe,
  type TurnReadinessInput,
} from './sandbox-turn-readiness.js';

function readiness(overrides: Partial<Record<(typeof EGRESS_HOPS)[number], EgressHopState>> = {}) {
  return {
    kind: 'readiness',
    readiness: {
      connector: 'ready',
      claude: 'ready',
      codex: 'ready',
      broker: 'ready',
      ...overrides,
    },
  } satisfies SandboxEgressProbe;
}

/** A clock that only moves when the gate sleeps, so timeouts are exact. */
function harness(probes: SandboxEgressProbe[], overrides: Partial<TurnReadinessInput> = {}) {
  let clock = 0;
  const queue = [...probes];
  const probe = vi.fn(async () => queue.shift() ?? probes[probes.length - 1]!);
  const waitingOn = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn() };
  const input: TurnReadinessInput = {
    projectId: 'project-1',
    sessionId: 'session-1',
    agent: 'codex',
    probe,
    canWait: true,
    waitingOn,
    log,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...overrides,
  };
  return { input, probe, waitingOn, log, elapsed: () => clock };
}

describe('waitForSandboxTurnReadiness', () => {
  it('admits a ready Sandbox after one probe, without a transcript note', async () => {
    const h = harness([readiness()]);
    await expect(waitForSandboxTurnReadiness(h.input)).resolves.toMatchObject({
      outcome: 'ready',
      attempts: 1,
    });
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.waitingOn).not.toHaveBeenCalled();
  });

  // The incident: the relay was running per Docker but refused the Codex
  // forward for a moment after a wake. The turn has to wait it out visibly.
  it('waits for a relay that refuses at first, then starts the turn', async () => {
    const h = harness([
      readiness({ codex: 'refused', broker: 'refused' }),
      readiness({ codex: 'refused' }),
      readiness(),
    ]);
    await expect(waitForSandboxTurnReadiness(h.input)).resolves.toMatchObject({
      outcome: 'ready',
      attempts: 3,
    });
    expect(h.waitingOn).toHaveBeenCalledTimes(1);
    expect(h.waitingOn).toHaveBeenCalledWith(TURN_READINESS_WAITING_MESSAGE);
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', sessionId: 'session-1', attempts: 3 }),
      expect.stringContaining('became ready'),
    );
  });

  it('waits while the runner supervisor does not answer yet', async () => {
    const h = harness([{ kind: 'unavailable' }, readiness()]);
    await expect(waitForSandboxTurnReadiness(h.input)).resolves.toMatchObject({ attempts: 2 });
    expect(h.waitingOn).toHaveBeenCalledTimes(1);
  });

  it('gives up within the deadline with a not-started error naming what was missing', async () => {
    const h = harness([readiness({ codex: 'refused' })], { timeoutMs: 10_000 });
    const failure = await waitForSandboxTurnReadiness(h.input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // Transient class: the session settles idle instead of badging `crashed`.
    expect(isSandboxNotReadyError(failure)).toBe(true);
    const [first, ...technical] = (failure as Error).message.split('\n');
    expect(first).toBe(
      'The project environment started, but its connection to Codex wasn’t ready within 10 seconds. Your message wasn’t sent to the agent.',
    );
    expect(technical.join('\n')).toContain('codex: refused');
    expect(technical.join('\n')).not.toMatch(/credential/iu);
    expect(h.elapsed()).toBeLessThanOrEqual(10_000);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        pending: ['codex'],
      }),
      expect.stringContaining('turn not started'),
    );
  });

  it('backs off instead of probing in a tight loop', async () => {
    const sleeps: number[] = [];
    const h = harness([readiness({ broker: 'refused' })], {
      timeoutMs: 6_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => sleeps.reduce((sum, ms) => sum + ms, 0),
    });
    await waitForSandboxTurnReadiness(h.input).catch(() => undefined);
    expect(sleeps).toEqual([250, 500, 1_000, 2_000, 2_000]);
  });

  // A background resolution (auto-title, reattach) must never sit on a wait.
  it('fails a background resolution at once without a transcript note', async () => {
    const h = harness([readiness({ codex: 'refused' }), readiness()], { canWait: false });
    const failure = await waitForSandboxTurnReadiness(h.input).catch((error: unknown) => error);
    expect(isSandboxNotReadyError(failure)).toBe(true);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.waitingOn).not.toHaveBeenCalled();
  });

  // Sandboxes built from an older toolkit keep starting turns as before.
  it('reports an older toolkit found after the supervisor came up as unsupported', async () => {
    const h = harness([{ kind: 'unavailable' }, { kind: 'unsupported' }]);
    await expect(waitForSandboxTurnReadiness(h.input)).resolves.toEqual({
      outcome: 'unsupported',
    });
    expect(h.log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('became ready'),
    );
  });

  it('lets an older toolkit through untouched', async () => {
    const h = harness([{ kind: 'unsupported' }]);
    await expect(waitForSandboxTurnReadiness(h.input)).resolves.toEqual({
      outcome: 'unsupported',
    });
    expect(h.waitingOn).not.toHaveBeenCalled();
  });

  // Without a relay the Codex leg is the gateway itself, whose refusal may mean
  // no credential: the turn must meet that at once, not after the deadline.
  it('does not wait on a gateway leg that is not behind a project relay', async () => {
    const h = harness([readiness({ codex: 'refused', broker: 'refused' })], { relayed: false });
    await expect(waitForSandboxTurnReadiness(h.input)).resolves.toMatchObject({ attempts: 1 });
    expect(h.waitingOn).not.toHaveBeenCalled();
  });

  it('only waits on the hops the agent uses', async () => {
    const codex = harness([readiness({ claude: 'refused' })]);
    await expect(waitForSandboxTurnReadiness(codex.input)).resolves.toMatchObject({ attempts: 1 });
    const claude = harness([readiness({ codex: 'refused' })], { agent: 'claude' });
    await expect(waitForSandboxTurnReadiness(claude.input)).resolves.toMatchObject({
      attempts: 1,
    });
  });
});

describe('egress readiness parsing', () => {
  it('requires the connector and the broker for every agent', () => {
    for (const agent of ['claude', 'codex', 'opencode'] as const) {
      expect(requiredEgressHops(agent)).toEqual(expect.arrayContaining(['connector', 'broker']));
    }
    expect(requiredEgressHops('opencode')).toContain('codex');
  });

  it('does not wait on a leg the Sandbox was provisioned without or misconfigured', () => {
    expect(pendingEgressHops(readiness({ codex: 'not_configured' }), ['codex'])).toEqual([]);
    expect(pendingEgressHops(readiness({ codex: 'invalid' }), ['codex'])).toEqual([]);
  });

  it('reads a malformed reply as an older toolkit, never as a failure', () => {
    expect(parseEgressReadiness({ ok: true })).toEqual({ kind: 'unsupported' });
    expect(
      parseEgressReadiness({
        egressReadinessVersion: 1,
        connector: 'ready',
        claude: 'ready',
        codex: 'surprise',
        broker: 'ready',
      }),
    ).toEqual({ kind: 'unsupported' });
    expect(
      parseEgressReadiness({
        egressReadinessVersion: 1,
        connector: 'ready',
        claude: 'refused',
        codex: 'ready',
        broker: 'timeout',
      }),
    ).toEqual(readiness({ claude: 'refused', broker: 'timeout' }));
  });
});

describe('classifyProbeError', () => {
  it('waits only on a supervisor that timed out', () => {
    expect(
      classifyProbeError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
    ).toEqual({ kind: 'unavailable' });
  });

  it('lets every other failure through as before', () => {
    for (const error of [
      Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect EACCES'), { code: 'EACCES' }),
      new Error('unsupported supervisor protocol'),
      'not an error',
    ]) {
      expect(classifyProbeError(error)).toEqual({ kind: 'unsupported' });
    }
  });
});
