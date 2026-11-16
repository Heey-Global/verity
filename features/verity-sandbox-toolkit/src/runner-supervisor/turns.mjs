import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_CONCURRENT_STARTS,
  MAX_QUEUED_STARTS,
  REJECTED_WORKER_EXIT_WAIT_MS,
  SAFE_ID,
  WORKER_BACKENDS,
  WORKER_ERROR_DRAIN_TIMEOUT_MS,
  cancelExplainsSettlement,
  cancelPath,
  isObject,
  logTelemetry,
  readCancelTombstone,
  runTrustedCliViaBroker,
  sampleEventLoopDelay,
  writeSyntheticTerminalFrame,
} from './protocol.mjs';
import {
  acquireFileLock,
  activeCacheClaims,
  assertSpawnBoundary,
  boundedSpawnError,
  cacheClaimEpochs,
  cacheFinalAdmissions,
  cacheScans,
  claimTurn,
  createWorkerErrorCapture,
  describeSpawnFailure,
  isLockBusy,
  readTurnState,
  settleMissingWorkerTurn,
  spawnFailureDiagnostic,
  stdioWithWorkerLock,
  updateTurnState,
  validateStartTurnRequest,
  writeJsonAtomic,
} from './turn-state.mjs';
import { reclaimPackageCachesPage } from './requests.mjs';

