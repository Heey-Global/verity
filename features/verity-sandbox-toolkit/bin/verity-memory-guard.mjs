#!/usr/bin/env node

/**
 * In-container memory guard for a project Sandbox.
 *
 * A project Sandbox runs under a hard cgroup memory ceiling (HostConfig.Memory,
 * `DEFAULT_SANDBOX_MEMORY_BYTES` in the provisioner) and is shared by every
 * session of the project. Under gVisor, the default project runtime, the host
 * kernel cannot pick one guest process when that ceiling is hit: the whole guest
 * is one Sentry process plus platform stubs, the stubs are created to die with
 * SIGKILL, and the Sentry kills itself as soon as one of them is OOM-killed. The
 * cgroup limits the guest exposes are unenforced stubs in the pinned release, so
 * nothing inside the guest ever uses the margin below the limit. Every OOM kill
 * in the container's cgroup therefore ends every session in the project at
 * once — observed as `Memory cgroup out of memory: Killed process ... (exe)` on
 * the host and `containerManager.WaitPID EOF` on the Server.
 *
 * This guard stands in for the guest OOM killer the runtime does not have, the
 * way earlyoom or kubelet eviction stand in for a kernel that acts too late. It
 * polls the cgroup's usage and, once usage reaches the ceiling minus a reserve,
 * SIGKILLs the largest agent-owned command tree (see `chooseVictim`). One session's
 * build or test run dies with exit 137; the container and the other sessions
 * survive. The reserve exists because the guest cannot see the Sentry's own
 * memory (about 0.8 GiB anonymous RSS in the kill record) or the host page
 * cache charged to the cgroup; the guest's usage understates the host's charge
 * by roughly that much, so the threshold must sit well below the limit.
 *
 * This is a mitigation, not an isolation boundary. An allocation burst between
 * two polls can still reach the host limit, and growth in the Sentry's own
 * memory is invisible here. It makes the common case survivable; it does not
 * replace per-session isolation.
 *
 * Runs as root (CAP_KILL is among the container's retained capabilities) and is
 * launched by `verity-runner-stack-start` next to the spawn broker, idempotently
 * through `--probe`. Standalone ESM installed into the Sandbox image: no
 * workspace imports.
 *
 * Reads `/sys/fs/cgroup/memory/memory.{limit,usage}_in_bytes` (cgroup v1, which
 * gVisor mounts by default) or `memory.max` and `anon` from `memory.stat`
 * (cgroup v2, a runc Sandbox). The v1 usage includes the guest page cache on
 * purpose: under gVisor that cache lives in the Sentry's memory file, which the
 * host charges to the container like any anonymous page. With no readable finite limit the guard exits
 * quietly: there is nothing to defend.
 */

import { readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearInterval, setInterval } from 'node:timers';

export const DEFAULT_POLL_INTERVAL_MS = 500;
/** Share of the ceiling kept free for memory the guest cannot see. */
export const DEFAULT_RESERVE_FRACTION = 0.2;
/** Never reserve less than this: the Sentry alone exceeded 0.8 GiB when it was killed. */
export const DEFAULT_MINIMUM_RESERVE_BYTES = 1024 ** 3;
/** Time after a kill during which no second kill is attempted; freed pages take a moment to leave the cgroup. */
export const KILL_COOLDOWN_MS = 2_000;
/** Below this RSS a process is not worth killing: it would not free enough to matter and is likely infrastructure. */
export const MINIMUM_VICTIM_RSS_BYTES = 64 * 1024 ** 2;
export const DEFAULT_AGENT_UID = 1000;
export const DEFAULT_CONTROL_DIR = '/run/verity-runner-broker';
export const PID_FILE_NAME = 'memory-guard.pid';
/** cgroup v1 spells "no limit" as a near-2^63 sentinel rather than `max`. */
const UNLIMITED_SENTINEL_BYTES = 2 ** 50;
const MAX_LOGGED_COMMAND = 200;

const readFsFile = (path) => readFileSync(path, 'utf8');
const listProcDir = () => readdirSync('/proc');
const readProcLink = (path) => readlinkSync(path);

