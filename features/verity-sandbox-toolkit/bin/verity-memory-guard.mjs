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
 * gVisor mounts by default) or `memory.{max,current}` (cgroup v2, when gVisor
 * is configured to mount it). Usage includes the guest page cache on purpose:
 * under gVisor that cache lives in the Sentry's memory file, which the host
 * charges to the container like any anonymous page. With no readable finite
 * limit, or outside gVisor, the guard exits quietly.
 */

import { readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearInterval, setInterval } from 'node:timers';

const DEFAULT_POLL_INTERVAL_MS = 500;
/** Share of the ceiling kept free for memory the guest cannot see. */
const DEFAULT_RESERVE_FRACTION = 0.2;
/** Never reserve less than this: the Sentry alone exceeded 0.8 GiB when it was killed. */
export const DEFAULT_MINIMUM_RESERVE_BYTES = 1024 ** 3;
/** Time after a kill during which no second kill is attempted; freed pages take a moment to leave the cgroup. */
export const KILL_COOLDOWN_MS = 2_000;
/** Share of the reserve usage must grow by, past a suspension, to re-arm the guard (see `tick`). */
export const REARM_GROWTH_FRACTION = 0.25;
/** Below this RSS a process is not worth killing: it would not free enough to matter and is likely infrastructure. */
export const MINIMUM_VICTIM_RSS_BYTES = 64 * 1024 ** 2;
/**
 * Process names of agent CLIs that sit between an ACP adapter and the commands
 * they run. Only Claude has that layer (`claude-agent-acp` → `claude` → tool
 * shell); `codex-acp` and `opencode acp` are the agent themselves and run
 * commands as their own children. Matched on the `Name:` line of
 * `/proc/<pid>/status`, observed as `claude` for the Claude CLI in a project
 * Sandbox on 2026-10-08. A process can rename itself, so this is a heuristic,
 * not a boundary: a command calling itself `claude` gains only the CLI's higher
 * threshold, not immunity, and a CLI renamed away loses only its narrowing.
 */
const AGENT_CLI_NAMES = new Set(['claude']);
const DEFAULT_AGENT_UID = 1000;
const DEFAULT_CONTROL_DIR = '/run/verity-runner-broker';
const PID_FILE_NAME = 'memory-guard.pid';
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
 * mount never has them. Both versions read the total charge, page cache and
 * tmpfs included: the guard runs only under gVisor, where that memory lives in
 * the Sentry's memory file and the host charges it like any anonymous page.
 */
export function readMemoryCeiling(readFile = readFsFile, cgroupRoot = '/sys/fs/cgroup') {
  const v2Max = tryRead(readFile, join(cgroupRoot, 'memory.max'));
  if (v2Max !== undefined) {
    if (v2Max.trim() === 'max') return undefined;
    const limitBytes = parseBytes(v2Max);
    if (limitBytes === undefined || limitBytes === 0) return undefined;
    const current = tryRead(readFile, join(cgroupRoot, 'memory.current'));
    const usageBytes = current === undefined ? undefined : parseBytes(current);
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
    // Read with the rest of the snapshot: the signal fence compares against it,
    // so a pid reused after this point no longer matches.
    const startTime = statStartTime(readFile, pid);
    processes.push({ pid, ppid, uid, rssBytes, name: fields.Name ?? '', startTime });
  }
  return processes;
}

/**
 * The agent-owned process tree to kill: where the memory is, at the narrowest
 * scope that still holds most of it.
 *
 * Only the agent uid qualifies: root and the Runner identity are the
 * container's infrastructure (init, spawn broker, supervisor, workers, egress
 * connector, this guard), and killing any of them would end sessions without
 * freeing the memory a build holds. Among the agent's processes the unit is a
 * tree, not a single process: a test runner's worker pool respawns a worker
 * killed on its own, so the largest single process is the wrong target.
 *
 * An agent process whose parent is infrastructure other than init is a session
 * anchor — the ACP adapter the spawn broker started — and is never killed. The
 * anchor is recognised by its parent: an adapter orphaned to init by a broker
 * restart becomes a detached tree like any other. An agent process whose parent
 * the guest cannot see (`docker exec`, ppid 0) is an anchor as well. The
 * candidate trees are rooted at an anchor's children and at agent processes
 * detached under init (a backgrounded dev server or database); the largest by
 * summed RSS wins. A tree rooted at an anchor's child that is an agent CLI
 * (`AGENT_CLI_NAMES`) is first narrowed: unless the CLI's own RSS is most of
 * its tree, the guard takes its largest child tree, the command it ran. A
 * runaway `npm test` is thus killed while the CLI survives to report exit 137,
 * also when several commands run at once. The CLI itself goes only when it is
 * where the memory is and its tree holds at least `minimumSessionRssBytes` (the
 * guard passes its reserve): an ordinary CLI is no runaway, and killing it for
 * cache pressure would cost a session for nothing. Any other child of an anchor
 * is a command an adapter ran directly (Codex, OpenCode) and is a candidate
 * with its whole tree, like any command.
 *
 * Trees below `MINIMUM_VICTIM_RSS_BYTES` are not worth killing. Ties go to the
 * higher pid, the younger tree.
 */
