import {
  AUTONOMY_RESUME_SYSTEM_PROMPT,
  AUTOMATION_SYSTEM_PROMPT,
  BREVITY_SYSTEM_PROMPT,
  PLANNING_SYSTEM_PROMPT,
  TASKS_RESUME_SYSTEM_PROMPT,
  PROJECT_REPOSITORIES_SYSTEM_PROMPT,
  SANDBOX_RESOURCES_SYSTEM_PROMPT,
  TERMINOLOGY_SYSTEM_PROMPT,
  VISIBLE_MEDIA_SYSTEM_PROMPT,
  type AgentEvent,
  type BrokeredGrantChannel,
} from '@verity/events';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conductor, SessionBusyError } from './conductor.js';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';
import { type Backend } from './backend.js';
import { SessionWriter } from './ingest.js';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import type { RunnerClient } from './runner-contract.js';

let ctx: TestDb;

// Isolated (in-process pglite), not the shared PostgreSQL harness: the recovery
// tests advance fake timers over store-backed work, and advanceTimersByTimeAsync
// only flushes microtasks — a networked database needs real event-loop turns for
// its socket, so the assertion can run before the query returns. See
// packages/store/src/testing.ts; enforced by scripts/test-db-harness.test.ts.
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
} as const;

/**
 * The compact directive set a resumed turn carries, enumerated rather than
 * imported: the conductor consumes `RESUME_SYSTEM_PROMPT`, and
 * restating its membership here is the point — a fragment joining or leaving the
 * set has to be a two-file change, not a silent one.
 */
const RESUME_SET = [
  TERMINOLOGY_SYSTEM_PROMPT,
  AUTONOMY_RESUME_SYSTEM_PROMPT,
  PLANNING_SYSTEM_PROMPT,
  TASKS_RESUME_SYSTEM_PROMPT,
  PROJECT_REPOSITORIES_SYSTEM_PROMPT,
  VISIBLE_MEDIA_SYSTEM_PROMPT,
  SANDBOX_RESOURCES_SYSTEM_PROMPT,
  AUTOMATION_SYSTEM_PROMPT,
  BREVITY_SYSTEM_PROMPT,
];

/**
 * Ceiling for the assembled set, which includes the automation contract for existing sessions
 * alongside the compact autonomy convergence fragment. A tripwire on the whole re-sent payload rather
 * than a target: the cost here is per operator message, not per context, so growth that
 * is cheap in a fresh turn is not cheap in this one. Membership is checked
 * exactly by {@link expectResumeSet}; this is the only instrument that notices
 * the members themselves growing — including the two this feature does not own,
 * which is deliberate: what is charged per message is the assembled payload, not
 * whichever fragment last grew. Kept above the sandbox fragment's own ceiling
 * (3100, in sandbox-resources.test.ts) so that growth *that* ceiling still
 * permits cannot fail here instead, where the message would name the wrong
 * thing. The repository-discovery directive adds 1466 characters so existing
 * sessions learn the managed module workflow too. The assembled payload is now
 * about 9300 characters; keep a small explicit allowance for separators and wording.
 */
const RESUME_SET_BUDGET = 9500;

/**
 * Asserts that `appended` is exactly {@link RESUME_SET} — every member present
 * once, and nothing else but the separators between them.
 *
 * Membership and exclusivity rather than string equality: equality would also pin
 * the order the conductor happens to interpolate them in, so a semantically
 * neutral reorder would fail with a 3.4 KB string diff naming nothing. What has
 * to hold is that a resumed turn carries exactly this compact convergence set.
 */
function expectResumeSet(appended: string | undefined): void {
  let residue = appended ?? '';
  for (const fragment of RESUME_SET) {
    // `split` rather than `toContain`, so a template that interpolated a fragment
    // twice fails here instead of passing.
    expect(residue.split(fragment)).toHaveLength(2);
    residue = residue.replace(fragment, '');
  }
  expect(residue.trim()).toBe('');
  expect(
    (appended ?? '').length,
    `the resumed-turn prompt exceeds RESUME_SET_BUDGET (${String(RESUME_SET_BUDGET)}); it is ` +
      're-sent on every operator message, so growing any of its fragments is not free',
  ).toBeLessThan(RESUME_SET_BUDGET);
}

