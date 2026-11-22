#!/usr/bin/env node

// features/verity-sandbox-toolkit/src/spawn-broker/capacity-leases.mjs
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
var ROOT = "/run/verity-capacity-leases";
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validateCapacityLeaseRequest(request) {
  if (request?.protocolVersion !== 1 || request.kind !== "capacity-lease" || !["create", "status", "retire"].includes(request.action) || typeof request.operationId !== "string" || !UUID.test(request.operationId) || typeof request.generation !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.generation))
    throw new Error("invalid capacity lease request");
}
function safeFile(info, uid, mode) {
  return info.isFile() && info.uid === BigInt(uid) && info.nlink === 1n && (info.mode & 0o777n) === BigInt(mode);
}
function identity(info) {
  return { device: String(info.dev), inode: String(info.ino) };
}
function same(a, b) {
  return a?.device === b?.device && a?.inode === b?.inode;
}
async function flock(handle, wait = false) {
  return await new Promise((resolve5, reject) => {
    const child = spawn(
      "/usr/bin/flock",
      ["--exclusive", ...wait ? ["--wait", "5"] : ["--nonblock"], "3"],
      { stdio: ["ignore", "ignore", "ignore", handle.fd] }
    );
    child.once("error", reject);
    child.once(
      "exit",
      (code) => code === 0 ? resolve5(true) : code === 1 ? resolve5(false) : reject(new Error("capacity flock failed"))
    );
  });
}
async function rootDirectory(root, uid) {
  await mkdir(root, { mode: 493 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 18) !== 0 || await realpath(root) !== root)
    throw new Error("unsafe capacity lease directory");
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const opened = await directory.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error("capacity directory changed");
    await directory.chmod(493);
  } finally {
    await directory.close();
  }
}
async function syncDirectory(root) {
  const handle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function metadata(path, uid) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!safeFile(info, uid, 384) || info.size > 2048n) throw new Error("unsafe lease metadata");
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid lease metadata");
    return value;
  } finally {
    await handle.close();
  }
}
async function persist(root, path, value) {
  const temporary = join(root, `.metadata-${randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    384
  );
  try {
    await handle.chmod(384);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(root);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
async function capacityLeaseRequest(request, options = {}) {
  validateCapacityLeaseRequest(request);
  const root = options.capacityLeaseRoot ?? ROOT;
  const uid = options.enforceRoot === false ? process.getuid() : 0;
  const path = join(root, `${request.operationId}.lock`);
  const reply = (state, extra = {}) => ({
    ok: true,
    capacityLeaseVersion: 1,
    operationId: request.operationId,
    generation: request.generation,
    state,
    path,
    ...extra
  });
  let registry;
  let lease;
  try {
    await rootDirectory(root, uid);
    registry = await open(
      join(root, ".registry.lock"),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      384
    );
    if (!safeFile(await registry.stat({ bigint: true }), uid, 384) || !await flock(registry, true))
      return reply("unknown");
    const recordPath = join(root, `${request.operationId}.json`);
    let record;
    try {
      record = await metadata(recordPath, uid);
    } catch (error) {
      if (error.code !== "ENOENT" || request.action !== "create") return reply("unknown");
    }
    if (record) {
      if (record.operationId !== request.operationId || record.generation !== request.generation || !/^[0-9]+$/.test(record.identity?.device) || !/^[0-9]+$/.test(record.identity?.inode))
        return reply("unknown");
      if (record.state === "retired") return reply("retired", { identity: record.identity });
      if (record.state !== "live") return reply("unknown");
    } else {
      lease = await open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        420
      );
      await lease.chmod(420);
      const info2 = await lease.stat({ bigint: true });
      if (!safeFile(info2, uid, 420)) return reply("unknown");
      record = {
        operationId: request.operationId,
        generation: request.generation,
        state: "live",
        identity: identity(info2)
      };
      await lease.sync();
      await persist(root, recordPath, record);
    }
    lease ??= await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await lease.stat({ bigint: true });
    if (!safeFile(info, uid, 420) || !same(identity(info), record.identity))
      return reply("unknown");
    if (!await flock(lease)) return reply("held", { identity: record.identity });
    const current = await lstat(path, { bigint: true });
    if (!safeFile(current, uid, 420) || !same(identity(current), record.identity))
      return reply("unknown");
    if (request.action === "retire") {
      await persist(root, recordPath, { ...record, state: "retired" });
      await unlink(path);
      await syncDirectory(root);
      return reply("retired", { identity: record.identity });
    }
    return reply("idle", { identity: record.identity });
  } catch {
    return reply("unknown");
  } finally {
    await lease?.close();
    await registry?.close();
  }
}

// features/verity-sandbox-toolkit/src/spawn-broker/main.mjs
import { statSync } from "node:fs";
import { resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// features/verity-sandbox-toolkit/src/spawn-broker/request.mjs
import { spawn as spawn5 } from "node:child_process";
import {
  probeMemoryGuard,
  readMemoryCeiling,
  runsUnderGvisor
} from "./verity-memory-guard.mjs";
import { stopTaggedManagedPids } from "./verity-managed-secret-servers.mjs";
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
import { createConnection as createConnection2 } from "node:net";
import {
  chmod as chmod4,
  chown as chown4,
  lstat as lstat5,
  mkdir as mkdir4,
  open as open3,
  readdir as readdir2,
  rename as rename2,
  realpath as realpath4,
  rm as rm4,
  writeFile as writeFile2
} from "node:fs/promises";
import { constants as constants3, readFileSync as readFileSync2 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join5, resolve as resolve3 } from "node:path";
import { URL as URL2 } from "node:url";

// features/verity-sandbox-toolkit/src/spawn-broker/launch.mjs
import { spawn as spawn4 } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod as chmod3,
  chown as chown3,
  lstat as lstat4,
  mkdir as mkdir3,
  mkdtemp as mkdtemp2,
  readdir,
  readFile as readFile3,
  realpath as realpath3,
  rm as rm3,
  symlink as symlink2,
  truncate,
  writeFile
} from "node:fs/promises";
import { lstatSync as lstatSync2, readFileSync, realpathSync } from "node:fs";
import { join as join4, resolve as resolve2 } from "node:path";

// features/verity-sandbox-toolkit/src/spawn-broker/session-home.mjs
import { spawn as spawn3 } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
import {
  chmod as chmod2,
  chown as chown2,
  lstat as lstat3,
  mkdir as mkdir2,
  mkdtemp,
  open as open2,
  opendir,
  readFile as readFile2,
  realpath as realpath2,
  rm as rm2,
  rmdir,
  symlink
} from "node:fs/promises";
import { constants as constants2, lstatSync } from "node:fs";
import { isAbsolute, join as join3 } from "node:path";
import { fileURLToPath, URL } from "node:url";

// features/verity-sandbox-toolkit/src/spawn-broker/process.mjs
import { spawn as spawn2 } from "node:child_process";
import { createManagedSecretServers } from "./verity-managed-secret-servers.mjs";
import { createConnection, createServer } from "node:net";
import { chmod, chown, lstat as lstat2, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join as join2, resolve } from "node:path";
function collectEscapedProcessTree(root, readProc = readProcFile) {
  const rootGroup = String(root);
  const descendants = /* @__PURE__ */ new Map();
  let rootStartTime;
  try {
    rootStartTime = processStartTime(root, readProc);
  } catch {
    return descendants;
  }
  if (rootStartTime === "") return descendants;
  const visited = /* @__PURE__ */ new Set();
  const visit = (parent) => {
    if (visited.has(parent)) return;
    visited.add(parent);
    let taskIds;
    try {
      taskIds = readdirSync(`/proc/${parent}/task`).filter((entry) => /^\d+$/.test(entry)).map(Number);
    } catch {
      taskIds = [parent];
    }
    const children = /* @__PURE__ */ new Set();
    for (const taskId of taskIds) {
      try {
        for (const child of readProc(`/proc/${parent}/task/${taskId}/children`).trim().split(/\s+/).filter(Boolean).map(Number)) {
          children.add(child);
        }
      } catch {
      }
    }
    for (const child of children) {
      try {
        const before = statFields(child, readProc);
        const startTime = before[19] ?? "";
        if (startTime === "") continue;
        const alreadyCollected = new Set(descendants.keys());
        visit(child);
        const after = statFields(child, readProc);
        if ((after[19] ?? "") !== startTime) {
          for (const pid of descendants.keys()) {
            if (!alreadyCollected.has(pid)) descendants.delete(pid);
          }
          continue;
        }
        if ((after[2] ?? "") !== rootGroup) descendants.set(child, startTime);
      } catch {
      }
    }
  };
  visit(root);
  try {
    if (processStartTime(root, readProc) !== rootStartTime) descendants.clear();
  } catch {
    descendants.clear();
  }
  return descendants;
}
function warn(message) {
  const ignoreWriteError = () => void 0;
  process.stderr.once("error", ignoreWriteError);
  try {
    process.stderr.write(`verity-agent-spawn-broker: ${message}
`, () => {
      process.stderr.off("error", ignoreWriteError);
    });
  } catch {
    process.stderr.off("error", ignoreWriteError);
  }
}
var childrenApiWarned = false;
function warnIfChildrenApiMissing(pid, readProc) {
  if (childrenApiWarned) return;
  try {
    readProc(`/proc/${pid}/stat`);
  } catch {
    return;
  }
  try {
    readProc(`/proc/${pid}/task/${pid}/children`);
  } catch {
    childrenApiWarned = true;
    warn(
      "no /proc/<pid>/task/<pid>/children on this kernel (CONFIG_CHECKPOINT_RESTORE) \u2014 agent tool trees that left the process group cannot be reached"
    );
  }
}
function resetProcessTreeWarnings() {
  childrenApiWarned = false;
}
function signalProcessTree(tree, signal, kill, readProc) {
  let signalled = 0;
  for (const [pid, startTime] of tree) {
    try {
      if (processStartTime(pid, readProc) !== startTime) continue;
      kill(pid, signal);
      signalled += 1;
    } catch {
    }
  }
  return signalled;
}
function stopAgentProcessGroup(child, signal, options = {}) {
  const kill = options.kill ?? ((pid, signalName) => process.kill(pid, signalName));
  const readProc = options.readProc ?? readProcFile;
  const running = child.exitCode === null && child.signalCode === null;
  if (child.pid === void 0 || !running) {
    child.kill(signal);
    return;
  }
  let rootStartTime = "";
  try {
    rootStartTime = processStartTime(child.pid, readProc);
  } catch {
  }
  const escaped = collectEscapedProcessTree(child.pid, readProc);
  if (escaped.size === 0) warnIfChildrenApiMissing(child.pid, readProc);
  signalProcessTree(escaped, signal, kill, readProc);
  let rootIdentityMatches = true;
  if (rootStartTime !== "") {
    try {
      rootIdentityMatches = processStartTime(child.pid, readProc) === rootStartTime;
    } catch {
      rootIdentityMatches = false;
    }
  }
  if (rootIdentityMatches) {
    try {
      kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
  if (signal === "SIGKILL" || escaped.size === 0) return;
  setTimeout(() => {
    const killed = signalProcessTree(escaped, "SIGKILL", kill, readProc);
    if (killed > 0) warn(`SIGKILLed ${killed} agent tool process(es) that outlived SIGTERM`);
  }, PROCESS_TREE_KILL_GRACE_MS);
}
function killExitedTrustedCliProcessGroup(child, kill = process.kill) {
  if (child.pid === void 0) return;
  try {
    kill(-child.pid, "SIGKILL");
  } catch {
  }
}
function validateRunnerRuntimeStats(stats, options) {
  if (options.runnerUid === void 0) return;
  if (stats.gid !== Number(options.runnerGid)) {
    throw new Error("runner runtime ownership mismatch");
  }
  const runnerOwned = stats.uid === Number(options.runnerUid);
  const serverOwned = !runnerOwned && (stats.mode & 384) === 0;
  if (!runnerOwned && !serverOwned) {
    throw new Error("runner runtime ownership mismatch");
  }
  if ((stats.mode & 7) !== 0 || (stats.mode & 56) !== 56) {
    throw new Error("runner runtime must be group-only and writable");
  }
}
function brokerSocketOwnership(options) {
  if (options.runnerUid === void 0) return { uid: void 0, gid: void 0, mode: 384 };
  const rootBroker = options.enforceRoot !== false;
  return {
    uid: rootBroker ? 0 : Number(options.runnerUid),
    gid: Number(options.runnerGid),
    mode: rootBroker ? 432 : 384
  };
}
async function readConnectorUrl(path, expectedUid) {
  try {
    const stats = await lstat2(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== expectedUid || (stats.mode & 63) !== 0 || stats.size > 128) {
      throw new Error("invalid Claude connector routing file");
    }
    const value = (await readFile(path, "utf8")).trim();
    if (!isLocalConnectorUrl(value)) {
      throw new Error("invalid Claude connector routing URL");
    }
    return value;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : void 0;
    if (code === "ENOENT") return void 0;
    throw error;
  }
}
async function runAgentSpawnBroker(options = {}) {
  if (options.enforceRoot !== false && process.getuid?.() !== 0)
    throw new Error("agent spawn broker must run as root");
  const admissionLease = await acquireRuntimeAdmissionLease(options);
  let brokerLock;
  try {
    return await runAgentSpawnBrokerOnce(options, admissionLease, (lock) => {
      brokerLock = lock;
    });
  } catch (error) {
    await brokerLock?.close();
    await admissionLease.close();
    throw error;
  }
}
async function runAgentSpawnBrokerOnce(options, admissionLease, onLock) {
  if (options.enforceRoot !== false && process.getuid?.() !== 0) {
    throw new Error("agent spawn broker must run as root");
  }
  validateIdentity(options);
  await validateSharedSessionRoot(options);
  const runtimeDir = resolve(options.runtimeDir ?? DEFAULT_RUNTIME_DIR);
  if (options.enforceRoot === false && options.secretDir === void 0) {
    options = { ...options, secretDir: join2(runtimeDir, "secrets") };
  }
  const controlDir = resolve(
    options.controlDir ?? (options.enforceRoot === false ? runtimeDir : DEFAULT_CONTROL_DIR)
  );
  const stats = await lstat2(runtimeDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("invalid runner runtime");
  if (options.runnerUid === void 0 !== (options.runnerGid === void 0)) {
    throw new Error("runner uid and gid must be configured together");
  }
  validateRunnerRuntimeStats(stats, options);
  const scriptIsolation = options.scriptIsolation ?? // A root probe can fail user-namespace mapping even when the agent can
  // enforce isolation. Probe with the same privilege drop as actual launches.
  await probeScriptSandbox(
    options.scriptSandboxPath ?? DEFAULT_SCRIPT_SANDBOX_PATH,
    SCRIPT_SANDBOX_PROBE_TIMEOUT_MS,
    options.enforceRoot === false ? void 0 : options
  );
  if (!scriptIsolation.available) {
    process.stderr.write(
      `verity-agent-spawn-broker: worktree entry scripts are disabled: ${scriptIsolation.reason ?? "script sandbox unavailable"}
`
    );
  }
  const identity2 = validateIdentity(options);
  const managedRoots = await resolveAgentWorktreeRoots(options);
  const lock = await acquireLock(join2(controlDir, "agent-spawn-broker.lock"));
  onLock(lock);
  await removeLegacyTrustedCliSecretFiles(options);
  const socketPath = join2(controlDir, "agent-spawn-broker.sock");
  await rm(socketPath, { force: true });
  const children = /* @__PURE__ */ new Map();
  const sockets = /* @__PURE__ */ new Set();
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const connectorConfigPath = options.connectorConfigPath ?? join2(controlDir, "egress-connector.url");
  const connectorConfigOwner = options.enforceRoot === false ? process.getuid?.() ?? 0 : 0;
  let closing = false;
  const spawnChild = (command, args, spawnOptions) => {
    const stdio = Array.isArray(spawnOptions.stdio) ? [...spawnOptions.stdio] : Array(3).fill(spawnOptions.stdio ?? "pipe");
    stdio.push(admissionLease.fd);
    return (options.spawnChild ?? spawn2)(command, args, { ...spawnOptions, stdio });
  };
  let codexStartupTail = Promise.resolve();
  const acquireCodexStartup = async () => {
    let releaseSlot = () => void 0;
    const slot = new Promise((resolveSlot) => releaseSlot = resolveSlot);
    const previous = codexStartupTail;
    codexStartupTail = previous.then(() => slot);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  };
  const managedSecrets = createManagedSecretServers({
    uid: identity2.uid,
    gid: identity2.gid,
    privilegeDropFlags: privilegeDropFlags(options.dockerGid, options.runnerGid),
    setprivPath: options.setprivPath,
    env: options.env,
    spawnChild,
    realpath: (path) => agentWorkspaceRead("realpath", path, options),
    stopTagged: (id, signal) => agentWorkspaceRead("managedStop", id + ":" + signal, options),
    allowedPath: (path) => withinAgentWorktreeRoots(path, managedRoots)
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => void 0);
    let buffered = Buffer.alloc(0);
    let child;
    let processing = Promise.resolve();
    let accepted = false;
    let connectionClosed = false;
    let childRecord;
    let protocolFailed = false;
    let trustedCliFailurePhase;
    let trustedCliCorrelationId;
    let releaseCodexStartup = () => void 0;
    const fail = (error) => {
      if (protocolFailed) return;
      protocolFailed = true;
      send(socket, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...trustedCliFailurePhase === void 0 ? {} : {
          trustedCliFailure: {
            phase: trustedCliFailurePhase,
            cause: `${trustedCliFailurePhase} failed`,
            code: trustedCliFailureCode(trustedCliFailurePhase, error),
            ...trustedCliCorrelationId === void 0 ? {} : { correlationId: trustedCliCorrelationId }
          }
        }
      });
      childRecord?.stop("SIGKILL");
      socket.end();
    };
    const handle = async (raw) => {
      if (protocolFailed) return;
      if (!accepted) {
        if (isObject(raw) && raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION && raw.kind === "status") {
          protocolFailed = true;
          send(socket, {
            ok: true,
            protocolVersion: AGENT_SPAWN_PROTOCOL_VERSION,
            managedAgentConfig: true,
            gatewayToolsOnlyVersion: 1,
            persistentSessionHomes: true,
            cacheMaintenanceVersion: 2,
            runtimeAdmissionFenceVersion: 1,
            capacityLeaseVersion: 1,
            planningIsolation: scriptIsolation.available,
            knowledgeIsolation: scriptIsolation.available,
            scriptIsolation: scriptIsolation.available
          });
          socket.end();
          return;
        }
        if (isObject(raw) && raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION && raw.kind === "stack-health") {
          protocolFailed = true;
          send(socket, await runnerStackHealth({ ...options, controlDir }));
          socket.end();
          return;
        }
        if (isObject(raw) && raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION && raw.kind === "egress-readiness") {
          protocolFailed = true;
          send(
            socket,
            await runnerEgressReadiness({ env: options.env, ...options.egressReadiness })
          );
          socket.end();
          return;
        }
        if (closing) throw new Error("agent spawn broker is shutting down");
        if (isObject(raw) && raw.kind === "capacity-lease") {
          protocolFailed = true;
          send(socket, await capacityLeaseRequest(raw, options));
          socket.end();
          return;
        }
        if (isObject(raw) && raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION && raw.kind === "reclaim-package-caches") {
          send(socket, { ok: true, report: await reclaimPackageCaches(raw, options) });
          socket.end();
          return;
        }
        if (isObject(raw) && raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION && ["prepare-session-home", "delete-session-home"].includes(raw.kind)) {
          const home = sessionHomePath(options.runtimeDir, raw.sessionId);
          if (raw.kind === "delete-session-home") {
            await managedDirectory(
              join2(options.runtimeDir, "session-homes"),
              process.getuid(),
              process.getgid()
            );
            await policyWrite(`${home}.deleted`, "{}");
            const owned = [...children.values()].filter(
              (record) => record.sessionId === raw.sessionId
            );
            for (const record of owned) record.stop("SIGKILL");
            await Promise.all(owned.map((record) => record.closed));
            if (activeSessionHomes.has(home)) throw new Error("session storage is still in use");
            const lease = await lockSessionHome(home, options);
            try {
              const manifest = await readFile(join2(home, ".legacy-opencode.json"), "utf8").catch(
                (error) => {
                  if (error.code === "ENOENT") return void 0;
                  throw error;
                }
              );
              if (manifest)
                await nativeStateRequest({ operation: "purge", ...JSON.parse(manifest) }, options);
              await removeKnowledgeIsolation(home, identity2.uid, identity2.gid, options.setprivPath);
            } finally {
              await lease.close();
            }
          } else {
            await waitForSessionHome(home);
            await prepareSessionHome(raw.sessionId, options, {
              backend: raw.legacyBackend,
              sessionId: raw.legacySessionId
            });
          }
          send(socket, { ok: true });
          socket.end();
          return;
        }
        if (isObject(raw) && typeof raw.kind === "string" && raw.kind.startsWith("managed-secret-")) {
          protocolFailed = true;
          try {
            send(socket, { ok: true, ...await managedSecrets.handle(raw) });
          } catch {
            send(socket, { ok: false, error: "Managed secret server request failed." });
          }
          socket.end();
          return;
        }
        if (isObject(raw) && raw.kind === "spawn-trusted-cli") {
          trustedCliFailurePhase = "validation";
        }
        const request = await validateSpawnRequest(raw, options);
        if (request.kind === "trusted-cli") trustedCliCorrelationId = request.correlationId;
        if (!scriptIsolation.available && (request.kind === "trusted-cli" && request.entryScript !== void 0 || request.kind === "agent" && (request.knowledgeIsolation || request.planning))) {
          throw new Error(SCRIPT_ISOLATION_UNAVAILABLE_ERROR);
        }
        if (closing || connectionClosed) throw new Error("agent spawn request was detached");
        const connectorUrl = request.kind === "agent" ? await readConnectorUrl(connectorConfigPath, connectorConfigOwner) : void 0;
        if (request.kind === "trusted-cli") trustedCliFailurePhase = "materialization";
        const materialized = request.kind === "agent" ? { args: request.args, cleanup: async () => void 0 } : await (async () => {
          const entryScript = await materializeTrustedCliEntryScript(request, options);
          let secrets;
          try {
            secrets = await materializeTrustedCliSecrets(request, options);
          } catch (error) {
            await entryScript.cleanup();
            throw error;
          }
          return {
            args: entryScript.args,
            ...entryScript.entrySandbox === void 0 ? {} : { entrySandbox: entryScript.entrySandbox },
            cleanup: async () => {
              const [secretContained] = await Promise.all([
                secrets.cleanup(),
                entryScript.cleanup()
              ]);
              return secretContained;
            }
          };
        })();
        try {
          if (request.kind === "agent" && (request.knowledgeIsolation || request.planning)) {
            const isolated = await (request.planning && !request.knowledgeIsolation ? materializeManagedAgentHome(request, options, connectorUrl) : materializeKnowledgeIsolation(request, options, connectorUrl));
            request.knowledgeHome = isolated.home;
            request.sessionLockFd = isolated.lockFd;
            const cleanup = materialized.cleanup;
            materialized.cleanup = async () => {
              try {
                return await cleanup();
              } finally {
                await isolated.cleanup();
              }
            };
          }
          if (request.kind === "agent" && !request.knowledgeIsolation && !request.planning && (options.enforceRoot !== false || connectorUrl !== void 0 || request.gatewayToolsOnly)) {
            const isolated = await materializeManagedAgentHome(request, options, connectorUrl);
            request.managedHome = isolated.home;
            request.sessionLockFd = isolated.lockFd;
            const cleanup = materialized.cleanup;
            materialized.cleanup = async () => {
              try {
                return await cleanup();
              } finally {
                await isolated.cleanup();
              }
            };
          }
          if (request.kind === "trusted-cli") trustedCliFailurePhase = "launch-spec";
          if (request.kind === "agent") {
            const lease = await acquirePackageCacheLease(options);
            request.packageCacheLockFd = lease.fd;
            const cleanup = materialized.cleanup;
            materialized.cleanup = async () => {
              try {
                return await cleanup();
              } finally {
                await lease.close();
              }
            };
          }
          if (request.kind === "agent" && request.command === "codex-acp") {
            releaseCodexStartup = await acquireCodexStartup();
          }
          const spec = request.kind === "agent" ? agentLaunchSpec(
            { ...request, args: materialized.args },
            {
              ...options,
              connectorUrl,
              signalTraceSeconds: await agentSignalTraceSeconds(controlDir, request)
            }
          ) : trustedCliLaunchSpec(
            {
              ...request,
              args: materialized.args,
              ...materialized.entrySandbox === void 0 ? {} : { entrySandbox: materialized.entrySandbox }
            },
            options
          );
          if (request.kind === "trusted-cli") trustedCliFailurePhase = "spawn";
          child = spawnChild(spec.command, spec.args, spec.spawnOptions);
        } catch (error) {
          releaseCodexStartup();
          throw leakOutranks(await materialized.cleanup(), error);
        }
        const pendingFrames = [];
        let childClosed = false;
        let resolveClosed = () => void 0;
        const closed = new Promise((resolve5) => resolveClosed = resolve5);
        let pendingSignal;
        const stop = (signal) => {
          pendingSignal = signal;
          stopAgentProcessGroup(child, signal);
        };
        childRecord = { child, closed, stop, sessionId: request.sessionEnv?.VERITY_SESSION_ID };
        children.set(child, childRecord);
        child.once("spawn", () => {
          if (pendingSignal !== void 0) child.kill(pendingSignal);
        });
        let spawnErrorCleanup;
        child.once("error", () => {
          releaseCodexStartup();
          spawnErrorCleanup = materialized.cleanup();
        });
        const relay = (kind, chunk) => {
          if (kind === "stdout") releaseCodexStartup();
          const frame = { ok: true, kind, data: chunk.toString("base64") };
          if (!accepted) pendingFrames.push(frame);
          else if (!send(socket, frame)) {
            child.stdout?.pause();
            child.stderr?.pause();
          }
        };
        child.stdout?.on("data", (chunk) => relay("stdout", chunk));
        child.stderr?.on("data", (chunk) => relay("stderr", chunk));
        child.once("exit", () => killExitedTrustedCliProcessGroup(child));
        child.once("close", (code, signal) => {
          releaseCodexStartup();
          childClosed = true;
          children.delete(child);
          const exitFrame = { ok: true, kind: "exit", code, signal };
          const deliver = (frame) => {
            if (!accepted) pendingFrames.push(frame);
            else {
              send(socket, frame);
              socket.end();
            }
            resolveClosed();
          };
          if (request.kind === "trusted-cli") {
            void materialized.cleanup().then(
              (contained) => deliver(
                contained ? exitFrame : (
                  // Containment failed outright, so the credential is still
                  // sitting at a path the agent knows and owns. Reporting the
                  // command's own clean exit here would hide that. The
                  // supervisor turns `ok: false` into a failed run carrying
                  // this reason, which is what gets the secret rotated.
                  { ok: false, error: TRUSTED_CLI_SECRET_LEAK_ERROR }
                )
              )
            );
          } else if (request.knowledgeIsolation || request.kind === "agent") {
            void materialized.cleanup().then(
              () => deliver(exitFrame),
              () => deliver({ ok: false, error: "Could not remove the managed agent runtime home" })
            );
          } else {
            deliver(exitFrame);
            void materialized.cleanup();
          }
        });
        await new Promise((resolveSpawn, rejectSpawn) => {
          child.once("spawn", resolveSpawn);
          child.once("error", rejectSpawn);
        }).catch(async (error) => {
          throw leakOutranks(await spawnErrorCleanup, error);
        });
        if (closing || connectionClosed) {
          stop("SIGKILL");
          throw new Error("agent spawn request was detached");
        }
        accepted = true;
        if (childClosed) children.delete(child);
        socket.on("drain", () => {
          child.stdout?.resume();
          child.stderr?.resume();
        });
        send(socket, {
          ok: true,
          kind: "spawned",
          pid: child.pid
        });
        for (const frame of pendingFrames) send(socket, frame);
        if (childClosed) socket.end();
        return;
      }
      if (!isObject(raw) || raw.protocolVersion !== AGENT_SPAWN_PROTOCOL_VERSION) {
        throw new Error("invalid agent control request");
      }
      if (raw.kind === "stdin" && typeof raw.data === "string") {
        if (child.stdin?.write(decode(raw.data)) === false) {
          socket.pause();
          child.stdin.once("drain", () => socket.resume());
        }
      } else if (raw.kind === "close-stdin") child.stdin?.end();
      else if (raw.kind === "signal" && ["SIGTERM", "SIGKILL"].includes(raw.signal))
        childRecord.stop(raw.signal);
      else throw new Error("invalid agent control request");
    };
    socket.on("data", (chunk) => {
      if (buffered.length + chunk.length > maxFrameBytes) {
        fail(new Error("agent broker frame too large"));
        socket.destroy();
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      for (; ; ) {
        const newline = buffered.indexOf(10);
        if (newline < 0) break;
        const line = buffered.subarray(0, newline).toString("utf8");
        buffered = buffered.subarray(newline + 1);
        processing = processing.then(async () => await handle(JSON.parse(line))).catch(fail);
      }
    });
    socket.once("close", () => {
      connectionClosed = true;
      childRecord?.stop("SIGKILL");
    });
  });
  const previousUmask = process.umask(63);
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
  } finally {
    process.umask(previousUmask);
  }
  const socketOwnership = brokerSocketOwnership(options);
  if (socketOwnership.uid !== void 0 && socketOwnership.gid !== void 0) {
    await chown(socketPath, socketOwnership.uid, socketOwnership.gid);
  }
  await chmod(socketPath, socketOwnership.mode);
  return {
    socketPath,
    async close() {
      closing = true;
      await managedSecrets.close();
      const running = [...children.values()];
      for (const record of running) record.stop("SIGTERM");
      const escalation = setTimeout(() => {
        for (const record of running) {
          if (record.child.exitCode === null) record.stop("SIGKILL");
        }
      }, options.shutdownGraceMs ?? 5e3);
      await Promise.all(running.map((record) => record.closed));
      clearTimeout(escalation);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
      await rm(socketPath, { force: true });
      await lock.close();
      await admissionLease.close();
    }
  };
}
async function probeAgentSpawnBroker(controlDir = DEFAULT_CONTROL_DIR, timeoutMs = 1e3) {
  const socketPath = join2(resolve(controlDir), "agent-spawn-broker.sock");
  return await new Promise((resolveProbe) => {
    const socket = createConnection(socketPath);
    let response = "";
    let finished = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (live) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(live);
    };
    socket.once("error", () => finish(false));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => {
      try {
        const parsed = JSON.parse(response);
        finish(parsed?.ok === true && parsed.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION);
      } catch {
        finish(false);
      }
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ protocolVersion: AGENT_SPAWN_PROTOCOL_VERSION, kind: "status" })}
`
      );
    });
  });
}