export function createTurnStarter(runtimeDir, runnerInstanceId, options = {}) {
  const children = new Map();
  const settlements = new Set();
  const settlementsByTurn = new Map();
  const starts = new Set();
  const startsByTurn = new Map();
  const cancelledBeforeStart = new Set();
  const maxConcurrentStarts = options.maxConcurrentStarts ?? MAX_CONCURRENT_STARTS;
  const maxQueuedStarts = options.maxQueuedStarts ?? MAX_QUEUED_STARTS;
  /** Slot waiters, FIFO. */
  const queue = [];
  let running = 0;
  let closing = false;
  const spawnWorker =
    options.spawnWorker ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const workerCommand = options.workerCommand;
  const workerBackends = new Set(options.workerBackends ?? WORKER_BACKENDS);
  const adoptedTurnIsLive = async (turnId) => {
    if (options.adoptedTurns?.has(turnId) !== true) return false;
    let lock;
    try {
      lock = await acquireFileLock(join(runtimeDir, 'turns', turnId, 'worker.lock'));
      options.adoptedTurns.delete(turnId);
      await settleMissingWorkerTurn(runtimeDir, turnId);
      return false;
    } catch (error) {
      if (isLockBusy(error)) return true;
      throw error;
    } finally {
      await lock?.close();
    }
  };

  const terminate = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    child.kill('SIGTERM');
    const escalation = setTimeout(() => child.kill('SIGKILL'), options.shutdownGraceMs ?? 5_000);
    await exited;
    clearTimeout(escalation);
  };

  const startImpl = async (request) => {
    // Re-checked AFTER admission, not only at `start()`. Queueing put time between
    // the two: a start accepted while the supervisor was healthy can reach its slot
    // after `close()` has begun, and spawning a worker into a shutdown leaves one
    // behind that no supervisor owns.
    if (closing) throw new Error('runner supervisor is shutting down');
    if (typeof workerCommand !== 'string' || workerCommand.length === 0) {
      throw new Error('runner worker is not installed');
    }
    if (!workerBackends.has(request.backend)) {
      // Name the likely cause, not just the fact. The Server and this toolkit ship
      // and roll out separately, so the realistic way to reach this line is the
      // ordering constraint in ADR 0012 Amendment 4: a Server that already offers a
      // backend talking to a Sandbox whose image predates it, or was built without
      // that agent. The backend is real; this container does not have the adapter.
      // Listing what it does have turns an opaque refusal into "rebuild the image",
      // which is the actual fix and is not something the chat can otherwise deduce.
      // The list is `installedWorkerBackends()` in production, so it is what the
      // image carries rather than what this file was written knowing about.
      throw new Error(
        `worker does not support backend: ${request.backend} ` +
          `(this sandbox image provides ${[...workerBackends].sort().join(', ') || 'no agent adapter at all'}; ` +
          `a backend the server offers but this image lacks means the container predates it or was built without that agent, and needs rebuilding)`,
      );
    }
    const claim = await claimTurn(runtimeDir, request, runnerInstanceId);
    if (claim.outcome !== 'created') return claim;
    const turnDir = join(runtimeDir, 'turns', request.turnId);
    const cancelledInMemory = cancelledBeforeStart.delete(request.turnId);
    const tombstone = cancelledInMemory
      ? 'cancelled'
      : await readCancelTombstone(runtimeDir, request.turnId);
    if (tombstone !== 'absent') {
      // Settled without a worker ever existing — and still owed a terminal frame, or
      // the Server reads an empty stream behind a settled turn as a crash and badges
      // the operator's own cancel as a failure.
      //
      // Two different turns end here and they must not be given the same label. A
      // proven cancellation is the operator's own doing and is reported as `aborted`.
      // A tombstone that could not be READ stops the start for safety — running a turn
      // that was cancelled cannot be taken back — but it is a filesystem fault, and
      // telling the operator they cancelled a turn they did not is the same class of
      // lie `cancelExplainsSettlement` refuses to tell on the way out.
      const cancelled = tombstone === 'cancelled';
      await writeSyntheticTerminalFrame(turnDir, {
        turnId: request.turnId,
        runnerInstanceId,
        // The text is named explicitly because the signal alone would be a lie in the
        // frame's own words: with only `workerSignal` set the stderr line reads
        // "terminated by signal SIGTERM", and no process was terminated here — none
        // was started.
        //
        // And the signal itself is only carried for the cancelled half. SIGTERM
        // derives exit 143, which the Server reads as "the operator interrupted this"
        // (see `signalExitCode`) — true for a cancel, and the same false accusation as
        // `aborted` for a turn an unreadable tombstone stopped. That half reports an
        // ordinary failed start instead.
        ...(cancelled ? { workerSignal: 'SIGTERM' } : { workerExitCode: 1, workerSignal: null }),
        workerError: cancelled
          ? 'runner turn was cancelled before its worker started'
          : 'runner turn could not start: its cancellation record was unreadable',
        aborted: cancelled,
      }).catch(() => undefined);
      const state = await updateTurnState(runtimeDir, request.turnId, {
        status: 'settled',
        ...(cancelled
          ? { workerSignal: 'SIGTERM' }
          : {
              workerExitCode: 1,
              workerError: 'runner turn could not start: its cancellation record was unreadable',
            }),
      });
      return { outcome: 'terminal', state };
    }
    const requestPath = join(turnDir, 'request.json');
    const workerLockPath = join(turnDir, 'worker.lock');
    let child;
    let workerLock;
    let attestationTail = Promise.resolve();
    let workerErrorDone = Promise.resolve('');
    let exited = false;
    let resolveExit;
    const exitInfo = new Promise((resolve) => {
      resolveExit = resolve;
    });
    try {
      // The request is a one-worker capability channel. It must not be writable by
      // the shared runtime group after validation: the worker opens this inode once,
      // verifies its ownership/mode, and unlinks it before parsing.
      await writeJsonAtomic(requestPath, request, 0o600);
      // The worker securely consumes and unlinks request.json before parsing it. Keep
      // only the non-secret trusted-CLI capability beside the durable turn state so a
      // later tool call (and a replacement supervisor adopting this worker) never
      // depends on that one-use request pathname still existing.
      await updateTurnState(runtimeDir, request.turnId, {
        workerLock: true,
        ...(request.trustedCliExecution === true
          ? { trustedCliExecution: true, cwd: request.cwd }
          : {}),
      });
      workerLock = await acquireFileLock(workerLockPath);
      await assertSpawnBoundary(
        request,
        workerCommand,
        options.workerEnv?.PATH ?? process.env.PATH,
      );
      child = spawnWorker(workerCommand, [...(options.workerArgs ?? []), requestPath], {
        cwd: request.cwd,
        stdio: stdioWithWorkerLock(workerLock.fd),
        env: {
          PATH: process.env.PATH,
          ...(options.workerEnv ?? {}),
          VERITY_RUNNER_TURN_DIR: turnDir,
          VERITY_RUNNER_EVENT_FILE: join(turnDir, 'events.jsonl'),
          VERITY_RUNNER_CONTROL_SOCKET: join(turnDir, 'control.sock'),
        },
      });
      if (child.stdout === null || child.stdout === undefined) {
        throw new Error('runner worker has no private attestation pipe');
      }
      if (child.stdin === null || child.stdin === undefined) {
        throw new Error('runner worker has no private attestation acknowledgement pipe');
      }
      if (child.stderr === null || child.stderr === undefined) {
        throw new Error('runner worker has no private error pipe');
      }
      const workerErrorCapture = createWorkerErrorCapture();
      let resolveWorkerError;
      let workerErrorSettled = false;
      const settleWorkerError = () => {
        if (workerErrorSettled) return;
        workerErrorSettled = true;
        resolveWorkerError(workerErrorCapture.finish());
      };
      child.stderr.on('data', (chunk) => workerErrorCapture.push(chunk));
      workerErrorDone = new Promise((resolveError) => {
        resolveWorkerError = resolveError;
        child.stderr.once('end', settleWorkerError);
      });
      child.once('exit', (code, signal) => {
        exited = true;
        children.delete(request.turnId);
        setTimeout(settleWorkerError, WORKER_ERROR_DRAIN_TIMEOUT_MS);
        resolveExit({ code, signal });
      });
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once('spawn', resolveSpawn);
        child.once('error', rejectSpawn);
      });
    } catch (error) {
      const workerSpawnFailure = spawnFailureDiagnostic(error, request, workerCommand);
      const workerError = describeSpawnFailure(
        boundedSpawnError(error instanceof Error ? error.message : String(error)),
        workerSpawnFailure,
      );
      logTelemetry({
        event: 'worker-spawn-failed',
        turnId: request.turnId,
        sessionId: request.sessionId,
        ...workerSpawnFailure,
      });
      // The frame below declares this turn dead, so nothing may still be alive under
      // it. Reaching here with a live child is not the ordinary `spawn`-failed case
      // — that child has no pid at all — but the guards above can also reject a
      // process that DID start, and a synthetic terminal frame over a running agent
      // is worse than the failure it reports. The signal goes to the pid alone, which
      // is all `terminate()` does too — the worker is spawned attached, in this
      // supervisor's own process group, so there is no group to signal and no
      // detached descendant this could miss that `terminate()` would catch.
      // `terminate()` itself is deliberately not used: it awaits an `exit` that never
      // arrives for a child which failed to spawn.
      //
      // Before the lock is dropped, not after, and not merely signalled before it: the
      // worker lock IS the liveness signal recovery reads (`adoptedTurnIsLive`), so a
      // lock released while a rejected child is still dying lets a concurrent probe
      // find it free, call the worker missing and settle a turn that is very much
      // alive. SIGKILL cannot be refused, so the wait is short and bounded — and
      // bounded rather than open-ended because a turn that cannot be ended must still
      // be reported.
      // A child that never got a pid cannot write anything, so there is nothing to
      // outlive the frame below. Any other case has to be PROVED dead.
      let reaped = child?.pid === undefined;
      if (!reaped) {
        child.kill('SIGKILL');
        if (!exited) {
          await Promise.race([
            exitInfo,
            new Promise((resolve) => setTimeout(resolve, REJECTED_WORKER_EXIT_WAIT_MS).unref?.()),
          ]);
        }
        // Set synchronously by the `exit` handler, so it distinguishes which side of
        // the race won: `exitInfo` means reaped, the timer means still there.
        reaped = exited;
      }
      await workerLock?.close().catch(() => undefined);
      // Same reasoning as the exit path: a turn that settles must leave the Server a
      // terminal frame to settle FROM, or the session badges `running` forever. And
      // the same reasoning for `aborted`: a cancel that lands while the spawn is
      // failing is still a cancel, so read the durable tombstone rather than let the
      // race decide whether the operator sees a crash. That read cannot throw here —
      // see {@link readCancelTombstone} — because everything below it is what settles
      // the turn.
      //
      // Only over a child PROVED dead, though. SIGKILL cannot be refused but it can
      // be outwaited — a process wedged in uninterruptible sleep is exactly the case
      // the bound above accepts — and a worker that comes back after this frame owns
      // `frameSeq` 1 too. Its first frame would then collide with a fabricated
      // terminal one carrying a different payload hash, and a stream the Store
      // refuses to ingest is worse than the missing frame this writes: the state
      // below still carries the exit reason, so the Server reports
      // `worker-exited-early` with the captured stderr rather than the bare "exited
      // with code 1" this path exists to replace.
      if (reaped) {
        await writeSyntheticTerminalFrame(turnDir, {
          turnId: request.turnId,
          runnerInstanceId,
          workerExitCode: 1,
          workerSignal: null,
          workerError,
          aborted: await cancelExplainsSettlement(runtimeDir, request.turnId),
        }).catch(() => undefined);
      }
      await updateTurnState(runtimeDir, request.turnId, {
        status: 'settled',
        ...(workerError.length > 0 ? { workerError } : {}),
        workerSpawnFailure,
      });
      // eslint-disable-next-line preserve-caught-error -- raw spawn exceptions may contain credentials.
      throw new Error(workerError);
    }
    // INVARIANT from here down: no throw may escape this function while the child is
    // alive. The Server treats a refusal it HEARS as decided — no reconciliation, no
    // cancel fence — so a spoken failure over a running worker is precisely the orphan
    // this file exists to prevent. Everything between here and the guarded block below
    // is therefore synchronous and non-throwing; the one thing that can fail, the
    // `running` state write, is awaited inside it and answered by `terminate(child)`.
    if (!exited) children.set(request.turnId, child);
    const runningState = updateTurnState(runtimeDir, request.turnId, {
      status: 'running',
      workerPid: child.pid,
    });
    const settlement = exitInfo
      .then(async ({ code, signal }) => {
        await runningState.catch(() => undefined);
        await attestationTail;
        const workerError = await workerErrorDone;
        // Before the state says "settled", make sure the STREAM says why. A worker
        // that exited without writing a single frame leaves the Server a turn that
        // ended and nothing to end it with; this is the only place that still holds
        // the exit code, the signal and the captured stderr.
        // The same predicate the other two callers use — one question, one spelling,
        // so a tombstone that stops counting as one cannot start counting here.
        const aborted = await cancelExplainsSettlement(runtimeDir, request.turnId);
        const wrote = await writeSyntheticTerminalFrame(turnDir, {
          turnId: request.turnId,
          runnerInstanceId,
          workerExitCode: code,
          workerSignal: signal,
          workerError,
          aborted,
        }).catch(() => false);
        if (wrote) {
          logTelemetry({
            event: 'worker-exited-without-events',
            turnId: request.turnId,
            exitCode: code,
            signal,
          });
        }
        return await updateTurnState(runtimeDir, request.turnId, {
          status: 'settled',
          workerExitCode: code,
          workerSignal: signal,
          ...(code !== 0 || signal !== null ? (workerError.length > 0 ? { workerError } : {}) : {}),
        });
      })
      .catch(() => undefined);
    settlements.add(settlement);
    settlementsByTurn.set(request.turnId, settlement);
    void settlement.finally(() => {
      settlements.delete(settlement);
      if (settlementsByTurn.get(request.turnId) === settlement) {
        settlementsByTurn.delete(request.turnId);
      }
    });
    let state;
    try {
      state = await runningState;
      await workerLock.close();
    } catch (error) {
      await terminate(child);
      await workerLock.close().catch(() => undefined);
      await settlement;
      throw error;
    }
    return { outcome: 'created', state };
  };

  /**
   * Admit one start into the bounded worker-spawn pool.
   *
   * Everything a start does is expensive and contended — fsyncs, a `flock` fork,
   * the worker fork — so an unbounded burst does not go faster, it goes slower for
   * everyone and makes each individual start look wedged. Queueing makes the wait a
   * number (`queueMs`) rather than a mystery, and the cap makes overload a refusal
   * the Server can show rather than a timeout it has to interpret.
   */
  const admit = (run) => {
    let slot;
    if (running >= maxConcurrentStarts) {
      if (queue.length >= maxQueuedStarts) {
        throw new Error('runner supervisor start queue is full');
      }
      slot = new Promise((resolveSlot) => queue.push(resolveSlot));
    } else {
      // Reserve synchronously. `start()` acknowledges immediately after `admit`
      // returns, so deferring this increment to a promise microtask would let a
      // same-tick burst observe stale capacity and over-admit every request.
      running += 1;
      slot = Promise.resolve();
    }
    return slot.then(async () => {
      try {
        return await run();
      } finally {
        const next = queue.shift();
        if (next === undefined) running -= 1;
        else next(); // Transfer this reserved slot directly to the oldest waiter.
      }
    });
  };

  /**
   * Accept a start-turn.
   *
   * Returns `{ accepted, pending }`: `accepted` is settled the moment the request is
   * VALID and queued, which is what the Server acknowledges on, while `pending`
   * carries the real outcome. Splitting the two is what lets a start take as long as
   * it honestly takes without the Server having to choose between a short budget
   * that abandons live turns and a long one that hides a wedged supervisor.
   *
   * A start for a turn that already has one in flight returns THAT promise rather
   * than chaining a second `startImpl`. The chained version was idempotent only by
   * grace of `claimTurn` refusing the duplicate afterwards; collapsing here means a
   * retried start does no work at all, and — with `cancel` still awaiting the single
   * per-turn promise — a retry storm can neither queue behind itself nor outrun the
   * cancel that is waiting for it.
   */
  const start = (rawRequest) => {
    if (closing) throw new Error('runner supervisor is shutting down');
    const request = validateStartTurnRequest(rawRequest);
    const previous = startsByTurn.get(request.turnId);
    // Only a retry of the SAME start command is the same work. A different command
    // for an in-flight turn is rejected synchronously: queueing conflicts would let
    // an unbounded flood bypass the global queue cap by chaining on one turn.
    if (previous !== undefined && previous.startCommandId === request.startCommandId) {
      // Once per turn, not once per retry: a Server that re-sends in a loop would
      // otherwise write the supervisor's own stderr full of the fact that it is
      // being retried, which is the least useful line to lose the real ones behind.
      if (!previous.loggedDeduplication) {
        previous.loggedDeduplication = true;
        logTelemetry({ event: 'start-deduplicated', turnId: request.turnId });
      }
      return { accepted: true, pending: previous.promise };
    }
    if (previous !== undefined) {
      throw new Error(`turn ${request.turnId} is already starting under another command`);
    }
    const queuedAt = Date.now();
    // `admit` reserves capacity or throws BEFORE this function returns. Therefore a
    // start acknowledgement means exactly what it says: the request owns a running
    // slot or a bounded queue slot, never a promise that may later reject as full.
    // Note the order with the dedup above: a retry of a start that is still queued
    // is answered from `startsByTurn` and never reaches `admit`, so a Server that
    // re-sends a lost start can never be told the queue is full while its original
    // is sitting in that very queue.
    const entry = { promise: undefined, startCommandId: request.startCommandId };
    const promise = admit(async () => {
      const startedAt = Date.now();
      entry.admitted = true;
      try {
        return await startImpl(request);
      } finally {
        // A `finally` around a value the caller is about to receive: anything thrown
        // here would REPLACE a successful start with a spoken failure, over a worker
        // that is already running — the same orphan `startImpl`'s post-spawn invariant
        // rules out. Both calls below swallow their own errors for that reason, and
        // any line added here must too.
        logTelemetry({
          event: 'start',
          turnId: request.turnId,
          backend: request.backend,
          sessionId: request.sessionId,
          gatewayTokenPresent: request.mcpGatewayToken !== undefined,
          gatewayUrlPresent:
            typeof options.workerEnv?.VERITY_MCP_GATEWAY_URL === 'string' &&
            options.workerEnv.VERITY_MCP_GATEWAY_URL !== '',
          configuredMcpServers: request.mcpServers?.length ?? 0,
          queueMs: startedAt - queuedAt,
          startMs: Date.now() - startedAt,
          // Read in `run()`'s `finally`, BEFORE the slot is handed on, so this start
          // is still counted in `activeStarts` and its own record includes itself.
          // The Server-side `SupervisorStartTelemetry.activeStarts` excludes the
          // start it describes: same name, one more here, and this is the stream
          // where "how many were running while this one waited" is the question.
          queuedStarts: queue.length,
          activeStarts: running,
          activeWorkers: children.size,
          eventLoopDelayMs: sampleEventLoopDelay(),
        });
      }
    });
    entry.promise = promise;
    starts.add(promise);
    startsByTurn.set(request.turnId, entry);
    void promise
      .finally(() => {
        starts.delete(promise);
        if (startsByTurn.get(request.turnId) === entry) startsByTurn.delete(request.turnId);
      })
      .catch(() => undefined);
    return { accepted: true, pending: promise };
  };

  const cancel = async (turnId) => {
    if (typeof turnId !== 'string' || !SAFE_ID.test(turnId)) throw new Error('invalid turnId');
    // Register before the first await. A concurrent start either observes this
    // after its claim or is included in `startsByTurn` and awaited below.
    cancelledBeforeStart.add(turnId);
    await mkdir(join(runtimeDir, 'cancellations'), { recursive: true, mode: 0o770 });
    await writeJsonAtomic(cancelPath(runtimeDir, turnId), {
      protocolVersion: 1,
      turnId,
      cancelledAt: Date.now(),
    });
    // A cancel can arrive after the durable claim but before the worker is entered
    // in `children`. Wait only for this turn's in-flight start to cross that seam —
    // and only if it is ADMITTED. A start still waiting for a slot has written
    // nothing and settles itself against the tombstone above the moment it is
    // admitted, so waiting for it would put the operator's cancel behind the whole
    // queue of unrelated spawns and blow the Server's control-request budget.
    const inFlight = startsByTurn.get(turnId);
    if (inFlight?.admitted === true) await inFlight.promise.catch(() => undefined);
    const currentState = await readTurnState(runtimeDir, turnId);
    if (currentState === undefined) {
      // A start request on another socket may not have reached `claimTurn` yet.
      // Persist the intent in memory so that this supervisor settles the turn
      // immediately if that start arrives after the cancel request.
      return { outcome: 'cancelled' };
    }
    if (currentState.status === 'settled') {
      cancelledBeforeStart.delete(turnId);
      return { outcome: 'terminal', state: currentState };
    }
    const child = children.get(turnId);
    if (child === undefined) {
      // A worker owned by a previous supervisor instance cannot be addressed by
      // this process without risking PID reuse. Recovery will settle it once its
      // durable worker lock disappears.
      throw new Error('runner worker is not owned by this supervisor');
    }
    try {
      await terminate(child);
      await settlementsByTurn.get(turnId);
      return { outcome: 'cancelled', state: await readTurnState(runtimeDir, turnId) };
    } finally {
      // Keep the capability revoked throughout the SIGTERM/SIGKILL grace window.
      cancelledBeforeStart.delete(turnId);
    }
  };

  return {
    start,
    cancel,
    // A persisted running flag and a stale socket inode are not proof of life.
    // Only this supervisor's child or a worker adopted under its liveness lock is.
    workerStatus(turnId) {
      return children.has(turnId) || options.adoptedTurns?.has(turnId) === true
        ? 'live'
        : 'uncertain';
    },
    runTrustedCli(request, onSpawned, outputOptions = {}) {
      return runTrustedCliViaBroker(request, {
        runtimeDir,
        ...outputOptions,
        ...(options.brokerSocket === undefined ? {} : { brokerSocket: options.brokerSocket }),
        ...(onSpawned === undefined ? {} : { onSpawned }),
        authorize: async ({ turnId }) =>
          !cancelledBeforeStart.has(turnId) &&
          (children.has(turnId) || (await adoptedTurnIsLive(turnId))),
      });
    },
    async close() {
      closing = true;
      await Promise.allSettled([...starts]);
      await Promise.all([...children.values()].map(terminate));
      await Promise.all([...settlements]);
    },
  };
}