export function chooseVictim(
  processes,
  { agentUid, protectedPids = new Set(), minimumSessionRssBytes = MINIMUM_VICTIM_RSS_BYTES },
) {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const isAgent = (process) =>
    process !== undefined && process.uid === agentUid && process.pid !== 1;
  const isAnchor = (process) => {
    if (!isAgent(process)) return false;
    // A parent the guest cannot see — ppid 0, as for anything `docker exec`
    // started — is infrastructure too: the Server runs its own commands that way.
    const parent = byPid.get(process.ppid);
    return process.ppid !== 1 && (parent === undefined || !isAgent(parent));
  };
  const treeOf = (process) => {
    const tree = [process, ...descendantsOf(process.pid, processes)];
    if (tree.some((member) => protectedPids.has(member.pid))) return undefined;
    return tree.reduce((sum, member) => sum + member.rssBytes, 0);
  };
  const larger = (a, b) =>
    b === undefined ||
    a.treeRssBytes > b.treeRssBytes ||
    (a.treeRssBytes === b.treeRssBytes && a.pid > b.pid);

  // A session tree resolves to the command holding its memory, or to the CLI
  // when the CLI itself is the consumer. The CLI is that only when its own RSS
  // is most of its tree; otherwise its commands are, even when no single one
  // holds a majority — two parallel builds must not cost the session its agent.
  // A CLI of ordinary size is not a runaway either: with nothing larger to
  // blame, the pressure is likely cache or tmpfs, which no kill cures.
  const resolveSession = (cli, treeRssBytes) => {
    // Not a CLI: a command an adapter ran directly, killable like any other.
    if (!AGENT_CLI_NAMES.has(cli.name)) return { ...cli, tier: 'command', treeRssBytes };
    if (cli.rssBytes * 2 > treeRssBytes) {
      return treeRssBytes >= minimumSessionRssBytes
        ? { ...cli, tier: 'session', treeRssBytes }
        : undefined;
    }
    let largestChild;
    for (const child of processes) {
      if (child.ppid !== cli.pid || !isAgent(child)) continue;
      const childRssBytes = treeOf(child);
      if (childRssBytes === undefined) continue;
      const scored = { ...child, tier: 'command', treeRssBytes: childRssBytes };
      if (larger(scored, largestChild)) largestChild = scored;
    }
    if (largestChild !== undefined && largestChild.treeRssBytes >= MINIMUM_VICTIM_RSS_BYTES) {
      return largestChild;
    }
    // Memory spread over many small commands: none is worth killing alone, so
    // the CLI's whole tree is the unit, under the same bar as the CLI itself.
    return treeRssBytes >= minimumSessionRssBytes
      ? { ...cli, tier: 'session', treeRssBytes }
      : undefined;
  };

  let best;
  for (const candidate of processes) {
    if (!isAgent(candidate) || isAnchor(candidate)) continue;
    const parent = byPid.get(candidate.ppid);
    const tier = isAnchor(parent) ? 'session' : isAgent(parent) ? undefined : 'detached';
    if (tier === undefined) continue;
    const treeRssBytes = treeOf(candidate);
    if (treeRssBytes === undefined) continue;
    const victim =
      tier === 'session'
        ? resolveSession(candidate, treeRssBytes)
        : { ...candidate, tier, treeRssBytes };
    // A root whose start time could not be read can never pass the signal
    // fence; chosen anyway, it would be picked every cooldown and never hit.
    if (victim === undefined || victim.startTime === '') continue;
    if (victim.treeRssBytes < MINIMUM_VICTIM_RSS_BYTES) continue;
    if (larger(victim, best)) best = victim;
  }
  return best;
}

