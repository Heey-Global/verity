import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { URL } from 'node:url';
import {
  ACP_WORKER_BACKENDS,
  CANCELLED_MISSING_WORKER_ERROR,
  DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS,
  IMAGE_MEDIA_TYPES,
  MAX_START_ATTACHMENTS,
  MAX_START_REQUEST_BYTES,
  MAX_WORKER_ERROR_BYTES,
  MISSING_WORKER_ERROR,
  SAFE_ID,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_REQUEST_GRACE_MS,
  TRUSTED_CLI_KILL_GRACE_MS,
  TRUSTED_CLI_TIMEOUT_MS,
  TURN_CAPABILITY_PATTERN,
  WORKER_BACKENDS,
  cancelExplainsSettlement,
  isGitAuthor,
  isObject,
  writeSyntheticTerminalFrame,
} from './protocol.mjs';

/**
 * Settle a turn whose worker is gone — and say WHY in the stream, not only in the
 * state.
 *
 * Recovery after a supervisor restart is the one remaining way to reach a settled
 * turn with an empty event stream, which the Server reads as `agent exited without
 * a terminal event`: the same symptom, arriving by the one door the start path no
 * longer leaves open. The frame is written first so no window exists in which the
 * state says `settled` and the stream still says nothing, and it is written
 * best-effort because a turn that cannot be explained must still be ended.
 *
 * The frame is stamped with the state's OWN `runnerInstanceId` — the instance that
 * ran the worker — not this one: `turnId` binds to exactly one instance for the
 * life of the turn (ADR 0006 D3), and this supervisor is only its undertaker. A
 * state old enough to lack that field is settled without a frame rather than with
 * an unattributable one.
 *
 * A turn with NO state at all is left alone. Writing one here would invent a settled
 * turn out of a state that says nothing — no `startCommandId`, no instance, no
 * diagnosis — and the Server reads exactly that shape as "nothing ever claimed this",
 * the one answer that lets it safely start the turn again. Better a turn it may retry
 * than a failure it cannot explain.
 *
 * That rule is the adopter's own, unchanged; sharing this function extends it to the
 * start path's liveness check, which used to write `settled` for a turn it could not
 * read. The difference is theoretical: `adopt()` only ever adopts a turn whose state
 * parsed as `claimed`/`running` with `workerLock`, and nothing here ever removes a
 * `state.json`, so the absent-state branch is not reachable from an adopted turn. It
 * is written for the one that is: a `state.json` that is present but CORRUPT throws
 * out of `readTurnState`, which the adopter retries as `uncertain` and the start path
 * refuses — neither of them settling a turn on a file they could not read.
 */
export async function settleMissingWorkerTurn(runtimeDir, turnId) {
  const state = await readTurnState(runtimeDir, turnId);
  if (state === undefined || state.status === 'settled') return;
  // A turn cancelled just before the supervisor died is settled here rather than on
  // the exit path, and it must carry the same label it would have carried there: the
  // operator asked for it to stop, and it stopped. Only a PROVEN cancellation counts
  // — an unreadable tombstone reports the crash, exactly as on every other exit.
  const aborted = await cancelExplainsSettlement(runtimeDir, turnId);
  const workerError = aborted ? CANCELLED_MISSING_WORKER_ERROR : MISSING_WORKER_ERROR;
  if (typeof state.runnerInstanceId === 'string') {
    await writeSyntheticTerminalFrame(join(runtimeDir, 'turns', turnId), {
      turnId,
      runnerInstanceId: state.runnerInstanceId,
      // SIGTERM only for the cancelled half: it derives exit 143, which the Server
      // reads as "the operator interrupted this" — true here, and a false accusation
      // for a worker that simply vanished.
      ...(aborted ? { workerSignal: 'SIGTERM' } : {}),
      workerError,
      aborted,
    }).catch(() => undefined);
  }
  await updateTurnState(runtimeDir, turnId, {
    status: 'settled',
    ...(aborted ? { workerSignal: 'SIGTERM' } : {}),
    workerError,
  });
}

/**
 * How long one request may occupy a connection before the supervisor gives up on it.
 *
 * Note what expiry does: it DESTROYS the socket, it does not answer. So this is not a
 * refusal the Server can act on — it reaches the client as a lost answer, which is
 * what sends it to reconciliation and the cancel fence rather than down the decided
 * path. That is the safe direction, and it is why nothing here needs to be shorter
 * than the client's budgets.
 *
 * For `start-turn` that is `DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS` (15 min) plus the
 * grace — three orders of magnitude above the queue's own drain time, so a start
 * cannot lose its connection while it is merely waiting for a slot. The grace is
 * ADDED to the budget, never a cap on it: it exists so the supervisor outlives the
 * peer's deadline and the peer's error, not the supervisor's silence, is what the
 * operator reads.
 */
