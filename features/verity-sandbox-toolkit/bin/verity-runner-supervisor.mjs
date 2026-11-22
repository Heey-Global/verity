#!/usr/bin/env node

// features/verity-sandbox-toolkit/src/runner-supervisor/main.mjs
import { resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// features/verity-sandbox-toolkit/src/runner-supervisor/protocol.mjs
import { createHash as createHash2 } from "node:crypto";
import { spawn as spawn2 } from "node:child_process";
import { accessSync, constants as constants2, statSync } from "node:fs";
import { createConnection } from "node:net";
import { constants as osConstants } from "node:os";
import { lstat as lstat2, open as open2, readFile as readFile2, rm as rm2 } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { TextDecoder } from "node:util";

// features/verity-sandbox-toolkit/src/runner-supervisor/turn-state.mjs
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { URL } from "node:url";
async function settleMissingWorkerTurn(runtimeDir, turnId) {
  const state = await readTurnState(runtimeDir, turnId);
  if (state === void 0 || state.status === "settled") return;
  const aborted = await cancelExplainsSettlement(runtimeDir, turnId);
  const workerError = aborted ? CANCELLED_MISSING_WORKER_ERROR : MISSING_WORKER_ERROR;
  if (typeof state.runnerInstanceId === "string") {
    await writeSyntheticTerminalFrame(join(runtimeDir, "turns", turnId), {
      turnId,
      runnerInstanceId: state.runnerInstanceId,
      // SIGTERM only for the cancelled half: it derives exit 143, which the Server
      // reads as "the operator interrupted this" — true here, and a false accusation
      // for a worker that simply vanished.
      ...aborted ? { workerSignal: "SIGTERM" } : {},
      workerError,
      aborted
    }).catch(() => void 0);
  }
  await updateTurnState(runtimeDir, turnId, {
    status: "settled",
    ...aborted ? { workerSignal: "SIGTERM" } : {},
    workerError
  });
}
function supervisorRequestTimeoutMs(request) {
  return (isObject(request) && request.kind === "run-trusted-cli" ? TRUSTED_CLI_TIMEOUT_MS + TRUSTED_CLI_KILL_GRACE_MS : DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS) + SUPERVISOR_REQUEST_GRACE_MS;
}
async function processStartTime(pid) {
  const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => void 0);
  if (stat === void 0) return void 0;
  const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  return afterCommand[19];
}
async function writeJsonAtomic(path, value, mode = 432) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(`${JSON.stringify(value)}
`);
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
async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function acquireFileLock(path) {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    432
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
    throw new Error("runner lock is not a regular file");
  }
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
      stdio: ["ignore", "ignore", "pipe", handle.fd]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectResult);
    child.once("close", (code, signal) => resolveResult({ code, signal, stderr }));
  }).catch(async (error) => {
    await handle.close();
    throw error;
  });
  if (result.code !== 0) {
    await handle.close();
    const busy = result.code === 75 && result.signal === null;
    const error = new Error(
      busy ? "runner supervisor is already claimed" : result.stderr.trim().length > 0 ? `runner supervisor lock failed: ${result.stderr.trim()}` : `runner supervisor lock failed with ${result.signal ?? `code ${String(result.code)}`}`
    );
    if (busy) error.code = "ELOCKED";
    throw error;
  }
  return handle;
}
function isLockBusy(error) {
  return error?.code === "ELOCKED";
}
function stdioWithWorkerLock(lockFd) {
  return ["pipe", "pipe", "pipe", lockFd];
}
function boundedWorkerError(value) {
  const redacted = redactWorkerError(String(value)).trim();
  if (redacted.length === 0) return "";
  const allowlistedDiagnostics = [
    { pattern: /\bnot logged in\b/i, message: "worker stderr reported: not logged in" },
    {
      pattern: /\b(?:authentication failed|unauthorized|invalid credentials?)\b/i,
      message: "worker stderr reported an authentication failure"
    },
    { pattern: /\bforbidden\b/i, message: "worker stderr reported: forbidden" },
    {
      pattern: /\bpermission denied\b/i,
      message: "worker stderr reported: permission denied"
    },
    {
      pattern: /\b(?:could not resolve host|name or service not known)\b/i,
      message: "worker stderr reported a DNS resolution failure"
    },
    {
      pattern: /\bconnection (?:refused|reset)\b/i,
      message: "worker stderr reported a connection failure"
    },
    {
      pattern: /\b(?:timed out|timeout)\b/i,
      message: "worker stderr reported a timeout"
    },
    {
      pattern: /\b(?:no such file or directory|command not found|module not found)\b/i,
      message: "worker stderr reported a missing executable or module"
    }
  ];
  const diagnostic = allowlistedDiagnostics.find(({ pattern }) => pattern.test(redacted));
  if (diagnostic !== void 0) return diagnostic.message;
  const errorCode = redacted.match(/\b(?:E[A-Z]{2,20}|HTTP [45]\d\d)\b/)?.[0];
  return errorCode === void 0 ? "worker stderr reported an unrecognized failure" : `worker stderr reported error code ${errorCode}`;
}
function boundedSpawnError(value) {
  const message = String(value);
  if (/^runner worker (?:is not installed|has no private (?:attestation|attestation acknowledgement|error) pipe)$/.test(
    message
  )) {
    return message;
  }
  const errorCode = message.match(/\bE[A-Z]{2,20}\b/)?.[0];
  return errorCode === void 0 ? "runner worker spawn failed" : `runner worker spawn failed with error code ${errorCode}`;
}
function describeSpawnFailure(message, diagnostic) {
  if (diagnostic.stage === "spawn" && diagnostic.path === void 0) return message;
  if (diagnostic.path === void 0) return `${message} (${diagnostic.stage})`;
  const path = diagnostic.path.replace(/[\u0000-\u001f\u007f]/g, "?");
  const shown = path.length > MAX_SPAWN_FAILURE_PATH ? `${path.slice(0, MAX_SPAWN_FAILURE_PATH)}\u2026` : path;
  return `${message} (${diagnostic.stage}: ${shown})`;
}
var MAX_SPAWN_FAILURE_PATH = 512;
function spawnFailureDiagnostic(error, request, workerCommand) {
  const code = typeof error?.code === "string" && /^E[A-Z]{2,20}$/.test(error.code) ? error.code : void 0;
  const declared = error?.veritySpawnDiagnostic;
  if (isObject(declared) && ["cwd-traverse", "worker-executable", "spawn"].includes(declared.stage) && ["cwd", "worker-executable", "unknown"].includes(declared.target)) {
    return {
      stage: declared.stage,
      target: declared.target,
      ...declared.target === "cwd" ? { path: request.cwd } : {},
      ...declared.target === "worker-executable" ? { path: declared.path ?? resolve(request.cwd, workerCommand) } : {},
      ...code !== void 0 ? { code } : {}
    };
  }
  const target = error?.path === workerCommand ? "worker-executable" : "unknown";
  return {
    stage: "spawn",
    target,
    ...target === "worker-executable" ? { path: resolve(request.cwd, workerCommand) } : {},
    ...code !== void 0 ? { code } : {}
  };
}
async function assertSpawnBoundary(request, workerCommand, workerPath) {
  try {
    await access(request.cwd, constants.X_OK);
  } catch (error2) {
    error2.veritySpawnDiagnostic = { stage: "cwd-traverse", target: "cwd" };
    throw error2;
  }
  const candidates = workerCommand.includes("/") ? [resolve(request.cwd, workerCommand)] : (workerPath ?? "").split(delimiter).map((entry) => resolve(request.cwd, entry, workerCommand));
  let lastError;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return;
    } catch (error2) {
      lastError = error2;
    }
  }
  const error = lastError ?? Object.assign(new Error("worker executable is not on PATH"), { code: "ENOENT" });
  error.veritySpawnDiagnostic = {
    stage: "worker-executable",
    target: "worker-executable",
    path: candidates[0] ?? resolve(request.cwd, workerCommand)
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
    /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g
  ];
  let redacted = value.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "\uFFFD");
  for (const pattern of credentialPatterns) redacted = redacted.replace(pattern, "[REDACTED]");
  redacted = redacted.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi,
    "$1: [REDACTED]"
  );
  redacted = redacted.replace(
    /(["']?(?:authorization|proxy-authorization|cookie|set-cookie|password|token|secret|api[_-]?key)["']?\s*:\s*["'])[^"']+(["'])/gi,
    "$1[REDACTED]$2"
  );
  redacted = redacted.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@");
  redacted = redacted.replace(
    /([?&](?:access_token|api_key|token|signature|x-amz-signature)=)[^&\s]+/gi,
    "$1[REDACTED]"
  );
  redacted = redacted.replace(
    /\b((?:database_url|redis_url|mongodb_uri)|[a-z0-9_]*(?:token|secret|password|api[_-]?key|cookie))\s*=\s*[^\s]+/gi,
    "$1=[REDACTED]"
  );
  redacted = redacted.replace(
    /(\s--(?:access-token|token|secret|password|api-key|cookie)(?:=|\s+))[^\s]+/gi,
    "$1[REDACTED]"
  );
  return redacted;
}
function createWorkerErrorCapture() {
  const privateKeyMarkers = ["", "OPENSSH ", "RSA ", "EC "].flatMap((kind) => [
    { bytes: Buffer.from(["-----BEGIN ", `${kind}PRIVATE KEY-----`].join("")), begins: true },
    { bytes: Buffer.from(["-----END ", `${kind}PRIVATE KEY-----`].join("")), begins: false }
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
    const text = line.toString("utf8");
    const beginsPrivateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text);
    const endsPrivateKey = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(text);
    if (oversizedLine || privateKeyBlock || beginsPrivateKey) {
      appendOutput(`[REDACTED]${terminated ? "\n" : ""}`);
    } else {
      appendOutput(`${redactWorkerError(text)}${terminated ? "\n" : ""}`);
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
      for (; ; ) {
        const newline = bytes.indexOf(10, offset);
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
    }
  };
}
function validateRuntimeStats(stats, expected = {}) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("runner runtime is not a real directory");
  }
  const uid = expected.uid ?? process.getuid?.();
  const gid = expected.gid ?? process.getgid?.();
  if (gid !== void 0 && stats.gid !== gid) {
    throw new Error(`runner runtime gid mismatch: expected ${gid}, got ${stats.gid}`);
  }
  const mode = stats.mode & 511;
  if (uid !== void 0) {
    const runnerOwned = stats.uid === uid;
    const serverOwned = !runnerOwned && (mode & 384) === 0;
    if (!runnerOwned && !serverOwned) {
      throw new Error(
        `runner runtime uid mismatch: expected ${uid} or server-owned group-only, got ${stats.uid}`
      );
    }
    if (runnerOwned && (mode & 448) !== 448) {
      throw new Error(
        `runner-owned runtime must be owner/group-only and writable (0770): ${mode.toString(8)}`
      );
    }
  }
  if ((mode & 7) !== 0 || (mode & 56) !== 56) {
    throw new Error(
      `runner runtime must be group-only and writable by the runtime group: ${mode.toString(8)}`
    );
  }
}
async function validateRuntimeDirectory(runtimeDir, expected = {}) {
  const stats = await lstat(runtimeDir);
  try {
    validateRuntimeStats(stats, expected);
  } catch (error) {
    if (error instanceof Error && error.message === "runner runtime is not a real directory") {
      throw new Error(`runner runtime is not a real directory: ${runtimeDir}`, { cause: error });
    }
    throw error;
  }
}
async function acquireSingleton(runtimeDir, instanceId = randomUUID()) {
  const lockPath = join(runtimeDir, "supervisor.lock");
  const ownerPath = join(runtimeDir, "supervisor.lock.json");
  const lockHandle = await acquireFileLock(lockPath);
  const owner = {
    pid: process.pid,
    processStartTime: await processStartTime(process.pid),
    instanceId
  };
  try {
    await writeJsonAtomic(ownerPath, owner);
    await chmod(lockPath, 432);
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
      const currentOwner = await readFile(ownerPath, "utf8").catch(() => void 0);
      let currentInstanceId;
      try {
        currentInstanceId = currentOwner === void 0 ? void 0 : JSON.parse(currentOwner).instanceId;
      } catch {
        currentInstanceId = void 0;
      }
      try {
        if (currentInstanceId === instanceId) {
          await rm(ownerPath, { force: true });
        }
      } finally {
        await lockHandle.close();
      }
    }
  };
}
async function readTurnState(runtimeDir, turnId) {
  if (!SAFE_ID.test(turnId)) throw new Error("invalid turnId");
  const path = join(runtimeDir, "turns", turnId, "state.json");
  const stats = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return void 0;
    throw error;
  });
  if (stats === void 0) return void 0;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024)
    throw new Error(`invalid state file for ${turnId}`);
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return void 0;
    throw error;
  });
  if (raw === void 0) return void 0;
  const parsed = JSON.parse(raw);
  if (!isObject(parsed) || parsed.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION || parsed.turnId !== turnId || typeof parsed.startCommandId !== "string" || !SAFE_ID.test(parsed.startCommandId) || typeof parsed.runnerInstanceId !== "string" || !SAFE_ID.test(parsed.runnerInstanceId) || parsed.sessionId !== void 0 && (typeof parsed.sessionId !== "string" || !SAFE_ID.test(parsed.sessionId)) || !["claimed", "running", "settled"].includes(parsed.status) || typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt) || typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt) || parsed.workerLock !== void 0 && parsed.workerLock !== true || parsed.trustedCliExecution !== void 0 && parsed.trustedCliExecution !== true || parsed.cwd !== void 0 && (typeof parsed.cwd !== "string" || !parsed.cwd.startsWith("/")) || parsed.workerExitCode !== void 0 && parsed.workerExitCode !== null && !Number.isInteger(parsed.workerExitCode) || parsed.workerError !== void 0 && (typeof parsed.workerError !== "string" || Buffer.byteLength(parsed.workerError) > MAX_WORKER_ERROR_BYTES) || parsed.workerSpawnFailure !== void 0 && (!isObject(parsed.workerSpawnFailure) || !["cwd-traverse", "worker-executable", "spawn"].includes(parsed.workerSpawnFailure.stage) || !["cwd", "worker-executable", "unknown"].includes(parsed.workerSpawnFailure.target) || parsed.workerSpawnFailure.path !== void 0 && (typeof parsed.workerSpawnFailure.path !== "string" || !parsed.workerSpawnFailure.path.startsWith("/")) || parsed.workerSpawnFailure.code !== void 0 && (typeof parsed.workerSpawnFailure.code !== "string" || !/^E[A-Z]{2,20}$/.test(parsed.workerSpawnFailure.code)))) {
    throw new Error(`invalid state for ${turnId}`);
  }
  return parsed;
}
var cacheClaimEpochs = /* @__PURE__ */ new Map();
var cacheScans = /* @__PURE__ */ new Map();
var activeCacheClaims = /* @__PURE__ */ new Map();
var cacheFinalAdmissions = /* @__PURE__ */ new Map();
async function claimTurn(runtimeDir, request, runnerInstanceId) {
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
  if (typeof turnId !== "string" || !SAFE_ID.test(turnId)) throw new Error("invalid turnId");
  if (typeof startCommandId !== "string" || !SAFE_ID.test(startCommandId)) {
    throw new Error("invalid startCommandId");
  }
  if (sessionId !== void 0 && (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)))
    throw new Error("invalid sessionId");
  const turnsDir = join(runtimeDir, "turns");
  const turnDir = join(turnsDir, turnId);
  const createdTurnsPath = await mkdir(turnsDir, { recursive: true, mode: 504 });
  await chmod(turnsDir, 504);
  if (createdTurnsPath !== void 0) await syncDirectory(runtimeDir);
  let created = false;
  try {
    await mkdir(turnDir, { mode: 504 });
    await chmod(turnDir, 504);
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (created) {
    const now = Date.now();
    const state2 = {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      turnId,
      startCommandId,
      runnerInstanceId,
      ...sessionId === void 0 ? {} : { sessionId },
      status: "claimed",
      createdAt: now,
      updatedAt: now
    };
    await writeJsonAtomic(join(turnDir, "state.json"), state2);
    await syncDirectory(turnsDir);
    return { outcome: "created", state: state2 };
  }
  const turnStats = await lstat(turnDir);
  if (!turnStats.isDirectory() || turnStats.isSymbolicLink()) {
    return { outcome: "ambiguous", reason: "invalid-turn-directory" };
  }
  const state = await readTurnState(runtimeDir, turnId);
  if (state === void 0) {
    return { outcome: "ambiguous", reason: "turn-directory-without-state" };
  }
  if (state.sessionId !== void 0 && state.sessionId !== sessionId) {
    return { outcome: "conflict", reason: "session-identity-mismatch", state };
  }
  if (state.startCommandId !== startCommandId) {
    return { outcome: "conflict", reason: "start-command-mismatch", state };
  }
  if (state.status !== "settled" && state.runnerInstanceId !== runnerInstanceId) {
    return { outcome: "ambiguous", reason: "runner-instance-mismatch", state };
  }
  return {
    outcome: state.status === "settled" ? "terminal" : "already-running",
    state
  };
}
function validateImageReferences(value, cwd, turnId) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.length > MAX_START_ATTACHMENTS) {
    throw new Error("invalid attachments");
  }
  return value.map((item) => {
    if (!isObject(item) || item.kind !== "image" || !IMAGE_MEDIA_TYPES.has(item.mediaType) || typeof item.filePath !== "string" || !Number.isSafeInteger(item.byteSize) || item.byteSize < 1 || item.byteSize > 75e5 || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256))
      throw new Error("invalid attachment");
    const root = join(cwd, ".verity-sessions", "attachments", `turn-${turnId}`);
    const name = item.filePath.slice(root.length + 1);
    if (!item.filePath.startsWith(`${root}/`) || !/^[\w.-]+$/u.test(name) || name === "." || name === "..") {
      throw new Error("invalid attachment path");
    }
    const handles = [];
    try {
      if (lstatSync(cwd).isSymbolicLink()) throw new Error("invalid attachment directory");
      let directory = openSync(
        cwd,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      handles.push(directory);
      for (const part of [".verity-sessions", "attachments", `turn-${turnId}`]) {
        if (lstatSync(join(`/proc/self/fd/${directory}`, part)).isSymbolicLink())
          throw new Error("invalid attachment directory");
        directory = openSync(
          join(`/proc/self/fd/${directory}`, part),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        handles.push(directory);
      }
      if (lstatSync(join(`/proc/self/fd/${directory}`, name)).isSymbolicLink())
        throw new Error("invalid attachment file");
      const file = openSync(
        join(`/proc/self/fd/${directory}`, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      handles.push(file);
      const stats = fstatSync(file);
      if (!stats.isFile() || stats.size !== item.byteSize)
        throw new Error("invalid attachment size");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(item.byteSize, 64 * 1024));
      let offset = 0;
      while (offset < item.byteSize) {
        const count = readSync(
          file,
          buffer,
          0,
          Math.min(buffer.length, item.byteSize - offset),
          offset
        );
        if (count === 0) throw new Error("invalid attachment size");
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
      if (fstatSync(file).size !== item.byteSize || hash.digest("hex") !== item.sha256) {
        throw new Error("invalid attachment checksum");
      }
    } catch (error) {
      throw new Error("invalid attachment reference", { cause: error });
    } finally {
      for (const handle of handles.reverse()) closeSync(handle);
    }
    return {
      kind: "image",
      mediaType: item.mediaType,
      filePath: item.filePath,
      byteSize: item.byteSize,
      sha256: item.sha256
    };
  });
}
function validateStartTurnRequest(request) {
  if (!isObject(request) || request.kind !== "start-turn") throw new Error("invalid start request");
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_START_REQUEST_BYTES) {
    throw new Error("start request exceeds supervisor limit");
  }
  if (!SAFE_ID.test(request.turnId ?? "")) throw new Error("invalid turnId");
  if (!SAFE_ID.test(request.startCommandId ?? "")) throw new Error("invalid startCommandId");
  if (!SAFE_ID.test(request.sessionId ?? "")) throw new Error("invalid sessionId");
  if (!WORKER_BACKENDS.has(request.backend)) throw new Error("invalid worker backend");
  if (typeof request.worktree !== "string" || !request.worktree.startsWith("/")) {
    throw new Error("invalid worktree");
  }
  if (typeof request.cwd !== "string" || !request.cwd.startsWith("/"))
    throw new Error("invalid cwd");
  const worktree = resolve(request.worktree);
  const cwd = resolve(request.cwd);
  if (cwd !== worktree && !cwd.startsWith(`${worktree}/`)) throw new Error("cwd outside worktree");
  if (typeof request.prompt !== "string" || Buffer.byteLength(request.prompt) > 1024 * 1024) {
    throw new Error("invalid prompt");
  }
  if (request.model !== void 0 && (typeof request.model !== "string" || request.model.length > 256)) {
    throw new Error("invalid model");
  }
  const optionalString = (value, name, maxBytes) => {
    if (value === void 0) return void 0;
    if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) {
      throw new Error(`invalid ${name}`);
    }
    return value;
  };
  const stringList = (value, name) => {
    if (value === void 0) return void 0;
    if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== "string" || Buffer.byteLength(item) > 4096)) {
      throw new Error(`invalid ${name}`);
    }
    return value;
  };
  const attachments = validateImageReferences(request.attachments, cwd, request.turnId);
  const appendSystemPrompt = optionalString(
    request.appendSystemPrompt,
    "appendSystemPrompt",
    1048576
  );
  const resumeSessionId = optionalString(request.resumeSessionId, "resumeSessionId", 256);
  const mcpGatewayToken = optionalString(request.mcpGatewayToken, "mcpGatewayToken", 512);
  if (mcpGatewayToken !== void 0 && (mcpGatewayToken === "" || !ACP_WORKER_BACKENDS.has(request.backend))) {
    throw new Error("invalid mcpGatewayToken");
  }
  const mcpProxyToken = optionalString(request.mcpProxyToken, "mcpProxyToken", 512);
  if (mcpProxyToken === "") throw new Error("invalid mcpProxyToken");
  const turnCapability = optionalString(request.turnCapability, "turnCapability", 43);
  if (turnCapability !== void 0 && !TURN_CAPABILITY_PATTERN.test(turnCapability)) {
    throw new Error("invalid turnCapability");
  }
  if (request.gitAuthor !== void 0 && !isGitAuthor(request.gitAuthor)) {
    throw new Error("invalid gitAuthor");
  }
  if (request.signCommits !== void 0 && request.signCommits !== false) {
    throw new Error("invalid signCommits");
  }
  const gitAuthor = request.gitAuthor === void 0 ? void 0 : { name: request.gitAuthor.name, email: request.gitAuthor.email };
  let mcpServers;
  if (request.mcpServers !== void 0) {
    if (!Array.isArray(request.mcpServers) || request.mcpServers.length > 16) {
      throw new Error("invalid mcpServers");
    }
    mcpServers = request.mcpServers.map((server) => {
      if (!isObject(server)) throw new Error("invalid mcpServers");
      const name = optionalString(server.name, "mcpServers.name", 128);
      const url = optionalString(server.url, "mcpServers.url", 4096);
      if (name === void 0 || name === "" || url === void 0 || url === "") {
        throw new Error("invalid mcpServers");
      }
      if (url !== "verity-internal://mcp-proxy") {
        try {
          if (!["http:", "https:"].includes(new URL(url).protocol)) {
            throw new Error("invalid scheme");
          }
        } catch {
          throw new Error("invalid mcpServers");
        }
      }
      if (!Array.isArray(server.headers) || server.headers.length > 32) {
        throw new Error("invalid mcpServers");
      }
      const headers = server.headers.map((header) => {
        if (!isObject(header)) throw new Error("invalid mcpServers");
        const headerName = optionalString(header.name, "mcpServers.headers.name", 256);
        const value = optionalString(header.value, "mcpServers.headers.value", 4096);
        if (headerName === void 0 || headerName === "" || value === void 0) {
          throw new Error("invalid mcpServers");
        }
        return { name: headerName, value };
      });
      return { name, url, headers };
    });
  }
  if (request.knowledgeIsolation !== void 0 && typeof request.knowledgeIsolation !== "boolean")
    throw new Error("invalid knowledgeIsolation");
  if (request.knowledgeIsolation && (request.resumeSessionId || request.trustedCliExecution || request.mcpProxyToken || request.mcpServers?.length))
    throw new Error("Isolated Wiki jobs cannot inherit context or external tools");
  if (request.trustedCliExecution === true && !ACP_WORKER_BACKENDS.has(request.backend)) {
    throw new Error("invalid trustedCliExecution");
  }
  const permissionMode = optionalString(request.permissionMode, "permissionMode", 128);
  const allowedTools = stringList(request.allowedTools, "allowedTools");
  const disallowedTools = stringList(request.disallowedTools, "disallowedTools");
  let sessionEnv;
  if (request.sessionEnv !== void 0) {
    if (!isObject(request.sessionEnv)) throw new Error("invalid sessionEnv");
    const entries = Object.entries(request.sessionEnv);
    if (entries.length > 8 || entries.some(
      ([key, value]) => !["VERITY_SESSION_BACKEND", "VERITY_SESSION_MODEL", "VERITY_SESSION_ID"].includes(key) || typeof value !== "string" || value.length > 256
    )) {
      throw new Error("invalid sessionEnv");
    }
    sessionEnv = Object.fromEntries(entries);
  }
  if (request.timeoutMs !== void 0 && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 864e5)) {
    throw new Error("invalid timeoutMs");
  }
  return {
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    kind: "start-turn",
    turnId: request.turnId,
    startCommandId: request.startCommandId,
    sessionId: request.sessionId,
    backend: request.backend,
    worktree,
    cwd,
    prompt: request.prompt,
    ...attachments !== void 0 ? { attachments } : {},
    ...request.model !== void 0 ? { model: request.model } : {},
    steerable: request.steerable === true,
    permissionControl: request.permissionControl === true,
    trustedCliExecution: request.trustedCliExecution === true,
    ...request.knowledgeIsolation ? { knowledgeIsolation: true } : {},
    ...appendSystemPrompt !== void 0 ? { appendSystemPrompt } : {},
    ...resumeSessionId !== void 0 ? { resumeSessionId } : {},
    ...mcpGatewayToken !== void 0 ? { mcpGatewayToken } : {},
    ...mcpProxyToken !== void 0 ? { mcpProxyToken } : {},
    ...turnCapability !== void 0 ? { turnCapability } : {},
    ...gitAuthor !== void 0 ? { gitAuthor } : {},
    ...request.signCommits === false ? { signCommits: false } : {},
    ...mcpServers !== void 0 ? { mcpServers } : {},
    ...permissionMode !== void 0 ? { permissionMode } : {},
    ...allowedTools !== void 0 ? { allowedTools } : {},
    ...disallowedTools !== void 0 ? { disallowedTools } : {},
    ...request.timeoutMs !== void 0 ? { timeoutMs: request.timeoutMs } : {},
    ...sessionEnv !== void 0 ? { sessionEnv } : {}
  };
}
async function updateTurnState(runtimeDir, turnId, patch) {
  const current = await readTurnState(runtimeDir, turnId);
  if (current === void 0) throw new Error(`missing state for ${turnId}`);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await writeJsonAtomic(join(runtimeDir, "turns", turnId, "state.json"), next);
  return next;
}