/** Descendants of `pid`, deepest first. */
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

  /**
   * A pid the guard may signal: still the agent's, and still the process the
   * snapshot saw. The guard runs as root, and a pid that exited and was reused
   * in between — by infrastructure or by another session — must not be hit.
   */
  const stillTarget = (pid, startTime) => {
    const uid = Number.parseInt(
      (parseStatus(tryRead(readFile, `/proc/${pid}/status`) ?? '').Uid ?? '').split(/\s+/)[0] ?? '',
      10,
    );
    return uid === agentUid && startTime !== '' && statStartTime(readFile, pid) === startTime;
  };

  /** Signals every target that passes `fence`; returns the pids it reached. */
  const send = (targets, signal, fence) => {
    const delivered = new Set();
    for (const [pid, startTime] of targets) {
      if (!fence(pid, startTime)) continue;
      try {
        kill(pid, signal);
        delivered.add(pid);
      } catch {
        // Already gone: the memory it held is not the guard's problem any more.
      }
    }
    return delivered;
  };

  /**
   * Freeze the tree top-down, then kill it. Killing workers while their parent
   * still runs gives a pool the moment it needs to respawn them, and a child
   * forked after the snapshot would survive as a new detached tree. Stopped
   * parents fork nothing, so a second walk after the freeze catches every child
   * that appeared in between.
   */
  const signalTree = (victim, descendants) => {
    const topDown = (processes) =>
      [...processes].reverse().map((process) => [process.pid, process.startTime]);
    const targets = new Map(topDown([...descendants, victim]));
    const stopped = send(targets, 'SIGSTOP', stillTarget);
    const late = topDown(descendantsOf(victim.pid, listProcesses(readFile, listPids))).filter(
      ([pid]) => !targets.has(pid),
    );
    for (const pid of send(late, 'SIGSTOP', stillTarget)) stopped.add(pid);
    for (const [pid, startTime] of late) targets.set(pid, startTime);
    // A process this pass stopped is killed on the start-time fence alone: left
    // stopped because its status became unreadable, it would hang its session.
    return send(targets, 'SIGKILL', (pid, startTime) =>
      stopped.has(pid)
        ? startTime !== '' && statStartTime(readFile, pid) === startTime
        : stillTarget(pid, startTime),
    ).size;
  };

  /**
   * One kill per episode, then evidence before the next. If usage is still at
   * or above the threshold once the cooldown after a kill has passed, what keeps
   * the cgroup full is not something that kill could reach — page cache, tmpfs
   * files, the Sentry, another session's steady load — and killing on every
   * cooldown would fail one command after another, each of which "freed what it
   * held" without bringing usage down. So the guard stands down until usage
   * drops below the threshold, or until it grows by another
   * `REARM_GROWTH_FRACTION` of the reserve past where it was suspended: growth is
   * the one sign that process memory is rising again, and a timer would only
   * space out the kills it should stop. Each re-arm needs fresh growth, so
   * between the threshold and the ceiling the guard kills a bounded number of
   * times.
   */
  let lastKill;
  let suspendedAtBytes;

  /** One poll. Returns what happened, for `--once` and for the tests. */
  const tick = () => {
    const ceiling = readMemoryCeiling(readFile, cgroupRoot);
    if (ceiling === undefined) return { outcome: 'no-ceiling' };
    // Under runc the kernel already picks one process at the ceiling and the
    // container survives; a guard there would only kill builds a reserve early.
    if (!runsUnderGvisor(readFile)) return { outcome: 'not-gvisor' };
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
    const result = (outcome, extra = {}) => ({ outcome, ...ceiling, thresholdBytes, ...extra });
    if (ceiling.usageBytes < thresholdBytes) {
      lastOutcome = 'below-threshold';
      lastKill = undefined;
      suspendedAtBytes = undefined;
      return result('below-threshold');
    }
    if (now() < cooldownUntil) return result('cooldown');
    if (suspendedAtBytes !== undefined) {
      // Never past the ceiling: a suspension that began close to it would
      // otherwise ask for growth beyond the limit, and the guard would sit
      // disarmed through the very kill it exists to prevent. Never without
      // growth either: half the remaining room is still growth, so kills stay
      // bounded however close to the ceiling the suspension began.
      const step = reserveBytes * REARM_GROWTH_FRACTION;
      const rearmAtBytes =
        suspendedAtBytes + Math.min(step, (ceiling.limitBytes - suspendedAtBytes) / 2);
      if (ceiling.usageBytes < rearmAtBytes) {
        return result('suspended');
      }
      suspendedAtBytes = undefined;
      lastKill = undefined;
    }
    if (lastKill !== undefined) {
      suspendedAtBytes = ceiling.usageBytes;
      log({
        event: 'suspended',
        reason:
          'usage stayed above the threshold after a kill; what fills the cgroup is not what a kill reaches',
        usageBytes: ceiling.usageBytes,
        usageAtKillBytes: lastKill.usageBytes,
        victimTreeRssBytes: lastKill.treeRssBytes,
        limitBytes: ceiling.limitBytes,
        thresholdBytes,
      });
      return result('suspended');
    }
    const processes = listProcesses(readFile, listPids);
    const victim = chooseVictim(processes, {
      agentUid,
      protectedPids,
      minimumSessionRssBytes: reserveBytes,
    });
    if (victim === undefined) {
      cooldownUntil = now() + KILL_COOLDOWN_MS;
      // Logged once per episode: the log sits on tmpfs charged to this cgroup.
      if (lastOutcome !== 'no-candidate') {
        log({
          event: 'no-candidate',
          usageBytes: ceiling.usageBytes,
          limitBytes: ceiling.limitBytes,
          thresholdBytes,
        });
      }
      lastOutcome = 'no-candidate';
      return result('no-candidate');
    }
    const descendants = descendantsOf(victim.pid, processes);
    // Read before the kill: a killed process is a zombie or gone, with no
    // command line and no working directory left to attribute it by.
    const command = loggableCommand(readFile, victim.pid);
    const session = sessionOf(readLink, victim.pid);
    const signalled = dryRun ? 0 : signalTree(victim, descendants);
    cooldownUntil = now() + KILL_COOLDOWN_MS;
    lastOutcome = 'kill';
    if (signalled > 0) {
      lastKill = { usageBytes: ceiling.usageBytes, treeRssBytes: victim.treeRssBytes };
    }
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
      command,
      session,
      descendants: descendants.map((process) => process.pid),
      signalled,
    });
    return result(dryRun ? 'would-kill' : 'kill', { victim });
  };

  return { tick };
}