export function createTurnAdopter(runtimeDir, options = {}) {
  const pollMs = options.adoptionPollMs ?? 250;
  const adopted = options.adoptedTurns ?? new Set();
  let timer;
  let closed = false;
  let polling = false;

  // `claim` pins a retried probe to the claim it was undecided about. Nothing removes
  // turn directories today, but if one were removed and the id claimed afresh, that
  // new claim would be this supervisor's own, and settling or adopting it here would
  // end a turn whose worker has simply not taken its lock yet. Rechecked once the lock
  // is held (or found busy) to narrow that window, not to close it: a recreated
  // directory has a different lock file than the one held here.
  const probe = async (turnId, initial, claim) => {
    const lockPath = join(runtimeDir, 'turns', turnId, 'worker.lock');
    const isOtherClaim = async () => {
      if (claim === undefined) return false;
      const state = await readTurnState(runtimeDir, turnId);
      return state !== undefined && !sameClaim(state, claim);
    };
    let lock;
    try {
      lock = await acquireFileLock(lockPath);
    } catch (error) {
      if (!isLockBusy(error)) return 'uncertain';
      if (await isOtherClaim()) return 'gone';
      if (initial) {
        const state = await readTurnState(runtimeDir, turnId);
        if (state?.status === 'claimed') {
          await updateTurnState(runtimeDir, turnId, {
            status: 'running',
            adoptedAt: Date.now(),
          }).catch(() => undefined);
        }
      }
      return 'live';
    }
    try {
      if (await isOtherClaim()) return 'gone';
      try {
        await settleMissingWorkerTurn(runtimeDir, turnId);
      } catch {
        return 'uncertain';
      }
      return 'dead';
    } finally {
      await lock.close();
    }
  };

  // Turns whose boot-time probe could not decide. Kept apart from `adopted`, which
  // authorizes control over a LIVE worker: an undecided turn must not gain that, but it
  // must not be dropped either. Dropping it left its state `running` with a stale
  // `control.sock` beside it after a whole-Sandbox kill — which the Server reads as a
  // live Runner, so the turn badged `running` with nothing left to ever settle it.
  // Retried on a slower cadence than the adopted poll: each probe forks a `flock`, and
  // what keeps a turn undecided (a corrupt state file) can persist indefinitely.
  const unresolved = new Map();
  const unresolvedRetryMs = options.unresolvedRetryMs ?? 5000;
  let nextUnresolvedAt = 0;
  const exists = (turnId) =>
    lstat(join(runtimeDir, 'turns', turnId)).then(
      () => true,
      (error) => error?.code !== 'ENOENT',
    );

  const schedule = () => {
    if (closed || (adopted.size === 0 && unresolved.size === 0) || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, pollMs);
    timer.unref?.();
  };

  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      for (const turnId of [...adopted]) {
        const disposition = await probe(turnId, false).catch(() => 'uncertain');
        if (disposition === 'dead') adopted.delete(turnId);
      }
      const retryUnresolved = Date.now() >= nextUnresolvedAt;
      if (retryUnresolved) nextUnresolvedAt = Date.now() + unresolvedRetryMs;
      // Boot-mode probes stay safe after boot: every unresolved turn was claimed under
      // an earlier supervisor's `runnerInstanceId`, so `claimTurn` answers a retried
      // start for it as a runner-instance mismatch — this supervisor never launches a
      // worker for it, and no fresh claim can be caught before its worker lock.
      for (const turnId of retryUnresolved ? [...unresolved.keys()] : []) {
        if (closed) break;
        // Something else may have finished the turn meanwhile, or its directory may be
        // gone. A missing lock never opens again, so probing alone would keep the
        // turn here for the life of this supervisor.
        const claim = unresolved.get(turnId);
        const current = await readTurnState(runtimeDir, turnId).catch(() => null);
        const finished =
          current === undefined
            ? !(await exists(turnId))
            : current !== null && (current.status === 'settled' || !sameClaim(current, claim));
        if (finished) {
          unresolved.delete(turnId);
          continue;
        }
        const disposition = await probe(turnId, true, claim).catch(() => 'uncertain');
        if (disposition === 'uncertain') continue;
        unresolved.delete(turnId);
        if (disposition === 'live') adopted.add(turnId);
      }
    } finally {
      polling = false;
      schedule();
    }
  };

  return {
    async adopt() {
      for (const state of await listTurns(runtimeDir)) {
        if (state.status !== 'claimed' && state.status !== 'running') continue;
        // Turns created before worker-lock adoption shipped have no authoritative
        // liveness lock. Never infer death from its absence during a rolling deploy.
        if (state.workerLock !== true) continue;
        const disposition = await probe(state.turnId, true).catch(() => 'uncertain');
        if (disposition === 'live') adopted.add(state.turnId);
        else if (disposition === 'uncertain') {
          unresolved.set(state.turnId, {
            runnerInstanceId: state.runnerInstanceId,
            startCommandId: state.startCommandId,
          });
        }
      }
      schedule();
    },
    async close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      while (polling) await new Promise((resolvePoll) => setTimeout(resolvePoll, 1));
      adopted.clear();
      unresolved.clear();
    },
  };
}