export function supervisorRequestTimeoutMs(request) {
  return (
    (isObject(request) && request.kind === 'run-trusted-cli'
      ? TRUSTED_CLI_TIMEOUT_MS + TRUSTED_CLI_KILL_GRACE_MS
      : DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS) + SUPERVISOR_REQUEST_GRACE_MS
  );
}

async function processStartTime(pid) {
  const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => undefined);
  if (stat === undefined) return undefined;
  // `/proc/<pid>/stat` field 2 is parenthesized and may contain spaces. Everything
  // after the final `)` starts at field 3; starttime is field 22 (index 19 here).
  const afterCommand = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/u);
  return afterCommand[19];
}

export async function writeJsonAtomic(path, value, mode = 0o660) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, mode);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function acquireFileLock(path) {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o660,
  );
  let stats;
  try {
    stats = await handle.stat();
  } catch (error) {
    await handle.close();
    throw error;
  }
  if (!stats.isFile()) {
    await handle.close();
    throw new Error('runner lock is not a regular file');
  }
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', handle.fd],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', rejectResult);
    child.once('close', (code, signal) => resolveResult({ code, signal, stderr }));
  }).catch(async (error) => {
    await handle.close();
    throw error;
  });
  if (result.code !== 0) {
    await handle.close();
    const busy = result.code === 75 && result.signal === null;
    const error = new Error(
      busy
        ? 'runner supervisor is already claimed'
        : result.stderr.trim().length > 0
          ? `runner supervisor lock failed: ${result.stderr.trim()}`
          : `runner supervisor lock failed with ${result.signal ?? `code ${String(result.code)}`}`,
    );
    if (busy) error.code = 'ELOCKED';
    throw error;
  }
  return handle;
}

export function isLockBusy(error) {
  return error?.code === 'ELOCKED';
}

export function stdioWithWorkerLock(lockFd) {
  return ['pipe', 'pipe', 'pipe', lockFd];
}

function boundedWorkerError(value) {
  const redacted = redactWorkerError(String(value)).trim();
  if (redacted.length === 0) return '';
  const allowlistedDiagnostics = [
    { pattern: /\bnot logged in\b/i, message: 'worker stderr reported: not logged in' },
    {
      pattern: /\b(?:authentication failed|unauthorized|invalid credentials?)\b/i,
      message: 'worker stderr reported an authentication failure',
    },
    { pattern: /\bforbidden\b/i, message: 'worker stderr reported: forbidden' },
    {
      pattern: /\bpermission denied\b/i,
      message: 'worker stderr reported: permission denied',
    },
    {
      pattern: /\b(?:could not resolve host|name or service not known)\b/i,
      message: 'worker stderr reported a DNS resolution failure',
    },
    {
      pattern: /\bconnection (?:refused|reset)\b/i,
      message: 'worker stderr reported a connection failure',
    },
    {
      pattern: /\b(?:timed out|timeout)\b/i,
      message: 'worker stderr reported a timeout',
    },
    {
      pattern: /\b(?:no such file or directory|command not found|module not found)\b/i,
      message: 'worker stderr reported a missing executable or module',
    },
  ];
  const diagnostic = allowlistedDiagnostics.find(({ pattern }) => pattern.test(redacted));
  if (diagnostic !== undefined) return diagnostic.message;
  const errorCode = redacted.match(/\b(?:E[A-Z]{2,20}|HTTP [45]\d\d)\b/)?.[0];
  return errorCode === undefined
    ? 'worker stderr reported an unrecognized failure'
    : `worker stderr reported error code ${errorCode}`;
}

export function boundedSpawnError(value) {
  const message = String(value);
  if (
    /^runner worker (?:is not installed|has no private (?:attestation|attestation acknowledgement|error) pipe)$/.test(
      message,
    )
  ) {
    return message;
  }
  const errorCode = message.match(/\bE[A-Z]{2,20}\b/)?.[0];
  return errorCode === undefined
    ? 'runner worker spawn failed'
    : `runner worker spawn failed with error code ${errorCode}`;
}

/**
 * Name the refused stage and path in the error the Server reports. Without it an
 * operator sees only "error code EACCES" and cannot tell a worktree the Runner uid
 * may not traverse from a worker binary it may not execute — the diagnostic above
 * existed only in this container's state and log. Both parts are values this file
 * derived itself (a fixed stage name and the requested cwd or worker path), never
 * exception text, so the credential guarantee of {@link boundedSpawnError} holds.
 */
