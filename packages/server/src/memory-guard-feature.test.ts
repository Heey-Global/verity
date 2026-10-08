import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  chooseVictim,
  createMemoryGuard,
  DEFAULT_MINIMUM_RESERVE_BYTES,
  descendantsOf,
  KILL_COOLDOWN_MS,
  REARM_GROWTH_FRACTION,
  listProcesses,
  MINIMUM_VICTIM_RSS_BYTES,
  probeMemoryGuard,
  readMemoryCeiling,
  resolvePollIntervalMs,
  resolveReserveBytes,
  type GuardedProcess,
  type MemoryGuardLogRecord,
} from '../../../features/verity-sandbox-toolkit/bin/verity-memory-guard.mjs';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const reader =
  (files: Record<string, string>) =>
  (path: string): string => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };

/** `/proc/<pid>/status` as the guard reads it: Name, PPid, Uid and VmRSS. */
const status = (name: string, ppid: number, uid: number, rssBytes: number): string =>
  `Name:\t${name}\nPid:\t0\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nVmRSS:\t${Math.floor(rssBytes / 1024)} kB\n`;

/**
 * A synthetic Sandbox: init (root), the spawn broker (root), the supervisor and a
 * worker (Runner uid 1101), an agent CLI under its ACP adapter (uid 1000), the
 * agent's shell running vitest with two workers, and a neighbouring session's
 * eslint. The vitest workers are the largest processes; vitest itself is not.
 */
const sandbox = (): Record<string, string> => ({
  '/proc/1/status': status('docker-init', 0, 0, 2 * MIB),
  '/proc/470/status': status('node', 1, 0, 150 * MIB),
  '/proc/519/status': status('node', 1, 1101, 150 * MIB),
  '/proc/5485/status': status('node', 519, 1101, 160 * MIB),
  '/proc/5574/status': status('node', 470, 1000, 180 * MIB),
  '/proc/5867/status': status('claude', 5574, 1000, 500 * MIB),
  '/proc/6000/status': status('bash', 5867, 1000, 5 * MIB),
  '/proc/6100/status': status('node', 6000, 1000, 470 * MIB),
  '/proc/6101/status': status('node', 6100, 1000, 900 * MIB),
  '/proc/6102/status': status('node', 6100, 1000, 950 * MIB),
  '/proc/7000/status': status('node', 1, 1000, 600 * MIB),
  '/proc/6000/cmdline': 'bash\0-c\0npm test\0',
});

/**
 * `reader` plus what a gVisor guest always has: a kernel version naming gVisor,
 * and a `/proc/<pid>/stat` for every process (start time = pid unless a test
 * sets one). The guard refuses to signal a pid whose start time it cannot read,
 * so a fixture without stats would test a guard that never kills.
 */
const guestReader =
  (files: Record<string, string>) =>
  (path: string): string => {
    if (path === '/proc/version' && files[path] === undefined) {
      return 'Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016\n';
    }
    const statPid = /^\/proc\/(\d+)\/stat$/u.exec(path)?.[1];
    if (statPid !== undefined && files[path] === undefined && files[`/proc/${statPid}/status`]) {
      return `${statPid} (node) S 1 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${statPid} 0 0`;
    }
    return reader(files)(path);
  };

