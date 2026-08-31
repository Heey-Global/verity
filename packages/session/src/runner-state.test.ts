import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_FRAME_PROTOCOL_VERSION } from '@verity/store';
import type { AgentEvent } from '@verity/events';
import type { Backend } from './backend.js';
import type { RunResult, RunTurnOptions } from './backend-contract.js';
import { RunnerServer } from './runner-server.js';
import {
  initialRunnerTurnState,
  readRunnerState,
  writeRunnerState,
  type RunnerTurnState,
} from './runner-state.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verity-runner-state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample = (over: Partial<RunnerTurnState> = {}): RunnerTurnState => ({
  ...initialRunnerTurnState('turn-1', 'runner-1', 1000),
  ...over,
});

describe('runner-state (ADR 0006 D3 status file)', () => {
  it('round-trips a state record through atomic write/read', async () => {
    const path = join(dir, 'state.json');
    const state = sample({ sessionId: 's1', lastFrameSeq: 3 });
    await writeRunnerState(path, state);
    expect(await readRunnerState(path)).toEqual(state);
  });

  it('leaves no temp file behind after an atomic replace', async () => {
    const path = join(dir, 'state.json');
    await writeRunnerState(path, sample());
    await writeRunnerState(path, sample({ status: 'settled', settledAt: 2000, aborted: false }));
    const entries = await readdir(dir);
    expect(entries).toEqual(['state.json']);
  });

  it('returns undefined for a missing file', async () => {
    expect(await readRunnerState(join(dir, 'nope.json'))).toBeUndefined();
  });

  it('returns undefined for malformed JSON (a mid-write crash)', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '{"turnId":"turn-1", partial', 'utf8');
    expect(await readRunnerState(path)).toBeUndefined();
  });

  it('returns undefined for a well-formed JSON of the wrong shape', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, JSON.stringify({ turnId: 'turn-1', status: 'bogus' }), 'utf8');
    expect(await readRunnerState(path)).toBeUndefined();
  });

  it('stamps the current protocol version on a fresh record', () => {
    expect(initialRunnerTurnState('t', 'r', 5).protocolVersion).toBe(RUNNER_FRAME_PROTOCOL_VERSION);
    expect(initialRunnerTurnState('t', 'r', 5).status).toBe('running');
  });
});

const SID = 'sess-state';
const WT = '/wt/state';

/** A scripted {@link Backend} that binds a session, emits one event, then parks until
 * `settle` is called — enough to drive a full RunnerServer turn lifecycle. */
function scriptedBackend() {
  let settle: (r: RunResult) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>((res) => {
    resolveStarted = res;
  });
  const backend: Backend = {
    run(opts: RunTurnOptions): Promise<RunResult> {
      void (async () => {
        await opts.store.createSession({ sessionId: SID, worktree: WT, model: 'm' });
        await opts.onSession?.(SID);
        const event: AgentEvent = { t: 'text', delta: 'hi' };
        await opts.store.appendEvent(SID, event);
        resolveStarted();
      })();
      return new Promise<RunResult>((res, rej) => {
        settle = res;
        fail = rej;
      });
    },
  };
  return { backend, started, settle: (r: RunResult) => settle(r), fail: (e: unknown) => fail(e) };
}

describe('RunnerServer writes the per-turn state file', () => {
  it('publishes running with the bound session, then settled after the terminal frame', async () => {
    const fb = scriptedBackend();
    const server = new RunnerServer(fb.backend);
    const eventFile = join(dir, 'events.jsonl');
    const statePath = `${eventFile}.state.json`;

    const turn = await server.run(eventFile, {
      turnId: 'turn-x',
      worktree: WT,
      cwd: WT,
      prompt: 'go',
    });

    await fb.started;
    // Once the session binds, the state file reports it while still running.
    await vi.waitFor(async () => {
      const s = await readRunnerState(statePath);
      expect(s?.sessionId).toBe(SID);
    });
    const running = await readRunnerState(statePath);
    expect(running?.status).toBe('running');
    expect(running?.turnId).toBe('turn-x');
    expect(running?.settledAt).toBeNull();
    expect(running?.aborted).toBeNull();

    // After the turn settles, the record flips to settled with a frame count.
    fb.settle({ sessionId: SID, exitCode: 0, stderr: '', aborted: false });
    await turn.result;
    const settled = await readRunnerState(statePath);
    expect(settled?.status).toBe('settled');
    expect(settled?.aborted).toBe(false);
    expect(settled?.lastFrameSeq).toBeGreaterThan(0);
    expect(typeof settled?.settledAt).toBe('number');
    // Same runner instance throughout (immutable binding).
    expect(settled?.runnerInstanceId).toBe(running?.runnerInstanceId);
  });

  it('records an aborted settle when the turn ends via cancel', async () => {
    const fb = scriptedBackend();
    const server = new RunnerServer(fb.backend);
    const eventFile = join(dir, 'events.jsonl');
    const statePath = `${eventFile}.state.json`;

    const turn = await server.run(eventFile, {
      turnId: 'turn-y',
      worktree: WT,
      cwd: WT,
      prompt: 'go',
    });

    await fb.started;
    fb.settle({ sessionId: SID, exitCode: 0, stderr: '', aborted: true });
    await turn.result;
    const settled = await readRunnerState(statePath);
    expect(settled?.status).toBe('settled');
    expect(settled?.aborted).toBe(true);
  });

  it('marks the state settled when the run rejects (abnormal settle, no terminal frame)', async () => {
    const fb = scriptedBackend();
    const server = new RunnerServer(fb.backend);
    const eventFile = join(dir, 'events.jsonl');
    const statePath = `${eventFile}.state.json`;

    const turn = await server.run(eventFile, {
      turnId: 'turn-z',
      worktree: WT,
      cwd: WT,
      prompt: 'go',
    });

    await fb.started;
    fb.fail(new Error('run boom'));
    // The run rejection propagates; the abnormal settle is recorded before it does.
    await expect(turn.result).rejects.toThrow('run boom');
    const settled = await readRunnerState(statePath);
    expect(settled?.status).toBe('settled');
    expect(settled?.aborted).toBe(true);
  });
});