function sameClaim(state, claim) {
  return (
    state != null &&
    state.runnerInstanceId === claim.runnerInstanceId &&
    state.startCommandId === claim.startCommandId
  );
}

/** Turn states read at once. A project keeps every turn directory, so a scan
 *  reads thousands of small files; inside the Sandbox each read is a round trip
 *  through the runtime, and reading them one after another made a scan take
 *  longer than the requests that perform it may wait. */
const TURN_SCAN_CONCURRENCY = 16;

export async function listTurns(runtimeDir) {
  const turnsDir = join(runtimeDir, 'turns');
  const entries = await readdir(turnsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const names = entries
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map((entry) => entry.name);
  const states = new Array(names.length);
  let next = 0;
  const readNext = async () => {
    for (let index = next++; index < names.length; index = next++) {
      const turnId = names[index];
      try {
        const state = await readTurnState(runtimeDir, turnId);
        states[index] = state ?? { turnId, status: 'ambiguous', reason: 'missing-state' };
      } catch {
        // Discovery fails closed per D3: a corrupt directory remains visible and
        // can never be mistaken for an absent turn that is safe to launch again.
        states[index] = { turnId, status: 'ambiguous', reason: 'invalid-state' };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TURN_SCAN_CONCURRENCY, names.length) }, readNext),
  );
  return states.sort((a, b) => String(a.turnId).localeCompare(String(b.turnId)));
}

