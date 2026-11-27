import { capacityLeaseRequest, ensureCapacityLeaseRoot } from './capacity-leases.mjs';
import { spawn } from 'node:child_process';
import { createManagedSecretServers } from '../../bin/verity-managed-secret-servers.mjs';
import { createConnection, createServer } from 'node:net';
import { chmod, chown, lstat, readFile, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AGENT_SPAWN_PROTOCOL_VERSION,
  DEFAULT_CONTROL_DIR,
  DEFAULT_RUNTIME_DIR,
  DEFAULT_SCRIPT_SANDBOX_PATH,
  MAX_FRAME_BYTES,
  acquireLock,
  activeSessionHomes,
  agentWorkspaceRead,
  decode,
  isLocalConnectorUrl,
  isObject,
  lockSessionHome,
  managedDirectory,
  policyWrite,
  privilegeDropFlags,
  resolveAgentWorktreeRoots,
  runnerEgressReadiness,
  runnerStackHealth,
  send,
  sessionHomePath,
  validateIdentity,
  validateSharedSessionRoot,
  validateSpawnRequest,
  waitForSessionHome,
  withinAgentWorktreeRoots,
} from './request.mjs';
import {
  acquirePackageCacheLease,
  acquireRuntimeAdmissionLease,
  agentSignalTraceSeconds,
  materializeKnowledgeIsolation,
  materializeManagedAgentHome,
  nativeStateRequest,
  prepareSessionHome,
  reclaimPackageCaches,
  removeKnowledgeIsolation,
} from './session-home.mjs';
import {
  PROCESS_TREE_KILL_GRACE_MS,
  SCRIPT_ISOLATION_UNAVAILABLE_ERROR,
  SCRIPT_SANDBOX_PROBE_TIMEOUT_MS,
  TRUSTED_CLI_SECRET_LEAK_ERROR,
  agentLaunchSpec,
  leakOutranks,
  materializeTrustedCliEntryScript,
  materializeTrustedCliSecrets,
  probeScriptSandbox,
  processStartTime,
  readProcFile,
  removeLegacyTrustedCliSecretFiles,
  statFields,
  trustedCliFailureCode,
  trustedCliLaunchSpec,
} from './launch.mjs';

/**
 * Depth-first walk of the descendants of `root` that a `kill(-root)` would MISS — the
 * ones outside process group `root`. `root` itself is NOT included (the group signal
 * owns it), and neither are the descendants inside that group: those the group signal
 * already reaches, and they are entitled to their leader's grace rather than to the
 * short one an escaped tree is escalated on. The walk still DESCENDS through them,
 * because an in-group shell is exactly how an escaped grandchild is reached.
 *
 * The group is `root`'s pid and NOT the `pgrp` its own `/proc` entry reports, because
 * `-root` is what the caller signals; see the note on the session-package copy.
 *
 * The kernel files a child under the thread that forked it, so every task's `children`
 * file is read. If the task directory cannot be listed, the main-thread path remains a
 * best-effort fallback.
 *
 * Exported for the drift tripwire only. This is a hand-synced fork of
 * `collectEscapedProcessTree` in `packages/session/src/process-tree.ts` — the broker is
 * standalone ESM and cannot import the workspace — and behaviourally identical, though
 * not textually: the seam is a positional `readProc` here and a `ProcessTreeOptions`
 * there, and the `keep` predicate is inlined here rather than passed to a shared
 * `walkProcessTree`. The test that keeps the two honest runs the same fixture table
 * through both walks; `signalProcessTree` and the grace constant are compared
 * separately, the latter by value only.
 */