/** The live window of a scripted turn, handed to {@link TurnScript.during}. */
interface ScriptedTurn {
  /** The turn's options, exactly as the Conductor built them. */
  readonly opts: RunTurnOptions;
  /** Persist one canonical event through the run's own writer. */
  write: (event: AgentEvent) => Promise<void>;
  /** Persist a chunk of assistant prose. */
  text: (delta: string) => Promise<void>;
  /** Raise a mid-turn permission prompt the way a real backend does (#27): record
   *  it in the transcript, surface it to the Conductor, and park the turn until the
   *  decision comes back (or the turn is aborted, which fails it safe to deny). */
  permission: (request: PermissionRequest) => Promise<PermissionDecision>;
}

/**
 * What one scripted run does between binding a session and settling.
 *
 * These tests used to drive a fake `claude` process and read the Conductor's
 * decisions back off the argv the native runner built from them. That runner went
 * with the native transport (ADR 0012) — and the seam it stood in for was always
 * one level up: what the Conductor owns is the {@link RunTurnOptions} it hands a
 * backend and the events that backend persists. Each transport's own translation
 * of those options is covered by that backend's tests.
 */
interface TurnScript {
  /** Backend session id this run binds; defaults to the Verity session id it was
   *  asked to persist under. `null` binds nothing — the run that dies before the
   *  agent protocol ever names a session. */
  sessionId?: string | null;
  /** Model recorded on the `session` event; defaults to the turn's own. */
  model?: string;
  /** Prose persisted right after the bind. Omit for a turn that says nothing. */
  text?: string;
  /** Persist no terminal `result` — a run that ends mid-turn. */
  omitResult?: boolean;
  /** Stay in flight until the operator's cancel signal fires, then settle the way
   *  a killed agent does: no terminal `result`, `aborted`, 128 + SIGTERM. */
  abortable?: boolean;
  exitCode?: number;
  stderr?: string;
  failedBeforeExecution?: true;
  /** Transport {@link ScriptedTurn.permission} stamps on the prompts it raises
   *  (ADR 0014 D3). Defaults to the restricted `acp` channel; a script standing in
   *  for a backend that declares a native `runnerSupervisorBackend` must say so,
   *  or the persisted card and the channel the grant redeems on disagree. */
  grantChannel?: BrokeredGrantChannel;
  /** The live window: runs after the bind (and after {@link text}), before the
   *  turn settles. */
  during?: (turn: ScriptedTurn) => void | Promise<void>;
}

/**
 * Run one scripted turn through {@link SessionWriter} — the same writer every real
 * backend persists through, so session binding, the store-session-id remap, the
 * pre-init buffer, and persist-before-publish stay real rather than simulated.
 */
async function runScript(opts: RunTurnOptions, script: TurnScript): Promise<RunResult> {
  const writer = new SessionWriter(
    opts.store,
    {
      ...(opts.bus !== undefined ? { bus: opts.bus } : {}),
      ...(opts.onSession !== undefined ? { onSession: opts.onSession } : {}),
    },
    opts.storeSessionId,
  );
  const turn: ScriptedTurn = {
    opts,
    write: (event) => writer.write(event),
    text: (delta) => writer.write({ t: 'text', delta }),
    permission: async (request) => {
      // Grant channel is the CALLER's transport (ADR 0014 D3) — the script's, since
      // it is the one standing in for a backend here.
      await writer.writePermission(request, script.grantChannel ?? 'acp');
      const denied: PermissionDecision = { behavior: 'deny', message: 'turn ended' };
      if (opts.onPermissionRequest === undefined) return denied;
      return new Promise<PermissionDecision>((resolve) => {
        opts.onPermissionRequest?.(request, resolve);
        opts.signal?.addEventListener('abort', () => resolve(denied), { once: true });
      });
    },
  };
  if (script.sessionId !== null) {
    await writer.write({
      t: 'session',
      id: script.sessionId ?? opts.resumeSessionId ?? opts.storeSessionId ?? 's1',
      model: script.model ?? opts.model ?? 'm',
      worktree: opts.worktree,
    });
  }
  if (script.text !== undefined) await turn.text(script.text);
  await script.during?.(turn);
  if (script.abortable === true) {
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted === true) resolve();
      else opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    await writer.finish();
    return { sessionId: writer.currentSessionId, exitCode: 143, stderr: '', aborted: true };
  }
  if (script.omitResult !== true) {
    await writer.write({ t: 'result', usage: ZERO_USAGE, stopReason: 'end_turn' });
  }
  await writer.finish();
  return {
    sessionId: writer.currentSessionId,
    exitCode: script.exitCode ?? 0,
    stderr: script.stderr ?? '',
    aborted: false,
    ...(script.failedBeforeExecution !== undefined ? { failedBeforeExecution: true } : {}),
  };
}