// features/verity-sandbox-toolkit/src/spawn-broker/session-home.mjs
async function packageCacheDirectory(options) {
  const { uid, gid } = validateIdentity(options);
  const root = join3(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, "package-cache");
  try {
    await mkdir2(root, { mode: 493 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const rootMetadata = await lstat3(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || rootMetadata.uid !== process.getuid() || (rootMetadata.mode & 18) !== 0 || await realpath2(root) !== root)
    throw new Error("invalid package cache root");
  await chmod2(root, 493);
  const cache = npmCachePath(options);
  try {
    await mkdir2(cache, { mode: 448 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const metadata2 = await lstat3(cache);
  if (!metadata2.isDirectory() || metadata2.isSymbolicLink() || metadata2.uid !== uid && metadata2.uid !== process.getuid() || (metadata2.mode & 511) !== 448)
    throw new Error("invalid package cache");
  if (metadata2.uid !== uid || metadata2.gid !== gid) await chown2(cache, uid, gid);
  return cache;
}
async function acquireRuntimeAdmissionLease(options, exclusive = false) {
  const runtime = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const root = await lstat3(runtime);
  if (!root.isDirectory() || root.isSymbolicLink() || options.runnerUid === void 0 && root.uid !== process.getuid() || (root.mode & 2) !== 0 || await realpath2(runtime) !== runtime)
    throw new Error("unsafe runner runtime");
  validateRunnerRuntimeStats(root, options);
  const handle = await open2(
    join3(runtime, "admission.lock"),
    constants2.O_CREAT | constants2.O_RDWR | constants2.O_NOFOLLOW,
    384
  );
  try {
    const metadata2 = await handle.stat();
    if (!metadata2.isFile() || metadata2.uid !== process.getuid() || metadata2.nlink !== 1 || (metadata2.mode & 63) !== 0)
      throw new Error("invalid runtime admission lease");
    await new Promise((resolveLock, rejectLock) => {
      const child = spawn3(
        "/usr/bin/flock",
        [...exclusive ? ["--exclusive", "--nonblock"] : ["--shared", "--wait", "30"], "3"],
        { stdio: ["ignore", "ignore", "ignore", handle.fd] }
      );
      child.once("error", rejectLock);
      child.once(
        "exit",
        (code) => code === 0 ? resolveLock() : rejectLock(new Error("runner runtime is in use"))
      );
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function reclaimPackageCachesOffline(request, options) {
  const lease = await acquireRuntimeAdmissionLease(options, true);
  try {
    return await reclaimPackageCaches(request, { ...options, runtimeAdmissionLockFd: lease.fd });
  } finally {
    await lease.close();
  }
}
async function packageCacheMaintenanceMain(runtimeDir) {
  let input = "";
  const inputDeadline = setTimeout(() => {
    process.stdin.destroy(new Error("package cache maintenance request timed out"));
  }, 5e3);
  try {
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 96 * 1024)
        throw new Error("invalid package cache maintenance request");
    }
  } finally {
    clearTimeout(inputDeadline);
  }
  const request = JSON.parse(input);
  if (!isObject(request) || !Array.isArray(request.sessionIds) || request.sessionIds.length > 512)
    throw new Error("invalid package cache maintenance request");
  const report = await reclaimPackageCachesOffline(request, {
    runtimeDir,
    agentUid: Number(process.env.VERITY_AGENT_UID ?? 1e3),
    agentGid: Number(process.env.VERITY_AGENT_GID ?? 1e3),
    runnerUid: Number(process.env.VERITY_RUNNER_RUNTIME_UID ?? 1101),
    runnerGid: Number(process.env.VERITY_RUNNER_RUNTIME_GID ?? 1101)
  });
  const output = JSON.stringify({ ok: true, report });
  if (Buffer.byteLength(output) > 64 * 1024)
    throw new Error("invalid package cache maintenance result");
  process.stdout.write(output);
  return true;
}
async function acquirePackageCacheLease(options, exclusive = false) {
  await packageCacheDirectory(options);
  const handle = await open2(
    join3(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, "package-cache", "npm.lock"),
    constants2.O_CREAT | constants2.O_RDWR | constants2.O_NOFOLLOW,
    384
  );
  try {
    const metadata2 = await handle.stat();
    if (!metadata2.isFile() || metadata2.uid !== process.getuid() || metadata2.nlink !== 1)
      throw new Error("invalid package cache lease");
    await new Promise((resolveLock, rejectLock) => {
      const child = spawn3(
        "/usr/bin/flock",
        [...exclusive ? ["--exclusive", "--nonblock"] : ["--shared", "--wait", "30"], "3"],
        { stdio: ["ignore", "ignore", "ignore", handle.fd] }
      );
      child.once("error", rejectLock);
      child.once(
        "exit",
        (code) => code === 0 ? resolveLock() : rejectLock(new Error("package cache is in use"))
      );
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function cacheTreeBytes(path, budget, owner) {
  if (++budget.entries > 1e5 || Date.now() > budget.deadline)
    throw new Error("package cache inventory limit");
  const metadata2 = await lstat3(path);
  if (metadata2.isSymbolicLink() || !metadata2.isDirectory() && !metadata2.isFile() || metadata2.uid !== owner || metadata2.isFile() && metadata2.nlink !== 1)
    throw new Error("unsafe package cache entry");
  let bytes = metadata2.blocks * 512;
  if (metadata2.isDirectory()) {
    const directory = await opendir(path);
    for await (const entry of directory)
      bytes += await cacheTreeBytes(join3(path, entry.name), budget, owner);
  }
  return bytes;
}
async function validatedCacache(parent, options, budget) {
  const { uid } = validateIdentity(options);
  const parentMetadata = await lstat3(parent).catch((error) => {
    if (error.code === "ENOENT") return void 0;
    throw error;
  });
  if (!parentMetadata) return { path: join3(parent, "_cacache"), bytes: 0 };
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || parentMetadata.uid !== uid || await realpath2(parent) !== parent)
    throw new Error("unsafe package cache root");
  const path = join3(parent, "_cacache");
  const metadata2 = await lstat3(path).catch((error) => {
    if (error.code === "ENOENT") return void 0;
    throw error;
  });
  if (!metadata2) return { path, bytes: 0 };
  if (!metadata2.isDirectory() || metadata2.isSymbolicLink())
    throw new Error("unsafe package cache root");
  return { path, bytes: await cacheTreeBytes(path, budget, uid) };
}
async function maintainPackageCache(parent, options, budget, maxBytes, shared = false) {
  const { uid, gid } = validateIdentity(options);
  if (uid === process.getuid() && gid === process.getgid())
    return await collectPackageCacheLeaf(parent, options, budget, maxBytes, shared);
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn3(
      options.setprivPath ?? "/usr/bin/setpriv",
      [
        `--reuid=${uid}`,
        `--regid=${gid}`,
        "--clear-groups",
        process.execPath,
        fileURLToPath(import.meta.url),
        "--package-cache-leaf"
      ],
      {
        stdio: [
          "pipe",
          "pipe",
          "ignore",
          ...options.runtimeAdmissionLockFd === void 0 ? [] : [options.runtimeAdmissionLockFd]
        ],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" }
      }
    );
    let output = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      Math.max(1, budget.deadline - Date.now())
    );
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 4096) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 4096)
        return rejectResult(new Error("package cache owner operation could not be verified"));
      try {
        resolveResult(JSON.parse(output));
      } catch {
        rejectResult(new Error("invalid package cache owner result"));
      }
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(
      JSON.stringify({
        parent,
        maxBytes,
        shared,
        remainingEntries: 1e5 - budget.entries,
        durationMs: Math.max(1, budget.deadline - Date.now())
      })
    );
  });
  if (!result || !Number.isSafeInteger(result.entries) || result.entries < 0 || !Number.isSafeInteger(result.removedBytes) || result.removedBytes < 0 || !Number.isSafeInteger(result.remainingBytes) || result.remainingBytes < 0 || typeof result.pruned !== "boolean" || typeof result.otherEntries !== "boolean")
    throw new Error("invalid package cache owner result");
  budget.entries += result.entries;
  return result;
}
async function collectPackageCacheLeaf(parent, options, budget, maxBytes, shared) {
  const before = budget.entries;
  const cache = await validatedCacache(parent, options, budget);
  const pruned = cache.bytes > maxBytes;
  let otherEntries = false;
  if (shared) {
    const directory = await opendir(parent);
    for await (const entry of directory) {
      if (++budget.entries > 1e5 || Date.now() > budget.deadline)
        throw new Error("package cache inventory limit");
      if (entry.name !== "_cacache") otherEntries = true;
    }
  }
  if (pruned) await rm2(cache.path, { recursive: true });
  return {
    remainingBytes: pruned ? 0 : cache.bytes,
    removedBytes: pruned ? cache.bytes : 0,
    pruned,
    otherEntries,
    entries: budget.entries - before
  };
}
async function packageCacheLeafMain() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 4096) throw new Error("invalid package cache owner request");
  }
  const value = JSON.parse(input);
  if (typeof value.parent !== "string" || !isAbsolute(value.parent) || !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 0 || typeof value.shared !== "boolean" || !Number.isSafeInteger(value.remainingEntries) || value.remainingEntries < 0 || value.remainingEntries > 1e5 || !Number.isSafeInteger(value.durationMs) || value.durationMs < 1 || value.durationMs > 15e3)
    throw new Error("invalid package cache owner request");
  const result = await collectPackageCacheLeaf(
    value.parent,
    { enforceRoot: false, agentUid: process.getuid(), agentGid: process.getgid() },
    { entries: 1e5 - value.remainingEntries, deadline: Date.now() + value.durationMs },
    value.maxBytes,
    value.shared
  );
  process.stdout.write(JSON.stringify(result));
  return true;
}
async function reclaimPackageCaches(request, options) {
  if (!Array.isArray(request.sessionIds) || request.sessionIds.length > 1e3 || new Set(request.sessionIds).size !== request.sessionIds.length || !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0)
    throw new Error("invalid package cache reclamation request");
  const homes = request.sessionIds.map(
    (id) => sessionHomePath(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, id)
  );
  const report = {
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sharedBytes: null,
    legacyBytes: 0,
    removedBytes: 0,
    legacyCachesRemoved: 0,
    sharedCachePruned: false,
    usageComplete: true,
    blockers: []
  };
  const block = (reason) => {
    report.usageComplete = false;
    if (report.blockers.length < 100) report.blockers.push(String(reason).slice(0, 500));
  };
  const budget = { entries: 0, deadline: Date.now() + 15e3 };
  let safeHomes = true;
  try {
    const directory = join3(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, "session-homes");
    const metadata2 = await lstat3(directory).catch((error) => {
      if (error.code === "ENOENT") return void 0;
      throw error;
    });
    if (metadata2) {
      if (!metadata2.isDirectory() || metadata2.isSymbolicLink() || metadata2.uid !== process.getuid() || (metadata2.mode & 18) !== 0 || await realpath2(directory) !== directory)
        throw new Error("unsafe session homes root");
      const owned = new Set(homes);
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (++budget.entries > 1e5 || Date.now() > budget.deadline)
          throw new Error("package cache inventory limit");
        if (/^[a-f0-9]{64}$/u.test(entry.name) && !owned.has(join3(directory, entry.name))) {
          report.legacyBytes = null;
          block("session home ownership is unknown");
        }
      }
    }
  } catch (error) {
    safeHomes = false;
    report.legacyBytes = null;
    block(error.message);
  }
  for (const home of safeHomes ? homes : []) {
    let lease2;
    try {
      if (Date.now() > budget.deadline) throw new Error("package cache inventory limit");
      if (activeSessionHomes.has(home)) throw new Error("session home is in use");
      const metadata2 = await lstat3(home).catch((error) => {
        if (error.code === "ENOENT") return void 0;
        throw error;
      });
      if (!metadata2) continue;
      if (!metadata2.isDirectory() || metadata2.isSymbolicLink() || metadata2.uid !== process.getuid() && metadata2.uid !== validateIdentity(options).uid || await realpath2(home) !== home)
        throw new Error("unsafe session home");
      lease2 = await lockSessionHome(home, options, true);
      if (activeSessionHomes.has(home)) throw new Error("session home is in use");
      const cache = await maintainPackageCache(join3(home, "cache"), options, budget, 0);
      report.removedBytes += cache.removedBytes;
      if (cache.pruned) report.legacyCachesRemoved++;
    } catch (error) {
      report.legacyBytes = null;
      block(error.message);
    } finally {
      await lease2?.close();
    }
  }
  let lease;
  try {
    lease = await acquirePackageCacheLease(options, true);
    const cache = await maintainPackageCache(
      npmCachePath(options),
      options,
      budget,
      request.maxBytes,
      true
    );
    report.removedBytes += cache.removedBytes;
    report.sharedCachePruned = cache.pruned;
    report.sharedBytes = cache.remainingBytes;
    if (cache.otherEntries) {
      report.sharedBytes = null;
      block("Retained non-cacache npm cache entries have unknown allocation");
    }
  } catch (error) {
    block(error.message);
  } finally {
    await lease?.close();
  }
  return report;
}
async function claimSessionHome(request, options) {
  const sessionId = request.sessionEnv?.VERITY_SESSION_ID;
  if (request.knowledgeIsolation || typeof sessionId !== "string") return void 0;
  const home = sessionHomePath(options.runtimeDir, sessionId);
  await waitForSessionHome(home);
  if (activeSessionHomes.has(home)) throw new Error(SESSION_HOME_BUSY);
  activeSessionHomes.add(home);
  try {
    sessionHomeLocks.set(home, await lockSessionHome(home, options));
    await prepareSessionHome(sessionId, options);
    return home;
  } catch (error) {
    activeSessionHomes.delete(home);
    await sessionHomeLocks.get(home)?.close();
    sessionHomeLocks.delete(home);
    throw error;
  }
}
async function nativeStateRequest(request, options) {
  const { uid, gid } = validateIdentity(options);
  return await new Promise((resolveNative, rejectNative) => {
    const sameIdentity = process.getuid() === uid && process.getgid() === gid;
    const helper = options.enforceRoot === false ? fileURLToPath(new URL("./verity-session-state.mjs", import.meta.url)) : "/usr/local/bin/verity-session-state.mjs";
    const args = [process.execPath, helper];
    const child = spawn3(
      sameIdentity ? args[0] : options.setprivPath ?? "/usr/bin/setpriv",
      sameIdentity ? args.slice(1) : [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", ...args],
      { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/local/bin:/usr/bin:/bin" } }
    );
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 3e4);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 65536) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectNative(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 65536)
        return rejectNative(new Error("Native session migration or cleanup could not be verified"));
      try {
        resolveNative(JSON.parse(output));
      } catch {
        rejectNative(new Error("Invalid native session migration result"));
      }
    });
    child.stdin.on("error", () => void 0);
    child.stdin.end(JSON.stringify(request));
  });
}
async function prepareSessionHome(sessionId, options, migration) {
  const home = sessionHomePath(options.runtimeDir, sessionId);
  const marker = `${home}.deleted`;
  const lease = sessionHomeLocks.has(home) ? void 0 : await lockSessionHome(home, options);
  try {
    if (await lstat3(marker).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    ))
      throw new Error("session home has been deleted");
    const { uid, gid } = validateIdentity(options);
    await managedDirectory(
      join3(options.runtimeDir, "session-homes"),
      process.getuid(),
      process.getgid()
    );
    await managedDirectory(home, process.getuid(), process.getgid());
    for (const name of ["claude", "codex", "config"])
      await managedDirectory(join3(home, name), process.getuid(), process.getgid());
    for (const relative of [
      "claude/projects",
      "codex/sessions",
      "codex/thread-writer-locks",
      "codex-state",
      "data",
      "state",
      "cache",
      "tmp"
    ]) {
      const path = join3(home, relative);
      try {
        await mkdir2(path, { mode: 448 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const metadata2 = await lstat3(path);
      if (!metadata2.isDirectory() || metadata2.isSymbolicLink())
        throw new Error("invalid session storage");
      await chown2(path, uid, gid);
    }
    if (migration?.backend === "opencode-acp" && migration.sessionId !== void 0) {
      if (typeof migration.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(migration.sessionId))
        throw new Error("invalid legacy native session id");
      const source = join3(
        options.enforceRoot === false ? join3(options.runtimeDir, "opencode-state") : OPENCODE_STATE_DIR,
        "data",
        "opencode",
        "opencode.db"
      );
      const result = await nativeStateRequest(
        {
          source,
          target: join3(home, "data", "opencode", "opencode.db"),
          rootId: migration.sessionId
        },
        options
      );
      if (Array.isArray(result.sessionIds) && result.sessionIds.length) {
        if (!result.sessionIds.every(
          (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)
        ))
          throw new Error("Invalid migrated native session identity");
        await policyWrite(
          join3(home, ".legacy-opencode.json"),
          JSON.stringify({ source, sessionIds: result.sessionIds })
        );
      }
    }
    return home;
  } finally {
    await lease?.close();
  }
}
async function prepareKnowledgeIsolation(request, options, connectorUrl) {
  if (!isLocalConnectorUrl(connectorUrl))
    throw new Error("Wiki isolation requires the local model gateway");
  const { uid, gid } = validateIdentity(options);
  const parent = options.enforceRoot === false ? join3(options.runtimeDir, "wiki-homes") : "/run/verity-knowledge";
  await mkdir2(parent, { recursive: true, mode: 493 });
  if (options.enforceRoot !== false) await validateImmutablePath(parent);
  await chmod2(parent, 457);
  const home = await claimSessionHome(request, options) ?? await mkdtemp(join3(parent, "job-"));
  try {
    await chmod2(home, 448);
    const directories = [];
    for (const relative of ["claude", "codex", "config", "data", "state", "cache", "tmp"]) {
      const directory = join3(home, relative);
      await managedDirectory(directory, process.getuid(), process.getgid());
      directories.push(directory);
    }
    const files = [];
    const writeConfig = async (path, content) => {
      await policyWrite(path, content, { mode: 384 });
      files.push(path);
    };
    const gateway = new URL(connectorUrl);
    await writeConfig(
      join3(home, "codex", "config.toml"),
      [
        'model_provider = "verity_gateway"',
        "[model_providers.verity_gateway]",
        'name = "Verity Gateway"',
        `base_url = "${gateway.origin}/codex"`,
        'env_key = "VERITY_CODEX_PLACEHOLDER"',
        'http_headers = { "x-openai-actor-authorization" = "verity-codex-gateway-placeholder-v1" }',
        'wire_api = "responses"',
        "requires_openai_auth = false"
      ].join("\n")
    );
    if (request.command === "opencode-acp") {
      const configPath = options.env?.OPENCODE_CONFIG;
      if (typeof configPath !== "string")
        throw new Error("Wiki isolation requires configured OpenCode models");
      const config = JSON.parse(await readFile2(configPath, "utf8"));
      const models = config?.provider?.verity?.models;
      if (!models || typeof models !== "object" || Array.isArray(models))
        throw new Error("Invalid OpenCode model gateway configuration");
      await writeConfig(
        join3(home, "config", "opencode.json"),
        JSON.stringify({
          autoupdate: false,
          provider: {
            verity: {
              npm: "@opencode/ai/providers/openai-compatible",
              name: "Verity",
              options: {
                baseURL: `${gateway.origin}/opencode`,
                apiKey: "verity-opencode-gateway-placeholder-v1"
              },
              models: Object.fromEntries(
                Object.keys(models).map((model) => [model, { name: model }])
              )
            }
          }
        })
      );
    }
    if (!activeSessionHomes.has(home)) {
      for (const file of files) await chown2(file, uid, gid);
      for (const directory of directories) await chown2(directory, uid, gid);
      await chown2(home, uid, gid);
    } else {
      for (const directory of directories.slice(3)) {
        await chmod2(directory, 448);
        await chown2(directory, uid, gid);
      }
    }
    return home;
  } catch (error) {
    if (!activeSessionHomes.has(home))
      await removeKnowledgeIsolation(home, uid, gid, options.setprivPath);
    activeSessionHomes.delete(home);
    await sessionHomeLocks.get(home)?.close();
    sessionHomeLocks.delete(home);
    throw error;
  }
}
async function removeKnowledgeIsolation(home, uid, gid, setprivPath = "/usr/bin/setpriv") {
  try {
    await rm2(home, { recursive: true, force: true });
    return;
  } catch {
    for (const name of ["config/opencode", "config", "codex", "claude", "."]) {
      const path = join3(home, name);
      try {
        const metadata2 = await lstat3(path);
        if (metadata2.isDirectory() && metadata2.uid === process.getuid()) {
          await chmod2(path, 448);
          await chown2(path, uid, gid);
        }
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
      }
    }
    const asAgent = async (args) => {
      await new Promise((resolveCleanup, rejectCleanup) => {
        const sameIdentity = process.getuid() === uid && process.getgid() === gid;
        const child = spawn3(
          sameIdentity ? "/usr/bin/find" : setprivPath,
          sameIdentity ? args : [
            `--reuid=${String(uid)}`,
            `--regid=${String(gid)}`,
            "--clear-groups",
            "/usr/bin/find",
            ...args
          ],
          { stdio: "ignore" }
        );
        child.once("error", rejectCleanup);
        child.once(
          "close",
          (code) => code === 0 ? resolveCleanup() : rejectCleanup(new Error("Agent home cleanup failed"))
        );
      });
    };
    await asAgent([home, "-type", "d", "-exec", "/bin/chmod", "u+rwx", "{}", ";"]);
    await asAgent([home, "-mindepth", "1", "-delete"]);
    await rmdir(home);
  }
}
async function materializeKnowledgeIsolation(request, options, connectorUrl) {
  const { uid, gid } = validateIdentity(options);
  const home = await prepareKnowledgeIsolation(request, options, connectorUrl);
  const persistent = activeSessionHomes.has(home);
  let cleaned = false;
  return {
    home,
    lockFd: sessionHomeLocks.get(home)?.fd,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      if (persistent) {
        try {
          await removeKnowledgeIsolation(join3(home, "tmp"), uid, gid, options.setprivPath);
        } finally {
          activeSessionHomes.delete(home);
          await sessionHomeLocks.get(home)?.close();
          sessionHomeLocks.delete(home);
        }
      } else await removeKnowledgeIsolation(home, uid, gid, options.setprivPath);
    }
  };
}
function planningRuntimeRoots(request, options) {
  if (!request.planning || request.knowledgeIsolation || request.sessionEnv?.VERITY_SESSION_ID)
    return [];
  if (request.command === "codex-acp" && options.runtimeDir)
    return [join3(options.runtimeDir, "codex-sessions"), join3(options.runtimeDir, "codex-state")];
  if (request.command === "claude-agent-acp" && options.env?.CLAUDE_CONFIG_DIR)
    return [join3(options.env.CLAUDE_CONFIG_DIR, "projects")];
  if (request.command === "opencode-acp")
    return [
      options.enforceRoot === false ? join3(options.runtimeDir, "opencode-state") : OPENCODE_STATE_DIR
    ];
  return [];
}
function restrictedCodexModelCatalog(model) {
  if (typeof model !== "string" || !/^codex\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model) || model === "codex/default")
    throw new Error("Native tool isolation requires a concrete Codex model");
  const slug = model.slice("codex/".length);
  return {
    models: [
      {
        slug,
        display_name: slug,
        description: "Verity tool isolation",
        base_instructions: "You are Verity. Complete the supplied assignment using only the provided Verity tools.",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["minimal", "low", "medium", "high", "xhigh"].map((effort) => ({
          effort,
          description: effort
        })),
        shell_type: "disabled",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        support_verbosity: false,
        apply_patch_tool_type: null,
        truncation_policy: { mode: "bytes", limit: 1e4 },
        experimental_supported_tools: [],
        tool_mode: null,
        input_modalities: ["text"],
        node_repl_disabled: true,
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false
      }
    ]
  };
}
function restrictedOpenCodePermissions() {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "verity_*", resource: "*", effect: "allow" }
  ];
}
function restrictedOpenCodePolicies() {
  return [
    { action: "provider.use", resource: "*", effect: "deny" },
    { action: "provider.use", resource: "verity", effect: "allow" },
    { action: "tool.use", resource: "*", effect: "deny" },
    { action: "tool.use", resource: "verity_*:*", effect: "allow" },
    { action: "skill.use", resource: "*", effect: "deny" },
    { action: "plugin.use", resource: "*", effect: "deny" },
    { action: "mcp.use", resource: "*", effect: "deny" },
    { action: "mcp.use", resource: "verity", effect: "allow" }
  ];
}
async function materializeManagedAgentHome(request, options, connectorUrl) {
  const { uid, gid } = validateIdentity(options);
  const isolated = await materializeKnowledgeIsolation(request, options, connectorUrl);
  const home = isolated.home;
  try {
    await chown2(home, process.getuid(), process.getgid());
    await chmod2(home, 493);
    for (const name of ["claude", "codex", "config"]) {
      const directory = join3(home, name);
      await chown2(directory, process.getuid(), process.getgid());
      await chmod2(directory, 493);
    }
    let gitPolicy = "";
    try {
      const template = await open2(
        "/etc/verity-agent.gitconfig",
        constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK
      );
      try {
        const metadata2 = await template.stat();
        if (!metadata2.isFile() || metadata2.uid !== 0 || (metadata2.mode & 18) !== 0 || metadata2.size > 65536)
          throw new Error("Untrusted managed Git configuration");
        gitPolicy = await template.readFile("utf8");
      } finally {
        await template.close();
      }
    } catch (error) {
      if (error.code !== "ENOENT" || options.enforceRoot !== false) throw error;
    }
    const gitValue = (value) => JSON.stringify(value);
    const gitIgnore = join3(home, "config", "git-ignore");
    await policyWrite(
      gitIgnore,
      ".gh-token\n.env\n.agents/.last-code-review-sha\n.agents/.last-code-review-run\n.agents/.local-checks-skip\n",
      { mode: 420 }
    );
    const gitIdentity = options.env ?? {};
    await policyWrite(
      join3(home, ".gitconfig"),
      [
        gitPolicy,
        "[core]",
        `excludesFile = ${gitValue(gitIgnore)}`,
        "[user]",
        ...gitIdentity.GIT_USER_NAME ? [`name = ${gitValue(gitIdentity.GIT_USER_NAME)}`] : [],
        ...gitIdentity.GIT_USER_EMAIL ? [`email = ${gitValue(gitIdentity.GIT_USER_EMAIL)}`] : []
      ].join("\n"),
      { mode: 420 }
    );
    const configFile = join3(home, "codex", "config.toml");
    await chown2(configFile, process.getuid(), process.getgid());
    const codexConfig = await readFile2(configFile, "utf8");
    await policyWrite(
      configFile,
      [
        `sqlite_home = ${JSON.stringify(join3(home, "codex-state"))}`,
        `log_dir = ${JSON.stringify(join3(home, "state"))}`,
        "skills.include_instructions = false",
        ...request.gatewayToolsOnly === true ? [
          'web_search = "disabled"',
          ...request.command === "codex-acp" ? [
            `model = ${JSON.stringify(request.gatewayToolsModel.slice("codex/".length))}`,
            `model_catalog_json = ${JSON.stringify(join3(home, "codex", "restricted-models.json"))}`
          ] : []
        ] : [],
        codexConfig,
        "[features]",
        "multi_agent = false",
        "plugins = false",
        ...request.gatewayToolsOnly === true ? [
          ...[
            "shell_tool",
            "unified_exec",
            "multi_agent_v2",
            "goals",
            "view_image",
            "apps",
            "browser_use",
            "browser_use_external",
            "browser_use_full_cdp_access",
            "computer_use",
            "in_app_browser",
            "image_generation",
            "tool_suggest",
            "sleep_tool",
            "skill_search",
            "skill_mcp_dependency_install",
            "code_mode_host",
            "code_mode",
            "hooks",
            "deferred_executor",
            "context_management",
            "chronicle"
          ].map((name) => `${name} = false`),
          "[tools.experimental_request_user_input]",
          "enabled = false"
        ] : [],
        "[hooks]"
        // No trusted projects are imported from the former user home. Codex's
        // loader disables project-local config, hooks and exec policies by default.
      ].join("\n")
    );
    await chmod2(configFile, 420);
    if (request.gatewayToolsOnly === true && request.command === "codex-acp") {
      await policyWrite(
        join3(home, "codex", "restricted-models.json"),
        JSON.stringify(restrictedCodexModelCatalog(request.gatewayToolsModel)),
        { mode: 420 }
      );
    }
    const writable = async (path) => {
      try {
        await mkdir2(path, { mode: 448 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const metadata2 = await lstat3(path);
      if (!metadata2.isDirectory() || metadata2.isSymbolicLink())
        throw new Error("invalid writable session directory");
      await chown2(path, uid, gid);
    };
    try {
      const installationId = await open2(
        join3(home, "codex", "installation_id"),
        constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | constants2.O_NOFOLLOW,
        384
      );
      try {
        await installationId.writeFile(randomUUID2());
        await installationId.chown(uid, gid);
      } finally {
        await installationId.close();
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await writable(join3(home, "codex-state"));
    for (const name of ["tmp", ".tmp", "skills", "log", "shell_snapshots"])
      await writable(join3(home, "codex", name));
    for (const name of [
      "todos",
      "tasks",
      "debug",
      "session-env",
      "shell-snapshots",
      "plans",
      "telemetry"
    ])
      await writable(join3(home, "claude", name));
    if (activeSessionHomes.has(home)) {
      await writable(join3(home, "claude", "projects"));
      await writable(join3(home, "codex", "sessions"));
      await writable(join3(home, "codex", "thread-writer-locks"));
    } else {
      if (options.env?.CLAUDE_CONFIG_DIR)
        await symlink(
          join3(options.env.CLAUDE_CONFIG_DIR, "projects"),
          join3(home, "claude", "projects")
        );
      else await writable(join3(home, "claude", "projects"));
      if (options.runtimeDir) {
        await symlink(
          join3(options.runtimeDir, "codex-state", "thread-writer-locks"),
          join3(home, "codex", "thread-writer-locks")
        );
        await symlink(join3(options.runtimeDir, "codex-sessions"), join3(home, "codex", "sessions"));
      } else {
        await writable(join3(home, "codex", "sessions"));
        await writable(join3(home, "codex", "thread-writer-locks"));
      }
    }
    await policyWrite(
      join3(home, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
      {
        mode: 420
      }
    );
    const openCodeDir = join3(home, "config", "opencode");
    await managedDirectory(openCodeDir, process.getuid(), process.getgid());
    await policyWrite(join3(openCodeDir, ".gitignore"), "*\n", { mode: 420 });
    if (request.command === "opencode-acp") {
      const path = join3(home, "config", "opencode.json");
      await chown2(path, process.getuid(), process.getgid());
      if (request.gatewayToolsOnly === true) {
        const config = JSON.parse(await readFile2(path, "utf8"));
        config.policies = restrictedOpenCodePolicies();
        config.permissions = restrictedOpenCodePermissions();
        await policyWrite(path, JSON.stringify(config), { mode: 420 });
      }
      await chmod2(path, 420);
    }
    for (const path of [
      join3(home, ".gitconfig"),
      gitIgnore,
      join3(home, ".claude.json"),
      join3(openCodeDir, ".gitignore")
    ])
      await chmod2(path, 420);
    await chmod2(openCodeDir, 493);
    return isolated;
  } catch (error) {
    await isolated.cleanup();
    throw error;
  }
}
async function agentSignalTraceSeconds(controlDir, request, now = Date.now()) {
  if (request.command !== "codex-acp" || request.knowledgeIsolation || typeof request.sessionEnv?.VERITY_SESSION_ID !== "string")
    return void 0;
  let handle;
  try {
    handle = await open2(
      join3(controlDir, "signal-trace.json"),
      constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 18) !== 0 || stat.size > 4096)
      return void 0;
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return void 0;
    return validateAgentSignalTraceLease(
      buffer.subarray(0, bytesRead).toString("utf8"),
      request,
      now
    );
  } catch {
    return void 0;
  } finally {
    await handle?.close();
  }
}
function validateAgentSignalTraceLease(text, request, now = Date.now()) {
  if (request.command !== "codex-acp" || request.knowledgeIsolation || text.length > 4096)
    return void 0;
  try {
    const lease = JSON.parse(text);
    if (!isObject(lease) || Object.keys(lease).sort().join(",") !== "expiresAt,sessionId" || typeof lease.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(lease.sessionId) || lease.sessionId !== request.sessionEnv?.VERITY_SESSION_ID || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now || lease.expiresAt > now + 6e5)
      return void 0;
    const seconds = Math.floor((lease.expiresAt - now) / 1e3);
    return seconds > 0 ? seconds : void 0;
  } catch {
    return void 0;
  }
}
function nodeRuntimeRoots() {
  return lstatSync("/etc/ssl/openssl.cnf", { throwIfNoEntry: false }) ? ["--secret", "/etc/ssl/openssl.cnf"] : [];
}

// features/verity-sandbox-toolkit/src/spawn-broker/launch.mjs
function claudePolicyRoots(command) {
  if (command !== "claude-agent-acp") return [];
  const path = "/etc/claude-code";
  const metadata2 = lstatSync2(path, { throwIfNoEntry: false });
  if (!metadata2) return [];
  if (!metadata2.isDirectory() || metadata2.isSymbolicLink() || metadata2.uid !== 0 || (metadata2.mode & 18) !== 0)
    throw new Error("Invalid Claude managed policy directory");
  return ["--read-root", path];
}
function normalSessionRoots(options, agentPath) {
  const roots = [];
  for (const [flag, path] of [
    // Image-owned hooks and wrapper targets must remain executable under confinement.
    ["--read-root", "/opt/agent-seed"],
    ["--read-root", "/opt/verity/package-managers"],
    ["--read-root", "/knowledge"],
    ["--write-root", "/knowledge/insights"]
  ]) {
    try {
      const metadata2 = lstatSync2(path);
      if (!metadata2.isDirectory() || metadata2.isSymbolicLink())
        throw new Error("Invalid session access root");
      roots.push(flag, path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const moduleRoots = /* @__PURE__ */ new Set();
  for (const executable of [
    agentPath,
    "/usr/local/bin/codex",
    "/usr/local/bin/claude",
    "/usr/local/bin/opencode"
  ]) {
    try {
      const target = realpathSync(executable);
      const index = target.indexOf("/node_modules/");
      if (index >= 0) moduleRoots.add(target.slice(0, index + "/node_modules".length));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const path of moduleRoots) roots.push("--read-root", path);
  roots.push(...nodeRuntimeRoots());
  for (const key of [
    "VERITY_FORGE_PROXY_CA_FILE",
    "VERITY_SIGNING_TOKEN_FILE",
    "VERITY_GH_BROKER_CAPABILITY_FILE"
  ]) {
    const path = options.env?.[key] ?? {
      VERITY_SIGNING_TOKEN_FILE: "/run/verity/ssh/signing_broker_token",
      VERITY_GH_BROKER_CAPABILITY_FILE: "/run/verity/gh-token-capability"
    }[key];
    if (path !== void 0 && (options.env?.[key] !== void 0 || lstatSync2(path, { throwIfNoEntry: false })))
      roots.push("--secret", path);
  }
  return roots;
}
function agentLaunchSpec(request, options) {
  if (request.gatewayToolsOnly && request.knowledgeIsolation)
    throw new Error("Native tool isolation cannot use the separate knowledge runtime");
  if (request.gatewayToolsOnly && !request.managedHome && !request.knowledgeHome)
    throw new Error("Native tool isolation requires broker-owned configuration");
  const { uid, gid } = validateIdentity(options);
  const setprivPath = options.setprivPath ?? "/usr/bin/setpriv";
  const normalConfinement = !!request.managedHome && !request.planning && !request.knowledgeIsolation && options.dockerGid === void 0;
  const agentPaths = Object.assign(/* @__PURE__ */ Object.create(null), {
    "codex-acp": options.codexAcpPath ?? "/usr/local/bin/codex-acp",
    "claude-agent-acp": options.claudeAcpPath ?? "/usr/local/bin/claude-agent-acp",
    // A root-owned wrapper the Feature writes (`exec opencode acp "$@"`), because
    // OpenCode speaks ACP as a subcommand and ships no adapter binary of its own.
    // The indirection lives in the image rather than in this argv on purpose: the
    // mapping stays one fixed command name to one fixed executable, so nothing
    // here has to know that this agent needs a subcommand and the others do not.
    "opencode-acp": options.openCodeAcpPath ?? "/usr/local/bin/opencode-acp"
  });
  const agentPath = typeof request.command === "string" ? agentPaths[request.command] : void 0;
  if (typeof agentPath !== "string") {
    throw new Error(`unsupported agent command '${String(request.command)}'`);
  }
  if ((request.knowledgeIsolation || request.planning) && typeof request.knowledgeHome !== "string")
    throw new Error("Wiki isolation home was not prepared");
  return {
    command: setprivPath,
    args: [
      `--reuid=${String(uid)}`,
      `--regid=${String(gid)}`,
      // Never `options.runnerGid`, and never a shorter list than this one: these
      // flags ARE the ADR 0006 anti-forgery boundary for a PROJECT Sandbox — the
      // case the boundary exists for, since that is where repository code runs.
      // See PRIVILEGE_DROP_FLAGS, including what ADR 0006 Amendment 1 takes away
      // from the control-plane Runner and why this argv does not restore it.
      // `options.dockerGid` is that one sanctioned variation, and it swaps
      // `--clear-groups` for `--groups=<docker>` — never the runtime GID.
      ...privilegeDropFlags(
        request.knowledgeIsolation || request.planning ? void 0 : options.dockerGid,
        options.runnerGid
      ),
      ...request.knowledgeIsolation || request.planning || normalConfinement ? [
        options.scriptSandboxPath ?? DEFAULT_SCRIPT_SANDBOX_PATH,
        "--root",
        request.planning || normalConfinement ? request.cwd === (options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT) || request.cwd.startsWith(`${options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT}/`) ? options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT : options.sharedSessionRoot ?? request.cwd : request.cwd,
        "--cwd",
        request.cwd,
        "--loading",
        "dynamic",
        "--dynamic-root",
        normalConfinement ? request.managedHome : request.knowledgeHome,
        request.planning ? "--read-only-root" : "--write-isolated",
        ...request.command === "opencode-acp" ? ["--self-proc-maps"] : [],
        request.planning ? "--runtime-root" : "--write-root",
        npmCachePath(options),
        ...planningRuntimeRoots(request, options).flatMap((path) => ["--runtime-root", path]),
        ...normalConfinement ? normalSessionRoots(options, agentPath) : [],
        ...request.planning || request.knowledgeIsolation ? nodeRuntimeRoots() : [],
        ...claudePolicyRoots(request.command),
        "--"
      ] : [],
      ...options.signalTraceSeconds === void 0 || request.command !== "codex-acp" || request.knowledgeIsolation ? [] : [
        "/usr/bin/python3",
        "/usr/local/bin/verity-agent-signal-trace",
        "--seconds",
        String(options.signalTraceSeconds),
        "--launch"
      ],
      agentPath,
      ...request.args
    ],
    spawnOptions: {
      cwd: request.cwd,
      env: {
        ...childEnvironment(
          request.command,
          {
            ...options.env,
            VERITY_CLAUDE_CONNECTOR_URL: options.connectorUrl
          },
          request.sessionEnv,
          request.turnCapability,
          request.gitAuthor,
          request.signCommits
        ),
        VERITY_SESSION_WORKTREE: request.cwd,
        // Disabling project config also disables automatic AGENTS.md discovery.
        // Keep repository guidance as text, without allowing repository JSON to
        // configure providers, permissions or executable extensions. Wiki turns
        // deliberately receive no project instructions.
        ...request.command === "opencode-acp" ? {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            instructions: request.knowledgeIsolation || request.gatewayToolsOnly ? [] : [join4(request.cwd, "AGENTS.md")],
            websearch: { provider: "exa" },
            policies: request.gatewayToolsOnly ? restrictedOpenCodePolicies() : [
              { action: "integration.use", resource: "plugin:*", effect: "deny" },
              { action: "provider.use", resource: "*", effect: "deny" },
              { action: "provider.use", resource: "verity", effect: "allow" }
            ],
            permissions: request.gatewayToolsOnly ? restrictedOpenCodePermissions() : [
              { action: "external_directory", resource: "*", effect: "ask" },
              { action: "external_directory", resource: "/knowledge/**", effect: "allow" }
            ]
          })
        } : {},
        ...request.managedHome ? {
          HOME: request.managedHome,
          ...request.command === "claude-agent-acp" ? { CLAUDE_CONFIG_DIR: join4(request.managedHome, "claude") } : {},
          ...request.command === "codex-acp" ? { CODEX_HOME: join4(request.managedHome, "codex") } : {},
          XDG_CONFIG_HOME: join4(request.managedHome, "config"),
          OPENCODE_CONFIG: join4(request.managedHome, "config", "opencode.json"),
          XDG_DATA_HOME: join4(request.managedHome, "data"),
          XDG_STATE_HOME: join4(request.managedHome, "state"),
          XDG_CACHE_HOME: join4(request.managedHome, "cache"),
          npm_config_logs_dir: join4(request.managedHome, "cache", "_logs"),
          TMPDIR: join4(request.managedHome, "tmp")
        } : {},
        ...request.knowledgeIsolation || request.planning ? {
          HOME: request.knowledgeHome,
          CLAUDE_CONFIG_DIR: join4(request.knowledgeHome, "claude"),
          CODEX_HOME: join4(request.knowledgeHome, "codex"),
          XDG_CONFIG_HOME: join4(request.knowledgeHome, "config"),
          OPENCODE_CONFIG: join4(request.knowledgeHome, "config", "opencode.json"),
          ...request.command === "opencode-acp" && request.planning && !request.knowledgeIsolation && !request.sessionEnv?.VERITY_SESSION_ID ? Object.fromEntries(
            ["data", "state", "cache"].map((name) => [
              `XDG_${name.toUpperCase()}_HOME`,
              join4(planningRuntimeRoots(request, options)[0], name)
            ])
          ) : {
            XDG_DATA_HOME: join4(request.knowledgeHome, "data"),
            XDG_STATE_HOME: join4(request.knowledgeHome, "state"),
            XDG_CACHE_HOME: join4(request.knowledgeHome, "cache")
          },
          npm_config_logs_dir: join4(request.knowledgeHome, "cache", "_logs"),
          TMPDIR: join4(request.knowledgeHome, "tmp")
        } : {},
        npm_config_cache: npmCachePath(options)
      },
      stdio: [
        "pipe",
        "pipe",
        "pipe",
        ...request.sessionLockFd === void 0 ? [] : [request.sessionLockFd],
        ...request.packageCacheLockFd === void 0 ? [] : [request.packageCacheLockFd]
      ],
      // Give every agent invocation its own process group. Codex can leave tool
      // and sub-agent descendants running after its direct process receives a
      // signal; those descendants inherit stdout and keep the broker/turn open.
      // The broker can therefore only guarantee Stop by signalling this whole
      // group, rather than the setpriv/Codex process alone.
      detached: true
    }
  };
}
var TRUSTED_CLI_INTERPRETERS = /* @__PURE__ */ new Set([
  "sh",
  "bash",
  "ash",
  "awk",
  "busybox",
  "bun",
  "dash",
  "deno",
  "fish",
  "zsh",
  "ksh",
  "lua",
  "node",
  "nodejs",
  "perl",
  "php",
  "pwsh",
  "python",
  "python2",
  "python3",
  "ruby",
  "Rscript",
  "tclsh"
]);
function trustedCliInterpreterName(token) {
  const name = token.slice(token.lastIndexOf("/") + 1);
  return TRUSTED_CLI_INTERPRETERS.has(name) || /^(?:g|m|n)?awk$/u.test(name) || /^(?:python|ruby)\d+(?:\.\d+)*$/u.test(name) ? name : void 0;
}
var TRUSTED_CLI_ARGV_POLICY_SUFFIX = ".verity-trusted-cli-policy.json";
var LEGACY_TRUSTED_CLI_ARGV_POLICY_SUFFIX = ".breeze-trusted-cli-policy.json";
var MAX_TRUSTED_CLI_ARGV_POLICY_ROUTES = 256;
var MAX_TRUSTED_CLI_ARGV_POLICY_BYTES = 64 * 1024;
var TRUSTED_CLI_POLICY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
function parseTrustedCliArgvPolicy(raw) {
  if (!isObject(raw) || raw.version !== 1 || Object.keys(raw).some((key) => key !== "version" && key !== "routes") || !Array.isArray(raw.routes) || raw.routes.length === 0 || raw.routes.length > MAX_TRUSTED_CLI_ARGV_POLICY_ROUTES) {
    throw new Error("trusted CLI argv policy is invalid");
  }
  const routes = raw.routes.map((route) => {
    if (!Array.isArray(route) || route.length === 0 || route.length > 255) {
      throw new Error("trusted CLI argv policy is invalid");
    }
    return route.map((token) => {
      if (typeof token === "string" && token.length > 0) return token;
      if (isObject(token) && token.kind === "identifier" && Object.keys(token).length === 1) {
        return token;
      }
      throw new Error("trusted CLI argv policy is invalid");
    });
  });
  return { version: 1, routes };
}
function matchesTrustedCliArgvPolicy(policy, args) {
  const parsed = parseTrustedCliArgvPolicy(policy);
  return parsed.routes.some(
    (route) => route.length === args.length && route.every(
      (token, index) => typeof token === "string" && token === args[index] || isObject(token) && token.kind === "identifier" && TRUSTED_CLI_POLICY_IDENTIFIER.test(args[index] ?? "")
    )
  );
}
async function loadTrustedCliArgvPolicy(resolvedCommand, options = {}) {
  const inspect = options.lstat ?? lstat4;
  const validatePath = options.validateImmutablePath ?? validateImmutablePath;
  const read = options.readFile ?? readFile3;
  let path;
  let entry;
  for (const suffix of [TRUSTED_CLI_ARGV_POLICY_SUFFIX, LEGACY_TRUSTED_CLI_ARGV_POLICY_SUFFIX]) {
    const candidate = `${resolvedCommand}${suffix}`;
    try {
      entry = await inspect(candidate);
      path = candidate;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (path === void 0 || entry === void 0) return void 0;
  if (!entry.isFile() || entry.size > MAX_TRUSTED_CLI_ARGV_POLICY_BYTES) {
    throw new Error("trusted CLI argv policy is invalid");
  }
  await validatePath(path);
  try {
    return parseTrustedCliArgvPolicy(JSON.parse(await read(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message === "trusted CLI argv policy is invalid") {
      throw error;
    }
    throw new Error("trusted CLI argv policy is invalid", { cause: error });
  }
}
var TRUSTED_CLI_CODE_LOADING_ENV = /* @__PURE__ */ new Set([
  "BASH_ENV",
  "ENV",
  // The environment spelling of `-javaagent:`: the JVM reads its options out of
  // these, so `env JAVA_TOOL_OPTIONS=-javaagent:<jar> java Main` loads the same
  // jar without ever naming it in a place argv inspection reaches.
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LUA_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5LIB",
  "PERL5OPT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RUBYLIB"
]);
async function validateTrustedCliArguments(command, args, cwd, executablePath = "/usr/local/bin:/usr/bin:/bin", mutableDataPaths = [], approvedEntryScript, options = {}) {
  const workspaceRealpath = approvedEntryScript === void 0 || options.agentUid === void 0 ? realpath3 : (path) => agentWorkspaceRead("realpath", path, options);
  const workspaceLstat = approvedEntryScript === void 0 || options.agentUid === void 0 ? lstat4 : (path) => agentWorkspaceRead("lstat", path, options);
  const resolvedCommand = await realpath3(command).catch(() => command);
  const commandName = resolvedCommand.slice(resolvedCommand.lastIndexOf("/") + 1);
  let interpreterName = trustedCliInterpreterName(resolvedCommand) ?? "";
  let interpreter = interpreterName.length > 0;
  let inlineCodeFollows = false;
  let remainingAreData = false;
  let approvedDynamicScriptSeen = false;
  let executableDirectories = executablePath.split(":").map((dir) => resolve2(cwd, dir));
  await Promise.all(executableDirectories.map(validateTrustedCliExecutableDirectory));
  const argvPolicy = await (options.loadArgvPolicy ?? loadTrustedCliArgvPolicy)(resolvedCommand);
  if (argvPolicy !== void 0) {
    if (!matchesTrustedCliArgvPolicy(argvPolicy, args)) {
      throw new Error("trusted CLI argv is not allowed by executable policy");
    }
    return;
  }
  let envWrapper = commandName === "env";
  let timeoutWrapper = commandName === "timeout";
  let timeoutDurationSeen = false;
  let requiredFileOperand = false;
  const canonicalPath = async (path) => {
    let current = path.startsWith("/") ? path : `${cwd}/${path}`;
    while (current.length > 1 && current.endsWith("/")) current = current.slice(0, -1);
    const missing = [];
    for (; ; ) {
      const real = await realpath3(current).catch(() => void 0);
      if (real !== void 0) return missing.length === 0 ? real : join4(real, ...missing);
      const slash = current.lastIndexOf("/");
      if (slash < 0) return resolve2(cwd, path);
      missing.unshift(current.slice(slash + 1));
      current = slash === 0 ? "/" : current.slice(0, slash);
    }
  };
  const namesMaterializedSecret = async (paths) => {
    for (const secretPath of mutableDataPaths) {
      const secret = await canonicalPath(secretPath);
      for (const path of paths) {
        if (await canonicalPath(path) === secret) return true;
      }
    }
    return false;
  };
  const describeOperand = (operand) => {
    const token = operand.length > 200 ? `${operand.slice(0, 200)}\u2026` : operand;
    if (mutableDataPaths.length === 0) return token;
    return `${token} (only ${mutableDataPaths.join(", ")} may be named before it is written)`;
  };
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    const fileOperandRequired = requiredFileOperand;
    requiredFileOperand = commandName === "make" && arg === "-f" || commandName === "xargs" && arg === "-a" || (commandName === "java" || commandName === "javac") && (arg === "-cp" || arg === "-classpath" || arg === "--class-path");
    if (inlineCodeFollows) {
      inlineCodeFollows = false;
      interpreter = false;
      remainingAreData = true;
      continue;
    }
    const shellInline = ["sh", "bash", "dash", "zsh", "ksh"].includes(interpreterName) && /^-[^-]*c/u.test(arg);
    const otherInline = ["node", "nodejs", "perl", "ruby"].includes(interpreterName) && (arg === "-e" || arg === "--eval");
    const attachedInline = ["node", "nodejs", "perl", "ruby"].includes(interpreterName) && (/^-e.+/u.test(arg) || arg.startsWith("--eval="));
    if (interpreter && attachedInline) {
      interpreter = false;
      remainingAreData = true;
      continue;
    }
    if (interpreter && (shellInline || arg === "-c" || otherInline)) {
      inlineCodeFollows = true;
      continue;
    }
    if (interpreter && interpreterName.startsWith("python") && /^-m/u.test(arg)) {
      throw new Error("trusted CLI interpreter module execution is not immutable");
    }
    if (interpreter && arg.startsWith("-")) {
      throw new Error("trusted CLI interpreter option execution is not immutable");
    }
    if (envWrapper && arg.startsWith("-")) {
      throw new Error("trusted CLI env option execution is not immutable");
    }
    if (!interpreter && arg.startsWith("PATH=")) {
      executableDirectories = arg.slice("PATH=".length).split(":").map((dir) => resolve2(cwd, dir));
      await Promise.all(executableDirectories.map(validateTrustedCliExecutableDirectory));
      continue;
    }
    if (envWrapper && arg.includes("=")) {
      const name = arg.slice(0, arg.indexOf("="));
      if (TRUSTED_CLI_CODE_LOADING_ENV.has(name)) {
        throw new Error("trusted CLI code-loading environment is not immutable");
      }
    }
    const envCommandOperand = envWrapper && !arg.includes("=");
    if (envCommandOperand) envWrapper = false;
    let timeoutCommandOperand = false;
    if (timeoutWrapper && !arg.startsWith("-")) {
      if (timeoutDurationSeen) {
        timeoutCommandOperand = true;
        timeoutWrapper = false;
      } else {
        timeoutDurationSeen = true;
      }
    }
    if (interpreterName === "busybox") {
      const appletInterpreter = trustedCliInterpreterName(arg);
      if (appletInterpreter !== void 0) {
        interpreterName = appletInterpreter;
        interpreter = true;
        continue;
      }
    }
    const activatedInterpreterName = !remainingAreData && !interpreter ? trustedCliInterpreterName(arg) : void 0;
    const activatesInterpreter = activatedInterpreterName !== void 0;
    const bareExecutableOperand = activatesInterpreter || envCommandOperand || timeoutCommandOperand;
    const filesystemToken = (token) => token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("file:");
    const pathTokens = [{ token: arg, explicit: filesystemToken(arg) }];
    const equals = arg.indexOf("=");
    if (equals >= 0 && equals + 1 < arg.length) {
      const value = arg.slice(equals + 1);
      pathTokens.push({ token: value, explicit: filesystemToken(value) });
      if (value.startsWith("file:")) {
        pathTokens.push({ token: value.slice("file:".length), explicit: true });
      }
    }
    if (arg.startsWith("file:")) {
      pathTokens.push({ token: arg.slice("file:".length), explicit: true });
    }
    if (arg.startsWith("@") && arg.length > 1) {
      const value = arg.slice(1);
      pathTokens.push({ token: value, explicit: filesystemToken(value) });
    }
    const optionColon = arg.startsWith("-") ? arg.indexOf(":") : -1;
    if (optionColon >= 0 && optionColon + 1 < arg.length && (equals < 0 || optionColon < equals)) {
      const carried = arg.slice(optionColon + 1);
      const carriedEquals = carried.indexOf("=");
      const carriedPath = carriedEquals > 0 ? carried.slice(0, carriedEquals) : carried;
      pathTokens.push({ token: carriedPath, explicit: filesystemToken(carriedPath) });
      if (carriedEquals > 0) {
        for (const fragment of carried.slice(carriedEquals + 1).split(/[,=]/u)) {
          const value = fragment.startsWith("file:") ? fragment.slice("file:".length) : fragment;
          if (fragment.startsWith("file:") || filesystemToken(value)) {
            pathTokens.push({ token: value, explicit: true });
          }
        }
      }
    }
    const pathGroups = pathTokens.map(({ token, explicit }) => ({
      token,
      explicit,
      locations: /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(token) || token.startsWith("file:") ? [] : token.startsWith("/") ? [token] : token.includes("/") || interpreter ? [resolve2(cwd, token)] : bareExecutableOperand ? executableDirectories.map((dir) => resolve2(dir, token)) : [resolve2(cwd, token)]
    })).filter((group) => group.locations.length > 0);
    let candidate;
    let entry;
    for (const group of pathGroups) {
      let found;
      let stat;
      for (const path of group.locations) {
        try {
          const canonical = await workspaceRealpath(path);
          found = path;
          stat = await workspaceLstat(canonical);
          break;
        } catch {
        }
      }
      if (found === void 0 || stat === void 0) {
        if (!interpreter && await namesMaterializedSecret(group.locations)) continue;
        if (interpreter) throw new Error("trusted CLI interpreter operand does not exist");
        if (group.explicit || bareExecutableOperand || fileOperandRequired) {
          throw new Error(`trusted CLI file operand does not exist: ${describeOperand(arg)}`);
        }
        continue;
      }
      if (stat.isDirectory() && !interpreter && !bareExecutableOperand && approvedDynamicScriptSeen && withinAgentWorktreeRoots(await workspaceRealpath(found), [approvedEntryScript.worktreeRoot]))
        continue;
      if (!stat.isFile() && (interpreter || !stat.isSocket())) {
        throw new Error("trusted CLI file operand must be a regular file");
      }
      if (!interpreter && await namesMaterializedSecret([found])) continue;
      if (candidate === void 0) {
        candidate = found;
        entry = stat;
        if (activatesInterpreter) await validateTrustedCliExecutable(found);
        else if (!(interpreter && approvedEntryScript !== void 0 && await workspaceRealpath(found) === approvedEntryScript.path))
          await validateTrustedCliFileIntegrity(found);
        continue;
      }
      await validateTrustedCliFileIntegrity(found);
    }
    if (candidate === void 0 || entry === void 0) continue;
    if (activatesInterpreter) {
      interpreter = true;
      interpreterName = activatedInterpreterName;
      continue;
    }
    if (arg.slice(arg.lastIndexOf("/") + 1) === "env") envWrapper = true;
    if (arg.slice(arg.lastIndexOf("/") + 1) === "timeout") {
      timeoutWrapper = true;
      timeoutDurationSeen = false;
    }
    if (interpreter) {
      if (approvedEntryScript?.loading === "dynamic" && typeof approvedEntryScript.worktreeRoot === "string" && await workspaceRealpath(candidate) === approvedEntryScript.path)
        approvedDynamicScriptSeen = true;
      interpreter = false;
    }
  }
}
var TRUSTED_CLI_SECRET_DIR = "/run/verity-runner/secrets";
function trustedCliSecretPath(name, options, correlationId) {
  if (!isSafeTrustedCliEnvName(name)) throw new Error("unsafe trusted CLI environment variable");
  const root = options?.secretDir ?? TRUSTED_CLI_SECRET_DIR;
  return correlationId === void 0 ? `${root}/${name}` : `${root}/${correlationId}/${name}`;
}
var TRUSTED_CLI_SECRET_LEAK_ERROR = "trusted CLI secret file could not be removed";
var SCRIPT_ISOLATION_UNAVAILABLE_ERROR = "trusted CLI entry-script isolation is unavailable in this Sandbox";
var SCRIPT_SANDBOX_PROBE_TIMEOUT_MS = 1e4;
async function probeScriptSandbox(helperPath = DEFAULT_SCRIPT_SANDBOX_PATH, timeoutMs = SCRIPT_SANDBOX_PROBE_TIMEOUT_MS, launchOptions) {
  return await new Promise((resolveProbe) => {
    let child;
    try {
      const spec = launchOptions === void 0 ? { command: helperPath, args: ["--probe"], spawnOptions: {} } : trustedCliLaunchSpec(
        {
          kind: "trusted-cli",
          command: helperPath,
          args: ["--probe"],
          cwd: "/",
          secrets: []
        },
        launchOptions
      );
      child = spawn4(spec.command, spec.args, {
        ...spec.spawnOptions,
        detached: false,
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
var TRUSTED_CLI_VALIDATION_CODES = /* @__PURE__ */ new Map([
  ["invalid trusted CLI spawn request", "validation_invalid_request"],
  ["trusted CLI argv exceeds broker limit", "validation_argv_too_large"],
  ["trusted CLI executable must be root-owned and immutable", "validation_path_not_immutable"],
  ["trusted CLI command is not an executable file", "validation_command_not_executable"],
  ["trusted CLI file operand must be a regular file", "validation_operand_not_regular_file"],
  [
    "trusted CLI PATH entry must be an immutable directory",
    "validation_path_directory_not_immutable"
  ],
  [
    "isolated trusted CLI interpreter must be installed under /bin or /usr",
    "validation_isolated_interpreter_location"
  ],
  ["trusted CLI cwd escaped the worktree root", "validation_cwd_outside_worktree"],
  ["invalid trusted CLI entry-script attestation", "validation_invalid_entry_attestation"],
  ["trusted CLI entry script escaped the worktree root", "validation_entry_outside_worktree"],
  ["trusted CLI entry script must be a regular file", "validation_entry_not_regular_file"],
  ["trusted CLI entry script content hash changed after approval", "validation_entry_hash_changed"],
  [
    "trusted CLI cwd and entry script must share one worktree root",
    "validation_entry_worktree_mismatch"
  ],
  [
    "trusted CLI entry script project path does not match its worktree",
    "validation_entry_project_path_mismatch"
  ],
  ["trusted CLI argv policy is invalid", "validation_invalid_argv_policy"],
  ["trusted CLI argv is not allowed by executable policy", "validation_argv_policy_denied"],
  [
    "trusted CLI interpreter module execution is not immutable",
    "validation_interpreter_module_mutable"
  ],
  [
    "trusted CLI interpreter option execution is not immutable",
    "validation_interpreter_option_mutable"
  ],
  ["trusted CLI env option execution is not immutable", "validation_env_option_mutable"],
  [
    "trusted CLI code-loading environment is not immutable",
    "validation_code_loading_environment_mutable"
  ],
  ["trusted CLI interpreter operand does not exist", "validation_interpreter_operand_missing"],
  [SCRIPT_ISOLATION_UNAVAILABLE_ERROR, "validation_script_isolation_unavailable"]
]);
function trustedCliFailureCode(phase, error) {
  if (phase === "validation") {
    const rule = TRUSTED_CLI_VALIDATION_CODES.get(error instanceof Error ? error.message : "");
    if (rule !== void 0) return rule;
    const code2 = error && typeof error === "object" ? error.code : void 0;
    if (code2 === "ENOENT" || code2 === "ENOTDIR") return "validation_path_missing";
    if (code2 === "EACCES" || code2 === "EPERM") return "validation_path_permissions";
    if (code2 === "ELOOP") return "validation_path_symlink_loop";
    return "validation_failed";
  }
  if (phase !== "materialization") return `${phase.replace("-", "_")}_failed`;
  const code = error && typeof error === "object" ? error.code : void 0;
  if (code === "EEXIST") return "materialization_secret_file_exists";
  if (code === "EACCES" || code === "EPERM") return "materialization_path_permissions";
  if (code === "ENOENT") return "materialization_path_missing";
  if (code === "ENOSPC" || code === "EDQUOT") return "materialization_storage_full";
  if (code === "EROFS") return "materialization_read_only";
  return "materialization_failed";
}
function leakOutranks(contained, error, stage = "spawn failed") {
  if (contained !== false) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${TRUSTED_CLI_SECRET_LEAK_ERROR} after ${stage}: ${detail}`);
}
async function containTrustedCliSecretFile(path) {
  const removed = await rm3(path, { force: true }).then(
    () => true,
    () => false
  );
  if (removed) return true;
  const reclaimed = await chown3(path, 0, 0).then(
    () => true,
    () => false
  );
  if (!reclaimed) return false;
  await truncate(path, 0).catch(() => void 0);
  await rm3(path, { force: true }).catch(() => void 0);
  return true;
}
async function removeLegacyTrustedCliSecretFiles(options) {
  const root = options?.secretDir ?? TRUSTED_CLI_SECRET_DIR;
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory() || !isSafeTrustedCliEnvName(entry.name)) continue;
    const contained = await containTrustedCliSecretFile(`${root}/${entry.name}`);
    if (!contained) throw new Error(TRUSTED_CLI_SECRET_LEAK_ERROR);
  }
}
async function materializeTrustedCliSecrets(request, options) {
  const fileSecrets = request.secrets.filter((secret) => secret.injection === "file");
  if (fileSecrets.length === 0) return { cleanup: async () => true };
  const { uid, gid } = validateIdentity(options);
  const written = [];
  const invocationDir = request.correlationId === void 0 ? void 0 : `${options?.secretDir ?? TRUSTED_CLI_SECRET_DIR}/${request.correlationId}`;
  const contain = async () => {
    const contained = await Promise.all(
      written.map(async (path) => {
        if (await containTrustedCliSecretFile(path)) return true;
        process.stderr.write(`verity-agent-spawn-broker: leaked trusted CLI secret file ${path}
`);
        return false;
      })
    );
    const fullyContained = contained.every(Boolean);
    if (fullyContained && invocationDir !== void 0) {
      await rm3(invocationDir, { recursive: true, force: true }).catch(() => void 0);
    }
    return fullyContained;
  };
  let running;
  const cleanup = () => running ??= contain();
  try {
    const root = options?.secretDir ?? TRUSTED_CLI_SECRET_DIR;
    await mkdir3(root, { recursive: true, mode: 457 });
    await chmod3(root, 457);
    for (const secret of fileSecrets) {
      const path = trustedCliSecretPath(secret.name, options, request.correlationId);
      const dir = path.slice(0, path.lastIndexOf("/"));
      await mkdir3(dir, { recursive: true, mode: 457 });
      await chmod3(dir, 457);
      const bytes = secret.encoding === "base64" ? Buffer.from(secret.value, "base64") : secret.value;
      await writeFile(path, bytes, { mode: 384, flag: "wx" });
      written.push(path);
      await chown3(path, uid, gid);
    }
  } catch (error) {
    throw leakOutranks(await cleanup(), error, "materialization failed");
  }
  return { cleanup };
}
async function materializeTrustedCliEntryScript(request, options) {
  if (request.entryScript === void 0) {
    return { args: request.args, cleanup: async () => true };
  }
  const bytes = await agentWorkspaceRead("readEntry", request.entryScript.path, options);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== request.entryScript.sha256) {
    throw new Error("trusted CLI entry script content hash changed after approval");
  }
  const base = resolve2(
    options.trustedCliEntryScriptDir ?? join4(options.secretDir ?? TRUSTED_CLI_SECRET_DIR, "..", "entry-scripts")
  );
  await mkdir3(base, { recursive: true, mode: 457 });
  await chmod3(base, 457);
  const directory = await mkdtemp2(join4(base, `${digest.slice(0, 16)}-`));
  try {
    await chmod3(directory, 457);
    const snapshotRoot = join4(directory, "root");
    const relativeScript = request.entryScript.path.slice(
      request.entryScript.worktreeRoot.length + 1
    );
    const snapshot = join4(snapshotRoot, relativeScript);
    const snapshotScriptDir = snapshot.slice(0, snapshot.lastIndexOf("/"));
    const makeSnapshotDirectory = async (path) => {
      await mkdir3(snapshotRoot, { mode: 493 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      await chmod3(snapshotRoot, 493);
      let current = snapshotRoot;
      for (const component of path.slice(snapshotRoot.length + 1).split("/").filter(Boolean)) {
        current = join4(current, component);
        await mkdir3(current, { mode: 493 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
        await chmod3(current, 493);
      }
    };
    await makeSnapshotDirectory(snapshotScriptDir);
    const relativeCwd = request.cwd.slice(request.entryScript.worktreeRoot.length + 1);
    const snapshotCwd = join4(snapshotRoot, relativeCwd);
    if (request.entryScript.loading === "isolated") {
      await makeSnapshotDirectory(snapshotCwd);
    }
    await writeFile(snapshot, bytes, { mode: 292, flag: "wx" });
    await chmod3(snapshot, 292);
    if (request.entryScript.loading === "dynamic") {
      const components = relativeScript.split("/");
      let sourceDir = request.entryScript.worktreeRoot;
      let targetDir = snapshotRoot;
      for (const component of components) {
        for (const entry of await agentWorkspaceRead("readdir", sourceDir, options)) {
          if (entry === component) continue;
          await symlink2(join4(sourceDir, entry), join4(targetDir, entry));
        }
        sourceDir = join4(sourceDir, component);
        targetDir = join4(targetDir, component);
      }
    }
    const cleanup = async () => {
      try {
        await rm3(directory, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    };
    return {
      args: [snapshot, ...request.args.slice(1)],
      entrySandbox: {
        root: snapshotRoot,
        cwd: request.entryScript.loading === "isolated" ? snapshotCwd : request.cwd,
        loading: request.entryScript.loading,
        ...request.entryScript.loading === "dynamic" ? { dynamicRoot: request.entryScript.worktreeRoot } : {}
      },
      cleanup
    };
  } catch (error) {
    await rm3(directory, { recursive: true, force: true });
    throw error;
  }
}
function trustedCliLaunchSpec(request, options) {
  const { uid, gid } = validateIdentity(options);
  for (const secret of request.secrets) {
    if (!isSafeTrustedCliEnvName(secret.name)) {
      throw new Error("unsafe trusted CLI environment variable");
    }
  }
  if (new Set(request.secrets.map((secret) => secret.name)).size !== request.secrets.length) {
    throw new Error("duplicate trusted CLI environment variable");
  }
  const setprivPath = options.setprivPath ?? "/usr/bin/setpriv";
  const command = request.entrySandbox === void 0 ? [request.command, ...request.args] : [
    options.scriptSandboxPath ?? DEFAULT_SCRIPT_SANDBOX_PATH,
    "--root",
    request.entrySandbox.root,
    "--cwd",
    request.entrySandbox.cwd,
    "--loading",
    request.entrySandbox.loading,
    ...request.entrySandbox.loading === "dynamic" ? ["--dynamic-root", request.entrySandbox.dynamicRoot] : [],
    ...request.secrets.flatMap(
      (secret) => secret.injection === "file" ? ["--secret", trustedCliSecretPath(secret.name, options, request.correlationId)] : []
    ),
    "--",
    request.command,
    ...request.args
  ];
  return {
    command: setprivPath,
    args: [
      `--reuid=${String(uid)}`,
      `--regid=${String(gid)}`,
      // The same boundary as `agentLaunchSpec`, from the same list, for the same
      // reason: a trusted CLI is reached THROUGH an agent turn — so it gets the
      // ADR 0006 Amendment 1 Docker grant too. Withholding it here would buy nothing (the
      // agent can already run `docker` directly) while making the two argv
      // prefixes differ, which is precisely the drift the shared list prevents.
      ...privilegeDropFlags(options.dockerGid, options.runnerGid),
      ...command
    ],
    spawnOptions: {
      cwd: request.cwd,
      env: {
        PATH: options.env?.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: options.env?.VERITY_AGENT_HOME ?? "/home/dev",
        USER: options.env?.VERITY_AGENT_USER ?? "dev",
        LOGNAME: options.env?.VERITY_AGENT_USER ?? "dev",
        LANG: options.env?.LANG ?? "C.UTF-8",
        // Last, so a secret can never overwrite the fixed launch environment —
        // isSafeTrustedCliEnvName already rejects those names, and this keeps the
        // two defences from depending on each other.
        ...Object.fromEntries(
          request.secrets.map((secret) => [
            secret.name,
            secret.injection === "file" ? trustedCliSecretPath(secret.name, options, request.correlationId) : secret.value
          ])
        )
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    }
  };
}
var PROCESS_TREE_KILL_GRACE_MS = 1e3;
var readProcFile = (path) => readFileSync(path, "utf8");
function statFields(pid, readProc) {
  const stat = readProc(`/proc/${pid}/stat`);
  const end = stat.lastIndexOf(")");
  if (end < 0) return [];
  return stat.slice(end + 1).trim().split(/\s+/);
}
function processStartTime(pid, readProc) {
  return statFields(pid, readProc)[19] ?? "";
}

// features/verity-sandbox-toolkit/src/spawn-broker/request.mjs
async function runnerStackHealth(options = {}) {
  const env = options.env ?? process.env;
  const controlDir = options.controlDir ?? DEFAULT_CONTROL_DIR;
  const read = options.readFile ?? ((path) => readFileSync2(path, "utf8"));
  let memoryGuard = true;
  try {
    if (env.VERITY_MEMORY_GUARD !== "0" && runsUnderGvisor(read) && readMemoryCeiling(read))
      memoryGuard = probeMemoryGuard(controlDir, read);
  } catch {
    memoryGuard = false;
  }
  let connector = true;
  if (env.VERITY_CLAUDE_CONNECTOR_PORT) {
    try {
      const port = Number(env.VERITY_CLAUDE_CONNECTOR_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
      const record = read(join5(controlDir, "egress-connector.pid")).trim().split(/\s+/u);
      const [pid, startTime, fingerprint] = record;
      if (!/^[1-9][0-9]*$/u.test(pid ?? "") || !startTime) throw new Error("missing identity");
      const stat = read(`/proc/${pid}/stat`);
      if (stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u)[19] !== startTime || !read(`/proc/${pid}/cmdline`).includes("/usr/local/bin/verity-egress-connector"))
        throw new Error("stale identity");
      const hash = createHash2("sha256");
      for (const name of [
        "VERITY_CLAUDE_EGRESS_URL",
        "VERITY_CLAUDE_EGRESS_AUTHORITY",
        "VERITY_CLAUDE_EGRESS_SERVERNAME",
        "VERITY_CODEX_EGRESS_URL",
        "VERITY_CODEX_EGRESS_AUTHORITY"
      ])
        hash.update(`${env[name] ?? ""}\0`);
      for (const name of [
        "VERITY_CLAUDE_EGRESS_CA",
        "VERITY_CLAUDE_EGRESS_CERT",
        "VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE"
      ]) {
        const path = env[name];
        if (!path || !isAbsolute2(path)) throw new Error("missing configuration");
        hash.update(`${createHash2("sha256").update(read(path)).digest("hex")}  ${path}
`);
      }
      if (fingerprint !== hash.digest("hex")) throw new Error("configuration changed");
      const response = await (options.fetch ?? globalThis.fetch)(
        `http://127.0.0.1:${port}/__verity/ready`,
        {
          signal: globalThis.AbortSignal.timeout(1e3),
          redirect: "error"
        }
      );
      connector = response.ok && (await response.text()).includes('"ready":true');
    } catch {
      connector = false;
    }
  }
  return {
    ok: true,
    stackHealthVersion: 1,
    healthy: memoryGuard && connector,
    memoryGuard,
    connector
  };
}
async function runnerEgressReadiness(options = {}) {
  const env = options.env ?? process.env;
  const connect = options.connect ?? probeTcp;
  const fetchReady = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 1e3;
  const hop = async (value) => {
    if (!value) return "not_configured";
    let url;
    try {
      url = new URL2(value);
    } catch {
      return "invalid";
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "invalid";
    return await connect(url.hostname.replace(/^\[(.*)\]$/u, "$1"), port, timeoutMs);
  };
  const connector = async () => {
    const port = Number(env.VERITY_CLAUDE_CONNECTOR_PORT);
    if (!env.VERITY_CLAUDE_CONNECTOR_PORT) return "not_configured";
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "invalid";
    try {
      const response = await fetchReady(`http://127.0.0.1:${port}/__verity/ready`, {
        signal: globalThis.AbortSignal.timeout(timeoutMs),
        redirect: "error"
      });
      if (!response.ok) return "unreachable";
      const body = JSON.parse(await response.text());
      return body !== null && typeof body === "object" && body.ready === true ? "ready" : "unreachable";
    } catch (error) {
      return tcpFailure(error);
    }
  };
  const [local, claude, codex, broker] = await Promise.all([
    connector(),
    hop(env.VERITY_CLAUDE_EGRESS_URL),
    hop(env.VERITY_CODEX_EGRESS_URL),
    hop(env.VERITY_MCP_GATEWAY_URL)
  ]);
  return {
    ok: true,
    egressReadinessVersion: 1,
    connector: local,
    claude,
    codex,
    broker
  };
}
function tcpFailure(error) {
  const codes = [];
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === "string") codes.push(current.code);
    if (Array.isArray(current.errors)) {
      for (const nested of current.errors)
        if (typeof nested?.code === "string") codes.push(nested.code);
    }
    current = current.cause;
  }
  if (codes.includes("ECONNREFUSED")) return "refused";
  if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN")) return "unresolved";
  if (codes.includes("ETIMEDOUT") || error?.name === "TimeoutError" || error?.name === "AbortError")
    return "timeout";
  return "unreachable";
}
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolveProbe) => {
    const socket = createConnection2({ host, port });
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(state);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    socket.once("connect", () => finish("ready"));
    socket.once("error", (error) => finish(tcpFailure(error)));
  });
}
var AGENT_SPAWN_PROTOCOL_VERSION = 1;
var OPENCODE_STATE_DIR = "/run/verity/opencode";
var DEFAULT_RUNTIME_DIR = "/run/verity-runner";
var DEFAULT_CONTROL_DIR = "/run/verity-runner-broker";
var DEFAULT_WORKTREE_ROOT = "/work";
var DEFAULT_SCRIPT_SANDBOX_PATH = "/usr/local/bin/verity-script-sandbox";
var SHARED_SESSION_ROOT = "/srv/verity/sessions";
var MAX_FRAME_BYTES = 8 * 1024 * 1024;
var MAX_ARGS_BYTES = 2 * 1024 * 1024;
var SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
var SPAWNABLE_AGENT_COMMANDS = /* @__PURE__ */ new Set(["claude-agent-acp", "codex-acp", "opencode-acp"]);
var TURN_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
function unsignedCommitsConfig(source) {
  const raw = source.GIT_CONFIG_COUNT;
  const count = raw !== void 0 && /^\d{1,3}$/u.test(raw) ? Number(raw) : 0;
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "commit.gpgsign",
    [`GIT_CONFIG_VALUE_${count}`]: "false"
  };
}
function isGitAuthor(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { name, email } = value;
  return Object.keys(value).length === 2 && typeof name === "string" && typeof email === "string" && name.trim().length > 0 && Buffer.byteLength(name) <= 200 && // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  /^[^\u0000-\u001f\u007f<>]+$/u.test(name) && Buffer.byteLength(email) <= 320 && // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  /^[^\s\u0000-\u001f\u007f<>@]+@[^\s\u0000-\u001f\u007f<>@]+$/u.test(email);
}
var SESSION_RUNTIME_ENV_KEYS = [
  "VERITY_SESSION_BACKEND",
  "VERITY_SESSION_MODEL",
  "VERITY_SESSION_ID"
];
var MAX_SESSION_ENV_VALUE_BYTES = 256;
var SESSION_ENV_VALUE_SHAPES = {
  // Without the `m` flag `$` is end-of-input in JS, so a trailing newline fails
  // this on its own rather than relying on the control-character check above.
  VERITY_SESSION_BACKEND: /^[a-z0-9][a-z0-9._-]*$/u,
  // A model id is opaque and may legitimately contain spaces or punctuation, so
  // it is only length- and control-character-checked. Consumers must quote it:
  // it is an environment value, never a fragment of a command line.
  VERITY_SESSION_MODEL: void 0,
  VERITY_SESSION_ID: void 0
};
function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
var MAX_TRUSTED_CLI_SECRETS = 8;
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decode(data) {
  return Buffer.from(data, "base64");
}
function isLocalConnectorUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL2(value);
    const port = Number(url.port);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" && Number.isSafeInteger(port) && port > 0 && port <= 65535 && value === url.origin;
  } catch {
    return false;
  }
}
function send(socket, value) {
  if (socket.destroyed) return false;
  return socket.write(`${JSON.stringify(value)}
`);
}
async function acquireLock(path) {
  const handle = await open3(path, "a+", 384);
  const code = await new Promise((resolveCode, rejectCode) => {
    const child = spawn5("flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", handle.fd]
    });
    child.once("error", rejectCode);
    child.once("close", resolveCode);
  }).catch(async (error) => {
    await handle.close();
    throw error;
  });
  if (code !== 0) {
    await handle.close();
    throw new Error("agent spawn broker is already claimed");
  }
  await chmod4(path, 384);
  return handle;
}
function validateIdentity(options) {
  const uid = Number(options.agentUid);
  const gid = Number(options.agentGid);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error("agent spawn broker requires non-root agent uid/gid");
  }
  return { uid, gid };
}
var AGENT_FILE_READER = `
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const { operation, path } = JSON.parse(input);
    let value;
    if (operation === 'managedStop') {
      const { stopTaggedManagedPids } = await import('/usr/local/bin/verity-managed-secret-servers.mjs');
      const [id, signal] = path.split(':');
      value = await stopTaggedManagedPids(id, signal);
    } else if (operation === 'realpath' || operation === 'readdir') value = await fs[operation](path);
    else if (operation === 'lstat') {
      const stat = await fs.lstat(path);
      value = { uid: stat.uid, mode: stat.mode, size: stat.size,
        file: stat.isFile(), directory: stat.isDirectory(), socket: stat.isSocket() };
    } else if (operation === 'readEntry') {
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('trusted CLI entry script must be a regular file');
        value = (await handle.readFile()).toString('base64');
      } finally { await handle.close(); }
    } else throw new Error('invalid workspace read operation');
    process.stdout.write(JSON.stringify({ value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: { code: error.code,
      message: error.code ? 'workspace read failed' : error.message } }));
  }
});
`;
async function agentWorkspaceRead(operation, path, options) {
  const { uid, gid } = options.enforceRoot === false ? { uid: process.getuid?.(), gid: process.getgid?.() } : validateIdentity(options);
  let value;
  if (options.enforceRoot === false || process.getuid?.() === uid && process.getgid?.() === gid) {
    if (operation === "managedStop") {
      const [id, signal] = path.split(":");
      return await stopTaggedManagedPids(id, signal);
    }
    if (operation === "readEntry") {
      const handle = await open3(path, constants3.O_RDONLY | constants3.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile())
          throw new Error("trusted CLI entry script must be a regular file");
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    }
    if (operation === "realpath") return await realpath4(path);
    if (operation === "readdir") return await readdir2(path);
    return await lstat5(path);
  }
  const response = await new Promise((resolveResponse, reject) => {
    const child = spawn5(
      options.setprivPath ?? "/usr/bin/setpriv",
      [
        `--reuid=${uid}`,
        `--regid=${gid}`,
        ...PRIVILEGE_DROP_FLAGS,
        process.execPath,
        "--input-type=commonjs",
        "-e",
        AGENT_FILE_READER
      ],
      { env: {}, cwd: "/", stdio: ["pipe", "pipe", "ignore"] }
    );
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("workspace reader timed out"));
    }, 1e4);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("workspace reader failed"));
      try {
        resolveResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid workspace reader response"));
      }
    });
    child.stdin.end(JSON.stringify({ operation, path }));
  });
  if (response.error) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    throw error;
  }
  value = response.value;
  if (operation === "readdir" && (!Array.isArray(value) || value.some(
    (name) => typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")
  ))) {
    throw new Error("invalid workspace directory response");
  }
  if (operation === "realpath" && (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || resolve3(value) !== value)) {
    throw new Error("invalid workspace path response");
  }
  if (operation === "readEntry") {
    if (typeof value !== "string") throw new Error("invalid workspace entry response");
    return Buffer.from(value, "base64");
  }
  if (operation === "lstat")
    return {
      ...value,
      isFile: () => value.file,
      isDirectory: () => value.directory,
      isSocket: () => value.socket
    };
  return value;
}
function isSafeTrustedCliEnvName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) && !/^(?:LD_|MALLOC_)/u.test(name) && !(/* @__PURE__ */ new Set([
    "GCONV_PATH",
    "GETCONF_DIR",
    "GLIBC_TUNABLES",
    "HOME",
    "HOSTALIASES",
    "LANG",
    "LOGNAME",
    "LOCALDOMAIN",
    "LOCPATH",
    "NLSPATH",
    "PATH",
    "RES_OPTIONS",
    "TMPDIR",
    "TZDIR",
    "USER"
  ])).has(name);
}
async function validateImmutablePath(path, endpoint = false) {
  const segments = path.split("/").filter(Boolean);
  let current = "/";
  for (const [index, segment] of segments.entries()) {
    current = join5(current, segment);
    const entry = await lstat5(current);
    const connectable = endpoint && index === segments.length - 1 && entry.isSocket();
    if (entry.uid !== 0 || !entry.isSymbolicLink() && !connectable && (entry.mode & 18) !== 0) {
      throw new Error("trusted CLI executable must be root-owned and immutable");
    }
  }
}
async function validateTrustedCliExecutable(command) {
  const resolved = await realpath4(command);
  await validateImmutablePath(command);
  if (resolved !== command) await validateImmutablePath(resolved);
  const executable = await lstat5(resolved);
  if (!executable.isFile() || (executable.mode & 73) === 0) {
    throw new Error("trusted CLI command is not an executable file");
  }
}
async function validateTrustedCliFileIntegrity(path) {
  const resolved = await realpath4(path);
  const entry = await lstat5(resolved);
  const endpoint = entry.isSocket();
  await validateImmutablePath(path, endpoint);
  if (resolved !== path) await validateImmutablePath(resolved, endpoint);
  if (!entry.isFile() && !endpoint) {
    throw new Error("trusted CLI file operand must be a regular file");
  }
}
async function validateTrustedCliExecutableDirectory(path) {
  const resolved = await realpath4(path);
  await validateImmutablePath(path);
  if (resolved !== path) await validateImmutablePath(resolved);
  const entry = await lstat5(resolved);
  if (!entry.isDirectory()) {
    throw new Error("trusted CLI PATH entry must be an immutable directory");
  }
}
async function resolveAgentWorktreeRoots(options = {}) {
  const configured = [resolve3(options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT)];
  if (options.sharedSessionRoot !== void 0) configured.push(resolve3(options.sharedSessionRoot));
  return await Promise.all(configured.map(async (root) => await realpath4(root)));
}
function withinAgentWorktreeRoots(cwd, roots) {
  return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}