export function describeSpawnFailure(message, diagnostic) {
  if (diagnostic.stage === 'spawn' && diagnostic.path === undefined) return message;
  if (diagnostic.path === undefined) return `${message} (${diagnostic.stage})`;
  // The path is request data: keep it one line and well inside the state's error budget.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  const path = diagnostic.path.replace(/[\u0000-\u001f\u007f]/g, '?');
  const shown =
    path.length > MAX_SPAWN_FAILURE_PATH ? `${path.slice(0, MAX_SPAWN_FAILURE_PATH)}…` : path;
  return `${message} (${diagnostic.stage}: ${shown})`;
}

const MAX_SPAWN_FAILURE_PATH = 512;

export function spawnFailureDiagnostic(error, request, workerCommand) {
  const code =
    typeof error?.code === 'string' && /^E[A-Z]{2,20}$/.test(error.code) ? error.code : undefined;
  const declared = error?.veritySpawnDiagnostic;
  if (
    isObject(declared) &&
    ['cwd-traverse', 'worker-executable', 'spawn'].includes(declared.stage) &&
    ['cwd', 'worker-executable', 'unknown'].includes(declared.target)
  ) {
    return {
      stage: declared.stage,
      target: declared.target,
      ...(declared.target === 'cwd' ? { path: request.cwd } : {}),
      ...(declared.target === 'worker-executable'
        ? { path: declared.path ?? resolve(request.cwd, workerCommand) }
        : {}),
      ...(code !== undefined ? { code } : {}),
    };
  }
  const target = error?.path === workerCommand ? 'worker-executable' : 'unknown';
  return {
    stage: 'spawn',
    target,
    ...(target === 'worker-executable' ? { path: resolve(request.cwd, workerCommand) } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

export async function assertSpawnBoundary(request, workerCommand, workerPath) {
  try {
    await access(request.cwd, constants.X_OK);
  } catch (error) {
    error.veritySpawnDiagnostic = { stage: 'cwd-traverse', target: 'cwd' };
    throw error;
  }
  const candidates = workerCommand.includes('/')
    ? [resolve(request.cwd, workerCommand)]
    : (workerPath ?? '')
        .split(delimiter)
        .map((entry) => resolve(request.cwd, entry, workerCommand));
  let lastError;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const error =
    lastError ?? Object.assign(new Error('worker executable is not on PATH'), { code: 'ENOENT' });
  error.veritySpawnDiagnostic = {
    stage: 'worker-executable',
    target: 'worker-executable',
    path: candidates[0] ?? resolve(request.cwd, workerCommand),
  };
  throw error;
}

function redactWorkerError(value) {
  const credentialPatterns = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    /sk-ant-[a-z0-9-]{8,}/gi,
    /gh[pousr]_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /dp\.(?:st|sa|ct|scim|audit)\.[A-Za-z0-9._-]{16,}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  ];
  // eslint-disable-next-line no-control-regex -- stderr is untrusted bytes normalized to safe text.
  let redacted = value.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '\uFFFD');
  for (const pattern of credentialPatterns) redacted = redacted.replace(pattern, '[REDACTED]');
  redacted = redacted.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi,
    '$1: [REDACTED]',
  );
  redacted = redacted.replace(
    /(["']?(?:authorization|proxy-authorization|cookie|set-cookie|password|token|secret|api[_-]?key)["']?\s*:\s*["'])[^"']+(["'])/gi,
    '$1[REDACTED]$2',
  );
  redacted = redacted.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@');
  redacted = redacted.replace(
    /([?&](?:access_token|api_key|token|signature|x-amz-signature)=)[^&\s]+/gi,
    '$1[REDACTED]',
  );
  redacted = redacted.replace(
    /\b((?:database_url|redis_url|mongodb_uri)|[a-z0-9_]*(?:token|secret|password|api[_-]?key|cookie))\s*=\s*[^\s]+/gi,
    '$1=[REDACTED]',
  );
  redacted = redacted.replace(
    /(\s--(?:access-token|token|secret|password|api-key|cookie)(?:=|\s+))[^\s]+/gi,
    '$1[REDACTED]',
  );
  return redacted;
}

export function createWorkerErrorCapture() {
  const privateKeyMarkers = ['', 'OPENSSH ', 'RSA ', 'EC '].flatMap((kind) => [
    { bytes: Buffer.from(['-----BEGIN ', `${kind}PRIVATE KEY-----`].join('')), begins: true },
    { bytes: Buffer.from(['-----END ', `${kind}PRIVATE KEY-----`].join('')), begins: false },
  ]);
  const markerOverlapBytes = Math.max(...privateKeyMarkers.map(({ bytes }) => bytes.length)) - 1;
  let output = Buffer.alloc(0);
  let line = Buffer.alloc(0);
  let oversizedLine = false;
  let privateKeyBlock = false;
  let markerTail = Buffer.alloc(0);

  const appendOutput = (value) => {
    output = Buffer.concat([output, Buffer.from(value)]).subarray(-MAX_WORKER_ERROR_BYTES);
  };
  const observePrivateKeyMarkers = (bytes) => {
    const boundaryLength = Math.min(bytes.length, markerOverlapBytes);
    const boundary = Buffer.concat([markerTail, bytes.subarray(0, boundaryLength)]);
    const matches = [];
    for (const marker of privateKeyMarkers) {
      const boundaryIndex = boundary.indexOf(marker.bytes);
      if (boundaryIndex !== -1) matches.push({ index: boundaryIndex, begins: marker.begins });
      let index = bytes.indexOf(marker.bytes);
      while (index !== -1) {
        matches.push({ index: markerTail.length + index, begins: marker.begins });
        index = bytes.indexOf(marker.bytes, index + 1);
      }
    }
    matches.sort((left, right) => left.index - right.index);
    for (const match of matches) privateKeyBlock = match.begins;
    markerTail = Buffer.from(bytes.subarray(-markerOverlapBytes));
  };
  const appendLineBytes = (bytes) => {
    observePrivateKeyMarkers(bytes);
    if (oversizedLine || bytes.length === 0) return;
    if (line.length + bytes.length > MAX_WORKER_ERROR_BYTES) {
      line = Buffer.alloc(0);
      oversizedLine = true;
      return;
    }
    line = Buffer.concat([line, bytes]);
    const outputBudget = MAX_WORKER_ERROR_BYTES - line.length;
    output = outputBudget === 0 ? Buffer.alloc(0) : output.subarray(-outputBudget);
  };
  const finishLine = (terminated) => {
    const text = line.toString('utf8');
    const beginsPrivateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text);
    const endsPrivateKey = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text);
    if (oversizedLine || privateKeyBlock || beginsPrivateKey) {
      appendOutput(`[REDACTED]${terminated ? '\n' : ''}`);
    } else {
      appendOutput(`${redactWorkerError(text)}${terminated ? '\n' : ''}`);
    }
    if (beginsPrivateKey) privateKeyBlock = true;
    if (endsPrivateKey) privateKeyBlock = false;
    line = Buffer.alloc(0);
    oversizedLine = false;
    markerTail = Buffer.alloc(0);
  };

  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline === -1) {
          appendLineBytes(bytes.subarray(offset));
          return;
        }
        appendLineBytes(bytes.subarray(offset, newline));
        finishLine(true);
        offset = newline + 1;
      }
    },
    finish() {
      if (line.length > 0 || oversizedLine) finishLine(false);
      return boundedWorkerError(output);
    },
  };
}

