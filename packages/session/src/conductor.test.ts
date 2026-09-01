import {
  AUTONOMY_RESUME_SYSTEM_PROMPT,
  AUTONOMY_SYSTEM_PROMPT,
  AGENT_LOOP_PROPOSAL_SYSTEM_PROMPT,
  CHOICES_SYSTEM_PROMPT,
  CODE_REVIEW_SYSTEM_PROMPT,
  DELEGATION_SYSTEM_PROMPT,
  LANGUAGE_SYSTEM_PROMPT,
  LOCAL_PROJECT_SYSTEM_PROMPT,
  MEMORY_SYSTEM_PROMPT,
  PULL_REQUEST_SYSTEM_PROMPT,
  REPO_CONVENTIONS_SYSTEM_PROMPT,
  SANDBOX_RESOURCES_SYSTEM_PROMPT,
  TERMINOLOGY_SYSTEM_PROMPT,
  VISIBLE_MEDIA_SYSTEM_PROMPT,
  type AgentEvent,
  type BrokeredGrantChannel,
} from '@verity/events';
import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  TranscriptStore,
  type RunningTurnRecord,
} from '@verity/store';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from './bus.js';
import {
  BackendTerminationUnconfirmedError,
  Conductor,
  PermissionDecisionInProgressError,
  brokeredGrantTarget,
  formatBrokeredSecretAliases,
  QueueFullError,
  SessionBusyError,
  UnknownSessionError,
  WorktreeMissingError,
} from './conductor.js';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';
import {
  brokeredGrantChannel,
  type Backend,
  type QueryInput,
  type RunnerSupervisorBackend,
} from './backend.js';
import { NoSessionInitError, SessionWriter } from './ingest.js';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import type {
  RunnerAttachTarget,
  RunnerClient,
  RunnerClientContext,
  RunnerRecovery,
  RunnerRecoveryOutcome,
  RunnerTurn,
} from './runner-contract.js';

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
 * imported: `RESUME_SYSTEM_PROMPT` is module-private to the conductor, and
 * restating its membership here is the point — a fragment joining or leaving the
 * set has to be a two-file change, not a silent one.
 */
const RESUME_SET = [
  TERMINOLOGY_SYSTEM_PROMPT,
  AUTONOMY_RESUME_SYSTEM_PROMPT,
  VISIBLE_MEDIA_SYSTEM_PROMPT,
  SANDBOX_RESOURCES_SYSTEM_PROMPT,
];

/**
 * Ceiling for the assembled set, which remains under 4.2 KB with the compact
 * autonomy convergence fragment. A tripwire on the whole re-sent payload rather
 * than a target: the cost here is per operator message, not per context, so growth that
 * is cheap in a fresh turn is not cheap in this one. Membership is checked
 * exactly by {@link expectResumeSet}; this is the only instrument that notices
 * the members themselves growing — including the two this feature does not own,
 * which is deliberate: what is charged per message is the assembled payload, not
 * whichever fragment last grew. Kept above the sandbox fragment's own ceiling
 * (3100, in sandbox-resources.test.ts) so that growth *that* ceiling still
 * permits cannot fail here instead, where the message would name the wrong
 * thing. That ordering is conditional, not structural: it holds while the other
 * members sum to under 5000 - 3100 = 1900 characters. If they grow past that,
 * this budget fires first on sandbox-fragment growth — annoying, not wrong, and
 * the fix is to raise this one after reading what actually grew, not to derive
 * either number from the other.
 */
const RESUME_SET_BUDGET = 5000;

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

describe('formatBrokeredSecretAliases', () => {
  it('caps large alias lists and reports omitted names', () => {
    const aliases = Array.from({ length: 10_000 }, (_, index) => `SECRET_${index}`);
    const prompt = formatBrokeredSecretAliases(aliases);

    expect(prompt).toContain('SECRET_0');
    expect(prompt).toContain('(9900 more omitted)');
    expect(prompt).not.toContain('SECRET_100,');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(10 * 1024);
  });

  // The list exists so the agent stops guessing names, not to cap how many it
  // may use: a trusted CLI run carries several, and reading the rule as "one
  // alias per call" is what pushes agents back to packing several credentials
  // into a single Doppler value.
  it('restricts which names may be used without restricting how many', () => {
    const prompt = formatBrokeredSecretAliases(['ASC_KEY_ID', 'ASC_ISSUER_ID']);
    expect(prompt).toContain('more than one');
    expect(prompt).not.toContain('exactly one');
  });

  // A project with no secrets configured must contribute nothing at all — not a
  // degenerate "Secret names available in this project: ." naming none of them. This
  // now reaches every transport rather than the native relay alone, so the empty case
  // ships far more widely than it used to.
  it.each([[[]], [undefined]])('contributes nothing for %j', (aliases) => {
    expect(formatBrokeredSecretAliases(aliases)).toBe('');
  });
});

describe('Conductor.sendTurn', () => {
  it('resumes an existing session and persists the turn events', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'keep going');

    expect(result).toMatchObject({ sessionId: 's1', exitCode: 0 });
    // Resumes the session, defaults the model to the stored one, and asks for a
    // steerable turn (#101). `permissionMode` stays absent here on purpose: the
    // Conductor forwards only what it was configured with, and the fleet-safe
    // `auto` default is the backend's (`acp-claude-backend.ts`).
    expect(fake.last()).toMatchObject({
      resumeSessionId: 's1',
      storeSessionId: 's1',
      model: 'm',
      prompt: 'keep going',
      steerable: true,
    });
    expect(fake.last().permissionMode).toBeUndefined();
    expect(fake.last().appendSystemPrompt).toContain(TERMINOLOGY_SYSTEM_PROMPT);
    expect(fake.last().appendSystemPrompt).toContain(VISIBLE_MEDIA_SYSTEM_PROMPT);
    expect(fake.last().env).toMatchObject({
      VERITY_SESSION_BACKEND: 'claude',
      VERITY_SESSION_MODEL: 'm',
    });
    // the agent runs IN the session's worktree (cwd == worktree).
    expect(fake.last().cwd).toBe('/wt/s1');
    expect(fake.last().worktree).toBe('/wt/s1');
    // The operator's prompt is persisted FIRST (so it precedes the agent's output
    // in the transcript), then the agent's session/text/result.
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).toEqual([
      'session',
      'prompt',
      'session',
      'text',
      'result',
    ]);
    expect(conductor.isBusy('s1')).toBe(false);
  });

  it('sends compact convergence directives on resumed turns', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'go');

    expect(fake.last().resumeSessionId).toBe('s1');
    // Membership is checked exhaustively below; only the exclusion needs its own
    // line, since `expectResumeSet` says what is in the set, not what was kept out
    // of it on purpose.
    expect(fake.last().appendSystemPrompt).not.toContain(CHOICES_SYSTEM_PROMPT);
    // The sandbox rule joins this set — the OOM killer picks the largest process
    // in the cgroup, so the turn that overcommits is not reliably the one that
    // dies, and a neighbouring session's test run is just as likely. That is why
    // it converges on resumed turns while the rest of the heavy policy does not.
    // Asserted by the exhaustive check below rather than a `toContain` of its own.
    // This set is charged on every operator message for the life of the session,
    // unlike the turn prompt, which is paid once per context — so what it carries
    // is checked exactly, not sampled: a `toContain` per fragment cannot see a
    // fourth one joining, which is the growth that costs here. It also pins the
    // composition claim the turn prompt does not share: the resume branch returns
    // this set verbatim while only the fresh-turn branch composes on kind.
    expectResumeSet(fake.last().appendSystemPrompt);
  });

  it('sends the same resume set for an unattended Agent Loop session', async () => {
    // The kind-independence above is the load-bearing half of that assertion and
    // was the half nothing exercised: the fresh-turn branch demonstrably composes
    // on kind, so "the resume branch does not" is a claim, not a given. The kind
    // to pin it with is this one — an Agent Loop resumes on a schedule with nobody
    // watching, which is the case the sandbox rule is justified by.
    await ctx.store.createSession({
      sessionId: 'loop-resume',
      worktree: '/wt/loop',
      model: 'm',
      kind: 'agent_loop',
    });
    // The `session` event is what marks the session Claude-origin, via its
    // `model`; its `id` is not a backend session id — that only exists once
    // `upsertSessionBackendState` has run, which nothing here does. So the resume
    // handle is the STORE key, and the id here is deliberately unlike it so the
    // assertion below cannot pass while reading the wrong one.
    await ctx.store.appendEvent('loop-resume', {
      t: 'session',
      id: 'claude-loop-1',
      model: 'm',
      worktree: '/wt/loop',
    });
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('loop-resume', 'go');

    expect(fake.last().resumeSessionId).toBe('loop-resume');
    expectResumeSet(fake.last().appendSystemPrompt);
    expect(fake.last().appendSystemPrompt).not.toContain(AGENT_LOOP_PROPOSAL_SYSTEM_PROMPT);
  });

  it('starts the first turn of an empty precreated session without resuming a backend id', async () => {
    await ctx.store.createSession({ sessionId: 's-empty', worktree: '/wt/empty', model: 'm' });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        await opts.onSession?.('backend-empty');
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-empty', 'start');

    expect(captured?.storeSessionId).toBe('s-empty');
    expect(captured?.resumeSessionId).toBeUndefined();
    expect(captured?.appendSystemPrompt).toContain(CHOICES_SYSTEM_PROMPT);
    expect(captured?.appendSystemPrompt).toContain(AUTONOMY_SYSTEM_PROMPT);
    expect(captured?.appendSystemPrompt).not.toContain(AGENT_LOOP_PROPOSAL_SYSTEM_PROMPT);
    expect(captured?.appendSystemPrompt).toContain(MEMORY_SYSTEM_PROMPT);
    expect(captured?.appendSystemPrompt).toContain(VISIBLE_MEDIA_SYSTEM_PROMPT);
    expect(await ctx.store.getSessionBackendState('s-empty', 'claude')).toMatchObject({
      backendSessionId: 'backend-empty',
    });
  });

  it('passes opts.transcript to the runner by default (flag-off, unchanged)', async () => {
    await ctx.store.createSession({ sessionId: 's-tx-off', worktree: '/wt/tx', model: 'm' });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        await opts.onSession?.('backend-tx-off');
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const transcript = new TranscriptStore(ctx.db);
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      transcript,
    });

    await conductor.sendTurn('s-tx-off', 'start');

    expect(captured?.transcript).toBe(transcript);
  });

  it('omits opts.transcript when the server manages persistence (flag-on)', async () => {
    await ctx.store.createSession({ sessionId: 's-tx-on', worktree: '/wt/tx', model: 'm' });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        await opts.onSession?.('backend-tx-on');
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      transcript: new TranscriptStore(ctx.db),
      serverManagedTranscript: true,
    });

    await conductor.sendTurn('s-tx-on', 'start');

    expect(captured?.transcript).toBeUndefined();
  });

  it('adds Agent Loop proposal guidance only to Agent Loop sessions', async () => {
    await ctx.store.createSession({
      sessionId: 'loop-session',
      worktree: '/wt/loop',
      model: 'm',
      kind: 'agent_loop',
    });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        await opts.onSession?.('backend-loop');
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('loop-session', 'configure');

    expect(captured?.appendSystemPrompt).toContain(AGENT_LOOP_PROPOSAL_SYSTEM_PROMPT);
    // The kind-specific branch adds to the base rather than replacing it, and an
    // Agent Loop runs turns unattended — exactly the kind that can spend a
    // container's memory with nobody watching. This is also the only path that
    // composes prompts, so it is where a duplicate would appear first.
    expect(captured?.appendSystemPrompt).toContain(SANDBOX_RESOURCES_SYSTEM_PROMPT);
    expect(
      (captured?.appendSystemPrompt ?? '').split(SANDBOX_RESOURCES_SYSTEM_PROMPT),
    ).toHaveLength(2);
  });

  it('settles a silent non-zero exit with a synthetic crashed marker (P0a)', async () => {
    await ctx.store.createSession({ sessionId: 's-crash', worktree: '/wt/x', model: 'm' });
    // Exits non-zero WITHOUT emitting any terminal event (e.g. codex crashing
    // before thread.started) — the case that used to hang the session `running`.
    const backend: Backend = {
      run: async (opts) => ({
        sessionId: opts.storeSessionId,
        exitCode: 1,
        stderr: 'boom',
        aborted: false,
      }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-crash', 'go');

    const terminal = (await ctx.store.getEvents('s-crash')).filter(
      (e) => e.t === 'error' || e.t === 'result' || e.t === 'interrupted',
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ t: 'error', kind: 'crashed' });
  });

  it('settles a SIGTERM exit without a terminal event as interrupted, not crashed', async () => {
    await ctx.store.createSession({ sessionId: 's-term', worktree: '/wt/x', model: 'm' });
    const backend: Backend = {
      run: async (opts) => ({
        sessionId: opts.storeSessionId,
        exitCode: 143,
        stderr: 'Terminated',
        aborted: false,
      }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-term', 'go');

    const terminal = (await ctx.store.getEvents('s-term')).filter(
      (e) => e.t === 'error' || e.t === 'result' || e.t === 'interrupted',
    );
    expect(terminal).toEqual([{ t: 'interrupted' }]);
  });

  it('does NOT double-mark when the backend already reported its own crash (P0a)', async () => {
    await ctx.store.createSession({ sessionId: 's-own', worktree: '/wt/x', model: 'm' });
    const backend: Backend = {
      run: async () => {
        // Backend writes its own terminal error (e.g. claude synthesizing crashed).
        await ctx.store.appendEvent('s-own', {
          t: 'error',
          kind: 'run_failed',
          message: 'backend said so',
        });
        return { sessionId: 's-own', exitCode: 1, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-own', 'go');

    const errors = (await ctx.store.getEvents('s-own')).filter((e) => e.t === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'run_failed' });
  });

  it('marks in-flight turns interrupted on shutdown drain (P0b)', async () => {
    await ctx.store.createSession({ sessionId: 's-drain', worktree: '/wt/x', model: 'm' });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const backend: Backend = {
      run: async () => {
        await gate; // hang so the turn stays in flight while we drain
        return { sessionId: 's-drain', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    // Background dispatch: accepted immediately, the run hangs → turn in flight.
    const { accepted } = await conductor.dispatchTurnWhenIdle('s-drain', 'go');
    expect(accepted).toBe(true);
    expect(conductor.isBusy('s-drain')).toBe(true);

    await conductor.drainOnShutdown();

    expect((await ctx.store.getEvents('s-drain')).some((e) => e.t === 'interrupted')).toBe(true);

    release(); // let the hung run settle so nothing leaks
    await vi.waitFor(() => expect(conductor.isBusy('s-drain')).toBe(false));
  });

  it('leaves reattachable supervisor turns open on shutdown drain', async () => {
    await ctx.store.createSession({ sessionId: 's-reattach-drain', worktree: '/wt/x', model: 'm' });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const backend: Backend = {
      run: async () => {
        await gate; // hang so the turn stays in flight while we drain
        return { sessionId: 's-reattach-drain', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    const { accepted } = await conductor.dispatchTurnWhenIdle('s-reattach-drain', 'go');
    expect(accepted).toBe(true);
    await vi.waitFor(async () => expect(await ctx.store.listRunningTurns()).toHaveLength(1));
    await ctx.store.bindTurnIdentity('s-reattach-drain', {
      turnId: 'turn-survives-shutdown',
      startCommandId: 'start-survives-shutdown',
    });

    await conductor.drainOnShutdown();

    expect((await ctx.store.getEvents('s-reattach-drain')).map((e) => e.t)).not.toContain(
      'interrupted',
    );
    expect(await ctx.store.listRunningTurns()).toHaveLength(1);

    release(); // let the hung run settle so nothing leaks
    await vi.waitFor(() => expect(conductor.isBusy('s-reattach-drain')).toBe(false));
  });

  it('folds a pending note into the next turn’s model prompt but not the chat transcript', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // A deterministic server action (e.g. the post-merge worktree reset) left a note.
    await ctx.store.appendPendingNote('s1', 'PR #7 was merged — worktree reset to main.');
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'what changed?');

    // The operator's instruction leads; the note rides as provenance-labelled JSON.
    const modelPrompt = fake.last().prompt ?? '';
    expect(modelPrompt).toContain('PR #7 was merged');
    expect(modelPrompt).toContain('what changed?');
    expect(modelPrompt.indexOf('what changed?')).toBeLessThan(modelPrompt.indexOf('PR #7'));
    expect(modelPrompt).toContain('External data from Verity pending session notices');

    // But the VISIBLE prompt event is only the operator's text — no chat bubble
    // for the server's note.
    const promptEvent = (await ctx.store.getEvents('s1')).find((e) => e.t === 'prompt');
    expect(promptEvent).toMatchObject({ t: 'prompt', text: 'what changed?' });

    // Consumed once: the note is gone after the turn ran.
    expect(await ctx.store.consumePendingNotes('s1')).toEqual([]);
  });

  it('rejects an unknown session without spawning, releasing the lock', async () => {
    const fake = unreachableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('ghost', 'hi')).rejects.toBeInstanceOf(UnknownSessionError);
    expect(fake.ran()).toBe(false);
    expect(conductor.isBusy('ghost')).toBe(false);
  });

  it('rejects resuming a session whose worktree is gone, without spawning', async () => {
    // A session pointing at a dir that no longer exists (e.g. an isolated worktree
    // cleaned up after its PR merged). No `worktreeExists` stub → the real fs probe
    // runs. Spawning here would crash the host with `spawn ENOENT` (regression: a
    // missing cwd once took down the whole control-plane).
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/gone-abc123', model: 'm' });
    const fake = unreachableBackend();
    const conductor = new Conductor({ store: ctx.store, backend: fake.backend });

    await expect(conductor.sendTurn('s1', 'go')).rejects.toBeInstanceOf(WorktreeMissingError);
    expect(fake.ran()).toBe(false); // pre-flight rejected before any spawn
    expect(conductor.isBusy('s1')).toBe(false); // lock released for a later retry
  });

  it('rejects an empty turn (no prompt and no attachment) without touching the store or spawning', async () => {
    const fake = unreachableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s1', '')).rejects.toThrow(/prompt or an attachment/);
    await expect(conductor.sendTurn('s1', '   \n\t')).rejects.toThrow(/prompt or an attachment/);
    expect(fake.ran()).toBe(false);
  });

  it('sends attachments: persists them on the prompt event and hands them to the backend', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'look at this', {
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
    });

    // The backend receives the bytes inline — how it frames them for its own
    // transport is that backend's business.
    expect(fake.last()).toMatchObject({
      prompt: 'look at this',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
    });
    // The persisted prompt event references the blob by id (NOT inline base64), and
    // the bytes are stored content-addressed for lazy fetch.
    const events = await ctx.store.getEvents('s1');
    const prompt = events.find((e) => e.t === 'prompt');
    expect(prompt).toMatchObject({
      t: 'prompt',
      text: 'look at this',
      attachments: [{ kind: 'image', mediaType: 'image/png', id: expect.any(String) }],
    });
    const ref = prompt?.t === 'prompt' ? prompt.attachments?.[0] : undefined;
    expect(ref && 'data' in ref).toBe(false); // no inline base64 on the event
    const blob = await ctx.store.getAttachment(ref?.id ?? '');
    expect(blob?.bytes.toString('base64')).toBe('aGk='); // bytes recoverable by id
  });

  it('accepts an attachments-only turn with an empty prompt (a bare screenshot)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', '', {
      attachments: [{ kind: 'image', mediaType: 'image/jpeg', data: 'eA==' }],
    });

    // Empty prompt → the backend is handed the attachment and no prompt text.
    expect(fake.last().prompt ?? '').toBe('');
    expect(fake.last().attachments).toEqual([
      { kind: 'image', mediaType: 'image/jpeg', data: 'eA==' },
    ]);
    const prompt = (await ctx.store.getEvents('s1')).find((e) => e.t === 'prompt');
    expect(prompt).toMatchObject({ t: 'prompt', text: '', attachments: [{ kind: 'image' }] });
  });

  it('serializes turns per session: a concurrent turn rejects with SessionBusyError', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend, // hold the first turn in flight until released
      worktreeExists: async () => true,
    });

    const first = conductor.sendTurn('s1', 'one');
    // the lock is claimed synchronously, before the first await.
    expect(conductor.isBusy('s1')).toBe(true);
    await expect(conductor.sendTurn('s1', 'two')).rejects.toBeInstanceOf(SessionBusyError);

    release();
    await expect(first).resolves.toMatchObject({ sessionId: 's1', exitCode: 0 });
    expect(conductor.isBusy('s1')).toBe(false);
  });

  it('runs an after-current-turn action when sendTurn settles', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    const turn = conductor.sendTurn('s1', 'one');
    let ran = false;
    expect(
      conductor.runAfterCurrentTurn('s1', () => {
        ran = true;
      }),
    ).toBe(true);
    expect(ran).toBe(false);

    release();
    await turn;
    expect(ran).toBe(true);
    expect(conductor.hasDeferredAfterCurrentTurn('s1')).toBe(false);
  });

  it('runs an after-current-turn action when turn acceptance rolls back', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let finishPreflight: (exists: boolean) => void = () => undefined;
    const preflight = new Promise<boolean>((resolve) => {
      finishPreflight = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: unreachableBackend().backend,
      worktreeExists: () => preflight,
    });

    const turn = conductor.sendTurn('s1', 'one');
    let ran = false;
    expect(
      conductor.runAfterCurrentTurn('s1', () => {
        ran = true;
      }),
    ).toBe(true);

    finishPreflight(false);
    await expect(turn).rejects.toBeInstanceOf(WorktreeMissingError);
    expect(ran).toBe(true);
    expect(conductor.hasDeferredAfterCurrentTurn('s1')).toBe(false);
  });

  it('releases the lock after a failed turn so the session can be retried', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // First turn: a run that ends with events but no session init → ingest throws.
    // Second turn: a well-formed run.
    const fake = scriptedBackend((_opts, attempt) =>
      attempt === 1 ? { sessionId: null, text: 'hi', omitResult: true } : {},
    );
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s1', 'one')).rejects.toThrow(/no session init/);
    expect(conductor.isBusy('s1')).toBe(false);

    const result = await conductor.sendTurn('s1', 'two');
    expect(result).toMatchObject({ sessionId: 's1', exitCode: 0 });
  });

  it('does not retry a fresh (non-resume) turn that ends before binding a session', async () => {
    // Nothing to recover from: with no thread to discard, a second identical attempt
    // would only double the failure.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend({ sessionId: null, text: 'hi', omitResult: true });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s1', 'one')).rejects.toThrow(/no session init/);
    expect(fake.calls).toHaveLength(1);
  });

  it('preserves the resume target after a transient pre-init failure', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'still-valid-thread',
      contextSeq: 0,
    });
    const fake = scriptedBackend({ sessionId: null, text: 'hi', omitResult: true });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s1', 'weiter')).rejects.toThrow(/no session init/);
    expect(fake.calls).toHaveLength(1);
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'still-valid-thread',
    });
  });

  it('threads optional deps and per-turn overrides into the run', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'stored' });
    const fake = scriptedBackend({ text: 'hi' });
    const bus = new InMemoryEventBus();
    const seen: number[] = [];
    bus.subscribe('s1', (se) => seen.push(se.seq));
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      command: 'claude-bin',
      bus,
      timeoutMs: 10_000,
      permissionMode: 'plan',
      env: { ...process.env, VERITY_TEST: '1' },
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'go', { permissionMode: 'acceptEdits', model: 'override' });

    // per-turn overrides win over both the stored model and the deps default mode.
    expect(fake.last()).toMatchObject({
      command: 'claude-bin',
      timeoutMs: 10_000,
      permissionMode: 'acceptEdits',
      model: 'override',
    });
    expect(fake.last().env?.VERITY_TEST).toBe('1');
    expect(seen.length).toBeGreaterThan(0); // events fanned out to the bus
  });

  it('threads per-turn allow/deny tool lists into the turn options', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'go', {
      allowedTools: ['Read', 'Bash(git *)'],
      disallowedTools: ['WebFetch'],
    });

    expect(fake.last()).toMatchObject({
      allowedTools: ['Read', 'Bash(git *)'],
      disallowedTools: ['WebFetch'],
    });
  });
});

describe('Conductor.query', () => {
  it('runs stateless queries through the configured dynamic backend wrapper', async () => {
    const rawQuery = vi.fn(async () => 'raw');
    const wrappedQuery = vi.fn((input: QueryInput) =>
      Promise.resolve(input.env?.CLAUDE_CODE_OAUTH_TOKEN),
    );
    const rawBackend: Backend = {
      run: vi.fn(async () => ({
        sessionId: undefined,
        exitCode: 0,
        stderr: '',
        aborted: false,
      })),
      query: rawQuery,
    };
    const queryBackend = vi.fn(async (selected: Backend) => ({
      ...selected,
      query: wrappedQuery,
    }));
    const conductor = new Conductor({
      store: ctx.store,
      backend: rawBackend,
      queryBackend,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'central-access-token' },
    });

    await expect(conductor.query({ prompt: 'refine', cwd: '/wt' })).resolves.toBe(
      'central-access-token',
    );
    expect(queryBackend).toHaveBeenCalledWith(rawBackend, undefined);
    expect(wrappedQuery).toHaveBeenCalledTimes(1);
    expect(rawQuery).not.toHaveBeenCalled();
  });

  it('runs an ACP-only meta-query as a transient supervised turn', async () => {
    const backend: Backend = {
      runnerSupervisorBackend: 'claude-acp',
      run: vi.fn(async () => ({
        sessionId: undefined,
        exitCode: 0,
        stderr: '',
        aborted: false,
      })),
    };
    const runner = vi.fn(async (_selected: Backend, context: RunnerClientContext) => ({
      startTurn: (opts: RunTurnOptions) => {
        context.ephemeralEventSink?.({ t: 'text', delta: ' Refined ' });
        context.ephemeralEventSink?.({ t: 'thinking', blockId: 'x', delta: 'hidden' });
        expect(opts.permissionMode).toBe('dontAsk');
        expect(opts.storeSessionId).toMatch(/^query-/u);
        return {
          result: Promise.resolve({
            sessionId: 'agent-query',
            exitCode: 0,
            stderr: '',
            aborted: false,
          }),
          steer: async () => false,
          answerPermission: async () => false,
          cancel: async () => false,
        };
      },
    }));
    const conductor = new Conductor({ store: ctx.store, backend, runner });

    await expect(conductor.query({ prompt: 'refine', cwd: '/wt' })).resolves.toBe('Refined');
    expect(runner).toHaveBeenCalledWith(
      backend,
      expect.objectContaining({ sessionId: null, projectId: null, worktree: '/wt' }),
    );
  });
});