// features/verity-sandbox-toolkit/src/runner-supervisor/protocol.mjs
async function installedSkillsManifestHash(seedRoot = "/opt/agent-seed") {
  try {
    if (!(await lstat2(join2(seedRoot, "bin/verity"))).isFile()) return void 0;
    const bytes = await readFile2(join2(seedRoot, "skills-manifest.json"));
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (createHash2("sha256").update(await readFile2(join2(seedRoot, "bin/verity"))).digest("hex") !== manifest.dispatcher)
      return void 0;
    if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== "object")
      return void 0;
    const files = Object.entries(manifest.files);
    if (!files.length) return void 0;
    for (const [path, digest] of files) {
      if (!/^[a-z]+(?:-[a-z]+)*\/SKILL\.md$/.test(path) || typeof digest !== "string")
        return void 0;
      const target = join2(seedRoot, "skills", path);
      if (!(await lstat2(dirname2(target))).isDirectory() || !(await lstat2(target)).isFile())
        return void 0;
      if (createHash2("sha256").update(await readFile2(target)).digest("hex") !== digest)
        return void 0;
    }
    return createHash2("sha256").update(bytes).digest("hex");
  } catch {
    return void 0;
  }
}
async function installedSkillsVersion(seedRoot = "/opt/agent-seed") {
  return await installedSkillsManifestHash(seedRoot) ? 1 : 0;
}
var SUPERVISOR_PROTOCOL_VERSION = 1;
var MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION = 1;
function supportedRequestVersion(value) {
  return Number.isInteger(value) && value >= MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION && value <= SUPERVISOR_PROTOCOL_VERSION;
}
var DEFAULT_RUNTIME_DIR = "/run/verity-runner";
var DEFAULT_SCRIPT_SANDBOX_PATH = "/usr/local/bin/verity-script-sandbox";
var SCRIPT_ISOLATION_UNAVAILABLE_ERROR = "worktree script isolation is unavailable";
var SCRIPT_SANDBOX_PROBE_TIMEOUT_MS = 1e4;
async function probeScriptSandbox(helperPath = DEFAULT_SCRIPT_SANDBOX_PATH, timeoutMs = SCRIPT_SANDBOX_PROBE_TIMEOUT_MS) {
  return await new Promise((resolveProbe) => {
    let child;
    try {
      child = spawn2(helperPath, ["--probe"], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: timeoutMs
      });
    } catch {
      resolveProbe({ available: false, reason: "script sandbox helper could not be started" });
      return;
    }
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 512) stderr += chunk;
    });
    child.once(
      "error",
      () => resolveProbe({ available: false, reason: "script sandbox helper could not be started" })
    );
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveProbe({ available: true });
        return;
      }
      const line = stderr.split("\n", 1)[0].trim().slice(0, 256);
      resolveProbe({
        available: false,
        reason: line !== "" ? line : `script sandbox probe exited with ${signal === null ? `code ${String(code)}` : signal}`
      });
    });
  });
}
var MAX_START_REQUEST_BYTES = 4 * 1024 * 1024;
var MAX_CONTROL_LINE_BYTES = MAX_START_REQUEST_BYTES + 1;
var OVERSIZE_DRAIN_GRACE_MS = 2e3;
var TURN_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
function isGitAuthor(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { name, email } = value;
  return Object.keys(value).length === 2 && typeof name === "string" && typeof email === "string" && name.trim().length > 0 && Buffer.byteLength(name) <= 200 && // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  /^[^\u0000-\u001f\u007f<>]+$/u.test(name) && Buffer.byteLength(email) <= 320 && // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  /^[^\s\u0000-\u001f\u007f<>@]+@[^\s\u0000-\u001f\u007f<>@]+$/u.test(email);
}
var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var DEFAULT_SUPERVISOR_REQUEST_TIMEOUT_MS = 15 * 60 * 1e3;
var WORKER_BACKENDS = /* @__PURE__ */ new Set(["claude-acp", "codex-acp", "opencode-acp"]);
var ACP_WORKER_BACKENDS = /* @__PURE__ */ new Set(["claude-acp", "codex-acp", "opencode-acp"]);
var SUPERVISED_WORKER_BACKENDS = Object.freeze([
  "claude-acp",
  "codex-acp",
  "opencode-acp"
]);
var WORKER_BACKEND_EXECUTABLES = Object.freeze({
  "claude-acp": "/usr/local/bin/claude-agent-acp",
  "codex-acp": "/usr/local/bin/codex-acp",
  "opencode-acp": "/usr/local/bin/opencode-acp"
});
function installedWorkerBackends(executable = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants2.X_OK);
    return true;
  } catch {
    return false;
  }
}) {
  return SUPERVISED_WORKER_BACKENDS.filter(
    (backend) => executable(WORKER_BACKEND_EXECUTABLES[backend])
  );
}
function supervisorWorkerEnv(environment) {
  const brokerSocket = environment.VERITY_AGENT_SPAWN_BROKER_SOCKET;
  const mcpGatewayUrl = environment.VERITY_MCP_GATEWAY_URL;
  const controlMemoryUrl = environment.VERITY_CONTROL_MEMORY_URL;
  return {
    ...controlMemoryUrl === void 0 || controlMemoryUrl === "" ? {} : { VERITY_CONTROL_MEMORY_URL: controlMemoryUrl },
    ...brokerSocket === void 0 || brokerSocket === "" ? {} : { VERITY_AGENT_SPAWN_BROKER_SOCKET: brokerSocket },
    ...mcpGatewayUrl === void 0 || mcpGatewayUrl === "" ? {} : { VERITY_MCP_GATEWAY_URL: mcpGatewayUrl }
  };
}
var IMAGE_MEDIA_TYPES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
var MAX_START_ATTACHMENTS = 8;
var MAX_WORKER_ERROR_BYTES = 16 * 1024;
var WORKER_ERROR_DRAIN_TIMEOUT_MS = 100;
var REJECTED_WORKER_EXIT_WAIT_MS = 2e3;
var MAX_TRUSTED_CLI_OUTPUT_BYTES = 24 * 1024;
var MAX_TRUSTED_CLI_SECRETS = 8;
var TRUSTED_CLI_TIMEOUT_MS = 30 * 60 * 1e3;
var TRUSTED_CLI_KILL_GRACE_MS = 5e3;
var SUPERVISOR_REQUEST_GRACE_MS = 1e4;
var MAX_CONCURRENT_STARTS = 4;
var MAX_QUEUED_STARTS = 64;
var SYNTHETIC_TERMINAL_FRAME_SEQ = 1;
var RUNNER_FRAME_PROTOCOL_VERSION = 1;
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function redactTrustedCliText(bytes, secrets) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "[output withheld: undecodable]";
  }
  const variants = (Array.isArray(secrets) ? secrets : [secrets]).flatMap((secret) => [
    secret,
    Buffer.from(secret, "utf8").toString("base64"),
    encodeURIComponent(secret)
  ]).filter((value) => typeof value === "string" && value.length > 0).sort((left, right) => right.length - left.length);
  for (const value of new Set(variants)) {
    text = text.split(value).join("[REDACTED]");
  }
  return text;
}
function isValidTrustedCliSecret(secret) {
  return isObject(secret) && typeof secret.secretAlias === "string" && /^[A-Z][A-Z0-9_]*$/u.test(secret.secretAlias) && typeof secret.env === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(secret.env) && typeof secret.secret === "string" && secret.secret.length > 0 && !secret.secret.includes("\0") && Buffer.byteLength(secret.secret) <= 1024 * 1024 && (secret.injection === void 0 || secret.injection === "env" || secret.injection === "file") && (secret.encoding === void 0 || secret.injection === "file" && secret.encoding === "base64");
}
function normalizeTrustedCliRequest(request) {
  if (!isObject(request) || Array.isArray(request.secrets) || typeof request.secret !== "string") {
    return request;
  }
  const { secret, secretAlias, env, injection, ...rest } = request;
  request.secret = "";
  return {
    ...rest,
    secrets: [{ secretAlias, env, ...injection === void 0 ? {} : { injection }, secret }]
  };
}
async function runTrustedCliViaBroker(rawRequest, options = {}) {
  const request = normalizeTrustedCliRequest(rawRequest);
  if (!isObject(request) || !SAFE_ID.test(request.turnId ?? "") || request.correlationId !== void 0 && !SAFE_ID.test(request.correlationId) || !Array.isArray(request.secrets) || request.secrets.length === 0 || request.secrets.length > MAX_TRUSTED_CLI_SECRETS || !request.secrets.every(isValidTrustedCliSecret) || // Duplicates would collide on one environment variable, and under file
  // injection on one path in the secret directory.
  new Set(request.secrets.map((secret) => secret.env)).size !== request.secrets.length || !Array.isArray(request.command) || request.command.length === 0 || request.command.length > 256 || request.command.some((part) => typeof part !== "string" || Buffer.byteLength(part) > 16384) || !request.command[0].startsWith("/") || request.entryScript !== void 0 && (!isObject(request.entryScript) || typeof request.entryScript.path !== "string" || !request.entryScript.path.startsWith("/") || typeof request.entryScript.projectPath !== "string" || request.entryScript.projectPath.startsWith("/") || request.entryScript.projectPath.split("/").some((component) => component === "" || component === "." || component === "..") || typeof request.entryScript.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(request.entryScript.sha256) || request.entryScript.loading !== "isolated" && request.entryScript.loading !== "dynamic")) {
    throw new Error("invalid trusted CLI request");
  }
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const persistedState = await readTurnState(runtimeDir, request.turnId);
  const startRequest = persistedState ?? JSON.parse(await readFile2(join2(runtimeDir, "turns", request.turnId, "request.json"), "utf8"));
  if (!isObject(startRequest) || startRequest.turnId !== request.turnId || startRequest.trustedCliExecution !== true || typeof startRequest.cwd !== "string") {
    throw new Error("trusted CLI is unavailable for this turn");
  }
  const socketPath = options.brokerSocket ?? process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET ?? "/run/verity-runner-broker/agent-spawn-broker.sock";
  if (options.authorize !== void 0 && await options.authorize(request) !== true) {
    throw new Error("trusted CLI turn capability is no longer active");
  }
  return await new Promise((resolveResult, rejectResult) => {
    const socket = createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let spawned = false;
    let settled = false;
    let truncated = false;
    let timedOut = false;
    const streaming = request.streamOutput === true && typeof options.onOutput === "function";
    const counts = { stdout: 0, stderr: 0 };
    let terminationReason = "process_exit";
    let terminationRequested = false;
    let processing = false;
    let ended = false;
    let killTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      const secrets = request.secrets.flatMap(
        (entry) => entry.encoding === "base64" ? [entry.secret, Buffer.from(entry.secret, "base64").toString("utf8")] : [entry.secret]
      );
      for (const entry of request.secrets) entry.secret = "";
      if (error !== void 0) rejectResult(error);
      else if (streaming) {
        resolveResult({
          exitCode: result.exitCode,
          stdout: "",
          stderr: "",
          outputMode: "stream-v1",
          ...result.exitCodeKnown === false ? { exitCodeKnown: false } : {},
          terminationReason,
          stdoutBytes: counts.stdout,
          stderrBytes: counts.stderr,
          ...terminationRequested ? { terminationRequested: true } : {},
          ...timedOut ? { timedOut: true } : {},
          ...truncated ? { truncated: true } : {}
        });
      } else if (truncated) {
        resolveResult({
          exitCode: result.exitCode,
          stdout: "[output withheld: truncated]",
          stderr: "[output withheld: truncated]",
          truncated: true,
          ...timedOut ? { timedOut: true } : {}
        });
      } else {
        const redacted = {
          exitCode: result.exitCode,
          stdout: redactTrustedCliText(Buffer.concat(stdout), secrets),
          stderr: redactTrustedCliText(Buffer.concat(stderr), secrets),
          ...timedOut ? { timedOut: true } : {}
        };
        if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > MAX_TRUSTED_CLI_OUTPUT_BYTES) {
          resolveResult({
            exitCode: result.exitCode,
            stdout: "[output withheld: truncated]",
            stderr: "[output withheld: truncated]",
            truncated: true,
            ...timedOut ? { timedOut: true } : {}
          });
        } else {
          resolveResult(redacted);
        }
      }
    };
    const signal = () => {
      if (spawned && !socket.destroyed) {
        terminationRequested = true;
        socket.write(
          `${JSON.stringify({ protocolVersion: 1, kind: "signal", signal: "SIGKILL" })}
`
        );
      }
    };
    const terminate = () => {
      signal();
      if (killTimer !== void 0) return;
      killTimer = setTimeout(
        () => finish(new Error("trusted CLI broker did not settle after SIGKILL")),
        options.killGraceMs ?? TRUSTED_CLI_KILL_GRACE_MS
      );
    };
    const abort = () => {
      terminationReason = "transport_failure";
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      terminationReason = "timeout";
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? TRUSTED_CLI_TIMEOUT_MS);
    socket.once("error", (error) => finish(error));
    socket.once("connect", async () => {
      if (options.signal?.aborted) {
        finish(new Error("trusted CLI output connection closed"));
        return;
      }
      try {
        if (options.authorize !== void 0 && await options.authorize(request) !== true) {
          finish(new Error("trusted CLI turn capability is no longer active"));
          return;
        }
      } catch (error) {
        finish(error);
        return;
      }
      socket.write(
        `${JSON.stringify({
          protocolVersion: 1,
          kind: "spawn-trusted-cli",
          ...request.correlationId === void 0 ? {} : { correlationId: request.correlationId },
          command: request.command[0],
          args: request.command.slice(1),
          ...request.entryScript === void 0 ? {} : { entryScript: request.entryScript },
          cwd: startRequest.cwd,
          secrets: request.secrets.map((entry) => ({
            name: entry.env,
            value: entry.secret,
            ...entry.injection === void 0 ? {} : { injection: entry.injection },
            ...entry.encoding === void 0 ? {} : { encoding: entry.encoding }
          }))
        })}
`
      );
    });
    socket.on("data", (chunk) => {
      socket.pause();
      processing = true;
      void (async () => {
        if (buffered.length + chunk.length > 256 * 1024) {
          terminationReason = "transport_failure";
          terminate();
          finish(new Error("trusted CLI broker frame too large"));
          return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        for (; ; ) {
          const newline = buffered.indexOf(10);
          if (newline < 0) break;
          const line = buffered.subarray(0, newline).toString("utf8");
          buffered = buffered.subarray(newline + 1);
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            finish(new Error("trusted CLI broker returned malformed JSON"));
            return;
          }
          if (frame.ok !== true) {
            const reason = typeof frame.error === "string" && frame.error !== "" ? frame.error : void 0;
            const failure = new Error(
              reason === void 0 ? "trusted CLI broker rejected execution" : `trusted CLI broker rejected execution: ${reason}`
            );
            if (isObject(frame.trustedCliFailure) && ["validation", "materialization", "launch-spec", "spawn"].includes(
              frame.trustedCliFailure.phase
            ) && typeof frame.trustedCliFailure.cause === "string") {
              failure.trustedCliFailure = frame.trustedCliFailure;
            }
            finish(failure);
            return;
          }
          if (frame.kind === "spawned") {
            if (!spawned) {
              spawned = true;
              try {
                options.onSpawned?.();
              } catch (error) {
                finish(error);
                return;
              }
            }
            if (timedOut || truncated || terminationReason !== "process_exit") signal();
            continue;
          }
          if (frame.kind === "stdout" || frame.kind === "stderr") {
            const bytes = Buffer.from(frame.data ?? "", "base64");
            if (streaming) {
              counts[frame.kind] += bytes.length;
              if (terminationReason !== "process_exit") {
                bytes.fill(0);
                continue;
              }
              if (counts.stdout + counts.stderr > 10 * 1024 * 1024) {
                terminationReason = "output_limit";
                truncated = true;
                bytes.fill(0);
                terminate();
                continue;
              }
              try {
                for (let offset = 0; offset < bytes.length; offset += 16384) {
                  await options.onOutput(frame.kind, bytes.subarray(offset, offset + 16384));
                  if (settled || terminationReason !== "process_exit") break;
                }
              } catch (error) {
                if (terminationReason === "process_exit") {
                  terminationReason = ["redaction_failure", "output_limit"].includes(
                    error?.outputFailure
                  ) ? error.outputFailure : "storage_failure";
                }
                truncated = true;
                terminate();
              } finally {
                bytes.fill(0);
              }
              continue;
            }
            if (outputBytes + bytes.length > MAX_TRUSTED_CLI_OUTPUT_BYTES) {
              truncated = true;
              terminate();
              continue;
            }
            outputBytes += bytes.length;
            (frame.kind === "stdout" ? stdout : stderr).push(bytes);
            continue;
          }
          if (frame.kind === "exit") {
            const exitCode = Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255 ? frame.code : 1;
            finish(void 0, {
              exitCode,
              exitCodeKnown: Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255
            });
          }
        }
      })().catch(() => {
        terminate();
        finish(new Error("trusted CLI output processing failed"));
      }).finally(() => {
        processing = false;
        if (ended && !settled) finish(new Error("trusted CLI broker closed before exit"));
        if (!settled) socket.resume();
      });
    });
    socket.once("end", () => {
      ended = true;
      if (!processing && !settled) finish(new Error("trusted CLI broker closed before exit"));
    });
  });
}
function logTelemetry(record) {
  try {
    process.stderr.write(`${JSON.stringify({ verity: "runner-supervisor", ...record })}
`);
  } catch {
  }
}
var eventLoopHistogram;
function sampleEventLoopDelay() {
  try {
    if (eventLoopHistogram === void 0) {
      eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
      eventLoopHistogram.enable();
      return void 0;
    }
    const mean = eventLoopHistogram.mean / 1e6;
    const max = eventLoopHistogram.max / 1e6;
    eventLoopHistogram.reset();
    if (!Number.isFinite(mean) || !Number.isFinite(max)) return void 0;
    return { mean: Math.round(mean * 100) / 100, max: Math.round(max * 100) / 100 };
  } catch {
    return void 0;
  }
}
function signalExitCode(signal) {
  const number = osConstants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}
