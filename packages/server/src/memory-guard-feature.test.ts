import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  chooseVictim,
  createMemoryGuard,
  DEFAULT_MINIMUM_RESERVE_BYTES,
  descendantsOf,
  KILL_COOLDOWN_MS,
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

  it('reads cgroup v2 from anon rather than memory.current, and no ceiling from `max`', () => {
    // `memory.current` counts reclaimable page cache and sits near the limit after
    // any build; killing on it would evict a session for memory the kernel can
    // reclaim on its own.
    expect(
      readMemoryCeiling(
        reader({
          '/sys/fs/cgroup/memory.max': '4294967296\n',
          '/sys/fs/cgroup/memory.current': '4100000000\n',
          '/sys/fs/cgroup/memory.stat': 'anon 1000000\nfile 3100000000\n',
        }),
      ),
    ).toEqual({ limitBytes: 4 * GIB, usageBytes: 1000000, source: 'cgroup-v2' });
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
    // A tree holding a protected pid (the guard itself, its parent) is skipped;
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

  it('spares the agent CLI and its adapter while any command qualifies', () => {
    // A large CLI is still not the unit: killing it ends the session's agent
    // instead of failing one command with exit 137.
    const files = sandbox();
    files['/proc/5867/status'] = status('claude', 5574, 1000, 3 * GIB);
    files['/proc/5574/status'] = status('node', 470, 1000, 3 * GIB);
    const processes = listProcesses(reader(files), listPids(files));
    expect(chooseVictim(processes, { agentUid: 1000 })?.pid).toBe(6000);
    // With every command too small to matter, the CLI is the last resort — one
    // session lost rather than the container. The adapter never is.
    const idle = processes.filter((p) => ![6000, 6100, 6101, 6102, 7000].includes(p.pid));
    expect(chooseVictim(idle, { agentUid: 1000 })).toMatchObject({ pid: 5867, tier: 'agent-cli' });
    expect(
      chooseVictim(
        idle.filter((p) => p.pid !== 5867),
        { agentUid: 1000 },
      ),
    ).toBeUndefined();
  });

  it('declines when nothing agent-owned is large enough to matter', () => {
    const small: GuardedProcess[] = [
      { pid: 2, ppid: 1, uid: 1000, rssBytes: MINIMUM_VICTIM_RSS_BYTES - 1, name: 'sleep' },
      { pid: 3, ppid: 1, uid: 0, rssBytes: 2 * GIB, name: 'node' },
    ];
    expect(chooseVictim(small, { agentUid: 1000 })).toBeUndefined();
  });

  it('walks descendants deepest first so a worker pool cannot outlive its parent', () => {
    const processes = listProcesses(reader(sandbox()), listPids(sandbox()));
    // vitest (6100) → workers 6101, 6102. Killing the parent first would leave the
    // workers as orphans still holding the memory the kill was meant to free.
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
      readFile: reader(files),
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

  it('SIGKILLs the chosen command tree, deepest first, once usage reaches the threshold', () => {
    const { guard, kill, log } = guardAt(5.5 * GIB);
    const result = guard.tick();
    expect(result.outcome).toBe('kill');
    expect(result.victim?.pid).toBe(6000);
    // Workers before vitest before the shell: a parent killed first would leave
    // orphans still holding the memory, or respawn what was just killed.
    expect(kill.mock.calls).toEqual([
      [6101, 'SIGKILL'],
      [6102, 'SIGKILL'],
      [6100, 'SIGKILL'],
      [6000, 'SIGKILL'],
    ]);
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

  it('survives targets that are gone and never signals a pid reused by infrastructure', () => {
    const files = { ...sandbox(), ...cgroup(5.5 * GIB) };
    const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>((pid) => {
      if (pid === 6101) {
        // Between the snapshot and the next signal, vitest exits and its pid is
        // reused by a root process. The guard runs as root and could kill it.
        files['/proc/6100/status'] = status('node', 470, 0, 470 * MIB);
      }
      if (pid === 6102) throw new Error('ESRCH');
    });
    const guard = createMemoryGuard({
      readFile: reader(files),
      listPids: listPids(files),
      readLink: () => '/',
      kill,
      agentUid: 1000,
      now: () => 0,
    });
    expect(guard.tick().outcome).toBe('kill');
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([6101, 6102, 6000]);
  });

  it('waits out a cooldown after a kill so freed pages can leave the cgroup before the next one', () => {
    let clock = 0;
    const { guard, kill } = guardAt(5.5 * GIB, { now: () => clock });
    expect(guard.tick().outcome).toBe('kill');
    clock = KILL_COOLDOWN_MS - 1;
    expect(guard.tick().outcome).toBe('cooldown');
    expect(kill).toHaveBeenCalledTimes(4);
    clock = KILL_COOLDOWN_MS;
    expect(guard.tick().outcome).toBe('kill');
    expect(kill).toHaveBeenCalledTimes(8);
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
      readFile: reader(files),
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
      readFile('features/verity-sandbox-toolkit/install.sh', 'utf8'),
      readFile('features/verity-sandbox-toolkit/bin/verity-runner-stack-start', 'utf8'),
    ]);
    expect(installer).toContain('/usr/local/bin/verity-memory-guard');
    expect(stackLauncher).toContain('verity-memory-guard --probe');
    expect(stackLauncher).toContain('nohup /usr/local/bin/verity-memory-guard');
    // The guard reaches uid-1000 processes through CAP_KILL, which this root pass
    // holds; it must not be deferred to the unprivileged supervisor launcher.
    expect(stackLauncher.indexOf('verity-memory-guard')).toBeLessThan(
      stackLauncher.indexOf('exec /usr/bin/setpriv'),
    );
    // Opt-out spelled the way the launcher reads it.
    expect(stackLauncher).toContain('VERITY_MEMORY_GUARD:-1');
  });
});