describe('Conductor.dispatchTurn', () => {
  it('auto-resumes a turn that crashed without the operator cancelling it', async () => {
    await ctx.store.createSession({ sessionId: 's-auto', worktree: '/wt/x', model: 'm' });
    // Dies on the first attempt (the transient case: dropped stream, token race,
    // worker killed) and succeeds on the replay — the session must reach the good
    // turn on its own, with no second operator message.
    let attempts = 0;
    const prompts: string[] = [];
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        prompts.push(opts.prompt ?? '');
        if (attempts === 1) {
          // Died before producing anything — the stranding case (no session init,
          // a refused token, a worker killed at spawn).
          return {
            sessionId: opts.storeSessionId,
            exitCode: 1,
            stderr: 'boom',
            aborted: false,
            failedBeforeExecution: true,
          };
        }
        await ctx.store.appendEvent('s-auto', { t: 'text', delta: 'carried on' });
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-auto', 'go');
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(conductor.isBusy('s-auto')).toBe(false);
    });
    // The replay carries the operator's ORIGINAL instruction — not a synthesized
    // nudge — and appends no second prompt to the transcript.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    const events = await ctx.store.getEvents('s-auto');
    expect(events.filter((e) => e.t === 'prompt')).toHaveLength(1);
    expect(events.some((e) => e.t === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ t: 'text', delta: 'carried on' });
  });

  it('finishes an auto-resume before draining a later queued prompt', async () => {
    await ctx.store.createSession({ sessionId: 's-order', worktree: '/wt/x', model: 'm' });
    let attempts = 0;
    let failFirst!: () => void;
    const firstFailure = new Promise<void>((resolve) => {
      failFirst = resolve;
    });
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        if (attempts === 1) {
          await firstFailure;
          return {
            sessionId: opts.storeSessionId,
            exitCode: 1,
            stderr: 'transient',
            aborted: false,
            failedBeforeExecution: true,
          };
        }
        await ctx.store.appendEvent('s-order', {
          t: 'text',
          delta: opts.prompt === 'first' ? 'first answer' : 'second answer',
        });
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-order', 'first');
    await vi.waitFor(() => expect(attempts).toBe(1));
    await expect(conductor.dispatchTurn('s-order', 'second')).resolves.toEqual({ queued: true });
    failFirst();
    await vi.waitFor(() => {
      expect(attempts).toBe(3);
      expect(conductor.isBusy('s-order')).toBe(false);
    });

    const events = await ctx.store.getEvents('s-order');
    expect(
      events.map((event) =>
        event.t === 'prompt' ? event.text : event.t === 'text' ? event.delta : event.t,
      ),
    ).toEqual(['first', 'first answer', 'second', 'second answer']);
  });

  it('does not auto-resume a turn that did work it cannot resume into', async () => {
    await ctx.store.createSession({ sessionId: 's-side', worktree: '/wt/x', model: 'm' });
    let attempts = 0;
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        // Acted (a commit, a push, a deploy) and only THEN died. Replaying would
        // re-submit "ship it" to an agent that already shipped.
        await ctx.store.appendEvent('s-side', { t: 'text', delta: 'pushed the release' });
        return {
          sessionId: opts.storeSessionId,
          exitCode: 1,
          stderr: 'died after',
          aborted: false,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-side', 'ship it');
    await vi.waitFor(() => {
      expect(conductor.isBusy('s-side')).toBe(false);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts).toBe(1);
  });

  it('does not auto-resume an unclassified silent failure', async () => {
    await ctx.store.createSession({ sessionId: 's-unknown', worktree: '/wt/x', model: 'm' });
    let attempts = 0;
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        return { sessionId: opts.storeSessionId, exitCode: 1, stderr: 'unknown', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-unknown', 'ship it');
    await vi.waitFor(() => expect(conductor.isBusy('s-unknown')).toBe(false));
    expect(attempts).toBe(1);
  });

  it('does not auto-resume a turn the operator cancelled', async () => {
    await ctx.store.createSession({ sessionId: 's-cancel', worktree: '/wt/x', model: 'm' });
    let attempts = 0;
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        return { sessionId: opts.storeSessionId, exitCode: 1, stderr: '', aborted: true };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-cancel', 'go');
    await vi.waitFor(() => {
      expect(conductor.isBusy('s-cancel')).toBe(false);
    });
    // A deliberate stop must stay stopped.
    expect(attempts).toBe(1);
  });

  it('cancels the auto-resume delay without waiting for it to expire', async () => {
    await ctx.store.createSession({ sessionId: 's-delay', worktree: '/wt/x', model: 'm' });
    let attempts = 0;
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        return {
          sessionId: opts.storeSessionId,
          exitCode: 1,
          stderr: 'transient',
          aborted: false,
          failedBeforeExecution: true,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 60_000,
    });

    await conductor.dispatchTurn('s-delay', 'go');
    await vi.waitFor(() => expect(attempts).toBe(1));
    await expect(conductor.cancelTurn('s-delay')).resolves.toBe(true);
    await vi.waitFor(() => expect(conductor.isBusy('s-delay')).toBe(false));
    expect(attempts).toBe(1);
    expect((await ctx.store.getEvents('s-delay')).at(-1)).toEqual({ t: 'interrupted' });
  });

  it('does not enqueue a replay when cancellation lands at the delay boundary', async () => {
    await ctx.store.createSession({ sessionId: 's-boundary', worktree: '/wt/x', model: 'm' });
    let attempts = 0;
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        setTimeout(() => void conductor.cancelTurn('s-boundary'), 0);
        return {
          sessionId: opts.storeSessionId,
          exitCode: 1,
          stderr: 'transient',
          aborted: false,
          failedBeforeExecution: true,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-boundary', 'go');
    await vi.waitFor(() => expect(conductor.isBusy('s-boundary')).toBe(false));
    expect(attempts).toBe(1);
  });

  it('drops an auto-resume cancelled after enqueue but before queue drain', async () => {
    await ctx.store.createSession({
      sessionId: 's-enqueued-cancel',
      worktree: '/wt/x',
      model: 'm',
    });
    let attempts = 0;
    let releaseReplayAccept!: () => void;
    const replayAcceptGate = new Promise<void>((resolve) => {
      releaseReplayAccept = resolve;
    });
    let worktreeChecks = 0;
    const conductor = new Conductor({
      store: ctx.store,
      backend: {
        run: async (opts) => {
          attempts += 1;
          return {
            sessionId: opts.storeSessionId,
            exitCode: 1,
            stderr: 'transient',
            aborted: false,
            failedBeforeExecution: true,
          };
        },
      },
      worktreeExists: async () => {
        worktreeChecks += 1;
        if (worktreeChecks === 2) await replayAcceptGate;
        return true;
      },
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-enqueued-cancel', 'go');
    await vi.waitFor(() => expect(worktreeChecks).toBe(2));
    await expect(conductor.cancelTurn('s-enqueued-cancel')).resolves.toBe(true);
    releaseReplayAccept();
    await vi.waitFor(() => expect(conductor.isBusy('s-enqueued-cancel')).toBe(false));
    expect(attempts).toBe(1);
    expect((await ctx.store.getEvents('s-enqueued-cancel')).at(-1)).toMatchObject({
      t: 'interrupted',
    });
  });

  it('auto-resumes a failing turn only once, so a broken backend cannot loop', async () => {
    await ctx.store.createSession({ sessionId: 's-loop', worktree: '/wt/x', model: 'm' });
    let attempts = 0;
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        return {
          sessionId: opts.storeSessionId,
          exitCode: 1,
          stderr: 'always',
          aborted: false,
          failedBeforeExecution: true,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-loop', 'go');
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(conductor.isBusy('s-loop')).toBe(false);
    });
    // Budget spent: the deterministic failure settles instead of retrying forever.
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts).toBe(2);
  });

  it('preserves structured rate limits when pre-execution retries are exhausted', async () => {
    await ctx.store.createSession({ sessionId: 's-rate-loop', worktree: '/wt/x', model: 'm' });
    let attempts = 0;
    const backend: Backend = {
      run: async (opts) => {
        attempts += 1;
        await ctx.store.appendEvent('s-rate-loop', {
          t: 'rate_limit',
          status: 'rejected',
          resetsAt: 2_000,
          window: 'five_hour',
          providerLabel: 'Codex',
        });
        return {
          sessionId: opts.storeSessionId,
          exitCode: 1,
          stderr: 'rate limited',
          aborted: false,
          failedBeforeExecution: true,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoResumeDelayMs: 0,
    });

    await conductor.dispatchTurn('s-rate-loop', 'go');
    await vi.waitFor(() => {
      expect(attempts).toBe(2);
      expect(conductor.isBusy('s-rate-loop')).toBe(false);
    });

    const events = await ctx.store.getEvents('s-rate-loop');
    expect(events.filter((event) => event.t === 'rate_limit')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ t: 'error', kind: 'crashed' });
  });

  it('resolves on acceptance and runs the turn in the background', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'go'); // resolves once accepted, not when done
    expect(conductor.isBusy('s1')).toBe(true); // background run still in flight

    release();
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).toEqual([
      'prompt',
      'session',
      'result',
    ]);
  });

  it('can show a compact prompt while sending a fuller backend prompt', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'full backend instruction', undefined, {
      displayPrompt: 'Merged PR #119',
    });
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });

    expect(fake.last().prompt).toBe('full backend instruction');
    const prompts = (await ctx.store.getEvents('s1')).filter((e) => e.t === 'prompt');
    expect(prompts).toEqual([{ t: 'prompt', text: 'Merged PR #119' }]);
  });

  it('rejects an unknown session without spawning', async () => {
    const fake = unreachableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await expect(conductor.dispatchTurn('ghost', 'hi')).rejects.toBeInstanceOf(UnknownSessionError);
    expect(fake.ran()).toBe(false);
    expect(conductor.isBusy('ghost')).toBe(false);
  });

  it('deduplicates a replayed clientReplyId instead of dispatching a second turn', async () => {
    // ADR 0008: a background-woken app can re-flush the same quick reply after iOS
    // suspended it before the 202. A repeat key must return the prior result, never
    // start a second turn — even after the first turn has already settled.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    const first = await conductor.dispatchTurn('s1', 'answer', undefined, { clientReplyId: 'r-1' });
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
    const second = await conductor.dispatchTurn('s1', 'answer', undefined, {
      clientReplyId: 'r-1',
    });

    expect(second).toEqual(first);
    expect(fake.calls).toHaveLength(1);
    expect(conductor.isBusy('s1')).toBe(false);
  });

  it('coalesces two rapid submissions with the same client turn id', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    const [first, duplicate] = await Promise.all([
      conductor.dispatchTurn('s1', 'answer', undefined, { clientReplyId: 'rapid-1' }),
      conductor.dispatchTurn('s1', 'answer', undefined, { clientReplyId: 'rapid-1' }),
    ]);

    expect(duplicate).toEqual(first);
    await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
    expect(fake.calls).toHaveLength(1);
    expect((await ctx.store.getEvents('s1')).filter((event) => event.t === 'prompt')).toHaveLength(
      1,
    );
  });

  it('dispatches distinct clientReplyIds independently', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'one', undefined, { clientReplyId: 'r-1' });
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
    await conductor.dispatchTurn('s1', 'two', undefined, { clientReplyId: 'r-2' });
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });

    expect(fake.calls).toHaveLength(2);
  });

  it('does not memoize a rejected dispatch, so a retry with the same key still runs', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let worktreeOk = false;
    const fake = scriptedBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => worktreeOk,
    });

    await expect(
      conductor.dispatchTurn('s1', 'answer', undefined, { clientReplyId: 'r-1' }),
    ).rejects.toBeInstanceOf(WorktreeMissingError);
    expect(fake.calls).toHaveLength(0);

    // The failure was not cached: once the worktree is back, the same key dispatches.
    worktreeOk = true;
    await conductor.dispatchTurn('s1', 'answer', undefined, { clientReplyId: 'r-1' });
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('dispatchTurnWhenIdle refuses busy sessions without steering or queueing', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bus = new InMemoryEventBus();
    const prompts: string[] = [];
    bus.subscribe('s1', (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    const conductor = new Conductor({
      store: ctx.store,
      bus,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'operator turn');
    expect(await conductor.dispatchTurnWhenIdle('s1', 'automatic repair')).toEqual({
      accepted: false,
    });
    expect(conductor.queuedCount('s1')).toBe(0);
    await vi.waitFor(() => {
      expect(prompts).toEqual(['operator turn']);
    });

    release();
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
    expect(await conductor.dispatchTurnWhenIdle('s1', 'automatic repair')).toEqual({
      accepted: true,
    });
  });

  it('queues turns sent while one runs and drains them FIFO when it finishes (#90)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bus = new InMemoryEventBus();
    const prompts: string[] = [];
    bus.subscribe('s1', (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    const conductor = new Conductor({
      store: ctx.store,
      bus,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    expect(await conductor.dispatchTurn('s1', 'one')).toEqual({ queued: false });
    expect(conductor.isBusy('s1')).toBe(true);
    // Sent while busy → queued (not rejected); their prompts aren't emitted yet.
    expect(await conductor.dispatchTurn('s1', 'two')).toEqual({ queued: true });
    expect(await conductor.dispatchTurn('s1', 'three')).toEqual({ queued: true });
    expect(conductor.queuedCount('s1')).toBe(2);
    // Only the in-flight turn's prompt is emitted; the queued ones wait (their
    // prompt lands when they actually dispatch on drain).
    await vi.waitFor(() => {
      expect(prompts).toEqual(['one']);
    });

    release(); // turn one settles → two drains → three drains, in order
    await vi.waitFor(() => {
      expect(prompts).toEqual(['one', 'two', 'three']);
    });
    await vi.waitFor(() => {
      expect(conductor.queuedCount('s1')).toBe(0);
      expect(conductor.isBusy('s1')).toBe(false);
    });
  });

  it('rejects an enqueue past the cap with QueueFullError', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
      maxQueuedTurns: 1,
    });

    await conductor.dispatchTurn('s1', 'one'); // in flight
    expect(await conductor.dispatchTurn('s1', 'two')).toEqual({ queued: true }); // fills the 1-slot queue
    await expect(conductor.dispatchTurn('s1', 'three')).rejects.toBeInstanceOf(QueueFullError);
    expect(conductor.queuedCount('s1')).toBe(1);

    release();
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
  });

  it('rejects a blank prompt even when it would be queued behind a running turn', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'one'); // in flight
    await expect(conductor.dispatchTurn('s1', '   \n\t')).rejects.toThrow(
      /prompt or an attachment/,
    );
    expect(conductor.queuedCount('s1')).toBe(0);

    release();
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
  });

  it('skips a queued turn that fails to dispatch and still drains the rest', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bus = new InMemoryEventBus();
    const prompts: string[] = [];
    bus.subscribe('s1', (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    const errors: string[] = [];
    // worktreeExists is probed once per accepted turn: true for the in-flight
    // 'one' (call 1) and the second queued 'three' (call 3), but false for the
    // first queued 'two' (call 2) → its dispatch fails with WorktreeMissingError.
    let probes = 0;
    const conductor = new Conductor({
      store: ctx.store,
      bus,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => {
        probes += 1;
        return probes !== 2;
      },
      onTurnError: (_id, err) => errors.push(err.message),
    });

    await conductor.dispatchTurn('s1', 'one'); // in flight
    await conductor.dispatchTurn('s1', 'two'); // queued — will fail on drain
    await conductor.dispatchTurn('s1', 'three'); // queued — should still run
    expect(conductor.queuedCount('s1')).toBe(2);

    release();
    // 'two' is skipped (its prompt never emits); 'three' still drains and runs.
    await vi.waitFor(() => {
      expect(prompts).toEqual(['one', 'three']);
      expect(conductor.isBusy('s1')).toBe(false);
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/worktree/i);
    expect(conductor.queuedCount('s1')).toBe(0);
    expect(conductor.isBusy('s1')).toBe(false);
  });

  it('routes a background turn failure to onTurnError and releases the lock', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const errors: { id: string; msg: string }[] = [];
    const bus = new InMemoryEventBus();
    const observed: AgentEvent[] = [];
    bus.subscribeAll((_sessionId, sequenced) => observed.push(sequenced.event));
    // A stream with events but no session init → ingest throws — in the
    // background, AFTER acceptance has already resolved.
    const conductor = new Conductor({
      store: ctx.store,
      bus,
      backend: scriptedBackend({ sessionId: null, text: 'hi', omitResult: true }).backend,
      onTurnError: (id, err) => errors.push({ id, msg: err.message }),
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'go'); // accepted, though it fails in the background
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0]).toMatchObject({ id: 's1' });
    expect(errors[0]?.msg).toMatch(/no session init/);
    expect(conductor.isBusy('s1')).toBe(false);
    expect(observed).toEqual(
      expect.arrayContaining([expect.objectContaining({ t: 'error', kind: 'run_failed' })]),
    );
    expect(await ctx.store.getEvents('s1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          t: 'error',
          kind: 'run_failed',
          message: expect.stringMatching(/no session init/),
        }),
      ]),
    );
  });
});