/** A backend that runs {@link runScript} for every turn and records the options it
 *  was handed. `script` may be a function to vary per attempt. */
function scriptedBackend(
  script: TurnScript | ((opts: RunTurnOptions, attempt: number) => TurnScript) = {},
): { backend: Backend; calls: RunTurnOptions[]; last: () => RunTurnOptions } {
  const calls: RunTurnOptions[] = [];
  const backend: Backend = {
    run: (opts) => {
      calls.push(opts);
      return runScript(opts, typeof script === 'function' ? script(opts, calls.length) : script);
    },
  };
  return {
    backend,
    calls,
    last: () => {
      const options = calls.at(-1);
      if (options === undefined) throw new Error('backend was never run');
      return options;
    },
  };
}

/** A backend whose turn binds its session and then stays in flight until `gate`
 *  resolves, so a test can assert acceptance/serialization while a turn is
 *  genuinely running. */
function gatedBackend(
  gate: Promise<void>,
  script: TurnScript = {},
): ReturnType<typeof scriptedBackend> {
  return scriptedBackend({
    ...script,
    during: async (turn) => {
      await script.during?.(turn);
      await gate;
    },
  });
}

/**
 * A backend that registers the live turn's steering channel (#101) and then holds
 * the turn open until the test releases it — the seam the Conductor folds a mid-turn
 * message through. `registersChannel: false` models a turn that never surfaces an
 * injector (not steerable, or it ended in the race), which must fall back to the
 * #90 queue.
 */
function steerableBackend(registersChannel = true): {
  backend: Backend;
  steered: SteerMessage[];
  ready: () => boolean;
  release: () => void;
  last: () => RunTurnOptions;
} {
  const steered: SteerMessage[] = [];
  let ready = false;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = scriptedBackend({
    during: async (turn) => {
      if (registersChannel) {
        turn.opts.onSteer?.((message) => {
          steered.push(message);
          return true;
        });
      }
      ready = true; // run is live → the steering channel is registered
      await gate; // hold the turn in flight so we can steer it
    },
  });
  return { backend: fake.backend, steered, ready: () => ready, release, last: fake.last };
}

/**
 * A backend whose turns bind their session and then park until released — one
 * resolver per turn, in start order, so a test can hold several turns in flight
 * and free them one at a time.
 */
function releasableBackend(): {
  backend: Backend;
  releases: Array<() => void>;
  calls: RunTurnOptions[];
} {
  const releases: Array<() => void> = [];
  const fake = scriptedBackend({
    during: () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  });
  return { backend: fake.backend, releases, calls: fake.calls };
}

/** A backend that must never be reached: every pre-flight rejection test asserts
 *  the Conductor refused the turn before it got this far. */
function unreachableBackend(): { backend: Backend; ran: () => boolean } {
  let ran = false;
  return {
    backend: {
      run: () => {
        ran = true;
        return Promise.reject(new Error('backend must not run'));
      },
    },
    ran: () => ran,
  };
}

// The `.jsonl` restore-before-resume / tail-only-new-lines behaviour lived in the
// retired native runner. It now belongs to the Runner's transcript sink and is
// covered there (packages/server/src/runner-transcript.test.ts); the Conductor only
// forwards `transcript`/`claudeHome` into the turn options.

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error('waitFor: condition not met in time');
}

