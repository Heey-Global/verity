import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@verity/events';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from './bus.js';
import { Conductor } from './conductor.js';
import { FileTailRunnerClient } from './file-tail-runner-client.js';
import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';

/**
 * ADR 0006 Stage 2.2-prep — the SAME Conductor behaviors (event persistence +
 * ordering, bus fan-out, mid-turn steer, cancel, and permission approve/deny),
 * but driven THROUGH the real event-file + control-socket transport rather than
 * the in-process loopback. The Conductor is built with a `runner` factory that
 * returns a {@link FileTailRunnerClient} over a per-turn event file + control
 * socket; a fake {@link Backend} scripts one turn (bind + a couple of events + a
 * permission prompt, then settle). This proves the transport carries a real
 * Conductor-driven turn end-to-end — the exact wiring that stays when the
 * RunnerServer later moves into the Sandbox (only its location changes).
 *
 * The RunnerServer is still IN-PROCESS here (no container). The socket path base
 * is kept SHORT (`<tmpdir>/verity-<uuid>`) so it stays under the unix-domain
 * ~108-char limit.
 */

const SESSION_ID = 's1';
const WORKTREE = '/wt/s1';
const EVENT_ONE: AgentEvent = { t: 'text', delta: 'first' };
const EVENT_TWO: AgentEvent = { t: 'text', delta: 'second' };
const PERMISSION_REQUEST: PermissionRequest = {
  requestId: 'req-1',
  toolName: 'Bash',
  input: { command: 'rm -rf /' },
  toolUseId: 'toolu_a',
};
const RESULT: RunResult = { sessionId: SESSION_ID, exitCode: 0, stderr: '', aborted: false };

/**
 * A fake {@link Backend} that scripts ONE turn against the run's `store` (which,
 * routed through the RunnerServer, is the file-sink) + callbacks: bind the
 * session (onSession), emit two `text` events, raise a permission prompt, then
 * BLOCK until settled. It surfaces the steer inject fn (from `onSteer`), records
 * the operator's permission answer + steer messages, and whether it was
 * cancelled — so the test can assert control reaches the backend THROUGH the
 * transport. `settle()` releases the terminal result.
 */
function scriptedBackend() {
  const steerSeen: SteerMessage[] = [];
  const permissionAnswers: PermissionDecision[] = [];
  let cancelled = false;
  let settle: (r: RunResult) => void = () => {};
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>((res) => {
    resolveStarted = res;
  });
  const backend: Backend = {
    run(opts: RunTurnOptions): Promise<RunResult> {
      opts.signal?.addEventListener('abort', () => {
        cancelled = true;
      });
      opts.onSteer?.((m) => {
        steerSeen.push(m);
        return true;
      });
      void (async () => {
        // Bind the backend session (the first `session` frame → onSession), like ingest.
        await opts.onSession?.(SESSION_ID);
        // Two persisted events → two `event` frames on the file.
        await opts.store.appendEvent(SESSION_ID, EVENT_ONE);
        await opts.store.appendEvent(SESSION_ID, EVENT_TWO);
        // A mid-turn permission prompt; the operator's answer arrives via `respond`.
        opts.onPermissionRequest?.(PERMISSION_REQUEST, (decision) => {
          permissionAnswers.push(decision);
        });
        resolveStarted();
      })();
      return new Promise<RunResult>((res) => {
        settle = res;
      });
    },
  };
  return {
    backend,
    steerSeen,
    permissionAnswers,
    started,
    get cancelled() {
      return cancelled;
    },
    settle: () => settle(RESULT),
  };
}