describe('Conductor durable queue: persist, retract, recover (#80)', () => {
  it('mirrors a queued turn to the store and removes the row when it dispatches', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'one'); // in flight
    await conductor.dispatchTurn('s1', 'two'); // queued → persisted

    const persisted = await ctx.store.listQueuedTurns();
    expect(persisted.map((r) => ({ session: r.sessionId, prompt: r.prompt }))).toEqual([
      { session: 's1', prompt: 'two' },
    ]);
    // The queued item's store id matches the conductor's retract handle.
    expect(persisted[0]?.id).toBe(conductor.queuedItems('s1')[0]?.id);

    release(); // 'one' settles → 'two' drains and its row is dropped
    await vi.waitFor(async () => {
      expect(conductor.isBusy('s1')).toBe(false);
      expect(await ctx.store.listQueuedTurns()).toHaveLength(0);
    });
  });

  it('surfaces stored attachment refs with queued items for waiting previews', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const gate = new Promise<void>(() => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'one');
    await conductor.dispatchTurn('s1', 'with screenshot', {
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
    });

    expect(conductor.queuedItems('s1')).toEqual([
      {
        id: expect.any(String),
        text: 'with screenshot',
        attachments: [
          { kind: 'image', mediaType: 'image/png', id: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
      },
    ]);
  });

  it('retracts a queued turn via dequeue: returns its prompt and drops it everywhere', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'one'); // in flight
    await conductor.dispatchTurn('s1', 'keep'); // queued
    await conductor.dispatchTurn('s1', 'internal backend prompt', undefined, {
      displayPrompt: 'retract me',
    }); // queued
    const items = conductor.queuedItems('s1');
    const target = items.find((i) => i.text === 'retract me');
    expect(target).toBeDefined();

    const removed = await conductor.dequeue('s1', target!.id);
    expect(removed).toEqual({ prompt: 'retract me' });
    // Gone from the live queue AND the durable store; the other item is untouched.
    expect(conductor.queuedItems('s1').map((i) => i.text)).toEqual(['keep']);
    expect((await ctx.store.listQueuedTurns()).map((r) => r.prompt)).toEqual(['keep']);

    release();
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
  });

  it('dequeue returns undefined for an unknown/stale id', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    expect(await conductor.dequeue('s1', 'no-such-id')).toBeUndefined();
  });

  it('clearQueue drops the whole backlog (live + durable) and returns the prompts, so a cancelled turn cannot drain a queued message (#79)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const bus = new InMemoryEventBus();
    bus.subscribe('s1', (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    const conductor = new Conductor({
      store: ctx.store,
      bus,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'one'); // in flight
    await conductor.dispatchTurn('s1', 'two'); // queued
    await conductor.dispatchTurn('s1', 'internal', undefined, { displayPrompt: 'three' }); // queued
    const queued = conductor.queuedItems('s1');
    expect(queued.map((i) => i.text)).toEqual(['two', 'three']);

    // Clear returns every dropped turn's id + prompt in FIFO order...
    const dropped = await conductor.clearQueue('s1');
    expect(dropped).toEqual([
      { id: queued[0]!.id, prompt: 'two' },
      { id: queued[1]!.id, prompt: 'three' },
    ]);
    // ...and the backlog is gone from BOTH the live queue and the durable store.
    expect(conductor.queuedCount('s1')).toBe(0);
    expect(await ctx.store.listQueuedTurns()).toHaveLength(0);

    // The head prompt of the (now cleared) backlog never emitted while the in-flight
    // turn ran; releasing that turn must NOT drain a queued message into a new turn.
    release();
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
    expect(prompts).toEqual(['one']); // only the original in-flight turn ever ran
  });

  it('clearQueue is idempotent on an empty/unknown session', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    expect(await conductor.clearQueue('s1')).toEqual([]);
    expect(await conductor.clearQueue('no-such-session')).toEqual([]);
  });

  it('stopSession includes an enqueue already awaiting durable storage and prevents it from draining', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let releaseTurn = (): void => undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let releaseEnqueue = (): void => undefined;
    const enqueueGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    const enqueueTurn = ctx.store.enqueueTurn.bind(ctx.store);
    const enqueueStarted = vi.fn();
    vi.spyOn(ctx.store, 'enqueueTurn').mockImplementationOnce(async (row) => {
      enqueueStarted();
      await enqueueGate;
      await enqueueTurn(row);
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(turnGate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'one');
    const enqueue = conductor.dispatchTurn('s1', 'internal', undefined, {
      displayPrompt: 'queued while stopping',
    });
    await vi.waitFor(() => expect(enqueueStarted).toHaveBeenCalledOnce());
    const stop = conductor.stopSession('s1');
    releaseEnqueue();

    await expect(enqueue).resolves.toEqual({ queued: true });
    // A cancel ACK is not process exit. Let the old backend actually finish before
    // Stop may report the cancellation as complete.
    releaseTurn();
    await expect(stop).resolves.toMatchObject({
      cancelled: true,
      droppedQueued: [expect.objectContaining({ prompt: 'queued while stopping' })],
    });
    expect(conductor.queuedCount('s1')).toBe(0);
    expect(await ctx.store.listQueuedTurns()).toHaveLength(0);
  });

  it('stopSession still cancels the active turn when durable queue cleanup fails', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });
    await conductor.dispatchTurn('s1', 'one');
    await conductor.dispatchTurn('s1', 'two');
    vi.spyOn(ctx.store, 'deleteQueuedTurns').mockRejectedValueOnce(
      new Error('storage unavailable'),
    );
    const cancelTurn = vi.spyOn(conductor, 'cancelTurn');

    await expect(conductor.stopSession('s1')).rejects.toThrow('storage unavailable');
    expect(cancelTurn).toHaveBeenCalledWith('s1');
    expect(conductor.queuedCount('s1')).toBe(1);
    expect(await ctx.store.listQueuedTurns()).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
  });

  it('shares one fenced queue cleanup across overlapping stopSession calls', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    let releaseCleanup = (): void => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const clearQueue = vi.spyOn(conductor, 'clearQueue').mockImplementationOnce(async () => {
      await cleanupGate;
      return [];
    });

    const firstStop = conductor.stopSession('s1');
    const secondStop = conductor.stopSession('s1');
    await expect(conductor.dispatchTurn('s1', 'must stay fenced')).rejects.toBeInstanceOf(
      SessionBusyError,
    );
    releaseCleanup();
    await expect(firstStop).resolves.toEqual({ cancelled: false, droppedQueued: [] });
    await expect(secondStop).resolves.toEqual({ cancelled: false, droppedQueued: [] });
    expect(clearQueue).toHaveBeenCalledOnce();
  });

  it('recover rebuilds the queue from the store on restart and drains it FIFO', async () => {
    // Simulate turns persisted by a PREVIOUS process that then crashed/restarted.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.enqueueTurn({ id: 'q1', sessionId: 's1', prompt: 'alpha', opts: {} });
    await ctx.store.enqueueTurn({ id: 'q2', sessionId: 's1', prompt: 'beta', opts: {} });

    const bus = new InMemoryEventBus();
    const prompts: string[] = [];
    bus.subscribe('s1', (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    const conductor = new Conductor({
      store: ctx.store,
      bus,
      backend: scriptedBackend({ text: 'hi' }).backend,
      worktreeExists: async () => true,
    });

    await conductor.recover();

    await vi.waitFor(() => {
      expect(prompts).toEqual(['alpha', 'beta']); // FIFO order preserved
    });
    // The second prompt is persisted before its fake process settles. Under a busy
    // full-suite worker, wait for that final settle rather than asserting in the
    // small gap between queue deletion and in-flight cleanup.
    await vi.waitFor(async () => {
      expect(await ctx.store.listQueuedTurns()).toHaveLength(0); // rows drained
      expect(conductor.isBusy('s1')).toBe(false);
    });
  });

  it('recover resumes prompt events left at the transcript tail without duplicating them', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'done before restart' });
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'orphan one' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'orphan two' });

    const seenPrompts: string[] = [];
    const backend: Backend = {
      run: async (opts) => {
        seenPrompts.push(opts.prompt ?? '');
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.recover();

    await vi.waitFor(() => {
      expect(seenPrompts).toEqual(['orphan one', 'orphan two']);
    });
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
    expect((await ctx.store.getEvents('s1')).filter((event) => event.t === 'prompt')).toEqual([
      { t: 'prompt', text: 'done before restart' },
      { t: 'prompt', text: 'orphan one' },
      { t: 'prompt', text: 'orphan two' },
    ]);
  });

  it('recover retries tail prompts stranded by a sealed-store startup recovery', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'needs unlocked secrets' });
    await ctx.store.appendEvent('s1', {
      t: 'error',
      kind: 'sealed',
      message:
        'verity: secret store is sealed — unlock it with the master password before using project secrets',
    });

    const seenPrompts: string[] = [];
    const backend: Backend = {
      run: async (opts) => {
        seenPrompts.push(opts.prompt ?? '');
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.recover();

    await vi.waitFor(() => {
      expect(seenPrompts).toEqual(['needs unlocked secrets']);
    });
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
  });

  it('recover is a no-op when the store has no queued turns or orphan tail prompts', async () => {
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    await expect(conductor.recover()).resolves.toBeUndefined();
  });

  it("recover rehydrates a queued turn's attachment ref into a base64 upload", async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const pngB64 = Buffer.from('PNGDATA').toString('base64');
    const hash = await ctx.store.putAttachment('image/png', pngB64);
    await ctx.store.enqueueTurn({
      id: 'q1',
      sessionId: 's1',
      prompt: 'see this',
      opts: { attachments: [{ kind: 'image', mediaType: 'image/png', id: hash }] },
    });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.recover();

    await vi.waitFor(() => {
      expect(captured).toBeDefined();
    });
    // The stored ref is re-read from the blob store and re-encoded as the upload the
    // runner expects — a queued screenshot dispatches exactly like a freshly-sent one.
    expect(captured?.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', data: pngB64 },
    ]);
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
  });

  it('recover drops a queued attachment whose blob is missing but still runs the turn', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.enqueueTurn({
      id: 'q1',
      sessionId: 's1',
      prompt: 'orphan ref',
      opts: { attachments: [{ kind: 'image', mediaType: 'image/png', id: 'cafebabe' }] }, // no blob
    });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.recover();

    await vi.waitFor(() => {
      expect(captured).toBeDefined();
    });
    expect(captured?.prompt).toBe('orphan ref');
    expect(captured?.attachments).toBeUndefined(); // missing blob dropped; turn still ran
  });

  it('recover skips a row that fails to rehydrate and still recovers other sessions', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    await ctx.store.enqueueTurn({
      id: 'bad',
      sessionId: 's1',
      prompt: 'boom',
      opts: { attachments: [{ kind: 'image', mediaType: 'image/png', id: 'boom' }] },
    });
    await ctx.store.enqueueTurn({ id: 'good', sessionId: 's2', prompt: 'survivor', opts: {} });
    // A real blob-read error (NOT a missing blob) while rehydrating 'bad' must not
    // strand 's2's backlog: the bad row is logged + skipped, 's2' still recovers.
    const store = new Proxy(ctx.store, {
      get(target, prop, receiver) {
        if (prop === 'getAttachment') {
          return async (h: string) => {
            if (h === 'boom') throw new Error('blob read failed');
            return target.getAttachment(h);
          };
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const bus = new InMemoryEventBus();
    const prompts: string[] = [];
    bus.subscribe('s2', (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    const errors: string[] = [];
    const conductor = new Conductor({
      store,
      bus,
      backend: scriptedBackend({ sessionId: 's2', text: 'hi' }).backend,
      worktreeExists: async () => true,
      onTurnError: (_id, err) => errors.push(err.message),
    });

    await conductor.recover();

    await vi.waitFor(() => {
      expect(prompts).toEqual(['survivor']);
    });
    expect(errors.some((m) => /blob read failed/.test(m))).toBe(true);
    expect(conductor.isBusy('s1')).toBe(false); // the bad row never dispatched
  });

  it('retries a queued turn in FIFO order when its atomic drain transiently fails (SR-5/B2)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The atomic delete+persist txn fails ONCE (transient), rolling back — so the row
    // survives. The failed head turn must be put back at the FRONT and retried in
    // order (not overtaken by a later turn nor stranded until restart); the retry then
    // succeeds and 'two' runs exactly once, keeping FIFO.
    let drainAttempts = 0;
    const store = new Proxy(ctx.store, {
      get(target, prop, receiver) {
        if (prop === 'drainQueuedTurn') {
          return async (...args: unknown[]): Promise<unknown> => {
            drainAttempts += 1;
            if (drainAttempts === 1) throw new Error('drain txn failed');
            return (target.drainQueuedTurn as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const bus = new InMemoryEventBus();
    const prompts: string[] = [];
    bus.subscribe('s1', (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    const errors: string[] = [];
    const conductor = new Conductor({
      store,
      bus,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
      onTurnError: (_id, err) => errors.push(err.message),
    });

    await conductor.dispatchTurn('s1', 'one'); // in flight
    await conductor.dispatchTurn('s1', 'two'); // queued → durable row
    release();

    await vi.waitFor(() => {
      expect(prompts).toEqual(['one', 'two']); // 'two' retried in order, ran exactly once
    });
    expect(errors.some((m) => /drain txn failed/.test(m))).toBe(true); // the transient failure was logged
    expect(await ctx.store.listQueuedTurns()).toHaveLength(0); // row drained after the retry
  });

  it('drains a turn enqueued while the in-flight one settles mid-persist', async () => {
    // Forces the headline race the design hinges on: the in-flight turn settles DURING
    // the queued turn's durable insert (so its drain sees an empty queue), then the
    // insert completes and the enqueue must kick its own drain so the item isn't stranded.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolveEnqueue = (): void => undefined;
    const enqueueGate = new Promise<void>((resolve) => {
      resolveEnqueue = resolve;
    });
    let signalEnqueueStarted = (): void => undefined;
    const enqueueStarted = new Promise<void>((resolve) => {
      signalEnqueueStarted = resolve;
    });
    const store = new Proxy(ctx.store, {
      get(target, prop, receiver) {
        if (prop === 'enqueueTurn') {
          return async (input: Parameters<typeof target.enqueueTurn>[0]): Promise<void> => {
            signalEnqueueStarted();
            await enqueueGate; // hold the persist open so the in-flight turn can settle
            return target.enqueueTurn(input);
          };
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const bus = new InMemoryEventBus();
    const prompts: string[] = [];
    bus.subscribe('s1', (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    const conductor = new Conductor({
      store,
      bus,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'one'); // in flight
    const two = conductor.dispatchTurn('s1', 'two'); // suspends inside the persist
    await enqueueStarted; // we're now inside the durable insert, before the in-memory push
    release(); // 'one' settles → its drain sees an empty queue (two not pushed yet)
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false); // 'one' fully settled
    });
    resolveEnqueue(); // persist completes → push 'two' → kick its own drain
    await expect(two).resolves.toEqual({ queued: true });

    await vi.waitFor(() => {
      expect(prompts).toEqual(['one', 'two']); // 'two' was not stranded
    });
  });
});

describe('Conductor in-flight markers drive recovery (lifecycle Phase 1)', () => {
  // A bare `error` is NOT terminal — only result/interrupted here (the tests below
  // that need error-kind granularity assert on the event stream directly).
  const isTerminal = (t: string): boolean => t === 'result' || t === 'interrupted';

  it('settles a turn abandoned mid-flight: marker + non-terminal tail → interrupted', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // A turn that started running (marker written) then the process died before any
    // terminal event — the classic CR-3 mid-turn drop.
    const { seq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'do the thing' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: seq });

    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    await conductor.recover();

    const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
    expect(kinds.at(-1)).toBe('interrupted'); // settled, not left badging `running`
    expect(await ctx.store.listRunningTurns()).toHaveLength(0); // marker cleared
  });

  it('does NOT re-run the abandoned prompt (SR-1): the backend is never invoked', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // Mirrors a steered prompt persisted into a turn that was then abandoned: with a
    // marker present, the trailing prompt must be settled, NOT dispatched as a fresh
    // turn (the pre-Phase-1 tail re-run, which double-ran steered prompts).
    const { seq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'steered text' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: seq });

    const seen: string[] = [];
    const backend: Backend = {
      run: async (opts) => {
        seen.push(opts.prompt ?? '');
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });
    await conductor.recover();

    expect(seen).toEqual([]); // the trailing prompt was settled, not re-dispatched
    expect(conductor.isBusy('s1')).toBe(false);
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('does not double-settle a finished-but-uncleaned turn: marker + terminal tail → just clears', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { seq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    // The turn actually finished (terminal `result`) but the crash landed between the
    // terminal event and the marker cleanup, leaving the marker behind.
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: seq });

    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    await conductor.recover();

    const terminal = (await ctx.store.getEvents('s1')).filter((e) => isTerminal(e.t));
    expect(terminal.map((e) => e.t)).toEqual(['result']); // no spurious second terminal
    expect(await ctx.store.listRunningTurns()).toHaveLength(0); // marker cleared
  });

  it('settles when the tail ends in a NON-terminal adapter error (B1: parse_error ≠ terminal)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { seq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    // A single corrupt stdout line yields a non-terminal `error` while the stream keeps
    // running (adapter-claude normalize.ts). The turn then crashes before a real
    // terminal event. Recovery must NOT read the parse_error as a finished turn — it
    // must append `interrupted` (the CR-3 mid-turn drop this fix closes).
    await ctx.store.appendEvent('s1', { t: 'error', kind: 'parse_error', message: 'bad line' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: seq });

    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    await conductor.recover();

    const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
    expect(kinds.at(-1)).toBe('interrupted'); // settled despite the trailing non-terminal error
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('treats a terminal-kind error (run_failed) as settled: no spurious interrupted (B1)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { seq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    // run_failed IS a turn-terminal error kind — the turn genuinely ended, so recovery
    // just drops the marker and must not append a second `interrupted`.
    await ctx.store.appendEvent('s1', {
      t: 'error',
      kind: 'run_failed',
      message: 'backend crashed',
    });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: seq });

    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    await conductor.recover();

    const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
    expect(kinds.filter((t) => t === 'interrupted')).toHaveLength(0); // already settled by run_failed
    expect(await ctx.store.listRunningTurns()).toHaveLength(0); // marker cleared
  });

  it('writes the in-flight marker while a turn runs and clears it on settle', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: gatedBackend(gate).backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'run');
    await vi.waitFor(async () => {
      expect((await ctx.store.listRunningTurns()).map((r) => r.sessionId)).toEqual(['s1']);
    });
    release();
    await vi.waitFor(async () => {
      expect(await ctx.store.listRunningTurns()).toHaveLength(0); // cleared on settle
    });
  });

  it('sendTurn clears its marker when the turn completes on its own', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({ text: 'hi' }).backend,
      worktreeExists: async () => true,
    });
    await conductor.sendTurn('s1', 'go');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });
});

describe('Conductor recover(): reattach-before-settle (ADR 0006 Stage 4c / D7)', () => {
  /** A runner whose `attach` returns a controllable turn and whose `startTurn` must
   * never be called on the reattach path (no new agent is launched). */
  function fakeAttachRunner(result: Promise<RunResult>, confirmsTermination = false) {
    const attachTargets: RunnerAttachTarget[] = [];
    let startTurnCalled = false;
    let cancelCount = 0;
    const client: RunnerClient = {
      startTurn: () => {
        startTurnCalled = true;
        throw new Error('startTurn must not be called on a reattach');
      },
      attach: (target: RunnerAttachTarget): RunnerTurn => {
        attachTargets.push(target);
        return {
          result,
          steer: () => Promise.resolve(true),
          answerPermission: () => Promise.resolve(true),
          cancel: () => {
            cancelCount += 1;
            return Promise.resolve(true);
          },
          ...(confirmsTermination ? { forceCancel: () => Promise.resolve(true) } : {}),
        };
      },
    };
    return {
      factory: () => client,
      attachTargets,
      get startTurnCalled() {
        return startTurnCalled;
      },
      get cancelCount() {
        return cancelCount;
      },
    };
  }

  function fakeRecovery(outcome: RunnerRecoveryOutcome) {
    const calls: { sessionId: string; turnId: string }[] = [];
    const recovery: RunnerRecovery = {
      discover: (marker) => {
        calls.push({ sessionId: marker.sessionId, turnId: marker.turnId });
        return Promise.resolve(outcome);
      },
    };
    return { recovery, calls };
  }

  // A backend that must never run — the reattach path only needs it to compose the
  // runner factory, it never launches an agent.
  const inertBackend: Backend = {
    run: () => Promise.reject(new Error('backend.run must not be called on a reattach')),
  };

  async function seedMarker(turnId: string): Promise<number> {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { seq } = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: seq });
    await ctx.store.bindTurnIdentity('s1', { turnId, startCommandId: `${turnId}-start` });
    return seq;
  }

  it('reattaches a LIVE recovered turn instead of settling it, and settles on the terminal frame', async () => {
    await seedMarker('turn-1');
    let settle!: (r: RunResult) => void;
    const result = new Promise<RunResult>((resolve) => (settle = resolve));
    const runner = fakeAttachRunner(result);
    const { recovery, calls } = fakeRecovery({
      status: 'live',
      target: {
        turnId: 'turn-1',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      },
    });

    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: runner.factory,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    // Discovered by turnId, reattached (never re-launched), and held busy with the marker.
    expect(calls).toEqual([{ sessionId: 's1', turnId: 'turn-1' }]);
    expect(runner.attachTargets).toEqual([
      {
        turnId: 'turn-1',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      },
    ]);
    expect(runner.startTurnCalled).toBe(false);
    expect(conductor.isBusy('s1')).toBe(true);
    expect(await ctx.store.listRunningTurns()).toHaveLength(1); // marker held while running
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).not.toContain('interrupted');

    // Control reaches the reattached turn's live handle.
    const cancellation = conductor.cancelTurn('s1');
    expect(runner.cancelCount).toBe(1);

    // The terminal frame settles it — marker + busy state released, no interrupt.
    settle({ sessionId: 's1', exitCode: 0, stderr: '', aborted: false });
    await expect(cancellation).resolves.toBe(true);
    await vi.waitFor(async () => {
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
    });
    expect(conductor.isBusy('s1')).toBe(false);
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).not.toContain('interrupted');
  });

  it('marks a recovered turn busy before resolving its project backend', async () => {
    await seedMarker('turn-backend-gap');
    let releaseBackend!: () => void;
    const backendGate = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    let settle!: (result: RunResult) => void;
    const runnerResult = new Promise<RunResult>((resolve) => {
      settle = resolve;
    });
    const runner = fakeAttachRunner(runnerResult);
    const { recovery } = fakeRecovery({
      status: 'live',
      target: {
        turnId: 'turn-backend-gap',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      },
    });
    const sessionBackend = vi.fn(async () => {
      await backendGate;
      return inertBackend;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      sessionBackend,
      worktreeExists: async () => true,
      runner: runner.factory,
      runnerRecovery: recovery,
    });

    const recovering = conductor.recover();
    await vi.waitFor(() => expect(sessionBackend).toHaveBeenCalledOnce());
    expect(conductor.isBusy('s1')).toBe(true);
    expect(runner.attachTargets).toHaveLength(0);

    releaseBackend();
    await recovering;
    expect(runner.attachTargets).toHaveLength(1);
    settle({ sessionId: 's1', exitCode: 0, stderr: '', aborted: false });
    await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
  });

  it('keeps the marker and does NOT interrupt on an UNCERTAIN discovery (bounded discovery)', async () => {
    await seedMarker('turn-2');
    const attachmentId = await ctx.store.putAttachment('image/png', 'cXVldWVkIGltYWdl');
    await ctx.store.enqueueTurn({
      id: 'queued-behind-uncertain',
      sessionId: 's1',
      prompt: 'must wait',
      opts: {
        attachments: [{ kind: 'image', mediaType: 'image/png', id: attachmentId }],
      },
    });
    const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
    const { recovery } = fakeRecovery({ status: 'uncertain' });

    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: runner.factory,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    // No reattach, no interrupt, and the marker survives for a later pass to resolve.
    expect(runner.attachTargets).toEqual([]);
    expect(runner.startTurnCalled).toBe(false);
    expect(await ctx.store.listQueuedTurns()).toHaveLength(1);
    expect(conductor.queuedItems('s1')).toEqual([
      {
        id: 'queued-behind-uncertain',
        text: 'must wait',
        attachments: [{ kind: 'image', mediaType: 'image/png', id: attachmentId }],
      },
    ]);
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).not.toContain('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(1);
    // Uncertainty fences the session so neither the recovered queue nor a fresh
    // prompt can start a second agent while the original may still be alive.
    expect(conductor.isBusy('s1')).toBe(true);
  });

  it('refuses a backend handoff while recovered Runner ownership is uncertain', async () => {
    await seedMarker('turn-handoff-uncertain');
    const closeSession = vi.fn();
    const { recovery } = fakeRecovery({ status: 'uncertain' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: { ...inertBackend, closeSession },
      worktreeExists: async () => true,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    const replacement = vi.fn(async () => undefined);
    await expect(conductor.runBackendHandoff('s1', replacement)).rejects.toBeInstanceOf(
      BackendTerminationUnconfirmedError,
    );

    expect(replacement).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(conductor.isBusy('s1')).toBe(true);
    expect(await ctx.store.listRunningTurns()).toHaveLength(1);
    expect((await ctx.store.getEvents('s1')).map((event) => event.t)).not.toContain('interrupted');
  });

  it('lets Stop force-settle an UNCERTAIN recovered turn with no live handle', async () => {
    await seedMarker('turn-stop');
    const closeSession = vi.fn();
    const { recovery } = fakeRecovery({ status: 'uncertain' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: { ...inertBackend, closeSession },
      worktreeExists: async () => true,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    expect(conductor.isBusy('s1')).toBe(true);
    await expect(conductor.cancelTurn('s1')).resolves.toBe(true);

    expect(closeSession).toHaveBeenCalledWith('s1');
    expect(conductor.isBusy('s1')).toBe(false);
    expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('reattaches and sends a real cancel when Stop can rediscover an UNCERTAIN turn as LIVE', async () => {
    await seedMarker('turn-stop-live');
    let settle!: (result: RunResult) => void;
    const result = new Promise<RunResult>((resolve) => (settle = resolve));
    let cancelCount = 0;
    const target = {
      turnId: 'turn-stop-live',
      sessionId: 's1',
      eventFilePath: '/rt/events.jsonl',
      controlSocketPath: '/rt/control.sock',
    };
    let discoverCount = 0;
    const recovery: RunnerRecovery = {
      discover: async () => {
        discoverCount += 1;
        return discoverCount === 1 ? { status: 'uncertain' } : { status: 'live', target };
      },
    };
    const runner: RunnerClient = {
      startTurn: () => {
        throw new Error('startTurn must not be called on a reattach');
      },
      attach: () => ({
        result,
        steer: () => Promise.resolve(true),
        answerPermission: () => Promise.resolve(true),
        cancel: () => {
          cancelCount += 1;
          settle({ sessionId: 's1', exitCode: 143, stderr: '', aborted: true });
          return Promise.resolve(true);
        },
      }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: () => runner,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    expect(conductor.isBusy('s1')).toBe(true);
    await expect(conductor.cancelTurn('s1')).resolves.toBe(true);
    await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));

    expect(discoverCount).toBe(2);
    expect(cancelCount).toBe(1);
    expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('retries an UNCERTAIN marker and releases its queued turn once discovery says DEAD', async () => {
    vi.useFakeTimers();
    try {
      await seedMarker('turn-retry');
      await ctx.store.enqueueTurn({ id: 'q-retry', sessionId: 's1', prompt: 'after', opts: {} });
      let outcome: RunnerRecoveryOutcome = { status: 'uncertain' };
      const recovery: RunnerRecovery = { discover: async () => outcome };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      expect(conductor.isBusy('s1')).toBe(true);
      outcome = { status: 'dead' };
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a permanently UNCERTAIN marker instead of fencing the session forever', async () => {
    // ADR 0006 D7 step 5 calls the uncertain state BOUNDED. A seam that can never
    // answer (missing supervisor socket, deleted runtime dir) used to retry every 5s
    // with no end, so the session badged `running` and refused new prompts until an
    // operator pressed Stop.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-forever-uncertain');
      const { recovery } = fakeRecovery({ status: 'uncertain' });
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      expect(conductor.isBusy('s1')).toBe(true);

      // Well inside the bound the marker is KEPT — a slow Sandbox restart must not
      // lose its still-live turn.
      for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(5_000);
      expect(conductor.isBusy('s1')).toBe(true);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);

      // Past RUNNER_RECOVERY_UNCERTAIN_MAX_ATTEMPTS it settles like a dead one.
      for (let i = 0; i < 30 && conductor.isBusy('s1'); i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(conductor.isBusy('s1')).toBe(false);
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds).toContain('notice'); // says the Runner's fate was never confirmed
      expect(kinds.at(-1)).toBe('interrupted');

      // Never confirmed gone means it may still be alive, so the released session is
      // closed to it: a frame arriving from the abandoned turn is refused rather than
      // appended into whatever runs next.
      await expect(
        ctx.store.ingestRunnerFrame('s1', {
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          runnerInstanceId: 'runner-forever-uncertain',
          turnId: 'turn-forever-uncertain',
          frameSeq: 1,
          payloadHash: 'h1',
          event: { t: 'text', delta: 'still working on it' },
        }),
      ).rejects.toThrow(/abandoned by recovery/i);
      expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a turn that spoke while its give-up probe was in flight', async () => {
    // Discovery is bounded in SECONDS. A turn that emits inside that window has just
    // disproved the verdict the probe is about to return, so the silence the settle
    // rests on has to be anchored before the probe rather than after it — anchoring
    // afterwards would fold that speech into the baseline and settle a live turn.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-speaks-mid-probe');
      let probes = 0;
      const recovery: RunnerRecovery = {
        discover: async () => {
          // Speaks inside every probe but the first (startup recovery's), so each retry
          // finds the log moved since it anchored — an unreachable seam over a Runner
          // that is plainly still working.
          probes += 1;
          if (probes > 1) {
            await ctx.store.appendEvent('s1', { t: 'text', delta: `still building ${probes}` });
          }
          return { status: 'uncertain' };
        },
      };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      for (let i = 0; i < 30; i += 1) await vi.advanceTimersByTimeAsync(5_000);

      // Well past the bound, and the turn still stands: the log moved, so no anchored
      // write lands and the marker it would have cleared is untouched.
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds).not.toContain('interrupted');
      expect(kinds).not.toContain('notice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a turn whose Runner stays live but mute', async () => {
    vi.useFakeTimers();
    try {
      await seedMarker('turn-stays-live');
      const target = {
        turnId: 'turn-stays-live',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      };
      let discoverCalls = 0;
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined), true);
      const recovery: RunnerRecovery = {
        discover: async () => {
          discoverCalls += 1;
          return { status: 'live', target };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      for (let i = 0; i < 80 && conductor.isBusy('s1'); i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(discoverCalls).toBeGreaterThanOrEqual(7);
      expect(conductor.isBusy('s1')).toBe(false);
      expect(runner.cancelCount).toBe(0); // the out-of-band termination path is used
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      const events = await ctx.store.getEvents('s1');
      expect(
        events.some((event) => event.t === 'notice' && event.text.includes('half an hour')),
      ).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ t: 'interrupted' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('never settles a silent turn when the Runner seam stays unreachable', async () => {
    vi.useFakeTimers();
    try {
      await seedMarker('turn-uncertain');
      const target = {
        turnId: 'turn-uncertain',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      };
      let discoverCalls = 0;
      const recovery: RunnerRecovery = {
        discover: async () => {
          discoverCalls += 1;
          return discoverCalls === 1 ? { status: 'live', target } : { status: 'uncertain' };
        },
      };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      for (let i = 0; i < 210; i += 1) await vi.advanceTimersByTimeAsync(30_000);

      expect(discoverCalls).toBeGreaterThanOrEqual(20);
      expect(conductor.isBusy('s1')).toBe(true);
      expect(runner.cancelCount).toBe(0);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
      const kinds = (await ctx.store.getEvents('s1')).map((event) => event.t);
      expect(kinds).not.toContain('notice');
      expect(kinds).not.toContain('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the confirmed-live count when the turn speaks', async () => {
    vi.useFakeTimers();
    try {
      await seedMarker('turn-speaks-between-windows');
      const target = {
        turnId: 'turn-speaks-between-windows',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      };
      let discoverCalls = 0;
      const recovery: RunnerRecovery = {
        discover: async () => {
          discoverCalls += 1;
          return { status: 'live', target };
        },
      };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      for (let i = 0; i < 60 && discoverCalls < 6; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(discoverCalls).toBe(6); // startup plus five silent live windows

      await ctx.store.appendEvent('s1', { t: 'text', delta: 'still making progress' });
      await vi.advanceTimersByTimeAsync(30_000); // observe the new sequence and reset
      for (let i = 0; i < 60 && discoverCalls < 11; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(discoverCalls).toBe(11); // five more live windows after the activity
      expect(conductor.isBusy('s1')).toBe(true);
      expect(runner.cancelCount).toBe(0);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the confirmed-dead verdict on its immediate settle path', async () => {
    vi.useFakeTimers();
    try {
      await seedMarker('turn-goes-silent');
      let outcome: RunnerRecoveryOutcome = {
        status: 'live',
        target: {
          turnId: 'turn-goes-silent',
          sessionId: 's1',
          eventFilePath: '/rt/events.jsonl',
          controlSocketPath: '/rt/control.sock',
        },
      };
      const recovery: RunnerRecovery = { discover: async () => outcome };
      // A reattached turn that never produces another frame — the silence under test.
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      outcome = { status: 'dead' };
      for (let i = 0; i < 12 && conductor.isBusy('s1'); i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(conductor.isBusy('s1')).toBe(false);
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      const events = await ctx.store.getEvents('s1');
      expect(
        events.some(
          (event) =>
            event.t === 'notice' && event.text.includes('Runner executing this turn is gone'),
        ),
      ).toBe(true);
      expect(events.at(-1)?.t).toBe('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not sweep markers while startup recovery still owns them', async () => {
    // Recovery owns every open marker while it runs: the ones it has not reached yet
    // are not in `uncertainRecovery`, so a sweep overlapping it would happily probe
    // and settle a marker recovery is about to reattach. A slow recovery is not
    // hypothetical — each discovery is bounded by 15s, so a host whose supervisor is
    // unreachable takes minutes to walk a few dozen markers.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-recovery-still-running');
      let releaseFirstDiscovery!: (outcome: RunnerRecoveryOutcome) => void;
      const firstDiscovery = new Promise<RunnerRecoveryOutcome>((resolve) => {
        releaseFirstDiscovery = resolve;
      });
      let discoverCalls = 0;
      const recovery: RunnerRecovery = {
        discover: () => {
          discoverCalls += 1;
          // Park recovery's own discovery; answer any LATER caller (i.e. a sweep that
          // should not be running yet) with the one verdict that would settle the turn.
          return discoverCalls === 1 ? firstDiscovery : Promise.resolve({ status: 'dead' });
        },
      };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
        // Long enough that the bounded-discovery race cannot fire while the sweep
        // windows below advance — recovery stays parked on the gate, as intended.
        runnerRecoveryDiscoverTimeoutMs: 60 * 60 * 1000,
      });

      const recovering = conductor.recover();
      // Well past the sweep's probe threshold (10 × 30s). Nothing may touch the marker.
      for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(30_000);
      expect(discoverCalls).toBe(1); // no sweep probe ran behind recovery's back
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
      expect((await ctx.store.getEvents('s1')).map((e) => e.t)).not.toContain('interrupted');

      // Recovery finishes on its own terms, and only then does the sweep take over.
      releaseFirstDiscovery({ status: 'dead' });
      await recovering;
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a probe that was still in flight when shutdown began', async () => {
    // Clearing the interval does not stop a sweep already inside a probe, and that
    // probe can outlive the start of shutdown by the whole discovery timeout. Acting
    // on its verdict then would settle a marker `drainOnShutdown` deliberately leaves
    // OPEN so its external Worker survives the restart for D7 reattach — the sweep
    // would kill the very Runner the shutdown path is preserving.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-shutdown-race');
      const target = {
        turnId: 'turn-shutdown-race',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      };
      let discoverCalls = 0;
      let releaseProbe!: (outcome: RunnerRecoveryOutcome) => void;
      const probe = new Promise<RunnerRecoveryOutcome>((resolve) => {
        releaseProbe = resolve;
      });
      const recovery: RunnerRecovery = {
        discover: () => {
          discoverCalls += 1;
          // Call 1 is recovery's (reattach the live turn); call 2 is the sweep's probe.
          return discoverCalls === 1
            ? Promise.resolve<RunnerRecoveryOutcome>({ status: 'live', target })
            : probe;
        },
      };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
        runnerRecoveryDiscoverTimeoutMs: 60 * 60 * 1000,
      });

      await conductor.recover();
      // Drive the silent turn until the sweep enters its probe, then leave it parked.
      for (let i = 0; i < 12 && discoverCalls < 2; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(discoverCalls).toBe(2);

      const draining = conductor.drainOnShutdown();
      // Shutdown waits only its documented bound for the already-running sweep;
      // advance that bound because fake timers do not move on their own.
      await vi.advanceTimersByTimeAsync(3_000);
      await draining;
      // The verdict lands after the sweep was stopped — it must be dropped, not acted on.
      releaseProbe({ status: 'dead' });
      await vi.advanceTimersByTimeAsync(0);

      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds).not.toContain('interrupted');
      expect(kinds).not.toContain('notice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a DEAD verdict whose turn was replaced by a successor while probing', async () => {
    // `cancelTurn` is keyed by SESSION, but the verdict is about one TURN. A probe runs
    // for up to the discovery timeout, and in that window the probed turn can settle on
    // its own and a queued successor can start. Acting on the stale verdict would then
    // kill a healthy new turn — the same session-keyed hazard the cancel paths guard.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-replaced');
      const target = {
        turnId: 'turn-replaced',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      };
      let discoverCalls = 0;
      let releaseProbe!: (outcome: RunnerRecoveryOutcome) => void;
      const probe = new Promise<RunnerRecoveryOutcome>((resolve) => {
        releaseProbe = resolve;
      });
      const recovery: RunnerRecovery = {
        discover: () => {
          discoverCalls += 1;
          return discoverCalls === 1
            ? Promise.resolve<RunnerRecoveryOutcome>({ status: 'live', target })
            : probe;
        },
      };
      let settleFirstTurn!: (result: RunResult) => void;
      const firstResult = new Promise<RunResult>((resolve) => {
        settleFirstTurn = resolve;
      });
      const runner = fakeAttachRunner(firstResult);
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
        runnerRecoveryDiscoverTimeoutMs: 60 * 60 * 1000,
      });

      await conductor.recover();
      for (let i = 0; i < 12 && discoverCalls < 2; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(discoverCalls).toBe(2); // probe is parked, verdict pending

      // The probed turn finishes on its own while the probe is still outstanding.
      settleFirstTurn({ sessionId: 's1', exitCode: 0, stderr: '', aborted: false });
      for (let i = 0; i < 10 && (await ctx.store.listRunningTurns()).length > 0; i += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);

      // A successor turn takes the session over.
      const { seq: successorSeq } = await ctx.store.appendEvent('s1', {
        t: 'prompt',
        text: 'next',
      });
      await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: successorSeq });
      await ctx.store.bindTurnIdentity('s1', {
        turnId: 'turn-successor',
        startCommandId: 'turn-successor-start',
      });

      // The verdict — true of the OLD turn — lands now. It must not touch the new one.
      releaseProbe({ status: 'dead' });
      await vi.advanceTimersByTimeAsync(0);

      const markers = await ctx.store.listRunningTurns();
      expect(markers).toHaveLength(1);
      expect(markers[0]?.turnId).toBe('turn-successor');
      const afterSuccessor = (await ctx.store.getEventsAfter('s1', successorSeq)).map(
        (e) => e.event.t,
      );
      expect(afterSuccessor).not.toContain('interrupted');
      expect(afterSuccessor).not.toContain('notice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a DEAD verdict whose turn settled during the final revalidation', async () => {
    // The last guard before settling is a marker READ, and a read can be overtaken by
    // what it is checking for: the probed turn can settle in the gap between the row
    // being fetched and the caller acting on it. The settle is therefore aimed at the
    // handle that was probed, not at the session — this drives exactly that gap.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-late');
      const target = {
        turnId: 'turn-late',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      };
      let discoverCalls = 0;
      let releaseProbe!: (outcome: RunnerRecoveryOutcome) => void;
      const probe = new Promise<RunnerRecoveryOutcome>((resolve) => {
        releaseProbe = resolve;
      });
      const recovery: RunnerRecovery = {
        discover: () => {
          discoverCalls += 1;
          return discoverCalls === 1
            ? Promise.resolve<RunnerRecoveryOutcome>({ status: 'live', target })
            : probe;
        },
      };
      let settleProbedTurn!: (result: RunResult) => void;
      const probedResult = new Promise<RunResult>((resolve) => {
        settleProbedTurn = resolve;
      });
      const runner = fakeAttachRunner(probedResult);

      // A store whose marker snapshot goes stale in the caller's hands: the row is read
      // first, the probed turn settles and hands the session to a successor second, and
      // only then does the read return the row the session has already left behind.
      let staleTheNextRead = false;
      let successorSeq = 0;
      const store = Object.assign(Object.create(ctx.store) as typeof ctx.store, {
        listRunningTurns: async () => {
          const snapshot = await ctx.store.listRunningTurns();
          if (staleTheNextRead) {
            staleTheNextRead = false;
            settleProbedTurn({ sessionId: 's1', exitCode: 0, stderr: '', aborted: false });
            for (let i = 0; i < 20 && (await ctx.store.listRunningTurns()).length > 0; i += 1) {
              await vi.advanceTimersByTimeAsync(0);
            }
            successorSeq = (await ctx.store.appendEvent('s1', { t: 'prompt', text: 'next' })).seq;
            await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: successorSeq });
            await ctx.store.bindTurnIdentity('s1', {
              turnId: 'turn-successor',
              startCommandId: 'turn-successor-start',
            });
          }
          return snapshot;
        },
      });
      const conductor = new Conductor({
        store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
        runnerRecoveryDiscoverTimeoutMs: 60 * 60 * 1000,
      });

      await conductor.recover();
      for (let i = 0; i < 12 && discoverCalls < 2; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(discoverCalls).toBe(2); // probe is parked, verdict pending

      staleTheNextRead = true; // the revalidation is the next marker read
      releaseProbe({ status: 'dead' });
      for (let i = 0; i < 20 && staleTheNextRead; i += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(0);

      // The verdict was true of a turn that is already gone, so it must add nothing to
      // the successor now holding the session.
      const markers = await ctx.store.listRunningTurns();
      expect(markers).toHaveLength(1);
      expect(markers[0]?.turnId).toBe('turn-successor');
      const afterSuccessor = (await ctx.store.getEventsAfter('s1', successorSeq)).map(
        (e) => e.event.t,
      );
      expect(afterSuccessor).not.toContain('interrupted');
      expect(afterSuccessor).not.toContain('notice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches from a confirmed-dead Runner instead of leaving its tail attached', async () => {
    // A `dead` verdict finalizes the turn without the cancel round-trip — there is no
    // one on the control socket to answer it. That must not mean staying attached: the
    // reattached turn's frame tail runs until its own force-cancel aborts it, so
    // skipping BOTH would leak a tail (and an in-process backend) per dead Runner.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-dead-runner');
      let outcome: RunnerRecoveryOutcome = {
        status: 'live',
        target: {
          turnId: 'turn-dead-runner',
          sessionId: 's1',
          eventFilePath: '/rt/events.jsonl',
          controlSocketPath: '/rt/control.sock',
        },
      };
      const recovery: RunnerRecovery = { discover: async () => outcome };
      let cancels = 0;
      let forceCancels = 0;
      const closeSession = vi.fn();
      const runner: RunnerClient = {
        startTurn: () => {
          throw new Error('startTurn must not be called on a reattach');
        },
        attach: () => ({
          result: new Promise<RunResult>(() => undefined), // never speaks again
          steer: () => Promise.resolve(true),
          answerPermission: () => Promise.resolve(true),
          cancel: () => {
            cancels += 1;
            return Promise.resolve(true);
          },
          forceCancel: () => {
            forceCancels += 1;
            return Promise.resolve(true);
          },
        }),
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: { ...inertBackend, closeSession },
        worktreeExists: async () => true,
        runner: () => runner,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      expect(conductor.isBusy('s1')).toBe(true);

      outcome = { status: 'dead' };
      for (let i = 0; i < 40 && conductor.isBusy('s1'); i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(conductor.isBusy('s1')).toBe(false);
      // Detached out-of-band (which is what stops the tail), never through the dead
      // Runner's per-turn control socket.
      expect(forceCancels).toBe(1);
      expect(cancels).toBe(0);
      expect(closeSession).toHaveBeenCalledWith('s1');
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a DEAD verdict whose Runner starts speaking again before the settle', async () => {
    // `dead` is also what an unreachable Sandbox looks like. The notice lands on proof
    // of silence, but the settle follows it after another read — and a Runner that says
    // something in that gap has just disproved the verdict it was about to be killed on.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-speaks-again');
      const target = {
        turnId: 'turn-speaks-again',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      };
      let discoverCalls = 0;
      const recovery: RunnerRecovery = {
        discover: () => {
          discoverCalls += 1;
          return Promise.resolve<RunnerRecoveryOutcome>(
            discoverCalls === 1 ? { status: 'live', target } : { status: 'dead' },
          );
        },
      };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));

      // The revalidation's own marker read is where the turn speaks: after the notice
      // was written, before anything destructive has happened.
      let pendingSpeech = true;
      const store = Object.assign(Object.create(ctx.store) as typeof ctx.store, {
        listRunningTurns: async () => {
          const snapshot = await ctx.store.listRunningTurns();
          if (pendingSpeech && discoverCalls >= 2) {
            pendingSpeech = false;
            await ctx.store.appendEvent('s1', { t: 'text', delta: 'back from the build' });
          }
          return snapshot;
        },
      });
      const conductor = new Conductor({
        store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      for (let i = 0; i < 40 && pendingSpeech; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(pendingSpeech).toBe(false); // the probe ran and the verdict was `dead`
      await vi.advanceTimersByTimeAsync(0);

      expect(conductor.isBusy('s1')).toBe(true);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
      // Refusing the terminal event is not enough on its own: the settle would still have
      // killed the Runner that just proved itself alive, and no rejected append undoes that.
      expect(runner.cancelCount).toBe(0);
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds).toContain('notice'); // written while it was still true, and kept
      expect(kinds).not.toContain('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a session whose turn was replaced while its uncertain probe ran', async () => {
    // The bounded retry re-reads the marker on entry, then spends up to the discovery
    // timeout asking about the Runner. Settling on what it learns without looking again
    // would interrupt whatever holds the session by then and clear THAT turn's marker.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-overtaken');
      let discoverCalls = 0;
      let releaseRetryProbe!: (outcome: RunnerRecoveryOutcome) => void;
      const retryProbe = new Promise<RunnerRecoveryOutcome>((resolve) => {
        releaseRetryProbe = resolve;
      });
      const recovery: RunnerRecovery = {
        discover: () => {
          discoverCalls += 1;
          return discoverCalls === 1
            ? Promise.resolve<RunnerRecoveryOutcome>({ status: 'uncertain' })
            : retryProbe;
        },
      };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      const conductor = new Conductor({
        store: ctx.store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
        runnerRecoveryDiscoverTimeoutMs: 60 * 60 * 1000,
      });

      await conductor.recover();
      for (let i = 0; i < 10 && discoverCalls < 2; i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(discoverCalls).toBe(2); // the retry's probe is parked, verdict pending

      // The session moves on underneath it: the abandoned turn is settled and a new one
      // takes the marker.
      await ctx.store.clearRunningTurn('s1');
      const { seq: successorSeq } = await ctx.store.appendEvent('s1', {
        t: 'prompt',
        text: 'next',
      });
      await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: successorSeq });
      await ctx.store.bindTurnIdentity('s1', {
        turnId: 'turn-successor',
        startCommandId: 'turn-successor-start',
      });

      releaseRetryProbe({ status: 'dead' });
      await vi.advanceTimersByTimeAsync(0);

      const markers = await ctx.store.listRunningTurns();
      expect(markers).toHaveLength(1);
      expect(markers[0]?.turnId).toBe('turn-successor');
      const afterSuccessor = (await ctx.store.getEventsAfter('s1', successorSeq)).map(
        (e) => e.event.t,
      );
      expect(afterSuccessor).not.toContain('interrupted');
      expect(afterSuccessor).not.toContain('notice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the turn when the notice its settle rests on cannot be written', async () => {
    // The conditional append is not decoration: landing it is what proves the marker
    // still anchors the probed turn and that the turn has stayed silent since the
    // verdict was formed. A write that FAILED proves neither, so treating a store blip
    // as license to settle would interrupt a turn that may have finished a second ago.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-notice-unwritable');
      let outcome: RunnerRecoveryOutcome = {
        status: 'live',
        target: {
          turnId: 'turn-notice-unwritable',
          sessionId: 's1',
          eventFilePath: '/rt/events.jsonl',
          controlSocketPath: '/rt/control.sock',
        },
      };
      const recovery: RunnerRecovery = { discover: async () => outcome };
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      let attemptedWrites = 0;
      const store = Object.assign(Object.create(ctx.store) as typeof ctx.store, {
        appendEventForRunningTurn: async () => {
          attemptedWrites += 1;
          throw new Error('event log unavailable');
        },
      });
      const conductor = new Conductor({
        store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      outcome = { status: 'dead' };
      for (let i = 0; i < 60 && attemptedWrites < 2; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      // Probed, judged dead, and still standing — each window tries the write again.
      expect(attemptedWrites).toBeGreaterThanOrEqual(2);
      expect(conductor.isBusy('s1')).toBe(true);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
      expect((await ctx.store.getEvents('s1')).map((e) => e.t)).not.toContain('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an exhausted settle out of the turn that replaced it', async () => {
    // The settle still spans several awaits after its last marker read, and Stop can
    // force-settle this turn and drain the next prompt inside that gap. Re-reading the
    // marker before the writes narrows the window but cannot close it: only anchoring
    // each write to this turn keeps its `interrupted` out of the successor's transcript,
    // where it would end a turn that is genuinely running.
    vi.useFakeTimers();
    try {
      const promptSeq = await seedMarker('turn-replaced-mid-settle');
      const { recovery } = fakeRecovery({ status: 'uncertain' });
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      let swapped = false;
      const store = Object.assign(Object.create(ctx.store) as typeof ctx.store, {
        appendEventForRunningTurn: async (
          sessionId: string,
          anchor: RunningTurnRecord & { silentSinceSeq: number },
          event: AgentEvent,
        ) => {
          if (event.t === 'interrupted' && !swapped) {
            swapped = true;
            await ctx.store.clearRunningTurn('s1', promptSeq);
            const next = await ctx.store.appendEvent('s1', { t: 'prompt', text: 'next' });
            await ctx.store.markTurnRunning({ sessionId: 's1', promptSeq: next.seq });
            await ctx.store.bindTurnIdentity('s1', {
              turnId: 'turn-successor',
              startCommandId: 'turn-successor-start',
            });
          }
          return await ctx.store.appendEventForRunningTurn(sessionId, anchor, event);
        },
      });
      const conductor = new Conductor({
        store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      for (let i = 0; i < 80 && !swapped; i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(swapped).toBe(true); // the bound was spent and the settle reached its write
      await vi.advanceTimersByTimeAsync(30_000);

      const markers = await ctx.store.listRunningTurns();
      expect(markers).toHaveLength(1);
      expect(markers[0]?.turnId).toBe('turn-successor');
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds).not.toContain('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces an exhausted uncertain recovery once, however often its settle is retried', async () => {
    // Past the bound, every retry re-enters the give-up branch — the bound is already
    // spent. A settle that fails before writing its terminal event therefore comes back
    // through here, and an unconditional notice would stack one copy per attempt.
    vi.useFakeTimers();
    try {
      await seedMarker('turn-exhausted-retry');
      const { recovery } = fakeRecovery({ status: 'uncertain' });
      const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
      let failedInterrupts = 2;
      const store = Object.assign(Object.create(ctx.store) as typeof ctx.store, {
        appendEventForRunningTurn: async (
          sessionId: string,
          anchor: RunningTurnRecord & { silentSinceSeq: number },
          event: AgentEvent,
        ) => {
          if (event.t === 'interrupted' && failedInterrupts > 0) {
            failedInterrupts -= 1;
            throw new Error('event log unavailable');
          }
          return await ctx.store.appendEventForRunningTurn(sessionId, anchor, event);
        },
      });
      const conductor = new Conductor({
        store,
        backend: inertBackend,
        worktreeExists: async () => true,
        runner: runner.factory,
        runnerRecovery: recovery,
      });

      await conductor.recover();
      for (let i = 0; i < 80 && conductor.isBusy('s1'); i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }

      expect(failedInterrupts).toBe(0); // the settle really was retried
      expect(conductor.isBusy('s1')).toBe(false);
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds.filter((kind) => kind === 'notice')).toHaveLength(1);
      expect(kinds.at(-1)).toBe('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles (interrupted) on a DEAD discovery, exactly like the seam-less default', async () => {
    await seedMarker('turn-3');
    const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
    const { recovery } = fakeRecovery({ status: 'dead' });

    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: runner.factory,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    expect(runner.attachTargets).toEqual([]);
    expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('settles as interrupted when no discovery seam is configured, even with a bound turnId', async () => {
    await seedMarker('turn-4');
    const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));

    // No `runnerRecovery` → the seam is opt-in, so recovery keeps the legacy behavior.
    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: runner.factory,
    });
    await conductor.recover();

    expect(runner.attachTargets).toEqual([]);
    expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('settles when the configured runner cannot reattach (no attach method)', async () => {
    await seedMarker('turn-5');
    const { recovery } = fakeRecovery({
      status: 'live',
      target: {
        turnId: 'turn-5',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      },
    });
    // A runner WITHOUT `attach` (the loopback shape) cannot reattach → settle.
    const startOnly: RunnerClient = {
      startTurn: () => {
        throw new Error('startTurn must not be called on a reattach');
      },
    };

    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: () => startOnly,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
  });

  it('settles + releases without a re-run when attach throws synchronously mid-setup', async () => {
    const seq = await seedMarker('turn-6');
    const { recovery } = fakeRecovery({
      status: 'live',
      target: {
        turnId: 'turn-6',
        sessionId: 's1',
        eventFilePath: '/rt/events.jsonl',
        controlSocketPath: '/rt/control.sock',
      },
    });
    // A runner whose `attach` throws AFTER the in-flight lock/handle are taken — the
    // reattach must not leak the lock or leave the prompt to be re-run (SR-1).
    const runStarts: string[] = [];
    const throwingRunner: RunnerClient = {
      startTurn: (opts) => {
        runStarts.push(opts.prompt ?? '');
        throw new Error('startTurn must not run');
      },
      attach: () => {
        throw new Error('attach blew up');
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: () => throwingRunner,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    // Settled (interrupted), marker cleared, lock released, and — crucially — the
    // trailing prompt at `seq` was NOT re-dispatched as a fresh turn.
    expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
    expect(conductor.isBusy('s1')).toBe(false);
    expect(runStarts).toEqual([]);
    expect(seq).toBeGreaterThan(0);
  });

  it('bounds a hanging discovery: a seam that never resolves degrades to uncertain', async () => {
    await seedMarker('turn-7');
    const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
    // A discover that never settles must not wedge recovery — the timeout degrades it
    // to `uncertain`, keeping the marker (never wrongly interrupting a possibly-live turn).
    const recovery: RunnerRecovery = {
      discover: () => new Promise<RunnerRecoveryOutcome>(() => undefined),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: runner.factory,
      runnerRecovery: recovery,
      runnerRecoveryDiscoverTimeoutMs: 10,
    });
    await conductor.recover();

    expect(runner.attachTargets).toEqual([]);
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).not.toContain('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(1); // uncertain → marker kept
  });

  it('S5 drops the marker without reattaching when a terminal event is already in the log (D7 step 3)', async () => {
    const promptSeq = await seedMarker('turn-done');
    // The turn actually FINISHED before the crash — only the marker cleanup was lost.
    // A terminal `result` sits after the prompt in the log.
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    const runner = fakeAttachRunner(new Promise<RunResult>(() => undefined));
    // A LIVE discovery seam is available but must NOT be consulted — the terminal-in-log
    // short-circuit fires first, so `discover` is never called and nothing reattaches.
    const { recovery, calls } = fakeRecovery({
      status: 'live',
      target: {
        turnId: 'turn-done',
        sessionId: 's1',
        eventFilePath: '/rt/e.jsonl',
        controlSocketPath: '/rt/c.sock',
      },
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: inertBackend,
      worktreeExists: async () => true,
      runner: runner.factory,
      runnerRecovery: recovery,
    });
    await conductor.recover();

    // Never discovered, never reattached, never re-run.
    expect(calls).toEqual([]);
    expect(runner.attachTargets).toEqual([]);
    expect(runner.startTurnCalled).toBe(false);
    // Marker dropped; the session is free again.
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
    expect(conductor.isBusy('s1')).toBe(false);
    // NO double-run: recovery appended no `interrupted`, and did not add a second `result`.
    const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
    expect(kinds).not.toContain('interrupted');
    expect(kinds.filter((t) => t === 'result')).toHaveLength(1);
    expect(promptSeq).toBeGreaterThan(0);
  });
});

// The `.jsonl` restore-before-resume / tail-only-new-lines behaviour lived in the
// retired native runner. It now belongs to the Runner's transcript sink and is
// covered there (packages/server/src/runner-transcript.test.ts); the Conductor only
// forwards `transcript`/`claudeHome` into the turn options.

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error('waitFor: condition not met in time');
}

describe('Conductor.startSession', () => {
  it('spawns a fresh agent run, resolves the minted id, and persists the session', async () => {
    const fake = scriptedBackend({ sessionId: 'claude-xyz', model: 'sonnet', text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    const { sessionId } = await conductor.startSession({ worktree: '/wt/new', prompt: 'do x' });

    expect(sessionId).toBe('claude-xyz');
    expect(fake.last()).toMatchObject({
      cwd: '/wt/new',
      worktree: '/wt/new',
      prompt: 'do x',
      // Steerable (#101): the first turn holds its input channel open too.
      steerable: true,
    });
    expect(fake.last().resumeSessionId).toBeUndefined(); // fresh run, not a resume
    // The choices contract is installed on the first turn too (issue #97).
    const appended = fake.last().appendSystemPrompt ?? '';
    expect(appended).toContain(CHOICES_SYSTEM_PROMPT);
    expect(appended).toContain(DELEGATION_SYSTEM_PROMPT);
    expect(appended).toContain(MEMORY_SYSTEM_PROMPT);
    expect(appended).toContain(TERMINOLOGY_SYSTEM_PROMPT);
    expect(appended).toContain(PULL_REQUEST_SYSTEM_PROMPT);
    expect(appended).toContain(REPO_CONVENTIONS_SYSTEM_PROMPT);
    expect(appended).toContain(CODE_REVIEW_SYSTEM_PROMPT);
    expect(appended).toContain(LANGUAGE_SYSTEM_PROMPT);
    expect(appended).toContain(SANDBOX_RESOURCES_SYSTEM_PROMPT);
    // Once, not twice. The sandbox rule is the only fragment that appears in both
    // the turn prompt and the resume set, so it is the only one a future refactor
    // could concatenate rather than choose between — and `toContain` above would
    // not notice.
    expect(appended.split(SANDBOX_RESOURCES_SYSTEM_PROMPT)).toHaveLength(2);
    // The same guard for the two review/convention fragments: they sit outside the
    // local-project ternary precisely so both branches inherit them, which is also
    // the shape that makes duplicating them into a branch an easy mistake.
    expect(appended.split(REPO_CONVENTIONS_SYSTEM_PROMPT)).toHaveLength(2);
    expect(appended.split(CODE_REVIEW_SYSTEM_PROMPT)).toHaveLength(2);
    expect(await ctx.store.getSession('claude-xyz')).toMatchObject({
      sessionId: 'claude-xyz',
      worktree: '/wt/new',
    });

    await waitFor(() => !conductor.isBusy(sessionId)); // background run settles
    expect(conductor.isBusy(sessionId)).toBe(false); // lock released after completion
  });

  it('seeds a spawn with attachments: hands the runner the image and refs it on the prompt event', async () => {
    const fake = scriptedBackend({ sessionId: 'claude-img', model: 'sonnet', text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    const { sessionId } = await conductor.startSession({
      worktree: '/wt/img',
      prompt: 'fix this screenshot',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
    });
    await waitFor(() => !conductor.isBusy(sessionId)); // let the background run settle

    // The seed turn carries the prompt text AND the image.
    expect(fake.last()).toMatchObject({
      prompt: 'fix this screenshot',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
    });
    // The persisted prompt event references the blob by id (NOT inline base64), so
    // the seed image renders in the transcript and the bytes are recoverable.
    const events = await ctx.store.getEvents(sessionId);
    const prompt = events.find((e) => e.t === 'prompt');
    expect(prompt).toMatchObject({
      t: 'prompt',
      text: 'fix this screenshot',
      attachments: [{ kind: 'image', mediaType: 'image/png', id: expect.any(String) }],
    });
    const ref = prompt?.t === 'prompt' ? prompt.attachments?.[0] : undefined;
    expect(ref && 'data' in ref).toBe(false); // no inline base64 on the event
    const blob = await ctx.store.getAttachment(ref?.id ?? '');
    expect(blob?.bytes.toString('base64')).toBe('aGk=');
  });

  it('drains a turn queued during the initial run once startSession settles (#90)', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bus = new InMemoryEventBus();
    const prompts: string[] = [];
    const conductor = new Conductor({
      store: ctx.store,
      bus,
      // Binds 'claude-xyz' → startSession resolves with the lock still held, while
      // the initial run keeps going in the background until `release()`.
      backend: gatedBackend(gate, { sessionId: 'claude-xyz' }).backend,
      worktreeExists: async () => true,
    });

    const { sessionId } = await conductor.startSession({ worktree: '/wt/new', prompt: 'start' });
    const [marker] = await ctx.store.listRunningTurns();
    expect(marker).toMatchObject({
      sessionId,
      promptSeq: expect.any(Number),
      turnId: expect.any(String),
      startCommandId: expect.any(String),
    });
    bus.subscribe(sessionId, (se) => {
      if (se.event.t === 'prompt') prompts.push(se.event.text);
    });
    expect(conductor.isBusy(sessionId)).toBe(true); // the initial run is still in flight

    // The operator sends a turn while the initial run is still going → queued.
    expect(await conductor.dispatchTurn(sessionId, 'follow-up')).toEqual({ queued: true });
    expect(conductor.queuedCount(sessionId)).toBe(1);

    release(); // the initial run settles → the queued turn must drain (not be stranded)
    // The queued 'follow-up' runs (its prompt emits). The initial 'start' prompt
    // may or may not be captured depending on subscribe timing, so assert on the
    // thing under test: the queued turn drained.
    await vi.waitFor(() => {
      expect(prompts).toContain('follow-up');
      expect(conductor.queuedCount(sessionId)).toBe(0);
      expect(conductor.isBusy(sessionId)).toBe(false);
    });
  });

  it('persists an initial cancellation before draining a queued successor', async () => {
    const fake = scriptedBackend((_opts, attempt) =>
      attempt === 1 ? { sessionId: 's-initial-cancel', abortable: true } : {},
    );
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    const { sessionId } = await conductor.startSession({
      worktree: '/wt/initial-cancel',
      prompt: 'first',
    });
    expect(await conductor.dispatchTurn(sessionId, 'second')).toEqual({ queued: true });
    await conductor.cancelTurn(sessionId);
    await waitFor(() => !conductor.isBusy(sessionId));

    const events = await ctx.store.getEvents(sessionId);
    const interrupted = events.findIndex((event) => event.t === 'interrupted');
    const secondPrompt = events.findIndex(
      (event) => event.t === 'prompt' && event.text === 'second',
    );
    expect(interrupted).toBeGreaterThanOrEqual(0);
    expect(secondPrompt).toBeGreaterThan(interrupted);
  });

  it('persists the operator prompt ordered before the agent output on a fresh start', async () => {
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({ sessionId: 's-order', model: 'sonnet', text: 'hi' }).backend,
    });

    const { sessionId } = await conductor.startSession({ worktree: '/wt/order', prompt: 'do x' });
    await waitFor(() => !conductor.isBusy(sessionId)); // let the background run settle

    // onSession is awaited through ingest, so the prompt INSERT lands BETWEEN the
    // binding `session` event and claude's first `text` — never racing after it.
    const events = await ctx.store.getEvents('s-order');
    expect(events.map((e) => e.t)).toEqual(['session', 'prompt', 'text', 'result']);
    const prompt = events.find((e) => e.t === 'prompt');
    expect(prompt).toMatchObject({ t: 'prompt', text: 'do x' });
  });

  it('can seed a fresh context with hidden runtime instructions', async () => {
    const putAttachment = vi.spyOn(ctx.store, 'putAttachment');
    const fake = scriptedBackend({ sessionId: 's-hidden', model: 'sonnet', text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
    });

    const { sessionId } = await conductor.startSession({
      worktree: '/wt/hidden',
      prompt: 'initialize control plane',
      appendSystemPrompt: 'server-provided control-plane capabilities',
      persistPrompt: false,
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
    });
    await waitFor(() => !conductor.isBusy(sessionId));

    expect(fake.last().appendSystemPrompt).toContain('server-provided control-plane capabilities');
    expect((await ctx.store.getEvents(sessionId)).map((event) => event.t)).toEqual([
      'session',
      'text',
      'result',
    ]);
    expect(putAttachment).not.toHaveBeenCalled();
  });

  /** Give a fresh precreated session a project of the requested kind and return
   *  the runtime prompt its first turn is launched with. */
  async function freshTurnSystemPrompt(
    sessionId: string,
    kind: 'github' | 'local',
  ): Promise<string> {
    await ctx.store.upsertProject({
      id: `project-${sessionId}`,
      owner: kind === 'local' ? '__local__' : 'acme',
      repo: sessionId,
      containerName: `verity-${sessionId}`,
      state: 'active',
      kind,
    });
    await ctx.store.createSession({
      sessionId,
      worktree: `/wt/${sessionId}`,
      model: 'm',
      projectId: `project-${sessionId}`,
    });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        await opts.onSession?.(`backend-${sessionId}`);
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });
    await conductor.sendTurn(sessionId, 'go');
    return captured?.appendSystemPrompt ?? '';
  }

  it('drops the pull-request directive for a project with no GitHub repository', async () => {
    const appended = await freshTurnSystemPrompt('s-local-project', 'local');

    // The clone has no `origin`, so the review-ready-PR rule is not just inert
    // here: together with the Quick-Action contract's own "Push + PR" example it
    // is what makes the agent offer a chip whose turn cannot succeed. Replaced,
    // not merely supplemented, so nothing in the context still asks for a push.
    expect(appended).toContain(LOCAL_PROJECT_SYSTEM_PROMPT);
    expect(appended).not.toContain(PULL_REQUEST_SYSTEM_PROMPT);
    // Everything that is not remote-bound is unchanged.
    expect(appended).toContain(CHOICES_SYSTEM_PROMPT);
    expect(appended).toContain(TERMINOLOGY_SYSTEM_PROMPT);
    expect(appended).toContain(MEMORY_SYSTEM_PROMPT);
    // The cgroup is the sandbox's, not the project's: a local project runs under
    // the same limits as a GitHub-backed one. `LOCAL_PROJECT_TURN_SYSTEM_PROMPT`
    // is its own assembly, so it gets the same once-only guard as the others —
    // `toContain` alone would pass on a template that interpolated it twice.
    expect(appended).toContain(SANDBOX_RESOURCES_SYSTEM_PROMPT);
    expect(appended.split(SANDBOX_RESOURCES_SYSTEM_PROMPT)).toHaveLength(2);
    // Neither of these is remote-bound the way the pull-request rule is: a local
    // project still branches and commits, and it can be linked to GitHub later —
    // the window LOCAL_PROJECT_SYSTEM_PROMPT names its own expiry condition for.
    // Dropping them here would leave the session that outlives the link naming
    // branches the Issue chip cannot parse.
    expect(appended).toContain(REPO_CONVENTIONS_SYSTEM_PROMPT);
    expect(appended).toContain(CODE_REVIEW_SYSTEM_PROMPT);
    expect(appended.split(REPO_CONVENTIONS_SYSTEM_PROMPT)).toHaveLength(2);
    expect(appended.split(CODE_REVIEW_SYSTEM_PROMPT)).toHaveLength(2);
  });

  it('keeps the pull-request directive for a GitHub-backed project', async () => {
    const appended = await freshTurnSystemPrompt('s-github-project', 'github');

    expect(appended).toContain(PULL_REQUEST_SYSTEM_PROMPT);
    expect(appended).not.toContain(LOCAL_PROJECT_SYSTEM_PROMPT);
  });

  it('reclassifies a linked project on its next fresh context, not on resumed turns', async () => {
    // A local project can be linked to GitHub later. Project facts are snapshotted
    // when a backend context is created (as project memory and the server's session
    // prompt already are), so a live context keeps what it was told — which for a
    // prohibition would mean refusing pushes forever on a repo that now has a
    // remote. Two things bound that: a fresh context reads the new kind, and the
    // directive itself tells the agent to re-check `git remote` before claiming a
    // push is impossible. This pins the first half and the resume boundary.
    await ctx.store.upsertProject({
      id: 'project-linked',
      owner: '__local__',
      repo: 'linked',
      containerName: 'verity-linked',
      state: 'active',
      kind: 'local',
    });
    await ctx.store.createSession({
      sessionId: 's-linked',
      worktree: '/wt/linked',
      model: 'm',
      projectId: 'project-linked',
    });
    // A bound backend id makes every later turn a resume.
    await ctx.store.appendEvent('s-linked', {
      t: 'session',
      id: 's-linked',
      model: 'm',
      worktree: '/wt/linked',
    });
    const captured: RunTurnOptions[] = [];
    const backend: Backend = {
      run: async (opts) => {
        captured.push(opts);
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-linked', 'before linking');
    await ctx.store.linkProjectToGitHub('project-linked', { owner: 'acme', repo: 'linked' });
    await conductor.sendTurn('s-linked', 'after linking');

    // Resumed turns carry only the compact convergence directives — the local
    // note is not re-sent, but neither is it retracted from the live context.
    expect(captured).toHaveLength(2);
    for (const run of captured) {
      expect(run.appendSystemPrompt).not.toContain(LOCAL_PROJECT_SYSTEM_PROMPT);
      expect(run.appendSystemPrompt).not.toContain(PULL_REQUEST_SYSTEM_PROMPT);
    }
    // The directive carries its own expiry condition for exactly that window.
    expect(LOCAL_PROJECT_SYSTEM_PROMPT).toContain('git remote -v');
    // A fresh context in the same session now classifies as GitHub-backed.
    const relinked = await ctx.store.getProject('project-linked');
    expect(relinked).toMatchObject({ kind: 'github', owner: 'acme' });
    expect(await freshTurnSystemPrompt('s-linked-fresh', 'github')).toContain(
      PULL_REQUEST_SYSTEM_PROMPT,
    );
  });

  it('keeps the GitHub posture for a session that belongs to no project', async () => {
    // Control-plane and legacy sessions carry no project row to classify. Falling
    // back to "local" would silently stop them opening PRs, so the pre-existing
    // posture is the safe default for every session the lookup cannot resolve.
    await ctx.store.createSession({ sessionId: 's-no-project', worktree: '/wt/np', model: 'm' });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        await opts.onSession?.('backend-np');
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-no-project', 'go');

    expect(captured?.appendSystemPrompt).toContain(PULL_REQUEST_SYSTEM_PROMPT);
    expect(captured?.appendSystemPrompt).not.toContain(LOCAL_PROJECT_SYSTEM_PROMPT);
  });

  /** The heading of `BROKERED_HTTP_SYSTEM_PROMPT`, which stays private to
   *  `conductor.ts`. Matched as a literal rather than exported: the point of these
   *  tests is which transport receives that block at all, and exporting a prompt
   *  body only so a test can name it would widen the module's surface for nothing.
   *
   *  The cost of the literal is that a rename would make every `not.toContain` here
   *  pass vacuously. The native assertion below is the canary that stops that: it
   *  requires the heading to be PRESENT, so a rename fails there first. Keep at least
   *  one positive assertion on this constant. */
  const BROKERED_RULES_HEADING = '## Brokered secrets';

  /** Launch a project session's first turn on `supervisor`'s transport and return the
   *  runtime prompt it was launched with. */
  async function brokeredTurnSystemPrompt(
    sessionId: string,
    supervisor: RunnerSupervisorBackend | undefined,
    // An object rather than a bare resolver: "wired to a resolver that rejects" and
    // "not wired at all" are two of the cases under test, and a default parameter
    // collapses them — passing `undefined` for a resolver reinstates the default.
    deps: { brokeredSecretAliases?: (projectId: string) => Promise<readonly string[]> } = {
      brokeredSecretAliases: () => Promise.resolve(['ASC_API_KEY', 'EXAMPLE_TOKEN']),
    },
  ): Promise<string> {
    await ctx.store.upsertProject({
      id: `project-${sessionId}`,
      owner: 'acme',
      repo: sessionId,
      containerName: `verity-${sessionId}`,
      state: 'active',
      kind: 'github',
    });
    await ctx.store.createSession({
      sessionId,
      worktree: `/wt/${sessionId}`,
      model: 'm',
      projectId: `project-${sessionId}`,
    });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      ...(supervisor !== undefined ? { runnerSupervisorBackend: supervisor } : {}),
      run: async (opts) => {
        captured = opts;
        await opts.onSession?.(`backend-${sessionId}`);
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      ...deps,
    });
    await conductor.sendTurn(sessionId, 'go');
    return captured?.appendSystemPrompt ?? '';
  }

  // The names are the answer to "which `secretAlias` may I pass", and every transport
  // that can reach the brokered tools has to answer it. Gating them on the native relay
  // left ACP sessions guessing — and a guess is indistinguishable from the secret not
  // existing, which is what sends an agent looking for Doppler credentials instead.
  // `satisfies` pins these to the real union, so a renamed transport fails to compile
  // here rather than quietly dropping out of coverage. Adding one is caught on the
  // source side: `carriesBrokeredSecretTools` switches exhaustively, so a new member
  // has to be decided there before it can reach a turn at all.
  it.each(['claude-acp', 'codex-acp'] as const satisfies readonly RunnerSupervisorBackend[])(
    'lists the project secret names on the %s transport',
    async (supervisor) => {
      const appended = await brokeredTurnSystemPrompt(`s-alias-${supervisor}`, supervisor);

      expect(appended).toContain('ASC_API_KEY, EXAMPLE_TOKEN');
    },
  );

  // The other half of the same rule. A backend that declares no transport (OpenCode/Pi
  // on the loopback path) has no native relay and no MCP gateway, so it has no tool that
  // accepts a `secretAlias`. Handing it names would leave it holding a list it cannot
  // spend — the same dead end, made more inviting.
  it('omits the project secret names for a backend that declares no transport', async () => {
    const brokeredSecretAliases = vi.fn(() => Promise.resolve(['ASC_API_KEY', 'EXAMPLE_TOKEN']));

    const appended = await brokeredTurnSystemPrompt('s-alias-none', undefined, {
      brokeredSecretAliases,
    });

    expect(appended).toContain(TERMINOLOGY_SYSTEM_PROMPT); // the turn did reach the backend
    expect(appended).not.toContain('ASC_API_KEY');
    // Not merely dropped after the fact: a backend that cannot use the names must not
    // cost the provider a round trip either.
    expect(brokeredSecretAliases).not.toHaveBeenCalled();
  });

  // An ACP turn reads these rules beside the schema, as the MCP gateway's tool
  // descriptions (ADR 0014). Repeating them in the system prompt would ship a second
  // copy of the same security rules, paid for every turn and free to drift from the
  // copy the agent actually reads. The native Codex relay has no description channel,
  // so it is the one transport that still needs them spelled out here.
  // Every ACP transport, not just Claude's: a branch that leaked the rules block to
  // `codex-acp` alone would otherwise pass on the strength of the `claude-acp` case.
  it.each(['claude-acp', 'codex-acp'] as const satisfies readonly RunnerSupervisorBackend[])(
    'leaves the brokered-tool rules to the MCP tool descriptions on %s',
    async (supervisor) => {
      const appended = await brokeredTurnSystemPrompt(`s-rules-${supervisor}`, supervisor);

      expect(appended).toContain(TERMINOLOGY_SYSTEM_PROMPT); // the turn did reach the backend
      expect(appended).not.toContain(BROKERED_RULES_HEADING);
    },
  );

  // Best-effort by design: the broker re-checks every alias at call time, so a provider
  // outage costs discoverability and must not cost the turn.
  it('runs the turn without a name list when the lookup fails', async () => {
    const appended = await brokeredTurnSystemPrompt('s-alias-down', 'claude-acp', {
      brokeredSecretAliases: () => Promise.reject(new Error('doppler unreachable')),
    });

    expect(appended).not.toContain('Secret names available in this project');
    expect(appended).toContain(TERMINOLOGY_SYSTEM_PROMPT);
  });

  it('omits the name list when the deployment wires no resolver', async () => {
    const appended = await brokeredTurnSystemPrompt('s-alias-unwired', 'claude-acp', {});

    expect(appended).toContain(TERMINOLOGY_SYSTEM_PROMPT); // the turn did reach the backend
    expect(appended).not.toContain('Secret names available in this project');
  });

  it('fails the turn rather than guessing when the project lookup errors', async () => {
    // The classification is installed once and then lives for the whole backend
    // context, so a transient error must not be papered over: guessing "GitHub"
    // here would durably seed a remote-less project with the very push/PR
    // guidance this removes, and nothing would retry it.
    await ctx.store.upsertProject({
      id: 'project-flaky',
      owner: '__local__',
      repo: 'flaky',
      containerName: 'verity-flaky',
      state: 'active',
      kind: 'local',
    });
    await ctx.store.createSession({
      sessionId: 's-flaky',
      worktree: '/wt/flaky',
      model: 'm',
      projectId: 'project-flaky',
    });
    const getProject = vi
      .spyOn(ctx.store, 'getProject')
      .mockRejectedValueOnce(new Error('connection terminated'));
    const backend: Backend = {
      run: async (opts) => ({
        sessionId: opts.storeSessionId,
        exitCode: 0,
        stderr: '',
        aborted: false,
      }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s-flaky', 'go')).rejects.toThrow(/connection terminated/);
    getProject.mockRestore();
  });

  it('releases the start lock when a spawn cannot classify its project', async () => {
    // The classification read is the first await after the worktree start lock is
    // taken, and the lock is otherwise released only from inside the run promise.
    // A throwing read that skipped that release would leave the worktree
    // permanently unstartable — SessionBusyError for the conductor's lifetime.
    await ctx.store.upsertProject({
      id: 'project-lock',
      owner: '__local__',
      repo: 'lock',
      containerName: 'verity-lock',
      state: 'active',
      kind: 'local',
    });
    await ctx.store.createSession({
      sessionId: 's-lock',
      worktree: '/wt/lock',
      model: 'm',
      projectId: 'project-lock',
    });
    const getProject = vi
      .spyOn(ctx.store, 'getProject')
      .mockRejectedValueOnce(new Error('connection terminated'));
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({ sessionId: 's-lock', model: 'sonnet', text: 'hi' }).backend,
    });
    const start = { sessionId: 's-lock', worktree: '/wt/lock', prompt: 'start here' };

    await expect(conductor.startSession(start)).rejects.toThrow(/connection terminated/);

    // The retry (store healthy again) must not report the worktree as busy.
    const { sessionId } = await conductor.startSession(start);
    await waitFor(() => !conductor.isBusy(sessionId));
    expect(getProject).toHaveBeenCalledTimes(2);
    getProject.mockRestore();
  });

  it('classifies a spawn under a preallocated id from its own session row', async () => {
    // The Agent Loop spawn path writes the session (with its project) before it
    // asks for the run, so the fresh context a spawn installs is classified by
    // the same lookup the turn path uses — no second, caller-supplied channel.
    await ctx.store.upsertProject({
      id: 'project-local-spawn',
      owner: '__local__',
      repo: 'notes',
      containerName: 'verity-local-spawn',
      state: 'active',
      kind: 'local',
    });
    await ctx.store.createSession({
      sessionId: 's-local-spawn',
      worktree: '/wt/local-spawn',
      model: 'm',
      projectId: 'project-local-spawn',
    });
    const fake = scriptedBackend({ sessionId: 's-local-spawn', model: 'sonnet', text: 'hi' });
    const conductor = new Conductor({ store: ctx.store, backend: fake.backend });

    const { sessionId } = await conductor.startSession({
      sessionId: 's-local-spawn',
      worktree: '/wt/local-spawn',
      prompt: 'start here',
    });
    await waitFor(() => !conductor.isBusy(sessionId));

    const appended = fake.last().appendSystemPrompt ?? '';
    expect(appended).toContain(LOCAL_PROJECT_SYSTEM_PROMPT);
    expect(appended).not.toContain(PULL_REQUEST_SYSTEM_PROMPT);
  });

  it('rejects an empty prompt', async () => {
    const conductor = new Conductor({ store: ctx.store, backend: unreachableBackend().backend });
    await expect(conductor.startSession({ worktree: '/wt/x', prompt: '   ' })).rejects.toThrow(
      /non-empty/,
    );
  });

  it('rejects a concurrent start for the same worktree', async () => {
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({ sessionId: 's-dup' }).backend,
    });
    const first = conductor.startSession({ worktree: '/wt/dup', prompt: 'a' });
    // Second is rejected WHILE the first still holds the worktree lock...
    await expect(conductor.startSession({ worktree: '/wt/dup', prompt: 'b' })).rejects.toThrow(
      SessionBusyError,
    );
    // ...and the first actually proceeded (it was the lock holder, not a spurious reject).
    const { sessionId } = await first;
    expect(sessionId).toBe('s-dup');
    await waitFor(() => !conductor.isBusy(sessionId));
  });

  it('rejects + releases the lock when the bound worktree is already taken (store UNIQUE)', async () => {
    await ctx.store.createSession({ sessionId: 'existing', worktree: '/wt/taken', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      // A fresh run whose agent mints a NEW id but binds the already-taken
      // worktree → createSession hits the worktree-UNIQUE constraint inside
      // bindSession, BEFORE onSession fires.
      backend: scriptedBackend({ sessionId: 'newcomer' }).backend,
    });

    const err = await conductor
      .startSession({ worktree: '/wt/taken', prompt: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SessionBusyError); // the DB UNIQUE error, not a lock error
    // No inFlight leak for the would-be id, and the worktree lock is released so a
    // retry isn't synchronously blocked by a stale `starting` entry (it reaches the
    // spawner + DB again → rejects with the DB error, not a SessionBusyError).
    expect(conductor.isBusy('newcomer')).toBe(false);
    const retry = await conductor
      .startSession({ worktree: '/wt/taken', prompt: 'y' })
      .catch((e: unknown) => e);
    expect(retry).not.toBeInstanceOf(SessionBusyError);
  });

  it('rejects if the run ends without ever binding a session', async () => {
    // A run that settles cleanly but never named a session: nothing to resolve
    // `startSession` with.
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({ sessionId: null, omitResult: true }).backend,
    });
    await expect(conductor.startSession({ worktree: '/wt/none', prompt: 'x' })).rejects.toThrow(
      /no session (?:event|init)/,
    );
  });

  it('rejects if the backend fails before binding', async () => {
    const conductor = new Conductor({
      store: ctx.store,
      backend: {
        run: () => Promise.reject(new Error('spawn failed')),
      },
    });
    await expect(conductor.startSession({ worktree: '/wt/err', prompt: 'x' })).rejects.toThrow(
      /spawn failed/,
    );
  });

  it('routes a failure AFTER the session binds to onTurnError', async () => {
    const errors: Array<{ id: string; message: string }> = [];
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({
        sessionId: 's-fail',
        during: () => {
          throw new Error('mid-stream boom');
        },
      }).backend,
      onTurnError: (id, err) => errors.push({ id, message: err.message }),
    });

    const { sessionId } = await conductor.startSession({ worktree: '/wt/fail', prompt: 'x' });
    expect(sessionId).toBe('s-fail'); // bound + resolved before the failure

    await waitFor(() => errors.length > 0);
    expect(errors[0]).toMatchObject({ id: 's-fail' });
    expect(conductor.isBusy('s-fail')).toBe(false); // lock released on failure too
  });

  it('routes a failed prompt INSERT to onTurnError without killing the live run', async () => {
    const errors: Array<{ id: string; message: string }> = [];
    // A store whose appendEvent rejects for the operator-prompt event only — the
    // failure path of emitPrompt on the start path. The rest of the run (text,
    // result) must still persist: a lost prompt event can't take the session down.
    const store = new Proxy(ctx.store, {
      get(target, prop, recv: unknown) {
        if (prop === 'appendEvent') {
          return async (
            sessionId: string,
            event: AgentEvent,
          ): Promise<{ seq: number; ts: number }> => {
            if (event.t === 'prompt') throw new Error('prompt insert boom');
            return target.appendEvent(sessionId, event);
          };
        }
        // Reflect.get is typed `any`; narrow to unknown so the proxy passthrough
        // doesn't trip no-unsafe-return (the value is delegated verbatim either way).
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const conductor = new Conductor({
      store,
      backend: scriptedBackend({ sessionId: 's-prompt-fail', text: 'hi' }).backend,
      onTurnError: (id, err) => errors.push({ id, message: err.message }),
    });

    const { sessionId } = await conductor.startSession({ worktree: '/wt/pf', prompt: 'x' });
    expect(sessionId).toBe('s-prompt-fail');

    await waitFor(() => errors.length > 0);
    expect(errors[0]).toMatchObject({ id: 's-prompt-fail', message: 'prompt insert boom' });
    await waitFor(() => !conductor.isBusy('s-prompt-fail')); // run still completed

    // The prompt was dropped (its INSERT failed), but the agent's output survived.
    const events = await ctx.store.getEvents('s-prompt-fail');
    expect(events.map((e) => e.t)).toEqual(['session', 'text', 'result']);
  });
});

describe('Conductor.cancelTurn (#79)', () => {
  // A backend that streams one partial text block and then stays in flight until
  // the operator's cancel aborts the turn — so there is genuinely something to
  // cancel, and the abort is observed the way a real backend observes it. The
  // already-aborted case is handled too: the cancel can land while the partial
  // output is still being persisted, and a listener added after that fires never.
  function cancellableBackend(onAbort: () => void): Backend {
    return scriptedBackend({
      text: 'hi', // partial output BEFORE the cancel
      abortable: true,
      during: (turn) => {
        if (turn.opts.signal?.aborted === true) onAbort();
        else turn.opts.signal?.addEventListener('abort', onAbort, { once: true });
      },
    }).backend;
  }

  it('aborts the in-flight turn, keeps partial output, and appends a terminal interrupted event', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let aborted = false;
    const conductor = new Conductor({
      store: ctx.store,
      backend: cancellableBackend(() => {
        aborted = true;
      }),
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'go');
    await waitFor(() => conductor.isBusy('s1')); // turn is running
    await expect(conductor.cancelTurn('s1')).resolves.toBe(true);
    await waitFor(() => !conductor.isBusy('s1')); // run settled after the abort

    expect(aborted).toBe(true);
    const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
    expect(kinds).toContain('text'); // partial output preserved (store is the truth)
    expect(kinds.at(-1)).toBe('interrupted'); // terminal marker, last
    await expect(conductor.cancelTurn('s1')).resolves.toBe(false); // idle now → no-op
  });

  // The barrier is backend-agnostic by construction: it fences on the session's turn
  // lock and never reads which engine either side runs, so one direction covers both.
  it('keeps one worktree mutator across a live backend handoff', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let settleOld!: (result: RunResult) => void;
    let oldMutating = true;
    const runner: RunnerClient = {
      startTurn: () => ({
        result: new Promise<RunResult>((resolve) => {
          settleOld = (result) => {
            oldMutating = false;
            resolve(result);
          };
        }),
        steer: () => Promise.resolve(false),
        answerPermission: () => Promise.resolve(false),
        cancel: () => Promise.resolve(true),
        forceCancel: () => Promise.resolve(true),
      }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
      worktreeExists: async () => true,
      runner: () => runner,
    });

    await conductor.dispatchTurn('s1', 'old backend work');
    await waitFor(() => settleOld !== undefined);
    let replacementEntered = false;
    const handoff = conductor.runBackendHandoff('s1', async () => {
      expect(oldMutating).toBe(false);
      replacementEntered = true;
    });

    await waitFor(() => conductor.isBackendHandoffPending('s1'));
    expect(replacementEntered).toBe(false);
    await expect(conductor.dispatchTurn('s1', 'overlapping submission')).rejects.toBeInstanceOf(
      SessionBusyError,
    );
    settleOld({ sessionId: 's1', exitCode: 143, stderr: '', aborted: true });
    await handoff;

    expect(replacementEntered).toBe(true);
    expect(conductor.isBackendHandoffPending('s1')).toBe(false);
  });

  it('refuses the handoff instead of starting a second backend on unconfirmed termination', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged run loop
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined), // no ack
            forceCancel: () => new Promise<boolean>(() => undefined), // no certificate
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      let replacementEntered = false;
      const handoff = conductor.runBackendHandoff('s1', async () => {
        replacementEntered = true;
      });
      const rejection = expect(handoff).rejects.toBeInstanceOf(BackendTerminationUnconfirmedError);
      // Cancel grace + bounded forceCancel, then the bounded wait on the ownership
      // fence that never releases because termination stays unproven.
      await vi.advanceTimersByTimeAsync(2_000 + 9_000 + 200);
      await rejection;

      // The replacement backend never ran, so the persisted model/backend state the
      // caller would have rewritten inside it is untouched — and the old worker keeps
      // sole ownership of the worktree until a retry can prove it is gone.
      expect(replacementEntered).toBe(false);
      expect(conductor.isBusy('s1')).toBe(true);
      expect(conductor.isBackendHandoffPending('s1')).toBe(false);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes two concurrent handoffs instead of interleaving them', async () => {
    // Two switches racing (an impatient double tap, or a retry beside the original)
    // must not both hold the session: the second has to see the first one's finished
    // state, or it would tear down a backend the first just installed.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
      worktreeExists: async () => true,
    });

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = conductor.runBackendHandoff('s1', async () => {
      order.push('first:enter');
      await firstHeld;
      order.push('first:exit');
    });
    await waitFor(() => order.length === 1);
    const second = conductor.runBackendHandoff('s1', async () => {
      order.push('second:enter');
    });

    // Parked behind the first, not running beside it.
    await Promise.resolve();
    expect(order).toEqual(['first:enter']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:enter', 'first:exit', 'second:enter']);
    expect(conductor.isBackendHandoffPending('s1')).toBe(false);
    expect(conductor.isBusy('s1')).toBe(false);
  });

  it('releases the session when the handoff callback itself throws', async () => {
    // The callback is the caller's persistence work, and it can fail (a store blip
    // mid-switch). The barrier must still hand the session back — a failed switch is
    // retriable, a permanently fenced session is not.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
      worktreeExists: async () => true,
    });

    await expect(
      conductor.runBackendHandoff('s1', () => Promise.reject(new Error('store blip'))),
    ).rejects.toThrow('store blip');

    expect(conductor.isBusy('s1')).toBe(false);
    expect(conductor.isBackendHandoffPending('s1')).toBe(false);
    // And the next switch is admitted rather than parked behind the failed one.
    await expect(conductor.runBackendHandoff('s1', async () => 'ok')).resolves.toBe('ok');
  });

  it('refuses a handoff behind a maintenance lock as busy, not as an unterminated backend', async () => {
    // A bind/purge/local-merge holds the same ownership lock with NO worker behind it.
    // Reporting that as "the old backend may still be alive" (503) sends the operator
    // after a process that does not exist; it is ordinary contention, so 409/retry.
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
        worktreeExists: async () => true,
      });

      let releaseMaintenance!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseMaintenance = resolve;
      });
      const maintenance = conductor.runExclusive('s1', () => held);
      await Promise.resolve();
      expect(conductor.isBusy('s1')).toBe(true);

      const handoff = conductor.runBackendHandoff('s1', async () => 'never');
      const rejection = expect(handoff).rejects.toBeInstanceOf(SessionBusyError);
      await vi.advanceTimersByTimeAsync(2_000 + 9_000 + 200);
      await rejection;

      releaseMaintenance();
      await maintenance;
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees a session by itself once the reaper can finally confirm the kill', async () => {
    // The refusal above is only acceptable because the session is not stuck there: the
    // background reaper keeps re-issuing the out-of-band kill, and the moment one
    // answers, the turn finalizes and the fence drops without the operator acting.
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      let forceAnswers = false;
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged run loop
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined), // no ack
            // Unreachable control plane at first, then back.
            forceCancel: () =>
              forceAnswers ? Promise.resolve(true) : new Promise<boolean>(() => undefined),
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      void conductor.cancelTurn('s1');

      // Cancel grace, then the bounded force-cancel: the stop gives up on PROVING
      // termination and hands the session to the reaper, still fenced.
      await vi.advanceTimersByTimeAsync(2_000 + 200);
      expect(conductor.hasUnconfirmedTermination('s1')).toBe(true);
      expect(conductor.isBusy('s1')).toBe(true);

      // The control plane comes back. One reaper backoff later the next attempt
      // returns a certificate, and the session frees itself.
      forceAnswers = true;
      await vi.advanceTimersByTimeAsync(1_000 + 200);

      expect(conductor.isBusy('s1')).toBe(false);
      expect(conductor.hasUnconfirmedTermination('s1')).toBe(false);
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      // A transient control-plane delay that recovers on the first background retry
      // does not leave a contradictory "could not confirm" / "confirmed gone" pair.
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds.filter((t) => t === 'notice')).toHaveLength(0);
      expect(kinds).toContain('interrupted');
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a runner with no kill channel at once instead of retrying nothing', async () => {
    // `forceCancel` is OPTIONAL on the RunnerTurn contract, so a client can own a worker
    // with no out-of-band way to kill it. That is "unprovable", not "nothing to prove" —
    // the fence still has to hold. But retrying a channel that does not exist can only
    // fail the same way ten times over, so the operator hears about it immediately
    // rather than twenty seconds later.
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged run loop
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined), // no ack
            // No forceCancel at all — the whole point of this case.
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      void conductor.cancelTurn('s1');

      // Only the cancel grace — no force-cancel bound to wait out, and no retry budget.
      await vi.advanceTimersByTimeAsync(1_000 + 200);

      const notices = (await ctx.store.getEvents('s1')).filter((e) => e.t === 'notice');
      expect(notices).toHaveLength(2);
      expect(JSON.stringify(notices[1])).toContain('periodic liveness check');
      expect(conductor.isBusy('s1')).toBe(true);
      expect(conductor.hasUnconfirmedTermination('s1')).toBe(true);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the reaper gives up, rather than going quiet on a held fence', async () => {
    // The other end of the same path: the control plane never comes back. The reaper
    // is bounded, so it stops trying — and that is precisely when the operator most
    // needs to be told, because from here only the periodic liveness sweep can free
    // the session. Silence would read as "busy forever" with no explanation.
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged run loop
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined), // no ack
            forceCancel: () => new Promise<boolean>(() => undefined), // never answers
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      void conductor.cancelTurn('s1');

      // Cancel grace + bounded force-cancel, then the whole retry budget:
      // UNCONFIRMED_WORKER_REAP_ATTEMPTS (10) × (backoff + bounded force-cancel).
      await vi.advanceTimersByTimeAsync(2_000 + 10 * 2_000 + 200);

      const notices = (await ctx.store.getEvents('s1')).filter((e) => e.t === 'notice');
      expect(notices).toHaveLength(2);
      expect(JSON.stringify(notices[1])).toContain('periodic liveness check');

      // Still fenced and still flagged — giving up on the retries is not giving up on
      // the guarantee. The worker may hold the worktree, so nothing new may start.
      expect(conductor.isBusy('s1')).toBe(true);
      expect(conductor.hasUnconfirmedTermination('s1')).toBe(true);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the operator release a fence no automatic path can lift', async () => {
    // The state the barrier deliberately creates and neither recovery path can end:
    // the worker may be alive, its control plane never answers, so the reaper cannot
    // prove death and the liveness sweep cannot prove absence. Without a manual
    // release the honest advice would be "delete the session".
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      let sawAbort = false;
      const runner: RunnerClient = {
        startTurn: (opts) => {
          started = true;
          opts.signal?.addEventListener('abort', () => {
            sawAbort = true;
          });
          return {
            result: new Promise<RunResult>(() => undefined), // wedged run loop
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined), // no ack
            forceCancel: () => new Promise<boolean>(() => undefined), // never answers
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run: () => Promise.reject(new Error('unexpected loopback run')) },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      void conductor.cancelTurn('s1');
      await vi.advanceTimersByTimeAsync(2_000 + 10 * 2_000 + 200);
      expect(conductor.hasUnconfirmedTermination('s1')).toBe(true);
      expect(conductor.isBusy('s1')).toBe(true);

      await conductor.releaseUnconfirmedTermination('s1');

      expect(conductor.hasUnconfirmedTermination('s1')).toBe(false);
      expect(conductor.isBusy('s1')).toBe(false);
      expect(sawAbort).toBe(true);
      // The turn is finalized like any other force-settle, and the durable marker is
      // gone — a release that left the marker would resurrect the turn on restart.
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds).toContain('interrupted');
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      // The transcript must not claim the process exited — nothing established that.
      const notices = (await ctx.store.getEvents('s1')).filter((e) => e.t === 'notice');
      expect(JSON.stringify(notices)).toContain('Released by hand');
      expect(JSON.stringify(notices)).not.toContain('confirmed gone');
      // And the session really is usable again.
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a no-op release on a session that was never fenced', async () => {
    // The button is reachable from a stale banner, and the fence may have lifted by
    // itself in the meantime. That must be a quiet false, not a stop of live work.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: { run: () => Promise.reject(new Error('unexpected run')) },
      worktreeExists: async () => true,
    });
    await expect(conductor.releaseUnconfirmedTermination('s1')).resolves.toBe(false);
    expect((await ctx.store.getEvents('s1')).filter((e) => e.t === 'notice')).toHaveLength(0);
  });

  it('does not abort a successor when the old turn settles during the release audit write', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let settleOld!: (result: RunResult) => void;
      const oldResult = new Promise<RunResult>((resolve) => (settleOld = resolve));
      const closeSession = vi.fn();
      let started = false;
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: oldResult,
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined),
            forceCancel: () => new Promise<boolean>(() => undefined),
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: { run: () => Promise.reject(new Error('unexpected loopback run')), closeSession },
        worktreeExists: async () => true,
        runner: () => runner,
      });
      await conductor.dispatchTurn('s1', 'old');
      await vi.waitFor(() => expect(started).toBe(true));
      void conductor.cancelTurn('s1');
      await vi.advanceTimersByTimeAsync(2_000 + 200);
      expect(conductor.hasUnconfirmedTermination('s1')).toBe(true);
      closeSession.mockClear();

      let releaseAudit!: () => void;
      const auditGate = new Promise<void>((resolve) => (releaseAudit = resolve));
      const appendEvent = ctx.store.appendEvent.bind(ctx.store);
      vi.spyOn(ctx.store, 'appendEvent').mockImplementation(async (sessionId, event) => {
        if (event.t === 'notice' && event.text.includes('Released by hand')) await auditGate;
        return await appendEvent(sessionId, event);
      });
      const releasing = conductor.releaseUnconfirmedTermination('s1');
      await Promise.resolve();

      settleOld({ sessionId: 's1', exitCode: 143, stderr: '', aborted: true });
      await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
      await expect(conductor.dispatchTurn('s1', 'too early')).rejects.toBeInstanceOf(
        SessionBusyError,
      );
      releaseAudit();
      await expect(releasing).resolves.toBe(true);

      expect(closeSession).not.toHaveBeenCalled();
      await expect(conductor.dispatchTurn('s1', 'successor')).resolves.toMatchObject({
        queued: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-closes the backend when a live runner cancel hangs', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let settle!: (result: RunResult) => void;
      const result = new Promise<RunResult>((resolve) => {
        settle = resolve;
      });
      let sawAbort = false;
      let started = false;
      const cancel = vi.fn(() => new Promise<boolean>(() => undefined));
      const forceCancel = vi.fn(() => Promise.resolve(true));
      const closeSession = vi.fn((sessionId: string) => {
        settle({ sessionId, exitCode: 0, stderr: '', aborted: true });
      });
      const runner: RunnerClient = {
        startTurn: (opts) => {
          started = true;
          if (opts.signal?.aborted) sawAbort = true;
          else
            opts.signal?.addEventListener(
              'abort',
              () => {
                sawAbort = true;
              },
              { once: true },
            );
          return {
            result,
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel,
            forceCancel,
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      expect(conductor.isBusy('s1')).toBe(true);
      const cancelled = conductor.cancelTurn('s1');
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(cancelled).resolves.toBe(true);
      await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
      expect(sawAbort).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(forceCancel).toHaveBeenCalledTimes(1);
      expect(closeSession).toHaveBeenCalledWith('s1');
      expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-settles when the runner acks the cancel but the run loop never settles', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      // The kill does NOT unstick anything: the run loop is wedged behind an await
      // that outlives the process (e.g. a broker call that never resolves).
      const closeSession = vi.fn();
      const cancel = vi.fn(() => Promise.resolve(true)); // acked — but an ack is not a settle
      const forceCancel = vi.fn(() => Promise.resolve(true));
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged forever
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel,
            forceCancel,
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      expect(conductor.isBusy('s1')).toBe(true);

      const cancellation = conductor.cancelTurn('s1');
      expect(conductor.isBusy('s1')).toBe(true); // wedged — nothing has settled yet
      await vi.advanceTimersByTimeAsync(5_100); // STOP_SETTLE_GRACE_MS elapses
      await expect(cancellation).resolves.toBe(true);

      // The Stop guarantee: fence released, terminal marker written, durable marker
      // cleared — the session takes the next prompt.
      expect(conductor.isBusy('s1')).toBe(false);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(forceCancel).toHaveBeenCalledTimes(1);
      expect(closeSession).toHaveBeenCalledWith('s1');
      expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-settles when the cancel hangs and the kill cannot unstick the run loop', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      const closeSession = vi.fn(); // no-op: nothing this process does settles the loop
      const forceCancel = vi.fn(() => Promise.resolve(true));
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged forever
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined), // cancel hangs too
            forceCancel,
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      expect(conductor.isBusy('s1')).toBe(true);

      const cancelled = conductor.cancelTurn('s1');
      await vi.advanceTimersByTimeAsync(1_100); // cancel grace elapses → force path
      await expect(cancelled).resolves.toBe(true);

      expect(conductor.isBusy('s1')).toBe(false);
      expect(forceCancel).toHaveBeenCalledTimes(1);
      expect(closeSession).toHaveBeenCalledWith('s1');
      expect((await ctx.store.getEvents('s1')).map((e) => e.t).at(-1)).toBe('interrupted');
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('overlapping Stop presses on a wedged turn force-settle exactly once', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged forever
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => Promise.resolve(true),
            forceCancel: () => Promise.resolve(true),
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession: () => undefined,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      // Two Stop presses in quick succession. Both report `true`: the turn is still
      // live, so the second press re-signals it rather than answering "idle" — and
      // however many watchdogs end up armed, the single-shot force claim lets exactly
      // ONE force-settle run.
      const first = conductor.cancelTurn('s1');
      const second = conductor.cancelTurn('s1');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_200);
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);

      expect(conductor.isBusy('s1')).toBe(false);
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds.filter((t) => t === 'interrupted')).toHaveLength(1);
      expect(await ctx.store.listRunningTurns()).toHaveLength(0);
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('watchdog stands down when the turn settles during its bounded force-cancel wait', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      const settles: Array<(r: RunResult) => void> = [];
      const closeSession = vi.fn();
      const runner: RunnerClient = {
        startTurn: () => ({
          result: new Promise<RunResult>((resolve) => settles.push(resolve)),
          steer: () => Promise.resolve(false),
          answerPermission: () => Promise.resolve(false),
          cancel: () => Promise.resolve(true),
          forceCancel: () => new Promise<boolean>(() => undefined), // hangs → bounded wait
        }),
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(settles).toHaveLength(1));
      const cancellation = conductor.cancelTurn('s1');
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: true });
      await vi.advanceTimersByTimeAsync(0);

      // Watchdog fires and enters its bounded force-cancel wait — DURING that wait
      // the cancelled turn settles naturally and the queued successor drains.
      await vi.advanceTimersByTimeAsync(5_050);
      settles[0]!({ sessionId: 's1', exitCode: 0, stderr: '', aborted: true });
      await vi.waitFor(() => expect(settles).toHaveLength(2)); // successor is live
      await vi.advanceTimersByTimeAsync(1_100); // force-cancel bound elapses → revalidate
      await expect(cancellation).resolves.toBe(true);

      // Stand-down: the successor's backend was NOT closed and its turn is intact.
      expect(closeSession).not.toHaveBeenCalled();
      expect(conductor.isBusy('s1')).toBe(true);
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds.filter((t) => t === 'interrupted')).toHaveLength(1); // the turn's own settle
      expect(await ctx.store.listRunningTurns()).toHaveLength(1); // successor marker intact
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the worktree fenced when cancel delivery and termination stay uncertain', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      const closeSession = vi.fn();
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged forever
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => new Promise<boolean>(() => undefined), // hangs
            forceCancel: () => new Promise<boolean>(() => undefined), // hangs too
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      const cancelled = conductor.cancelTurn('s1');
      // The boolean answers "there WAS a live turn to cancel", which stays true here —
      // it is the FENCE, not the ack, that carries ownership. Neither control path
      // proved termination, so the fence must stay held and no successor may acquire
      // the worktree, while the background reaper keeps retrying the kill.
      await vi.advanceTimersByTimeAsync(2_200);
      await expect(cancelled).resolves.toBe(true);

      expect(conductor.isBusy('s1')).toBe(true);
      expect(conductor.hasUnconfirmedTermination('s1')).toBe(true);
      // The in-process child IS closed even here — it is the cheapest lever against the
      // very overlap this path guards, and closing it does not free the fence.
      expect(closeSession).toHaveBeenCalledWith('s1');
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds.at(-1)).not.toBe('interrupted');
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a delayed force-settle marker clear cannot erase the successor turn marker', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      const settles: Array<(r: RunResult) => void> = [];
      const runner: RunnerClient = {
        startTurn: () => ({
          result: new Promise<RunResult>((resolve) => settles.push(resolve)),
          steer: () => Promise.resolve(false),
          answerPermission: () => Promise.resolve(false),
          cancel: () => Promise.resolve(true),
          forceCancel: () => Promise.resolve(true),
        }),
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession: () => undefined,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(settles).toHaveLength(1));
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: true });

      // Hold the marker delete the force-settle issues until AFTER the successor
      // has written its own marker — the delete is scoped to the wedged turn's
      // prompt_seq, so it must not touch the successor's row.
      const realClear = ctx.store.clearRunningTurn.bind(ctx.store);
      let releaseClear!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseClear = resolve;
      });
      vi.spyOn(ctx.store, 'clearRunningTurn').mockImplementationOnce(
        async (sessionId: string, promptSeq?: number) => {
          await held;
          return realClear(sessionId, promptSeq);
        },
      );

      const cancellation = conductor.cancelTurn('s1');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_100); // watchdog force-settles, drains 'next'
      await expect(cancellation).resolves.toBe(true);
      await vi.waitFor(() => expect(settles).toHaveLength(2)); // successor is live
      await vi.waitFor(async () => {
        expect(await ctx.store.listRunningTurns()).toHaveLength(1); // successor marker written
      });
      releaseClear();
      await vi.advanceTimersByTimeAsync(10); // let the held, scoped delete land

      expect(await ctx.store.listRunningTurns()).toHaveLength(1); // marker survived
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the session for the terminal interrupted write, then releases it bounded', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      let started = false;
      const runner: RunnerClient = {
        startTurn: () => {
          started = true;
          return {
            result: new Promise<RunResult>(() => undefined), // wedged forever
            steer: () => Promise.resolve(false),
            answerPermission: () => Promise.resolve(false),
            cancel: () => Promise.resolve(true),
            forceCancel: () => Promise.resolve(true),
          };
        },
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession: () => undefined,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(started).toBe(true));
      // The store hangs ONLY on the terminal `interrupted` append — the last
      // unbounded await in the forced Stop path.
      const realAppend = ctx.store.appendEvent.bind(ctx.store);
      const appendSpy = vi
        .spyOn(ctx.store, 'appendEvent')
        .mockImplementation((sessionId, event) =>
          (event as { t?: string }).t === 'interrupted'
            ? new Promise<never>(() => undefined)
            : realAppend(sessionId, event),
        );
      try {
        void conductor.cancelTurn('s1');
        await vi.advanceTimersByTimeAsync(0);
        // Settle grace elapses, the wedged run loop is force-settled, and the terminal
        // write hangs: the session stays fenced while that write is outstanding.
        await vi.advanceTimersByTimeAsync(5_100);
        expect(conductor.isBusy('s1')).toBe(true);
        expect(await ctx.store.listRunningTurns()).toHaveLength(1);

        // BOUNDED, though: the worker's termination was already certified here, so a
        // store that never answers costs the transcript a marker, not the session. Once
        // the write bound elapses the fence drops and the session is usable again.
        await vi.advanceTimersByTimeAsync(1_100);
        expect(conductor.isBusy('s1')).toBe(false);
        await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({
          queued: false,
        });
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees the session even when the durable marker cleanup rejects on settle', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({ sessionId: null, omitResult: true }).backend,
      worktreeExists: async () => true,
    });
    vi.spyOn(ctx.store, 'clearRunningTurn').mockRejectedValueOnce(new Error('cleanup failed'));

    await conductor.dispatchTurn('s1', 'go');
    await waitFor(() => !conductor.isBusy('s1'));
    // The failed marker delete was reported, not fatal: the fence released and the
    // session takes the next prompt.
    await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: false });
  });

  it('a run loop that unsticks after the watchdog force-settle skips its own settle', async () => {
    vi.useFakeTimers();
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      const settles: Array<(r: RunResult) => void> = [];
      const runner: RunnerClient = {
        startTurn: () => ({
          result: new Promise<RunResult>((resolve) => settles.push(resolve)),
          steer: () => Promise.resolve(false),
          answerPermission: () => Promise.resolve(false),
          cancel: () => Promise.resolve(true),
          forceCancel: () => Promise.resolve(true),
        }),
      };
      const conductor = new Conductor({
        store: ctx.store,
        backend: {
          run: () => Promise.reject(new Error('backend.run must not be called by this runner')),
          closeSession: () => undefined,
        },
        worktreeExists: async () => true,
        runner: () => runner,
      });

      await conductor.dispatchTurn('s1', 'go');
      await vi.waitFor(() => expect(settles).toHaveLength(1));
      const cancellation = conductor.cancelTurn('s1');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_100); // watchdog force-settles the wedged loop
      await expect(cancellation).resolves.toBe(true);
      expect(conductor.isBusy('s1')).toBe(false);

      // A successor turn is live when the old run loop finally unsticks with an
      // aborted result — the settle claim it lost must silence it completely.
      await expect(conductor.dispatchTurn('s1', 'next')).resolves.toMatchObject({ queued: false });
      await vi.waitFor(() => expect(settles).toHaveLength(2));
      expect(conductor.isBusy('s1')).toBe(true);
      settles[0]!({ sessionId: 's1', exitCode: 0, stderr: '', aborted: true });
      await vi.advanceTimersByTimeAsync(50); // let the unstuck loop run to completion

      // Single-owner settle: the late loop wrote no second `interrupted`, kept the
      // successor's fence, and left the successor's running marker in place.
      expect(conductor.isBusy('s1')).toBe(true);
      const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
      expect(kinds.filter((t) => t === 'interrupted')).toHaveLength(1);
      expect(await ctx.store.listRunningTurns()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false (no-op) when the session is idle', async () => {
    const conductor = new Conductor({ store: ctx.store, backend: unreachableBackend().backend });
    await expect(conductor.cancelTurn('nobody')).resolves.toBe(false);
  });

  it('force-settles a durable running marker even when this process has no live turn handle', async () => {
    await ctx.store.createSession({ sessionId: 's-stale-marker', worktree: '/wt/s1', model: 'm' });
    const { seq } = await ctx.store.appendEvent('s-stale-marker', {
      t: 'prompt',
      text: 'stale after restart',
    });
    await ctx.store.markTurnRunning({ sessionId: 's-stale-marker', promptSeq: seq });

    const conductor = new Conductor({
      store: ctx.store,
      backend: unreachableBackend().backend,
      worktreeExists: async () => true,
    });

    expect(conductor.isBusy('s-stale-marker')).toBe(false);
    await expect(conductor.cancelTurn('s-stale-marker')).resolves.toBe(true);

    const kinds = (await ctx.store.getEvents('s-stale-marker')).map((event) => event.t);
    expect(kinds.at(-1)).toBe('interrupted');
    expect(await ctx.store.listRunningTurns()).toHaveLength(0);
    await expect(conductor.cancelTurn('s-stale-marker')).resolves.toBe(false);
  });

  it('emitMerged appends a "merged" marker and fans it out — no turn dispatched', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const bus = new InMemoryEventBus();
    const fanned: unknown[] = [];
    bus.subscribe('s1', (se) => fanned.push(se.event));
    const conductor = new Conductor({
      store: ctx.store,
      backend: unreachableBackend().backend,
      bus,
      worktreeExists: async () => true,
    });

    await conductor.emitMerged('s1', 233);

    // Persisted as a bare marker (the only event — no prompt, no turn) and fanned out.
    const events = await ctx.store.getEvents('s1');
    expect(events.map((e) => e.t)).toEqual(['merged']);
    expect(events.at(-1)).toEqual({ t: 'merged', number: 233 });
    expect(fanned).toEqual([{ t: 'merged', number: 233 }]);
    expect(conductor.isBusy('s1')).toBe(false); // marker starts no turn
  });

  it('runWhenIdle runs the action immediately when the session is idle', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: unreachableBackend().backend,
      worktreeExists: async () => true,
    });

    let ran = false;
    await conductor.runWhenIdle('s1', async () => {
      ran = true;
    });
    expect(ran).toBe(true); // no turn in flight → runs synchronously with the call
  });

  it('runWhenIdle defers the action under a live turn and runs it once the turn settles', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { backend, releases } = releasableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'work');
    // Wait until the run actually started (its resolver is registered), not just
    // until it was accepted — `isBusy` flips at accept, BEFORE the run.
    await waitFor(() => conductor.isBusy('s1') && releases.length === 1);

    let ran = false;
    await conductor.runWhenIdle('s1', async () => {
      ran = true;
    });
    expect(ran).toBe(false); // deferred while the turn is live

    releases[0]?.(); // let the turn finish → settle path flushes the deferred action
    await waitFor(() => ran);
    expect(conductor.isBusy('s1')).toBe(false);
  });

  it('runWhenIdle waits for queued turns too — it never runs between them', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { backend, releases, calls } = releasableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'first');
    await waitFor(() => conductor.isBusy('s1') && releases.length === 1);
    await conductor.dispatchTurn('s1', 'second'); // queued behind the live first

    let ran = false;
    await conductor.runWhenIdle('s1', async () => {
      ran = true;
    });

    releases[0]?.(); // finish first → the queued second drains and starts
    await waitFor(() => calls.length === 2 && conductor.isBusy('s1') && releases.length === 2);
    expect(ran).toBe(false); // NOT run between the two turns

    releases[1]?.(); // finish second → now truly idle → deferred action fires
    await waitFor(() => ran);
    expect(conductor.isBusy('s1')).toBe(false);
  });

  it('runExclusive holds the turn lock so a turn dispatched meanwhile cannot race it', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    let release = (): void => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let inside = false;
    const exclusive = conductor.runExclusive('s1', async () => {
      inside = true;
      await held;
    });
    await waitFor(() => inside);
    expect(conductor.isBusy('s1')).toBe(true); // lock HELD for the whole callback

    // A turn dispatched now must not start beside the cleanup — it queues.
    await conductor.dispatchTurn('s1', 'work');
    expect(fake.calls).toHaveLength(0);
    expect(conductor.queuedCount('s1')).toBe(1);

    release();
    await exclusive;
    await waitFor(() => fake.calls.length === 1); // released → the queued turn drains
    await waitFor(() => !conductor.isBusy('s1'));
  });

  // Stop force-settles a session that holds the lock without a live turn — the one path
  // that releases a lock it does not own. A maintenance callback (the post-merge reset)
  // is exactly that shape, so Stop must leave it alone instead of handing the session to
  // a queued turn while the worktree is still being rewritten.
  it('runExclusive keeps its lock when Stop lands mid-callback', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    let release = (): void => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let inside = false;
    const exclusive = conductor.runExclusive('s1', async () => {
      inside = true;
      await held;
    });
    await waitFor(() => inside);
    await conductor.dispatchTurn('s1', 'work'); // queued behind the lock

    // Nothing is running for the operator to stop, so this reports "nothing cancelled"
    // rather than force-settling the lock out from under the callback.
    expect(await conductor.cancelTurn('s1')).toBe(false);
    expect(conductor.isBusy('s1')).toBe(true);
    expect(fake.calls).toHaveLength(0); // the queued turn is still parked
    expect(conductor.queuedCount('s1')).toBe(1);

    release();
    await exclusive;
    await waitFor(() => fake.calls.length === 1); // and drains normally once the callback is done
  });

  it('tryRunExclusive refuses instead of deferring while a turn is in flight', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { backend, releases } = releasableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'work');
    await waitFor(() => conductor.isBusy('s1') && releases.length === 1);

    let ran = false;
    expect(
      await conductor.tryRunExclusive('s1', async () => {
        ran = true;
        return 'value';
      }),
    ).toEqual({ ran: false });
    expect(ran).toBe(false); // refused outright — nothing is parked for later

    releases[0]?.();
    await waitFor(() => !conductor.isBusy('s1'));
    // Idle again: it claims the lock, hands back the callback's value, and releases.
    expect(await conductor.tryRunExclusive('s1', async () => 'value')).toEqual({
      ran: true,
      value: 'value',
    });
    expect(conductor.isBusy('s1')).toBe(false);
  });

  it('tryRunExclusive releases the lock when its callback throws', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: unreachableBackend().backend,
      worktreeExists: async () => true,
    });

    await expect(
      conductor.tryRunExclusive('s1', async () => {
        throw new Error('merge failed');
      }),
    ).rejects.toThrow('merge failed');
    expect(conductor.isBusy('s1')).toBe(false); // a failed claim must not wedge the session
  });

  it('runExclusive defers under a live turn and takes the lock once that turn settles', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { backend, releases } = releasableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'work');
    await waitFor(() => conductor.isBusy('s1') && releases.length === 1);

    let ran = false;
    let release = (): void => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await conductor.runExclusive('s1', async () => {
      ran = true;
      await held;
    });
    expect(ran).toBe(false); // parked, exactly like runWhenIdle

    releases[0]?.();
    await waitFor(() => ran);
    // Still busy: the lock is now held by the deferred action, not by the turn.
    expect(conductor.isBusy('s1')).toBe(true);
    release();
    await waitFor(() => !conductor.isBusy('s1'));
  });

  it('runAfterCurrentTurn runs between the live turn and its queued successor', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { backend, releases, calls } = releasableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'first');
    await waitFor(() => conductor.isBusy('s1') && releases.length === 1);
    await conductor.dispatchTurn('s1', 'second');

    let callsWhenActionRan = -1;
    expect(
      conductor.runAfterCurrentTurn('s1', () => {
        callsWhenActionRan = calls.length;
      }),
    ).toBe(true);

    releases[0]?.();
    await waitFor(() => calls.length === 2 && releases.length === 2);
    expect(callsWhenActionRan).toBe(1);

    releases[1]?.();
    await waitFor(() => !conductor.isBusy('s1'));
  });

  it('still drains a queued turn after the in-flight one is cancelled', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const prompts: string[] = [];
    const fake = scriptedBackend((opts, attempt) => {
      prompts.push(opts.prompt ?? '');
      // The first turn stays in flight until the cancel aborts it; the queued one
      // runs normally.
      return attempt === 1 ? { abortable: true } : {};
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'first');
    await waitFor(() => conductor.isBusy('s1'));
    await conductor.dispatchTurn('s1', 'second'); // queued behind the in-flight first
    expect(conductor.queuedCount('s1')).toBe(1);

    await expect(conductor.cancelTurn('s1')).resolves.toBe(true); // stop the first
    await waitFor(() => fake.calls.length === 2 && !conductor.isBusy('s1')); // second still ran

    expect(prompts).toEqual(['first', 'second']);
  });

  it('does NOT append interrupted for a turn that completed on its own', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({ text: 'hi' }).backend,
      worktreeExists: async () => true,
    });
    await conductor.sendTurn('s1', 'go'); // runs to completion, never cancelled
    const kinds = (await ctx.store.getEvents('s1')).map((e) => e.t);
    expect(kinds).not.toContain('interrupted');
  });
});

