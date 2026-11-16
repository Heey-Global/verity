import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { chmod, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import {
  DEFAULT_RUNTIME_DIR,
  DEFAULT_SCRIPT_SANDBOX_PATH,
  MAX_CONTROL_LINE_BYTES,
  OVERSIZE_DRAIN_GRACE_MS,
  SAFE_ID,
  SCRIPT_ISOLATION_UNAVAILABLE_ERROR,
  SUPERVISOR_PROTOCOL_VERSION,
  installedSkillsManifestHash,
  isObject,
  probeScriptSandbox,
  sampleEventLoopDelay,
  supportedRequestVersion,
} from './protocol.mjs';
import {
  acquireSingleton,
  cacheClaimEpochs,
  cacheScans,
  claimTurn,
  readTurnState,
  supervisorRequestTimeoutMs,
  validateRuntimeDirectory,
  writeJsonAtomic,
} from './turn-state.mjs';
import {
  CACHE_SCAN_PAGE,
  CACHE_SCAN_TTL_MS,
  brokerStorageRequest,
  cacheMaintenanceFailure,
  cacheTurnSummary,
  closeCacheScan,
  createTurnAdopter,
  createTurnStarter,
  listTurns,
  reclaimPackageCachesPaged,
  responseForError,
  sessionHomeRequest,
  withFinalCacheAdmission,
} from './turns.mjs';

export async function reclaimPackageCachesPage(runtimeDir, request) {
  const fingerprint = JSON.stringify([request.sessionIds, request.maxBytes]);
  let scan = cacheScans.get(runtimeDir);
  if (request.scanId === undefined) {
    if (scan) await closeCacheScan(runtimeDir, scan);
    const directory = await opendir(join(runtimeDir, 'turns')).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw cacheMaintenanceFailure('turn-inventory-unavailable');
    });
    scan = {
      id: randomUUID(),
      fingerprint,
      directory,
      cursor: 0,
      epoch: cacheClaimEpochs.get(runtimeDir) ?? 0,
      busy: new Set(),
      pending: [],
      counts: { missingState: 0, invalidState: 0, unsettledWithoutSession: 0 },
    };
    scan.timer = setTimeout(() => {
      void closeCacheScan(runtimeDir, scan);
    }, CACHE_SCAN_TTL_MS);
    scan.timer.unref?.();
    cacheScans.set(runtimeDir, scan);
  } else if (!scan || scan.id !== request.scanId || scan.fingerprint !== fingerprint) {
    throw cacheMaintenanceFailure('turn-inventory-unavailable');
  }
  try {
    scan.timer.refresh(); // Expire abandoned scans, not an inventory making bounded progress.
    if (scan.epoch !== (cacheClaimEpochs.get(runtimeDir) ?? 0))
      throw cacheMaintenanceFailure('turn-inventory-unavailable');
    if (request.scanId !== undefined) {
      if (!Array.isArray(request.turnOwners) || request.turnOwners.length > CACHE_SCAN_PAGE)
        throw new Error('invalid turn ownership response');
      const pending = new Map(scan.pending.map((turn) => [turn.turnId, turn]));
      const owners = new Map();
      for (const owner of request.turnOwners) {
        if (
          !isObject(owner) ||
          !pending.has(owner.turnId) ||
          owners.has(owner.turnId) ||
          typeof owner.conflict !== 'boolean' ||
          (owner.sessionId !== undefined &&
            (typeof owner.sessionId !== 'string' || !SAFE_ID.test(owner.sessionId)))
        )
          throw new Error('invalid turn ownership response');
        owners.set(owner.turnId, owner);
      }
      for (const prior of scan.pending) {
        const current = await cacheTurnSummary(runtimeDir, prior.turnId);
        // An identity changed while the Server resolved a page: start a fresh scan.
        if (
          current.startCommandId !== prior.startCommandId ||
          current.runnerInstanceId !== prior.runnerInstanceId
        )
          throw cacheMaintenanceFailure('turn-inventory-unavailable');
        if (current.status === 'settled') continue;
        const owner = owners.get(prior.turnId);
        const sessionId = owner?.conflict ? undefined : owner?.sessionId;
        if (
          sessionId !== undefined &&
          (current.sessionId === undefined || current.sessionId === sessionId)
        ) {
          if (request.sessionIds.includes(sessionId)) scan.busy.add(sessionId);
        } else {
          const key =
            current.reason === 'missing-state'
              ? 'missingState'
              : current.reason === 'invalid-state'
                ? 'invalidState'
                : 'unsettledWithoutSession';
          scan.counts[key] = Math.min(1_000_000, scan.counts[key] + 1);
        }
      }
      scan.pending = [];
    }
    let done = scan.directory === undefined;
    for (
      let inspected = 0;
      !done && inspected < CACHE_SCAN_PAGE && scan.pending.length < 64;
      inspected++
    ) {
      const entry = await scan.directory.read();
      if (entry === null) {
        done = true;
        break;
      }
      scan.cursor++;
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const turn = await cacheTurnSummary(runtimeDir, entry.name);
      if (turn.status === 'settled') continue;
      if (turn.sessionId !== undefined) {
        if (request.sessionIds.includes(turn.sessionId)) scan.busy.add(turn.sessionId);
      } else scan.pending.push(turn);
    }
    if (!done || scan.pending.length > 0) {
      return {
        ok: true,
        maintenancePending: true,
        scanId: scan.id,
        cursor: String(scan.cursor),
        turnsNeedingOwnership: scan.pending,
      };
    }
    if (scan.epoch !== (cacheClaimEpochs.get(runtimeDir) ?? 0))
      throw cacheMaintenanceFailure('turn-inventory-unavailable');
    const unknown = Object.values(scan.counts).some((count) => count > 0);
    let response;
    try {
      response = await withFinalCacheAdmission(runtimeDir, scan, async () => {
        const capabilities = await brokerStorageRequest({ protocolVersion: 1, kind: 'status' });
        if (
          capabilities.cacheMaintenanceVersion !== 2 ||
          capabilities.runtimeAdmissionFenceVersion !== 1
        )
          throw cacheMaintenanceFailure('unsupported');
        return await brokerStorageRequest({
          protocolVersion: 1,
          kind: 'reclaim-package-caches',
          sessionIds: unknown ? [] : request.sessionIds.filter((id) => !scan.busy.has(id)),
          maxBytes: request.maxBytes,
        });
      });
    } catch (error) {
      if (error?.runnerCacheFailure) throw error;
      const code = ['EACCES', 'EPERM'].includes(error?.code)
        ? 'broker-access-denied'
        : ['ENOENT', 'ECONNREFUSED'].includes(error?.code)
          ? 'broker-unavailable'
          : error?.message === 'runner storage request timed out'
            ? 'broker-timeout'
            : error instanceof SyntaxError || error?.code === 'ERR_INVALID_RUNNER_STORAGE_RESPONSE'
              ? 'broker-invalid-response'
              : 'broker-rejected';
      throw cacheMaintenanceFailure(code);
    }
    if (response.report && (unknown || scan.busy.size > 0)) {
      response.report.usageComplete = false;
      response.report.legacyBytes = null;
      response.report.turnOwnershipCounts = scan.counts;
      response.report.blockers = [
        ...(response.report.blockers ?? []).slice(0, 99),
        unknown
          ? 'Runner turn ownership is unknown; legacy package caches were retained'
          : 'Runner sessions have unsettled turns; their legacy package caches were retained',
      ];
    }
    await closeCacheScan(runtimeDir, scan);
    return response;
  } catch (error) {
    await closeCacheScan(runtimeDir, scan);
    throw error;
  }
}

