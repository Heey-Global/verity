import { describe, expect, it } from 'vitest';

import {
  attentionSignals,
  sessionAttentionSignals,
  SANDBOX_DISCONNECTED_MESSAGE,
  SIGN_IN_REJECTED_STALL_MS,
  UPDATER_STALL_MS,
  USAGE_PROBE_STALL_MS,
  type AttentionInputs,
  type UpdaterProbe,
} from './attention.js';
import { CODEX_USAGE_MAX_BACKOFF_MS } from './codexUsage.js';
import type { UpdateOperation } from './self-update/update-operation.js';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function operation(overrides: Partial<UpdateOperation> = {}): UpdateOperation {
  return {
    updateId: 'update-1',
    state: 'activating',
    phase: 'switching-gateway',
    step: 12,
    totalSteps: 16,
    generation: 3,
    previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
    targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
    failureCode: null,
    startedAt: new Date(NOW - UPDATER_STALL_MS * 2).toISOString(),
    updatedAt: new Date(NOW - 1000).toISOString(),
    ...overrides,
  };
}

const healthy: UpdaterProbe = { kind: 'reachable', operation: null };

describe('attentionSignals', () => {
  it('says nothing about a healthy Server', () => {
    expect(attentionSignals({ secretStatus: 'unlocked', updater: healthy, now: NOW })).toEqual([]);
  });

  // The incident's exact state: serving /sessions perfectly well, and unable to
  // give a single sandbox a signing key or a GitHub token.
  it('flags a sealed Server', () => {
    const signals = attentionSignals({ secretStatus: 'sealed', updater: healthy, now: NOW });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.code).toBe('secret_sealed');
    expect(signals[0]?.message).toContain('sealed');
  });

  it('stays quiet about a Server that was never initialized or is unmanaged', () => {
    for (const secretStatus of ['uninitialized', 'unmanaged'] as const)
      expect(attentionSignals({ secretStatus, updater: healthy, now: NOW })).toEqual([]);
  });

  it('flags an Updater that is not answering its control socket', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: { kind: 'unreachable' },
      now: NOW,
    });
    expect(signals).toEqual([
      { code: 'updater_unhealthy', message: expect.stringContaining('not answering') },
    ]);
  });

  it('says nothing about a deployment that has no Updater at all', () => {
    expect(
      attentionSignals({ secretStatus: 'unlocked', updater: { kind: 'unmanaged' }, now: NOW }),
    ).toEqual([]);
  });

  it('flags an update that stopped moving in a non-terminal phase', () => {
    const stalled = operation({
      updatedAt: new Date(NOW - UPDATER_STALL_MS - 1).toISOString(),
    });
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: { kind: 'reachable', operation: stalled },
      now: NOW,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.code).toBe('updater_unhealthy');
    expect(signals[0]?.message).toContain('switching-gateway');
  });

  it('leaves an update that is still progressing alone', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: { kind: 'reachable', operation: operation() },
      now: NOW,
    });
    expect(signals).toEqual([]);
  });

  it.each(['completed', 'rolled-back', 'failed'] as const)(
    'never calls a %s operation stuck, however old it is',
    (state) => {
      const old = operation({
        state,
        updatedAt: new Date(NOW - UPDATER_STALL_MS * 100).toISOString(),
      });
      expect(
        attentionSignals({
          secretStatus: 'unlocked',
          updater: { kind: 'reachable', operation: old },
          now: NOW,
        }),
      ).toEqual([]);
    },
  );

  it('treats an unparsable journal timestamp as no evidence of a stall', () => {
    expect(
      attentionSignals({
        secretStatus: 'unlocked',
        updater: { kind: 'reachable', operation: operation({ updatedAt: 'not-a-date' }) },
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('reports both conditions when both hold, sealed first', () => {
    const signals = attentionSignals({
      secretStatus: 'sealed',
      updater: { kind: 'unreachable' },
      now: NOW,
    });
    expect(signals.map((signal) => signal.code)).toEqual(['secret_sealed', 'updater_unhealthy']);
  });

  it('flags a Codex quota probe that has been failing long enough to matter', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: {
        state: 'http-error',
        status: 401,
        at: NOW,
        since: NOW - USAGE_PROBE_STALL_MS - 1,
      },
      now: NOW,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.code).toBe('usage_probe_unhealthy');
    // Names the status for the person who can act on it, and — more importantly —
    // says what the meter is actually showing instead.
    expect(signals[0]?.message).toContain('HTTP 401');
    expect(signals[0]?.message).toContain('not your account');
  });

  it('still says what the meter is doing when there is no status to name', () => {
    // `res?.status` is undefined when the request never produced a response at
    // all. The cause clause drops out; the consequence must not.
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: {
        state: 'http-error',
        status: undefined,
        at: NOW,
        since: NOW - USAGE_PROBE_STALL_MS - 1,
      },
      now: NOW,
    });
    expect(signals[0]?.message).toBe(
      "Codex usage check was refused — the Codex meter is showing an older number, not your account's now",
    );
  });

  it('says nothing until the failure has outlasted a backoff step', () => {
    expect(
      attentionSignals({
        secretStatus: 'unlocked',
        updater: healthy,
        codexUsage: { state: 'failed', at: NOW, since: NOW - USAGE_PROBE_STALL_MS },
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('withdraws the verdict once nothing has re-checked it in a long while', () => {
    // The probe only attempts when someone reads the meter. A failure nobody has
    // re-tested for half an hour is not evidence the endpoint is still down.
    expect(
      attentionSignals({
        secretStatus: 'unlocked',
        updater: healthy,
        codexUsage: {
          state: 'http-error',
          status: 500,
          at: NOW - USAGE_PROBE_STALL_MS - 1,
          since: NOW - USAGE_PROBE_STALL_MS * 4,
        },
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('says nothing about a verdict whose timestamps are not numbers', () => {
    // The guard that withdraws an unrefreshed verdict compares against `at`, and
    // every comparison against NaN is false — so a probe handing over a non-number
    // would get its stale verdict ASSERTED rather than withdrawn. The server
    // shape-checks the object it is given; this is the same care one field deeper.
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: {
        state: 'failed',
        at: Number.NaN,
        since: Number.NaN,
      } as unknown as Exclude<AttentionInputs['codexUsage'], undefined>,
      now: NOW,
    });
    expect(signals).toEqual([]);
  });

  it('flags a quota endpoint it cannot reach at all', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: { state: 'failed', at: NOW, since: NOW - USAGE_PROBE_STALL_MS - 1 },
      now: NOW,
    });
    expect(signals[0]?.message).toContain('could not be reached');
  });

  it('flags a quota response it cannot read, once it persists', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: {
        state: 'unreadable',
        fields: ['plan_type', 'usage'],
        windows: 0,
        at: NOW,
        since: NOW - USAGE_PROBE_STALL_MS - 1,
      },
      now: NOW,
    });
    expect(signals[0]?.code).toBe('usage_probe_unhealthy');
    expect(signals[0]?.message).toContain('does not understand');
    expect(signals[0]?.message).toContain('not your account');
  });

  // The same failure with something salvaged from it. Saying "you are looking at
  // the last value a session reported" here would be a lie in the direction that
  // costs the most: the number on screen IS the account's, and the reader would
  // go looking for a staleness that is not there.
  it('does not call a half-read answer stale, because the half it read is fresh', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: {
        state: 'unreadable',
        fields: ['rate_limits'],
        windows: 1,
        at: NOW,
        since: NOW - USAGE_PROBE_STALL_MS - 1,
      },
      now: NOW,
    });
    expect(signals[0]?.code).toBe('usage_probe_unhealthy');
    expect(signals[0]?.message).toBe(
      'Codex usage check came back in a shape Verity does not understand — the Codex meter may be missing a window',
    );
  });

  // A Server nobody has given a Codex login to is not broken, and a Claude-only
  // deployment must never carry a permanent banner about a probe it doesn't want.
  // `idle` is the same rule for the account that simply has no window running:
  // the probe read the answer correctly and the answer was "nothing".
  it.each([
    { state: 'unconfigured' } as const,
    { state: 'pending' } as const,
    { state: 'ok', windows: 2, at: NOW } as const,
    { state: 'idle', at: NOW } as const,
    {
      state: 'no-credential',
      everWorked: false,
      at: NOW,
      since: NOW - USAGE_PROBE_STALL_MS * 100,
    } as const,
  ])('stays quiet about a $state probe', (codexUsage) => {
    expect(
      attentionSignals({ secretStatus: 'unlocked', updater: healthy, codexUsage, now: NOW }),
    ).toEqual([]);
  });

  it('says nothing about a Server that runs no Codex probe at all', () => {
    // The Claude-only deployment. `codexUsage` is simply absent, and the healthy
    // payload has to stay byte-identical to what it was before this existed.
    expect(attentionSignals({ secretStatus: 'unlocked', updater: healthy, now: NOW })).toEqual([]);
  });

  // The opposite case, and the one that hides: a login that WAS answering and
  // stopped. The meter froze at that instant and keeps rendering the frozen value.
  it('flags a Codex sign-in that used to work and no longer resolves', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: {
        state: 'no-credential',
        everWorked: true,
        at: NOW,
        since: NOW - USAGE_PROBE_STALL_MS - 1,
      },
      now: NOW,
    });
    expect(signals[0]?.code).toBe('usage_probe_unhealthy');
    expect(signals[0]?.message).toContain('no Codex sign-in');
    // Reported, but WITHOUT the sign-in button. "Found no credential" reads the
    // same whether the login was removed, the secret store is sealed, or the
    // gateway was never configured, and only the first is fixed by signing in.
    // The refusal below is the one state that proves the remedy.
    expect(signals[0]?.action).toBeUndefined();
  });

  // The incident this state exists for: the gateway still answered, and refused
  // the stored Codex login for every call it was asked to make with it. The meter
  // going stale was the visible half; Codex sessions failing every model call was
  // the half nobody could see.
  it('says a refused Codex sign-in stops sessions, not just the meter', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: {
        state: 'sign-in-rejected',
        at: NOW,
        since: NOW - SIGN_IN_REJECTED_STALL_MS - 1,
      },
      now: NOW,
    });
    expect(signals[0]?.code).toBe('usage_probe_unhealthy');
    expect(signals[0]?.action).toBe('codex-login');
    expect(signals[0]?.message).toContain('Codex sessions cannot run');
    // Specifically NOT the stale-meter sentence: that one sends the reader after a
    // display bug while their sessions are the thing that is broken.
    expect(signals[0]?.message).not.toContain('not your account');
  });

  it('gives a refused sign-in less rope than a failure that might pass', () => {
    const refused = {
      at: NOW,
      since: NOW - SIGN_IN_REJECTED_STALL_MS - 1,
    } as const;
    // Long enough for a verdict, far short of the patience every other cause gets.
    expect(NOW - refused.since).toBeLessThan(USAGE_PROBE_STALL_MS);
    expect(
      attentionSignals({
        secretStatus: 'unlocked',
        updater: healthy,
        codexUsage: { state: 'sign-in-rejected', ...refused },
        now: NOW,
      }),
    ).toHaveLength(1);
    // The shorter fuse belongs to the refusal alone. An unreachable endpoint at
    // the same age is still inside its backoff and says nothing.
    expect(
      attentionSignals({
        secretStatus: 'unlocked',
        updater: healthy,
        codexUsage: { state: 'failed', at: NOW, since: refused.since },
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('stays quiet about a refusal younger than its own fuse', () => {
    expect(
      attentionSignals({
        secretStatus: 'unlocked',
        updater: healthy,
        codexUsage: {
          state: 'sign-in-rejected',
          at: NOW,
          since: NOW - SIGN_IN_REJECTED_STALL_MS,
        },
        now: NOW,
      }),
    ).toEqual([]);
  });

  // The fuse says the refusal is old enough to be believed; the freshness cut says
  // the verdict itself is too old to repeat. A refusal keeps the second rule even
  // though it relaxed the first: a probe nobody has run for half an hour is a
  // gateway nobody has asked, and re-asking may well be what fixes it.
  it('stops repeating a refusal nothing has re-checked in half an hour', () => {
    const at = NOW - USAGE_PROBE_STALL_MS - 1;
    expect(
      attentionSignals({
        secretStatus: 'unlocked',
        updater: healthy,
        codexUsage: {
          state: 'sign-in-rejected',
          at,
          // Refusing for well past its own fuse, so only the stale verdict silences it.
          since: at - SIGN_IN_REJECTED_STALL_MS - 1,
        },
        now: NOW,
      }),
    ).toEqual([]);
  });

  // A refusal is only ever raised for a login that exists and cannot be used, so
  // it needs no `everWorked` guard the way `no-credential` does — and crucially,
  // nothing here is process-local. A Server restarted into an already-refusing
  // gateway reports it, which is exactly when someone is looking.
  it('reports a refusal a restarted Server has never seen work', () => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage: {
        state: 'sign-in-rejected',
        at: NOW,
        since: NOW - SIGN_IN_REJECTED_STALL_MS - 1,
      },
      now: NOW,
    });
    expect(signals[0]?.action).toBe('codex-login');
  });

  // The button has to mean something. A 429, a moved response shape or a host that
  // is down would all survive a re-login, so offering one there would send the
  // operator through a sign-in flow that changes nothing.
  it.each([
    { state: 'http-error', status: 429, at: NOW, since: NOW - USAGE_PROBE_STALL_MS - 1 } as const,
    { state: 'failed', at: NOW, since: NOW - USAGE_PROBE_STALL_MS - 1 } as const,
    {
      state: 'unreadable',
      fields: ['usage'],
      windows: 0,
      at: NOW,
      since: NOW - USAGE_PROBE_STALL_MS - 1,
    } as const,
  ])('offers no remedy for a $state probe, which a re-login would not fix', (codexUsage) => {
    const signals = attentionSignals({
      secretStatus: 'unlocked',
      updater: healthy,
      codexUsage,
      now: NOW,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.action).toBeUndefined();
  });

  // Both fuses are read against a verdict the probe itself has to produce, so the
  // probe's own retry ceiling sits between them. Too fast and a refusal can outlive
  // its fuse with no refreshed verdict to prove it — the banner never appears; too
  // slow and every verdict is already stale by the freshness cut, same silence.
  it('leaves the probe room to confirm a refusal within both fuses', () => {
    expect(SIGN_IN_REJECTED_STALL_MS).toBeGreaterThanOrEqual(CODEX_USAGE_MAX_BACKOFF_MS);
    expect(CODEX_USAGE_MAX_BACKOFF_MS).toBeLessThan(USAGE_PROBE_STALL_MS);
  });

  it('ranks the quota probe below the conditions that stop work outright', () => {
    const signals = attentionSignals({
      secretStatus: 'sealed',
      updater: { kind: 'unreachable' },
      codexUsage: { state: 'failed', at: NOW, since: NOW - USAGE_PROBE_STALL_MS - 1 },
      now: NOW,
    });
    // A stale meter is the least of three: the other two stop work outright, this
    // one misinforms about work that still runs. The client renders the first and
    // counts the rest, so this order is what decides which line an operator gets.
    expect(signals.map((signal) => signal.code)).toEqual([
      'secret_sealed',
      'updater_unhealthy',
      'usage_probe_unhealthy',
    ]);
  });

  // And the ranking is what decides whether the remedy is offered at all: the
  // client renders the first signal only, so a refusal behind a sealed store keeps
  // its action and loses its button. That is the right way round — the store the
  // login would be written into is the thing that is shut.
  it('leaves the sign-in remedy behind a condition that outranks it', () => {
    const signals = attentionSignals({
      secretStatus: 'sealed',
      updater: healthy,
      codexUsage: {
        state: 'sign-in-rejected',
        at: NOW,
        since: NOW - SIGN_IN_REJECTED_STALL_MS - 1,
      },
      now: NOW,
    });
    expect(signals[0]?.code).toBe('secret_sealed');
    expect(signals[0]?.action).toBeUndefined();
    // Still carried, so the sentence behind it is the same one it always was.
    expect(signals[1]?.action).toBe('codex-login');
  });
});

describe('sessionAttentionSignals', () => {
  const disconnected = new Set(['project-a']);

  it('says nothing about a session whose sandbox is current', () => {
    expect(
      sessionAttentionSignals({
        projectId: 'project-b',
        disconnectedSandboxProjects: disconnected,
      }),
    ).toEqual([]);
  });

  it('says nothing about a session with no project', () => {
    // A project-less session (the Concierge) runs no sandbox, so it has no
    // sandbox of its own to lose a connection from.
    expect(
      sessionAttentionSignals({ projectId: null, disconnectedSandboxProjects: disconnected }),
    ).toEqual([]);
    expect(
      sessionAttentionSignals({ projectId: undefined, disconnectedSandboxProjects: disconnected }),
    ).toEqual([]);
  });

  it('reports a session whose sandbox is cut off from the broker', () => {
    expect(
      sessionAttentionSignals({
        projectId: 'project-a',
        disconnectedSandboxProjects: disconnected,
      }),
    ).toEqual([{ code: 'sandbox_disconnected', message: SANDBOX_DISCONNECTED_MESSAGE }]);
  });

  it('says nothing when the server classifies no sandbox as cut off', () => {
    expect(
      sessionAttentionSignals({ projectId: 'project-a', disconnectedSandboxProjects: new Set() }),
    ).toEqual([]);
  });
});