/** gVisor names itself in the kernel version it reports, e.g. `4.19.0-gvisor`. */
function runsUnderGvisor(readFile = readFsFile) {
  return /gvisor/iu.test(tryRead(readFile, '/proc/version') ?? '');
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
 * left by a guard that is no longer running is replaced once. That replacement
 * can race with another launcher's; the loser notices on its next poll that the
 * file no longer holds the record it wrote, which this returns, and exits (see
 * `main`). Returns `undefined` when another guard holds the claim.
 */
function claimPidFile(controlDir) {
  const path = join(controlDir, PID_FILE_NAME);
  const record = `${process.pid} ${statStartTime(readFsFile, process.pid)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, record, { mode: 0o600, flag: 'wx' });
      return record;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt > 0 || probeMemoryGuard(controlDir)) return undefined;
      // `wx` creates the file before it writes the record: an empty or partial
      // record is another guard mid-claim, not a stale one, unless it has stayed
      // that way long enough that its writer cannot still be alive.
      const existing = tryRead(readFsFile, path) ?? '';
      let ageMs;
      try {
        ageMs = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // removed by a competing launcher in between: try to claim it
      }
      if (!/^\d+ \d+\n$/u.test(existing) && ageMs < 10_000) return undefined;
      rmSync(path, { force: true });
    }
  }
  return undefined;
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
    protectedPids: [process.pid],
    env: process.env,
    log: writeLog,
    dryRun,
  });
  if (once) {
    const result = guard.tick();
    writeLog({ event: 'once', ...result, victim: result.victim?.pid });
    process.exit(0);
  }
  const ownRecord = claimPidFile(controlDir);
  if (ownRecord === undefined) {
    writeLog({ event: 'already-running' });
    process.exit(0);
  }
  let first;
  try {
    first = guard.tick();
  } catch (error) {
    writeLog({ event: 'error', message: error instanceof Error ? error.message : String(error) });
    first = { outcome: 'error' };
  }
  if (first.outcome === 'no-ceiling' || first.outcome === 'not-gvisor') {
    writeLog({
      event: 'disabled',
      reason:
        first.outcome === 'no-ceiling'
          ? 'no finite memory limit is readable'
          : 'not running under gVisor; the kernel OOM killer picks one process',
    });
    rmSync(join(controlDir, PID_FILE_NAME), { force: true });
    process.exit(0);
  }
  const intervalMs = resolvePollIntervalMs(process.env);
  let lastError;
  const timer = setInterval(() => {
    // Replacing a stale pid file is not atomic across two launchers; the one
    // whose record is no longer in the file steps aside within a poll.
    if (tryRead(readFsFile, join(controlDir, PID_FILE_NAME)) !== ownRecord) {
      writeLog({ event: 'superseded' });
      process.exit(0);
    }
    try {
      guard.tick();
      lastError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Once per run of identical failures: the log is on tmpfs in this cgroup.
      if (message !== lastError) writeLog({ event: 'error', message });
      lastError = message;
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