describe('Conductor mid-turn steering (#101)', () => {
  /** Poll the persisted `prompt` events (the steered prompt is persisted
   * fire-and-forget, so it lands a beat after dispatch returns). */
  async function promptTexts(sessionId: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await ctx.store.getEvents(sessionId)) if (e.t === 'prompt') out.push(e.text);
    return out;
  }

  it('folds a mid-turn message into the live turn instead of queueing it', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = steerableBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'first');
    await waitFor(fake.ready);

    const res = await conductor.dispatchTurn('s1', 'full steered instruction', undefined, {
      displayPrompt: 'Merged PR #119',
    });

    // Delivered into the running turn — NOT queued behind it.
    expect(res).toEqual({ queued: false });
    expect(conductor.queuedCount('s1')).toBe(0);
    // The turn was requested steerable, so the backend held a channel open for it.
    expect(fake.last().steerable).toBe(true);
    expect(fake.steered.map((m) => m.text)).toEqual(['full steered instruction']);

    fake.release();
    await waitFor(() => !conductor.isBusy('s1'));
    // Both the initial prompt and the steered one are persisted in the transcript.
    for (let i = 0; i < 200 && !(await promptTexts('s1')).includes('Merged PR #119'); i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(await promptTexts('s1')).toEqual(expect.arrayContaining(['first', 'Merged PR #119']));
    const prompts = (await ctx.store.getEvents('s1')).filter((event) => event.t === 'prompt');
    expect(prompts.find((event) => event.text === 'first')?.steered).toBeUndefined();
    expect(prompts.find((event) => event.text === 'Merged PR #119')?.steered).toBe(true);
  });

  it('falls back to queueing when the live turn has no writable steering channel', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // A live turn that never surfaces an injector: the steer attempt returns false,
    // so the conductor must fall back to the #90 queue rather than silently dropping
    // the message.
    const fake = steerableBackend(false);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
    });

    await conductor.dispatchTurn('s1', 'first');
    await waitFor(fake.ready);

    const res = await conductor.dispatchTurn('s1', 'queue me');

    expect(res).toEqual({ queued: true });
    expect(conductor.queuedCount('s1')).toBe(1);
    expect(conductor.queuedItems('s1').map((i) => i.text)).toEqual(['queue me']);

    fake.release();
    await waitFor(() => !conductor.isBusy('s1')); // in-flight + drained queued turn settle
  });

  it('routes a failed steered-prompt persist to onTurnError while still delivering the message', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const errors: string[] = [];
    // A store whose appendEvent rejects only for the steered prompt event — the
    // initial 'first' prompt and the agent's own events still persist.
    const store = new Proxy(ctx.store, {
      get(target, prop, recv: unknown) {
        if (prop === 'appendEvent') {
          return async (
            sessionId: string,
            event: AgentEvent,
          ): Promise<{ seq: number; ts: number }> => {
            if (event.t === 'prompt' && event.text === 'boom steer') {
              throw new Error('steer prompt boom');
            }
            return target.appendEvent(sessionId, event);
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const fake = steerableBackend();
    const conductor = new Conductor({
      store,
      backend: fake.backend,
      worktreeExists: async () => true,
      onTurnError: (_id, err) => errors.push(err.message),
    });

    await conductor.dispatchTurn('s1', 'first');
    await waitFor(fake.ready);

    const res = await conductor.dispatchTurn('s1', 'boom steer');

    // The message was still delivered into the live turn (not queued)…
    expect(res).toEqual({ queued: false });
    expect(fake.steered.map((m) => m.text)).toEqual(['boom steer']);
    // …but its prompt-event persist failed and routed to onTurnError (not silent).
    await waitFor(() => errors.includes('steer prompt boom'));

    fake.release();
    await waitFor(() => !conductor.isBusy('s1'));
  });
});

describe('Conductor — backend seam (#143)', () => {
  it('runs each turn through the injected backend, not the default one', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    let captured: RunTurnOptions | undefined;
    const backend: Backend = {
      run: async (opts) => {
        captured = opts;
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'go');

    expect(captured?.prompt).toBe('go');
    expect(captured?.storeSessionId).toBe('s1');
    expect(captured?.resumeSessionId).toBe('s1');
    expect(result).toMatchObject({ sessionId: 's1', exitCode: 0, aborted: false });
  });
});

describe('Conductor — backend session state', () => {
  it('stores backend ids and resumes with the backend id, not the Verity session id', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    const seen: RunTurnOptions[] = [];
    let n = 0;
    const codex: Backend = {
      run: async (opts) => {
        seen.push(opts);
        await opts.onSession?.(`thread_${++n}`);
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      codexBackend: codex,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'one');
    await conductor.sendTurn('s1', 'two');

    expect(seen[0]?.storeSessionId).toBe('s1');
    expect(seen[0]?.resumeSessionId).toBeUndefined();
    expect(seen[0]?.appendSystemPrompt).toContain(CHOICES_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(DELEGATION_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(MEMORY_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(TERMINOLOGY_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(VISIBLE_MEDIA_SYSTEM_PROMPT);
    expect(seen[1]?.storeSessionId).toBe('s1');
    expect(seen[1]?.resumeSessionId).toBe('thread_1');
    expect(seen[1]?.appendSystemPrompt).toContain(TERMINOLOGY_SYSTEM_PROMPT);
    expect(seen[1]?.appendSystemPrompt).toContain(VISIBLE_MEDIA_SYSTEM_PROMPT);
    expect(seen[1]?.appendSystemPrompt).not.toContain(MEMORY_SYSTEM_PROMPT);
    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toMatchObject({
      backendSessionId: 'thread_2',
    });
  });

  it('clears a stale Codex backend id and retries with the Verity session id', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'missing_thread',
      contextSeq: 5,
    });
    const seenResumeIds: Array<string | undefined> = [];
    const codex: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        if (opts.resumeSessionId === 'missing_thread') {
          return {
            sessionId: opts.resumeSessionId,
            exitCode: 1,
            stderr: 'Error: thread/resume failed: no rollout found for thread id missing_thread',
            aborted: false,
          };
        }
        await opts.onSession?.(opts.resumeSessionId ?? 'thread_fresh');
        return {
          sessionId: opts.resumeSessionId ?? 'thread_fresh',
          exitCode: 0,
          stderr: '',
          aborted: false,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      codexBackend: codex,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'resume');

    expect(result.exitCode).toBe(0);
    expect(seenResumeIds).toEqual(['missing_thread', 's1']);
    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toMatchObject({
      backendSessionId: 's1',
    });
  });

  it('sends a Codex resume the ACP agent refused down the same ladder', async () => {
    // The neutral `staleResume` signal reaches Codex too, and it must not overtake
    // the ladder above: `codex-acp` answers a load it cannot serve with -32002, and
    // the second rung — resume by the Verity session id — still finds the rollouts
    // of sessions from before Codex minted its own thread ids. Short-circuiting to
    // a cold start there would discard a conversation that was still reachable.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'missing_thread',
      contextSeq: 5,
    });
    const seenResumeIds: Array<string | undefined> = [];
    const codex: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        if (opts.resumeSessionId === 'missing_thread') {
          // No phrasebook match: the protocol answered, the stderr did not say so.
          return {
            sessionId: undefined,
            exitCode: 1,
            stderr: 'Resource not found: missing_thread',
            aborted: false,
            staleResume: true,
          };
        }
        await opts.onSession?.(opts.resumeSessionId ?? 'thread_fresh');
        return {
          sessionId: opts.resumeSessionId ?? 'thread_fresh',
          exitCode: 0,
          stderr: '',
          aborted: false,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      codexBackend: codex,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'resume');

    expect(result.exitCode).toBe(0);
    expect(seenResumeIds).toEqual(['missing_thread', 's1']);
    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toMatchObject({
      backendSessionId: 's1',
    });
  });

  it('clears a stale Claude backend id and cold-starts with DB handoff context', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'die kuh heißt rosa' });
    const seq = (await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert.' })).seq;
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'missing-claude-thread',
      contextSeq: seq,
    });

    const seenResumeIds: Array<string | undefined> = [];
    const seenPrompts: string[] = [];
    const closedSessionIds: string[] = [];
    const claude: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        seenPrompts.push(opts.prompt ?? '');
        if (opts.resumeSessionId === 'missing-claude-thread') {
          return {
            sessionId: 's1',
            exitCode: 0,
            stderr: 'No conversation found with session ID: missing-claude-thread',
            aborted: false,
          };
        }
        await opts.onSession?.('fresh-claude-thread');
        return { sessionId: 'fresh-claude-thread', exitCode: 0, stderr: '', aborted: false };
      },
      closeSession: (sessionId) => {
        closedSessionIds.push(sessionId);
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'wie heißt die kuh?');

    expect(result.exitCode).toBe(0);
    expect(seenResumeIds).toEqual(['missing-claude-thread', undefined]);
    expect(closedSessionIds).toEqual(['missing-claude-thread']);
    expect(seenPrompts[1]).toContain('die kuh heißt rosa');
    expect(seenPrompts[1]).toContain('wie heißt die kuh?');
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'fresh-claude-thread',
    });
  });

  it('clears a Claude thread the ACP adapter answers with `Resource not found`', async () => {
    // Same wedge as the test above, reached through the ACP transport instead of
    // the native CLI: `session/load` for a conversation the adapter cannot restore
    // is refused with JSON-RPC -32002, never with Claude's own "No conversation
    // found" line. Recognizing only the CLI wording leaves every ACP session that
    // outlives its adapter state resuming the same dead id forever.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'die kuh heißt rosa' });
    const seq = (await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert.' })).seq;
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'missing-acp-thread',
      contextSeq: seq,
    });

    const seenResumeIds: Array<string | undefined> = [];
    const seenPrompts: string[] = [];
    const claude: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        seenPrompts.push(opts.prompt ?? '');
        if (opts.resumeSessionId === 'missing-acp-thread') {
          // What the adapter really reports, including the echoed bind that made
          // the conductor re-pin the dead pointer before this fix.
          return {
            sessionId: 'missing-acp-thread',
            exitCode: 1,
            stderr: 'Resource not found: missing-acp-thread',
            aborted: false,
          };
        }
        await opts.onSession?.('fresh-acp-thread');
        return { sessionId: 'fresh-acp-thread', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'wie heißt die kuh?');

    expect(result.exitCode).toBe(0);
    expect(seenResumeIds).toEqual(['missing-acp-thread', undefined]);
    // The cold retry carries the whole prior transcript, so nothing is lost.
    expect(seenPrompts[1]).toContain('die kuh heißt rosa');
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'fresh-acp-thread',
    });
  });

  it('keeps a live thread when `Resource not found` names something else', async () => {
    // -32002 is the ACP adapter's answer for ANY missing resource — a file, an
    // MCP server, another session. Reading it as a stale-resume verdict on its own
    // would throw away a healthy conversation on an unrelated lookup failure.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    const seq = (await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert.' })).seq;
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'live-acp-thread',
      contextSeq: seq,
    });

    const seenResumeIds: Array<string | undefined> = [];
    const claude: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        await opts.onSession?.('live-acp-thread');
        return {
          sessionId: 'live-acp-thread',
          exitCode: 1,
          stderr: 'Resource not found: file:///wt/s1/missing.md',
          aborted: false,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'lies die datei');

    expect(seenResumeIds).toEqual(['live-acp-thread']);
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'live-acp-thread',
    });
  });

  it('clears a pre-ACP OpenCode bind the ACP agent cannot load and starts cold', async () => {
    // The upgrade case for ADR 0012 Amendment 4. Sessions that ran on the retired
    // `opencode serve` transport carry a bind minted by that server, and no
    // `opencode acp` process will ever know one — so without a recovery path the
    // first post-upgrade turn wedges the session permanently: the refused resume
    // mints no id, so the dead bind is never replaced, and every later turn repeats.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'deepinfra/zai-org/GLM-5.2',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'die kuh heißt rosa' });
    const seq = (await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert.' })).seq;
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'opencode',
      backendSessionId: 'ses_legacy_http',
      contextSeq: seq,
    });

    const seenResumeIds: Array<string | undefined> = [];
    const seenPrompts: string[] = [];
    const openCode: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        seenPrompts.push(opts.prompt ?? '');
        if (opts.resumeSessionId !== undefined) {
          // What `runAcpTurn` reports for an ANSWERED `session/load` refusal: no
          // bind, and the protocol-level verdict that the conversation is gone.
          return {
            sessionId: undefined,
            exitCode: 1,
            stderr: 'Resource not found: ses_legacy_http',
            aborted: false,
            staleResume: true,
          };
        }
        await opts.onSession?.('opencode-session-fresh');
        return { sessionId: 'opencode-session-fresh', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      openCodeBackend: openCode,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'wie heißt die kuh?');

    expect(result.exitCode).toBe(0);
    expect(seenResumeIds).toEqual(['ses_legacy_http', undefined]);
    // Cold, but not amnesiac: the retry carries the prior transcript as handoff
    // context, so the operator's session keeps its history across the transport
    // change even though the agent-side conversation could not be restored.
    expect(seenPrompts[1]).toContain('die kuh heißt rosa');
    // Rebound to the ACP id, which also proves the row was cleared rather than
    // merely bypassed — the routing key stays `opencode`, the conductor's backend
    // key, which the transport change did not move.
    expect(await ctx.store.getSessionBackendState('s1', 'opencode')).toMatchObject({
      backendSessionId: 'opencode-session-fresh',
    });
  });

  it('keeps an OpenCode bind when the adapter fails without refusing the resume', async () => {
    // No `staleResume`: the run failed for some other reason, and discarding a live
    // conversation over an unrelated crash would silently drop the agent's context.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'deepinfra/zai-org/GLM-5.2',
    });
    const seq = (await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert.' })).seq;
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'opencode',
      backendSessionId: 'opencode-session-live',
      contextSeq: seq,
    });

    const seenResumeIds: Array<string | undefined> = [];
    const openCode: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        return {
          sessionId: 'opencode-session-live',
          exitCode: 1,
          stderr: 'opencode-acp exited unexpectedly',
          aborted: false,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      openCodeBackend: openCode,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'noch mal');

    expect(seenResumeIds).toEqual(['opencode-session-live']);
    expect(await ctx.store.getSessionBackendState('s1', 'opencode')).toMatchObject({
      backendSessionId: 'opencode-session-live',
    });
  });

  it('cold-starts a Claude turn whose ACP agent refused the load', async () => {
    // The neutral branch is not OpenCode's: `claude-acp` reports the same refusal
    // over the same protocol, and the stderr phrasebook above does not catch it —
    // a JSON-RPC `resourceNotFound` need not repeat the id the way the CLI's "No
    // conversation found with session ID: …" line does. Without this the session
    // is wedged: no bind is minted to replace the dead one, so every later turn
    // re-resumes it and fails the same way.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'die kuh heißt rosa' });
    const seq = (await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert.' })).seq;
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'missing-claude-thread',
      contextSeq: seq,
    });

    const seenResumeIds: Array<string | undefined> = [];
    const seenPrompts: string[] = [];
    const claude: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        seenPrompts.push(opts.prompt ?? '');
        if (opts.resumeSessionId !== undefined) {
          return {
            sessionId: undefined,
            exitCode: 1,
            stderr: 'Resource not found',
            aborted: false,
            staleResume: true,
          };
        }
        await opts.onSession?.('fresh-claude-thread');
        return { sessionId: 'fresh-claude-thread', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'wie heißt die kuh?');

    expect(result.exitCode).toBe(0);
    expect(seenResumeIds).toEqual(['missing-claude-thread', undefined]);
    // The refusal came before the prompt was ever delivered, so the retry repeats
    // nothing — and it carries the transcript, so the session keeps its history.
    expect(seenPrompts[1]).toContain('die kuh heißt rosa');
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'fresh-claude-thread',
    });
  });

  it('does not bind a guessed resume id that a failed turn merely echoed back', async () => {
    // With no recorded cursor a Claude-origin session resumes its own canonical id
    // as a guess. A backend that fails while echoing that guess back as its
    // `sessionId` has told us nothing — writing it down as the bind promotes the
    // guess to a recorded fact and pins later turns to a thread nobody opened.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.appendEvent('s1', {
      t: 'session',
      id: 's1',
      model: 'claude-opus-4-8',
      worktree: '/wt/s1',
    });

    const claude: Backend = {
      run: async (opts) => ({
        sessionId: opts.resumeSessionId,
        exitCode: 1,
        stderr: 'the gateway hung up',
        aborted: false,
      }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'sag was');

    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toBeUndefined();
  });

  it('cold-starts when a resume dies before the backend ever opens a session', async () => {
    // The backend prints "No conversation found" and exits before `system/init`, so
    // ingest THROWS instead of returning a RunResult — the stderr-based stale check
    // above never sees it. Without recovery the session is wedged for good: every
    // later turn re-resumes the same dead id and fails identically.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'die kuh heißt rosa' });
    const seq = (await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert.' })).seq;
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'missing-claude-thread',
      contextSeq: seq,
    });

    const seenResumeIds: Array<string | undefined> = [];
    const seenPrompts: string[] = [];
    const claude: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        seenPrompts.push(opts.prompt ?? '');
        if (opts.resumeSessionId === 'missing-claude-thread') {
          // The reason folded in behind the symptom, the way a transport that
          // reconstructs failures from their text alone delivers it.
          throw new NoSessionInitError(
            'stream ended with 2 event(s) but no session init\n' +
              'No conversation found with session ID: missing-claude-thread',
          );
        }
        await opts.onSession?.('fresh-claude-thread');
        return { sessionId: 'fresh-claude-thread', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    const result = await conductor.sendTurn('s1', 'wie heißt die kuh?');

    expect(result.exitCode).toBe(0);
    expect(seenResumeIds).toEqual(['missing-claude-thread', undefined]);
    expect(seenPrompts[1]).toContain('die kuh heißt rosa'); // the cold start carries the history
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'fresh-claude-thread',
    });
  });

  it('recovers when the no-init failure arrives as a plain Error across the transport', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'missing-claude-thread',
      contextSeq: 0,
    });
    const seenResumeIds: Array<string | undefined> = [];
    const claude: Backend = {
      run: async (opts) => {
        seenResumeIds.push(opts.resumeSessionId);
        if (opts.resumeSessionId !== undefined) {
          // Reconstructed from its message by the runner transport — no class identity,
          // so the stderr the runner folded in is all that carries the reason across.
          throw new Error(
            'stream ended with 2 event(s) but no session init\n' +
              'No conversation found with session ID: missing-claude-thread',
          );
        }
        await opts.onSession?.('fresh-claude-thread');
        return { sessionId: 'fresh-claude-thread', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    expect((await conductor.sendTurn('s1', 'weiter')).exitCode).toBe(0);
    expect(seenResumeIds).toEqual(['missing-claude-thread', undefined]);
  });

  it('lets an unrelated failure through instead of silently re-running the turn', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'live-claude-thread',
      contextSeq: 0,
    });
    let runs = 0;
    const claude: Backend = {
      run: async () => {
        runs += 1;
        throw new Error('disk on fire');
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s1', 'weiter')).rejects.toThrow('disk on fire');
    expect(runs).toBe(1); // no cold retry — that turn may well have done work
  });

  it('does not re-run a no-init failure that never names a missing conversation', async () => {
    // Truncated output from a backend that had already acted looks exactly like a
    // dead resume from the ingest side. Without the backend's own "No conversation
    // found" line there is no evidence the turn did nothing, so it must not be
    // repeated — a duplicated turn re-applies whatever the first one did.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'live-claude-thread',
      contextSeq: 0,
    });
    let runs = 0;
    const claude: Backend = {
      run: async () => {
        runs += 1;
        throw new NoSessionInitError('stream ended with 7 event(s) but no session init');
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s1', 'weiter')).rejects.toThrow('no session init');
    expect(runs).toBe(1);
    // The pointer stays put: nothing proved it stale.
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'live-claude-thread',
    });
  });

  it('records the backend session id as soon as it binds, not only when the turn settles', async () => {
    // A turn killed mid-flight (sandbox rebuild) must not leave the session without a
    // pointer to its backend thread — that absence is what makes the resume fallback
    // fall back to guessing the store id.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    const claude: Backend = {
      run: async (opts) => {
        await opts.onSession?.('claude-thread-1');
        throw new Error('sandbox rebuilt mid-turn');
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s1', 'los')).rejects.toThrow('sandbox rebuilt mid-turn');
    await vi.waitFor(async () => {
      expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
        backendSessionId: 'claude-thread-1',
      });
    });
  });

  it('does not let the discarded attempt’s bind write outlive the clear that drops it', async () => {
    // The bind write from `onSession` is fire-and-forget and does a `latestEventSeq`
    // round-trip before it lands, so it is still open when the stale resume is
    // detected. A delete issued past it would be undone by that late upsert — the
    // session would be re-pinned to the id recovery just discarded, i.e. wedged by
    // the very mechanism meant to unwedge it.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'doomed-thread',
      contextSeq: 0,
    });

    const ops: string[] = [];
    const upsert = ctx.store.upsertSessionBackendState.bind(ctx.store);
    const remove = ctx.store.deleteSessionBackendState.bind(ctx.store);
    vi.spyOn(ctx.store, 'upsertSessionBackendState').mockImplementation(async (row) => {
      const displaced = await upsert(row);
      ops.push(`upsert:${row.backendSessionId}`);
      return displaced;
    });
    vi.spyOn(ctx.store, 'deleteSessionBackendState').mockImplementation(async (id, backend) => {
      const removed = await remove(id, backend);
      ops.push('delete');
      return removed;
    });

    const claude: Backend = {
      run: async (opts) => {
        if (opts.resumeSessionId === 'doomed-thread') {
          await opts.onSession?.('doomed-thread');
          return {
            sessionId: 's1',
            exitCode: 0,
            stderr: 'No conversation found with session ID: doomed-thread',
            aborted: false,
          };
        }
        await opts.onSession?.('fresh-thread');
        return { sessionId: 'fresh-thread', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    expect((await conductor.sendTurn('s1', 'weiter')).exitCode).toBe(0);

    expect(ops.indexOf('delete')).toBeGreaterThan(ops.indexOf('upsert:doomed-thread'));
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'fresh-thread',
    });
    vi.restoreAllMocks();
  });
});