export function collectEscapedProcessTree(root, readProc = readProcFile) {
  const rootGroup = String(root);
  const descendants = new Map();
  let rootStartTime;
  try {
    rootStartTime = processStartTime(root, readProc);
  } catch {
    return descendants;
  }
  if (rootStartTime === '') return descendants;
  const visited = new Set();
  const visit = (parent) => {
    if (visited.has(parent)) return;
    visited.add(parent);
    let taskIds;
    try {
      taskIds = readdirSync(`/proc/${parent}/task`)
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number);
    } catch {
      taskIds = [parent];
    }
    const children = new Set();
    for (const taskId of taskIds) {
      try {
        for (const child of readProc(`/proc/${parent}/task/${taskId}/children`)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)) {
          children.add(child);
        }
      } catch {
        // A thread or the whole parent exited mid-walk.
      }
    }
    for (const child of children) {
      try {
        // Fence the recursive read on BOTH sides. The pid came from its parent's
        // `children` file, but it can exit and be reused before or during `visit`.
        // Anything collected below a child whose identity changed may belong to the
        // replacement process, so roll that entire addition back.
        const before = statFields(child, readProc);
        const startTime = before[19] ?? '';
        // No start time means no fence: at signal time an empty capture would compare
        // equal to the empty read of whatever now holds that pid, and the check meant to
        // refuse a recycled pid would wave it through. A descendant whose identity cannot
        // be established is therefore dropped — the group signal still covers it if it
        // never left the group, and an unfenced kill is the one outcome worth avoiding.
        if (startTime === '') continue;
        const alreadyCollected = new Set(descendants.keys());
        visit(child);
        const after = statFields(child, readProc);
        if ((after[19] ?? '') !== startTime) {
          for (const pid of descendants.keys()) {
            if (!alreadyCollected.has(pid)) descendants.delete(pid);
          }
          continue;
        }
        if ((after[2] ?? '') !== rootGroup) descendants.set(child, startTime);
      } catch {
        // It exited while the tree was being captured.
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

/**
 * A diagnostic line on stderr. Guarded: a broker whose stderr has been closed under it
 * gets EPIPE, and these calls sit in detached timer callbacks where that would be an
 * uncaught exception rather than a lost log line.
 */
function warn(message) {
  const ignoreWriteError = () => undefined;
  process.stderr.once('error', ignoreWriteError);
  try {
    process.stderr.write(`verity-agent-spawn-broker: ${message}\n`, () => {
      process.stderr.off('error', ignoreWriteError);
    });
  } catch {
    process.stderr.off('error', ignoreWriteError);
    // Nowhere to report to.
  }
}

/** Warned once per broker process; the condition is a property of the kernel. */
let childrenApiWarned = false;

/**
 * `/proc/<pid>/task/<pid>/children` exists only on kernels built with
 * `CONFIG_CHECKPOINT_RESTORE`. Without it the walk finds nothing, every teardown looks
 * like a sandbox that simply had no escaped tool trees, and the escalation log below —
 * the tell this design leans on — stays silent for the one reason that is NOT success.
 * Checked only when the walk came back empty, so the common case reads nothing extra.
 */
function warnIfChildrenApiMissing(pid, readProc) {
  if (childrenApiWarned) return;
  try {
    // A process that has already exited has no `children` file either, and that is the
    // common case, not a kernel without the API. Its `stat` is the discriminator.
    readProc(`/proc/${pid}/stat`);
  } catch {
    return;
  }
  try {
    readProc(`/proc/${pid}/task/${pid}/children`);
  } catch {
    childrenApiWarned = true;
    warn(
      'no /proc/<pid>/task/<pid>/children on this kernel (CONFIG_CHECKPOINT_RESTORE) — ' +
        'agent tool trees that left the process group cannot be reached',
    );
  }
}

/**
 * Clear the once-per-process latch above. Exported for tests only: the latch makes the
 * warning order-dependent across a file that tears many fake trees down, and a test that
 * asserts the line is written has to start from a known state rather than from whichever
 * test happened to run first.
 */
export function resetProcessTreeWarnings() {
  childrenApiWarned = false;
}

/**
 * Signal a captured tree, skipping any pid whose start time no longer matches, and
 * report how many pids were actually signalled — the escalation below is the one event
 * here worth a line in the broker's log, and this is what tells it whether to write one.
 */
function signalProcessTree(tree, signal, kill, readProc) {
  let signalled = 0;
  for (const [pid, startTime] of tree) {
    try {
      if (processStartTime(pid, readProc) !== startTime) continue;
      kill(pid, signal);
      signalled += 1;
    } catch {
      // Already gone.
    }
  }
  return signalled;
}

/**
 * Stop an agent and everything it started. The process group signal alone is not
 * enough: an agent starts each Bash tool call through `setsid`, so the shell — and the
 * `vitest`/`tsc` tree under it — leads its own group and `kill(-pid)` never reaches it.
 * Those survivors reparent to the sandbox's init and keep holding the sandbox's memory
 * and pid budget until the container is recreated. The `/proc` parent/child links
 * survive `setsid`, so the escaped subtree is walked first, signalled, and escalated to
 * SIGKILL after {@link PROCESS_TREE_KILL_GRACE_MS} — the agent itself keeps whatever
 * grace its caller grants it.
 */
export function stopAgentProcessGroup(child, signal, options = {}) {
  const kill = options.kill ?? ((pid, signalName) => process.kill(pid, signalName));
  const readProc = options.readProc ?? readProcFile;
  const running = child.exitCode === null && child.signalCode === null;
  if (child.pid === undefined || !running) {
    child.kill(signal);
    return;
  }
  // Captured BEFORE anything is signalled: a SIGTERM'd shell tears its own children
  // down, and a tree walked afterwards would be missing exactly what we mean to reach.
  let rootStartTime = '';
  try {
    rootStartTime = processStartTime(child.pid, readProc);
  } catch {
    // Root exited before its identity could be captured.
  }
  const escaped = collectEscapedProcessTree(child.pid, readProc);
  if (escaped.size === 0) warnIfChildrenApiMissing(child.pid, readProc);
  signalProcessTree(escaped, signal, kill, readProc);
  let rootIdentityMatches = true;
  if (rootStartTime !== '') {
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
      // The group may already be gone; fall back to Node's safe direct child
      // signal for custom spawners and spawn/exit races.
      child.kill(signal);
    }
  }
  // Nothing survives SIGKILL, and an empty capture has nothing to escalate: in both
  // cases a timer would only be a handle holding pids the kernel is free to recycle.
  if (signal === 'SIGKILL' || escaped.size === 0) return;
  // Deliberately NOT unref'd — see the session-package copy: broker shutdown is exactly
  // when a surviving tool tree costs the most, and the guard above keeps the timer from
  // being scheduled at all on a teardown that found nothing escaped.
  setTimeout(() => {
    const killed = signalProcessTree(escaped, 'SIGKILL', kill, readProc);
    // The one observable symptom of this whole mechanism. A tool tree that has to be
    // SIGKILLed is normal enough (a `vitest` run does not stop politely), but a sandbox
    // where this line NEVER appears while pids keep accumulating is how the leak coming
    // back — a `/proc` the walk can no longer read, a signal the kernel refuses — would
    // otherwise look exactly like success.
    if (killed > 0) warn(`SIGKILLed ${killed} agent tool process(es) that outlived SIGTERM`);
  }, PROCESS_TREE_KILL_GRACE_MS);
}

export function killExitedTrustedCliProcessGroup(child, kill = process.kill) {
  if (child.pid === undefined) return;
  try {
    kill(-child.pid, 'SIGKILL');
  } catch {
    // The expected case is that the process group disappeared with its leader.
  }
}

export function validateRunnerRuntimeStats(stats, options) {
  if (options.runnerUid === undefined) return;
  if (stats.gid !== Number(options.runnerGid)) {
    throw new Error('runner runtime ownership mismatch');
  }
  const runnerOwned = stats.uid === Number(options.runnerUid);
  // Owner read/write must stay clear (a same-uid agent must not touch the
  // Runner's control files), but a bare owner traverse bit (0170, --x) is allowed
  // so the agent can descend to its Server-created transcript dir under claude/.
  const serverOwned = !runnerOwned && (stats.mode & 0o600) === 0;
  if (!runnerOwned && !serverOwned) {
    throw new Error('runner runtime ownership mismatch');
  }
  if ((stats.mode & 0o007) !== 0 || (stats.mode & 0o070) !== 0o070) {
    throw new Error('runner runtime must be group-only and writable');
  }
}

export function brokerSocketOwnership(options) {
  if (options.runnerUid === undefined) return { uid: undefined, gid: undefined, mode: 0o600 };
  const rootBroker = options.enforceRoot !== false;
  return {
    uid: rootBroker ? 0 : Number(options.runnerUid),
    gid: Number(options.runnerGid),
    mode: rootBroker ? 0o660 : 0o600,
  };
}

async function readConnectorUrl(path, expectedUid) {
  try {
    const stats = await lstat(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.uid !== expectedUid ||
      (stats.mode & 0o077) !== 0 ||
      stats.size > 128
    ) {
      throw new Error('invalid Claude connector routing file');
    }
    const value = (await readFile(path, 'utf8')).trim();
    if (!isLocalConnectorUrl(value)) {
      throw new Error('invalid Claude connector routing URL');
    }
    return value;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function runAgentSpawnBroker(options = {}) {
  if (options.enforceRoot !== false && process.getuid?.() !== 0)
    throw new Error('agent spawn broker must run as root');
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
    throw new Error('agent spawn broker must run as root');
  }
  validateIdentity(options);
  await validateSharedSessionRoot(options);
  const runtimeDir = resolve(options.runtimeDir ?? DEFAULT_RUNTIME_DIR);
  // The unprivileged test seam must keep every broker-owned path inside its
  // temporary runtime. Falling back to the production secret directory here
  // makes even a secret-free probe depend on access to root-owned `/run` state.
  if (options.enforceRoot === false && options.secretDir === undefined) {
    options = { ...options, secretDir: join(runtimeDir, 'secrets') };
  }
  // `enforceRoot: false` is the explicit test seam; every real/root broker uses
  // the fixed root-owned control directory unless the caller names another one.
  const controlDir = resolve(
    options.controlDir ?? (options.enforceRoot === false ? runtimeDir : DEFAULT_CONTROL_DIR),
  );
  const stats = await lstat(runtimeDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('invalid runner runtime');
  if ((options.runnerUid === undefined) !== (options.runnerGid === undefined)) {
    throw new Error('runner uid and gid must be configured together');
  }
  validateRunnerRuntimeStats(stats, options);
  const scriptIsolation =
    options.scriptIsolation ??
    // A root probe can fail user-namespace mapping even when the agent can
    // enforce isolation. Probe with the same privilege drop as actual launches.
    (await probeScriptSandbox(
      options.scriptSandboxPath ?? DEFAULT_SCRIPT_SANDBOX_PATH,
      SCRIPT_SANDBOX_PROBE_TIMEOUT_MS,
      options.enforceRoot === false ? undefined : options,
    ));
  if (!scriptIsolation.available) {
    process.stderr.write(
      `verity-agent-spawn-broker: worktree entry scripts are disabled: ${scriptIsolation.reason ?? 'script sandbox unavailable'}\n`,
    );
  }
  const identity = validateIdentity(options);
  const managedRoots = await resolveAgentWorktreeRoots(options);
  const lock = await acquireLock(join(controlDir, 'agent-spawn-broker.lock'));
  onLock(lock);
  await removeLegacyTrustedCliSecretFiles(options);
  const socketPath = join(controlDir, 'agent-spawn-broker.sock');
  await rm(socketPath, { force: true });
  const children = new Map();
  const sockets = new Set();
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const connectorConfigPath =
    options.connectorConfigPath ?? join(controlDir, 'egress-connector.url');
  const connectorConfigOwner = options.enforceRoot === false ? (process.getuid?.() ?? 0) : 0;
  let closing = false;
  const spawnChild = (command, args, spawnOptions) => {
    const stdio = Array.isArray(spawnOptions.stdio)
      ? [...spawnOptions.stdio]
      : Array(3).fill(spawnOptions.stdio ?? 'pipe');
    // Managed servers and escaped descendants must keep offline maintenance excluded too.
    stdio.push(admissionLease.fd);
    return (options.spawnChild ?? spawn)(command, args, { ...spawnOptions, stdio });
  };
  // Codex opens one shared SQLite state runtime for every fresh ACP process. Its
  // startup path can return EAGAIN when two processes open that runtime together,
  // even after all databases already exist. Serialize only that startup window:
  // the first ACP stdout proves initialization completed, after which the live
  // processes may continue concurrently.
  let codexStartupTail = Promise.resolve();
  const acquireCodexStartup = async () => {
    let releaseSlot = () => undefined;
    const slot = new Promise((resolveSlot) => (releaseSlot = resolveSlot));
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
    uid: identity.uid,
    gid: identity.gid,
    privilegeDropFlags: privilegeDropFlags(options.dockerGid, options.runnerGid),
    setprivPath: options.setprivPath,
    env: options.env,
    spawnChild,
    realpath: (path) => agentWorkspaceRead('realpath', path, options),
    stopTagged: (id, signal) => agentWorkspaceRead('managedStop', id + ':' + signal, options),
    allowedPath: (path) => withinAgentWorktreeRoots(path, managedRoots),
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    let child;
    let processing = Promise.resolve();
    let accepted = false;
    let connectionClosed = false;
    let childRecord;
    let protocolFailed = false;
    let trustedCliFailurePhase;
    let trustedCliCorrelationId;
    let releaseCodexStartup = () => undefined;
    const fail = (error) => {
      if (protocolFailed) return;
      protocolFailed = true;
      send(socket, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(trustedCliFailurePhase === undefined
          ? {}
          : {
              trustedCliFailure: {
                phase: trustedCliFailurePhase,
                cause: `${trustedCliFailurePhase} failed`,
                code: trustedCliFailureCode(trustedCliFailurePhase, error),
                ...(trustedCliCorrelationId === undefined
                  ? {}
                  : { correlationId: trustedCliCorrelationId }),
              },
            }),
      });
      childRecord?.stop('SIGKILL');
      socket.end();
    };
    const handle = async (raw) => {
      if (protocolFailed) return;
      if (!accepted) {
        if (
          isObject(raw) &&
          raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION &&
          raw.kind === 'status'
        ) {
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
            scriptIsolation: scriptIsolation.available,
          });
          socket.end();
          return;
        }
        if (
          isObject(raw) &&
          raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION &&
          raw.kind === 'stack-health'
        ) {
          protocolFailed = true;
          send(socket, await runnerStackHealth({ ...options, controlDir }));
          socket.end();
          return;
        }
        if (
          isObject(raw) &&
          raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION &&
          raw.kind === 'egress-readiness'
        ) {
          protocolFailed = true;
          send(
            socket,
            await runnerEgressReadiness({ env: options.env, ...options.egressReadiness }),
          );
          socket.end();
          return;
        }
        if (closing) throw new Error('agent spawn broker is shutting down');
        if (isObject(raw) && raw.kind === 'capacity-lease') {
          protocolFailed = true;
          send(socket, await capacityLeaseRequest(raw, options));
          socket.end();
          return;
        }
        if (
          isObject(raw) &&
          raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION &&
          raw.kind === 'reclaim-package-caches'
        ) {
          send(socket, { ok: true, report: await reclaimPackageCaches(raw, options) });
          socket.end();
          return;
        }
        if (
          isObject(raw) &&
          raw.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION &&
          ['prepare-session-home', 'delete-session-home'].includes(raw.kind)
        ) {
          const home = sessionHomePath(options.runtimeDir, raw.sessionId);
          if (raw.kind === 'delete-session-home') {
            // The durable marker fences late starts after an interrupted deletion.
            await managedDirectory(
              join(options.runtimeDir, 'session-homes'),
              process.getuid(),
              process.getgid(),
            );
            await policyWrite(`${home}.deleted`, '{}');
            const owned = [...children.values()].filter(
              (record) => record.sessionId === raw.sessionId,
            );
            for (const record of owned) record.stop('SIGKILL');
            await Promise.all(owned.map((record) => record.closed));
            if (activeSessionHomes.has(home)) throw new Error('session storage is still in use');
            const lease = await lockSessionHome(home, options);
            try {
              const manifest = await readFile(join(home, '.legacy-opencode.json'), 'utf8').catch(
                (error) => {
                  if (error.code === 'ENOENT') return undefined;
                  throw error;
                },
              );
              if (manifest)
                await nativeStateRequest({ operation: 'purge', ...JSON.parse(manifest) }, options);
              await removeKnowledgeIsolation(home, identity.uid, identity.gid, options.setprivPath);
            } finally {
              await lease.close();
            }
          } else {
            await waitForSessionHome(home);
            await prepareSessionHome(raw.sessionId, options, {
              backend: raw.legacyBackend,
              sessionId: raw.legacySessionId,
            });
          }
          send(socket, { ok: true });
          socket.end();
          return;
        }

        if (
          isObject(raw) &&
          typeof raw.kind === 'string' &&
          raw.kind.startsWith('managed-secret-')
        ) {
          protocolFailed = true;
          try {
            send(socket, { ok: true, ...(await managedSecrets.handle(raw)) });
          } catch {
            send(socket, { ok: false, error: 'Managed secret server request failed.' });
          }
          socket.end();
          return;
        }
        if (isObject(raw) && raw.kind === 'spawn-trusted-cli') {
          trustedCliFailurePhase = 'validation';
        }
        const request = await validateSpawnRequest(raw, options);
        if (request.kind === 'trusted-cli') trustedCliCorrelationId = request.correlationId;
        // Still inside validation: nothing of the request is on disk yet. Both launch
        // paths below wrap the command in the script sandbox, which cannot confine it
        // here, so refuse now rather than stage an approved script and its secrets.
        if (
          !scriptIsolation.available &&
          ((request.kind === 'trusted-cli' && request.entryScript !== undefined) ||
            (request.kind === 'agent' && (request.knowledgeIsolation || request.planning)))
        ) {
          throw new Error(SCRIPT_ISOLATION_UNAVAILABLE_ERROR);
        }
        if (closing || connectionClosed) throw new Error('agent spawn request was detached');
        const connectorUrl =
          request.kind === 'agent'
            ? await readConnectorUrl(connectorConfigPath, connectorConfigOwner)
            : undefined;
        if (request.kind === 'trusted-cli') trustedCliFailurePhase = 'materialization';
        const materialized =
          request.kind === 'agent'
            ? { args: request.args, cleanup: async () => undefined }
            : await (async () => {
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
                  ...(entryScript.entrySandbox === undefined
                    ? {}
                    : { entrySandbox: entryScript.entrySandbox }),
                  cleanup: async () => {
                    const [secretContained] = await Promise.all([
                      secrets.cleanup(),
                      entryScript.cleanup(),
                    ]);
                    // A stranded snapshot contains only bytes the user approved,
                    // not a credential. Its cleanup failure must not falsely
                    // report that a secret leaked; the secret result remains the
                    // containment authority for this combined cleanup.
                    return secretContained;
                  },
                };
              })();
        try {
          // Inside the cleanup guard, not before it. Since ADR 0012 removed the
          // resolve-anything fallback, `agentLaunchSpec` rejects an unmapped command
          // by throwing, and by this point the request's files and secrets are
          // already on disk — so a throw with the spec built OUTSIDE the guard would
          // leave them there.
          //
          // No request can reach that throw today: `validateSpawnRequest` bounds
          // `command` to the same two names before anything is materialized, which
          // is also why this has no test driving it. The two lists are the point.
          // They are maintained separately on purpose — one guards the socket, one
          // guards the exported function — so they can disagree, and the day they do
          // is the day this matters. Cheap enough to hold the guard open for.
          if (request.kind === 'agent' && (request.knowledgeIsolation || request.planning)) {
            const isolated = await (request.planning && !request.knowledgeIsolation
              ? materializeManagedAgentHome(request, options, connectorUrl)
              : materializeKnowledgeIsolation(request, options, connectorUrl));
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
          if (
            request.kind === 'agent' &&
            !request.knowledgeIsolation &&
            !request.planning &&
            (options.enforceRoot !== false ||
              connectorUrl !== undefined ||
              request.gatewayToolsOnly)
          ) {
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
          if (request.kind === 'trusted-cli') trustedCliFailurePhase = 'launch-spec';
          if (request.kind === 'agent') {
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
          if (
            request.kind === 'agent' &&
            (options.enforceRoot !== false || options.capacityLeaseRoot !== undefined)
          ) {
            // The confined agent sees only roots that exist at launch. A failure
            // leaves dependency installs refused, never the agent unstarted.
            await ensureCapacityLeaseRoot(options).catch((error) => {
              process.stderr.write(
                `verity-agent-spawn-broker: capacity lease directory unavailable: ${error.code ?? error.message}\n`,
              );
            });
          }
          if (request.kind === 'agent' && request.command === 'codex-acp') {
            releaseCodexStartup = await acquireCodexStartup();
          }
          const spec =
            request.kind === 'agent'
              ? agentLaunchSpec(
                  { ...request, args: materialized.args },
                  {
                    ...options,
                    connectorUrl,
                    signalTraceSeconds: await agentSignalTraceSeconds(controlDir, request),
                  },
                )
              : trustedCliLaunchSpec(
                  {
                    ...request,
                    args: materialized.args,
                    ...(materialized.entrySandbox === undefined
                      ? {}
                      : { entrySandbox: materialized.entrySandbox }),
                  },
                  options,
                );
          if (request.kind === 'trusted-cli') trustedCliFailurePhase = 'spawn';
          child = spawnChild(spec.command, spec.args, spec.spawnOptions);
        } catch (error) {
          releaseCodexStartup();
          throw leakOutranks(await materialized.cleanup(), error);
        }
        const pendingFrames = [];
        let childClosed = false;
        let resolveClosed = () => undefined;
        const closed = new Promise((resolve) => (resolveClosed = resolve));
        let pendingSignal;
        const stop = (signal) => {
          pendingSignal = signal;
          stopAgentProcessGroup(child, signal);
        };
        childRecord = { child, closed, stop, sessionId: request.sessionEnv?.VERITY_SESSION_ID };
        children.set(child, childRecord);
        child.once('spawn', () => {
          if (pendingSignal !== undefined) child.kill(pendingSignal);
        });
        // Registered before the rejection handler below, so this containment is
        // always under way by the time the spawn rejection is handled.
        let spawnErrorCleanup;
        child.once('error', () => {
          releaseCodexStartup();
          spawnErrorCleanup = materialized.cleanup();
        });
        const relay = (kind, chunk) => {
          if (kind === 'stdout') releaseCodexStartup();
          const frame = { ok: true, kind, data: chunk.toString('base64') };
          if (!accepted) pendingFrames.push(frame);
          else if (!send(socket, frame)) {
            child.stdout?.pause();
            child.stderr?.pause();
          }
        };
        child.stdout?.on('data', (chunk) => relay('stdout', chunk));
        child.stderr?.on('data', (chunk) => relay('stderr', chunk));
        // `close` waits for inherited pipes, so a surviving descendant can hold
        // the broker's home claim forever even though the direct agent is dead.
        // Reap the remaining group at exit before waiting for pipe drain/cleanup.
        child.once('exit', () => killExitedTrustedCliProcessGroup(child));
        child.once('close', (code, signal) => {
          releaseCodexStartup();
          childClosed = true;
          children.delete(child);
          const exitFrame = { ok: true, kind: 'exit', code, signal };
          const deliver = (frame) => {
            // `accepted` is the whole guard against a child that never started
            // reporting success. A spawn failure emits `error` then `close`, so
            // this runs for it too and can queue an exit frame — but the spawn
            // rejection below throws before `accepted` is ever set, and queued
            // frames are flushed at exactly one place, after that assignment.
            // The frame is therefore dropped with the request, and the caller
            // hears the spawn failure. Keep that flush the only one.
            if (!accepted) pendingFrames.push(frame);
            else {
              send(socket, frame);
              socket.end();
            }
            resolveClosed();
          };
          if (request.kind === 'trusted-cli') {
            // A file-injected secret must be gone before its exit frame crosses
            // back: the caller is free to start the next run the moment it sees
            // that frame, and the `wx` guard would refuse it over this run's own
            // leftover. cleanup() never rejects, so this cannot strand the frame.
            void materialized.cleanup().then((contained) =>
              deliver(
                contained
                  ? exitFrame
                  : // Containment failed outright, so the credential is still
                    // sitting at a path the agent knows and owns. Reporting the
                    // command's own clean exit here would hide that. The
                    // supervisor turns `ok: false` into a failed run carrying
                    // this reason, which is what gets the secret rotated.
                    { ok: false, error: TRUSTED_CLI_SECRET_LEAK_ERROR },
              ),
            );
          } else if (request.knowledgeIsolation || request.kind === 'agent') {
            // Release the stable home before the caller can start its next turn.
            // Otherwise that sequential turn sees an active claim and falls back
            // to a disposable path that Codex persists in its thread database.
            void materialized.cleanup().then(
              () => deliver(exitFrame),
              () =>
                deliver({ ok: false, error: 'Could not remove the managed agent runtime home' }),
            );
          } else {
            deliver(exitFrame);
            void materialized.cleanup();
          }
        });
        await new Promise((resolveSpawn, rejectSpawn) => {
          child.once('spawn', resolveSpawn);
          child.once('error', rejectSpawn);
        }).catch(async (error) => {
          throw leakOutranks(await spawnErrorCleanup, error);
        });
        if (closing || connectionClosed) {
          stop('SIGKILL');
          throw new Error('agent spawn request was detached');
        }
        accepted = true;
        if (childClosed) children.delete(child);
        socket.on('drain', () => {
          child.stdout?.resume();
          child.stderr?.resume();
        });
        send(socket, {
          ok: true,
          kind: 'spawned',
          pid: child.pid,
        });
        for (const frame of pendingFrames) send(socket, frame);
        if (childClosed) socket.end();
        return;
      }
      if (!isObject(raw) || raw.protocolVersion !== AGENT_SPAWN_PROTOCOL_VERSION) {
        throw new Error('invalid agent control request');
      }
      if (raw.kind === 'stdin' && typeof raw.data === 'string') {
        if (child.stdin?.write(decode(raw.data)) === false) {
          socket.pause();
          child.stdin.once('drain', () => socket.resume());
        }
      } else if (raw.kind === 'close-stdin') child.stdin?.end();
      else if (raw.kind === 'signal' && ['SIGTERM', 'SIGKILL'].includes(raw.signal))
        childRecord.stop(raw.signal);
      else throw new Error('invalid agent control request');
    };
    socket.on('data', (chunk) => {
      if (buffered.length + chunk.length > maxFrameBytes) {
        fail(new Error('agent broker frame too large'));
        socket.destroy();
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffered.subarray(0, newline).toString('utf8');
        buffered = buffered.subarray(newline + 1);
        processing = processing.then(async () => await handle(JSON.parse(line))).catch(fail);
      }
    });
    socket.once('close', () => {
      connectionClosed = true;
      childRecord?.stop('SIGKILL');
    });
  });
  const previousUmask = process.umask(0o077);
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, resolveListen);
    });
  } finally {
    process.umask(previousUmask);
  }
  const socketOwnership = brokerSocketOwnership(options);
  if (socketOwnership.uid !== undefined && socketOwnership.gid !== undefined) {
    await chown(socketPath, socketOwnership.uid, socketOwnership.gid);
  }
  await chmod(socketPath, socketOwnership.mode);
  return {
    socketPath,
    async close() {
      closing = true;
      await managedSecrets.close();
      const running = [...children.values()];
      for (const record of running) record.stop('SIGTERM');
      const escalation = setTimeout(() => {
        for (const record of running) {
          if (record.child.exitCode === null) record.stop('SIGKILL');
        }
      }, options.shutdownGraceMs ?? 5_000);
      await Promise.all(running.map((record) => record.closed));
      clearTimeout(escalation);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
      await rm(socketPath, { force: true });
      await lock.close();
      await admissionLease.close();
    },
  };
}

export async function probeAgentSpawnBroker(controlDir = DEFAULT_CONTROL_DIR, timeoutMs = 1_000) {
  const socketPath = join(resolve(controlDir), 'agent-spawn-broker.sock');
  return await new Promise((resolveProbe) => {
    const socket = createConnection(socketPath);
    let response = '';
    let finished = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (live) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(live);
    };
    socket.once('error', () => finish(false));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response);
        finish(parsed?.ok === true && parsed.protocolVersion === AGENT_SPAWN_PROTOCOL_VERSION);
      } catch {
        finish(false);
      }
    });
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ protocolVersion: AGENT_SPAWN_PROTOCOL_VERSION, kind: 'status' })}\n`,
      );
    });
  });
}