export function responseForError(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(isObject(error?.runnerCacheFailure)
      ? { runnerCacheFailure: error.runnerCacheFailure }
      : {}),
    ...(isObject(error?.trustedCliFailure) ? { trustedCliFailure: error.trustedCliFailure } : {}),
  };
}

export async function sessionHomeRequest(kind, sessionId, migration = {}) {
  if (!SAFE_ID.test(sessionId ?? '')) throw new Error('invalid sessionId');
  return await brokerStorageRequest({
    protocolVersion: 1,
    kind,
    sessionId,
    legacyBackend: migration.legacyBackend,
    legacySessionId: migration.legacySessionId,
  });
}

export async function brokerStorageRequest(request) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(
      process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET ??
        '/run/verity-runner-broker/agent-spawn-broker.sock',
    );
    let buffered = '';
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response ?? { ok: true });
    };
    socket.setTimeout(30000, () => finish(new Error('runner storage request timed out')));
    socket.once('error', finish);
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => {
      buffered += chunk.toString();
      if (Buffer.byteLength(buffered, 'utf8') > 65536)
        return finish(
          Object.assign(new Error('runner storage response too large'), {
            code: 'ERR_INVALID_RUNNER_STORAGE_RESPONSE',
          }),
        );
      if (!buffered.includes('\n')) return;
      try {
        const response = JSON.parse(buffered.split('\n')[0]);
        if (!isObject(response) || typeof response.ok !== 'boolean')
          throw Object.assign(new Error('invalid runner storage response'), {
            code: 'ERR_INVALID_RUNNER_STORAGE_RESPONSE',
          });
        finish(
          response.ok === true
            ? undefined
            : new Error(response.error ?? 'session home request failed'),
          response,
        );
      } catch (error) {
        finish(error);
      }
    });
    socket.once('close', () => finish(new Error('session home broker closed before response')));
  });
}