export function validateRuntimeStats(stats, expected = {}) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('runner runtime is not a real directory');
  }
  const uid = expected.uid ?? process.getuid?.();
  const gid = expected.gid ?? process.getgid?.();
  if (gid !== undefined && stats.gid !== gid) {
    throw new Error(`runner runtime gid mismatch: expected ${gid}, got ${stats.gid}`);
  }
  const mode = stats.mode & 0o777;
  if (uid !== undefined) {
    const runnerOwned = stats.uid === uid;
    // Server-owned runtimes must keep owner read AND write clear so a same-uid
    // sandbox agent cannot read or write the Runner's control files here, but a
    // bare owner traverse bit (0170, --x) is allowed: the provisioner grants it so
    // the agent — which shares uid 1000 with the Server — can descend to its
    // Server-created transcript directory under claude/ (stage-5b capture).
    const serverOwned = !runnerOwned && (mode & 0o600) === 0;
    if (!runnerOwned && !serverOwned) {
      throw new Error(
        `runner runtime uid mismatch: expected ${uid} or server-owned group-only, got ${stats.uid}`,
      );
    }
    if (runnerOwned && (mode & 0o700) !== 0o700) {
      throw new Error(
        `runner-owned runtime must be owner/group-only and writable (0770): ${mode.toString(8)}`,
      );
    }
  }
  if ((mode & 0o007) !== 0 || (mode & 0o070) !== 0o070) {
    throw new Error(
      `runner runtime must be group-only and writable by the runtime group: ${mode.toString(8)}`,
    );
  }
}

export async function validateRuntimeDirectory(runtimeDir, expected = {}) {
  const stats = await lstat(runtimeDir);
  try {
    validateRuntimeStats(stats, expected);
  } catch (error) {
    if (error instanceof Error && error.message === 'runner runtime is not a real directory') {
      throw new Error(`runner runtime is not a real directory: ${runtimeDir}`, { cause: error });
    }
    throw error;
  }
}