export async function handleSupervisorRequest(
  runtimeDir,
  runnerInstanceId,
  request,
  turnStarter,
  onTrustedCliStarted,
  onStartAccepted,
  capabilities = { scriptIsolation: true },
  outputOptions = {},
) {
  if (!isObject(request) || !supportedRequestVersion(request.protocolVersion)) {
    throw new Error('unsupported supervisor protocol');
  }
  const skillsManifestHash =
    request.kind === 'status' ? await installedSkillsManifestHash() : undefined;
  switch (request.kind) {
    case 'stack-health':
      return await brokerStorageRequest({ protocolVersion: 1, kind: 'stack-health' });
    case 'egress-readiness':
      return await brokerStorageRequest({ protocolVersion: 1, kind: 'egress-readiness' });
    case 'status':
      return {
        ok: true,
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        runnerInstanceId,
        // Both ride on the same helper. The Server reads `scriptIsolation` before it
        // raises an approval card for an entry script this Sandbox could not confine.
        managedAgentConfig: true,
        builtInSkillsVersion: skillsManifestHash ? 1 : 0,
        ...(skillsManifestHash ? { builtInSkillsManifestHash: skillsManifestHash } : {}),
        persistentSessionHomes: true,
        cacheMaintenanceVersion: 2,
        turnOwnershipVersion: 1,
        planningIsolation: capabilities.scriptIsolation,
        knowledgeIsolation: capabilities.scriptIsolation,
        scriptIsolation: capabilities.scriptIsolation,
      };
    case 'prepare-session-home':
      return await sessionHomeRequest('prepare-session-home', request.sessionId, request);
    case 'delete-session-home': {
      if (!SAFE_ID.test(request.sessionId ?? '')) throw new Error('invalid sessionId');
      const turns = await listTurns(runtimeDir);
      for (const turn of turns) {
        // A settled turn has nothing left to stop. Cancelling it only wrote a
        // record and read its state back, once per turn the session ever ran,
        // inside a request the Server waits for. Every other status is still
        // cancelled, and refused where this supervisor cannot reach the worker.
        if (
          turn.sessionId === request.sessionId &&
          turn.status !== 'settled' &&
          turnStarter !== undefined
        )
          await turnStarter.cancel(turn.turnId);
      }
      return await sessionHomeRequest('delete-session-home', request.sessionId);
    }
    case 'reclaim-package-caches': {
      if (
        !Array.isArray(request.sessionIds) ||
        request.sessionIds.length > 512 ||
        request.sessionIds.some((id) => typeof id !== 'string' || !SAFE_ID.test(id)) ||
        !Number.isSafeInteger(request.maxBytes) ||
        request.maxBytes <= 0
      )
        throw new Error('invalid package cache request');
      if (request.maintenanceVersion === 2)
        return await reclaimPackageCachesPaged(runtimeDir, request);
      if (request.maintenanceVersion !== undefined) throw cacheMaintenanceFailure('unsupported');
      const fail = (code, counts) =>
        Object.assign(
          new Error(
            code === 'turn-ownership-unknown'
              ? 'Runner turn ownership is unknown; package caches retained'
              : 'Runner cache maintenance blocked; caches retained',
          ),
          {
            runnerCacheFailure: { code, ...(counts ? { counts } : {}) },
          },
        );
      let turns;
      try {
        turns = await listTurns(runtimeDir);
      } catch {
        throw fail('turn-inventory-unavailable');
      }
      // A missing/corrupt state or an unassigned claim cannot establish which
      // home is idle. Counts explain the refusal without exposing turn content.
      const counts = { missingState: 0, invalidState: 0, unsettledWithoutSession: 0 };
      for (const turn of turns) {
        if (turn.status === 'settled' || typeof turn.sessionId === 'string') continue;
        const key =
          turn.reason === 'missing-state'
            ? 'missingState'
            : turn.reason === 'invalid-state'
              ? 'invalidState'
              : 'unsettledWithoutSession';
        counts[key] = Math.min(1_000_000, counts[key] + 1);
      }
      if (Object.values(counts).some((count) => count > 0))
        throw fail('turn-ownership-unknown', counts);
      const busy = new Set(
        turns.filter((turn) => turn.status !== 'settled').map((turn) => turn.sessionId),
      );
      let response;
      try {
        response = await brokerStorageRequest({
          protocolVersion: 1,
          kind: 'reclaim-package-caches',
          sessionIds: request.sessionIds.filter((id) => !busy.has(id)),
          maxBytes: request.maxBytes,
        });
      } catch (error) {
        const code = ['EACCES', 'EPERM'].includes(error?.code)
          ? 'broker-access-denied'
          : ['ENOENT', 'ECONNREFUSED'].includes(error?.code)
            ? 'broker-unavailable'
            : error?.message === 'runner storage request timed out'
              ? 'broker-timeout'
              : error instanceof SyntaxError ||
                  error?.code === 'ERR_INVALID_RUNNER_STORAGE_RESPONSE'
                ? 'broker-invalid-response'
                : 'broker-rejected';
        throw fail(code);
      }
      if (busy.size > 0 && response.report) {
        response.report.usageComplete = false;
        response.report.legacyBytes = null;
        response.report.blockers = [
          ...(response.report.blockers ?? []).slice(0, 99),
          'Runner sessions have unsettled turns; their legacy package caches were retained',
        ];
      }
      return response;
    }
    case 'list-turns':
      return { ok: true, turns: await listTurns(runtimeDir) };
    case 'get-turn': {
      if (typeof request.turnId !== 'string') throw new Error('invalid turnId');
      const state = await readTurnState(runtimeDir, request.turnId);
      return {
        ok: true,
        state,
        ...(state?.status === 'running' && typeof turnStarter?.workerStatus === 'function'
          ? { workerStatus: turnStarter.workerStatus(request.turnId) }
          : {}),
      };
    }
    case 'claim-turn':
      return { ok: true, ...(await claimTurn(runtimeDir, request, runnerInstanceId)) };
    case 'start-turn': {
      if (turnStarter === undefined) throw new Error('runner worker is not installed');
      if (
        (request.knowledgeIsolation === true || request.planning === true) &&
        !capabilities.scriptIsolation
      ) {
        throw new Error(SCRIPT_ISOLATION_UNAVAILABLE_ERROR);
      }
      // `start` throws on an invalid or refused request, so the acknowledgement can
      // only ever follow an acceptance the supervisor actually made. Everything the
      // Server needs to stop guessing — that the frame was understood and the turn
      // is claimed or about to be — is true by the time this line runs.
      const { pending } = turnStarter.start(request);
      onStartAccepted?.();
      return { ok: true, ...(await pending) };
    }
    case 'cancel-turn':
      if (turnStarter === undefined) throw new Error('runner worker is not installed');
      return { ok: true, ...(await turnStarter.cancel(request.turnId)) };
    case 'run-trusted-cli':
      if (typeof turnStarter?.runTrustedCli !== 'function') {
        throw new Error('runner worker is not installed');
      }
      // Refused before the request, and the secrets it carries, reach the broker.
      if (request.entryScript !== undefined && !capabilities.scriptIsolation) {
        throw new Error(SCRIPT_ISOLATION_UNAVAILABLE_ERROR);
      }
      return {
        ok: true,
        ...(await turnStarter.runTrustedCli(request, onTrustedCliStarted, outputOptions)),
      };
    default:
      throw new Error('unknown supervisor request');
  }
}