async function writeSyntheticTerminalFrame(turnDir, detail) {
  const eventPath = join2(turnDir, "events.jsonl");
  const existing = await lstat2(eventPath).catch((error) => {
    if (error?.code === "ENOENT") return void 0;
    throw error;
  });
  if (existing !== void 0 && (!existing.isFile() || existing.size > 0 || existing.nlink > 1)) {
    return false;
  }
  const stderr = typeof detail.workerError === "string" ? detail.workerError : "";
  const body = {
    kind: "result",
    result: {
      // No `sessionId`. That field is the AGENT's conversation id, which only the
      // worker learns and only once the backend has opened the thread — a worker
      // that died before its first frame never had one. The Server persists a
      // failed turn's `result.sessionId` as the session's resume pointer
      // (`conductor.ts`), so putting the store's session id here would pin every
      // later turn to a thread the agent never issued. Absent means unknown, which
      // is the truth.
      // A clean exit with an EMPTY stream is still a failed turn: the worker did
      // none of the work and said nothing, so reporting the process's own `0` would
      // hand the Server a success it must then badge as running forever. The real
      // exit code stays in the turn state; this is the turn's verdict, not the
      // process's.
      exitCode: typeof detail.workerExitCode === "number" && detail.workerExitCode !== 0 ? detail.workerExitCode : detail.workerSignal != null ? signalExitCode(detail.workerSignal) : 1,
      stderr: stderr.length > 0 ? stderr : detail.workerSignal != null ? `runner worker terminated by signal ${detail.workerSignal} before producing any event` : detail.workerExitCode === 0 ? "runner worker exited successfully before producing any event" : "runner worker exited before producing any event",
      // A turn the operator cancelled is not a crash. Without this the SIGKILL that
      // ends the grace window reads as exit 137 and the session shows a failure for
      // something it was asked to do.
      aborted: detail.aborted === true
    }
  };
  const frame = {
    protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
    runnerInstanceId: detail.runnerInstanceId,
    turnId: detail.turnId,
    frameSeq: SYNTHETIC_TERMINAL_FRAME_SEQ,
    payloadHash: createHash2("sha256").update(JSON.stringify(body)).digest("hex"),
    ...body
  };
  const flags = constants2.O_RDWR | constants2.O_APPEND | constants2.O_NOFOLLOW | (existing === void 0 ? constants2.O_CREAT | constants2.O_EXCL : 0);
  const handle = await open2(eventPath, flags, 416).catch((error) => {
    if (error?.code === "EEXIST" || error?.code === "ELOOP" || error?.code === "ENOENT") {
      return void 0;
    }
    throw error;
  });
  if (handle === void 0) return false;
  let wrote = false;
  let owned = false;
  try {
    const fresh = await handle.stat();
    if (fresh.size > 0 || fresh.nlink > 1) return false;
    owned = true;
    const bytes = Buffer.from(`${JSON.stringify(frame)}
`, "utf8");
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length);
    if (bytesWritten !== bytes.length) return false;
    wrote = true;
    await handle.sync().catch(() => void 0);
    if (existing === void 0) await syncDirectory(turnDir).catch(() => void 0);
    return true;
  } finally {
    if (owned && !wrote) await handle.truncate(0).catch(() => void 0);
    await handle.close().catch(() => void 0);
    if (!wrote && existing === void 0) {
      await lstat2(eventPath).then(async (leftover) => {
        if (leftover.isFile() && leftover.size === 0) await rm2(eventPath, { force: true });
      }).catch(() => void 0);
    }
  }
}
var MISSING_WORKER_ERROR = "worker missing during supervisor recovery";
var CANCELLED_MISSING_WORKER_ERROR = "runner turn was cancelled; its worker did not survive the supervisor restart";
function cancelPath(runtimeDir, turnId) {
  return join2(runtimeDir, "cancellations", `${turnId}.json`);
}
async function readCancelTombstone(runtimeDir, turnId) {
  try {
    await readFile2(cancelPath(runtimeDir, turnId));
    return "cancelled";
  } catch (error) {
    return error?.code === "ENOENT" ? "absent" : "unknown";
  }
}
async function cancelExplainsSettlement(runtimeDir, turnId) {
  return await readCancelTombstone(runtimeDir, turnId) === "cancelled";
}