export async function acquireSingleton(runtimeDir, instanceId = randomUUID()) {
  const lockPath = join(runtimeDir, 'supervisor.lock');
  const ownerPath = join(runtimeDir, 'supervisor.lock.json');
  // The helper applies flock(2) to fd 3, which is a duplicate of this process's
  // open file description. Keeping the FileHandle open retains a kernel lock on
  // the SHARED volume across container/network namespaces; process death drops it.
  const lockHandle = await acquireFileLock(lockPath);
  const owner = {
    pid: process.pid,
    processStartTime: await processStartTime(process.pid),
    instanceId,
  };
  try {
    await writeJsonAtomic(ownerPath, owner);
    await chmod(lockPath, 0o660);
  } catch (error) {
    await lockHandle.close();
    throw error;
  }
  let released = false;
  return {
    instanceId,
    async release() {
      if (released) return;
      released = true;
      const currentOwner = await readFile(ownerPath, 'utf8').catch(() => undefined);
      let currentInstanceId;
      try {
        currentInstanceId =
          currentOwner === undefined ? undefined : JSON.parse(currentOwner).instanceId;
      } catch {
        currentInstanceId = undefined;
      }
      try {
        if (currentInstanceId === instanceId) {
          await rm(ownerPath, { force: true });
        }
      } finally {
        await lockHandle.close();
      }
    },
  };
}

export async function readTurnState(runtimeDir, turnId) {
  if (!SAFE_ID.test(turnId)) throw new Error('invalid turnId');
  const path = join(runtimeDir, 'turns', turnId, 'state.json');
  const stats = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stats === undefined) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024)
    throw new Error(`invalid state file for ${turnId}`);
  const raw = await readFile(path, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw);
  if (
    !isObject(parsed) ||
    parsed.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION ||
    parsed.turnId !== turnId ||
    typeof parsed.startCommandId !== 'string' ||
    !SAFE_ID.test(parsed.startCommandId) ||
    typeof parsed.runnerInstanceId !== 'string' ||
    !SAFE_ID.test(parsed.runnerInstanceId) ||
    (parsed.sessionId !== undefined &&
      (typeof parsed.sessionId !== 'string' || !SAFE_ID.test(parsed.sessionId))) ||
    !['claimed', 'running', 'settled'].includes(parsed.status) ||
    typeof parsed.createdAt !== 'number' ||
    !Number.isFinite(parsed.createdAt) ||
    typeof parsed.updatedAt !== 'number' ||
    !Number.isFinite(parsed.updatedAt) ||
    (parsed.workerLock !== undefined && parsed.workerLock !== true) ||
    (parsed.trustedCliExecution !== undefined && parsed.trustedCliExecution !== true) ||
    (parsed.cwd !== undefined && (typeof parsed.cwd !== 'string' || !parsed.cwd.startsWith('/'))) ||
    (parsed.workerExitCode !== undefined &&
      parsed.workerExitCode !== null &&
      !Number.isInteger(parsed.workerExitCode)) ||
    (parsed.workerError !== undefined &&
      (typeof parsed.workerError !== 'string' ||
        Buffer.byteLength(parsed.workerError) > MAX_WORKER_ERROR_BYTES)) ||
    (parsed.workerSpawnFailure !== undefined &&
      (!isObject(parsed.workerSpawnFailure) ||
        !['cwd-traverse', 'worker-executable', 'spawn'].includes(parsed.workerSpawnFailure.stage) ||
        !['cwd', 'worker-executable', 'unknown'].includes(parsed.workerSpawnFailure.target) ||
        (parsed.workerSpawnFailure.path !== undefined &&
          (typeof parsed.workerSpawnFailure.path !== 'string' ||
            !parsed.workerSpawnFailure.path.startsWith('/'))) ||
        (parsed.workerSpawnFailure.code !== undefined &&
          (typeof parsed.workerSpawnFailure.code !== 'string' ||
            !/^E[A-Z]{2,20}$/.test(parsed.workerSpawnFailure.code)))))
  ) {
    throw new Error(`invalid state for ${turnId}`);
  }
  return parsed;
}

export const cacheClaimEpochs = new Map();
export const cacheScans = new Map();
export const activeCacheClaims = new Map();
export const cacheFinalAdmissions = new Map();

