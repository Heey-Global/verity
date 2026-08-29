import { describe, expect, it } from 'vitest';
import type { PermissionDecision, PermissionRequest } from '@verity/adapter-claude';
import type { EventStore } from '@verity/store';
import { LoopbackRunnerClient } from './runner-contract.js';
import type { Backend } from './backend.js';
import type { EventBus } from './bus.js';
import type { RunResult, RunTurnOptions, SteerMessage } from './backend-contract.js';

const RESULT: RunResult = { sessionId: 'sid', exitCode: 0, stderr: '', aborted: false };
const REQUEST: PermissionRequest = {
  requestId: 'req-1',
  toolName: 'Bash',
  input: {},
  toolUseId: 'tool-1',
};
const OPTS = { store: {} as unknown as EventStore, worktree: '/w', cwd: '/w' } as RunTurnOptions;

/** A fake {@link Backend} that captures the merged run opts and drives the callbacks
 * the {@link LoopbackRunnerClient} threads in, so the test can assert the loopback
 * bridges them onto the {@link RunnerTurn} handle. `finish()` settles the run. */
function fakeBackend() {
  let captured: RunTurnOptions | undefined;
  const injectCalls: SteerMessage[] = [];
  const respondCalls: PermissionDecision[] = [];
  let settle: (r: RunResult) => void = () => {};
  const backend: Backend = {
    run(opts) {
      captured = opts;
      opts.onSteer?.((m) => {
        injectCalls.push(m);
        return true;
      });
      opts.onPermissionRequest?.(REQUEST, (d) => {
        respondCalls.push(d);
      });
      void opts.onSession?.('sid');
      return new Promise<RunResult>((res) => {
        settle = res;
      });
    },
  };
  return {
    backend,
    injectCalls,
    respondCalls,
    get captured() {
      return captured;
    },
    finish: () => settle(RESULT),
  };
}

describe('LoopbackRunnerClient (ADR 0006 Stage 1)', () => {
  it('bridges steer/cancel/answerPermission onto the handle and passes hooks through', async () => {
    const fb = fakeBackend();
    const sessionSeen: string[] = [];
    const permSeen: PermissionRequest[] = [];
    const bus = {} as unknown as EventBus;

    const turn = new LoopbackRunnerClient(fb.backend).startTurn(OPTS, {
      onSession: (id) => {
        sessionSeen.push(id);
      },
      onPermissionRequest: (r) => {
        permSeen.push(r);
      },
      bus,
    });

    // inbound hooks fired, bus passed straight through
    expect(sessionSeen).toEqual(['sid']);
    expect(permSeen).toEqual([REQUEST]);
    expect(fb.captured?.bus).toBe(bus);

    // steer forwards to the inject fn the run surfaced via onSteer
    const msg: SteerMessage = { text: 'more' };
    await expect(turn.steer(msg)).resolves.toBe(true);
    expect(fb.injectCalls).toEqual([msg]);

    // answerPermission forwards once; a repeat for the same id is a no-op (idempotent)
    const deny: PermissionDecision = { behavior: 'deny', message: 'no' };
    await expect(turn.answerPermission('tool-1', deny)).resolves.toBe(true);
    await expect(turn.answerPermission('tool-1', deny)).resolves.toBe(false);
    expect(fb.respondCalls).toEqual([deny]);

    // cancel aborts the SAME signal the run observes (#79)
    expect(fb.captured?.signal?.aborted).toBe(false);
    await expect(turn.cancel()).resolves.toBe(true);
    expect(fb.captured?.signal?.aborted).toBe(true);

    // result settles with the backend's result
    fb.finish();
    await expect(turn.result).resolves.toEqual(RESULT);
  });

  it('steer returns false before the run has surfaced an inject channel', async () => {
    const backend: Backend = { run: () => new Promise<RunResult>(() => {}) };
    const turn = new LoopbackRunnerClient(backend).startTurn(OPTS, {});
    await expect(turn.steer({ text: 'x' })).resolves.toBe(false);
  });

  it('answerPermission for an unknown id is a harmless no-op', async () => {
    const fb = fakeBackend();
    const turn = new LoopbackRunnerClient(fb.backend).startTurn(OPTS, {});
    await expect(turn.answerPermission('nope', { behavior: 'deny', message: 'no' })).resolves.toBe(
      false,
    );
    expect(fb.respondCalls).toEqual([]);
  });

  it('makes every control a false no-op after the turn settles', async () => {
    const fb = fakeBackend();
    const turn = new LoopbackRunnerClient(fb.backend).startTurn(OPTS, {});

    fb.finish();
    await expect(turn.result).resolves.toEqual(RESULT);

    await expect(turn.steer({ text: 'too late' })).resolves.toBe(false);
    await expect(
      turn.answerPermission('tool-1', { behavior: 'deny', message: 'too late' }),
    ).resolves.toBe(false);
    await expect(turn.cancel()).resolves.toBe(false);
    expect(fb.injectCalls).toEqual([]);
    expect(fb.respondCalls).toEqual([]);
    expect(fb.captured?.signal?.aborted).toBe(false);
  });
});