describe('Conductor — cross-backend context handoff via context_seq', () => {
  it('cold-starts a switched-to backend with the full prior history as a handoff preamble', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    // Prior Claude-era history lives in the backend-neutral event log.
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'die kuh heißt rosa' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert: die Kuh heißt Rosa.' });
    let captured: string | undefined;
    const codex: Backend = {
      run: async (opts) => {
        captured = opts.prompt;
        await opts.onSession?.('thread_1');
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      codexBackend: codex,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'wie heißt die kuh?');

    // The cold Codex backend has no native thread → the full prior history is folded in.
    expect(captured).toContain('die kuh heißt rosa');
    expect(captured).toContain('wie heißt die kuh?');
  });

  it('cold-starts Claude after a Codex-origin session switches to Claude', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    await ctx.store.appendEvent('s1', {
      t: 'session',
      id: 'codex-thread',
      model: 'codex/default',
      worktree: '/wt/s1',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'die kuh heißt rosa' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert: die Kuh heißt Rosa.' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'codex-thread',
      contextSeq: await ctx.store.latestEventSeq('s1'),
    });
    await ctx.store.setSessionModel('s1', 'claude-opus-4-8');

    let captured: string | undefined;
    let resumeId: string | undefined | null = null;
    const claude: Backend = {
      run: async (opts) => {
        captured = opts.prompt;
        resumeId = opts.resumeSessionId;
        return { sessionId: 'claude-thread', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'wie heißt die kuh?');

    expect(resumeId).toBeUndefined();
    expect(captured).toContain('die kuh heißt rosa');
    expect(captured).toContain('wie heißt die kuh?');
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'claude-thread',
    });
  });

  it('hands the switched-away backend’s binding to the artifact purge', async () => {
    // Binding Claude drops the Codex row, and that row was the only thing naming the
    // Codex rollout on the runner runtime — after this write nothing can resolve the
    // path again, so the transcript would outlive even a later delete of the session.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'codex-thread',
      contextSeq: 0,
    });
    await ctx.store.setSessionModel('s1', 'claude-opus-4-8');

    const purged: { sessionId: string; bindings: readonly { backend: string }[] }[] = [];
    const claude: Backend = {
      run: async () => ({ sessionId: 'claude-thread', exitCode: 0, stderr: '', aborted: false }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
      purgeBackendArtifacts: async (sessionId, bindings) => {
        purged.push({ sessionId, bindings });
      },
    });

    await conductor.sendTurn('s1', 'switch');

    expect(purged).toHaveLength(1);
    expect(purged[0]?.sessionId).toBe('s1');
    expect(purged[0]?.bindings).toEqual([
      expect.objectContaining({ backend: 'codex', backendSessionId: 'codex-thread' }),
    ]);
    // The backend it just switched TO keeps its files.
    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'claude-thread',
    });
  });

  it('binds the backend even when purging the displaced one throws', async () => {
    // A file that cannot be unlinked is a leak to log. Losing the resume state over it
    // would strand the session on a backend it can no longer continue.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'codex-thread',
      contextSeq: 0,
    });
    await ctx.store.setSessionModel('s1', 'claude-opus-4-8');

    const claude: Backend = {
      run: async () => ({ sessionId: 'claude-thread', exitCode: 0, stderr: '', aborted: false }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
      purgeBackendArtifacts: async () => {
        throw new Error('EACCES');
      },
    });

    await conductor.sendTurn('s1', 'switch');

    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'claude-thread',
    });
    expect(await ctx.store.getSessionBackendState('s1', 'codex')).toBeUndefined();
  });

  it('binds the backend without waiting out a purge that never returns', async () => {
    // The purge reads the store and walks a rollout archive, both on the shared data
    // volume. Awaiting it unconditionally puts a hung volume directly in the path of a
    // turn; the bound timeout turns that into a delay. What the timeout skips is a
    // transcript outliving its binding row, which is exactly what the startup sweep is
    // there to collect.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'codex-thread',
      contextSeq: 0,
    });
    await ctx.store.setSessionModel('s1', 'claude-opus-4-8');

    let releasePurge!: () => void;
    const purgeStarted = new Promise<void>((resolve) => {
      releasePurge = resolve;
    });
    const claude: Backend = {
      run: async () => ({ sessionId: 'claude-thread', exitCode: 0, stderr: '', aborted: false }),
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
      // Never settles, like the volume it stands in for.
      purgeBackendArtifacts: async () => {
        releasePurge();
        await new Promise<never>(() => {});
      },
    });

    vi.useFakeTimers();
    try {
      const turn = conductor.sendTurn('s1', 'switch');
      await purgeStarted;
      // Only the purge's own timer is pending here; advancing past it is what lets the
      // bind continue, which is the whole claim.
      await vi.advanceTimersByTimeAsync(10_000);
      await turn;
    } finally {
      vi.useRealTimers();
    }

    expect(await ctx.store.getSessionBackendState('s1', 'claude')).toMatchObject({
      backendSessionId: 'claude-thread',
    });
  });

  it('still resumes the canonical session id on a Claude-origin first Claude turn', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.appendEvent('s1', {
      t: 'session',
      id: 's1',
      model: 'claude-opus-4-8',
      worktree: '/wt/s1',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'hallo' });

    let captured: string | undefined;
    let resumeId: string | undefined | null = null;
    const claude: Backend = {
      run: async (opts) => {
        captured = opts.prompt;
        resumeId = opts.resumeSessionId;
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'wie geht es?');

    // Claude-origin → still implicitly resumes its own thread (the Verity session id);
    // same backend it was spawned on, so no handoff preamble.
    expect(resumeId).toBe('s1');
    expect(captured).toBe('wie geht es?');
  });

  it('prepends only the gap learned on another backend when resuming a stale native thread', async () => {
    // The session runs on Claude; it once saw the cow's name, was switched to Codex
    // (where it learned the friend's name), then switched back to Claude. Claude's
    // native thread holds everything up to its recorded cursor (the cow) but nothing
    // from the Codex detour (the friend) — that gap must ride along on resume, or the
    // model silently loses everything learned while it was switched away.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'die kuh heißt rosa' });
    const seenSeq = (
      await ctx.store.appendEvent('s1', { t: 'text', delta: 'Notiert: die Kuh heißt Rosa.' })
    ).seq;
    // Claude's cursor stops at the cow — everything after landed while on Codex.
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 's1',
      contextSeq: seenSeq,
    });
    // Codex-era turns, absent from Claude's native thread.
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'ihr freund ist ferdinand' });
    await ctx.store.appendEvent('s1', {
      t: 'text',
      delta: 'Notiert: Rosas Freund heißt Ferdinand.',
    });

    let captured: string | undefined;
    let resumeId: string | undefined;
    const claude: Backend = {
      run: async (opts) => {
        captured = opts.prompt;
        resumeId = opts.resumeSessionId;
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'und ihr freund?');

    // A native resume, not a cold start …
    expect(resumeId).toBe('s1');
    // … carrying the Codex-era gap the native thread never saw …
    expect(captured).toContain('ihr freund ist ferdinand');
    expect(captured).toContain('und ihr freund?');
    // … but NOT history the native thread already holds (a gap handoff, not a full one).
    expect(captured).not.toContain('die kuh heißt rosa');
  });

  it('sends a same-backend resume prompt verbatim when the native thread is already current', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'hello' });
    const seq = (await ctx.store.appendEvent('s1', { t: 'text', delta: 'hi there' })).seq;
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 's1',
      contextSeq: seq,
    });
    let captured: string | undefined;
    const claude: Backend = {
      run: async (opts) => {
        captured = opts.prompt;
        return { sessionId: 's1', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'next question');

    // No gap past the cursor → the prompt goes out plain, no handoff preamble (hot path).
    expect(captured).toBe('next question');
  });
});