export async function claimTurn(runtimeDir, request, runnerInstanceId) {
  while (cacheFinalAdmissions.has(runtimeDir)) await cacheFinalAdmissions.get(runtimeDir);
  activeCacheClaims.set(runtimeDir, (activeCacheClaims.get(runtimeDir) ?? 0) + 1);
  cacheClaimEpochs.set(runtimeDir, (cacheClaimEpochs.get(runtimeDir) ?? 0) + 1);
  try {
    return await claimTurnImpl(runtimeDir, request, runnerInstanceId);
  } finally {
    cacheClaimEpochs.set(runtimeDir, (cacheClaimEpochs.get(runtimeDir) ?? 0) + 1);
    const active = activeCacheClaims.get(runtimeDir) - 1;
    if (active === 0) activeCacheClaims.delete(runtimeDir);
    else activeCacheClaims.set(runtimeDir, active);
  }
}

async function claimTurnImpl(runtimeDir, request, runnerInstanceId) {
  const { turnId, startCommandId, sessionId } = request;
  if (typeof turnId !== 'string' || !SAFE_ID.test(turnId)) throw new Error('invalid turnId');
  if (typeof startCommandId !== 'string' || !SAFE_ID.test(startCommandId)) {
    throw new Error('invalid startCommandId');
  }
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)))
    throw new Error('invalid sessionId');
  const turnsDir = join(runtimeDir, 'turns');
  const turnDir = join(turnsDir, turnId);
  const createdTurnsPath = await mkdir(turnsDir, { recursive: true, mode: 0o770 });
  await chmod(turnsDir, 0o770);
  if (createdTurnsPath !== undefined) await syncDirectory(runtimeDir);
  let created = false;
  try {
    await mkdir(turnDir, { mode: 0o770 });
    await chmod(turnDir, 0o770);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (created) {
    const now = Date.now();
    const state = {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      turnId,
      startCommandId,
      runnerInstanceId,
      ...(sessionId === undefined ? {} : { sessionId }),
      status: 'claimed',
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(join(turnDir, 'state.json'), state);
    // Persist the new turn directory entry before acknowledging the claim. The
    // state file itself and turnDir were synced by writeJsonAtomic above.
    await syncDirectory(turnsDir);
    return { outcome: 'created', state };
  }
  const turnStats = await lstat(turnDir);
  if (!turnStats.isDirectory() || turnStats.isSymbolicLink()) {
    return { outcome: 'ambiguous', reason: 'invalid-turn-directory' };
  }
  const state = await readTurnState(runtimeDir, turnId);
  if (state === undefined) {
    return { outcome: 'ambiguous', reason: 'turn-directory-without-state' };
  }
  if (state.sessionId !== undefined && state.sessionId !== sessionId) {
    return { outcome: 'conflict', reason: 'session-identity-mismatch', state };
  }
  if (state.startCommandId !== startCommandId) {
    return { outcome: 'conflict', reason: 'start-command-mismatch', state };
  }
  if (state.status !== 'settled' && state.runnerInstanceId !== runnerInstanceId) {
    return { outcome: 'ambiguous', reason: 'runner-instance-mismatch', state };
  }
  return {
    outcome: state.status === 'settled' ? 'terminal' : 'already-running',
    state,
  };
}

/** Verify turn-owned image bytes before the worker can consume the reference. */
export function validateImageReferences(value, cwd, turnId) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_START_ATTACHMENTS) {
    throw new Error('invalid attachments');
  }
  return value.map((item) => {
    if (
      !isObject(item) ||
      item.kind !== 'image' ||
      !IMAGE_MEDIA_TYPES.has(item.mediaType) ||
      typeof item.filePath !== 'string' ||
      !Number.isSafeInteger(item.byteSize) ||
      item.byteSize < 1 ||
      item.byteSize > 7_500_000 ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.sha256)
    )
      throw new Error('invalid attachment');
    const root = join(cwd, '.verity-sessions', 'attachments', `turn-${turnId}`);
    const name = item.filePath.slice(root.length + 1);
    if (
      !item.filePath.startsWith(`${root}/`) ||
      !/^[\w.-]+$/u.test(name) ||
      name === '.' ||
      name === '..'
    ) {
      throw new Error('invalid attachment path');
    }
    const handles = [];
    try {
      if (lstatSync(cwd).isSymbolicLink()) throw new Error('invalid attachment directory');
      let directory = openSync(
        cwd,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(directory);
      for (const part of ['.verity-sessions', 'attachments', `turn-${turnId}`]) {
        if (lstatSync(join(`/proc/self/fd/${directory}`, part)).isSymbolicLink())
          throw new Error('invalid attachment directory');
        directory = openSync(
          join(`/proc/self/fd/${directory}`, part),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        handles.push(directory);
      }
      if (lstatSync(join(`/proc/self/fd/${directory}`, name)).isSymbolicLink())
        throw new Error('invalid attachment file');
      const file = openSync(
        join(`/proc/self/fd/${directory}`, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      handles.push(file);
      const stats = fstatSync(file);
      if (!stats.isFile() || stats.size !== item.byteSize)
        throw new Error('invalid attachment size');
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(Math.min(item.byteSize, 64 * 1024));
      let offset = 0;
      while (offset < item.byteSize) {
        const count = readSync(
          file,
          buffer,
          0,
          Math.min(buffer.length, item.byteSize - offset),
          offset,
        );
        if (count === 0) throw new Error('invalid attachment size');
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
      if (fstatSync(file).size !== item.byteSize || hash.digest('hex') !== item.sha256) {
        throw new Error('invalid attachment checksum');
      }
    } catch (error) {
      throw new Error('invalid attachment reference', { cause: error });
    } finally {
      for (const handle of handles.reverse()) closeSync(handle);
    }
    return {
      kind: 'image',
      mediaType: item.mediaType,
      filePath: item.filePath,
      byteSize: item.byteSize,
      sha256: item.sha256,
    };
  });
}

export function validateStartTurnRequest(request) {
  if (!isObject(request) || request.kind !== 'start-turn') throw new Error('invalid start request');
  // The remaining serialized request is bounded independently of staged image bytes. This runs
  // before per-field checks so a huge payload never reaches the shape validation.
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_START_REQUEST_BYTES) {
    throw new Error('start request exceeds supervisor limit');
  }
  if (!SAFE_ID.test(request.turnId ?? '')) throw new Error('invalid turnId');
  if (!SAFE_ID.test(request.startCommandId ?? '')) throw new Error('invalid startCommandId');
  if (!SAFE_ID.test(request.sessionId ?? '')) throw new Error('invalid sessionId');
  if (!WORKER_BACKENDS.has(request.backend)) throw new Error('invalid worker backend');
  if (typeof request.worktree !== 'string' || !request.worktree.startsWith('/')) {
    throw new Error('invalid worktree');
  }
  if (typeof request.cwd !== 'string' || !request.cwd.startsWith('/'))
    throw new Error('invalid cwd');
  const worktree = resolve(request.worktree);
  const cwd = resolve(request.cwd);
  if (cwd !== worktree && !cwd.startsWith(`${worktree}/`)) throw new Error('cwd outside worktree');
  if (typeof request.prompt !== 'string' || Buffer.byteLength(request.prompt) > 1024 * 1024) {
    throw new Error('invalid prompt');
  }
  if (
    request.model !== undefined &&
    (typeof request.model !== 'string' || request.model.length > 256)
  ) {
    throw new Error('invalid model');
  }
  const optionalString = (value, name, maxBytes) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) {
      throw new Error(`invalid ${name}`);
    }
    return value;
  };
  const stringList = (value, name) => {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.length > 256 ||
      value.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 4_096)
    ) {
      throw new Error(`invalid ${name}`);
    }
    return value;
  };
  const attachments = validateImageReferences(request.attachments, cwd, request.turnId);
  const appendSystemPrompt = optionalString(
    request.appendSystemPrompt,
    'appendSystemPrompt',
    1_048_576,
  );
  const resumeSessionId = optionalString(request.resumeSessionId, 'resumeSessionId', 256);
  // Per-turn bearer for the loopback MCP gateway (ADR 0014 D1). The supervisor only
  // bounds its shape; the Server minted it and is the only party that can resolve it.
  const mcpGatewayToken = optionalString(request.mcpGatewayToken, 'mcpGatewayToken', 512);
  if (
    mcpGatewayToken !== undefined &&
    (mcpGatewayToken === '' || !ACP_WORKER_BACKENDS.has(request.backend))
  ) {
    throw new Error('invalid mcpGatewayToken');
  }
  const mcpProxyToken = optionalString(request.mcpProxyToken, 'mcpProxyToken', 512);
  if (mcpProxyToken === '') throw new Error('invalid mcpProxyToken');
  // The turn's badge: names this turn (and the person it runs for) to Server routes
  // the in-Sandbox helpers call. Only its shape is checked here; the Server minted
  // it and alone can resolve it. Any backend may carry one.
  const turnCapability = optionalString(request.turnCapability, 'turnCapability', 43);
  if (turnCapability !== undefined && !TURN_CAPABILITY_PATTERN.test(turnCapability)) {
    throw new Error('invalid turnCapability');
  }
  if (request.gitAuthor !== undefined && !isGitAuthor(request.gitAuthor)) {
    throw new Error('invalid gitAuthor');
  }
  // False only for a person without a signing key (see git-author.ts).
  if (request.signCommits !== undefined && request.signCommits !== false) {
    throw new Error('invalid signCommits');
  }
  const gitAuthor =
    request.gitAuthor === undefined
      ? undefined
      : { name: request.gitAuthor.name, email: request.gitAuthor.email };
  let mcpServers;
  if (request.mcpServers !== undefined) {
    if (!Array.isArray(request.mcpServers) || request.mcpServers.length > 16) {
      throw new Error('invalid mcpServers');
    }
    mcpServers = request.mcpServers.map((server) => {
      if (!isObject(server)) throw new Error('invalid mcpServers');
      const name = optionalString(server.name, 'mcpServers.name', 128);
      const url = optionalString(server.url, 'mcpServers.url', 4096);
      if (name === undefined || name === '' || url === undefined || url === '') {
        throw new Error('invalid mcpServers');
      }
      if (url !== 'verity-internal://mcp-proxy') {
        try {
          if (!['http:', 'https:'].includes(new URL(url).protocol)) {
            throw new Error('invalid scheme');
          }
        } catch {
          throw new Error('invalid mcpServers');
        }
      }
      if (!Array.isArray(server.headers) || server.headers.length > 32) {
        throw new Error('invalid mcpServers');
      }
      const headers = server.headers.map((header) => {
        if (!isObject(header)) throw new Error('invalid mcpServers');
        const headerName = optionalString(header.name, 'mcpServers.headers.name', 256);
        const value = optionalString(header.value, 'mcpServers.headers.value', 4096);
        if (headerName === undefined || headerName === '' || value === undefined) {
          throw new Error('invalid mcpServers');
        }
        return { name: headerName, value };
      });
      return { name, url, headers };
    });
  }
  if (request.knowledgeIsolation !== undefined && typeof request.knowledgeIsolation !== 'boolean')
    throw new Error('invalid knowledgeIsolation');
  if (
    request.knowledgeIsolation &&
    (request.resumeSessionId ||
      request.trustedCliExecution ||
      request.mcpProxyToken ||
      request.mcpServers?.length)
  )
    throw new Error('Isolated Wiki jobs cannot inherit context or external tools');
  if (request.trustedCliExecution === true && !ACP_WORKER_BACKENDS.has(request.backend)) {
    throw new Error('invalid trustedCliExecution');
  }
  // Deliberately not narrowed to a fixed vocabulary here: ACP permission modes are
  // per-agent, and this one field carries every backend's. `Conductor.query` also
  // pins `dontAsk` for its unattended meta turns, which reach the supervisor by this
  // same path. The posture is bounded where it is actually agent-specific — the
  // profile's `permissionModes` in `acp-backend.ts`, checked at the spawn seam.
  const permissionMode = optionalString(request.permissionMode, 'permissionMode', 128);
  const allowedTools = stringList(request.allowedTools, 'allowedTools');
  const disallowedTools = stringList(request.disallowedTools, 'disallowedTools');
  let sessionEnv;
  if (request.sessionEnv !== undefined) {
    if (!isObject(request.sessionEnv)) throw new Error('invalid sessionEnv');
    const entries = Object.entries(request.sessionEnv);
    if (
      entries.length > 8 ||
      entries.some(
        ([key, value]) =>
          !['VERITY_SESSION_BACKEND', 'VERITY_SESSION_MODEL', 'VERITY_SESSION_ID'].includes(key) ||
          typeof value !== 'string' ||
          value.length > 256,
      )
    ) {
      throw new Error('invalid sessionEnv');
    }
    sessionEnv = Object.fromEntries(entries);
  }
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 86_400_000)
  ) {
    throw new Error('invalid timeoutMs');
  }
  return {
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    kind: 'start-turn',
    turnId: request.turnId,
    startCommandId: request.startCommandId,
    sessionId: request.sessionId,
    backend: request.backend,
    worktree,
    cwd,
    prompt: request.prompt,
    ...(attachments !== undefined ? { attachments } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    steerable: request.steerable === true,
    permissionControl: request.permissionControl === true,
    trustedCliExecution: request.trustedCliExecution === true,
    ...(request.knowledgeIsolation ? { knowledgeIsolation: true } : {}),
    ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(mcpGatewayToken !== undefined ? { mcpGatewayToken } : {}),
    ...(mcpProxyToken !== undefined ? { mcpProxyToken } : {}),
    ...(turnCapability !== undefined ? { turnCapability } : {}),
    ...(gitAuthor !== undefined ? { gitAuthor } : {}),
    ...(request.signCommits === false ? { signCommits: false } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(sessionEnv !== undefined ? { sessionEnv } : {}),
  };
}

export async function updateTurnState(runtimeDir, turnId, patch) {
  const current = await readTurnState(runtimeDir, turnId);
  if (current === undefined) throw new Error(`missing state for ${turnId}`);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await writeJsonAtomic(join(runtimeDir, 'turns', turnId, 'state.json'), next);
  return next;
}
