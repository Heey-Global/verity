import { chmod, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  frameBodyHash,
  runnerFrameIngestEnvelope,
  tailFrames,
  type RunnerFrame,
  type RunnerFrameBody,
} from '@verity/session';
import { RUNNER_FRAME_PROTOCOL_VERSION } from '@verity/store';
import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';
import {
  readTurnState,
  writeSyntheticTerminalFrame,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  NATIVE_WORKER_SETTLE_TIMEOUT_MS,
  runSupervisor,
  supervisorRequest,
} from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  // The privilege boundary the synthetic frame crosses. The turn directory is
  // worker-writable and the supervisor is not confined the way the worker is, so a
  // worker that replaced its own event file with a link would otherwise have the
  // supervisor write this frame wherever the link points — arbitrary file creation
  // outside the worker's reach, triggered by dying. A link is refused outright
  // rather than resolved, which is what `lstat` plus `O_NOFOLLOW` buy.
  it('refuses to write a synthetic terminal frame through a symlinked event stream', async () => {
    const turnDir = join(runtimeDir, 'turns', 'turn-symlinked-stream');
    const outside = join(runtimeDir, 'outside-the-turn.jsonl');
    await mkdir(turnDir, { recursive: true });
    await symlink(outside, join(turnDir, 'events.jsonl'));

    await expect(
      writeSyntheticTerminalFrame(turnDir, {
        turnId: 'turn-symlinked-stream',
        runnerInstanceId: 'runner-1',
        workerExitCode: 1,
        workerSignal: null,
      }),
    ).resolves.toBe(false);
    // Not written, not created, not even truncated: the link target is untouched.
    expect(existsSync(outside)).toBe(false);
  });

  // The same hole in the form neither `isFile()` nor `O_NOFOLLOW` can see. A hardlink
  // to an existing empty file passes every check a symlink fails — it IS a regular
  // file, of size zero — and appending to it writes the frame into that file. Only
  // the link count tells them apart.
  it('refuses to write a synthetic terminal frame through a hardlinked event stream', async () => {
    const turnDir = join(runtimeDir, 'turns', 'turn-hardlinked-stream');
    const outside = join(runtimeDir, 'outside-the-turn-hardlink.jsonl');
    await mkdir(turnDir, { recursive: true });
    await writeFile(outside, '');
    await link(outside, join(turnDir, 'events.jsonl'));

    await expect(
      writeSyntheticTerminalFrame(turnDir, {
        turnId: 'turn-hardlinked-stream',
        runnerInstanceId: 'runner-1',
        workerExitCode: 1,
        workerSignal: null,
      }),
    ).resolves.toBe(false);
    // Still empty: the frame went nowhere rather than into a file outside the turn.
    expect(await readFile(outside, 'utf8')).toBe('');
  });

  // The cancellation tombstone is read on the way into a spawn and again on the way
  // out of one, and the read can fail for reasons other than "absent". Letting it
  // throw aborted whichever path was running — including, on the way in, before the
  // turn was settled at all, which left it `claimed` forever with no worker and no
  // frame: the never-finishes symptom this whole change exists to remove. On the way
  // in the unreadable answer stops the worker, because running a turn the operator
  // cancelled is the one outcome that cannot be taken back.
  it('settles a turn whose cancellation tombstone cannot be read, without spawning', async () => {
    // A directory where the tombstone file belongs: `readFile` answers EISDIR, which
    // is neither "cancelled" nor the ENOENT that means "not cancelled".
    await mkdir(join(runtimeDir, 'cancellations', 'turn-unreadable-tombstone.json'), {
      recursive: true,
    });
    let workerStarts = 0;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      spawnWorker: (command, args, options) => {
        workerStarts += 1;
        return spawn(command, args, options);
      },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-unreadable-tombstone',
          startCommandId: 'start-unreadable-tombstone',
          sessionId: 'session-unreadable-tombstone',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'never runs',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'terminal' });
      expect(workerStarts).toBe(0);
      // Decided, not stranded — and owed a terminal frame all the same, because a
      // settled turn behind an empty stream is a crash to the Server.
      expect(await readTurnState(runtimeDir, 'turn-unreadable-tombstone')).toMatchObject({
        status: 'settled',
      });
      const frame = JSON.parse(
        await readFile(
          join(runtimeDir, 'turns', 'turn-unreadable-tombstone', 'events.jsonl'),
          'utf8',
        ),
      ) as { kind: string; result: { aborted: boolean; stderr: string } };
      // Refused, but NOT reported as cancelled: the operator did not cancel this turn,
      // a filesystem fault stopped it, and `aborted` is what tells the session which of
      // those it is looking at. Blocking the start on an unreadable tombstone is a
      // safety choice; describing it as the operator's own doing would be a false one.
      expect(frame).toMatchObject({
        kind: 'result',
        result: {
          aborted: false,
          stderr: 'runner turn could not start: its cancellation record was unreadable',
        },
      });
    } finally {
      await supervisor.close();
    }
  });

  // The other half of that catch block. It writes a terminal frame — a claim that
  // nothing is running under this turn any more — but the guards it runs for can
  // reject a worker that really did start. Declaring a live agent dead is worse than
  // the failure being reported, so the child has to go with the frame.
  it('kills a worker it rejects after spawn rather than declaring it dead while it runs', async () => {
    let child: ChildProcess | undefined;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      // Ignores SIGTERM, so only a SIGKILL ends it: a graceful shutdown at the end of
      // this test would otherwise mask the very kill under test.
      workerArgs: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      spawnWorker: (command, args, options) => {
        // A worker with no attestation pipe: spawned and alive, then refused by the
        // guard that requires one.
        const stdio = [...(options.stdio as unknown[])];
        stdio[1] = 'ignore';
        child = spawn(command, args, { ...options, stdio } as typeof options);
        return child;
      },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-rejected-after-spawn',
          startCommandId: 'start-rejected-after-spawn',
          sessionId: 'session-rejected-after-spawn',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'never observed',
        }),
      ).resolves.toMatchObject({ ok: false });
      const spawned = child;
      if (spawned === undefined) throw new Error('expected the worker to have been spawned');
      await vi.waitFor(() => {
        expect(spawned.killed || spawned.exitCode !== null || spawned.signalCode !== null).toBe(
          true,
        );
      });
      expect(await readTurnState(runtimeDir, 'turn-rejected-after-spawn')).toMatchObject({
        status: 'settled',
      });
    } finally {
      await supervisor.close();
    }
  });

  it('gives a worker that died before its first event a terminal frame of its own', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.stderr.write('codex: connection refused');process.exit(3)"],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-early-death',
        startCommandId: 'start-early-death',
        sessionId: 'session-early-death',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'die early',
      });
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, 'turn-early-death')).toMatchObject({
          status: 'settled',
        });
      });
      const lines = (
        await readFile(join(runtimeDir, 'turns/turn-early-death/events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      const frame = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(frame).toMatchObject({
        kind: 'result',
        // D3: contiguous from 1, and bound to the instance that wrote it — the
        // supervisor's own, because no worker ever opened this stream.
        frameSeq: 1,
        turnId: 'turn-early-death',
        runnerInstanceId: supervisor.instanceId,
        result: {
          exitCode: 3,
          // The same allow-listed diagnostic the turn state gets: the frame reaches
          // the operator, so it may not carry raw worker stderr either.
          stderr: 'worker stderr reported a connection failure',
          aborted: false,
        },
      });
      // No agent session id, because this worker never learned one. The Server
      // persists a failed turn's `result.sessionId` as the session's resume pointer,
      // so echoing the store's id here would pin the next turn to a thread the agent
      // never opened.
      expect(Object.keys(frame.result as Record<string, unknown>)).not.toContain('sessionId');
      // The Server stores this hash on first claim and compares it on replay, so a
      // synthetic frame has to be hashed exactly like a worker's.
      const { protocolVersion, runnerInstanceId, turnId, frameSeq, payloadHash, ...body } = frame;
      expect(payloadHash).toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'));
      expect(protocolVersion).toBe(1);
      expect([runnerInstanceId, turnId, frameSeq]).toEqual([
        supervisor.instanceId,
        'turn-early-death',
        1,
      ]);
    } finally {
      await supervisor.close();
    }
  });

  // The frame above is hand-built in the Sandbox toolkit, against a schema whose
  // reader lives in another package — protocol version, envelope shape and hash
  // algorithm all restated by hand on the writing side. So read it with the actual
  // reader: `tailFrames` is the code the Server runs against a live turn, and it
  // rejects an unknown `kind` or a malformed envelope outright rather than dropping
  // the frame. If the two ends ever drift, this fails here instead of in production
  // as a turn that never ends.
  it('produces a synthetic frame the Server-side tail accepts and settles on', async () => {
    let ctx: TestDb | undefined;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(3)'],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-cross-package',
        startCommandId: 'start-cross-package',
        sessionId: 'session-cross-package',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'die early',
      });
      const frames: RunnerFrame[] = [];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 10_000);
      try {
        // Resolves only when a `result` frame is delivered — the tail's own
        // definition of a turn that ended, which is precisely what an early death
        // used to leave it waiting for forever.
        await tailFrames(
          join(runtimeDir, 'turns/turn-cross-package/events.jsonl'),
          (frame) => {
            frames.push(frame);
          },
          { pollMs: 20, signal: abort.signal },
        );
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
      expect(frames).toHaveLength(1);
      const [frame] = frames as [RunnerFrame & { result: Record<string, unknown> }];
      expect(frame.kind).toBe('result');
      expect(frame.result).toMatchObject({ exitCode: 3, aborted: false });
      // And the hash the Server will store and compare on replay is the one the
      // Server's own function computes over the body it parsed — the algorithm lives
      // in @verity/session and is only mirrored in the toolkit.
      const { protocolVersion, runnerInstanceId, turnId, frameSeq, payloadHash, ...body } = frame;
      expect(payloadHash).toBe(frameBodyHash(body as RunnerFrameBody));
      expect({ protocolVersion, runnerInstanceId, turnId, frameSeq }).toEqual({
        // The Store's constant, not a literal: the supervisor mirrors this number by
        // hand, and the Store refuses a frame whose version it does not ingest. A bump
        // on one side has to fail here rather than in a turn that never ends.
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        runnerInstanceId: supervisor.instanceId,
        turnId: 'turn-cross-package',
        frameSeq: 1,
      });
      // Finally through the REAL ingester, by the REAL mapping. Everything above
      // proves the frame parses; only this proves the Store takes it — and the Store
      // is what actually ends the turn. It validates the protocol version, the seq,
      // the reserved fence hash and the terminal/event exclusivity, and a frame it
      // throws on leaves the running marker in place, which is the very "session stuck
      // forever" symptom this branch exists to remove. Asserting it against a
      // hand-built copy of the envelope would only prove the copy.
      //
      // The store is built HERE rather than in a file-level hook: this is the only
      // test in the file that needs one, and a `beforeAll` would pay for a migrated
      // database in every run of the other hundred and forty.
      //
      // Isolated rather than shared, and not by preference: other tests in this file
      // drive fake timers, and the shared harness resolves to one socket-backed
      // PostgreSQL in CI, which `advanceTimersByTimeAsync` cannot flush. The guard in
      // `scripts/test-db-harness.test.ts` enforces that pairing per FILE — by grepping
      // for the shared factory's NAME, so do not write it here even in prose — which
      // makes the choice the file's, not this test's. A private pglite costs a WASM
      // boot; correctness in CI is worth it.
      ctx = await createIsolatedTestDb();
      await ctx.store.createSession({
        sessionId: 'session-cross-package',
        worktree: runtimeDir,
        model: 'claude-opus-4-8',
      });
      await ctx.store.markTurnRunning({ sessionId: 'session-cross-package', promptSeq: 1 });
      await ctx.store.bindTurnIdentity('session-cross-package', {
        turnId: 'turn-cross-package',
        startCommandId: 'start-cross-package',
      });
      await expect(
        ctx.store.ingestRunnerFrame('session-cross-package', runnerFrameIngestEnvelope(frame)),
      ).resolves.toEqual({ outcome: 'accepted' });
      // The marker is gone, so the session is usable again rather than waiting on a
      // Runner that died three hundred milliseconds ago.
      expect(await ctx.store.listRunningTurns()).toEqual([]);
    } finally {
      await supervisor.close();
      await ctx?.close();
    }
  });

  // A clean exit with nothing in the stream is still a failed turn: the Server's
  // terminal-marker safety net ignores exit 0, so reporting the process's own code
  // would leave the session badged running with no event that ever ends it.
  it('reports an empty stream after a clean worker exit as a failed turn', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(0)'],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-silent-success',
        startCommandId: 'start-silent-success',
        sessionId: 'session-silent-success',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'say nothing',
      });
      await vi.waitFor(
        async () => {
          expect(await readTurnState(runtimeDir, 'turn-silent-success')).toMatchObject({
            status: 'settled',
            workerExitCode: 0,
          });
        },
        { timeout: NATIVE_WORKER_SETTLE_TIMEOUT_MS },
      );
      const frame = JSON.parse(
        (await readFile(join(runtimeDir, 'turns/turn-silent-success/events.jsonl'), 'utf8')).trim(),
      ) as { result: { exitCode: number; stderr: string } };
      // The process's own 0 stays in the turn state; the frame carries the turn's
      // verdict, which is that nothing was produced.
      expect(frame.result.exitCode).toBe(1);
      expect(frame.result.stderr).toMatch(/before producing any event/u);
    } finally {
      await supervisor.close();
    }
  });

  // The invariant that makes the synthetic frame safe: a worker that wrote even one
  // frame owns `turnId` → its own `runnerInstanceId` and the sequence after it, so
  // the supervisor must never append under a second instance id (ADR 0006 D3).
  it('never appends to an event stream a worker already owns', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';await writeFile(join(process.env.VERITY_RUNNER_TURN_DIR,'events.jsonl'),JSON.stringify({protocolVersion:1,runnerInstanceId:'worker-owned',turnId:'turn-owned-stream',frameSeq:1,payloadHash:'x',kind:'session',id:'session-owned'})+'\\n');process.exit(4);`,
      ],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-owned-stream',
        startCommandId: 'start-owned-stream',
        sessionId: 'session-owned',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'write then die',
      });
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, 'turn-owned-stream')).toMatchObject({
          status: 'settled',
          workerExitCode: 4,
        });
      });
      const lines = (
        await readFile(join(runtimeDir, 'turns/turn-owned-stream/events.jsonl'), 'utf8')
      )
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        runnerInstanceId: 'worker-owned',
        kind: 'session',
      });
    } finally {
      await supervisor.close();
    }
  });

  // A turn the operator cancelled is not a crash. The SIGKILL that ends the grace
  // window would otherwise reach the session as `agent exited with code 137`.
  it('marks the synthetic frame of a cancelled turn as aborted', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-cancel-frame',
        startCommandId: 'start-cancel-frame',
        sessionId: 'session-cancel-frame',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'wait to be cancelled',
      });
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'cancel-turn',
          turnId: 'turn-cancel-frame',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'cancelled' });
      const frame = JSON.parse(
        (await readFile(join(runtimeDir, 'turns/turn-cancel-frame/events.jsonl'), 'utf8')).trim(),
      ) as { kind: string; result: { aborted: boolean } };
      expect(frame.kind).toBe('result');
      expect(frame.result.aborted).toBe(true);
    } finally {
      await supervisor.close();
    }
  });

  it('delivers large image references to the worker over start-turn', async () => {
    const dir = join(runtimeDir, '.verity-sessions/attachments/turn-turn-image');
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.alloc(3 * 1024 * 1024, 42);
    const images: {
      kind: 'image';
      mediaType: 'image/png';
      filePath: string;
      byteSize: number;
      sha256: string;
    }[] = [];
    for (let index = 0; index < 2; index += 1) {
      const filePath = join(dir, `image-${String(index)}.png`);
      await writeFile(filePath, bytes);
      images.push({
        kind: 'image',
        mediaType: 'image/png',
        filePath,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    const supervisor = await runSupervisor({
      runtimeDir,
      // Pin runtime ownership to this process (self-owned mkdtemp) so the check passes
      // without depending on the container's VERITY_RUNNER_RUNTIME_UID/GID (1101).
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';const request=JSON.parse(await readFile(process.argv[1],'utf8'));await writeFile(join(process.env.VERITY_RUNNER_TURN_DIR,'worker-started.json'),JSON.stringify(request));process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
      ],
    });
    try {
      const imageResponse = await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-image',
        startCommandId: 'start-image',
        sessionId: 'session-image',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'describe this',
        attachments: images,
      });
      expect(imageResponse).toMatchObject({ ok: true, outcome: 'created' });
      // Large image bytes must never inflate the persisted worker request.
      await vi.waitFor(async () => {
        expect(
          JSON.parse(
            await readFile(join(runtimeDir, 'turns/turn-image/worker-started.json'), 'utf8'),
          ),
        ).toMatchObject({
          turnId: 'turn-image',
          prompt: 'describe this',
          attachments: images,
        });
      });
    } finally {
      await supervisor.close();
    }
  });

  it('settles a worker that exits immediately without missing its exit event', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(0)'],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-fast',
        startCommandId: 'start-fast',
        sessionId: 'session-fast',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'fast',
      });
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, 'turn-fast')).toMatchObject({
          status: 'settled',
          workerExitCode: 0,
        });
      });
      const terminal = JSON.parse(
        await readFile(join(runtimeDir, 'turns', 'turn-fast', 'events.jsonl'), 'utf8'),
      ) as { kind: string; result: { exitCode: number; stderr: string } };
      expect(terminal).toMatchObject({
        kind: 'result',
        result: {
          exitCode: 1,
          stderr: 'runner worker exited successfully before producing any event',
        },
      });
    } finally {
      await supervisor.close();
    }
  });

  it('does not persist raw details from a worker spawn exception', async () => {
    const secret = ['unknown', 'credential', 'value'].join('-');
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      spawnWorker: () => {
        throw new Error(`connector spawn rejected token: ${secret}`);
      },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-spawn-error',
          startCommandId: 'start-spawn-error',
          sessionId: 'session-spawn-error',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'fail safely',
        }),
      ).resolves.toMatchObject({ ok: false, error: 'runner worker spawn failed' });
      await expect(readTurnState(runtimeDir, 'turn-spawn-error')).resolves.toMatchObject({
        status: 'settled',
        workerError: 'runner worker spawn failed',
      });
      const state = await readTurnState(runtimeDir, 'turn-spawn-error');
      expect(state?.workerError).not.toContain(secret);
    } finally {
      await supervisor.close();
    }
  });

  it('preflights a bare worker executable through its effective PATH', async () => {
    const workerName = 'path-worker';
    await symlink(process.execPath, join(runtimeDir, workerName));
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: workerName,
      workerArgs: ['-e', 'process.exit(0)'],
      workerEnv: { PATH: runtimeDir },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-path-worker',
          startCommandId: 'start-path-worker',
          sessionId: 'session-path-worker',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: runtimeDir,
          prompt: 'resolve safely',
        }),
      ).resolves.toMatchObject({ ok: true });
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, 'turn-path-worker')).toMatchObject({
          status: 'settled',
          workerExitCode: 0,
        });
      });
    } finally {
      await supervisor.close();
    }
  });

  it('resolves a relative worker PATH entry from the requested cwd', async () => {
    const workerName = 'relative-path-worker';
    const requestedCwd = join(runtimeDir, 'session-worktree');
    await mkdir(requestedCwd);
    await symlink(process.execPath, join(runtimeDir, workerName));
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: workerName,
      workerArgs: ['-e', 'process.exit(0)'],
      workerEnv: { PATH: '..' },
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-relative-path-worker',
          startCommandId: 'start-relative-path-worker',
          sessionId: 'session-relative-path-worker',
          backend: 'claude-acp',
          worktree: requestedCwd,
          cwd: requestedCwd,
          prompt: 'resolve relative PATH safely',
        }),
      ).resolves.toMatchObject({ ok: true });
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, 'turn-relative-path-worker')).toMatchObject({
          status: 'settled',
          workerExitCode: 0,
        });
      });
    } finally {
      await supervisor.close();
    }
  });

  it('classifies an EACCES cwd failure without persisting arbitrary exception text', async () => {
    const blockedCwd = join(runtimeDir, 'blocked-cwd');
    await mkdir(blockedCwd);
    await chmod(blockedCwd, 0o600);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(0)'],
    });
    try {
      await expect(
        supervisorRequest(supervisor.socketPath, {
          protocolVersion: 1,
          kind: 'start-turn',
          turnId: 'turn-cwd-eacces',
          startCommandId: 'start-cwd-eacces',
          sessionId: 'session-cwd-eacces',
          backend: 'claude-acp',
          worktree: runtimeDir,
          cwd: blockedCwd,
          prompt: 'fail safely',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: `runner worker spawn failed with error code EACCES (cwd-traverse: ${blockedCwd})`,
      });
      await expect(readTurnState(runtimeDir, 'turn-cwd-eacces')).resolves.toMatchObject({
        workerSpawnFailure: {
          stage: 'cwd-traverse',
          target: 'cwd',
          path: blockedCwd,
          code: 'EACCES',
        },
      });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('"stage":"cwd-traverse","target":"cwd"'),
      );
    } finally {
      await chmod(blockedCwd, 0o700);
      await supervisor.close();
      stderr.mockRestore();
    }
  });

  it('persists bounded private stderr only when the worker fails', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '-e',
        "process.stderr.write('x'.repeat(32*1024)+'\\nspecific failure');process.exit(7)",
      ],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-stderr-failure',
        startCommandId: 'start-stderr-failure',
        sessionId: 'session-stderr-failure',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'fail',
      });
      await vi.waitFor(async () => {
        const state = await readTurnState(runtimeDir, 'turn-stderr-failure');
        expect(state).toMatchObject({
          status: 'settled',
          workerExitCode: 7,
          workerError: 'worker stderr reported an unrecognized failure',
        });
        expect(Buffer.byteLength(state?.workerError ?? '')).toBeLessThanOrEqual(16 * 1024);
      });
    } finally {
      await supervisor.close();
    }
  });

  it('does not persist stderr from a successful worker', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.stderr.write('successful diagnostic');process.exit(0)"],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-stderr-success',
        startCommandId: 'start-stderr-success',
        sessionId: 'session-stderr-success',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'succeed',
      });
      await vi.waitFor(async () => {
        const state = await readTurnState(runtimeDir, 'turn-stderr-success');
        expect(state).toMatchObject({ status: 'settled', workerExitCode: 0 });
        expect(state).not.toHaveProperty('workerError');
      });
    } finally {
      await supervisor.close();
    }
  });

  it('redacts credentials from persisted worker stderr', async () => {
    const secret = ['sk', 'ant', 'api03', 'abcDEF123', '456789ghiJKL'].join('-');
    const privateKeyBegin = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const privateKeyEnd = ['-----END ', 'PRIVATE KEY-----'].join('');
    const databaseUrl = ['postgres://user:', 'password', '@host/db'].join('');
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '-e',
        [
          `process.stderr.write('x'.repeat(16*1024-10)+'${secret}\\n');`,
          `process.stderr.write('${privateKeyBegin}'+'x'.repeat(17*1024)+'\\nsensitivePemBody\\n${privateKeyEnd}\\n');`,
          `process.stderr.write('{\\"authorization\\":\\"Bearer structured-secret\\"} DATABASE_URL=${databaseUrl} token=lowercase-secret --api-key cli-secret authentication failed');`,
          'process.exit(8);',
        ].join(''),
      ],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-stderr-secret',
        startCommandId: 'start-stderr-secret',
        sessionId: 'session-stderr-secret',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'fail safely',
      });
      await vi.waitFor(async () => {
        const state = await readTurnState(runtimeDir, 'turn-stderr-secret');
        expect(state).toMatchObject({
          status: 'settled',
          workerExitCode: 8,
          workerError: 'worker stderr reported an authentication failure',
        });
        expect(state?.workerError).not.toContain(secret);
        expect(state?.workerError).not.toContain('sensitivePemBody');
        expect(state?.workerError).not.toContain('structured-secret');
        expect(state?.workerError).not.toContain('user:password');
        expect(state?.workerError).not.toContain('lowercase-secret');
        expect(state?.workerError).not.toContain('cli-secret');
      });
    } finally {
      await supervisor.close();
    }
  });

  it('settles when a worker descendant keeps the stderr pipe open', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "spawn(process.execPath,['-e','setTimeout(()=>{},10_000)'],{stdio:['ignore','ignore',2]});",
          "process.stderr.write('worker failed before descendant exit');",
          'process.exit(9);',
        ].join(''),
      ],
    });
    try {
      await supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-stderr-descendant',
        startCommandId: 'start-stderr-descendant',
        sessionId: 'session-stderr-descendant',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'fail with inherited stderr',
      });
      await vi.waitFor(
        async () => {
          const state = await readTurnState(runtimeDir, 'turn-stderr-descendant');
          expect(state).toMatchObject({
            status: 'settled',
            workerExitCode: 9,
            workerError: 'worker stderr reported an unrecognized failure',
          });
        },
        { timeout: 2_000 },
      );
    } finally {
      await supervisor.close();
    }
  });

  it('escalates a SIGTERM-resistant worker to SIGKILL during shutdown', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '-e',
        "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.env.VERITY_RUNNER_TURN_DIR+'/ready','');setInterval(()=>{},1000)",
      ],
      shutdownGraceMs: 10,
    });
    await supervisorRequest(supervisor.socketPath, {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-stubborn',
      startCommandId: 'start-stubborn',
      sessionId: 'session-stubborn',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'stubborn',
    });
    await vi.waitFor(async () => {
      await expect(readFile(join(runtimeDir, 'turns/turn-stubborn/ready'))).resolves.toBeDefined();
    });
    await supervisor.close();
    await expect(readTurnState(runtimeDir, 'turn-stubborn')).resolves.toMatchObject({
      status: 'settled',
      workerSignal: 'SIGKILL',
    });
  });
});