describe('Conductor session deletion admission', () => {
  it('invalidates earlier terminal evidence before a retry launches an uncertain worker', async () => {
    await ctx.store.createSession({
      sessionId: 'retry-proof',
      worktree: '/wt/retry-proof',
      model: 'm',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 'retry-proof',
      backend: 'claude',
      backendSessionId: 'old-thread',
      contextSeq: 0,
    });
    let attempts = 0;
    const startTurn = vi.fn(() => ({
      result:
        ++attempts === 1
          ? Promise.resolve({
              sessionId: undefined,
              exitCode: 1,
              stderr: '',
              staleResume: true as const,
              aborted: false,
            })
          : Promise.reject(new Error('transport dropped')),
      steer: async () => false,
      answerPermission: async () => false,
      cancel: async () => false,
    }));
    const conductor = new Conductor({
      store: ctx.store,
      backend: { run: () => Promise.reject(new Error('unexpected loopback')) },
      runner: () => ({ startTurn }),
      worktreeExists: async () => true,
    });
    await expect(conductor.sendTurn('retry-proof', 'work')).rejects.toThrow('transport dropped');
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(await conductor.stopForDeletion('retry-proof', 20)).toBe(false);
    const restarted = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    expect(await restarted.stopForDeletion('retry-proof', 20)).toBe(false);
  });

  it.each(['send', 'dispatch'] as const)(
    'preserves terminal evidence after %s host publication fails',
    async (mode) => {
      await ctx.store.createSession({
        sessionId: 'postprocess',
        worktree: '/wt/postprocess',
        model: 'm',
      });
      const fake = scriptedBackend({ sessionId: 'postprocess', text: 'done' });
      const settleWorkspace = vi.fn(async () => {
        throw new Error('publication failed');
      });
      const conductor = new Conductor({
        store: ctx.store,
        backend: fake.backend,
        worktreeExists: async () => true,
        settleWorkspace,
      });
      if (mode === 'send')
        await expect(conductor.sendTurn('postprocess', 'work')).rejects.toThrow(
          'publication failed',
        );
      else {
        await conductor.dispatchTurn('postprocess', 'work');
        await vi.waitFor(() => expect(conductor.isBusy('postprocess')).toBe(false));
      }
      expect(settleWorkspace).toHaveBeenCalledOnce();
      expect(await conductor.stopForDeletion('postprocess', 20)).toBe(true);
    },
  );

  it.each([false, true])(
    'does not retain phantom termination uncertainty after prelaunch failure (retry=%s)',
    async (retry) => {
      await ctx.store.createSession({
        sessionId: 'prelaunch',
        worktree: '/wt/prelaunch',
        model: 'm',
      });
      const fake = scriptedBackend({ sessionId: 'prelaunch', model: 'm', text: 'done' });
      const sessionBackend = vi
        .fn(async () => fake.backend)
        .mockRejectedValueOnce(new Error('preparation failed'));
      const conductor = new Conductor({
        store: ctx.store,
        backend: fake.backend,
        worktreeExists: async () => true,
        sessionBackend,
      });
      await expect(conductor.sendTurn('prelaunch', 'first')).rejects.toThrow('preparation failed');
      if (retry) await conductor.sendTurn('prelaunch', 'retry');
      expect(await conductor.stopForDeletion('prelaunch', 20)).toBe(true);
    },
  );

  it('bounds deletion behind stalled maintenance and refuses queued handoffs permanently', async () => {
    await ctx.store.createSession({ sessionId: 's-delete', worktree: '/wt/delete', model: 'm' });
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    let release!: () => void;
    let entered = false;
    const first = conductor.runBackendHandoff('s-delete', async () => {
      entered = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await waitFor(() => entered);
    const replacement = vi.fn(async () => undefined);
    const queued = conductor.runBackendHandoff('s-delete', replacement);
    const refused = expect(queued).rejects.toBeInstanceOf(SessionBusyError);

    expect(await conductor.stopForDeletion('s-delete', 20)).toBe(false);
    expect(conductor.isBusy('s-delete')).toBe(true);
    expect(conductor.isDeletionWorktreeBusy('s-delete')).toBe(true);
    await expect(conductor.dispatchTurn('s-delete', 'late prompt')).rejects.toBeInstanceOf(
      SessionBusyError,
    );
    release();
    await first;
    await refused;
    expect(conductor.isDeletionWorktreeBusy('s-delete')).toBe(false);
    expect(replacement).not.toHaveBeenCalled();
    expect(await conductor.stopForDeletion('s-delete', 20)).toBe(true);
    expect(conductor.isSessionDeleting('s-delete')).toBe(true);
    await expect(conductor.dispatchTurn('s-delete', 'after cleanup')).rejects.toBeInstanceOf(
      SessionBusyError,
    );
  });

  it('does not treat an abandoned durable marker or failed inspection as proof of termination', async () => {
    await ctx.store.createSession({ sessionId: 's-delete', worktree: '/wt/delete', model: 'm' });
    const { seq } = await ctx.store.appendEvent('s-delete', {
      t: 'prompt',
      text: 'running elsewhere',
    });
    await ctx.store.markTurnRunning({ sessionId: 's-delete', promptSeq: seq });
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    expect(await conductor.stopForDeletion('s-delete', 20)).toBe(false);
    expect(await ctx.store.listRunningTurns()).toHaveLength(1);
    const inspect = vi
      .spyOn(ctx.store, 'listRunningTurns')
      .mockRejectedValueOnce(new Error('unavailable'));
    expect(await conductor.stopForDeletion('s-delete', 20)).toBe(false);
    inspect.mockRestore();
  });

  it('rejects a turn whose workspace preparation finishes after deletion begins', async () => {
    await ctx.store.createSession({ sessionId: 's-delete', worktree: '/wt/delete', model: 'm' });
    let release!: () => void;
    let entered = false;
    const backend = { run: vi.fn(() => Promise.reject(new Error('must not run'))) };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      ensureWorkspace: async () => {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const dispatch = conductor.dispatchTurn('s-delete', 'old prompt');
    const refused = expect(dispatch).rejects.toBeInstanceOf(SessionBusyError);
    await waitFor(() => entered);
    conductor.beginSessionDeletion('s-delete');
    expect(conductor.isDeletionWorktreeBusy('s-delete')).toBe(true);
    release();
    await refused;
    expect(conductor.isDeletionWorktreeBusy('s-delete')).toBe(false);
    expect(backend.run).not.toHaveBeenCalled();
    expect(conductor.isBusy('s-delete')).toBe(false);
  });

  it('bounds an unacknowledged worker stop and suppresses a late backend binding', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's-delete', worktree: '/wt/delete', model: 'm' });
      let settle!: (result: RunResult) => void;
      let bind: ((id: string) => void | Promise<void>) | undefined;
      const runner: RunnerClient = {
        startTurn: (_opts, hooks) => {
          bind = hooks.onSession;
          return {
            result: new Promise<RunResult>((resolve) => {
              settle = resolve;
            }),
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined),
            forceCancel: () => new Promise<boolean>(() => undefined),
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run: () => Promise.reject(new Error('unexpected loopback')) },
        worktreeExists: async () => true,
        runner: () => runner,
      });
      await conductor.dispatchTurn('s-delete', 'go');
      await vi.waitFor(() => expect(bind).toBeDefined());
      const persist = vi.spyOn(ctx.store, 'upsertSessionBackendState');
      const stopping = conductor.stopForDeletion('s-delete', 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await stopping).toBe(false);
      expect(conductor.isBusy('s-delete')).toBe(true);
      expect(conductor.isDeletionTerminationConfirmed('s-delete')).toBe(false);
      await ctx.store.deleteSession('s-delete');
      await bind!('late-backend-id');
      expect(persist).not.toHaveBeenCalled();
      settle({ sessionId: 's-delete', exitCode: 143, stderr: '', aborted: true });
      await vi.waitFor(() => expect(conductor.isBusy('s-delete')).toBe(false));
      await vi.waitFor(() =>
        expect(conductor.isDeletionTerminationConfirmed('s-delete')).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      persist.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