describe('Conductor — backend routing by model (#143)', () => {
  function recordingBackend(): Backend & { ran: ReturnType<typeof vi.fn> } {
    const ran = vi.fn(async () => ({ sessionId: 's', exitCode: 0, stderr: '', aborted: false }));
    return { run: ran, ran };
  }

  it('routes a non-qualified (Claude) model to the default backend', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    const claude = recordingBackend();
    const opencode = recordingBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      openCodeBackend: opencode,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'go');

    expect(claude.ran).toHaveBeenCalled();
    expect(opencode.ran).not.toHaveBeenCalled();
  });

  it('routes a provider-qualified model to the OpenCode backend', async () => {
    await ctx.store.createSession({
      sessionId: 's2',
      worktree: '/wt/s2',
      model: 'deepinfra/moonshotai/Kimi-K2.6',
    });
    const claude = recordingBackend();
    const opencode = recordingBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      openCodeBackend: opencode,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s2', 'go');

    expect(opencode.ran).toHaveBeenCalled();
    expect(claude.ran).not.toHaveBeenCalled();
  });

  it('wraps the model-selected backend for project-bound resume turns', async () => {
    await ctx.store.createSession({
      sessionId: 's-project',
      worktree: '/wt/project',
      model: 'deepinfra/moonshotai/Kimi-K2.6',
    });
    const claude = recordingBackend();
    const opencode = recordingBackend();
    const wrapped = recordingBackend();
    const sessionBackend = vi.fn(async (_session, selected: Backend) => {
      expect(selected).toBe(opencode);
      return wrapped;
    });
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      openCodeBackend: opencode,
      sessionBackend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-project', 'go');

    expect(sessionBackend).toHaveBeenCalled();
    expect(wrapped.ran).toHaveBeenCalled();
    expect(opencode.ran).not.toHaveBeenCalled();
    expect(claude.ran).not.toHaveBeenCalled();
  });

  it('parks the session on awaiting_dependency while the backend is prepared', async () => {
    // A backend resolution that has to rebuild infrastructure first used to be
    // invisible until it either started or failed. Reporting it turns the wait into
    // a "Waiting" badge plus a transcript note, and hands the badge back once the
    // turn actually starts — the operator sees a pending turn, not a dead one.
    await ctx.store.createSession({ sessionId: 's-wait', worktree: '/wt/w', model: 'claude-x' });
    const backend = recordingBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      sessionBackend: async (_session, selected, preparation) => {
        expect(preparation.canWait).toBe(true);
        preparation.waitingOn('Rebuilding the Sandbox — the turn continues by itself.');
        return selected;
      },
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-wait', 'go');

    const events = await ctx.store.getEvents('s-wait');
    const prepared = events.filter((e) => e.t === 'notice' || e.t === 'status');
    expect(prepared).toEqual([
      {
        t: 'notice',
        text: 'Rebuilding the Sandbox — the turn continues by itself.',
        role: 'agent',
      },
      { t: 'status', state: 'awaiting_dependency' },
      { t: 'status', state: 'running' },
    ]);
    expect(backend.ran).toHaveBeenCalled();
  });

  it('reports the wait only once and releases the badge even when preparation fails', async () => {
    await ctx.store.createSession({ sessionId: 's-fail', worktree: '/wt/f', model: 'claude-x' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: recordingBackend(),
      sessionBackend: async (_session, _selected, preparation) => {
        preparation.waitingOn('first');
        preparation.waitingOn('second');
        throw new Error('sandbox is beyond repair');
      },
      worktreeExists: async () => true,
    });

    await expect(conductor.sendTurn('s-fail', 'go')).rejects.toThrow(/beyond repair/);

    const events = await ctx.store.getEvents('s-fail');
    expect(events.filter((e) => e.t === 'notice')).toEqual([
      { t: 'notice', text: 'first', role: 'agent' },
    ]);
    // Released back to `running`, so the terminal error the caller raises is what
    // decides the session's status — not a stale `awaiting_dependency`.
    expect(events.filter((e) => e.t === 'status')).toEqual([
      { t: 'status', state: 'awaiting_dependency' },
      { t: 'status', state: 'running' },
    ]);
  });

  it('writes nothing when the backend resolves without reporting a wait', async () => {
    await ctx.store.createSession({ sessionId: 's-quiet', worktree: '/wt/q', model: 'claude-x' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: recordingBackend(),
      sessionBackend: async (_session, selected) => selected,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s-quiet', 'go');

    const events = await ctx.store.getEvents('s-quiet');
    expect(events.some((e) => e.t === 'status' || e.t === 'notice')).toBe(false);
  });

  it('falls back to the default backend for a qualified model when no OpenCode backend is set', async () => {
    await ctx.store.createSession({ sessionId: 's3', worktree: '/wt/s3', model: 'deepinfra/x' });
    const claude = recordingBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s3', 'go');

    expect(claude.ran).toHaveBeenCalled();
  });

  it('routes codex-prefixed models to the Codex backend before the generic slash rule', async () => {
    await ctx.store.createSession({ sessionId: 's5', worktree: '/wt/s5', model: 'codex/default' });
    const claude = recordingBackend();
    const opencode = recordingBackend();
    const codex = recordingBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      openCodeBackend: opencode,
      codexBackend: codex,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s5', 'go');

    expect(codex.ran).toHaveBeenCalled();
    expect(opencode.ran).not.toHaveBeenCalled();
    expect(claude.ran).not.toHaveBeenCalled();
  });

  it('does not route codex-prefixed models to OpenCode when Codex is disabled', async () => {
    await ctx.store.createSession({ sessionId: 's6', worktree: '/wt/s6', model: 'codex/default' });
    const claude = recordingBackend();
    const opencode = recordingBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      openCodeBackend: opencode,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s6', 'go');

    expect(claude.ran).toHaveBeenCalled();
    expect(opencode.ran).not.toHaveBeenCalled();
  });

  it('treats ANY non-codex slash-bearing model as OpenCode by contract (Verity never emits a slash-prefixed Claude id)', async () => {
    // The model-string format IS the contract (ADR 0001): a `/` means OpenCode, even a
    // Claude-ish `anthropic/claude-…` proxy form. Verity's picker guarantees a Claude id
    // is always bare, so this boundary is by design, not an accident. This test pins it.
    await ctx.store.createSession({
      sessionId: 's4',
      worktree: '/wt/s4',
      model: 'anthropic/claude-opus-4-8',
    });
    const claude = recordingBackend();
    const opencode = recordingBackend();
    const conductor = new Conductor({
      store: ctx.store,
      backend: claude,
      openCodeBackend: opencode,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s4', 'go');

    expect(opencode.ran).toHaveBeenCalled();
    expect(claude.ran).not.toHaveBeenCalled();
  });
});

describe('Conductor — a throwing onTurnError sink cannot escalate (#24)', () => {
  // Install a one-shot unhandled-rejection trap, run `body`, then assert the trap
  // never fired and clean the listener up — so a throwing sink that escapes a void-ed
  // promise (which would crash Node on modern defaults) is caught HERE, in-test, and
  // the assertion doesn't bleed into sibling tests. Returns once `body`'s settle
  // condition holds, plus a couple of macrotask ticks so any deferred rejection has
  // a chance to surface before we assert it didn't.
  async function expectNoUnhandledRejection(body: () => Promise<void>): Promise<void> {
    let rejected: unknown;
    const onUnhandled = (reason: unknown): void => {
      rejected = reason ?? new Error('unhandled rejection with no reason');
    };
    process.once('unhandledRejection', onUnhandled);
    try {
      await body();
      // Let any already-scheduled rejection microtask/macrotask flush before asserting.
      await new Promise((r) => setTimeout(r, 20));
      expect(rejected).toBeUndefined();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  }

  const throwingSink = (): never => {
    throw new Error('sink boom');
  };

  it('dispatchTurn: a background failure whose sink THROWS still releases the lock and never escalates', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // A stream with events but no session init → ingest throws in the background,
    // AFTER acceptance resolved. The .catch then invokes onTurnError, which THROWS.
    const conductor = new Conductor({
      store: ctx.store,
      backend: scriptedBackend({ sessionId: null, text: 'hi', omitResult: true }).backend,
      onTurnError: throwingSink,
      worktreeExists: async () => true,
    });

    await expectNoUnhandledRejection(async () => {
      await conductor.dispatchTurn('s1', 'go'); // accepted; fails + throwing sink in bg
      // The guard makes the report non-throwing, so the `.finally` lock release runs.
      await waitFor(() => !conductor.isBusy('s1'));
      for (let i = 0; i < 20; i += 1) {
        if ((await ctx.store.getEvents('s1')).some((event) => event.t === 'error')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await ctx.store.getEvents('s1')).some((event) => event.t === 'error')).toBe(true);
    });
    expect(conductor.isBusy('s1')).toBe(false); // lock released despite the throwing sink
  });

  it('drainNext: a queued turn whose dispatch fails + a throwing sink still drains the next queued turn', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const prompts: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // In-flight 'one' holds until released; the drained turns run to completion.
    const fake = scriptedBackend((opts) => {
      const text = opts.prompt ?? '';
      if (text === 'one') return { during: () => gate };
      prompts.push(text);
      return {};
    });
    // worktreeExists is probed once per accepted turn: true for in-flight 'one'
    // (probe 1) and the second queued 'three' (probe 3), but false for the first
    // queued 'two' (probe 2) → its drain dispatch fails, hitting the throwing sink.
    let probes = 0;
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => {
        probes += 1;
        return probes !== 2;
      },
      onTurnError: throwingSink,
    });

    await expectNoUnhandledRejection(async () => {
      await conductor.dispatchTurn('s1', 'one'); // in flight
      await conductor.dispatchTurn('s1', 'two'); // queued — will fail on drain
      await conductor.dispatchTurn('s1', 'three'); // queued — must still run
      expect(conductor.queuedCount('s1')).toBe(2);

      release();
      // The throwing sink on 'two' must not strand the backlog: 'three' still drains.
      await waitFor(() => prompts.includes('three') && !conductor.isBusy('s1'));
    });
    expect(prompts).toEqual(['three']); // 'two' skipped, 'three' drained past it
    expect(conductor.queuedCount('s1')).toBe(0);
  });

  it('persistSteeredPrompt: a steered-prompt persist failure + a throwing sink never escalates', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // A store whose appendEvent rejects only for the steered prompt event — covers the
    // `void this.persistSteeredPrompt(...)` site, which has no caller-side `.catch`.
    const store = new Proxy(ctx.store, {
      get(target, prop, recv: unknown) {
        if (prop === 'appendEvent') {
          return async (
            sessionId: string,
            event: AgentEvent,
          ): Promise<{ seq: number; ts: number }> => {
            if (event.t === 'prompt' && event.text === 'boom steer') {
              throw new Error('steer prompt boom');
            }
            return target.appendEvent(sessionId, event);
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    });
    const fake = steerableBackend();
    const conductor = new Conductor({
      store,
      backend: fake.backend,
      worktreeExists: async () => true,
      onTurnError: throwingSink,
    });

    await expectNoUnhandledRejection(async () => {
      await conductor.dispatchTurn('s1', 'first');
      await waitFor(fake.ready);

      // Steered into the live turn; its fire-and-forget persist throws, and the sink
      // it routes to also throws — the guard must keep that from becoming unhandled.
      const res = await conductor.dispatchTurn('s1', 'boom steer');
      expect(res).toEqual({ queued: false });
      expect(fake.steered.map((m) => m.text)).toEqual(['boom steer']);

      fake.release();
      await waitFor(() => !conductor.isBusy('s1'));
    });
  });
});

describe('Conductor — mid-turn permission control loop (#27)', () => {
  /**
   * A backend that raises one permission prompt and then BLOCKS until the decision
   * comes back (the real agent pauses the turn there), settling once it does.
   * Records every decision so a test can assert what the operator's answer became.
   */
  function permissionBackend(
    toolUseId: string,
    requestId: string,
  ): { backend: Backend; decisions: () => PermissionDecision[] } {
    const decisions: PermissionDecision[] = [];
    const fake = scriptedBackend({
      during: async (turn) => {
        decisions.push(
          await turn.permission({
            requestId,
            toolName: 'Bash',
            input: { command: 'ls' },
            toolUseId,
          }),
        );
      },
    });
    return { backend: fake.backend, decisions: () => decisions };
  }

  it('parks a prompt under its tool_use_id and resolves it via decidePermission (allow)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = permissionBackend('toolu_a', 'req-1');
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
    });

    await conductor.dispatchTurn('s1', 'go');
    // The prompt is parked the moment claude surfaces it.
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('s1')).toEqual(['toolu_a']);
    });

    // Operator allows with edited input → handed back to the parked turn verbatim.
    const decided = await conductor.decidePermission('s1', 'toolu_a', {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });
    expect(decided).toBe(true);

    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
    expect(fake.decisions()).toEqual([{ behavior: 'allow', updatedInput: { command: 'ls -la' } }]);
    // The prompt is recorded in the transcript and the parked channel is cleared.
    expect((await ctx.store.getEvents('s1')).map((e) => e.t)).toContain('permission');
    expect(conductor.pendingPermissions('s1')).toEqual([]);
  });

  it('decidePermission returns false for an unknown / already-answered prompt', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = permissionBackend('toolu_b', 'req-2');
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
    });
    await conductor.dispatchTurn('s1', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('s1')).toEqual(['toolu_b']);
    });
    await expect(
      conductor.decidePermission('s1', 'toolu_b', { behavior: 'deny', message: 'no' }),
    ).resolves.toBe(true);
    // A second answer for the same id is a no-op (already resolved + cleared).
    await expect(conductor.decidePermission('s1', 'toolu_b', { behavior: 'allow' })).resolves.toBe(
      false,
    );
    // An unknown session / tool id is also false (never throws).
    await expect(conductor.decidePermission('ghost', 'x', { behavior: 'allow' })).resolves.toBe(
      false,
    );
    await vi.waitFor(() => {
      expect(conductor.isBusy('s1')).toBe(false);
    });
  });

  it('does not let a delayed permission ACK clear a replacement turn prompt', async () => {
    const conductor = new Conductor({ store: ctx.store, permissionControl: true });
    type TrackedPermissionRequest = {
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      toolUseId: string;
    };
    const tracked = (toolUseId: string): [string, TrackedPermissionRequest] => [
      toolUseId,
      { requestId: `req-${toolUseId}`, toolName: 'Bash', input: { command: 'ls' }, toolUseId },
    ];
    const internals = conductor as unknown as {
      turns: Map<string, RunnerTurn>;
      pendingPermissionRequests: Map<string, Map<string, TrackedPermissionRequest>>;
    };
    let acknowledge!: (applied: boolean) => void;
    const oldTurn: RunnerTurn = {
      result: new Promise(() => undefined),
      steer: () => Promise.resolve(false),
      answerPermission: () =>
        new Promise<boolean>((resolve) => {
          acknowledge = resolve;
        }),
      cancel: () => Promise.resolve(false),
    };
    internals.turns.set('s1', oldTurn);
    internals.pendingPermissionRequests.set('s1', new Map([tracked('old-tool')]));

    const delayed = conductor.decidePermission('s1', 'old-tool', { behavior: 'allow' });
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));

    // The old turn settles while its ACK is in flight; a queued replacement turn
    // then installs an unrelated prompt under the same session id.
    internals.pendingPermissionRequests.set('s1', new Map([tracked('new-tool')]));
    acknowledge(true);

    await expect(delayed).resolves.toBe(false);
    expect(conductor.pendingPermissions('s1')).toEqual(['new-tool']);
  });

  it('lets only one racing permission decision consume a delayed ACK', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    let acknowledge!: (applied: boolean) => void;
    const ack = new Promise<boolean>((resolve) => {
      acknowledge = resolve;
    });
    const conductor = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      permissionControl: true,
      runner: () => ({
        startTurn: (_opts, hooks) => {
          hooks.onPermissionRequest?.({
            requestId: 'req-race',
            toolName: 'Bash',
            input: { command: 'true' },
            toolUseId: 'tool-race',
          });
          return {
            result: new Promise<RunResult>(() => undefined),
            steer: () => Promise.resolve(false),
            answerPermission: () => ack,
            cancel: () => Promise.resolve(true),
          };
        },
      }),
    });
    await conductor.dispatchTurn('s1', 'go');
    await vi.waitFor(() => expect(conductor.pendingPermissions('s1')).toEqual(['tool-race']));

    const first = conductor.decidePermission('s1', 'tool-race', { behavior: 'allow' });
    const second = conductor.decidePermission('s1', 'tool-race', { behavior: 'allow' });
    acknowledge(true);

    await expect(first).resolves.toBe(true);
    await expect(second).rejects.toBeInstanceOf(PermissionDecisionInProgressError);
    expect(conductor.pendingPermissions('s1')).toEqual([]);
  });

  it('does NOT ask the backend for the control loop when permissionControl is off', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      // permissionControl omitted → default OFF
    });
    await conductor.sendTurn('s1', 'go');
    // Each backend translates this into its own posture (ACP's permission mode, the
    // CLI's prompt tool); what the Conductor owns is not requesting it.
    expect(fake.last().permissionControl).toBeUndefined();
  });
});