const listPids = (files: Record<string, string>) => (): string[] => [
  'self',
  'sys',
  ...new Set(Object.keys(files).flatMap((path) => /^\/proc\/(\d+)\//u.exec(path)?.[1] ?? [])),
];

describe('readMemoryCeiling', () => {
  it('reads cgroup v1 the way gVisor mounts it, and treats the no-limit sentinel as no ceiling', () => {
    expect(
      readMemoryCeiling(
        reader({
          '/sys/fs/cgroup/memory/memory.limit_in_bytes': '6442450944\n',
          '/sys/fs/cgroup/memory/memory.usage_in_bytes': '1405800448\n',
        }),
      ),
    ).toEqual({ limitBytes: 6 * GIB, usageBytes: 1405800448, source: 'cgroup-v1' });
    // v1 spells "unlimited" as a near-2^63 number, not `max`. Read literally it
    // would arm the guard against an exabyte ceiling it can never reach.
    expect(
      readMemoryCeiling(
        reader({
          '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
          '/sys/fs/cgroup/memory/memory.usage_in_bytes': '1\n',
        }),
      ),
    ).toBeUndefined();
  });

  it('reads cgroup v2 from memory.current, cache included, and no ceiling from `max`', () => {
    // The guard runs only under gVisor, where page cache and tmpfs live in the
    // Sentry's memory file and count against the host limit like anonymous
    // memory. Reading `anon` would understate usage by exactly what kills the
    // Sentry, and the guard would never fire.
    expect(
      readMemoryCeiling(
        reader({
          '/sys/fs/cgroup/memory.max': '4294967296\n',
          '/sys/fs/cgroup/memory.current': '4100000000\n',
          '/sys/fs/cgroup/memory.stat': 'anon 1000000\nfile 3100000000\n',
        }),
      ),
    ).toEqual({ limitBytes: 4 * GIB, usageBytes: 4100000000, source: 'cgroup-v2' });
    expect(
      readMemoryCeiling(
        reader({ '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/memory.current': '5\n' }),
      ),
    ).toBeUndefined();
    expect(readMemoryCeiling(reader({}))).toBeUndefined();
  });
});

describe('resolveReserveBytes', () => {
  it('keeps a fifth of the ceiling free, never less than the Sentry needs, never more than half', () => {
    // 6 GiB: the fifth (1.2 GiB) exceeds the 1 GiB floor and is what applies.
    expect(resolveReserveBytes(6 * GIB)).toBe(Math.floor(6 * GIB * 0.2));
    // 2 GiB: a fifth would be 0.4 GiB, below what the Sentry alone used when it
    // was killed; the floor applies and still leaves half the ceiling to work in.
    expect(resolveReserveBytes(2 * GIB)).toBe(DEFAULT_MINIMUM_RESERVE_BYTES);
    // 1 GiB: the floor would consume everything, so half is the cap.
    expect(resolveReserveBytes(1 * GIB)).toBe(GIB / 2);
  });

  it('honours an explicit reserve only when it parses and lies inside the ceiling', () => {
    expect(resolveReserveBytes(6 * GIB, { VERITY_MEMORY_GUARD_RESERVE_BYTES: '2147483648' })).toBe(
      2 * GIB,
    );
    for (const bad of ['0', '-1', '6442450944', '7000000000', '1g', '', undefined]) {
      expect(resolveReserveBytes(6 * GIB, { VERITY_MEMORY_GUARD_RESERVE_BYTES: bad })).toBe(
        Math.floor(6 * GIB * 0.2),
      );
    }
  });

  it('bounds the poll interval so a typo cannot stop polling or spin the CPU', () => {
    expect(resolvePollIntervalMs({})).toBe(500);
    expect(resolvePollIntervalMs({ VERITY_MEMORY_GUARD_INTERVAL_MS: '250' })).toBe(250);
    expect(resolvePollIntervalMs({ VERITY_MEMORY_GUARD_INTERVAL_MS: '5' })).toBe(500);
    expect(resolvePollIntervalMs({ VERITY_MEMORY_GUARD_INTERVAL_MS: '600000' })).toBe(500);
  });
});

describe('victim selection', () => {
  it('lists processes from /proc/<pid>/status and skips entries that vanish mid-walk', () => {
    const files = sandbox();
    const processes = listProcesses(reader(files), () => [...listPids(files)(), '9999']);
    expect(processes).toHaveLength(11);
    expect(processes.find((p) => p.pid === 6102)).toEqual({
      pid: 6102,
      ppid: 6100,
      uid: 1000,
      rssBytes: 950 * MIB,
      name: 'node',
      startTime: '',
    });
  });

  it('picks the whole command an agent ran, ranked by tree RSS, and never infrastructure', () => {
    const processes = listProcesses(reader(sandbox()), listPids(sandbox()));
    // The largest single process is worker 6102, but a pool respawns a lone
    // worker: killing it frees nothing for long and repeats every cooldown. The
    // unit is the tool shell 6000 with vitest and both workers under it.
    expect(chooseVictim(processes, { agentUid: 1000 })).toMatchObject({
      pid: 6000,
      tier: 'command',
      treeRssBytes: (5 + 470 + 900 + 950) * MIB,
    });
    // Root and the Runner identity hold the spawn broker, supervisor and workers:
    // killing them ends sessions without freeing what a build holds. Make one of
    // them the biggest process in the container and it must still be passed over.
    const inflated: GuardedProcess[] = processes.map((p) =>
      p.pid === 519 ? { ...p, rssBytes: 4 * GIB } : p,
    );
    expect(chooseVictim(inflated, { agentUid: 1000 })?.pid).toBe(6000);
    // A tree holding a protected pid (the guard itself) is skipped;
    // the next unit is the process detached under init.
    expect(
      chooseVictim(processes, { agentUid: 1000, protectedPids: new Set([6102]) }),
    ).toMatchObject({ pid: 7000, tier: 'detached' });
  });

  it('treats init as infrastructure even when it runs as the agent uid', () => {
    // Observed in a project Sandbox: docker-init runs as uid 1000. Read as an agent
    // process it would turn every detached tree into a child of an agent "anchor".
    const files = sandbox();
    files['/proc/1/status'] = status('docker-init', 0, 1000, 2 * MIB);
    const processes = listProcesses(reader(files), listPids(files));
    expect(chooseVictim(processes, { agentUid: 1000 })?.pid).toBe(6000);
    const detachedOnly = processes.filter((p) => ![6000, 6100, 6101, 6102].includes(p.pid));
    expect(chooseVictim(detachedOnly, { agentUid: 1000 })).toMatchObject({
      pid: 7000,
      tier: 'detached',
    });
  });

  it('kills the agent CLI only when it, not a command, holds the memory, and never the adapter', () => {
    const files = sandbox();
    // A 3 GiB CLI over a 2.3 GiB command: the command is less than half of the
    // CLI's tree, so killing it would leave the bulk. The CLI goes, and its whole
    // tree with it — one session lost rather than the container.
    files['/proc/5867/status'] = status('claude', 5574, 1000, 3 * GIB);
    expect(
      chooseVictim(listProcesses(reader(files), listPids(files)), { agentUid: 1000 }),
    ).toMatchObject({ pid: 5867, tier: 'session' });
    // The adapter the broker started is the session's anchor: never a candidate,
    // however large. Its child, the CLI, still is.
    files['/proc/5867/status'] = status('claude', 5574, 1000, 500 * MIB);
    files['/proc/5574/status'] = status('node', 470, 1000, 5 * GIB);
    expect(
      chooseVictim(listProcesses(reader(files), listPids(files)), { agentUid: 1000 })?.pid,
    ).toBe(6000);
  });

  it('takes the largest of several parallel commands rather than their CLI', () => {
    // Two 1.2 GiB builds under a 500 MiB CLI: neither holds half of the CLI's
    // tree, but the CLI is not the consumer either. Killing it would end the
    // session's agent for memory its commands hold.
    const files = sandbox();
    files['/proc/6200/status'] = status('bash', 5867, 1000, 5 * MIB);
    files['/proc/6201/status'] = status('node', 6200, 1000, 1300 * MIB);
    const processes = listProcesses(reader(files), listPids(files));
    expect(chooseVictim(processes, { agentUid: 1000 })).toMatchObject({
      pid: 6000,
      tier: 'command',
    });
  });

  it('leaves an ordinary-sized idle CLI alone, without hiding a smaller real command', () => {
    // After a build, cache can hold usage over the threshold while sessions idle.
    // The largest tree is then an idle CLI; it is no runaway, and killing it would
    // cost a session for memory no kill frees.
    const files = sandbox();
    for (const pid of [6000, 6100, 6101, 6102, 7000]) delete files[`/proc/${pid}/status`];
    const idle = listProcesses(reader(files), listPids(files));
    expect(chooseVictim(idle, { agentUid: 1000, minimumSessionRssBytes: GIB })).toBeUndefined();
    // A larger idle CLI must not mask a smaller session whose command is the
    // consumer: rejecting the first candidate is not a reason to stop looking.
    files['/proc/9000/status'] = status('node', 470, 1000, 150 * MIB);
    files['/proc/9001/status'] = status('claude', 9000, 1000, 200 * MIB);
    files['/proc/9002/status'] = status('bash', 9001, 1000, 300 * MIB);
    const busy = listProcesses(reader(files), listPids(files));
    expect(chooseVictim(busy, { agentUid: 1000, minimumSessionRssBytes: GIB })).toMatchObject({
      pid: 9002,
      tier: 'command',
    });
  });

  it('treats what an adapter runs directly as a command, however it is shaped', () => {
    // codex-acp has no CLI process between it and the tool shell. Read as a CLI,
    // a large command would be spared until it held a whole reserve, and the
    // guard would kill the smaller detached tree, or nothing, instead.
    const files: Record<string, string> = {
      '/proc/1/status': status('docker-init', 0, 1000, 2 * MIB),
      '/proc/470/status': status('node', 1, 0, 150 * MIB),
      '/proc/8000/status': status('codex-acp', 470, 1000, 300 * MIB),
      '/proc/8001/status': status('bash', 8000, 1000, 5 * MIB),
      '/proc/8002/status': status('node', 8001, 1000, 400 * MIB),
      '/proc/8003/status': status('node', 8002, 1000, 900 * MIB),
      '/proc/8004/status': status('node', 8002, 1000, 1000 * MIB),
      '/proc/7000/status': status('node', 1, 1000, 600 * MIB),
    };
    const options = { agentUid: 1000, minimumSessionRssBytes: 1.2 * GIB };
    expect(chooseVictim(listProcesses(reader(files), listPids(files)), options)).toMatchObject({
      pid: 8001,
      tier: 'command',
      treeRssBytes: 2305 * MIB,
    });
    // `bash -c 'node script.js'` execs node: one large process, no children.
    for (const pid of [8001, 8002, 8003, 8004]) delete files[`/proc/${pid}/status`];
    files['/proc/8005/status'] = status('node', 8000, 1000, 900 * MIB);
    expect(chooseVictim(listProcesses(reader(files), listPids(files)), options)).toMatchObject({
      pid: 8005,
      tier: 'command',
    });
  });

  it('declines when nothing agent-owned is large enough to matter', () => {
    const small: GuardedProcess[] = [
      {
        pid: 2,
        ppid: 1,
        uid: 1000,
        rssBytes: MINIMUM_VICTIM_RSS_BYTES - 1,
        name: 'sleep',
        startTime: '2',
      },
      { pid: 3, ppid: 1, uid: 0, rssBytes: 2 * GIB, name: 'node', startTime: '3' },
    ];
    expect(chooseVictim(small, { agentUid: 1000 })).toBeUndefined();
  });

  it('walks descendants deepest first', () => {
    const processes = listProcesses(reader(sandbox()), listPids(sandbox()));
    expect(descendantsOf(5867, processes).map((p) => p.pid)).toEqual([6101, 6102, 6100, 6000]);
    expect(descendantsOf(6102, processes)).toEqual([]);
  });
});

describe('createMemoryGuard', () => {
  const cgroup = (usageBytes: number): Record<string, string> => ({
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${6 * GIB}\n`,
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${usageBytes}\n`,
  });

  const guardAt = (usageBytes: number, extra: { dryRun?: boolean; now?: () => number } = {}) => {
    const files = { ...sandbox(), ...cgroup(usageBytes) };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const log = vi.fn<(record: MemoryGuardLogRecord) => void>();
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: (path) =>
        path === '/proc/6000/cwd' ? '/work/.verity-sessions/agent-a/packages/server' : '/',
      kill,
      log,
      agentUid: 1000,
      now: extra.now ?? (() => 0),
      ...(extra.dryRun === undefined ? {} : { dryRun: extra.dryRun }),
    });
    return { guard, kill, log };
  };

  it('does nothing below the threshold, which sits a reserve below the ceiling', () => {
    const { guard, kill, log } = guardAt(4.5 * GIB);
    expect(guard.tick()).toMatchObject({
      outcome: 'below-threshold',
      thresholdBytes: 6 * GIB - Math.floor(6 * GIB * 0.2),
    });
    expect(kill).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([record]) => record.event)).toEqual(['armed']);
  });

  it('freezes the chosen tree top-down, then SIGKILLs it, once usage reaches the threshold', () => {
    const { guard, kill, log } = guardAt(5.5 * GIB);
    const result = guard.tick();
    expect(result.outcome).toBe('kill');
    expect(result.victim?.pid).toBe(6000);
    // Stopped parents fork nothing, so no worker is respawned between the kills
    // and no late child escapes as a new detached tree.
    expect(kill.mock.calls).toEqual(
      ['SIGSTOP', 'SIGKILL'].flatMap((signal) =>
        [6000, 6100, 6102, 6101].map((pid) => [pid, signal]),
      ),
    );
    const record = log.mock.calls.map(([r]) => r).find((r) => r.event === 'kill');
    // What the operator needs to attribute the kill: which session, which command,
    // and that the guard — not the kernel — is what the exit 137 came from.
    expect(record).toMatchObject({
      pid: 6000,
      uid: 1000,
      tier: 'command',
      treeRssBytes: (5 + 470 + 900 + 950) * MIB,
      session: 'agent-a',
      command: 'bash -c npm test',
      signalled: 4,
    });
  });

  it('also stops and kills a child forked after the snapshot', () => {
    const files = { ...sandbox(), ...cgroup(5.5 * GIB) };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>((pid, signal) => {
      // vitest respawns a worker in the moment before it is stopped.
      if (pid === 6000 && signal === 'SIGSTOP') {
        files['/proc/6103/status'] = status('node', 6100, 1000, 100 * MIB);
      }
    });
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => 0,
    });
    guard.tick();
    expect(kill).toHaveBeenCalledWith(6103, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(6103, 'SIGKILL');
  });

  it('kills every process it stopped, even one whose status became unreadable', () => {
    // A process left in SIGSTOP hangs its session for good; the start time alone
    // still fences against pid reuse.
    const files = { ...sandbox(), ...cgroup(5.5 * GIB) };
    files['/proc/6101/stat'] = '6101 (node) S 1 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 6101 0 0';
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>((pid, signal) => {
      if (pid === 6101 && signal === 'SIGSTOP') delete files['/proc/6101/status'];
    });
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => 0,
    });
    guard.tick();
    expect(kill).toHaveBeenCalledWith(6101, 'SIGKILL');
  });

  it('fences on the start time the snapshot saw, not one read at signal time', () => {
    // Worker 6101 exits and its pid goes to another session's process right after
    // the listing. Reading the start time only when signalling would adopt the
    // newcomer's and let the root guard stop and kill it.
    const files = { ...sandbox(), ...cgroup(5.5 * GIB) };
    const base = guestReader(files);
    let reads = 0;
    const readFile = (path: string): string => {
      if (path !== '/proc/6101/stat') return base(path);
      reads += 1;
      return `6101 (node) S 1 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${reads === 1 ? 100 : 200} 0 0`;
    };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const guard = createMemoryGuard({
      readFile,
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => 0,
    });
    expect(guard.tick().outcome).toBe('kill');
    expect(kill.mock.calls.some(([pid]) => pid === 6101)).toBe(false);
    expect(kill).toHaveBeenCalledWith(6000, 'SIGKILL');
  });

  it('never signals a pid reused by infrastructure or by another session', () => {
    const files = { ...sandbox(), ...cgroup(5.5 * GIB) };
    const stat = (startTime: number): string =>
      `0 (node) S 1 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 0 0`;
    files['/proc/6101/stat'] = stat(100);
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>((pid, signal) => {
      if (pid === 6000 && signal === 'SIGSTOP') {
        // Between the snapshot and the next signal, vitest exits and its pid is
        // reused by a root process; worker 6101 exits and its pid goes to another
        // session's agent process — same uid, different start time.
        files['/proc/6100/status'] = status('node', 470, 0, 470 * MIB);
        files['/proc/6101/stat'] = stat(200);
      }
      if (pid === 6102) throw new Error('ESRCH');
    });
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => 0,
    });
    expect(guard.tick().outcome).toBe('kill');
    const signalled = new Set(kill.mock.calls.map(([pid]) => pid));
    expect(signalled.has(6100)).toBe(false);
    expect(signalled.has(6101)).toBe(false);
    expect(kill).toHaveBeenCalledWith(6000, 'SIGKILL');
  });

  it('waits out a cooldown, and kills again only after an effective kill', () => {
    let clock = 0;
    const files = { ...sandbox(), ...cgroup(5.5 * GIB) };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => clock,
    });
    const kills = () => kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL').length;
    expect(guard.tick().outcome).toBe('kill');
    clock = KILL_COOLDOWN_MS - 1;
    expect(guard.tick().outcome).toBe('cooldown');
    expect(kills()).toBe(4);
    // The kill freed its tree; later the project grows back over the threshold.
    Object.assign(files, cgroup(3.5 * GIB));
    clock = KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('below-threshold');
    Object.assign(files, cgroup(5.5 * GIB));
    expect(guard.tick().outcome).toBe('kill');
    expect(kills()).toBe(8);
  });

  it('stands down when a kill freed nothing, instead of taking one session after another', () => {
    // On cgroup v1 the usage counts page cache and tmpfs files, which no kill
    // frees. Left alone the guard would kill on every cooldown, or on every
    // expiry of a timer, and work through the sessions one by one: the
    // project-wide outage it exists to prevent, by its own hand.
    let clock = 0;
    const files = { ...sandbox(), ...cgroup(5 * GIB) };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const log = vi.fn<(record: MemoryGuardLogRecord) => void>();
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      log,
      agentUid: 1000,
      now: () => clock,
    });
    const kills = () => kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL').length;
    expect(guard.tick().outcome).toBe('kill');
    clock = KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('suspended');
    // No timer re-arms it: an hour at the same usage kills nothing more.
    clock = 3_600_000;
    expect(guard.tick().outcome).toBe('suspended');
    expect(kills()).toBe(4);
    expect(log.mock.calls.map(([r]) => r.event)).toEqual(['armed', 'kill', 'suspended']);
    // Growth past the suspension point by a share of the reserve is process memory
    // rising again, and re-arms it — once per step, so kills stay bounded.
    const step = Math.floor(6 * GIB * 0.2) * REARM_GROWTH_FRACTION;
    Object.assign(files, cgroup(5 * GIB + step - 1));
    expect(guard.tick().outcome).toBe('suspended');
    Object.assign(files, cgroup(5 * GIB + step));
    expect(guard.tick().outcome).toBe('kill');
    expect(kills()).toBe(8);
  });

  it('stands down under runc, where the kernel already picks one process', () => {
    const files = { ...sandbox(), ...cgroup(5.9 * GIB), '/proc/version': 'Linux version 6.8.0\n' };
    const kill = vi.fn();
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => 0,
    });
    expect(guard.tick()).toEqual({ outcome: 'not-gvisor' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('never signals a process whose start time it cannot read', () => {
    // An empty start time would compare equal to another empty one and let a
    // reused pid through: the fence has to fail closed.
    const files = { ...sandbox(), ...cgroup(5.5 * GIB), '/proc/6101/stat': '' };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => 0,
    });
    expect(guard.tick().outcome).toBe('kill');
    expect(kill.mock.calls.some(([pid]) => pid === 6101)).toBe(false);
    expect(kill).toHaveBeenCalledWith(6000, 'SIGKILL');
  });

  it('stands down when usage stays over the threshold after a kill that did free its tree', () => {
    // Cache holds usage just above the threshold. Each small command killed frees
    // what it held, so a "did it free enough" test passes every time — and every
    // build in the project would die, one per cooldown, under a real ceiling it
    // would have fit beneath.
    let clock = 0;
    const threshold = 6 * GIB - Math.floor(6 * GIB * 0.2);
    // A small build: the shell and a 195 MiB node process, nothing else running.
    const files = { ...sandbox(), ...cgroup(threshold + 300 * MIB) };
    for (const pid of [6101, 6102, 7000]) delete files[`/proc/${pid}/status`];
    files['/proc/6100/status'] = status('node', 6000, 1000, 195 * MIB);
    files['/proc/5867/status'] = status('claude', 5574, 1000, 100 * MIB);
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => clock,
    });
    expect(guard.tick().outcome).toBe('kill');
    // The kill freed all 200 MiB the tree held — yet usage is still above, held
    // by cache the guard cannot reach. Another kill would cure nothing either.
    Object.assign(files, cgroup(threshold + 100 * MIB));
    clock = KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('suspended');
    expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(2);
  });

  it('re-arms before the ceiling even when suspended close to it, but only on growth', () => {
    // Suspended 200 MiB below a 6 GiB ceiling, a full growth step would only be
    // reached past the limit: the host would kill the Sandbox with the guard idle.
    // Re-arming without growth instead would kill once per cooldown for as long
    // as cache holds usage there — through every command in the project.
    let clock = 0;
    const files = { ...sandbox(), ...cgroup(6 * GIB - 200 * MIB) };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => clock,
    });
    const kills = () => kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL').length;
    expect(guard.tick().outcome).toBe('kill');
    clock = KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('suspended');
    clock += 3_600_000;
    expect(guard.tick().outcome).toBe('suspended');
    // Half the remaining room is growth, and re-arms it below the ceiling.
    Object.assign(files, cgroup(6 * GIB - 100 * MIB));
    expect(guard.tick().outcome).toBe('kill');
    expect(kills()).toBe(8);
    // At unchanged usage the next poll after the cooldown suspends again, and
    // stays suspended: no kill without fresh growth.
    clock += KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('suspended');
    clock += KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('suspended');
    clock += 3_600_000;
    expect(guard.tick().outcome).toBe('suspended');
    expect(kills()).toBe(8);
  });

  it('does not judge a kill that signalled nothing', () => {
    // A victim that exited on its own between the snapshot and the signal freed
    // its memory without the guard. Suspending on that would disarm the guard
    // for an episode it never acted in.
    let clock = 0;
    const files = { ...sandbox(), ...cgroup(5.5 * GIB) };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>(() => {
      throw new Error('ESRCH');
    });
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => clock,
    });
    expect(guard.tick().outcome).toBe('kill');
    clock = KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('kill');
  });

  it('only reports in dry-run mode', () => {
    const { guard, kill, log } = guardAt(5.5 * GIB, { dryRun: true });
    expect(guard.tick()).toMatchObject({ outcome: 'would-kill', victim: { pid: 6000 } });
    expect(kill).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([r]) => r.event)).toEqual(['armed', 'would-kill']);
  });

  it('reports no candidate rather than killing infrastructure when only root is large', () => {
    let clock = 0;
    const files: Record<string, string> = {
      ...cgroup(5.9 * GIB),
      '/proc/1/status': status('docker-init', 0, 0, 2 * MIB),
      '/proc/470/status': status('node', 1, 0, 5 * GIB),
    };
    const kill = vi.fn();
    const log = vi.fn<(record: MemoryGuardLogRecord) => void>();
    const guard = createMemoryGuard({
      readFile: guestReader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      log,
      agentUid: 1000,
      now: () => clock,
    });
    expect(guard.tick().outcome).toBe('no-candidate');
    // Logged once per episode, not every cooldown: the log is on tmpfs charged to
    // the very cgroup that is already at its threshold.
    clock = 10 * KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('no-candidate');
    expect(kill).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([r]) => r.event)).toEqual(['armed', 'no-candidate']);
  });

  it('stands down without a readable finite ceiling', () => {
    const guard = createMemoryGuard({ readFile: reader({}), listPids: () => [], kill: vi.fn() });
    expect(guard.tick()).toEqual({ outcome: 'no-ceiling' });
  });
});