export async function runSupervisor(options = {}) {
  const runtimeDir = options.runtimeDir ?? process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const expectedUid = Number(
    options.uid ?? process.env.VERITY_RUNNER_RUNTIME_UID ?? process.getuid?.(),
  );
  const expectedGid = Number(
    options.gid ?? process.env.VERITY_RUNNER_RUNTIME_GID ?? process.getgid?.(),
  );
  await validateRuntimeDirectory(runtimeDir, { uid: expectedUid, gid: expectedGid });
  // Arm the histogram here rather than on the first start, which would otherwise be
  // the one record with no delay figure attached — and the first start after boot is
  // exactly when the supervisor is busiest and the figure most worth having.
  //
  // Unconditional here, unlike the Server-side sampler, which arms only for a client
  // that was given an `onTelemetry` sink. The asymmetry is deliberate: this process
  // exists to run turns and always writes the record, whereas `@verity/session` is
  // imported by CLIs that never read one — there, arming is a cost with no reader.
  sampleEventLoopDelay();
  const scriptIsolation =
    options.scriptIsolation ??
    (await probeScriptSandbox(options.scriptSandboxPath ?? DEFAULT_SCRIPT_SANDBOX_PATH));
  if (!scriptIsolation.available) {
    // The Runner still starts: agent turns, brokered HTTP and plain trusted CLI
    // commands do not depend on filesystem isolation. Only the entry-script paths are refused.
    process.stderr.write(
      `verity-runner-supervisor: worktree entry scripts are disabled: ${scriptIsolation.reason ?? 'script sandbox unavailable'}\n`,
    );
  }
  const capabilities = { scriptIsolation: scriptIsolation.available };
  const singleton = await acquireSingleton(runtimeDir);
  const adoptedTurns = new Set();
  const turnOptions = { ...options, adoptedTurns };
  const turnStarter = createTurnStarter(runtimeDir, singleton.instanceId, turnOptions);
  const turnAdopter = createTurnAdopter(runtimeDir, turnOptions);
  try {
    await turnAdopter.adopt();
  } catch (error) {
    await turnAdopter.close();
    await turnStarter.close();
    await singleton.release();
    throw error;
  }
  const socketPath = join(runtimeDir, 'supervisor.sock');
  try {
    await rm(socketPath, { force: true });
  } catch (error) {
    await turnAdopter.close();
    await turnStarter.close();
    await singleton.release();
    throw error;
  }
  const readyPath = join(runtimeDir, 'supervisor.json');
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    // Peer resets are protocol failures, not supervisor process failures.
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    let handled = false;
    let processingStarted = false;
    let pipelinedAfterNewline = false;
    const outputAbort = new globalThis.AbortController();
    let outputAck;
    let ackBuffer = '';
    let outputSequence = 0;
    socket.once('close', () => {
      outputAbort.abort();
      outputAck?.reject(new Error('trusted CLI output connection closed'));
    });
    const onOutput = (stream, bytes) =>
      new Promise((resolve, reject) => {
        if (socket.destroyed) {
          reject(new Error('trusted CLI output connection closed'));
          return;
        }
        const sequence = outputSequence++;
        const timer = setTimeout(() => {
          outputAck = undefined;
          reject(new Error('trusted CLI output receipt timed out'));
        }, 30000);
        outputAck = {
          sequence,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        socket.write(
          `${JSON.stringify({ ok: true, kind: 'trusted-cli-output', sequence, stream, data: bytes.toString('base64') })}\n`,
        );
      });
    let timeout = setTimeout(() => socket.destroy(), 5_000);
    const setRequestTimeout = (milliseconds) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => socket.destroy(), milliseconds);
    };
    const respond = (response) => {
      clearTimeout(timeout);
      socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
    };
    // Refusing a peer that is STILL WRITING is the one case where destroying the
    // socket destroys the answer with it: the RST can drop the refusal out of the
    // peer's receive buffer, and its own pending write then fails with EPIPE —
    // which is how an oversize attachment reaches the operator as a bare `write
    // EPIPE` naming neither size nor attachments. So send the refusal and keep
    // reading and DISCARDING until the peer finishes and closes. Nothing is
    // buffered, so the memory bound this cap exists to enforce still holds, and
    // the grace timer keeps a stalled peer from pinning the connection open.
    const respondDraining = (response) => {
      clearTimeout(timeout);
      socket.end(`${JSON.stringify(response)}\n`);
      const grace = setTimeout(() => socket.destroy(), OVERSIZE_DRAIN_GRACE_MS);
      socket.once('close', () => clearTimeout(grace));
    };
    socket.on('data', (chunk) => {
      if (handled) {
        if (outputAck !== undefined) {
          ackBuffer += chunk.toString('utf8');
          if (ackBuffer.length > 512) {
            socket.destroy();
            return;
          }
          if (!ackBuffer.endsWith('\n')) return;
          try {
            const ack = JSON.parse(ackBuffer);
            ackBuffer = '';
            if (
              ack.kind !== 'output-ack' ||
              ack.sequence !== outputAck.sequence ||
              (ack.failure !== undefined &&
                !['redaction_failure', 'storage_failure', 'output_limit'].includes(ack.failure))
            ) {
              socket.destroy();
              return;
            }
            const pending = outputAck;
            outputAck = undefined;
            if (ack.failure === undefined) pending.resolve();
            else
              pending.reject(
                Object.assign(new Error('trusted CLI output rejected'), {
                  outputFailure: ack.failure,
                }),
              );
          } catch {
            socket.destroy();
          }
          return;
        }
        // A second request may arrive in a later Unix-socket chunk. Give framing
        // one event-loop turn before applying the first request so TCP/Unix chunk
        // boundaries cannot turn the same pipelined bytes into different behavior.
        if (!processingStarted && chunk.length > 0) pipelinedAfterNewline = true;
        return;
      }
      if (buffered.length + chunk.length > MAX_CONTROL_LINE_BYTES) {
        handled = true;
        buffered = Buffer.alloc(0);
        respondDraining(responseForError(new Error('supervisor frame too large')));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      const line = buffered.subarray(0, newline).toString('utf8');
      const remainder = buffered.subarray(newline + 1);
      buffered = Buffer.alloc(0);
      if (remainder.length > 0) {
        respond(responseForError(new Error('supervisor accepts exactly one request')));
        return;
      }
      void new Promise((resolve) => setImmediate(resolve))
        .then(() => {
          processingStarted = true;
          if (pipelinedAfterNewline) {
            throw new Error('supervisor accepts exactly one request');
          }
        })
        .then(() => JSON.parse(line))
        .then((request) => {
          setRequestTimeout(supervisorRequestTimeoutMs(request));
          return handleSupervisorRequest(
            runtimeDir,
            singleton.instanceId,
            request,
            turnStarter,
            request?.kind === 'run-trusted-cli'
              ? () => socket.write(`${JSON.stringify({ ok: true, kind: 'trusted-cli-started' })}\n`)
              : undefined,
            // Only when the Server asked for it. A Server that predates the two-phase
            // reply reads exactly one frame per request and would refuse a second as
            // an invalid frame count — the D9 half of this change that keeps a new
            // Sandbox image usable by an older Server.
            request?.kind === 'start-turn' && request.startAck === true
              ? () =>
                  socket.write(
                    `${JSON.stringify({
                      ok: true,
                      kind: 'start-accepted',
                      // The raw request's ids, which the client compares strictly
                      // against the ones it sent. Sound because `validateStartTurnRequest`
                      // only TESTS these two against `SAFE_ID` and never rewrites them;
                      // a validator that ever normalized an id would have to echo the
                      // normalized value here instead.
                      turnId: request.turnId,
                      startCommandId: request.startCommandId,
                    })}\n`,
                  )
              : undefined,
            capabilities,
            request?.kind === 'run-trusted-cli' && request.streamOutput === true
              ? { onOutput, signal: outputAbort.signal }
              : {},
          );
        })
        .catch(responseForError)
        .then(respond);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o660);
    await writeJsonAtomic(readyPath, {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      runnerInstanceId: singleton.instanceId,
      pid: process.pid,
      socketPath,
      readyAt: Date.now(),
    });
  } catch (error) {
    server.close();
    await turnAdopter.close();
    await turnStarter.close();
    await rm(socketPath, { force: true });
    await singleton.release();
    throw error;
  }
  const close = async () => {
    await turnAdopter.close();
    await turnStarter.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
    await rm(readyPath, { force: true });
    await singleton.release();
  };
  return { runtimeDir, socketPath, instanceId: singleton.instanceId, close };
}

export async function probeSupervisor(runtimeDir = DEFAULT_RUNTIME_DIR, timeoutMs = 1_000) {
  const socketPath = join(runtimeDir, 'supervisor.sock');
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    const finish = (live) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(live);
    };
    socket.once('error', () => finish(false));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response);
        finish(parsed?.ok === true && parsed.protocolVersion === SUPERVISOR_PROTOCOL_VERSION);
      } catch {
        finish(false);
      }
    });
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ protocolVersion: SUPERVISOR_PROTOCOL_VERSION, kind: 'status' })}\n`,
      );
    });
  });
}