describe('Conductor auto-title', () => {
  // A backend that serves BOTH a turn (`run`) and the one-shot title (`query`) —
  // the same model-routed seam the real auto-titler uses — recording each title
  // call's model and prompt. An empty `title` models a generation that came back
  // with nothing.
  function titleAwareBackend(title: string): {
    backend: Backend;
    titleCalls: { model: string | undefined; prompt: string | undefined }[];
  } {
    const titleCalls: { model: string | undefined; prompt: string | undefined }[] = [];
    const fake = scriptedBackend({ text: 'hi' });
    return {
      backend: {
        run: fake.backend.run.bind(fake.backend),
        query: (input) => {
          titleCalls.push({ model: input.model, prompt: input.prompt });
          return Promise.resolve(title.length > 0 ? title : undefined);
        },
      },
      titleCalls,
    };
  }

  it('names an unnamed session after N turns, using the SESSION model (not a default)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'sonnet' });
    const { backend, titleCalls } = titleAwareBackend('Auth Refactor');
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoTitle: { afterTurns: 2 },
    });

    await conductor.sendTurn('s1', 'first message');
    expect(titleCalls).toHaveLength(0); // only one turn so far
    expect((await ctx.store.getSession('s1'))?.name ?? null).toBeNull();

    await conductor.sendTurn('s1', 'second message');
    await vi.waitFor(async () => {
      expect((await ctx.store.getSession('s1'))?.name).toBe('Auth Refactor');
    });
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]!.model).toBe('sonnet'); // routed to the session's own model
    expect(titleCalls[0]!.prompt).toContain('User: first message');
    expect(titleCalls[0]!.prompt).toContain('User: second message');
  });

  it('never overwrites a name the operator already set', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      name: 'Kept',
    });
    const { backend, titleCalls } = titleAwareBackend('Auto');
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoTitle: { afterTurns: 1 },
    });
    await conductor.sendTurn('s1', 'hello');
    // The settle check runs fire-and-forget; give it a beat, then assert it no-opped.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(titleCalls).toHaveLength(0);
    expect((await ctx.store.getSession('s1'))?.name).toBe('Kept');
  });

  it('does nothing when no autoTitle is configured', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { backend, titleCalls } = titleAwareBackend('Auto');
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });
    await conductor.sendTurn('s1', 'hello');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(titleCalls).toHaveLength(0);
    expect((await ctx.store.getSession('s1'))?.name ?? null).toBeNull();
  });

  it('attempts only once even when the title comes back empty', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { backend, titleCalls } = titleAwareBackend(''); // empty output → no rename
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      autoTitle: { afterTurns: 1 },
    });
    await conductor.sendTurn('s1', 'one');
    await vi.waitFor(() => expect(titleCalls).toHaveLength(1));
    await conductor.sendTurn('s1', 'two');
    // Settled-and-gave-up: the next turn must not retry a failed generation.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(titleCalls).toHaveLength(1);
    expect((await ctx.store.getSession('s1'))?.name ?? null).toBeNull();
  });

  it('names at turn START from the prompt, before the turn settles', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'sonnet' });
    const titleCalls: { prompt: string | undefined }[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A turn that HANGS (never settles) until released, so a title that appears
    // could only have come from the turn-start attempt, not the settle fallback.
    const hanging = scriptedBackend({ during: () => gate });
    const conductor = new Conductor({
      store: ctx.store,
      backend: {
        run: hanging.backend.run.bind(hanging.backend),
        query: (input) => {
          titleCalls.push({ prompt: input.prompt });
          return Promise.resolve('Prompt Title');
        },
      },
      worktreeExists: async () => true,
      autoTitle: { afterTurns: 1 },
    });

    await conductor.dispatchTurn('s1', 'go'); // background; returns on acceptance
    // The name lands while the turn is still in flight (gate closed) — off the
    // operator's prompt, concurrently with the turn, not on settle.
    await vi.waitFor(async () => {
      expect((await ctx.store.getSession('s1'))?.name).toBe('Prompt Title');
    });
    expect(conductor.isBusy('s1')).toBe(true); // titled WITHOUT the turn settling
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]!.prompt).toContain('User: go'); // digest built from the prompt

    release();
    await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
    expect(titleCalls).toHaveLength(1); // settle didn't spawn a second generation
  });

  it('emits an English branch name when an auto-title lands', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'sonnet' });
    const branchNames: { worktree: string; branchName: string }[] = [];
    const prompts: string[] = [];
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: {
        run: fake.backend.run.bind(fake.backend),
        query: (input) => {
          prompts.push(input.prompt);
          return Promise.resolve(
            input.prompt.includes('<type>/<slug>') ? 'fix/session-branch-rename' : 'Sitzungstitel',
          );
        },
      },
      worktreeExists: async () => true,
      autoTitle: {
        afterTurns: 1,
        onBranchName: async (session, branchName) => {
          branchNames.push({ worktree: session.worktree, branchName });
        },
      },
    });

    await conductor.sendTurn('s1', 'benenne den Branch automatisch');
    await vi.waitFor(() => {
      expect(branchNames).toEqual([
        { worktree: '/wt/s1', branchName: 'fix/session-branch-rename' },
      ]);
    });
    expect((await ctx.store.getSession('s1'))?.name).toBe('Sitzungstitel');
    expect(prompts).toHaveLength(2);
  });

  it('keeps a throwing branch hook off the turn (the title still lands)', async () => {
    // A control-plane session's worktree is not a git repo, so the real hook's
    // `git rev-parse --abbrev-ref HEAD` fails. That must not reach `onTurnError` —
    // the operator's turn itself succeeded.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'sonnet' });
    const turnErrors: unknown[] = [];
    let hookCalls = 0;
    const fake = scriptedBackend({ text: 'hi' });
    const conductor = new Conductor({
      store: ctx.store,
      backend: {
        run: fake.backend.run.bind(fake.backend),
        query: (input) =>
          Promise.resolve(
            input.prompt.includes('<type>/<slug>') ? 'fix/session-branch-rename' : 'Sitzungstitel',
          ),
      },
      worktreeExists: async () => true,
      onTurnError: (_sessionId, error) => turnErrors.push(error),
      autoTitle: {
        afterTurns: 1,
        onBranchName: async () => {
          hookCalls += 1;
          throw new Error('fatal: not a git repository');
        },
      },
    });

    await conductor.sendTurn('s1', 'benenne den Branch automatisch');
    await vi.waitFor(() => expect(hookCalls).toBe(1));
    await vi.waitFor(() => expect(conductor.isBusy('s1')).toBe(false));
    expect((await ctx.store.getSession('s1'))?.name).toBe('Sitzungstitel');
    expect(turnErrors).toEqual([]);
  });

  it('titles without a bus configured (no live stream needed)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const { backend, titleCalls } = titleAwareBackend('Named');
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
      // No bus: firing off the prompt at turn start needs no live stream to watch.
      autoTitle: { afterTurns: 1 },
    });
    await conductor.sendTurn('s1', 'hello');
    await vi.waitFor(async () => {
      expect((await ctx.store.getSession('s1'))?.name).toBe('Named');
    });
    expect(titleCalls).toHaveLength(1);
  });
});