describe('probeMemoryGuard', () => {
  const stat = (startTime: number): string =>
    `4242 (node) S 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 0 0`;

  it('accepts only a live pid with the recorded start time running this program', () => {
    const live = {
      '/run/ctl/memory-guard.pid': '4242 777\n',
      '/proc/4242/stat': stat(777),
      '/proc/4242/cmdline': 'node\0/usr/local/bin/verity-memory-guard\0',
    };
    expect(probeMemoryGuard('/run/ctl', reader(live))).toBe(true);
    // The pid was reused by something else: the fence is the start time.
    expect(probeMemoryGuard('/run/ctl', reader({ ...live, '/proc/4242/stat': stat(778) }))).toBe(
      false,
    );
    expect(
      probeMemoryGuard('/run/ctl', reader({ ...live, '/proc/4242/cmdline': 'node\0vitest\0' })),
    ).toBe(false);
    expect(probeMemoryGuard('/run/ctl', reader({}))).toBe(false);
  });
});

describe('Sandbox wiring', () => {
  // The guard only helps if the image installs it and the root stack pass starts
  // it. Both are shell scripts outside any import graph, so the silent failure is
  // a guard that exists in the repository and never runs in a container.
  it('is installed next to the Runner stack and started by the root stack pass', async () => {
    const [installer, stackLauncher] = await Promise.all([
      readFile(
        new URL('../../../features/verity-sandbox-toolkit/install.sh', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL(
          '../../../features/verity-sandbox-toolkit/bin/verity-runner-stack-start',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
    expect(installer).toContain('/usr/local/bin/verity-memory-guard');
    expect(stackLauncher).toContain('verity-memory-guard --probe');
    expect(stackLauncher).toContain('nohup /usr/local/bin/verity-memory-guard');
    // The guard reaches uid-1000 processes through CAP_KILL, which this root pass
    // holds; it must not be deferred to the unprivileged supervisor launcher.
    expect(stackLauncher.indexOf('nohup /usr/local/bin/verity-memory-guard')).toBeLessThan(
      stackLauncher.indexOf('exec /usr/bin/setpriv'),
    );
    // Opt-out spelled the way the launcher reads it.
    expect(stackLauncher).toContain('VERITY_MEMORY_GUARD:-1');
  });
});