// features/verity-sandbox-toolkit/src/runner-supervisor/turns.mjs
import { spawn as spawn3 } from "node:child_process";
import { createConnection as createConnection3 } from "node:net";
import { lstat as lstat3, mkdir as mkdir2, readdir } from "node:fs/promises";
import { join as join4 } from "node:path";

// features/verity-sandbox-toolkit/src/spawn-broker/capacity-leases.mjs
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validateCapacityLeaseRequest(request) {
  if (request?.protocolVersion !== 1 || request.kind !== "capacity-lease" || !["create", "status", "retire"].includes(request.action) || typeof request.operationId !== "string" || !UUID.test(request.operationId) || typeof request.generation !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.generation))
    throw new Error("invalid capacity lease request");
}

// features/verity-sandbox-toolkit/src/runner-supervisor/requests.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
import { createConnection as createConnection2, createServer } from "node:net";
import { chmod as chmod2, opendir, rm as rm3 } from "node:fs/promises";
import { join as join3 } from "node:path";
import { setImmediate } from "node:timers";
async function reclaimPackageCachesPage(runtimeDir, request) {
  const fingerprint = JSON.stringify([request.sessionIds, request.maxBytes]);
  let scan = cacheScans.get(runtimeDir);
  if (request.scanId === void 0) {
    if (scan) await closeCacheScan(runtimeDir, scan);
    const directory = await opendir(join3(runtimeDir, "turns")).catch((error) => {
      if (error.code === "ENOENT") return void 0;
      throw cacheMaintenanceFailure("turn-inventory-unavailable");
    });
    scan = {
      id: randomUUID2(),
      fingerprint,
      directory,
      cursor: 0,
      epoch: cacheClaimEpochs.get(runtimeDir) ?? 0,
      busy: /* @__PURE__ */ new Set(),
      pending: [],
      counts: { missingState: 0, invalidState: 0, unsettledWithoutSession: 0 }
    };
    scan.timer = setTimeout(() => {
      void closeCacheScan(runtimeDir, scan);
    }, CACHE_SCAN_TTL_MS);
    scan.timer.unref?.();
    cacheScans.set(runtimeDir, scan);
  } else if (!scan || scan.id !== request.scanId || scan.fingerprint !== fingerprint) {
    throw cacheMaintenanceFailure("turn-inventory-unavailable");
  }
  try {
    scan.timer.refresh();
    if (scan.epoch !== (cacheClaimEpochs.get(runtimeDir) ?? 0))
      throw cacheMaintenanceFailure("turn-inventory-unavailable");
    if (request.scanId !== void 0) {
      if (!Array.isArray(request.turnOwners) || request.turnOwners.length > CACHE_SCAN_PAGE)
        throw new Error("invalid turn ownership response");
      const pending = new Map(scan.pending.map((turn) => [turn.turnId, turn]));
      const owners = /* @__PURE__ */ new Map();
      for (const owner of request.turnOwners) {
        if (!isObject(owner) || !pending.has(owner.turnId) || owners.has(owner.turnId) || typeof owner.conflict !== "boolean" || owner.sessionId !== void 0 && (typeof owner.sessionId !== "string" || !SAFE_ID.test(owner.sessionId)))
          throw new Error("invalid turn ownership response");
        owners.set(owner.turnId, owner);
      }
      for (const prior of scan.pending) {
        const current = await cacheTurnSummary(runtimeDir, prior.turnId);
        if (current.startCommandId !== prior.startCommandId || current.runnerInstanceId !== prior.runnerInstanceId)
          throw cacheMaintenanceFailure("turn-inventory-unavailable");
        if (current.status === "settled") continue;
        const owner = owners.get(prior.turnId);
        const sessionId = owner?.conflict ? void 0 : owner?.sessionId;
        if (sessionId !== void 0 && (current.sessionId === void 0 || current.sessionId === sessionId)) {
          if (request.sessionIds.includes(sessionId)) scan.busy.add(sessionId);
        } else {
          const key = current.reason === "missing-state" ? "missingState" : current.reason === "invalid-state" ? "invalidState" : "unsettledWithoutSession";
          scan.counts[key] = Math.min(1e6, scan.counts[key] + 1);
        }
      }
      scan.pending = [];
    }
    let done = scan.directory === void 0;
    for (let inspected = 0; !done && inspected < CACHE_SCAN_PAGE && scan.pending.length < 64; inspected++) {
      const entry = await scan.directory.read();
      if (entry === null) {
        done = true;
        break;
      }
      scan.cursor++;
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const turn = await cacheTurnSummary(runtimeDir, entry.name);
      if (turn.status === "settled") continue;
      if (turn.sessionId !== void 0) {
        if (request.sessionIds.includes(turn.sessionId)) scan.busy.add(turn.sessionId);
      } else scan.pending.push(turn);
    }
    if (!done || scan.pending.length > 0) {
      return {
        ok: true,
        maintenancePending: true,
        scanId: scan.id,
        cursor: String(scan.cursor),
        turnsNeedingOwnership: scan.pending
      };
    }
    if (scan.epoch !== (cacheClaimEpochs.get(runtimeDir) ?? 0))
      throw cacheMaintenanceFailure("turn-inventory-unavailable");
    const unknown = Object.values(scan.counts).some((count) => count > 0);
    let response;
    try {
      response = await withFinalCacheAdmission(runtimeDir, scan, async () => {
        const capabilities = await brokerStorageRequest({ protocolVersion: 1, kind: "status" });
        if (capabilities.cacheMaintenanceVersion !== 2 || capabilities.runtimeAdmissionFenceVersion !== 1)
          throw cacheMaintenanceFailure("unsupported");
        return await brokerStorageRequest({
          protocolVersion: 1,
          kind: "reclaim-package-caches",
          sessionIds: unknown ? [] : request.sessionIds.filter((id) => !scan.busy.has(id)),
          maxBytes: request.maxBytes
        });
      });
    } catch (error) {
      if (error?.runnerCacheFailure) throw error;
      const code = ["EACCES", "EPERM"].includes(error?.code) ? "broker-access-denied" : ["ENOENT", "ECONNREFUSED"].includes(error?.code) ? "broker-unavailable" : error?.message === "runner storage request timed out" ? "broker-timeout" : error instanceof SyntaxError || error?.code === "ERR_INVALID_RUNNER_STORAGE_RESPONSE" ? "broker-invalid-response" : "broker-rejected";
      throw cacheMaintenanceFailure(code);
    }
    if (response.report && (unknown || scan.busy.size > 0)) {
      response.report.usageComplete = false;
      response.report.legacyBytes = null;
      response.report.turnOwnershipCounts = scan.counts;
      response.report.blockers = [
        ...(response.report.blockers ?? []).slice(0, 99),
        unknown ? "Runner turn ownership is unknown; legacy package caches were retained" : "Runner sessions have unsettled turns; their legacy package caches were retained"
      ];
    }
    await closeCacheScan(runtimeDir, scan);
    return response;
  } catch (error) {
    await closeCacheScan(runtimeDir, scan);
    throw error;
  }
}
async function handleSupervisorRequest(runtimeDir, runnerInstanceId, request, turnStarter, onTrustedCliStarted, onStartAccepted, capabilities = { scriptIsolation: true }, outputOptions = {}) {
  if (!isObject(request) || !supportedRequestVersion(request.protocolVersion)) {
    throw new Error("unsupported supervisor protocol");
  }
  const skillsManifestHash = request.kind === "status" ? await installedSkillsManifestHash() : void 0;
  switch (request.kind) {
    case "capacity-lease":
      validateCapacityLeaseRequest(request);
      return await brokerStorageRequest({
        protocolVersion: 1,
        kind: "capacity-lease",
        action: request.action,
        operationId: request.operationId,
        generation: request.generation
      });
    case "stack-health":
      return await brokerStorageRequest({ protocolVersion: 1, kind: "stack-health" });
    case "egress-readiness":
      return await brokerStorageRequest({ protocolVersion: 1, kind: "egress-readiness" });
    case "status":
      return {
        ok: true,
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        runnerInstanceId,
        // Both ride on the same helper. The Server reads `scriptIsolation` before it
        // raises an approval card for an entry script this Sandbox could not confine.
        managedAgentConfig: true,
        builtInSkillsVersion: skillsManifestHash ? 1 : 0,
        ...skillsManifestHash ? { builtInSkillsManifestHash: skillsManifestHash } : {},
        persistentSessionHomes: true,
        cacheMaintenanceVersion: 2,
        capacityLeaseVersion: 1,
        turnOwnershipVersion: 1,
        planningIsolation: capabilities.scriptIsolation,
        knowledgeIsolation: capabilities.scriptIsolation,
        scriptIsolation: capabilities.scriptIsolation
      };
    case "prepare-session-home":
      return await sessionHomeRequest("prepare-session-home", request.sessionId, request);
    case "delete-session-home": {
      if (!SAFE_ID.test(request.sessionId ?? "")) throw new Error("invalid sessionId");
      const turns = await listTurns(runtimeDir);
      for (const turn of turns) {
        if (turn.sessionId === request.sessionId && turn.status !== "settled" && turnStarter !== void 0)
          await turnStarter.cancel(turn.turnId);
      }
      return await sessionHomeRequest("delete-session-home", request.sessionId);
    }
    case "reclaim-package-caches": {
      if (!Array.isArray(request.sessionIds) || request.sessionIds.length > 512 || request.sessionIds.some((id) => typeof id !== "string" || !SAFE_ID.test(id)) || !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0)
        throw new Error("invalid package cache request");
      if (request.maintenanceVersion === 2)
        return await reclaimPackageCachesPaged(runtimeDir, request);
      if (request.maintenanceVersion !== void 0) throw cacheMaintenanceFailure("unsupported");
      const fail = (code, counts2) => Object.assign(
        new Error(
          code === "turn-ownership-unknown" ? "Runner turn ownership is unknown; package caches retained" : "Runner cache maintenance blocked; caches retained"
        ),
        {
          runnerCacheFailure: { code, ...counts2 ? { counts: counts2 } : {} }
        }
      );
      let turns;
      try {
        turns = await listTurns(runtimeDir);
      } catch {
        throw fail("turn-inventory-unavailable");
      }
      const counts = { missingState: 0, invalidState: 0, unsettledWithoutSession: 0 };
      for (const turn of turns) {
        if (turn.status === "settled" || typeof turn.sessionId === "string") continue;
        const key = turn.reason === "missing-state" ? "missingState" : turn.reason === "invalid-state" ? "invalidState" : "unsettledWithoutSession";
        counts[key] = Math.min(1e6, counts[key] + 1);
      }
      if (Object.values(counts).some((count) => count > 0))
        throw fail("turn-ownership-unknown", counts);
      const busy = new Set(
        turns.filter((turn) => turn.status !== "settled").map((turn) => turn.sessionId)
      );
      let response;
      try {
        response = await brokerStorageRequest({
          protocolVersion: 1,
          kind: "reclaim-package-caches",
          sessionIds: request.sessionIds.filter((id) => !busy.has(id)),
          maxBytes: request.maxBytes
        });
      } catch (error) {
        const code = ["EACCES", "EPERM"].includes(error?.code) ? "broker-access-denied" : ["ENOENT", "ECONNREFUSED"].includes(error?.code) ? "broker-unavailable" : error?.message === "runner storage request timed out" ? "broker-timeout" : error instanceof SyntaxError || error?.code === "ERR_INVALID_RUNNER_STORAGE_RESPONSE" ? "broker-invalid-response" : "broker-rejected";
        throw fail(code);
      }
      if (busy.size > 0 && response.report) {
        response.report.usageComplete = false;
        response.report.legacyBytes = null;
        response.report.blockers = [
          ...(response.report.blockers ?? []).slice(0, 99),
          "Runner sessions have unsettled turns; their legacy package caches were retained"
        ];
      }
      return response;
    }
    case "list-turns":
      return { ok: true, turns: await listTurns(runtimeDir) };
    case "get-turn": {
      if (typeof request.turnId !== "string") throw new Error("invalid turnId");
      const state = await readTurnState(runtimeDir, request.turnId);
      return {
        ok: true,
        state,
        ...state?.status === "running" && typeof turnStarter?.workerStatus === "function" ? { workerStatus: turnStarter.workerStatus(request.turnId) } : {}
      };
    }
    case "claim-turn":
      return { ok: true, ...await claimTurn(runtimeDir, request, runnerInstanceId) };
    case "start-turn": {
      if (turnStarter === void 0) throw new Error("runner worker is not installed");
      if ((request.knowledgeIsolation === true || request.planning === true) && !capabilities.scriptIsolation) {
        throw new Error(SCRIPT_ISOLATION_UNAVAILABLE_ERROR);
      }
      const { pending } = turnStarter.start(request);
      onStartAccepted?.();
      return { ok: true, ...await pending };
    }
    case "cancel-turn":
      if (turnStarter === void 0) throw new Error("runner worker is not installed");
      return { ok: true, ...await turnStarter.cancel(request.turnId) };
    case "run-trusted-cli":
      if (typeof turnStarter?.runTrustedCli !== "function") {
        throw new Error("runner worker is not installed");
      }
      if (request.entryScript !== void 0 && !capabilities.scriptIsolation) {
        throw new Error(SCRIPT_ISOLATION_UNAVAILABLE_ERROR);
      }
      return {
        ok: true,
        ...await turnStarter.runTrustedCli(request, onTrustedCliStarted, outputOptions)
      };
    default:
      throw new Error("unknown supervisor request");
  }
}
async function runSupervisor(options = {}) {
  const runtimeDir = options.runtimeDir ?? process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const expectedUid = Number(
    options.uid ?? process.env.VERITY_RUNNER_RUNTIME_UID ?? process.getuid?.()
  );
  const expectedGid = Number(
    options.gid ?? process.env.VERITY_RUNNER_RUNTIME_GID ?? process.getgid?.()
  );
  await validateRuntimeDirectory(runtimeDir, { uid: expectedUid, gid: expectedGid });
  sampleEventLoopDelay();
  const scriptIsolation = options.scriptIsolation ?? await probeScriptSandbox(options.scriptSandboxPath ?? DEFAULT_SCRIPT_SANDBOX_PATH);
  if (!scriptIsolation.available) {
    process.stderr.write(
      `verity-runner-supervisor: worktree entry scripts are disabled: ${scriptIsolation.reason ?? "script sandbox unavailable"}
`
    );
  }
  const capabilities = { scriptIsolation: scriptIsolation.available };
  const singleton = await acquireSingleton(runtimeDir);
  const adoptedTurns = /* @__PURE__ */ new Set();
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
  const socketPath = join3(runtimeDir, "supervisor.sock");
  try {
    await rm3(socketPath, { force: true });
  } catch (error) {
    await turnAdopter.close();
    await turnStarter.close();
    await singleton.release();
    throw error;
  }
  const readyPath = join3(runtimeDir, "supervisor.json");
  const connections = /* @__PURE__ */ new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => void 0);
    let buffered = Buffer.alloc(0);
    let handled = false;
    let processingStarted = false;
    let pipelinedAfterNewline = false;
    const outputAbort = new globalThis.AbortController();
    let outputAck;
    let ackBuffer = "";
    let outputSequence = 0;
    socket.once("close", () => {
      outputAbort.abort();
      outputAck?.reject(new Error("trusted CLI output connection closed"));
    });
    const onOutput = (stream, bytes) => new Promise((resolve3, reject) => {
      if (socket.destroyed) {
        reject(new Error("trusted CLI output connection closed"));
        return;
      }
      const sequence = outputSequence++;
      const timer = setTimeout(() => {
        outputAck = void 0;
        reject(new Error("trusted CLI output receipt timed out"));
      }, 3e4);
      outputAck = {
        sequence,
        resolve: () => {
          clearTimeout(timer);
          resolve3();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };
      socket.write(
        `${JSON.stringify({ ok: true, kind: "trusted-cli-output", sequence, stream, data: bytes.toString("base64") })}
`
      );
    });
    let timeout = setTimeout(() => socket.destroy(), 5e3);
    const setRequestTimeout = (milliseconds) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => socket.destroy(), milliseconds);
    };
    const respond = (response) => {
      clearTimeout(timeout);
      socket.end(`${JSON.stringify(response)}
`, () => socket.destroy());
    };
    const respondDraining = (response) => {
      clearTimeout(timeout);
      socket.end(`${JSON.stringify(response)}
`);
      const grace = setTimeout(() => socket.destroy(), OVERSIZE_DRAIN_GRACE_MS);
      socket.once("close", () => clearTimeout(grace));
    };
    socket.on("data", (chunk) => {
      if (handled) {
        if (outputAck !== void 0) {
          ackBuffer += chunk.toString("utf8");
          if (ackBuffer.length > 512) {
            socket.destroy();
            return;
          }
          if (!ackBuffer.endsWith("\n")) return;
          try {
            const ack = JSON.parse(ackBuffer);
            ackBuffer = "";
            if (ack.kind !== "output-ack" || ack.sequence !== outputAck.sequence || ack.failure !== void 0 && !["redaction_failure", "storage_failure", "output_limit"].includes(ack.failure)) {
              socket.destroy();
              return;
            }
            const pending = outputAck;
            outputAck = void 0;
            if (ack.failure === void 0) pending.resolve();
            else
              pending.reject(
                Object.assign(new Error("trusted CLI output rejected"), {
                  outputFailure: ack.failure
                })
              );
          } catch {
            socket.destroy();
          }
          return;
        }
        if (!processingStarted && chunk.length > 0) pipelinedAfterNewline = true;
        return;
      }
      if (buffered.length + chunk.length > MAX_CONTROL_LINE_BYTES) {
        handled = true;
        buffered = Buffer.alloc(0);
        respondDraining(responseForError(new Error("supervisor frame too large")));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      handled = true;
      const line = buffered.subarray(0, newline).toString("utf8");
      const remainder = buffered.subarray(newline + 1);
      buffered = Buffer.alloc(0);
      if (remainder.length > 0) {
        respond(responseForError(new Error("supervisor accepts exactly one request")));
        return;
      }
      void new Promise((resolve3) => setImmediate(resolve3)).then(() => {
        processingStarted = true;
        if (pipelinedAfterNewline) {
          throw new Error("supervisor accepts exactly one request");
        }
      }).then(() => JSON.parse(line)).then((request) => {
        setRequestTimeout(supervisorRequestTimeoutMs(request));
        return handleSupervisorRequest(
          runtimeDir,
          singleton.instanceId,
          request,
          turnStarter,
          request?.kind === "run-trusted-cli" ? () => socket.write(`${JSON.stringify({ ok: true, kind: "trusted-cli-started" })}
`) : void 0,
          // Only when the Server asked for it. A Server that predates the two-phase
          // reply reads exactly one frame per request and would refuse a second as
          // an invalid frame count — the D9 half of this change that keeps a new
          // Sandbox image usable by an older Server.
          request?.kind === "start-turn" && request.startAck === true ? () => socket.write(
            `${JSON.stringify({
              ok: true,
              kind: "start-accepted",
              // The raw request's ids, which the client compares strictly
              // against the ones it sent. Sound because `validateStartTurnRequest`
              // only TESTS these two against `SAFE_ID` and never rewrites them;
              // a validator that ever normalized an id would have to echo the
              // normalized value here instead.
              turnId: request.turnId,
              startCommandId: request.startCommandId
            })}
`
          ) : void 0,
          capabilities,
          request?.kind === "run-trusted-cli" && request.streamOutput === true ? { onOutput, signal: outputAbort.signal } : {}
        );
      }).catch(responseForError).then(respond);
    });
  });
  try {
    await new Promise((resolve3, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve3);
    });
    await chmod2(socketPath, 432);
    await writeJsonAtomic(readyPath, {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      runnerInstanceId: singleton.instanceId,
      pid: process.pid,
      socketPath,
      readyAt: Date.now()
    });
  } catch (error) {
    server.close();
    await turnAdopter.close();
    await turnStarter.close();
    await rm3(socketPath, { force: true });
    await singleton.release();
    throw error;
  }
  const close = async () => {
    await turnAdopter.close();
    await turnStarter.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve3) => server.close(resolve3));
    await rm3(socketPath, { force: true });
    await rm3(readyPath, { force: true });
    await singleton.release();
  };
  return { runtimeDir, socketPath, instanceId: singleton.instanceId, close };
}
async function probeSupervisor(runtimeDir = DEFAULT_RUNTIME_DIR, timeoutMs = 1e3) {
  const socketPath = join3(runtimeDir, "supervisor.sock");
  return await new Promise((resolve3) => {
    const socket = createConnection2(socketPath);
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve3(false);
    }, timeoutMs);
    const finish = (live) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve3(live);
    };
    socket.once("error", () => finish(false));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => {
      try {
        const parsed = JSON.parse(response);
        finish(parsed?.ok === true && parsed.protocolVersion === SUPERVISOR_PROTOCOL_VERSION);
      } catch {
        finish(false);
      }
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ protocolVersion: SUPERVISOR_PROTOCOL_VERSION, kind: "status" })}
`
      );
    });
  });
}

// features/verity-sandbox-toolkit/src/runner-supervisor/turns.mjs
function createTurnStarter(runtimeDir, runnerInstanceId, options = {}) {
  const children = /* @__PURE__ */ new Map();
  const settlements = /* @__PURE__ */ new Set();
  const settlementsByTurn = /* @__PURE__ */ new Map();
  const starts = /* @__PURE__ */ new Set();
  const startsByTurn = /* @__PURE__ */ new Map();
  const cancelledBeforeStart = /* @__PURE__ */ new Set();
  const maxConcurrentStarts = options.maxConcurrentStarts ?? MAX_CONCURRENT_STARTS;
  const maxQueuedStarts = options.maxQueuedStarts ?? MAX_QUEUED_STARTS;
  const queue = [];
  let running = 0;
  let closing = false;
  const spawnWorker = options.spawnWorker ?? ((command, args, spawnOptions) => spawn3(command, args, spawnOptions));
  const workerCommand = options.workerCommand;
  const workerBackends = new Set(options.workerBackends ?? WORKER_BACKENDS);
  const adoptedTurnIsLive = async (turnId) => {
    if (options.adoptedTurns?.has(turnId) !== true) return false;
    let lock;
    try {
      lock = await acquireFileLock(join4(runtimeDir, "turns", turnId, "worker.lock"));
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
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill("SIGTERM");
    const escalation = setTimeout(() => child.kill("SIGKILL"), options.shutdownGraceMs ?? 5e3);
    await exited;
    clearTimeout(escalation);
  };
  const startImpl = async (request) => {
    if (closing) throw new Error("runner supervisor is shutting down");
    if (typeof workerCommand !== "string" || workerCommand.length === 0) {
      throw new Error("runner worker is not installed");
    }
    if (!workerBackends.has(request.backend)) {
      throw new Error(
        `worker does not support backend: ${request.backend} (this sandbox image provides ${[...workerBackends].sort().join(", ") || "no agent adapter at all"}; a backend the server offers but this image lacks means the container predates it or was built without that agent, and needs rebuilding)`
      );
    }
    const claim = await claimTurn(runtimeDir, request, runnerInstanceId);
    if (claim.outcome !== "created") return claim;
    const turnDir = join4(runtimeDir, "turns", request.turnId);
    const cancelledInMemory = cancelledBeforeStart.delete(request.turnId);
    const tombstone = cancelledInMemory ? "cancelled" : await readCancelTombstone(runtimeDir, request.turnId);
    if (tombstone !== "absent") {
      const cancelled = tombstone === "cancelled";
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
        ...cancelled ? { workerSignal: "SIGTERM" } : { workerExitCode: 1, workerSignal: null },
        workerError: cancelled ? "runner turn was cancelled before its worker started" : "runner turn could not start: its cancellation record was unreadable",
        aborted: cancelled
      }).catch(() => void 0);
      const state2 = await updateTurnState(runtimeDir, request.turnId, {
        status: "settled",
        ...cancelled ? { workerSignal: "SIGTERM" } : {
          workerExitCode: 1,
          workerError: "runner turn could not start: its cancellation record was unreadable"
        }
      });
      return { outcome: "terminal", state: state2 };
    }
    const requestPath = join4(turnDir, "request.json");
    const workerLockPath = join4(turnDir, "worker.lock");
    let child;
    let workerLock;
    let attestationTail = Promise.resolve();
    let workerErrorDone = Promise.resolve("");
    let exited = false;
    let resolveExit;
    const exitInfo = new Promise((resolve3) => {
      resolveExit = resolve3;
    });
    try {
      await writeJsonAtomic(requestPath, request, 384);
      await updateTurnState(runtimeDir, request.turnId, {
        workerLock: true,
        ...request.trustedCliExecution === true ? { trustedCliExecution: true, cwd: request.cwd } : {}
      });
      workerLock = await acquireFileLock(workerLockPath);
      await assertSpawnBoundary(
        request,
        workerCommand,
        options.workerEnv?.PATH ?? process.env.PATH
      );
      child = spawnWorker(workerCommand, [...options.workerArgs ?? [], requestPath], {
        cwd: request.cwd,
        stdio: stdioWithWorkerLock(workerLock.fd),
        env: {
          PATH: process.env.PATH,
          ...options.workerEnv ?? {},
          VERITY_RUNNER_TURN_DIR: turnDir,
          VERITY_RUNNER_EVENT_FILE: join4(turnDir, "events.jsonl"),
          VERITY_RUNNER_CONTROL_SOCKET: join4(turnDir, "control.sock")
        }
      });
      if (child.stdout === null || child.stdout === void 0) {
        throw new Error("runner worker has no private attestation pipe");
      }
      if (child.stdin === null || child.stdin === void 0) {
        throw new Error("runner worker has no private attestation acknowledgement pipe");
      }
      if (child.stderr === null || child.stderr === void 0) {
        throw new Error("runner worker has no private error pipe");
      }
      const workerErrorCapture = createWorkerErrorCapture();
      let resolveWorkerError;
      let workerErrorSettled = false;
      const settleWorkerError = () => {
        if (workerErrorSettled) return;
        workerErrorSettled = true;
        resolveWorkerError(workerErrorCapture.finish());
      };
      child.stderr.on("data", (chunk) => workerErrorCapture.push(chunk));
      workerErrorDone = new Promise((resolveError) => {
        resolveWorkerError = resolveError;
        child.stderr.once("end", settleWorkerError);
      });
      child.once("exit", (code, signal) => {
        exited = true;
        children.delete(request.turnId);
        setTimeout(settleWorkerError, WORKER_ERROR_DRAIN_TIMEOUT_MS);
        resolveExit({ code, signal });
      });
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
    } catch (error) {
      const workerSpawnFailure = spawnFailureDiagnostic(error, request, workerCommand);
      const workerError = describeSpawnFailure(
        boundedSpawnError(error instanceof Error ? error.message : String(error)),
        workerSpawnFailure
      );
      logTelemetry({
        event: "worker-spawn-failed",
        turnId: request.turnId,
        sessionId: request.sessionId,
        ...workerSpawnFailure
      });
      let reaped = child?.pid === void 0;
      if (!reaped) {
        child.kill("SIGKILL");
        if (!exited) {
          await Promise.race([
            exitInfo,
            new Promise((resolve3) => setTimeout(resolve3, REJECTED_WORKER_EXIT_WAIT_MS).unref?.())
          ]);
        }
        reaped = exited;
      }
      await workerLock?.close().catch(() => void 0);
      if (reaped) {
        await writeSyntheticTerminalFrame(turnDir, {
          turnId: request.turnId,
          runnerInstanceId,
          workerExitCode: 1,
          workerSignal: null,
          workerError,
          aborted: await cancelExplainsSettlement(runtimeDir, request.turnId)
        }).catch(() => void 0);
      }
      await updateTurnState(runtimeDir, request.turnId, {
        status: "settled",
        ...workerError.length > 0 ? { workerError } : {},
        workerSpawnFailure
      });
      throw new Error(workerError);
    }
    if (!exited) children.set(request.turnId, child);
    const runningState = updateTurnState(runtimeDir, request.turnId, {
      status: "running",
      workerPid: child.pid
    });
    const settlement = exitInfo.then(async ({ code, signal }) => {
      await runningState.catch(() => void 0);
      await attestationTail;
      const workerError = await workerErrorDone;
      const aborted = await cancelExplainsSettlement(runtimeDir, request.turnId);
      const wrote = await writeSyntheticTerminalFrame(turnDir, {
        turnId: request.turnId,
        runnerInstanceId,
        workerExitCode: code,
        workerSignal: signal,
        workerError,
        aborted
      }).catch(() => false);
      if (wrote) {
        logTelemetry({
          event: "worker-exited-without-events",
          turnId: request.turnId,
          exitCode: code,
          signal
        });
      }
      return await updateTurnState(runtimeDir, request.turnId, {
        status: "settled",
        workerExitCode: code,
        workerSignal: signal,
        ...code !== 0 || signal !== null ? workerError.length > 0 ? { workerError } : {} : {}
      });
    }).catch(() => void 0);
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
      await workerLock.close().catch(() => void 0);
      await settlement;
      throw error;
    }
    return { outcome: "created", state };
  };
  const admit = (run) => {
    let slot;
    if (running >= maxConcurrentStarts) {
      if (queue.length >= maxQueuedStarts) {
        throw new Error("runner supervisor start queue is full");
      }
      slot = new Promise((resolveSlot) => queue.push(resolveSlot));
    } else {
      running += 1;
      slot = Promise.resolve();
    }
    return slot.then(async () => {
      try {
        return await run();
      } finally {
        const next = queue.shift();
        if (next === void 0) running -= 1;
        else next();
      }
    });
  };
  const start = (rawRequest) => {
    if (closing) throw new Error("runner supervisor is shutting down");
    const request = validateStartTurnRequest(rawRequest);
    const previous = startsByTurn.get(request.turnId);
    if (previous !== void 0 && previous.startCommandId === request.startCommandId) {
      if (!previous.loggedDeduplication) {
        previous.loggedDeduplication = true;
        logTelemetry({ event: "start-deduplicated", turnId: request.turnId });
      }
      return { accepted: true, pending: previous.promise };
    }
    if (previous !== void 0) {
      throw new Error(`turn ${request.turnId} is already starting under another command`);
    }
    const queuedAt = Date.now();
    const entry = { promise: void 0, startCommandId: request.startCommandId };
    const promise = admit(async () => {
      const startedAt = Date.now();
      entry.admitted = true;
      try {
        return await startImpl(request);
      } finally {
        logTelemetry({
          event: "start",
          turnId: request.turnId,
          backend: request.backend,
          sessionId: request.sessionId,
          gatewayTokenPresent: request.mcpGatewayToken !== void 0,
          gatewayUrlPresent: typeof options.workerEnv?.VERITY_MCP_GATEWAY_URL === "string" && options.workerEnv.VERITY_MCP_GATEWAY_URL !== "",
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
          eventLoopDelayMs: sampleEventLoopDelay()
        });
      }
    });
    entry.promise = promise;
    starts.add(promise);
    startsByTurn.set(request.turnId, entry);
    void promise.finally(() => {
      starts.delete(promise);
      if (startsByTurn.get(request.turnId) === entry) startsByTurn.delete(request.turnId);
    }).catch(() => void 0);
    return { accepted: true, pending: promise };
  };
  const cancel = async (turnId) => {
    if (typeof turnId !== "string" || !SAFE_ID.test(turnId)) throw new Error("invalid turnId");
    cancelledBeforeStart.add(turnId);
    await mkdir2(join4(runtimeDir, "cancellations"), { recursive: true, mode: 504 });
    await writeJsonAtomic(cancelPath(runtimeDir, turnId), {
      protocolVersion: 1,
      turnId,
      cancelledAt: Date.now()
    });
    const inFlight = startsByTurn.get(turnId);
    if (inFlight?.admitted === true) await inFlight.promise.catch(() => void 0);
    const currentState = await readTurnState(runtimeDir, turnId);
    if (currentState === void 0) {
      return { outcome: "cancelled" };
    }
    if (currentState.status === "settled") {
      cancelledBeforeStart.delete(turnId);
      return { outcome: "terminal", state: currentState };
    }
    const child = children.get(turnId);
    if (child === void 0) {
      throw new Error("runner worker is not owned by this supervisor");
    }
    try {
      await terminate(child);
      await settlementsByTurn.get(turnId);
      return { outcome: "cancelled", state: await readTurnState(runtimeDir, turnId) };
    } finally {
      cancelledBeforeStart.delete(turnId);
    }
  };
  return {
    start,
    cancel,
    // A persisted running flag and a stale socket inode are not proof of life.
    // Only this supervisor's child or a worker adopted under its liveness lock is.
    workerStatus(turnId) {
      return children.has(turnId) || options.adoptedTurns?.has(turnId) === true ? "live" : "uncertain";
    },
    runTrustedCli(request, onSpawned, outputOptions = {}) {
      return runTrustedCliViaBroker(request, {
        runtimeDir,
        ...outputOptions,
        ...options.brokerSocket === void 0 ? {} : { brokerSocket: options.brokerSocket },
        ...onSpawned === void 0 ? {} : { onSpawned },
        authorize: async ({ turnId }) => !cancelledBeforeStart.has(turnId) && (children.has(turnId) || await adoptedTurnIsLive(turnId))
      });
    },
    async close() {
      closing = true;
      await Promise.allSettled([...starts]);
      await Promise.all([...children.values()].map(terminate));
      await Promise.all([...settlements]);
    }
  };
}
function createTurnAdopter(runtimeDir, options = {}) {
  const pollMs = options.adoptionPollMs ?? 250;
  const adopted = options.adoptedTurns ?? /* @__PURE__ */ new Set();
  let timer;
  let closed = false;
  let polling = false;
  const probe = async (turnId, initial, claim) => {
    const lockPath = join4(runtimeDir, "turns", turnId, "worker.lock");
    const isOtherClaim = async () => {
      if (claim === void 0) return false;
      const state = await readTurnState(runtimeDir, turnId);
      return state !== void 0 && !sameClaim(state, claim);
    };
    let lock;
    try {
      lock = await acquireFileLock(lockPath);
    } catch (error) {
      if (!isLockBusy(error)) return "uncertain";
      if (await isOtherClaim()) return "gone";
      if (initial) {
        const state = await readTurnState(runtimeDir, turnId);
        if (state?.status === "claimed") {
          await updateTurnState(runtimeDir, turnId, {
            status: "running",
            adoptedAt: Date.now()
          }).catch(() => void 0);
        }
      }
      return "live";
    }
    try {
      if (await isOtherClaim()) return "gone";
      try {
        await settleMissingWorkerTurn(runtimeDir, turnId);
      } catch {
        return "uncertain";
      }
      return "dead";
    } finally {
      await lock.close();
    }
  };
  const unresolved = /* @__PURE__ */ new Map();
  const unresolvedRetryMs = options.unresolvedRetryMs ?? 5e3;
  let nextUnresolvedAt = 0;
  const exists = (turnId) => lstat3(join4(runtimeDir, "turns", turnId)).then(
    () => true,
    (error) => error?.code !== "ENOENT"
  );
  const schedule = () => {
    if (closed || adopted.size === 0 && unresolved.size === 0 || timer !== void 0) return;
    timer = setTimeout(() => {
      timer = void 0;
      void poll();
    }, pollMs);
    timer.unref?.();
  };
  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      for (const turnId of [...adopted]) {
        const disposition = await probe(turnId, false).catch(() => "uncertain");
        if (disposition === "dead") adopted.delete(turnId);
      }
      const retryUnresolved = Date.now() >= nextUnresolvedAt;
      if (retryUnresolved) nextUnresolvedAt = Date.now() + unresolvedRetryMs;
      for (const turnId of retryUnresolved ? [...unresolved.keys()] : []) {
        if (closed) break;
        const claim = unresolved.get(turnId);
        const current = await readTurnState(runtimeDir, turnId).catch(() => null);
        const finished = current === void 0 ? !await exists(turnId) : current !== null && (current.status === "settled" || !sameClaim(current, claim));
        if (finished) {
          unresolved.delete(turnId);
          continue;
        }
        const disposition = await probe(turnId, true, claim).catch(() => "uncertain");
        if (disposition === "uncertain") continue;
        unresolved.delete(turnId);
        if (disposition === "live") adopted.add(turnId);
      }
    } finally {
      polling = false;
      schedule();
    }
  };
  return {
    async adopt() {
      for (const state of await listTurns(runtimeDir)) {
        if (state.status !== "claimed" && state.status !== "running") continue;
        if (state.workerLock !== true) continue;
        const disposition = await probe(state.turnId, true).catch(() => "uncertain");
        if (disposition === "live") adopted.add(state.turnId);
        else if (disposition === "uncertain") {
          unresolved.set(state.turnId, {
            runnerInstanceId: state.runnerInstanceId,
            startCommandId: state.startCommandId
          });
        }
      }
      schedule();
    },
    async close() {
      closed = true;
      if (timer !== void 0) clearTimeout(timer);
      timer = void 0;
      while (polling) await new Promise((resolvePoll) => setTimeout(resolvePoll, 1));
      adopted.clear();
      unresolved.clear();
    }
  };
}
function sameClaim(state, claim) {
  return state != null && state.runnerInstanceId === claim.runnerInstanceId && state.startCommandId === claim.startCommandId;
}
var TURN_SCAN_CONCURRENCY = 16;
async function listTurns(runtimeDir) {
  const turnsDir = join4(runtimeDir, "turns");
  const entries = await readdir(turnsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const names = entries.filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name)).map((entry) => entry.name);
  const states = new Array(names.length);
  let next = 0;
  const readNext = async () => {
    for (let index = next++; index < names.length; index = next++) {
      const turnId = names[index];
      try {
        const state = await readTurnState(runtimeDir, turnId);
        states[index] = state ?? { turnId, status: "ambiguous", reason: "missing-state" };
      } catch {
        states[index] = { turnId, status: "ambiguous", reason: "invalid-state" };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TURN_SCAN_CONCURRENCY, names.length) }, readNext)
  );
  return states.sort((a, b) => String(a.turnId).localeCompare(String(b.turnId)));
}
function responseForError(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...isObject(error?.runnerCacheFailure) ? { runnerCacheFailure: error.runnerCacheFailure } : {},
    ...isObject(error?.trustedCliFailure) ? { trustedCliFailure: error.trustedCliFailure } : {}
  };
}
async function sessionHomeRequest(kind, sessionId, migration = {}) {
  if (!SAFE_ID.test(sessionId ?? "")) throw new Error("invalid sessionId");
  return await brokerStorageRequest({
    protocolVersion: 1,
    kind,
    sessionId,
    legacyBackend: migration.legacyBackend,
    legacySessionId: migration.legacySessionId
  });
}
async function brokerStorageRequest(request) {
  return await new Promise((resolve3, reject) => {
    const socket = createConnection3(
      process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET ?? "/run/verity-runner-broker/agent-spawn-broker.sock"
    );
    let buffered = "";
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve3(response ?? { ok: true });
    };
    socket.setTimeout(3e4, () => finish(new Error("runner storage request timed out")));
    socket.once("error", finish);
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      buffered += chunk.toString();
      if (Buffer.byteLength(buffered, "utf8") > 65536)
        return finish(
          Object.assign(new Error("runner storage response too large"), {
            code: "ERR_INVALID_RUNNER_STORAGE_RESPONSE"
          })
        );
      if (!buffered.includes("\n")) return;
      try {
        const response = JSON.parse(buffered.split("\n")[0]);
        if (!isObject(response) || typeof response.ok !== "boolean")
          throw Object.assign(new Error("invalid runner storage response"), {
            code: "ERR_INVALID_RUNNER_STORAGE_RESPONSE"
          });
        finish(
          response.ok === true ? void 0 : new Error(response.error ?? "session home request failed"),
          response
        );
      } catch (error) {
        finish(error);
      }
    });
    socket.once("close", () => finish(new Error("session home broker closed before response")));
  });
}
var CACHE_SCAN_PAGE = 256;
var CACHE_SCAN_TTL_MS = 5 * 6e4;
var cacheMaintenanceFlights = /* @__PURE__ */ new Map();
function cacheMaintenanceFailure(code) {
  return Object.assign(new Error("Runner cache maintenance inventory is unavailable"), {
    runnerCacheFailure: { code }
  });
}
async function closeCacheScan(runtimeDir, scan) {
  if (cacheScans.get(runtimeDir) === scan) cacheScans.delete(runtimeDir);
  clearTimeout(scan.timer);
  await scan.directory?.close().catch(() => void 0);
}
async function cacheTurnSummary(runtimeDir, turnId) {
  try {
    const state = await readTurnState(runtimeDir, turnId);
    if (state === void 0) return { turnId, status: "ambiguous", reason: "missing-state" };
    return {
      turnId,
      status: state.status,
      startCommandId: state.startCommandId,
      runnerInstanceId: state.runnerInstanceId,
      ...state.sessionId === void 0 ? {} : { sessionId: state.sessionId }
    };
  } catch {
    return { turnId, status: "ambiguous", reason: "invalid-state" };
  }
}
function reclaimPackageCachesPaged(runtimeDir, request) {
  const previous = cacheMaintenanceFlights.get(runtimeDir) ?? Promise.resolve();
  const current = previous.catch(() => void 0).then(() => reclaimPackageCachesPage(runtimeDir, request));
  cacheMaintenanceFlights.set(runtimeDir, current);
  void current.finally(() => {
    if (cacheMaintenanceFlights.get(runtimeDir) === current)
      cacheMaintenanceFlights.delete(runtimeDir);
  }).catch(() => void 0);
  return current;
}
async function withFinalCacheAdmission(runtimeDir, scan, run) {
  if (activeCacheClaims.has(runtimeDir) || scan.epoch !== (cacheClaimEpochs.get(runtimeDir) ?? 0))
    throw cacheMaintenanceFailure("turn-inventory-unavailable");
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

// features/verity-sandbox-toolkit/src/runner-supervisor/main.mjs
var invokedPath = process.argv[1] === void 0 ? void 0 : resolve2(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeDir = process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const command = process.argv[2];
  const brokerSocket = process.env.VERITY_AGENT_SPAWN_BROKER_SOCKET;
  const launch = command === "--probe" ? probeSupervisor(runtimeDir) : runSupervisor(
    brokerSocket === void 0 ? void 0 : {
      runtimeDir,
      workerCommand: process.env.VERITY_RUNNER_WORKER ?? "/usr/local/bin/verity-runner-worker",
      workerBackends: installedWorkerBackends(),
      workerEnv: supervisorWorkerEnv(process.env)
    }
  );
  launch.then((supervisor) => {
    if (typeof supervisor === "boolean") {
      process.exitCode = supervisor ? 0 : 1;
      return;
    }
    const shutdown = () => {
      void supervisor.close().finally(() => process.exit(0));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }).catch((error) => {
    process.stderr.write(`verity-runner-supervisor: ${responseForError(error).error}
`);
    process.exitCode = 1;
  });
}
export {
  DEFAULT_RUNTIME_DIR,
  DEFAULT_SCRIPT_SANDBOX_PATH,
  MAX_START_REQUEST_BYTES,
  MIN_SUPPORTED_SUPERVISOR_PROTOCOL_VERSION,
  SCRIPT_ISOLATION_UNAVAILABLE_ERROR,
  SUPERVISED_WORKER_BACKENDS,
  SUPERVISOR_PROTOCOL_VERSION,
  acquireSingleton,
  claimTurn,
  createTurnAdopter,
  createTurnStarter,
  handleSupervisorRequest,
  installedSkillsManifestHash,
  installedSkillsVersion,
  installedWorkerBackends,
  listTurns,
  probeScriptSandbox,
  probeSupervisor,
  readTurnState,
  redactTrustedCliText,
  runSupervisor,
  runTrustedCliViaBroker,
  supervisorRequestTimeoutMs,
  supervisorWorkerEnv,
  validateImageReferences,
  validateRuntimeDirectory,
  validateRuntimeStats,
  validateStartTurnRequest,
  writeSyntheticTerminalFrame
};