async function validateSharedSessionRoot(options) {
  if (options.sharedSessionRoot === void 0) return;
  const configured = resolve3(options.sharedSessionRoot);
  if (configured === "/") throw new Error("shared session root must not be the filesystem root");
  const resolved = await realpath4(configured).catch(() => void 0);
  if (resolved === void 0 || resolved === "/" || !(await lstat5(resolved)).isDirectory()) {
    throw new Error(`shared session root is not a mounted directory: ${configured}`);
  }
}
async function validateSpawnRequest(raw, options) {
  if (isObject(raw) && raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION && raw.kind === "spawn-trusted-cli") {
    if (typeof raw.command !== "string" || !raw.command.startsWith("/") || !Array.isArray(raw.args) || raw.args.length > 255 || raw.args.some((arg) => typeof arg !== "string") || typeof raw.cwd !== "string" || raw.correlationId !== void 0 && !SAFE_CORRELATION_ID.test(raw.correlationId) || !Array.isArray(raw.secrets) || raw.secrets.length === 0 || raw.secrets.length > MAX_TRUSTED_CLI_SECRETS || !raw.secrets.every(
      (secret) => isObject(secret) && typeof secret.name === "string" && isSafeTrustedCliEnvName(secret.name) && typeof secret.value === "string" && secret.value.length > 0 && !secret.value.includes("\0") && (secret.encoding === void 0 || secret.injection === "file" && secret.encoding === "base64" && Buffer.from(secret.value, "base64").toString("base64") === secret.value) && Buffer.byteLength(secret.value) <= 1024 * 1024 && // Absent means env: every caller written before file injection existed.
      (secret.injection === void 0 || secret.injection === "env" || secret.injection === "file")
    ) || new Set(raw.secrets.map((secret) => secret.name)).size !== raw.secrets.length) {
      throw new Error("invalid trusted CLI spawn request");
    }
    if (Buffer.byteLength(JSON.stringify(raw.args)) > MAX_ARGS_BYTES) {
      throw new Error("trusted CLI argv exceeds broker limit");
    }
    await validateTrustedCliExecutable(raw.command);
    if (raw.entryScript?.loading === "isolated") {
      const executable = await realpath4(raw.command);
      if (executable !== "/bin" && !executable.startsWith("/bin/") && executable !== "/usr" && !executable.startsWith("/usr/")) {
        throw new Error("isolated trusted CLI interpreter must be installed under /bin or /usr");
      }
    }
    const [worktreeRoots2, cwd2] = await Promise.all([
      resolveAgentWorktreeRoots(options),
      agentWorkspaceRead("realpath", resolve3(raw.cwd), options)
    ]);
    if (!withinAgentWorktreeRoots(cwd2, worktreeRoots2)) {
      throw new Error("trusted CLI cwd escaped the worktree root");
    }
    let approvedEntryScript;
    if (raw.entryScript !== void 0) {
      if (!isObject(raw.entryScript) || typeof raw.entryScript.path !== "string" || !raw.entryScript.path.startsWith("/") || typeof raw.entryScript.projectPath !== "string" || raw.entryScript.projectPath.startsWith("/") || raw.entryScript.projectPath.split("/").some((component) => component === "" || component === "." || component === "..") || typeof raw.entryScript.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.entryScript.sha256) || raw.entryScript.loading !== "isolated" && raw.entryScript.loading !== "dynamic" || raw.args[0] !== raw.entryScript.path) {
        throw new Error("invalid trusted CLI entry-script attestation");
      }
      const canonical = await agentWorkspaceRead("realpath", raw.entryScript.path, options);
      if (!withinAgentWorktreeRoots(canonical, worktreeRoots2)) {
        throw new Error("trusted CLI entry script escaped the worktree root");
      }
      const entry = await agentWorkspaceRead("lstat", canonical, options);
      if (!entry.isFile()) throw new Error("trusted CLI entry script must be a regular file");
      const digest = createHash2("sha256").update(await agentWorkspaceRead("readEntry", canonical, options)).digest("hex");
      if (digest !== raw.entryScript.sha256) {
        throw new Error("trusted CLI entry script content hash changed after approval");
      }
      const worktreeRoot = cwd2;
      if (!withinAgentWorktreeRoots(canonical, [worktreeRoot])) {
        throw new Error("trusted CLI cwd and entry script must share one worktree root");
      }
      const projectPath = canonical.slice(worktreeRoot.length + 1);
      if (projectPath !== raw.entryScript.projectPath) {
        throw new Error("trusted CLI entry script project path does not match its worktree");
      }
      approvedEntryScript = {
        path: canonical,
        projectPath,
        sha256: digest,
        loading: raw.entryScript.loading,
        worktreeRoot
      };
    }
    await validateTrustedCliArguments(
      raw.command,
      raw.args,
      cwd2,
      options.env?.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      // Every file-injected secret contributes one path an argument may name
      // before it exists — the exception is per path, not per request.
      raw.secrets.filter((secret) => secret.injection === "file").map((secret) => trustedCliSecretPath(secret.name, options, raw.correlationId)),
      approvedEntryScript,
      options
    );
    return {
      kind: "trusted-cli",
      command: raw.command,
      args: raw.args,
      cwd: cwd2,
      ...raw.correlationId === void 0 ? {} : { correlationId: raw.correlationId },
      secrets: raw.secrets,
      ...approvedEntryScript === void 0 ? {} : { entryScript: approvedEntryScript }
    };
  }
  if (!isObject(raw) || raw.protocolVersion !== AGENT_SPAWN_PROTOCOL_VERSION || raw.kind !== "spawn-agent" || !SPAWNABLE_AGENT_COMMANDS.has(raw.command) || !Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string") || typeof raw.cwd !== "string") {
    throw new Error("invalid agent spawn request");
  }
  if (raw.sessionEnv !== void 0) {
    const entries = isObject(raw.sessionEnv) ? Object.entries(raw.sessionEnv) : void 0;
    if (entries === void 0 || entries.length > SESSION_RUNTIME_ENV_KEYS.length || entries.some(
      ([key, value]) => !SESSION_RUNTIME_ENV_KEYS.includes(key) || typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_SESSION_ENV_VALUE_BYTES || hasControlCharacter(value) || SESSION_ENV_VALUE_SHAPES[key]?.test(value) === false
    )) {
      throw new Error("invalid agent session environment");
    }
  }
  if (Buffer.byteLength(JSON.stringify(raw.args)) > MAX_ARGS_BYTES) {
    throw new Error("agent argv exceeds broker limit");
  }
  if (raw.args.length > 0) {
    throw new Error(`${raw.command} takes no argv`);
  }
  const [worktreeRoots, cwd] = await Promise.all([
    resolveAgentWorktreeRoots(options),
    realpath4(resolve3(raw.cwd))
  ]);
  if (!withinAgentWorktreeRoots(cwd, worktreeRoots)) {
    throw new Error("agent cwd escaped the worktree root");
  }
  if (raw.knowledgeIsolation !== void 0 && typeof raw.knowledgeIsolation !== "boolean")
    throw new Error("Invalid knowledge isolation policy");
  if (raw.turnCapability !== void 0 && (typeof raw.turnCapability !== "string" || !TURN_CAPABILITY_PATTERN.test(raw.turnCapability)))
    throw new Error("invalid agent turn capability");
  if (raw.gitAuthor !== void 0 && !isGitAuthor(raw.gitAuthor))
    throw new Error("invalid agent git author");
  if (raw.signCommits !== void 0 && raw.signCommits !== false)
    throw new Error("invalid agent commit signing flag");
  if (raw.planning !== void 0 && typeof raw.planning !== "boolean")
    throw new Error("Invalid planning isolation policy");
  if (raw.gatewayToolsOnly === true && raw.knowledgeIsolation === true)
    throw new Error("Native tool isolation cannot use the separate knowledge runtime");
  if (raw.gatewayToolsOnly !== void 0 && typeof raw.gatewayToolsOnly !== "boolean")
    throw new Error("Invalid native tool isolation policy");
  if (raw.gatewayToolsOnly === true && raw.command === "codex-acp" && (typeof raw.gatewayToolsModel !== "string" || !/^codex\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(raw.gatewayToolsModel) || raw.gatewayToolsModel === "codex/default"))
    throw new Error("Native tool isolation requires a concrete Codex model");
  return {
    kind: "agent",
    command: raw.command,
    args: raw.args,
    cwd,
    sessionEnv: raw.sessionEnv,
    ...raw.turnCapability !== void 0 ? { turnCapability: raw.turnCapability } : {},
    ...raw.gitAuthor !== void 0 ? { gitAuthor: { name: raw.gitAuthor.name, email: raw.gitAuthor.email } } : {},
    ...raw.signCommits === false ? { signCommits: false } : {},
    knowledgeIsolation: raw.knowledgeIsolation === true,
    planning: raw.planning === true,
    gatewayToolsOnly: raw.gatewayToolsOnly === true,
    ...raw.gatewayToolsOnly === true && raw.command === "codex-acp" ? { gatewayToolsModel: raw.gatewayToolsModel } : {}
  };
}
var CLAUDE_EGRESS_PLACEHOLDER = "verity-claude-egress-placeholder-v1";
function childEnvironment(command, source = process.env, sessionEnv = void 0, turnCapability = void 0, gitAuthor = void 0, signCommits = void 0) {
  const copy = (name) => source[name] === void 0 ? {} : { [name]: source[name] };
  const runtimeContext = {};
  for (const name of SESSION_RUNTIME_ENV_KEYS) {
    const value = sessionEnv?.[name];
    if (typeof value === "string" && value.length > 0) runtimeContext[name] = value;
  }
  const connectorUrl = source.VERITY_CLAUDE_CONNECTOR_URL;
  const isClaude = command === "claude-agent-acp";
  const connectorEnv = isClaude && isLocalConnectorUrl(connectorUrl) ? {
    ANTHROPIC_BASE_URL: connectorUrl,
    // Fixed, non-secret placeholder — the real OAuth token lives only in the
    // egress gateway; the connector rewrites this value. Not a credential.
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
    // Names the arrangement above, because the Claude CLI strips the
    // placeholder from the subprocesses it spawns: an in-Sandbox helper that
    // has to re-supply it (`verity-code-review`'s isolated reviewer) would
    // otherwise have to guess from ANTHROPIC_BASE_URL looking loopback, which
    // is also true of an unrelated local Anthropic-compatible proxy.
    VERITY_CLAUDE_EGRESS: "1"
  } : {};
  return {
    // First, so every fixed key below wins over anything a request supplied.
    ...runtimeContext,
    // Lifecycle launchers sanitize PATH before starting this broker. Restore the
    // image-owned Git/forge guards without losing package shims or interpreter paths.
    PATH: `/opt/verity/package-managers:/opt/agent-seed/bin:${source.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: source.VERITY_AGENT_HOME ?? "/home/dev",
    USER: source.VERITY_AGENT_USER ?? "dev",
    LOGNAME: source.VERITY_AGENT_USER ?? "dev",
    LANG: source.LANG ?? "C.UTF-8",
    ...isClaude ? copy("CLAUDE_CONFIG_DIR") : {},
    // claude-agent-acp otherwise starts the private Claude CLI bundled with its
    // Agent SDK. Pin it to the root-owned image binary so upgrades and the live
    // smoke exercise the same executable. Never accept this path from a request.
    ...command === "claude-agent-acp" ? { CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude" } : {},
    // The Claude CLI opens a cross-session inbox by default: a socket under
    // /tmp/cc-socks that every other Claude process of the same user can find and
    // write to. All sessions of a project share this Sandbox and its uid, so any
    // of them could message any other directly, bypassing session links, their
    // approval and their allowance. Session links are the only agent-to-agent
    // channel. Never accept this value from a request.
    ...isClaude ? { CLAUDE_CODE_HARBOR_KITE: "0" } : {},
    // The Claude CLI offers its task-list tools (TaskCreate/TaskUpdate, which the
    // ACP adapter reports as a plan) only to models on its own allowlist. Newer
    // models silently lose them, and the app never receives a checklist.
    ...isClaude ? { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } : {},
    // ADR 0006 D10: derive auth only from one validated local connector URL.
    // Never copy an inherited OAuth/API token; the placeholder is fixed here.
    ...connectorEnv,
    ...command === "codex-acp" ? {
      ...copy("CODEX_HOME"),
      VERITY_CODEX_PLACEHOLDER: "verity-codex-gateway-placeholder-v1"
    } : {},
    // codex-acp otherwise runs the @openai/codex copy bundled with the adapter.
    // Pin it to the root-owned, Renovate-pinned image binary — same reasoning as
    // CLAUDE_CODE_EXECUTABLE above. NO_BROWSER keeps the browserless sandbox from
    // being handed an interactive login flow it cannot complete. Never accept
    // either value from a request.
    // INITIAL_AGENT_MODE sets approvalPolicy 'never' + sandbox 'danger-full-access': the project
    // container is the isolation boundary, and Verity has no Codex approval UI.
    // Fixed here so a request cannot pick the mode.
    ...command === "codex-acp" ? {
      CODEX_PATH: "/usr/local/bin/codex",
      NO_BROWSER: "1",
      INITIAL_AGENT_MODE: "agent-full-access"
    } : {},
    // Verity's server-owned provider config lives outside OpenCode's writable XDG
    // directory. OpenCode creates files such as .gitignore under the latter during
    // startup, so mounting the whole directory read-only makes every turn crash.
    // OPENCODE_CONFIG points at the separate read-only directory bind while
    // XDG_CONFIG_HOME keeps OpenCode's own files writable. Both are copied, never
    // accepted from a request, and only for the one command that reads them.
    //
    // `copy` reads THIS process's environment, which is the container's: the
    // provisioner puts the variable in the container `Env`, and the stack launcher
    // starts this broker with a plain `nohup` rather than the `env -i` allowlist the
    // egress connector gets (`verity-runner-stack-start`). Move the broker behind a
    // sanitized environment and this forward has to be added to that allowlist.
    //
    // The other three XDG roots are NOT copied — they are pinned, because the
    // container sets none of them and the fallback behind them is `$HOME`, which
    // this function pins to a directory a project's devcontainer image need not
    // have. See {@link OPENCODE_STATE_DIR} for what each one holds and why the
    // path is container-local.
    ...command === "opencode-acp" ? {
      ...copy("XDG_CONFIG_HOME"),
      ...copy("OPENCODE_CONFIG"),
      // Repository config is executable policy: it can redefine the plan
      // agent, replace providers/MCP servers and load local tools. These
      // flags must be fixed here, never inherited from the container or turn.
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      XDG_DATA_HOME: `${OPENCODE_STATE_DIR}/data`,
      XDG_STATE_HOME: `${OPENCODE_STATE_DIR}/state`,
      XDG_CACHE_HOME: `${OPENCODE_STATE_DIR}/cache`
    } : {},
    ...copy("IS_SANDBOX"),
    ...copy("VERITY_FORGE_MODE"),
    ...copy("VERITY_FORGE_AUTHORITY"),
    ...copy("VERITY_FORGE_PROXY_URL"),
    ...copy("VERITY_FORGE_PROXY_CA_FILE"),
    ...copy("GIT_TERMINAL_PROMPT"),
    ...copy("GIT_CONFIG_COUNT"),
    ...Object.fromEntries(
      Object.entries(source).filter(([name]) => /^GIT_CONFIG_(KEY|VALUE)_\d+$/u.test(name))
    ),
    // A person without a signing key commits unsigned, from this turn's request
    // only. Appended after the container's own pairs, which keep the signing
    // program and key configured for everyone else in the container.
    ...signCommits === false ? unsignedCommitsConfig(source) : {},
    ...copy("VERITY_SIGNING_URL"),
    ...copy("VERITY_SIGNING_TOKEN_FILE"),
    ...copy("VERITY_GH_BROKER_CAPABILITY_FILE"),
    ...copy("VERITY_PROJECT_MEMORY_URL"),
    ...copy("VERITY_PROJECT_REPO_URL"),
    // Only ever from this turn's request, never copied from the container: an
    // ambient value would let one turn present another turn's badge.
    ...typeof turnCapability === "string" && TURN_CAPABILITY_PATTERN.test(turnCapability) ? { VERITY_TURN_CAPABILITY: turnCapability } : {},
    // The turn's own author, also only from this turn's request. git prefers these
    // over the shared container's `user.name` / `user.email`, which name one person.
    ...isGitAuthor(gitAuthor) ? {
      GIT_AUTHOR_NAME: gitAuthor.name,
      GIT_AUTHOR_EMAIL: gitAuthor.email,
      GIT_COMMITTER_NAME: gitAuthor.name,
      GIT_COMMITTER_EMAIL: gitAuthor.email
    } : {}
  };
}
var PRIVILEGE_DROP_FLAGS = Object.freeze([
  "--clear-groups",
  "--no-new-privs",
  "--inh-caps=-all",
  "--ambient-caps=-all",
  "--bounding-set=-all"
]);
function privilegeDropFlags(dockerGid, runnerGid) {
  if (dockerGid === void 0 || dockerGid === "") return [...PRIVILEGE_DROP_FLAGS];
  const gid = Number(dockerGid);
  if (!Number.isSafeInteger(gid) || gid < 1) {
    throw new Error("agent spawn broker requires a positive docker group id");
  }
  if (runnerGid !== void 0 && gid === Number(runnerGid)) {
    throw new Error("agent spawn broker refuses the Runner runtime gid as a docker grant");
  }
  return [`--groups=${String(gid)}`, ...PRIVILEGE_DROP_FLAGS.slice(1)];
}
function resolveDockerGid(env, statSocketGid) {
  const declared = env.VERITY_AGENT_DOCKER_GID;
  if (declared === void 0 || declared === "") return void 0;
  let socketGid;
  try {
    socketGid = statSocketGid("/var/run/docker.sock");
  } catch {
    socketGid = void 0;
  }
  if (socketGid === void 0 || String(socketGid) !== String(declared)) {
    process.stderr.write(
      "verity-agent-spawn-broker: ignoring VERITY_AGENT_DOCKER_GID \u2014 no /var/run/docker.sock owned by that group\n"
    );
    return void 0;
  }
  return String(declared);
}
var activeSessionHomes = /* @__PURE__ */ new Set();
var sessionHomeLocks = /* @__PURE__ */ new Map();
var SESSION_HOME_WAIT_MS = 2e3;
var SESSION_HOME_BUSY = "session home is already in use; the previous agent is still shutting down. Wait a moment and try again.";
async function waitForSessionHome(home) {
  const deadline = Date.now() + SESSION_HOME_WAIT_MS;
  while (activeSessionHomes.has(home)) {
    if (Date.now() >= deadline) throw new Error(SESSION_HOME_BUSY);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
function sessionHomePath(runtimeDir, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256 || hasControlCharacter(sessionId))
    throw new Error("invalid session id");
  return join5(runtimeDir, "session-homes", createHash2("sha256").update(sessionId).digest("hex"));
}
async function policyWrite(path, content, options = {}) {
  const temporary = `${path}.${randomUUID3()}.tmp`;
  try {
    await writeFile2(temporary, content, { mode: options.mode ?? 420, flag: "wx" });
    await rename2(temporary, path);
  } finally {
    await rm4(temporary, { force: true });
  }
}
async function managedDirectory(path, owner, group) {
  try {
    await mkdir4(path, { mode: 493 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const metadata2 = await lstat5(path);
  if (!metadata2.isDirectory() || metadata2.isSymbolicLink())
    throw new Error("invalid session home directory");
  await chown4(path, owner, group);
  await chmod4(path, 493);
}
async function lockSessionHome(home, options, nonblocking = false) {
  await managedDirectory(
    join5(options.runtimeDir, "session-homes"),
    process.getuid(),
    process.getgid()
  );
  const handle = await open3(
    `${home}.lock`,
    constants3.O_CREAT | constants3.O_RDWR | constants3.O_NOFOLLOW,
    384
  );
  try {
    await new Promise((resolveLock, rejectLock) => {
      const child = spawn5(
        "/usr/bin/flock",
        [...nonblocking ? ["--nonblock"] : ["--wait", String(SESSION_HOME_WAIT_MS / 1e3)], "3"],
        {
          stdio: ["ignore", "ignore", "ignore", handle.fd]
        }
      );
      child.once("error", rejectLock);
      child.once(
        "exit",
        (code) => code === 0 ? resolveLock() : rejectLock(new Error(SESSION_HOME_BUSY))
      );
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function npmCachePath(options) {
  return join5(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, "package-cache", "npm");
}

// features/verity-sandbox-toolkit/src/spawn-broker/main.mjs
var invokedPath = process.argv[1] === void 0 ? void 0 : resolve4(process.argv[1]);
if (invokedPath === fileURLToPath2(import.meta.url)) {
  const runtimeDir = process.env.VERITY_RUNNER_RUNTIME ?? DEFAULT_RUNTIME_DIR;
  const controlDir = process.env.VERITY_AGENT_BROKER_RUNTIME ?? DEFAULT_CONTROL_DIR;
  const sharedSessionRoot = process.env.VERITY_AGENT_SHARED_SESSION_ROOT === "1" || process.env.VERITY_AGENT_SHARED_SESSION_ROOT === "true" ? SHARED_SESSION_ROOT : void 0;
  const launch = process.argv[2] === "--reclaim-package-caches-maintenance" ? packageCacheMaintenanceMain(runtimeDir) : process.argv[2] === "--package-cache-leaf" ? packageCacheLeafMain() : process.argv[2] === "--probe" ? probeAgentSpawnBroker(controlDir) : runAgentSpawnBroker({
    runtimeDir,
    controlDir,
    ...sharedSessionRoot === void 0 ? {} : { sharedSessionRoot },
    agentUid: Number(process.env.VERITY_AGENT_UID ?? 1e3),
    agentGid: Number(process.env.VERITY_AGENT_GID ?? 1e3),
    runnerUid: Number(process.env.VERITY_RUNNER_RUNTIME_UID ?? 1101),
    runnerGid: Number(process.env.VERITY_RUNNER_RUNTIME_GID ?? 1101),
    // ADR 0006 Amendment 1. Set by `verity-control-plane-runner-start` and
    // by nothing else — but a project image CAN declare the same name, so
    // the value is re-checked against the mounted inode here rather than
    // trusted. See {@link resolveDockerGid}: no socket owned by the claimed
    // group, no grant, which is every project Sandbox.
    ...(() => {
      const dockerGid = resolveDockerGid(process.env, (path) => statSync(path).gid);
      return dockerGid === void 0 ? {} : { dockerGid };
    })(),
    // Thread the broker's own (container-provided) environment into the
    // Claude child through the `childEnvironment` allowlist. The container
    // sets CLAUDE_CONFIG_DIR=/run/verity-runner/claude on the
    // runner-supervisor path; without this the allowlisted copy() has no
    // source and Claude never sees the config dir, so its transcript would
    // land off the shared mount. The allowlist bounds exposure to the
    // vetted keys only — inherited OAuth/API/egress secrets never cross
    // (see the "passes only the local Claude connector coordinates" test).
    env: process.env
  });
  launch.then((broker) => {
    if (typeof broker === "boolean") {
      process.exitCode = broker ? 0 : 1;
      return;
    }
    const shutdown = () => void broker.close().finally(() => process.exit(0));
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }).catch((error) => {
    if (process.argv[2] === "--reclaim-package-caches-maintenance") {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          code: error?.message === "runner runtime is in use" ? "runtime-busy" : "maintenance-failed"
        })
      );
    } else {
      process.stderr.write(
        `verity-agent-spawn-broker: ${error instanceof Error ? error.message : String(error)}
`
      );
    }
    process.exitCode = 1;
  });
}
export {
  AGENT_SPAWN_PROTOCOL_VERSION,
  DEFAULT_CONTROL_DIR,
  DEFAULT_RUNTIME_DIR,
  DEFAULT_SCRIPT_SANDBOX_PATH,
  DEFAULT_WORKTREE_ROOT,
  LEGACY_TRUSTED_CLI_ARGV_POLICY_SUFFIX,
  PRIVILEGE_DROP_FLAGS,
  PROCESS_TREE_KILL_GRACE_MS,
  SCRIPT_ISOLATION_UNAVAILABLE_ERROR,
  SHARED_SESSION_ROOT,
  TRUSTED_CLI_ARGV_POLICY_SUFFIX,
  acquirePackageCacheLease,
  acquireRuntimeAdmissionLease,
  agentLaunchSpec,
  agentSignalTraceSeconds,
  brokerSocketOwnership,
  capacityLeaseRequest,
  collectEscapedProcessTree,
  killExitedTrustedCliProcessGroup,
  loadTrustedCliArgvPolicy,
  matchesTrustedCliArgvPolicy,
  materializeKnowledgeIsolation,
  materializeManagedAgentHome,
  materializeTrustedCliEntryScript,
  prepareSessionHome,
  privilegeDropFlags,
  probeAgentSpawnBroker,
  probeScriptSandbox,
  reclaimPackageCaches,
  reclaimPackageCachesOffline,
  resetProcessTreeWarnings,
  resolveAgentWorktreeRoots,
  resolveDockerGid,
  restrictedCodexModelCatalog,
  restrictedOpenCodePermissions,
  restrictedOpenCodePolicies,
  runAgentSpawnBroker,
  runnerEgressReadiness,
  runnerStackHealth,
  sessionHomePath,
  stopAgentProcessGroup,
  trustedCliLaunchSpec,
  validateAgentSignalTraceLease,
  validateRunnerRuntimeStats,
  validateTrustedCliArguments,
  validateTrustedCliExecutable,
  withinAgentWorktreeRoots
};