export const CACHE_SCAN_PAGE = 256;
export const CACHE_SCAN_TTL_MS = 5 * 60_000;
const cacheMaintenanceFlights = new Map();

export function cacheMaintenanceFailure(code) {
  return Object.assign(new Error('Runner cache maintenance inventory is unavailable'), {
    runnerCacheFailure: { code },
  });
}

export async function closeCacheScan(runtimeDir, scan) {
  if (cacheScans.get(runtimeDir) === scan) cacheScans.delete(runtimeDir);
  clearTimeout(scan.timer);
  await scan.directory?.close().catch(() => undefined);
}

export async function cacheTurnSummary(runtimeDir, turnId) {
  try {
    const state = await readTurnState(runtimeDir, turnId);
    if (state === undefined) return { turnId, status: 'ambiguous', reason: 'missing-state' };
    return {
      turnId,
      status: state.status,
      startCommandId: state.startCommandId,
      runnerInstanceId: state.runnerInstanceId,
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    };
  } catch {
    return { turnId, status: 'ambiguous', reason: 'invalid-state' };
  }
}

/** Scanning never grants deletion until every page has been classified. */
export function reclaimPackageCachesPaged(runtimeDir, request) {
  const previous = cacheMaintenanceFlights.get(runtimeDir) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => reclaimPackageCachesPage(runtimeDir, request));
  cacheMaintenanceFlights.set(runtimeDir, current);
  void current
    .finally(() => {
      if (cacheMaintenanceFlights.get(runtimeDir) === current)
        cacheMaintenanceFlights.delete(runtimeDir);
    })
    .catch(() => undefined);
  return current;
}

export async function withFinalCacheAdmission(runtimeDir, scan, run) {
  if (activeCacheClaims.has(runtimeDir) || scan.epoch !== (cacheClaimEpochs.get(runtimeDir) ?? 0))
    throw cacheMaintenanceFailure('turn-inventory-unavailable');
  let release;
  const barrier = new Promise((resolveBarrier) => {
    release = resolveBarrier;
  });
  cacheFinalAdmissions.set(runtimeDir, barrier);
  try {
    return await run();
  } finally {
    if (cacheFinalAdmissions.get(runtimeDir) === barrier) cacheFinalAdmissions.delete(runtimeDir);
    release();
  }
}
