import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryEventBus,
  SupervisorRunnerClient,
  SupervisorRunnerRecovery,
  type Backend,
  type RunnerAttachTarget,
} from '@verity/session';
import {
  claimTurn,
  readTurnState,
  probeSupervisor,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  runAgentSpawnBroker,
  runSupervisor,
  supervisorRequest,
  supervisorRequestFrames,
} from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

/**
 * S7 — supervisor crash-safety (ADR 0006), real process, NO Docker. The runtime dir is
 * a self-owned `mkdtemp` (chmod 0o770) so `validateRuntimeDirectory` defaults the
 * expected uid to `process.getuid()` and passes without depending on UID 1101 or the
 * privileged launchers. Two net-new properties:
 *   - a worker SIGKILLed MID-TURN (out of band) is durably settled with its signal;
 *   - a fresh supervisor reclaims the SAME runtimeDir, adopts the lock-owning worker,
 *     and observes its later exit without being that worker's parent.
 * The genuine crash-time flock reclaim (process death drops the OFD lock) is already
 * proven by the `acquireSingleton` dead-holder / cross-process fence tests above; this
 * block covers the full-`runSupervisor` restart path those do not.
 */
describe('supervisor crash-safety: worker death + restart (S7)', () => {
  // A long-lived worker: writes a `ready` sentinel, then idles until it is killed.
  const longLivedWorker = [
    '-e',
    "require('fs').writeFileSync(process.env.VERITY_RUNNER_TURN_DIR+'/ready','');setInterval(()=>{},1000)",
  ];

  // Pin the expected runtime ownership to THIS process's own uid/gid so the self-owned
  // `mkdtemp` dir validates cleanly, overriding the container's VERITY_RUNNER_RUNTIME_UID/GID
  // (1101) which would otherwise make `validateRuntimeDirectory` reject our 1000-owned dir.
  const selfOwned = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  const startTurn = (turnId: string): Record<string, unknown> => ({
    protocolVersion: 1,
    kind: 'start-turn',
    turnId,
    startCommandId: `start-${turnId}`,
    sessionId: `session-${turnId}`,
    backend: 'claude-acp',
    worktree: runtimeDir,
    cwd: runtimeDir,
    prompt: 'work',
  });

  const markWorkerLockProtocol = async (turnId: string): Promise<void> => {
    const state = await readTurnState(runtimeDir, turnId);
    await writeFile(
      join(runtimeDir, 'turns', turnId, 'state.json'),
      `${JSON.stringify({ ...state, workerLock: true })}\n`,
    );
  };

  it('durably records terminal settlement when the worker is SIGKILLed mid-turn', async () => {
    const runnerRuntime = join(runtimeDir, 'runners', 'project-crash');
    await mkdir(runnerRuntime, { recursive: true });
    await chmod(runnerRuntime, 0o770);
    const supervisor = await runSupervisor({
      runtimeDir: runnerRuntime,
      ...selfOwned,
      workerCommand: process.execPath,
      workerArgs: longLivedWorker,
    });
    try {
      const request = {
        ...startTurn('turn-killed'),
        worktree: runnerRuntime,
        cwd: runnerRuntime,
      };
      await supervisorRequest(supervisor.socketPath, request);

      // The turn is durably running; capture the live worker's PID from state.json.
      let workerPid = 0;
      await vi.waitFor(async () => {
        const state = (await readTurnState(runnerRuntime, 'turn-killed')) as {
          status: string;
          workerPid?: number;
        };
        expect(state.status).toBe('running');
        expect(typeof state.workerPid).toBe('number');
        workerPid = state.workerPid ?? 0;
      });

      // Kill the worker MID-TURN, out of band (models the worker process crashing).
      process.kill(workerPid, 'SIGKILL');

      // The supervisor observes the exit and durably settles the turn WITH its signal —
      // the terminal exit/signal record survives on disk.
      await vi.waitFor(async () => {
        expect(await readTurnState(runnerRuntime, 'turn-killed')).toMatchObject({
          status: 'settled',
          workerSignal: 'SIGKILL',
        });
      });

      const recovery = new SupervisorRunnerRecovery({
        dataVolumeRoot: runtimeDir,
        getSession: async () => ({ projectId: 'project-crash' }),
      });
      const outcome = await recovery.discover({
        sessionId: 'session-turn-killed',
        turnId: 'turn-killed',
        startCommandId: 'start-turn-killed',
      });
      // `live`, where a SIGKILLed worker used to be `dead`. The supervisor left a
      // terminal frame behind, so recovery has something to replay: it tails the
      // event stream, reads that frame and settles the turn with the real cause.
      // `dead` was the outcome for a stream with nothing in it, and the control
      // socket recovery would otherwise need is only demanded of a `running` turn.
      expect(outcome).toMatchObject({ status: 'live' });
      const terminal = JSON.parse(
        await readFile(join(runnerRuntime, 'turns', 'turn-killed', 'events.jsonl'), 'utf8'),
      ) as {
        kind: string;
        turnId: string;
        result: { exitCode: number; stderr: string };
      };
      expect(terminal).toMatchObject({
        kind: 'result',
        turnId: 'turn-killed',
        result: {
          // POSIX `128 + signum`, the encoding the Server's own exit-code checks read.
          exitCode: 137,
          stderr: 'runner worker terminated by signal SIGKILL before producing any event',
        },
      });
      // And `live` has to mean recoverable, not merely discoverable. The Conductor's
      // only move on this verdict is `runner.attach(target)`, so make that move: the
      // turn must settle from the stream alone. This worker was SIGKILLed and left no
      // `control.sock` behind — a reattach that waited for one would hang exactly
      // where the old `dead` verdict at least ended the turn.
      if (outcome.status !== 'live') throw new Error(`expected a live turn, got ${outcome.status}`);
      const target: RunnerAttachTarget = outcome.target;
      expect(existsSync(target.controlSocketPath)).toBe(false);
      const attachClient = new SupervisorRunnerClient(
        { runnerSupervisorBackend: 'claude-acp' } as Backend,
        {
          runtimeDir: runnerRuntime,
          store: { ingestRunnerFrame: async () => ({ outcome: 'accepted' as const }) },
          bus: new InMemoryEventBus(),
        },
      );
      await expect(attachClient.attach(target, {}).result).resolves.toMatchObject({
        exitCode: 137,
        aborted: false,
      });
    } finally {
      await supervisor.close();
    }
  });

  it('cancels a running worker through the supervisor control plane', async () => {
    const runnerRuntime = join(runtimeDir, 'runners', 'project-cancel');
    await mkdir(runnerRuntime, { recursive: true });
    await chmod(runnerRuntime, 0o770);
    const supervisor = await runSupervisor({
      runtimeDir: runnerRuntime,
      ...selfOwned,
      workerCommand: process.execPath,
      workerArgs: longLivedWorker,
      shutdownGraceMs: 100,
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        ...startTurn('turn-cancelled'),
        worktree: runnerRuntime,
        cwd: runnerRuntime,
      });
      await supervisorRequest(supervisor.socketPath, {
        ...startTurn('turn-unrelated'),
        worktree: runnerRuntime,
        cwd: runnerRuntime,
      });
      await vi.waitFor(async () => {
        await expect(readTurnState(runnerRuntime, 'turn-cancelled')).resolves.toMatchObject({
          status: 'running',
        });
        await expect(readTurnState(runnerRuntime, 'turn-unrelated')).resolves.toMatchObject({
          status: 'running',
        });
      });

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'cancel-turn',
          turnId: 'turn-cancelled',
        }),
      ).resolves.toMatchObject({ outcome: 'cancelled' });
      await expect(readTurnState(runnerRuntime, 'turn-cancelled')).resolves.toMatchObject({
        status: 'settled',
        workerSignal: 'SIGTERM',
      });
      await expect(readTurnState(runnerRuntime, 'turn-unrelated')).resolves.toMatchObject({
        status: 'running',
      });

      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'cancel-turn',
          turnId: 'turn-cancelled',
        }),
      ).resolves.toMatchObject({ outcome: 'terminal' });
    } finally {
      await supervisor.close();
    }
  });

  it('adopts a worker across a real supervisor SIGKILL and observes its later exit', async () => {
    const moduleUrl = new URL(
      '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs',
      import.meta.url,
    ).href;
    const script = `
      import { runSupervisor } from ${JSON.stringify(moduleUrl)};
      await runSupervisor({
        runtimeDir: process.argv[1],
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        workerCommand: process.execPath,
        workerArgs: [
          '-e',
          'require("node:fs").unlinkSync(process.argv[1]);setInterval(()=>{},1000)',
        ],
      });
      process.stdout.write('ready\\n');
      setInterval(()=>{},1000);
    `;
    const supAProcess = spawn(
      process.execPath,
      ['--input-type=module', '--eval', script, runtimeDir],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let workerPid = 0;
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const cleanup = (): void => {
          supAProcess.removeListener('error', onError);
          supAProcess.removeListener('exit', onExit);
          supAProcess.stdout?.removeListener('data', onData);
        };
        const onError = (error: Error): void => {
          cleanup();
          rejectReady(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          cleanup();
          rejectReady(new Error(`supervisor A exited before ready (${signal ?? String(code)})`));
        };
        const onData = (): void => {
          cleanup();
          resolveReady();
        };
        supAProcess.once('error', onError);
        supAProcess.once('exit', onExit);
        supAProcess.stdout?.once('data', onData);
      });
      await supervisorRequest(join(runtimeDir, 'supervisor.sock'), {
        ...startTurn('turn-persist'),
        backend: 'codex-acp',
        trustedCliExecution: true,
      });
      const running = await readTurnState(runtimeDir, 'turn-persist');
      expect(running).toMatchObject({ status: 'running', workerPid: expect.any(Number) });
      workerPid = Number(running?.workerPid);
      await vi.waitFor(async () => {
        await expect(
          readFile(join(runtimeDir, 'turns/turn-persist/request.json'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      });

      // Kill ONLY supervisor A. The worker retains worker.lock fd 3 and survives.
      supAProcess.kill('SIGKILL');
      await new Promise<void>((resolveExit) => supAProcess.once('exit', () => resolveExit()));
      expect(() => process.kill(workerPid, 0)).not.toThrow();

      const broker = await runAgentSpawnBroker({
        runtimeDir,
        enforceRoot: false,
        agentUid: 1000,
        agentGid: 1000,
        worktreeRoot: runtimeDir,
        secretDir: join(runtimeDir, 'adopted-worker-secrets'),
        spawnChild: (_command, args, options) => spawn(args[7]!, args.slice(8), options),
      });
      const supB = await runSupervisor({
        runtimeDir,
        ...selfOwned,
        workerCommand: process.execPath,
        workerArgs: longLivedWorker,
        adoptionPollMs: 60_000,
        brokerSocket: broker.socketPath,
      });
      try {
        await expect(probeSupervisor(runtimeDir)).resolves.toBe(true);
        await expect(readTurnState(runtimeDir, 'turn-persist')).resolves.toMatchObject({
          status: 'running',
          workerPid,
        });
        const trustedCliFrames = await supervisorRequestFrames(supB.socketPath, {
          protocolVersion: 1,
          kind: 'run-trusted-cli',
          turnId: 'turn-persist',
          secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'adopted-secret' }],
          command: ['/bin/true'],
        });
        expect(trustedCliFrames).toEqual([
          { ok: true, kind: 'trusted-cli-started' },
          expect.objectContaining({ ok: true, exitCode: 0 }),
        ]);

        // Supervisor B is not the worker's parent, but lock release is an authoritative
        // exit signal. PID is used only by this test to trigger the exit.
        process.kill(workerPid, 'SIGKILL');
        workerPid = 0;
        await vi.waitFor(() => {
          expect(() => process.kill(Number(running?.workerPid), 0)).toThrow();
        });
        // Do not wait for the adopter poll: authorization checks worker.lock itself,
        // so a cached adopted id cannot forward secrets after the worker exits.
        await expect(
          supervisorRequest(supB.socketPath, {
            protocolVersion: 1,
            kind: 'run-trusted-cli',
            turnId: 'turn-persist',
            secrets: [{ secretAlias: 'API_KEY', env: 'CLI_SECRET', secret: 'post-exit-secret' }],
            command: ['/bin/true'],
          }),
        ).resolves.toMatchObject({
          ok: false,
          error: 'trusted CLI turn capability is no longer active',
        });
        await vi.waitFor(
          async () => {
            expect(await readTurnState(runtimeDir, 'turn-persist')).toMatchObject({
              status: 'settled',
              workerError: 'worker missing during supervisor recovery',
            });
          },
          { timeout: 4_000 },
        );
      } finally {
        await supB.close();
        await broker.close();
      }
    } finally {
      if (workerPid > 0) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          // Best-effort cleanup after an earlier assertion failure.
        }
      }
      if (supAProcess.exitCode === null && supAProcess.signalCode === null) {
        supAProcess.kill('SIGKILL');
      }
    }
  });

  it('settles a claimed turn whose worker never acquired its lock', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-never-spawned', startCommandId: 'start-turn-never-spawned' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-never-spawned');
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      await expect(readTurnState(runtimeDir, 'turn-never-spawned')).resolves.toMatchObject({
        status: 'settled',
        workerError: 'worker missing during supervisor recovery',
      });
      // Recovery is the last door left to a settled turn behind an empty stream,
      // which is the Server's definition of `agent exited without a terminal event`.
      // It owes the same frame the start path now always leaves — stamped with the
      // instance that owned the turn, not with this supervisor's.
      const frame = JSON.parse(
        await readFile(join(runtimeDir, 'turns/turn-never-spawned/events.jsonl'), 'utf8'),
      ) as { runnerInstanceId: string; kind: string; result: { stderr: string } };
      expect(frame).toMatchObject({
        kind: 'result',
        runnerInstanceId: 'dead-supervisor',
        result: { stderr: 'worker missing during supervisor recovery' },
      });
    } finally {
      await supervisor.close();
    }
  });

  // After a whole-Sandbox kill every worker is gone, but a probe that cannot decide at
  // boot (here: a lock path it cannot open) used to drop the turn for good. Its state
  // stayed `running` beside a stale `control.sock`, which the Server reads as a live
  // Runner — the session then badged `running` with nothing left to ever settle it.
  it('keeps retrying a turn whose boot-time probe was undecided until it settles', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-undecided', startCommandId: 'start-turn-undecided' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-undecided');
    const lockPath = join(runtimeDir, 'turns/turn-undecided/worker.lock');
    await mkdir(lockPath);
    const supervisor = await runSupervisor({
      runtimeDir,
      ...selfOwned,
      adoptionPollMs: 10,
      unresolvedRetryMs: 10,
    });
    try {
      await expect(readTurnState(runtimeDir, 'turn-undecided')).resolves.toMatchObject({
        status: 'claimed',
      });
      await rm(lockPath, { recursive: true });
      await vi.waitFor(
        async () => {
          await expect(readTurnState(runtimeDir, 'turn-undecided')).resolves.toMatchObject({
            status: 'settled',
            workerError: 'worker missing during supervisor recovery',
          });
        },
        { timeout: 5000, interval: 20 },
      );
    } finally {
      await supervisor.close();
    }
  });

  // A removed turn directory makes the lock unopenable for good, so without a drop the
  // retry forks a `flock` every few seconds for the life of the supervisor. Watched
  // through the very same claim written back afterwards: identical ids leave only
  // the missing directory to have dropped it, and a retry still tracking it would
  // settle that turn.
  it('stops retrying an undecided turn once its directory is gone', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-gone', startCommandId: 'start-turn-gone' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-gone');
    await mkdir(join(runtimeDir, 'turns/turn-gone/worker.lock'));
    const supervisor = await runSupervisor({
      runtimeDir,
      ...selfOwned,
      adoptionPollMs: 10,
      unresolvedRetryMs: 10,
    });
    try {
      // Recursive deletion races with recovery writes and can fail with ENOTEMPTY.
      // Rename atomically so retries observe the missing turn directory.
      await rename(join(runtimeDir, 'turns/turn-gone'), join(runtimeDir, 'removed-turn-gone'));
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      await claimTurn(
        runtimeDir,
        { turnId: 'turn-gone', startCommandId: 'start-turn-gone' },
        'dead-supervisor',
      );
      await markWorkerLockProtocol('turn-gone');
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      await expect(readTurnState(runtimeDir, 'turn-gone')).resolves.toMatchObject({
        status: 'claimed',
      });
    } finally {
      await supervisor.close();
    }
  });

  // GC and a fresh claim of the same id can both land inside one retry interval, so
  // the retry never sees the directory missing. The new claim is this supervisor's
  // own and its worker may simply not hold the lock yet; settling it as "worker
  // missing during supervisor recovery" would end a turn that is just starting.
  it('leaves a re-claimed turn alone when its undecided predecessor is retried', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-reclaimed', startCommandId: 'start-turn-reclaimed' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-reclaimed');
    await mkdir(join(runtimeDir, 'turns/turn-reclaimed/worker.lock'));
    // Staged elsewhere, then swapped in with two renames, so no retry can observe
    // the gap in between.
    const stage = await mkdtemp(join(tmpdir(), 'verity-runner-reclaim-'));
    await claimTurn(
      stage,
      { turnId: 'turn-reclaimed', startCommandId: 'start-turn-reclaimed-2' },
      'live-supervisor',
    );
    const staged = await readTurnState(stage, 'turn-reclaimed');
    await writeFile(
      join(stage, 'turns/turn-reclaimed/state.json'),
      `${JSON.stringify({ ...staged, workerLock: true })}\n`,
    );
    const supervisor = await runSupervisor({
      runtimeDir,
      ...selfOwned,
      adoptionPollMs: 10,
      unresolvedRetryMs: 10,
    });
    try {
      await rename(join(runtimeDir, 'turns/turn-reclaimed'), join(stage, 'old-turn'));
      await rename(join(stage, 'turns/turn-reclaimed'), join(runtimeDir, 'turns/turn-reclaimed'));
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      await expect(readTurnState(runtimeDir, 'turn-reclaimed')).resolves.toMatchObject({
        status: 'claimed',
        startCommandId: 'start-turn-reclaimed-2',
      });
    } finally {
      await supervisor.close();
      await rm(stage, { recursive: true, force: true });
    }
  });

  // The same recovery, for a turn the operator had already stopped. The worker is
  // equally missing, but "the system lost your worker" and "you cancelled this" are
  // different things to be told, and the durable tombstone is the only thing left
  // that knows which happened — the supervisor that handled the cancel is gone.
  it('settles a cancelled turn whose worker is missing as a cancellation, not a crash', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-cancelled-recovery', startCommandId: 'start-cancelled-recovery' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-cancelled-recovery');
    await mkdir(join(runtimeDir, 'cancellations'), { recursive: true, mode: 0o770 });
    await writeFile(
      join(runtimeDir, 'cancellations/turn-cancelled-recovery.json'),
      JSON.stringify({ turnId: 'turn-cancelled-recovery' }),
    );
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      await expect(readTurnState(runtimeDir, 'turn-cancelled-recovery')).resolves.toMatchObject({
        status: 'settled',
        workerSignal: 'SIGTERM',
      });
      const frame = JSON.parse(
        await readFile(join(runtimeDir, 'turns/turn-cancelled-recovery/events.jsonl'), 'utf8'),
      ) as { result: { aborted: boolean; exitCode: number; stderr: string } };
      // `aborted` is what keeps the session from badging a failure, and 143 is the
      // exit code the Server reads as an interruption rather than a crash.
      expect(frame.result).toMatchObject({
        aborted: true,
        exitCode: 143,
        stderr: 'runner turn was cancelled; its worker did not survive the supervisor restart',
      });
    } finally {
      await supervisor.close();
    }
  });

  // The other end of that path, and the one place it deliberately does nothing. A turn
  // whose state file is gone cannot be settled truthfully — there is no start command
  // to attribute it to and no instance to stamp — and a state invented here would tell
  // the Server a turn failed that it can in fact simply start again.
  it('leaves a turn whose state file has vanished for the Server to reclaim', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-state-vanished', startCommandId: 'start-turn-state-vanished' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-state-vanished');
    await rm(join(runtimeDir, 'turns/turn-state-vanished/state.json'), { force: true });
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      // Long enough for the adopter to have polled this turn several times over.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expect(readTurnState(runtimeDir, 'turn-state-vanished')).resolves.toBeUndefined();
      // And no frame either: a stream with a verdict in it and no state to match is
      // the same unreadable turn by another route.
      expect(existsSync(join(runtimeDir, 'turns/turn-state-vanished/events.jsonl'))).toBe(false);
    } finally {
      await supervisor.close();
    }
  });

  it('leaves a claimed turn uncertain when worker.lock is a symlink', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-lock-symlink', startCommandId: 'start-turn-lock-symlink' },
      'dead-supervisor',
    );
    await markWorkerLockProtocol('turn-lock-symlink');
    const outside = join(runtimeDir, 'outside-worker-lock');
    await writeFile(outside, '');
    await symlink(outside, join(runtimeDir, 'turns/turn-lock-symlink/worker.lock'));
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      await expect(readTurnState(runtimeDir, 'turn-lock-symlink')).resolves.toMatchObject({
        status: 'claimed',
      });
    } finally {
      await supervisor.close();
    }
  });

  it('keeps a pre-worker-lock legacy turn uncertain during adoption', async () => {
    await claimTurn(
      runtimeDir,
      { turnId: 'turn-legacy', startCommandId: 'start-turn-legacy' },
      'old-supervisor',
    );
    const supervisor = await runSupervisor({ runtimeDir, ...selfOwned, adoptionPollMs: 10 });
    try {
      await expect(readTurnState(runtimeDir, 'turn-legacy')).resolves.toMatchObject({
        status: 'claimed',
      });
      await expect(lstat(join(runtimeDir, 'turns/turn-legacy/worker.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await supervisor.close();
    }
  });
});