function parseBytes(text) {
  const value = Number.parseInt(text.trim(), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tryRead(readFile, path) {
  try {
    return readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * The container's memory ceiling and current charge as the guest can see them.
 * Returns `undefined` when no finite limit is readable: nothing to defend.
 *
 * cgroup v2 is consulted first because its files sit at the root and a v1
 * mount never has them; `anon` from `memory.stat` is preferred over
 * `memory.current`, which counts reclaimable page cache and sits near the limit
 * after any build without being a reason to kill anything.
 */
export function readMemoryCeiling(readFile = readFsFile, cgroupRoot = '/sys/fs/cgroup') {
  const v2Max = tryRead(readFile, join(cgroupRoot, 'memory.max'));
  if (v2Max !== undefined) {
    if (v2Max.trim() === 'max') return undefined;
    const limitBytes = parseBytes(v2Max);
    if (limitBytes === undefined || limitBytes === 0) return undefined;
    const stat = tryRead(readFile, join(cgroupRoot, 'memory.stat'));
    const anonLine = stat?.split('\n').find((line) => line.startsWith('anon '));
    const anon = anonLine === undefined ? undefined : parseBytes(anonLine.slice('anon '.length));
    const current = tryRead(readFile, join(cgroupRoot, 'memory.current'));
    const usageBytes = anon ?? (current === undefined ? undefined : parseBytes(current));
    if (usageBytes === undefined) return undefined;
    return { limitBytes, usageBytes, source: 'cgroup-v2' };
  }
  const v1Limit = tryRead(readFile, join(cgroupRoot, 'memory', 'memory.limit_in_bytes'));
  if (v1Limit === undefined) return undefined;
  const limitBytes = parseBytes(v1Limit);
  if (limitBytes === undefined || limitBytes === 0 || limitBytes >= UNLIMITED_SENTINEL_BYTES) {
    return undefined;
  }
  const v1Usage = tryRead(readFile, join(cgroupRoot, 'memory', 'memory.usage_in_bytes'));
  const usageBytes = v1Usage === undefined ? undefined : parseBytes(v1Usage);
  if (usageBytes === undefined) return undefined;
  return { limitBytes, usageBytes, source: 'cgroup-v1' };
}

/**
 * How much of the ceiling to keep free. The default is a fifth of the limit and
 * never less than 1 GiB, capped at half the limit so a small ceiling still
 * leaves room to work in. `VERITY_MEMORY_GUARD_RESERVE_BYTES` overrides it when
 * it parses as a positive integer below the limit; anything else is ignored
 * rather than trusted, since a bad reserve either disarms the guard or makes it
 * kill at idle.
 */
export function resolveReserveBytes(limitBytes, env = {}) {
  const override = env.VERITY_MEMORY_GUARD_RESERVE_BYTES;
  if (typeof override === 'string' && /^\d+$/u.test(override)) {
    const bytes = Number.parseInt(override, 10);
    if (Number.isSafeInteger(bytes) && bytes > 0 && bytes < limitBytes) return bytes;
  }
  const proportional = Math.floor(limitBytes * DEFAULT_RESERVE_FRACTION);
  return Math.min(
    Math.max(proportional, DEFAULT_MINIMUM_RESERVE_BYTES),
    Math.floor(limitBytes / 2),
  );
}

export function resolvePollIntervalMs(env = {}) {
  const override = env.VERITY_MEMORY_GUARD_INTERVAL_MS;
  if (typeof override === 'string' && /^\d+$/u.test(override)) {
    const ms = Number.parseInt(override, 10);
    if (Number.isSafeInteger(ms) && ms >= 100 && ms <= 60_000) return ms;
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

function parseStatus(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  return fields;
}

/**
 * Every process the guard can see, from `/proc/<pid>/status`: enough to pick a
 * victim (uid, RSS) and to walk its descendants (ppid). A process that vanishes
 * between the listing and the read is skipped, not an error.
 */
export function listProcesses(readFile = readFsFile, listPids = listProcDir) {
  const processes = [];
  let entries;
  try {
    entries = listPids();
  } catch {
    return processes;
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    const status = tryRead(readFile, `/proc/${pid}/status`);
    if (status === undefined) continue;
    const fields = parseStatus(status);
    const ppid = Number.parseInt(fields.PPid ?? '', 10);
    const uid = Number.parseInt((fields.Uid ?? '').split(/\s+/)[0] ?? '', 10);
    const rssMatch = /^(\d+)\s*kB$/u.exec(fields.VmRSS ?? '');
    const rssBytes = rssMatch === null ? 0 : Number.parseInt(rssMatch[1], 10) * 1024;
    if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(uid)) continue;
    processes.push({ pid, ppid, uid, rssBytes, name: fields.Name ?? '' });
  }
  return processes;
}

/**
 * The agent-owned process tree to kill, ranked by the RSS of the whole tree.
 *
 * Only the agent uid qualifies: root and the Runner identity are the
 * container's infrastructure (init, spawn broker, supervisor, workers, egress
 * connector, this guard), and killing any of them would end sessions without
 * freeing the memory a build holds. Within the agent's processes the unit is a
 * whole command, not a single process, for two reasons. A test runner's worker
 * pool respawns a worker killed on its own, so killing the largest worker frees
 * nothing for long and repeats every cooldown; and the session that ran the
 * command should see that command fail with exit 137, not lose its agent.
 *
 * The tree shapes this distinguishes, from the agent processes' parents:
 *
 * - An agent process whose parent is infrastructure other than init is a
 *   session anchor — the ACP adapter the spawn broker started. It is never a
 *   unit of its own.
 * - Its children are the agent CLI. Killing one ends the session's agent, so a
 *   CLI tree is chosen only when no command tree qualifies: losing one session
 *   is still better than losing the container.
 * - Their children are the commands the agent ran (the tool shell, and under it
 *   `npm test`, vitest and its workers): the preferred units.
 * - An agent process under init — or with no visible parent — was detached from
 *   any session (a dev database, a backgrounded server) and is a unit with its
 *   whole tree.
 *
 * Trees below `MINIMUM_VICTIM_RSS_BYTES` are not worth killing. Ties go to the
 * higher pid, the younger tree.
 */
export function chooseVictim(processes, { agentUid, protectedPids = new Set() }) {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const isAgent = (process) =>
    process !== undefined && process.uid === agentUid && process.pid !== 1;
  const isAnchor = (process) => {
    const parent = byPid.get(process.ppid);
    return !isAgent(parent) && parent !== undefined && parent.pid !== 1;
  };
  const tierOf = (process) => {
    if (!isAgent(process)) return undefined;
    const parent = byPid.get(process.ppid);
    if (!isAgent(parent)) return isAnchor(process) ? undefined : 'detached';
    if (isAnchor(parent)) return 'agent-cli';
    const grandparent = byPid.get(parent.ppid);
    return isAgent(grandparent) && isAnchor(grandparent) ? 'command' : undefined;
  };
  let best;
  for (const candidate of processes) {
    const tier = tierOf(candidate);
    if (tier === undefined || protectedPids.has(candidate.pid)) continue;
    const tree = [candidate, ...descendantsOf(candidate.pid, processes)];
    if (tree.some((process) => protectedPids.has(process.pid))) continue;
    const treeRssBytes = tree.reduce((sum, process) => sum + process.rssBytes, 0);
    if (treeRssBytes < MINIMUM_VICTIM_RSS_BYTES) continue;
    const rank = tier === 'agent-cli' ? 0 : 1;
    if (
      best === undefined ||
      rank > best.rank ||
      (rank === best.rank &&
        (treeRssBytes > best.victim.treeRssBytes ||
          (treeRssBytes === best.victim.treeRssBytes && candidate.pid > best.victim.pid)))
    ) {
      best = { rank, victim: { ...candidate, tier, treeRssBytes } };
    }
  }
  return best?.victim;
}

/**
 * Descendants of `pid`, deepest first, so a worker pool dies before the parent
 * that would otherwise respawn it, and so a SIGKILLed parent leaves no orphan
 * still holding the memory the kill was meant to free.
 */
export function descendantsOf(pid, processes) {
  const children = new Map();
  for (const process of processes) {
    const siblings = children.get(process.ppid);
    if (siblings === undefined) children.set(process.ppid, [process]);
    else siblings.push(process);
  }
  const ordered = [];
  const visited = new Set([pid]);
  const visit = (parent) => {
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      visit(child.pid);
      ordered.push(child);
    }
  };
  visit(pid);
  return ordered;
}

function loggableCommand(readFile, pid) {
  const raw = tryRead(readFile, `/proc/${pid}/cmdline`);
  if (raw === undefined) return undefined;
  const command = raw.replaceAll('\0', ' ').trim();
  return command.length > MAX_LOGGED_COMMAND ? `${command.slice(0, MAX_LOGGED_COMMAND)}…` : command;
}

function sessionOf(readLink, pid) {
  try {
    const cwd = readLink(`/proc/${pid}/cwd`);
    const match = /^\/work\/\.verity-sessions\/([^/]+)/u.exec(cwd);
    return match === null ? undefined : match[1];
  } catch {
    return undefined;
  }
}

/**
 * The guard proper. Every dependency on the host is injectable so the decision
 * logic is testable against a synthetic `/proc` and cgroup, with a recorded
 * `kill` rather than a real one.
 */
export function createMemoryGuard(options) {
  const readFile = options.readFile ?? readFsFile;
  const listPids = options.listPids ?? listProcDir;
  const readLink = options.readLink ?? readProcLink;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const env = options.env ?? {};
  const agentUid = options.agentUid ?? DEFAULT_AGENT_UID;
  const protectedPids = new Set(options.protectedPids ?? []);
  const cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';
  const dryRun = options.dryRun === true;
  let cooldownUntil = 0;
  let reserveLogged = false;
  let lastOutcome;

  const signalTree = (victim, descendants) => {
    let signalled = 0;
    for (const target of [...descendants, victim]) {
      // The snapshot is a few milliseconds old and this runs as root: a pid that
      // exited and was reused by infrastructure in between must not be signalled.
      const current = tryRead(readFile, `/proc/${target.pid}/status`);
      const uid = Number.parseInt((parseStatus(current ?? '').Uid ?? '').split(/\s+/)[0] ?? '', 10);
      if (uid !== agentUid) continue;
      try {
        kill(target.pid, 'SIGKILL');
        signalled += 1;
      } catch {
        // Already gone, or reused by a pid the guard may not signal: either way
        // the memory it held is not the guard's problem any more.
      }
    }
    return signalled;
  };

  /** One poll. Returns what happened, for `--once` and for the tests. */
  const tick = () => {
    const ceiling = readMemoryCeiling(readFile, cgroupRoot);
    if (ceiling === undefined) return { outcome: 'no-ceiling' };
    const reserveBytes = resolveReserveBytes(ceiling.limitBytes, env);
    const thresholdBytes = ceiling.limitBytes - reserveBytes;
    if (!reserveLogged) {
      reserveLogged = true;
      log({
        event: 'armed',
        source: ceiling.source,
        limitBytes: ceiling.limitBytes,
        reserveBytes,
        thresholdBytes,
        dryRun,
      });
    }
    if (ceiling.usageBytes < thresholdBytes) {
      lastOutcome = 'below-threshold';
      return { outcome: 'below-threshold', ...ceiling, thresholdBytes };
    }
    if (now() < cooldownUntil) return { outcome: 'cooldown', ...ceiling, thresholdBytes };
    const processes = listProcesses(readFile, listPids);
    const victim = chooseVictim(processes, { agentUid, protectedPids });
    if (victim === undefined) {
      cooldownUntil = now() + KILL_COOLDOWN_MS;
      // Logged once per episode: the log sits on tmpfs charged to this cgroup.
      if (lastOutcome === 'no-candidate')
        return { outcome: 'no-candidate', ...ceiling, thresholdBytes };
      lastOutcome = 'no-candidate';
      log({
        event: 'no-candidate',
        usageBytes: ceiling.usageBytes,
        limitBytes: ceiling.limitBytes,
        thresholdBytes,
      });
      return { outcome: 'no-candidate', ...ceiling, thresholdBytes };
    }
    const descendants = descendantsOf(victim.pid, processes);
    const signalled = dryRun ? 0 : signalTree(victim, descendants);
    cooldownUntil = now() + KILL_COOLDOWN_MS;
    lastOutcome = 'kill';
    log({
      event: dryRun ? 'would-kill' : 'kill',
      usageBytes: ceiling.usageBytes,
      limitBytes: ceiling.limitBytes,
      thresholdBytes,
      pid: victim.pid,
      uid: victim.uid,
      tier: victim.tier,
      treeRssBytes: victim.treeRssBytes,
      name: victim.name,
      command: loggableCommand(readFile, victim.pid),
      session: sessionOf(readLink, victim.pid),
      descendants: descendants.map((process) => process.pid),
      signalled,
    });
    return { outcome: dryRun ? 'would-kill' : 'kill', ...ceiling, thresholdBytes, victim };
  };

  return { tick };
}

function statStartTime(readFile, pid) {
  const stat = tryRead(readFile, `/proc/${pid}/stat`);
  if (stat === undefined) return '';
  const end = stat.lastIndexOf(')');
  if (end < 0) return '';
  return (
    stat
      .slice(end + 1)
      .trim()
      .split(/\s+/)[19] ?? ''
  );
}

/**
 * Whether the pid file names a live guard: same pid, same start time (the fence
 * against pid reuse), and a command line that is this program's.
 */
export function probeMemoryGuard(controlDir, readFile = readFsFile) {
  const record = tryRead(readFile, join(controlDir, PID_FILE_NAME));
  if (record === undefined) return false;
  const [pidText, startTime] = record.trim().split(/\s+/);
  if (pidText === undefined || !/^\d+$/u.test(pidText) || !startTime) return false;
  const pid = Number.parseInt(pidText, 10);
  if (statStartTime(readFile, pid) !== startTime) return false;
  const command = tryRead(readFile, `/proc/${pid}/cmdline`);
  return command !== undefined && command.includes('verity-memory-guard');
}

/**
 * Claim the pid file before the first poll, exclusively, so two overlapping
 * stack passes cannot both start a guard that kills on its own cooldown. A file
 * left by a guard that is no longer running is replaced once; losing that
 * second race means another guard just claimed it.
 */
function claimPidFile(controlDir) {
  const path = join(controlDir, PID_FILE_NAME);
  const record = `${process.pid} ${statStartTime(readFsFile, process.pid)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, record, { mode: 0o600, flag: 'wx' });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0 || probeMemoryGuard(controlDir)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

function writeLog(record) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

function main() {
  const flags = new Set(process.argv.slice(2));
  const controlDir = process.env.VERITY_AGENT_BROKER_RUNTIME ?? DEFAULT_CONTROL_DIR;
  if (flags.has('--probe')) {
    process.exit(probeMemoryGuard(controlDir) ? 0 : 1);
  }
  const once = flags.has('--once');
  const dryRun = flags.has('--dry-run');
  const agentUid = Number.parseInt(process.env.VERITY_AGENT_UID ?? '', 10);
  const guard = createMemoryGuard({
    agentUid: Number.isSafeInteger(agentUid) && agentUid > 0 ? agentUid : DEFAULT_AGENT_UID,
    protectedPids: [process.pid, process.ppid],
    env: process.env,
    log: writeLog,
    dryRun,
  });
  if (once) {
    const result = guard.tick();
    writeLog({ event: 'once', ...result, victim: result.victim?.pid });
    process.exit(0);
  }
  if (!claimPidFile(controlDir)) {
    writeLog({ event: 'already-running' });
    process.exit(0);
  }
  const first = guard.tick();
  if (first.outcome === 'no-ceiling') {
    writeLog({ event: 'disabled', reason: 'no finite memory limit is readable' });
    process.exit(0);
  }
  const intervalMs = resolvePollIntervalMs(process.env);
  const timer = setInterval(() => {
    try {
      guard.tick();
    } catch (error) {
      writeLog({ event: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, intervalMs);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