let ctx: TestDb;
let dir: string;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  // SHORT base dir: a unix-domain socket path has a ~108-char OS limit, so the
  // per-turn `<uuid>.sock` must sit under a short root, NOT a deep worktree path.
  dir = await mkdtemp(join(tmpdir(), 'verity-cndx-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('Conductor over the runner transport (ADR 0006 Stage 2.2-prep)', () => {
  it('drives a full turn through the file+socket transport: persist-in-order, bus fan-out, steer, permission, settle', async () => {
    await ctx.store.createSession({ sessionId: SESSION_ID, worktree: WORKTREE, model: 'm' });
    const fb = scriptedBackend();
    const bus = new InMemoryEventBus();
    const published: AgentEvent[] = [];
    bus.subscribe(SESSION_ID, (se) => published.push(se.event));

    const allocatedEventFiles: string[] = [];
    const conductor = new Conductor({
      store: ctx.store,
      bus,
      backend: fb.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      // Route THROUGH the transport: RunnerServer (in-process) writes the turn's
      // stream to a per-turn event file; the FileTailRunnerClient tails it, re-persists
      // to the real store (Server is the seq authority — D2) and publishes to the SAME
      // bus; control (steer/cancel/answerPermission) rides the per-turn unix socket.
      runner: (backend) =>
        new FileTailRunnerClient(backend, {
          store: ctx.store,
          bus,
          allocateEventFile: () => {
            const path = join(dir, `${randomUUID()}.events.jsonl`);
            allocatedEventFiles.push(path);
            return path;
          },
          allocateControlSocket: () => join(dir, `${randomUUID()}.sock`),
          pollMs: 2,
        }),
    });

    // Dispatch in the background (resolves on accept, not on turn-done).
    await conductor.dispatchTurn(SESSION_ID, 'go');

    // The two scripted events land in the store IN ORDER, THROUGH the transport
    // (persisted by the tail's re-persist path, not by the backend directly), and
    // the operator's `prompt` precedes them.
    await vi.waitFor(() => {
      expect(published.filter((e) => e.t === 'text').length).toBe(2);
    });
    // Text and permission are separate transport frames. Waiting only for the
    // second text leaves a race where the store is read before the following
    // permission frame has been tailed and persisted.
    await vi.waitFor(() => {
      expect(conductor.pendingPermissions(SESSION_ID)).toEqual(['toolu_a']);
    });
    const stored = await ctx.store.getEvents(SESSION_ID);
    const texts = stored.filter((e): e is Extract<AgentEvent, { t: 'text' }> => e.t === 'text');
    expect(texts.map((e) => e.delta)).toEqual(['first', 'second']);

    // The Server tails this file as a DIFFERENT uid than the worker that writes it,
    // reaching it through the shared runner group. Created under the worker's
    // `umask 0077` without an explicit mode it lands at 0600, and every control-plane
    // turn then dies with `EACCES: permission denied, open '.../events.jsonl'`.
    expect(allocatedEventFiles.length).toBeGreaterThan(0);
    expect((await stat(allocatedEventFiles[0]!)).mode & 0o777).toBe(0o640);
    // The prompt was persisted before the transported text events.
    expect(stored.map((e) => e.t)).toEqual(['prompt', 'text', 'text', 'permission']);
    // The bus received the same events, in order (fan-out off the tail's re-publish).
    expect(published.filter((e) => e.t === 'text')).toEqual([EVENT_ONE, EVENT_TWO]);

    // decidePermission resolves the parked prompt: the allow decision reaches the
    // backend's `respond` over the control socket. answerPermission QUEUES over the
    // socket until it connects, so its landing at the backend also proves the control
    // wire is up — the steer below can then deterministically fold into the live turn
    // (steer does NOT queue; it needs a connected socket to return true, not enqueue).
    const decision: PermissionDecision = { behavior: 'allow', updatedInput: { command: 'ls' } };
    await expect(conductor.decidePermission(SESSION_ID, 'toolu_a', decision)).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(fb.permissionAnswers).toEqual([decision]);
    });
    expect(conductor.pendingPermissions(SESSION_ID)).toEqual([]);

    // Steer folds into the RUNNING turn over the (now-connected) control socket. The
    // Conductor steers via dispatchTurn on a busy session; a `false` return would
    // queue instead, so `{ queued: false }` proves the socket carried the message.
    expect(await conductor.dispatchTurn(SESSION_ID, 'keep going')).toEqual({ queued: false });
    await vi.waitFor(() => {
      expect(fb.steerSeen).toEqual([{ text: 'keep going' }]);
    });

    // Settle → terminal result frame → the turn completes; the session frees up.
    fb.settle();
    await vi.waitFor(() => {
      expect(conductor.isBusy(SESSION_ID)).toBe(false);
    });
  });

  it('cancel() reaches the backend over the transport and the turn still settles', async () => {
    await ctx.store.createSession({ sessionId: SESSION_ID, worktree: WORKTREE, model: 'm' });
    const fb = scriptedBackend();
    const bus = new InMemoryEventBus();

    const conductor = new Conductor({
      store: ctx.store,
      bus,
      backend: fb.backend,
      worktreeExists: async () => true,
      permissionControl: true,
      runner: (backend) =>
        new FileTailRunnerClient(backend, {
          store: ctx.store,
          bus,
          allocateEventFile: () => join(dir, `${randomUUID()}.events.jsonl`),
          allocateControlSocket: () => join(dir, `${randomUUID()}.sock`),
          pollMs: 2,
        }),
    });

    await conductor.dispatchTurn(SESSION_ID, 'go');
    await fb.started;

    // The cancel reaches the backend's abort signal over the control socket.
    await expect(conductor.cancelTurn(SESSION_ID)).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(fb.cancelled).toBe(true);
    });

    // The backend settles after the cancel (partial output already persisted); the
    // turn resolves off the terminal result frame the RunnerServer wrote on settle.
    fb.settle();
    await vi.waitFor(() => {
      expect(conductor.isBusy(SESSION_ID)).toBe(false);
    });
  });
});