describe('Conductor — durable session system prompt', () => {
  it('injects hidden session context on the first real turn and again after a failed cold start', async () => {
    await ctx.store.createSession({ sessionId: 'control', worktree: '/wt/control', model: 'm' });
    const seen: RunTurnOptions[] = [];
    let attempt = 0;
    const backend: Backend = {
      run: async (opts) => {
        seen.push(opts);
        attempt += 1;
        if (attempt === 1) {
          return { sessionId: '', exitCode: 1, stderr: 'login required', aborted: false };
        }
        await opts.onSession?.('control-thread');
        return { sessionId: 'control-thread', exitCode: 0, stderr: '', aborted: false };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      sessionSystemPrompt: (session) =>
        session.sessionId === 'control' ? '# Durable control capabilities' : '',
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('control', 'first');
    await conductor.sendTurn('control', 'retry');

    expect(seen).toHaveLength(2);
    expect(seen[0]?.resumeSessionId).toBeUndefined();
    expect(seen[1]?.resumeSessionId).toBeUndefined();
    expect(seen[0]?.appendSystemPrompt).toContain('# Durable control capabilities');
    expect(seen[1]?.appendSystemPrompt).toContain('# Durable control capabilities');
    expect(
      (await ctx.store.getEvents('control')).filter((event) => event.t === 'prompt'),
    ).toHaveLength(2);
  });

  it('does not duplicate MCP tool instructions in fresh or resumed ACP contexts', async () => {
    await ctx.store.createSession({
      sessionId: 'brokered-http-prompt',
      worktree: '/wt/brokered-http-prompt',
      model: 'm',
    });
    const seen: RunTurnOptions[] = [];
    const backend: Backend = {
      runnerSupervisorBackend: 'codex-acp',
      run: async (opts) => {
        seen.push(opts);
        await opts.onSession?.('brokered-http-thread');
        return {
          sessionId: 'brokered-http-thread',
          exitCode: 0,
          stderr: '',
          aborted: false,
        };
      },
    };
    const conductor = new Conductor({
      store: ctx.store,
      backend,
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('brokered-http-prompt', 'first');
    await conductor.sendTurn('brokered-http-prompt', 'second');

    expect(seen).toHaveLength(2);
    for (const opts of seen) {
      expect(opts.appendSystemPrompt).not.toContain('verity_http_request');
      expect(opts.appendSystemPrompt).not.toContain('DOPPLER_TOKEN');
      expect(opts.appendSystemPrompt).not.toContain('Do not read, print, materialize');
    }

    const unsupportedSeen: RunTurnOptions[] = [];
    const unsupported = new Conductor({
      store: ctx.store,
      backend: {
        run: async (opts) => {
          unsupportedSeen.push(opts);
          return { sessionId: 'unsupported', exitCode: 0, stderr: '', aborted: false };
        },
      },
      worktreeExists: async () => true,
    });
    await unsupported.sendTurn('brokered-http-prompt', 'third');
    expect(unsupportedSeen[0]?.appendSystemPrompt).not.toContain('verity_http_request');
  });
});

describe('Conductor — project memory injection (ADR 0008)', () => {
  const MEMORY_HEADER = '## Project memory';

  function captureBackend(seen: RunTurnOptions[]): Backend {
    let n = 0;
    return {
      run: async (opts) => {
        seen.push(opts);
        await opts.onSession?.(`thread_${++n}`);
        return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
      },
    };
  }

  it('injects project memory into a pre-created Agent Loop session', async () => {
    await ctx.store.upsertProject({
      id: 'p-loop',
      owner: 'example-org',
      repo: 'verity',
      containerName: 'dev-example-org-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 'loop-memory',
      worktree: '/wt/loop-memory',
      model: 'codex/default',
      projectId: 'p-loop',
      kind: 'agent_loop',
    });
    await ctx.store.appendProjectMemory('p-loop', 'keep the loop deterministic');

    const seen: RunTurnOptions[] = [];
    const conductor = new Conductor({
      store: ctx.store,
      codexBackend: captureBackend(seen),
      worktreeExists: async () => true,
    });

    await conductor.startSession({
      sessionId: 'loop-memory',
      sessionKind: 'agent_loop',
      worktree: '/wt/loop-memory',
      prompt: 'Configure this Agent Loop',
      model: 'codex/default',
    });
    await waitFor(() => !conductor.isBusy('loop-memory'));

    expect(seen[0]?.appendSystemPrompt).toContain(AGENT_LOOP_PROPOSAL_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(MEMORY_HEADER);
    expect(seen[0]?.appendSystemPrompt).toContain('keep the loop deterministic');
  });

  it('injects project memory on the fresh-context turn but not on resume', async () => {
    await ctx.store.upsertProject({
      id: 'p1',
      owner: 'example-org',
      repo: 'verity',
      containerName: 'dev-example-org-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'codex/default',
      projectId: 'p1',
    });
    await ctx.store.appendProjectMemory('p1', 'prefers vitest over jest');

    const seen: RunTurnOptions[] = [];
    const conductor = new Conductor({
      store: ctx.store,
      codexBackend: captureBackend(seen),
      worktreeExists: async () => true,
    });

    await conductor.sendTurn('s1', 'one');
    await conductor.sendTurn('s1', 'two');

    // Fresh context: runtime policy AND memory ride the system prompt.
    expect(seen[0]?.resumeSessionId).toBeUndefined();
    expect(seen[0]?.appendSystemPrompt).toContain(CHOICES_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(MEMORY_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(MEMORY_HEADER);
    expect(seen[0]?.appendSystemPrompt).toContain('prefers vitest over jest');
    // Resume turn: main now repeats the terminology policy, but the context
    // already carries project memory, so that block is not re-injected.
    expect(seen[1]?.resumeSessionId).toBe('thread_1');
    expect(seen[1]?.appendSystemPrompt).not.toContain(MEMORY_SYSTEM_PROMPT);
    expect(seen[1]?.appendSystemPrompt).not.toContain(MEMORY_HEADER);
    expect(seen[1]?.appendSystemPrompt).not.toContain('prefers vitest over jest');
  });

  it('omits the memory block when the project has no memory set', async () => {
    await ctx.store.upsertProject({
      id: 'p2',
      owner: 'example-org',
      repo: 'other',
      containerName: 'dev-example-org-other',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's2',
      worktree: '/wt/s2',
      model: 'codex/default',
      projectId: 'p2',
    });

    const seen: RunTurnOptions[] = [];
    const conductor = new Conductor({
      store: ctx.store,
      codexBackend: captureBackend(seen),
      worktreeExists: async () => true,
    });
    await conductor.sendTurn('s2', 'one');

    expect(seen[0]?.appendSystemPrompt).toContain(CHOICES_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(MEMORY_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).not.toContain(MEMORY_HEADER);
  });

  it('omits the memory block for a session with no project', async () => {
    await ctx.store.createSession({ sessionId: 's3', worktree: '/wt/s3', model: 'codex/default' });

    const seen: RunTurnOptions[] = [];
    const conductor = new Conductor({
      store: ctx.store,
      codexBackend: captureBackend(seen),
      worktreeExists: async () => true,
    });
    await conductor.sendTurn('s3', 'one');

    expect(seen[0]?.appendSystemPrompt).toContain(CHOICES_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).toContain(MEMORY_SYSTEM_PROMPT);
    expect(seen[0]?.appendSystemPrompt).not.toContain(MEMORY_HEADER);
  });
});

describe('brokeredGrantTarget — what a standing grant is allowed to cover', () => {
  it('derives a reusable target only for a hash-bound trusted CLI entry script', () => {
    expect(
      brokeredGrantTarget('verity_secret_run', {
        secrets: [
          { secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'ASC_PRIVATE_KEY' },
          { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY_ID' },
        ],
        command: ['/usr/local/bin/fastlane', 'deliver'],
      }),
    ).toBeUndefined();
    const input = {
      secrets: [
        { secretAlias: 'TOKEN', env: 'TOKEN' },
        { secretAlias: 'KEY_ID', env: 'KEY_ID' },
      ],
      command: ['/usr/bin/python3', '/work/project/deploy.py', '--apply'],
      entryScript: {
        path: '/work/project/deploy.py',
        projectPath: 'deploy.py',
        sha256: 'a'.repeat(64),
        loading: 'isolated',
      },
    };
    const target = brokeredGrantTarget('verity_secret_run', input);
    expect(target).toMatchObject({ secretAlias: 'KEY_ID', toolName: 'verity_secret_run' });
    expect(target?.secretAliases).toEqual(['KEY_ID', 'TOKEN']);
    expect(target?.target).toMatch(/^v1:\/usr\/bin\/python3#[a-f0-9]{64}$/u);
    expect(
      brokeredGrantTarget('verity_secret_run', {
        ...input,
        secrets: [...input.secrets].reverse(),
      }),
    ).toEqual(target);
    expect(
      brokeredGrantTarget('verity_secret_run', {
        ...input,
        entryScript: { ...input.entryScript, sha256: 'b'.repeat(64) },
      })?.target,
    ).not.toBe(target?.target);
    expect(
      brokeredGrantTarget('verity_secret_run', {
        ...input,
        secrets: [
          { secretAlias: 'TOKEN', env: 'TOKEN_FILE', injection: 'file' },
          { secretAlias: 'KEY_ID', env: 'KEY_ID' },
        ],
      })?.target,
    ).not.toBe(target?.target);
    expect(
      brokeredGrantTarget('verity_secret_run', {
        ...input,
        entryScript: { ...input.entryScript, loading: 'dynamic' },
      }),
    ).toBeUndefined();
    // Inline and unrelated shapes remain one-time.
    expect(
      brokeredGrantTarget('verity_secret_run', {
        secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY',
        url: 'https://api.appstoreconnect.apple.com/v1/apps',
      }),
    ).toBeUndefined();
  });

  it('reduces an HTTP request to the destination host', () => {
    expect(
      brokeredGrantTarget('verity_http_request', {
        secretAlias: 'REVENUECAT_ADMIN_KEY',
        url: 'https://api.revenuecat.com/v2/projects?limit=10',
      })?.target,
    ).toBe('api.revenuecat.com');
    expect(
      brokeredGrantTarget('verity_http_request', {
        secretAlias: 'REVENUECAT_ADMIN_KEY',
        url: 'not a url',
      }),
    ).toBeUndefined();
  });

  // A JWT request resolves aliases the grant row never records, so the host
  // alone would let an "Always" cover an assertion the operator never saw.
  it('binds a minted assertion into the target, lifetime included', () => {
    const jwt = (auth: Record<string, unknown>): string | undefined =>
      brokeredGrantTarget('verity_http_request', {
        secretAlias: 'ASC_PRIVATE_KEY',
        url: 'https://api.appstoreconnect.apple.com/v1/apps',
        auth: {
          kind: 'jwt',
          algorithm: 'ES256',
          audience: 'appstoreconnect-v1',
          issuer: { alias: 'ASC_ISSUER_ID' },
          keyId: { alias: 'ASC_KEY_ID' },
          ...auth,
        },
      })?.target;
    const approved = jwt({ expiresInSeconds: 600 });
    // The whole digest, not a prefix: the agent authors both claim sets, so a
    // truncated descriptor is a birthday search away from letting an approved
    // target cover an assertion the operator never saw.
    expect(approved).toMatch(/^api\.appstoreconnect\.apple\.com#jwt:[0-9a-f]{64}$/u);
    // Omitting the lifetime is the same request as naming the default, and must
    // not cost a second card.
    expect(jwt({})).toBe(approved);
    // Stretching it is not: the window in which a leaked assertion still works
    // is part of what was approved.
    expect(jwt({ expiresInSeconds: 1200 })).not.toBe(approved);
    // Nor is pointing a claim at a different alias.
    expect(jwt({ issuer: { alias: 'OTHER_ISSUER_ID' } })).not.toBe(approved);
    // Static auth stays on the bare host, so grants kept before any of this
    // existed still answer.
    expect(
      brokeredGrantTarget('verity_http_request', {
        secretAlias: 'ASC_PRIVATE_KEY',
        url: 'https://api.appstoreconnect.apple.com/v1/apps',
        auth: { header: 'authorization', scheme: 'Bearer' },
      })?.target,
    ).toBe('api.appstoreconnect.apple.com');
  });
});

describe('Conductor — scoped brokered-HTTP grants (ADR 0011 D2)', () => {
  const httpToolInput = {
    method: 'GET',
    url: 'https://api.revenuecat.com/v2/projects',
    secretAlias: 'REVENUECAT_ADMIN_KEY',
    auth: { header: 'authorization', scheme: 'Bearer' },
  };
  const trustedCliToolInput = {
    secrets: [
      { secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'ASC_PRIVATE_KEY' },
      { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY_ID' },
    ],
    command: ['/usr/local/bin/fastlane', 'deliver'],
  };

  /**
   * Build a backend whose turn raises exactly one brokered-tool prompt and records
   * the decision it gets back. The recorded decisions are the seam that replaces
   * watching a `control_response` go down the agent's stdin: an empty list means the
   * prompt is still parked, one entry means the turn was answered with that verdict.
   */
  function promptingBackend(
    toolName: string,
    input: Record<string, unknown>,
  ): (
    toolUseId: string,
    requestId: string,
    /** Transport the turn ends up running on. Only the channel the scripted prompt
     *  stamps on its transcript card follows from this — the channel a grant is
     *  redeemed on is the conductor's own read of the RESOLVED backend, which is what
     *  these tests assert. Pass `claude-acp` alongside {@link onAcpTransport} so the
     *  card and the redemption agree the way they do in production. */
    promptTransport?: RunnerSupervisorBackend,
  ) => { backend: Backend; decisions: () => PermissionDecision[] } {
    return (toolUseId, requestId, promptTransport = 'codex-acp') => {
      const decisions: PermissionDecision[] = [];
      const fake = scriptedBackend({
        grantChannel: brokeredGrantChannel({ runnerSupervisorBackend: promptTransport } as Backend),
        during: async (turn) => {
          decisions.push(await turn.permission({ requestId, toolName, input, toolUseId }));
        },
      });
      const backend: Backend = {
        // Claude's native transport is retired, so Codex stands in as the attested
        // native runner protocol a prompt can arrive over (ADR 0014 D3). Tests that
        // want the restricted channel wrap this in `onAcpTransport`.
        runnerSupervisorBackend: 'codex-acp',
        run: (opts) => fake.backend.run(opts),
      };
      return { backend, decisions: () => decisions };
    };
  }

  const httpPermissionBackend = promptingBackend('verity_http_request', httpToolInput);
  const trustedCliPermissionBackend = promptingBackend('verity_secret_run', trustedCliToolInput);

  async function createProjectSession(sessionId: string): Promise<void> {
    await ctx.store.upsertProject({
      id: 'project-g',
      owner: 'acme',
      repo: 'app',
      containerName: 'verity-acme-app',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId,
      worktree: `/wt/${sessionId}`,
      model: 'm',
      projectId: 'project-g',
    });
  }

  it('does not persist a scoped allow when the HTTP input was edited and rejected', async () => {
    await createProjectSession('sg1');
    const fake = httpPermissionBackend('toolu_scope', 'req-scope');
    const persist = vi.fn(async (): Promise<void> => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      persistBrokeredHttpGrant: persist,
    });
    await conductor.dispatchTurn('sg1', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg1')).toEqual(['toolu_scope']);
    });
    const onScopeSaved = vi.fn();
    await expect(
      conductor.decidePermission(
        'sg1',
        'toolu_scope',
        {
          behavior: 'allow',
          updatedInput: {
            secretAlias: 'UPDATED_KEY',
            url: 'https://updated.example:8443/v2/projects',
          },
        },
        { scope: 'project', onScopeSaved },
      ),
    ).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
    expect(onScopeSaved).toHaveBeenCalledWith(false);
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg1')).toBe(false);
    });
  });

  it('does not persist a grant for a plain (once) allow', async () => {
    await createProjectSession('sg2');
    const fake = httpPermissionBackend('toolu_once', 'req-once');
    const persist = vi.fn(async (): Promise<void> => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      persistBrokeredHttpGrant: persist,
    });
    await conductor.dispatchTurn('sg2', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg2')).toEqual(['toolu_once']);
    });
    await conductor.decidePermission('sg2', 'toolu_once', { behavior: 'allow' });
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg2')).toBe(false);
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('settles an executed request when scoped grant persistence fails', async () => {
    await createProjectSession('sg-failed');
    const fake = httpPermissionBackend('toolu_failed', 'req-failed');
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      persistBrokeredHttpGrant: async () => {
        throw new Error('database unavailable');
      },
    });
    await conductor.dispatchTurn('sg-failed', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg-failed')).toEqual(['toolu_failed']);
    });
    const onScopeSaved = vi.fn();
    await expect(
      conductor.decidePermission(
        'sg-failed',
        'toolu_failed',
        { behavior: 'allow' },
        { scope: 'project', onScopeSaved },
      ),
    ).resolves.toBe(true);
    expect(onScopeSaved).toHaveBeenCalledWith(false);
    // The request still executed — a grant that could not be saved must not turn
    // into a decision the agent never received.
    await vi.waitFor(() => {
      expect(fake.decisions()).toEqual([{ behavior: 'allow' }]);
    });
    expect(conductor.pendingPermissions('sg-failed')).toEqual([]);
  });

  it('auto-approves a prompt covered by a persisted grant without operator action', async () => {
    await createProjectSession('sg3');
    const fake = httpPermissionBackend('toolu_auto', 'req-auto');
    const check = vi.fn(async () => true);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      checkBrokeredHttpGrant: check,
    });
    await conductor.dispatchTurn('sg3', 'go');
    // No decidePermission call — the grant answers the prompt.
    await vi.waitFor(() => {
      expect(fake.decisions()).toEqual([{ behavior: 'allow' }]);
    });
    expect(check).toHaveBeenCalledWith({
      projectId: 'project-g',
      sessionId: 'sg3',
      secretAlias: 'REVENUECAT_ADMIN_KEY',
      toolName: 'verity_http_request',
      target: 'api.revenuecat.com',
      channel: 'acp',
    });
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg3')).toBe(false);
    });
    expect(conductor.pendingPermissions('sg3')).toEqual([]);
  });

  /** The turn's backend, but announcing an ACP transport. The conductor derives the
   *  grant channel from the resolved backend object (ADR 0014 D3), so this is the only
   *  thing a test has to change to move a prompt onto the unattested channel. */
  const onAcpTransport = (backend: Backend): Backend => ({
    runnerSupervisorBackend: 'claude-acp',
    run: async (opts) => backend.run(opts),
  });

  it('redeems and records a grant on the ACP channel when the turn runs through ACP', async () => {
    await createProjectSession('sg-acp');
    const fake = httpPermissionBackend('toolu_acp', 'req-acp', 'claude-acp');
    const check = vi.fn(async () => true);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      checkBrokeredHttpGrant: check,
      sessionBackend: async (_session, selected) => onAcpTransport(selected),
    });
    await conductor.dispatchTurn('sg-acp', 'go');
    await vi.waitFor(() => {
      expect(check).toHaveBeenCalled();
    });
    // The channel is never taken from the prompt or the tool input — both are agent
    // authored — so it can only follow the backend the conductor resolved for the turn.
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ channel: 'acp' }));
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg-acp')).toBe(false);
    });
  });

  it('persists a scoped grant against the channel the decision was made on', async () => {
    await createProjectSession('sg-acp-persist');
    const fake = httpPermissionBackend('toolu_acp_persist', 'req-acp-persist', 'claude-acp');
    const persist = vi.fn(async (): Promise<void> => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      persistBrokeredHttpGrant: persist,
      sessionBackend: async (_session, selected) => onAcpTransport(selected),
    });
    await conductor.dispatchTurn('sg-acp-persist', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg-acp-persist')).toEqual(['toolu_acp_persist']);
    });
    const onScopeSaved = vi.fn();
    await expect(
      conductor.decidePermission(
        'sg-acp-persist',
        'toolu_acp_persist',
        { behavior: 'allow' },
        { scope: 'project', onScopeSaved },
      ),
    ).resolves.toBe(true);
    expect(onScopeSaved).toHaveBeenCalledWith(true);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', channel: 'acp' }),
    );
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg-acp-persist')).toBe(false);
    });
  });

  it('requires a concrete one-time approval for trusted CLI commands', async () => {
    await createProjectSession('sg-cli');
    const fake = trustedCliPermissionBackend('toolu_cli', 'req-cli');
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
    });
    await conductor.dispatchTurn('sg-cli', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg-cli')).toEqual(['toolu_cli']);
    });
    await expect(
      conductor.decidePermission('sg-cli', 'toolu_cli', { behavior: 'allow' }),
    ).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg-cli')).toBe(false);
    });
  });

  it('executes a trusted CLI allow but refuses to persist forever scope', async () => {
    await createProjectSession('sg-cli-forever');
    const fake = trustedCliPermissionBackend('toolu_cli_forever', 'req-cli-forever');
    const persist = vi.fn(async () => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      persistBrokeredHttpGrant: persist,
    });
    await conductor.dispatchTurn('sg-cli-forever', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg-cli-forever')).toEqual(['toolu_cli_forever']);
    });
    const onScopeSaved = vi.fn();
    await expect(
      conductor.decidePermission(
        'sg-cli-forever',
        'toolu_cli_forever',
        { behavior: 'allow' },
        { scope: 'forever', onScopeSaved },
      ),
    ).resolves.toBe(true);
    expect(onScopeSaved).toHaveBeenCalledWith(false);
    expect(persist).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg-cli-forever')).toBe(false);
    });
  });

  it('executes a trusted CLI allow but refuses project scope across worktrees', async () => {
    await createProjectSession('sg-cli-project');
    const fake = trustedCliPermissionBackend('toolu_cli_project', 'req-cli-project');
    const persist = vi.fn(async () => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      persistBrokeredHttpGrant: persist,
    });
    await conductor.dispatchTurn('sg-cli-project', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg-cli-project')).toEqual(['toolu_cli_project']);
    });
    const onScopeSaved = vi.fn();
    await conductor.decidePermission(
      'sg-cli-project',
      'toolu_cli_project',
      { behavior: 'allow' },
      { scope: 'project', onScopeSaved },
    );
    expect(onScopeSaved).toHaveBeenCalledWith(false);
    expect(persist).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(conductor.isBusy('sg-cli-project')).toBe(false));
  });

  it('ignores standing grants for trusted CLI invocations', async () => {
    await createProjectSession('sg-cli-grant');
    const fake = trustedCliPermissionBackend('toolu_cli_grant', 'req-cli-grant');
    const check = vi.fn(async () => true);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      checkBrokeredHttpGrant: check,
    });
    await conductor.dispatchTurn('sg-cli-grant', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg-cli-grant')).toEqual(['toolu_cli_grant']);
    });
    expect(check).not.toHaveBeenCalled();
    expect(fake.decisions()).toEqual([]);
  });

  it('leaves the prompt parked when no grant matches', async () => {
    await createProjectSession('sg4');
    const fake = httpPermissionBackend('toolu_none', 'req-none');
    const check = vi.fn(async () => false);
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      checkBrokeredHttpGrant: check,
    });
    await conductor.dispatchTurn('sg4', 'go');
    await vi.waitFor(
      () => {
        expect(check).toHaveBeenCalled();
      },
      { timeout: 5_000 },
    );
    expect(fake.decisions()).toEqual([]);
    expect(conductor.pendingPermissions('sg4')).toEqual(['toolu_none']);
    await conductor.decidePermission('sg4', 'toolu_none', { behavior: 'deny', message: 'no' });
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg4')).toBe(false);
    });
  });

  it('lets a manual denial claim a prompt while an automatic grant check is pending', async () => {
    await createProjectSession('sg-race');
    const fake = httpPermissionBackend('toolu_race', 'req-race');
    let releaseCheck!: (covered: boolean) => void;
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCheck = resolve;
        }),
    );
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      checkBrokeredHttpGrant: check,
    });
    await conductor.dispatchTurn('sg-race', 'go');
    await vi.waitFor(() => {
      expect(check).toHaveBeenCalled();
      expect(conductor.pendingPermissions('sg-race')).toEqual(['toolu_race']);
    });
    await expect(
      conductor.decidePermission('sg-race', 'toolu_race', {
        behavior: 'deny',
        message: 'no',
      }),
    ).resolves.toBe(true);
    releaseCheck(true);
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg-race')).toBe(false);
    });
    // The late grant must not overwrite the operator's denial — the agent sees one
    // decision, and it is the deny.
    expect(fake.decisions()).toEqual([{ behavior: 'deny', message: 'no' }]);
  });

  it('reports an unsaved scope without making an executed request retryable', async () => {
    await createProjectSession('sg5');
    const fake = httpPermissionBackend('toolu_failed_scope', 'req-failed-scope');
    const conductor = new Conductor({
      store: ctx.store,
      backend: fake.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      persistBrokeredHttpGrant: async () => {
        throw new Error('database unavailable');
      },
    });
    await conductor.dispatchTurn('sg5', 'go');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('sg5')).toEqual(['toolu_failed_scope']);
    });
    const onScopeSaved = vi.fn();
    await expect(
      conductor.decidePermission(
        'sg5',
        'toolu_failed_scope',
        { behavior: 'allow' },
        { scope: 'project', onScopeSaved },
      ),
    ).resolves.toBe(true);
    expect(onScopeSaved).toHaveBeenCalledWith(false);
    await vi.waitFor(() => {
      expect(fake.decisions()).toEqual([{ behavior: 'allow' }]);
    });
    await vi.waitFor(() => {
      expect(conductor.isBusy('sg5')).toBe(false);
    });
  });
});

describe('Conductor — out-of-band permission prompts (ADR 0014 D2)', () => {
  const gatewayInput = {
    method: 'GET',
    url: 'https://api.revenuecat.com/v2/projects',
    secretAlias: 'REVENUECAT_ADMIN_KEY',
    auth: { header: 'authorization', scheme: 'Bearer' },
  };

  async function createProjectSession(sessionId: string): Promise<void> {
    await ctx.store.upsertProject({
      id: 'project-x',
      owner: 'acme',
      repo: 'app',
      containerName: 'verity-acme-app',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId,
      worktree: `/wt/${sessionId}`,
      model: 'm',
      projectId: 'project-x',
    });
  }

  function ask(
    conductor: Conductor,
    sessionId: string,
    toolUseId: string,
    signal?: AbortSignal,
  ): Promise<{ decision: { behavior: string }; decidedBy: string }> {
    return conductor.requestExternalPermission({
      sessionId,
      toolUseId,
      toolName: 'verity_http_request',
      input: gatewayInput,
      channel: 'acp',
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  it('parks a prompt with no turn in flight and resolves it from the decide route', async () => {
    await createProjectSession('x1');
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    const answered = ask(conductor, 'x1', 'toolu_gw');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('x1')).toEqual(['toolu_gw']);
    });
    // The card is written to the transcript with the channel the caller stated, so the
    // app offers only the scopes that channel accepts.
    const events = await ctx.store.getEvents('x1');
    expect(events.at(-1)).toMatchObject({
      t: 'permission',
      id: 'toolu_gw',
      tool: 'verity_http_request',
      riskClass: 'ask',
      grantChannel: 'acp',
    });
    await expect(conductor.decidePermission('x1', 'toolu_gw', { behavior: 'allow' })).resolves.toBe(
      true,
    );
    await expect(answered).resolves.toEqual({ decision: { behavior: 'allow' }, decidedBy: 'card' });
    expect(conductor.pendingPermissions('x1')).toEqual([]);
  });

  it('denies the waiting caller when it gives up, and refuses a later decision', async () => {
    await createProjectSession('x2');
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    const abort = new AbortController();
    const answered = ask(conductor, 'x2', 'toolu_gone', abort.signal);
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('x2')).toEqual(['toolu_gone']);
    });
    abort.abort();
    await expect(answered).resolves.toMatchObject({ decision: { behavior: 'deny' } });
    expect(conductor.pendingPermissions('x2')).toEqual([]);
    await expect(
      conductor.decidePermission('x2', 'toolu_gone', { behavior: 'allow' }),
    ).resolves.toBe(false);
  });

  it('answers a caller that gave up before it ever asked', async () => {
    await createProjectSession('x3');
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    await expect(ask(conductor, 'x3', 'toolu_dead', AbortSignal.abort())).resolves.toMatchObject({
      decision: { behavior: 'deny' },
    });
    expect(conductor.pendingPermissions('x3')).toEqual([]);
  });

  it('auto-approves against ACP grants only, and records the scope on that channel', async () => {
    await createProjectSession('x4');
    const check = vi.fn(async () => true);
    const conductor = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      checkBrokeredHttpGrant: check,
    });
    // A grant answered it with no card shown, and the answer says so — an audit record
    // must not claim the operator saw one.
    await expect(ask(conductor, 'x4', 'toolu_auto')).resolves.toEqual({
      decision: { behavior: 'allow' },
      decidedBy: 'grant',
    });
    expect(check).toHaveBeenCalledWith({
      projectId: 'project-x',
      sessionId: 'x4',
      secretAlias: 'REVENUECAT_ADMIN_KEY',
      toolName: 'verity_http_request',
      target: 'api.revenuecat.com',
      channel: 'acp',
    });
  });

  it('requires a fresh trusted CLI decision even when grant lookup would allow it', async () => {
    await createProjectSession('x4-cli');
    const check = vi.fn(async () => true);
    const persist = vi.fn(async (): Promise<void> => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      checkBrokeredHttpGrant: check,
      persistBrokeredHttpGrant: persist,
    });
    const answered = conductor.requestExternalPermission({
      sessionId: 'x4-cli',
      toolUseId: 'toolu_cli',
      toolName: 'verity_secret_run',
      input: {
        command: ['/usr/bin/example-cli', 'get', 'items'],
        secrets: [{ secretAlias: 'EXAMPLE_CONFIG_PROD', env: 'EXAMPLE_CONFIG', injection: 'file' }],
      },
      channel: 'acp',
      allowStandingGrant: false,
    });
    await vi.waitFor(() => expect(conductor.pendingPermissions('x4-cli')).toEqual(['toolu_cli']));
    expect(check).not.toHaveBeenCalled();

    const onScopeSaved = vi.fn();
    await expect(
      conductor.decidePermission(
        'x4-cli',
        'toolu_cli',
        { behavior: 'allow' },
        { scope: 'project', onScopeSaved },
      ),
    ).resolves.toBe(true);
    await expect(answered).resolves.toEqual({ decision: { behavior: 'allow' }, decidedBy: 'card' });
    expect(onScopeSaved).toHaveBeenCalledWith(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('never consults a grant for a tool that resolves no secret, flag or no flag', async () => {
    await createProjectSession('x4-delivery');
    const check = vi.fn(async () => true);
    const persist = vi.fn(async (): Promise<void> => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      checkBrokeredHttpGrant: check,
      persistBrokeredHttpGrant: persist,
    });
    // `allowStandingGrant` is deliberately left ON here: the point is that it is inert for
    // any tool outside the brokered pair, so the gateway route may set it from the tool name
    // without changing what the control-plane tools do. A grant is neither read nor written.
    const answered = conductor.requestExternalPermission({
      sessionId: 'x4-delivery',
      toolUseId: 'toolu_delivery',
      toolName: 'verity_create_delivery',
      input: { sourceProjectId: 'website' },
      channel: 'acp',
      allowStandingGrant: true,
    });
    await vi.waitFor(() =>
      expect(conductor.pendingPermissions('x4-delivery')).toEqual(['toolu_delivery']),
    );
    expect(check).not.toHaveBeenCalled();

    const onScopeSaved = vi.fn();
    await expect(
      conductor.decidePermission(
        'x4-delivery',
        'toolu_delivery',
        { behavior: 'allow' },
        { scope: 'forever', onScopeSaved },
      ),
    ).resolves.toBe(true);
    await expect(answered).resolves.toEqual({ decision: { behavior: 'allow' }, decidedBy: 'card' });
    // Not even reported as "requested but not saved", the way a trusted-CLI allow is: the
    // scope arm gates on `brokeredGrantToolName` and this tool has none, so a scope on this
    // card is not a thing that could have been saved.
    expect(onScopeSaved).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ['verity_session_handoff', { target: { sessionId: 'x' }, title: 't', briefing: 'b' }],
    ['verity_list_sessions', {}],
  ])('never auto-approves %s, whatever grants that session holds', async (toolName, input) => {
    const sessionId = `x4-${toolName}`;
    await createProjectSession(sessionId);
    // Approves everything it is asked about. If either card reaches it, ADR 0014 D2 is gone
    // for these tools — a briefing is dispatched into another operator's session, or the fleet
    // is listed, without anyone being asked.
    const check = vi.fn(async () => true);
    const conductor = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      checkBrokeredHttpGrant: check,
    });
    // `allowStandingGrant: true`, which the gateway route never sends for either tool. That is
    // the point: the route's `false` is the second lock, and this asserts the first one holds
    // on its own — `brokeredGrantToolName` has no name for these, so `maybeAutoApprove` returns
    // before it can look a grant up. Both would have to be undone to auto-answer them.
    const answered = conductor.requestExternalPermission({
      sessionId,
      toolUseId: 'toolu_cp',
      toolName,
      input,
      channel: 'acp',
      allowStandingGrant: true,
    });
    await vi.waitFor(() => expect(conductor.pendingPermissions(sessionId)).toEqual(['toolu_cp']));
    expect(check).not.toHaveBeenCalled();
    await expect(
      conductor.decidePermission(sessionId, 'toolu_cp', { behavior: 'deny', message: 'not now' }),
    ).resolves.toBe(true);
    await expect(answered).resolves.toEqual({
      decision: { behavior: 'deny', message: 'not now' },
      decidedBy: 'card',
    });
  });

  it('persists a scoped allow on the channel the prompt was raised on', async () => {
    await createProjectSession('x5');
    const persist = vi.fn(async (): Promise<void> => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      persistBrokeredHttpGrant: persist,
    });
    const answered = ask(conductor, 'x5', 'toolu_scope');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('x5')).toEqual(['toolu_scope']);
    });
    const onScopeSaved = vi.fn();
    await expect(
      conductor.decidePermission(
        'x5',
        'toolu_scope',
        { behavior: 'allow' },
        { scope: 'session', onScopeSaved },
      ),
    ).resolves.toBe(true);
    await expect(answered).resolves.toEqual({ decision: { behavior: 'allow' }, decidedBy: 'card' });
    expect(onScopeSaved).toHaveBeenCalledWith(true);
    expect(persist).toHaveBeenCalledWith({
      projectId: 'project-x',
      sessionId: 'x5',
      scope: 'session',
      channel: 'acp',
      secretAlias: 'REVENUECAT_ADMIN_KEY',
      toolName: 'verity_http_request',
      target: 'api.revenuecat.com',
    });
  });

  it('associates a multi-secret run grant with every alias and requires every association', async () => {
    const input = {
      secrets: [
        { secretAlias: 'TOKEN', env: 'TOKEN' },
        { secretAlias: 'KEY_ID', env: 'KEY_ID' },
      ],
      command: ['/usr/bin/python3', '/work/project/deploy.py'],
      entryScript: {
        path: '/work/project/deploy.py',
        projectPath: 'deploy.py',
        sha256: 'a'.repeat(64),
        loading: 'isolated',
      },
    };
    await createProjectSession('x5-multi');
    const persist = vi.fn(async (): Promise<void> => undefined);
    const conductor = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      persistBrokeredHttpGrant: persist,
    });
    const answered = conductor.requestExternalPermission({
      sessionId: 'x5-multi',
      toolUseId: 'toolu_multi',
      toolName: 'verity_secret_run',
      input,
      channel: 'acp',
      allowStandingGrant: true,
    });
    await vi.waitFor(() =>
      expect(conductor.pendingPermissions('x5-multi')).toEqual(['toolu_multi']),
    );
    await conductor.decidePermission(
      'x5-multi',
      'toolu_multi',
      { behavior: 'allow' },
      { scope: 'session' },
    );
    await expect(answered).resolves.toMatchObject({ decidedBy: 'card' });
    expect(persist).toHaveBeenNthCalledWith(1, expect.objectContaining({ secretAlias: 'KEY_ID' }));
    expect(persist).toHaveBeenNthCalledWith(2, expect.objectContaining({ secretAlias: 'TOKEN' }));

    await createProjectSession('x5-multi-check');
    const check = vi.fn(
      async ({ secretAlias }: { secretAlias: string }) => secretAlias === 'KEY_ID',
    );
    const checking = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      checkBrokeredHttpGrant: check,
    });
    const pending = checking.requestExternalPermission({
      sessionId: 'x5-multi-check',
      toolUseId: 'toolu_multi_check',
      toolName: 'verity_secret_run',
      input,
      channel: 'acp',
      allowStandingGrant: true,
    });
    await vi.waitFor(() =>
      expect(check.mock.calls.map(([grant]) => grant.secretAlias).sort()).toEqual([
        'KEY_ID',
        'TOKEN',
      ]),
    );
    expect(checking.pendingPermissions('x5-multi-check')).toEqual(['toolu_multi_check']);
    await checking.decidePermission('x5-multi-check', 'toolu_multi_check', {
      behavior: 'deny',
      message: 'not now',
    });
    await expect(pending).resolves.toMatchObject({ decidedBy: 'card' });
  });

  it('rejects a second prompt reusing a parked tool_use_id', async () => {
    await createProjectSession('x6');
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    const answered = ask(conductor, 'x6', 'toolu_dup');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('x6')).toEqual(['toolu_dup']);
    });
    await expect(ask(conductor, 'x6', 'toolu_dup')).rejects.toThrow(/already pending/);
    // The first prompt is untouched — a colliding id must not unpark it.
    await expect(
      conductor.decidePermission('x6', 'toolu_dup', { behavior: 'deny', message: 'no' }),
    ).resolves.toBe(true);
    await expect(answered).resolves.toMatchObject({ decision: { behavior: 'deny' } });
  });

  it('keeps the prompt parked across a turn settling, which never answered it', async () => {
    await createProjectSession('x7');
    const conductor = new Conductor({
      store: ctx.store,
      worktreeExists: async () => true,
      backend: scriptedBackend({ sessionId: 'x7' }).backend,
      permissionControl: true,
    });
    const answered = ask(conductor, 'x7', 'toolu_survives');
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions('x7')).toEqual(['toolu_survives']);
    });
    // A turn's settle fail-safe-denies the prompts that turn was carrying. This one is
    // not among them — its own caller still holds the deadline.
    await conductor.sendTurn('x7', 'go');
    expect(conductor.pendingPermissions('x7')).toEqual(['toolu_survives']);
    await expect(
      conductor.decidePermission('x7', 'toolu_survives', { behavior: 'allow' }),
    ).resolves.toBe(true);
    await expect(answered).resolves.toEqual({ decision: { behavior: 'allow' }, decidedBy: 'card' });
  });

  it('does not leave the caller waiting when the prompt cannot be written', async () => {
    const conductor = new Conductor({ store: ctx.store, worktreeExists: async () => true });
    await expect(ask(conductor, 'ghost', 'toolu_nowhere')).rejects.toThrow();
    expect(conductor.pendingPermissions('ghost')).toEqual([]);
  });
});
