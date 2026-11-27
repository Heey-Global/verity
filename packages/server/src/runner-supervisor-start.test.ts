import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTurnState } from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  runSupervisor,
  supervisorRequest,
  supervisorRequestFrames,
  supervisorRequestsTogether,
  supervisorRequestFramesTogether,
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
  it('starts one supervisor-owned worker and replays StartTurn idempotently', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';const request=JSON.parse(await readFile(process.argv[1],'utf8'));await writeFile(join(process.env.VERITY_RUNNER_TURN_DIR,'worker-started.json'),JSON.stringify(request));process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
      ],
    });
    const request = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
      await new Promise((resolveReply, rejectReply) => {
        const socket = createConnection(supervisor.socketPath);
        let response = '';
        socket.once('error', rejectReply);
        socket.on('data', (chunk) => {
          response += chunk.toString('utf8');
        });
        socket.once('end', () => resolveReply(JSON.parse(response) as Record<string, unknown>));
        socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
      });
    const start = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-worker',
      startCommandId: 'start-worker',
      sessionId: 'session-worker',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'hello',
      appendSystemPrompt: 'policy',
      resumeSessionId: 'claude-session-1',
      permissionControl: true,
      permissionMode: 'plan',
      allowedTools: ['Read', 'Bash(git *)'],
      disallowedTools: ['WebFetch'],
      timeoutMs: 30_000,
    };
    try {
      await expect(request(start)).resolves.toMatchObject({
        ok: true,
        outcome: 'created',
        state: { status: 'running' },
      });
      await expect(request(start)).resolves.toMatchObject({
        ok: true,
        outcome: 'already-running',
      });
      await expect(request({ ...start, startCommandId: 'different-start' })).resolves.toMatchObject(
        { ok: true, outcome: 'conflict' },
      );
      await vi.waitFor(async () => {
        expect(
          JSON.parse(
            await readFile(join(runtimeDir, 'turns/turn-worker/worker-started.json'), 'utf8'),
          ),
        ).toMatchObject({
          turnId: 'turn-worker',
          prompt: 'hello',
          appendSystemPrompt: 'policy',
          resumeSessionId: 'claude-session-1',
          permissionControl: true,
          permissionMode: 'plan',
          allowedTools: ['Read', 'Bash(git *)'],
          disallowedTools: ['WebFetch'],
          timeoutMs: 30_000,
        });
      });
      expect((await lstat(join(runtimeDir, 'turns/turn-worker/request.json'))).mode & 0o777).toBe(
        0o600,
      );
      await expect(
        request({
          ...start,
          turnId: 'turn-invalid-timeout',
          startCommandId: 'start-invalid-timeout',
          timeoutMs: 0,
        }),
      ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/timeoutMs/) });
    } finally {
      await supervisor.close();
    }
    await expect(readTurnState(runtimeDir, 'turn-worker')).resolves.toMatchObject({
      status: 'settled',
      workerExitCode: 0,
    });
  });

  it('returns the same worker when the StartTurn ACK is lost and retried', async () => {
    const startedPath = join(runtimeDir, 'worker-starts.jsonl');
    let workerStarts = 0;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: [
        '--input-type=module',
        '-e',
        `import {appendFile,readFile} from 'node:fs/promises';const request=JSON.parse(await readFile(process.argv[1],'utf8'));await appendFile(${JSON.stringify(startedPath)},JSON.stringify({pid:process.pid,turnId:request.turnId,startCommandId:request.startCommandId})+'\\n');process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,
      ],
      spawnWorker: (command, args, options) => {
        workerStarts += 1;
        return spawn(command, args, options);
      },
    });
    const start = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-lost-start-ack',
      startCommandId: 'start-lost-start-ack',
      sessionId: 'session-lost-start-ack',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'start exactly once',
    };
    try {
      // Deliver the complete request, then destroy the peer before reading the reply.
      // The durable worker artifact below proves the Supervisor processed the request.
      await new Promise<void>((resolveSent, rejectSent) => {
        const socket = createConnection(supervisor.socketPath);
        socket.once('error', rejectSent);
        socket.once('connect', () => {
          socket.write(`${JSON.stringify(start)}\n`, (error) => {
            if (error) {
              rejectSent(error);
              return;
            }
            socket.destroy();
            resolveSent();
          });
        });
      });

      await vi.waitFor(async () => {
        expect((await readFile(startedPath, 'utf8')).trim().split('\n')).toHaveLength(1);
      });
      const [workerRecord] = (await readFile(startedPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // The worker writes its artifact just before the start promise promotes
      // the durable claim. On a slow runner, reading immediately can observe
      // that intentional `claimed` window and fail without a product defect.
      await vi.waitFor(async () => {
        expect(await readTurnState(runtimeDir, start.turnId)).toMatchObject({
          status: 'running',
          workerPid: expect.any(Number),
        });
      });
      const stateAfterLostAck = await readTurnState(runtimeDir, start.turnId);
      expect(stateAfterLostAck).toMatchObject({
        runnerInstanceId: supervisor.instanceId,
        startCommandId: start.startCommandId,
        status: 'running',
        workerPid: expect.any(Number),
      });
      expect(workerRecord).toEqual({
        pid: stateAfterLostAck?.workerPid,
        turnId: start.turnId,
        startCommandId: start.startCommandId,
      });
      expect(workerStarts).toBe(1);

      const retry = await supervisorRequest(supervisor.socketPath, start);
      expect(retry).toMatchObject({
        ok: true,
        state: {
          runnerInstanceId: supervisor.instanceId,
          startCommandId: start.startCommandId,
          status: 'running',
          workerPid: stateAfterLostAck?.workerPid,
        },
      });
      // The durable worker artifact is written just before the original start
      // promise settles. A retry in that narrow window joins that promise and
      // truthfully receives its `created` result; after it settles, replay reads
      // the durable claim and reports `already-running`.
      expect(['created', 'already-running']).toContain(retry.outcome);
      await expect(supervisorRequest(supervisor.socketPath, start)).resolves.toMatchObject({
        ok: true,
        outcome: 'already-running',
        state: { workerPid: stateAfterLostAck?.workerPid },
      });
      expect(workerStarts).toBe(1);
      expect((await readFile(startedPath, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await supervisor.close();
    }
  });

  // The two-phase reply the Server's start budget now rests on: the supervisor says
  // "heard you, claiming" before the fsyncs and the two forks, and the real outcome
  // afterwards. Only then can a slow start be told apart from a wedged supervisor.
  it('acknowledges an opted-in start before the worker is up', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
    });
    const start = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-ack',
      startCommandId: 'start-ack',
      sessionId: 'session-ack',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'acknowledge me',
    };
    try {
      const frames = await supervisorRequestFrames(supervisor.socketPath, {
        ...start,
        startAck: true,
      });
      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual({
        ok: true,
        kind: 'start-accepted',
        turnId: 'turn-ack',
        startCommandId: 'start-ack',
      });
      expect(frames[1]).toMatchObject({
        ok: true,
        outcome: 'created',
        state: { status: 'running' },
      });

      // ADR 0006 D9, from the other side: a Server that predates the flag reads
      // exactly one frame, so a supervisor must never volunteer the acknowledgement.
      const legacy = await supervisorRequestFrames(supervisor.socketPath, {
        ...start,
        turnId: 'turn-legacy-ack',
        startCommandId: 'start-legacy-ack',
      });
      expect(legacy).toHaveLength(1);
      expect(legacy[0]).toMatchObject({ ok: true, outcome: 'created' });
    } finally {
      await supervisor.close();
    }
  });

  // A refusal must not arrive AFTER an acknowledgement that the start was accepted:
  // the Server would already have re-armed to the long start budget and would wait
  // out a turn that will never exist.
  it('refuses an invalid start without acknowledging it first', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'setInterval(()=>{},1000)'],
    });
    try {
      const frames = await supervisorRequestFrames(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-invalid-ack',
        startCommandId: 'start-invalid-ack',
        sessionId: 'session-invalid-ack',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'nope',
        timeoutMs: 0,
        startAck: true,
      });
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ ok: false, error: expect.stringMatching(/timeoutMs/) });
    } finally {
      await supervisor.close();
    }
  });

  // The duplicate-worker half of the incident. Retries of the SAME start command
  // that arrive while the first is still mid-spawn used to race `claimTurn`; they
  // now collapse onto the one start in flight, so the worktree only ever sees one
  // worker no matter how often the Server re-sends.
  it('spawns one worker for concurrent retries of the same start command', async () => {
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
    const start = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-retry-storm',
      startCommandId: 'start-retry-storm',
      sessionId: 'session-retry-storm',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'exactly once',
      startAck: true,
    };
    try {
      // Together, so the retries genuinely overlap the first start: five requests that
      // merely follow one another would each find a running turn and test the ordinary
      // idempotent path instead of the collapse.
      const replies = await supervisorRequestsTogether(
        supervisor.socketPath,
        Array.from({ length: 5 }, () => start),
      );
      expect(workerStarts).toBe(1);
      // Every retry is answered, and answered identically — a collapsed retry must
      // not be left hanging on a promise nobody resolves, and the same start command
      // has exactly one truthful outcome however many sockets asked for it.
      for (const reply of replies) {
        expect(reply).toMatchObject({ ok: true, outcome: 'created', state: { status: 'running' } });
        expect(reply).toEqual(replies[0]);
      }
      const state = await readTurnState(runtimeDir, start.turnId);
      expect(state).toMatchObject({ startCommandId: start.startCommandId, status: 'running' });
    } finally {
      await supervisor.close();
    }
  });

  // The other side of that collapse, and the reason it is keyed on the start command
  // rather than on the turn alone: two DIFFERENT commands for one turn are not one
  // piece of work. Adopting the second onto the first would report a stranger's
  // outcome as its own, and letting it through would put a second worker on the same
  // worktree. It is refused synchronously instead — which also keeps the global queue
  // cap honest, since conflicts chained onto one turn would otherwise bypass it.
  it('refuses a second start command for a turn that is already starting', async () => {
    let workerStarts = 0;
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      maxConcurrentStarts: 1,
      spawnWorker: (command, args, options) => {
        workerStarts += 1;
        return spawn(command, args, options);
      },
    });
    const start = (commandId: string): Record<string, unknown> => ({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-two-commands',
      startCommandId: commandId,
      sessionId: 'session-two-commands',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'only one of these may run',
    });
    try {
      // Together, or the test proves nothing: a second command that arrives after the
      // first has finished is an ordinary conflict on a running turn, not the race
      // this is about.
      const replies = await supervisorRequestsTogether(supervisor.socketPath, [
        start('start-two-commands-a'),
        start('start-two-commands-b'),
      ]);
      // Whichever reached `start()` first owns the turn; the other is told so rather
      // than being queued behind it or silently adopted onto it.
      expect(replies.filter((reply) => reply.ok === true)).toHaveLength(1);
      expect(replies.filter((reply) => reply.ok === false)).toEqual([
        expect.objectContaining({
          error: 'turn turn-two-commands is already starting under another command',
        }),
      ]);
      expect(workerStarts).toBe(1);
      const state = await readTurnState(runtimeDir, 'turn-two-commands');
      expect(state).toMatchObject({ status: 'running' });
      // And the winner is the one the Server was told about, not merely one of them.
      expect(replies.find((reply) => reply.ok === true)).toMatchObject({
        state: { startCommandId: (state as { startCommandId: string }).startCommandId },
      });
    } finally {
      await supervisor.close();
    }
  });

  // Overload has to be a refusal the Server can read, not a silence it has to time
  // out on — the failure mode this whole change exists to remove.
  it('refuses a start once the bounded start queue is full', async () => {
    const supervisor = await runSupervisor({
      runtimeDir,
      workerCommand: process.execPath,
      workerArgs: ['-e', "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      maxConcurrentStarts: 1,
      maxQueuedStarts: 1,
    });
    const start = (n: number): Record<string, unknown> => ({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: `turn-queue-${String(n)}`,
      startCommandId: `start-queue-${String(n)}`,
      sessionId: `session-queue-${String(n)}`,
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'queued',
      // Asking for the acknowledgement is what makes the ORDER observable below.
      startAck: true,
    });
    try {
      const frames = await supervisorRequestFramesTogether(
        supervisor.socketPath,
        Array.from({ length: 6 }, (_unused, n) => start(n)),
      );
      const replies = frames.map((lines) => lines.at(-1) ?? {});
      // Every one of the six is accounted for, in one of exactly two ways: there is no
      // third outcome — no silence, no other error, and no half-state where the Server
      // cannot tell whether a worker exists.
      const refused = replies.filter((reply) => reply.ok === false);
      const accepted = replies.filter((reply) => reply.ok === true);
      expect(refused.length + accepted.length).toBe(replies.length);
      // Bounded, and bounded on BOTH sides: the cap refuses work it cannot hold
      // without also refusing the work it can. A supervisor that answered all six
      // would not be bounded; one that answered none would be the wedge this replaces.
      // With all six in flight together the split is the configuration, not the host:
      // one slot plus one queue place is exactly two, and the remaining four bounce.
      // Admission is synchronous on frame arrival — `start()` queues or refuses before
      // it awaits anything — so no slot can be freed part-way through the burst.
      expect(accepted.length).toBe(2);
      expect(refused.length).toBe(4);
      for (const reply of refused) {
        expect(reply.error).toBe('runner supervisor start queue is full');
      }
      for (const reply of accepted) {
        expect(reply).toMatchObject({ outcome: 'created', state: { status: 'running' } });
      }
      // The ordering the Server's whole retry decision rests on: a full queue is
      // refused BEFORE the acknowledgement, never after it. The Server treats a
      // refusal it hears as decided — nothing spawned, safe to retry under the same
      // id — and reserves reconciliation and the cancel fence for answers it never
      // got. Were this refusal to arrive after `start-accepted`, that classification
      // would send a queued-then-refused start down the decided path and a worker
      // could be spawned with nobody tailing it. So: one frame for a refusal, two
      // for an acceptance, and every acknowledgement echoing its own request's ids.
      for (const lines of frames) {
        const isRefusal = lines.at(-1)?.ok === false;
        expect(lines).toHaveLength(isRefusal ? 1 : 2);
        if (isRefusal) continue;
        expect(lines[0]).toMatchObject({ ok: true, kind: 'start-accepted' });
      }
      for (const [n, lines] of frames.entries()) {
        if (lines.length < 2) continue;
        expect(lines[0]).toMatchObject({
          turnId: `turn-queue-${String(n)}`,
          startCommandId: `start-queue-${String(n)}`,
        });
      }
      // A refusal is a refusal: nothing was claimed, so the Server may safely start
      // that turn again later under the same id. An accepted one did claim, and its
      // worker is the reason the queue was full in the first place.
      for (const [n, reply] of replies.entries()) {
        const state = await readTurnState(runtimeDir, `turn-queue-${String(n)}`);
        if (reply.ok === false) expect(state).toBeUndefined();
        else expect(state).toMatchObject({ status: 'running', workerPid: expect.any(Number) });
      }
      // And the cap is a back-pressure signal, not a latch: once the burst has been
      // answered the supervisor takes work again, under a refused turn's own id.
      const readmitted = replies.findIndex((reply) => reply.ok === false);
      await expect(
        supervisorRequest(supervisor.socketPath, start(readmitted)),
      ).resolves.toMatchObject({ ok: true, outcome: 'created', state: { status: 'running' } });
    } finally {
      await supervisor.close();
    }
  });

  // Bounding the starts introduced a gap that did not exist when every start ran
  // immediately: a request can be accepted while the supervisor is healthy and reach
  // its slot after `close()` has begun. Spawning there leaves a worker behind that no
  // supervisor owns and no Server can settle — the orphan this whole change exists to
  // stop making.
  it('refuses a queued start that reaches its slot after shutdown began', async () => {
    const spawnedTurns: string[] = [];
    let shutdown: Promise<void> | undefined;
    // Annotated so the closure below may name it: `spawnWorker` only ever runs after
    // this has been assigned, but the inference would otherwise be circular.
    const supervisor: Awaited<ReturnType<typeof runSupervisor>> = await runSupervisor({
      runtimeDir,
      // A shell rather than a Node stand-in: six of these would cost more memory than
      // the sandbox has spare, and nothing here needs the worker to do anything.
      workerCommand: '/bin/sh',
      workerArgs: ['-c', 'sleep 5'],
      maxConcurrentStarts: 1,
      spawnWorker: (command, args, options) => {
        spawnedTurns.push(String(options.env?.VERITY_RUNNER_TURN_DIR));
        // Shutdown begins from inside the FIRST spawn, while this callback still
        // holds the only slot — so every other request is provably still waiting for
        // one. `close()` sets its flag synchronously and only then starts awaiting,
        // which is what makes the re-check the thing under test rather than a race.
        shutdown ??= supervisor.close();
        return spawn(command, args, options);
      },
    });
    const start = (n: number): Record<string, unknown> => ({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: `turn-shutdown-${String(n)}`,
      startCommandId: `start-shutdown-${String(n)}`,
      sessionId: `session-shutdown-${String(n)}`,
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'queued into a shutdown',
    });
    try {
      // Connected before any of them is written: `close()` stops the listener, so a
      // socket that only dials after the first spawn would be refused by the OS rather
      // than answered by the supervisor — a connection error, not the refusal under
      // test. Six live sockets first, then six frames, removes that race entirely.
      const replies = await supervisorRequestsTogether(
        supervisor.socketPath,
        Array.from({ length: 6 }, (_unused, n) => start(n)),
      );
      // One worker, not six. This is the property: the flag is re-read at the slot,
      // so a queue that was legal when it formed does not drain into a dying process.
      expect(spawnedTurns).toHaveLength(1);
      const refused = replies.filter((reply) => reply.ok === false);
      expect(refused).toHaveLength(5);
      for (const reply of refused) {
        expect(reply.error).toBe('runner supervisor is shutting down');
      }
      // And refused before the claim, not after: the re-check sits above `claimTurn`,
      // so a turn turned away here was never durably owned and the Server may start
      // it again — against the next supervisor — under the very same id.
      for (const [n, reply] of replies.entries()) {
        if (reply.ok === false) {
          expect(await readTurnState(runtimeDir, `turn-shutdown-${String(n)}`)).toBeUndefined();
        }
      }
    } finally {
      await shutdown;
      await supervisor.close();
    }
  });

  // A cancel is an operator action on a short control budget. It may wait for the one
  // start that could be mid-claim, and for nothing else — least of all for a queue of
  // unrelated spawns to drain, which is how bounding the starts could have turned
  // "stop this" into a second timeout.
  it('cancels a queued start without waiting for the queue to drain', async () => {
    const spawnedTurns: string[] = [];
    const supervisor = await runSupervisor({
      runtimeDir,
      // A shell rather than the usual Node stand-in: this test needs a deep queue,
      // and fifteen live Node processes cost more memory than the sandbox has spare.
      workerCommand: '/bin/sh',
      workerArgs: ['-c', 'sleep 3'],
      maxConcurrentStarts: 1,
      spawnWorker: (command, args, options) => {
        spawnedTurns.push(String(options.env?.VERITY_RUNNER_TURN_DIR));
        return spawn(command, args, options);
      },
    });
    const start = (n: number): Record<string, unknown> => ({
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: `turn-drain-${String(n)}`,
      startCommandId: `start-drain-${String(n)}`,
      sessionId: `session-drain-${String(n)}`,
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'queued behind others',
    });
    try {
      const starts = Array.from({ length: 16 }, (_unused, n) =>
        supervisorRequest(supervisor.socketPath, start(n)),
      );
      const last = 15;
      const cancelled = supervisorRequest(supervisor.socketPath, {
        protocolVersion: 1,
        kind: 'cancel-turn',
        turnId: `turn-drain-${String(last)}`,
      });
      // The property, not a timing preference: the cancel resolves while the start it
      // cancels is still queued behind fifteen others.
      await expect(
        Promise.race([cancelled.then(() => 'cancel'), starts[last]!.then(() => 'start')]),
      ).resolves.toBe('cancel');
      await expect(cancelled).resolves.toMatchObject({ ok: true, outcome: 'cancelled' });
      await Promise.all(starts);
      // And the durable tombstone still did its job: the queued start settled itself
      // when it was finally admitted, rather than spawning a worker after the cancel.
      expect(spawnedTurns).not.toContain(join(runtimeDir, 'turns', `turn-drain-${String(last)}`));
      expect(await readTurnState(runtimeDir, `turn-drain-${String(last)}`)).toMatchObject({
        status: 'settled',
      });
      // A cancel the operator asked for, reported as one: a settled turn with an
      // empty stream is a crash to the Server, so even the no-worker path owes it a
      // terminal frame.
      const frame = JSON.parse(
        await readFile(
          join(runtimeDir, 'turns', `turn-drain-${String(last)}`, 'events.jsonl'),
          'utf8',
        ),
      ) as { kind: string; result: { aborted: boolean } };
      expect(frame).toMatchObject({ kind: 'result', result: { aborted: true } });
    } finally {
      await supervisor.close();
    }
  });
});
