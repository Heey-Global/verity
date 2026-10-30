import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BuildStorage,
  buildStoragePolicy,
  estimateBuildStorageBytes,
  remoteOperationEnded,
} from './build-storage.js';

const GiB = 1024 ** 3;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'build-storage-test-'));
  directories.push(directory);
  const root = join(directory, 'owned');
  const report = join(directory, 'storage.json');
  const policy = { estimateBytes: 8 * GiB, reserveBytes: 2 * GiB, reserveInodes: 1000 };
  const local = { availableBytes: 100 * GiB, freeInodes: 100_000 };
  const writeReport = (availableBytes = 100 * GiB, freeInodes = 100_000, age = 0) => {
    writeFileSync(
      report,
      JSON.stringify({
        schemaVersion: 1,
        hostBootId: '11111111-1111-4111-8111-111111111111',
        hostIdentity: 'a'.repeat(64),
        observedAt: new Date(Date.now() - age).toISOString(),
        roots: ['buildkit', 'docker', 'containerd', 'export', 'project'].map((kind) => ({
          kind,
          state: 'available',
          observedAt: new Date(Date.now() - age).toISOString(),
          filesystemId: 'same-filesystem',
          availableBytes,
          freeInodes,
        })),
      }),
    );
  };
  writeReport();
  return {
    directory,
    root,
    report,
    local,
    policy,
    writeReport,
    manager: () => new BuildStorage(root, report, policy, () => local),
  };
}
const commandOptions = { env: process.env, timeout: 5000, maxBuffer: 1024 * 1024 };

describe('build storage admission', () => {
  it('rejects malformed settings and keeps conservative unknown-build defaults', () => {
    // The default must let an ordinary host build at all: a 306 GiB estimate
    // refused every build with 78 GiB free while the build needed about 15.
    const fallback = buildStoragePolicy({});
    expect(fallback.estimateBytes + fallback.reserveBytes).toBeLessThanOrEqual(64 * GiB);
    expect(fallback.estimateBytes).toBeGreaterThanOrEqual(24 * GiB);
    expect(buildStoragePolicy({ VERITY_BUILD_ESTIMATE_GIB: '42' }).estimateBytes).toBe(42 * GiB);
    // Writing the documented default explicitly must not prevent Server startup.
    const defaults = buildStoragePolicy({});
    expect(
      buildStoragePolicy({ VERITY_BUILD_FREE_INODES: String(defaults.reserveInodes) })
        .reserveInodes,
    ).toBe(defaults.reserveInodes);
    expect(() => buildStoragePolicy({ VERITY_BUILD_FREE_INODES: '1000000000000' })).toThrow(
      'Invalid',
    );
    for (const value of ['0', '-1', '1.5', 'Infinity', '1000000000000', '']) {
      for (const name of [
        'VERITY_BUILD_FREE_GIB',
        'VERITY_BUILD_ESTIMATE_GIB',
        'VERITY_BUILD_FREE_INODES',
      ])
        expect(() => buildStoragePolicy({ [name]: value })).toThrow('Invalid');
    }
  });

  it('sizes measured builds with bounded image allowances and preserves the fallback', () => {
    const policy = buildStoragePolicy({ VERITY_BUILD_ESTIMATE_GIB: '35' });
    expect(estimateBuildStorageBytes(policy, 10 * GiB)).toBe(22 * GiB);
    expect(estimateBuildStorageBytes(policy, 12 * GiB)).toBe(26 * GiB);
    expect(estimateBuildStorageBytes(policy, 1)).toBe(12 * GiB);
    expect(estimateBuildStorageBytes(policy, 100 * GiB)).toBe(96 * GiB);
    for (const size of [undefined, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(estimateBuildStorageBytes(policy, size)).toBe(policy.estimateBytes);
    expect(buildStoragePolicy({}).estimateBytes).toBe(24 * GiB);
  });

  it('uses the measured estimate while retaining byte and inode reserves', () => {
    const f = fixture();
    const lease = f.manager().acquire();
    f.writeReport(23 * GiB);
    expect(() => lease.reserveBuild(10 * GiB)).toThrow(
      'requires 22 GiB estimated growth plus 2 GiB reserve',
    );
    f.writeReport(24 * GiB);
    expect(() => lease.reserveBuild(10 * GiB)).not.toThrow();
    f.writeReport(24 * GiB, 999);
    expect(() => lease.reserveBuild(10 * GiB)).toThrow('free inodes');
    lease.dispose();
  });

  it('reserves before staging and holds one shared slot through import', async () => {
    const f = fixture();
    const manager = f.manager();
    const lease = manager.acquire();
    expect(() => manager.acquire()).toThrow('busy');
    expect(() => f.manager().acquire()).toThrow('recovery');
    lease.reserveBuild();
    expect(
      await lease.run(process.execPath, ['-e', 'console.log("exported")'], commandOptions),
    ).toMatchObject({ stdout: 'exported\n' });
    expect(() => manager.acquire()).toThrow('busy');
    writeFileSync(join(lease.directory, 'image.tar'), 'owned archive');
    const unrelated = join(f.directory, 'project-data');
    writeFileSync(unrelated, 'keep');
    lease.dispose();
    lease.dispose();
    expect(existsSync(lease.directory)).toBe(false);
    expect(readFileSync(unrelated, 'utf8')).toBe('keep');
    manager.acquire().dispose();
  });

  it('does not add free capacity reported by aliases of the same filesystem', () => {
    const f = fixture();
    const lease = f.manager().acquire();
    f.writeReport(9 * GiB);
    expect(() => lease.reserveBuild()).toThrow(
      'requires 8 GiB estimated growth plus 2 GiB reserve',
    );
    lease.dispose();
  });

  it('guards both local staging capacity and host free inodes', () => {
    const f = fixture();
    f.local.availableBytes = 3 * GiB;
    expect(() => f.manager().acquire()).toThrow('admission rejected');
    f.local.availableBytes = 100 * GiB;
    const lease = f.manager().acquire();
    f.writeReport(100 * GiB, 999);
    expect(() => lease.reserveBuild()).toThrow('free inodes');
    lease.dispose();
  });

  it('rejects a measured independent project filesystem that is too full', () => {
    const f = fixture();
    const lease = f.manager().acquire();
    const patched = (patch: Record<string, unknown>) => {
      f.writeReport();
      const report = JSON.parse(readFileSync(f.report, 'utf8')) as {
        roots: { kind: string; filesystemId: string }[];
      };
      const project = report.roots.find((root) => root.kind === 'project')!;
      project.filesystemId = 'independent-project-filesystem';
      Object.assign(project, patch);
      writeFileSync(f.report, JSON.stringify(report));
    };
    for (const patch of [{ availableBytes: 9 * GiB }, { freeInodes: 999 }]) {
      patched(patch);
      expect(() => lease.reserveBuild()).toThrow('admission rejected');
    }
    // Unmeasured is not full: the remaining measured roots decide.
    for (const patch of [
      { state: 'unavailable' },
      { observedAt: new Date(Date.now() - 121_000).toISOString() },
    ]) {
      patched(patch);
      expect(() => lease.reserveBuild()).not.toThrow();
    }
    lease.dispose();
  });

  // A missing reporter or an unconfigured root used to refuse every build on a
  // host with plenty of free space. Gaps are now reported, never a refusal.
  it('admits on partial host evidence, names the gaps and still enforces what was measured', () => {
    const f = fixture();
    const lease = f.manager().acquire();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      rmSync(f.report);
      expect(() => lease.reserveBuild()).not.toThrow();
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('missing or invalid'));
      f.writeReport(100 * GiB, 100_000, 121_000);
      expect(() => lease.reserveBuild()).not.toThrow();
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('stale'));

      f.writeReport(9 * GiB);
      const report = JSON.parse(readFileSync(f.report, 'utf8')) as {
        roots: { kind: string; state: string }[];
      };
      report.roots.find((root) => root.kind === 'containerd')!.state = 'unavailable';
      writeFileSync(f.report, JSON.stringify(report));
      // containerd is a gap, but the measured roots are too full.
      expect(() => lease.reserveBuild()).toThrow('admission rejected');
      expect(warn).toHaveBeenLastCalledWith(
        expect.stringContaining('containerd filesystem is not established'),
      );
      const calls = warn.mock.calls.length;
      expect(() => lease.reserveBuild()).toThrow('admission rejected');
      expect(warn.mock.calls.length).toBe(calls);
    } finally {
      warn.mockRestore();
      lease.dispose();
    }
  });
});

// A second project's build used to fail with "Build storage busy" whenever another
// project was building; it now waits for its turn.
describe('build queue', () => {
  it('serves waiting builds in arrival order instead of refusing them', async () => {
    const f = fixture();
    const storage = f.manager();
    const first = await storage.admitInTurn();
    expect(() => storage.acquire()).toThrow('Build storage busy');
    const order: string[] = [];
    const queued: number[] = [];
    const second = storage
      .admitInTurn((ahead) => queued.push(ahead))
      .then((lease) => {
        order.push('second');
        return lease;
      });
    const third = storage
      .admitInTurn((ahead) => queued.push(ahead))
      .then((lease) => {
        order.push('third');
        return lease;
      });
    expect(queued).toEqual([1, 2]);
    await setTimeout(5);
    expect(order).toEqual([]);
    first.dispose();
    // A newcomer arriving while the turn is handed over still queues behind.
    const fourth = storage.admitInTurn().then((lease) => {
      order.push('fourth');
      return lease;
    });
    (await second).dispose();
    (await third).dispose();
    (await fourth).dispose();
    expect(order).toEqual(['second', 'third', 'fourth']);
    storage.acquire().dispose();
  });

  it('keeps the queue moving when a wait notice throws', async () => {
    const f = fixture();
    const storage = f.manager();
    const first = await storage.admitInTurn();
    const second = storage.admitInTurn(() => {
      throw new Error('notice failed');
    });
    first.dispose();
    (await second).dispose();
    (await storage.admitInTurn()).dispose();
  });

  it('keeps the turn for a woken build against a newcomer', async () => {
    const f = fixture();
    const storage = f.manager();
    const first = await storage.admitInTurn();
    const woken = storage.admitInTurn();
    first.dispose();
    // The queue is empty again, but the turn already belongs to the woken build.
    const newcomer = storage.admitInTurn();
    (await woken).dispose();
    (await newcomer).dispose();
  });

  it('still refuses at once for anything but a busy lease, and frees the turn', async () => {
    const f = fixture();
    const storage = f.manager();
    const first = await storage.admitInTurn();
    f.local.availableBytes = 0;
    const refused = storage.admitInTurn();
    const next = storage.admitInTurn();
    first.dispose();
    // Its turn comes, and a full disk is still an immediate answer, not a wait.
    await expect(refused).rejects.toThrow('Build storage admission rejected');
    // The refused build does not strand the one behind it: that one gets its turn
    // and its own answer.
    await expect(next).rejects.toThrow('Build storage admission rejected');
    f.local.availableBytes = 100 * GiB;
    (await storage.admitInTurn()).dispose();
  });
});

describe('owned attempt recovery and cancellation', () => {
  it('keeps a dead owner reservation while its command group still exists', async () => {
    const f = fixture();
    const abandoned = join(f.root, 'attempt-command');
    mkdirSync(abandoned, { recursive: true });
    writeFileSync(
      join(abandoned, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2147483647,
        start: '0',
        namespace: readlinkSync('/proc/self/ns/pid'),
      }),
    );
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    writeFileSync(join(abandoned, 'child-0'), String(child.pid));
    try {
      // Kept with its files, but no longer a reason to refuse every other build.
      const storage = f.manager();
      storage.acquire().dispose();
      expect(existsSync(abandoned)).toBe(true);
      expect(storage.unresolvedAttempts()).toEqual([
        expect.objectContaining({ attempt: 'attempt-command', reservedBytes: 0 }),
      ]);
    } finally {
      const exited = once(child, 'exit');
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
    }
    f.manager().acquire().dispose();
    expect(existsSync(abandoned)).toBe(false);
  });

  it('supports cancellation without leaving a running command or owned artifact', async () => {
    const f = fixture();
    const lease = f.manager().acquire();
    const controller = new AbortController();
    const pending = lease.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      ...commandOptions,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    lease.dispose();
    expect(existsSync(lease.directory)).toBe(false);
  });

  it('cancels a SIGTERM-resistant command and its descendants promptly', async () => {
    const f = fixture();
    const lease = f.manager().acquire();
    const controller = new AbortController();
    const ready = join(f.directory, 'ready');
    const marker = join(f.directory, 'late-write');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'), 800)`;
    const pending = lease.run(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`,
      ],
      { ...commandOptions, signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toThrow('aborted');
    try {
      await expect.poll(() => existsSync(ready), { timeout: 2000 }).toBe(true);
      controller.abort();
      await rejected;
    } finally {
      controller.abort();
      await pending.catch(() => {});
      lease.dispose();
    }
    await setTimeout(1000);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lease.directory)).toBe(false);
  });

  it('reconciles a positively abandoned attempt, preserving unrecognized directories', () => {
    const f = fixture();
    const abandoned = join(f.root, 'attempt-abandoned');
    mkdirSync(abandoned, { recursive: true });
    writeFileSync(
      join(abandoned, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2147483647,
        start: '0',
        namespace: readlinkSync('/proc/self/ns/pid'),
      }),
    );
    writeFileSync(join(abandoned, 'image.tar'), 'abandoned archive');
    const unrelated = join(f.root, 'project');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'worktree'), 'keep');
    f.manager().acquire().dispose();
    expect(existsSync(abandoned)).toBe(false);
    expect(readFileSync(join(unrelated, 'worktree'), 'utf8')).toBe('keep');
  });

  it('retains ambiguous records and reservations from a different PID namespace', () => {
    const f = fixture();
    const unknown = join(f.root, 'attempt-unknown');
    mkdirSync(unknown, { recursive: true });
    // Retained, but a previous Server's leftovers no longer stop every build.
    f.manager().acquire().dispose();
    expect(existsSync(unknown)).toBe(true);
    writeFileSync(
      join(unknown, 'owner.json'),
      JSON.stringify({ version: 1, pid: 2147483647, start: '0', namespace: 'another-namespace' }),
    );
    const storage = f.manager();
    storage.acquire().dispose();
    expect(existsSync(unknown)).toBe(true);
    expect(storage.unresolvedAttempts()).toEqual([
      expect.objectContaining({
        attempt: 'attempt-unknown',
        reason: expect.stringContaining('previous Server'),
      }),
    ]);
  });

  it('kills descendants on timeout before releasing owned archives', async () => {
    const f = fixture();
    const lease = f.manager().acquire();
    const marker = join(f.directory, 'late-write');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'), 400)`;
    await expect(
      lease.run(
        process.execPath,
        [
          '-e',
          `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); setInterval(() => {}, 1000)`,
        ],
        { ...commandOptions, timeout: 150 },
      ),
    ).rejects.toThrow('timed out');
    lease.dispose();
    await setTimeout(500);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lease.directory)).toBe(false);
  });

  it('stops a command when the reserve is crossed and permits a later attempt', async () => {
    const f = fixture();
    const manager = f.manager();
    const lease = manager.acquire();
    lease.reserveBuild();
    f.local.availableBytes = GiB;
    await expect(
      lease.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], commandOptions),
    ).rejects.toThrow('admission rejected');
    lease.dispose();
    f.local.availableBytes = 100 * GiB;
    manager.acquire().dispose();
  });
});

describe('durable remote operation guard', () => {
  it.each(['timeout', 'abort', 'failure'] as const)(
    'retains reservation and artifacts after remote %s',
    async (reason) => {
      const f = fixture();
      const storage = f.manager();
      const lease = storage.acquire();
      const controller = new AbortController();
      const archive = join(lease.directory, 'image.tar');
      writeFileSync(archive, 'possibly in use remotely');
      const pending = lease.run(
        process.execPath,
        ['-e', reason === 'failure' ? 'process.exit(1)' : 'setInterval(() => {}, 1000)'],
        {
          ...commandOptions,
          timeout: reason === 'timeout' ? 50 : 5000,
          signal: controller.signal,
          remoteOperation: 'image-import',
        },
      );
      if (reason === 'abort') controller.abort();
      await expect(pending).rejects.toThrow();
      lease.dispose();
      expect(readFileSync(archive, 'utf8')).toBe('possibly in use remotely');
      // The ambiguous attempt keeps its files and its estimate; other builds still run.
      const next = storage.acquire();
      expect(storage.unresolvedAttempts()).toEqual([
        expect.objectContaining({ operation: 'image-import', reservedBytes: 8 * GiB }),
      ]);
      next.dispose();
      expect(readFileSync(archive, 'utf8')).toBe('possibly in use remotely');
    },
  );

  it('does not reconcile a crash during remote work from a dead local owner', () => {
    const f = fixture();
    const lease = f.manager().acquire();
    writeFileSync(
      join(lease.directory, 'remote-operation.json'),
      JSON.stringify({
        version: 1,
        operation: 'build-export',
        startedAt: '2000-01-01T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(lease.directory, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2147483647,
        start: '0',
        namespace: readlinkSync('/proc/self/ns/pid'),
      }),
    );
    // The crashed Server's lease is gone; only its files and record remain.
    lease.dispose();
    const storage = f.manager();
    storage.acquire().dispose();
    expect(existsSync(lease.directory)).toBe(true);
    expect(storage.unresolvedAttempts()).toEqual([
      expect.objectContaining({ attempt: lease.directory.slice(f.root.length + 1) }),
    ]);
  });
});

// The record keeps uncertain remote work reserved; one bad measurement in the
// same report must not cost it.
it('keeps the recovery record when only the measurements are malformed', async () => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.report, 'utf8'));
  data.roots = 'not a list';
  writeFileSync(f.report, JSON.stringify(data));
  const lease = f.manager().acquire();
  await expect(
    lease.run('false', [], { ...commandOptions, remoteOperation: 'build-export' }),
  ).rejects.toThrow();
  expect(existsSync(join(lease.directory, 'remote-operation.json'))).toBe(true);
  lease.dispose();
});

it('runs remote work without a recovery record when the host identity is unknown', async () => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.report, 'utf8'));
  delete data.hostIdentity;
  writeFileSync(f.report, JSON.stringify(data));
  const lease = f.manager().acquire();
  const marker = join(f.directory, 'command-started');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await lease.run(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      { ...commandOptions, remoteOperation: 'build-export' },
    );
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(join(lease.directory, 'remote-operation.json'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no host identity'));
  } finally {
    warn.mockRestore();
  }
  lease.dispose();
  expect(existsSync(lease.directory)).toBe(false);
});

describe('host maintenance admission', () => {
  function admission() {
    const f = fixture();
    const gate = join(f.directory, 'gate');
    mkdirSync(join(gate, 'leases'), { recursive: true });
    writeFileSync(join(gate, 'build-admission.lock'), '');
    const manager = new BuildStorage(f.root, f.report, f.policy, () => f.local, gate);
    return { ...f, gate, manager };
  }
  it('holds a shared host lock until disposal and removes only its own marker', async () => {
    const { spawnSync } = await import('node:child_process');
    const { readdirSync } = await import('node:fs');
    const f = admission();
    const lease = f.manager.acquire();
    const tryMaintenance = () =>
      spawnSync('flock', ['-xn', join(f.gate, 'build-admission.lock'), 'true']);
    expect(tryMaintenance().status).toBe(1);
    expect(readdirSync(join(f.gate, 'leases'))).toHaveLength(1);
    lease.dispose();
    expect(tryMaintenance().status).toBe(0);
    expect(readdirSync(join(f.gate, 'leases'))).toHaveLength(0);
  });
  it('refuses admission while recovery is pending and leaves no phantom lease', async () => {
    const { readdirSync } = await import('node:fs');
    const f = admission();
    writeFileSync(join(f.gate, 'migration-pending'), '');
    expect(() => f.manager.acquire()).toThrow('Builder admission unavailable');
    expect(readdirSync(join(f.gate, 'leases'))).toHaveLength(0);
  });
  // Queued behind another build, a host that cannot admit anyone must still answer
  // at once instead of after that build finishes.
  it('refuses a queued build at once while the host cannot admit builds', async () => {
    const f = admission();
    const lease = await f.manager.admitInTurn();
    writeFileSync(join(f.gate, 'migration-pending'), '');
    let settled = false;
    const refused = f.manager.admitInTurn().finally(() => {
      settled = true;
    });
    await expect(refused).rejects.toThrow('Builder admission unavailable');
    expect(settled).toBe(true);
    rmSync(join(f.gate, 'migration-pending'));
    lease.dispose();
    // The refused request left no place in the queue behind.
    (await f.manager.admitInTurn()).dispose();
  });
  // A host whose builder came from an installer before managed admission has
  // neither marker, and no storage report either: requiring them blocked every
  // build on such hosts until the installer was re-run.
  it('builds unmanaged on a host that never provisioned admission', () => {
    const f = fixture();
    const gate = join(f.directory, 'gate');
    // runsc keeps its state here on every builder host; it is not an admission marker.
    mkdirSync(join(gate, 'runsc'), { recursive: true });
    rmSync(f.report);
    const manager = new BuildStorage(f.root, f.report, f.policy, () => f.local, gate);
    const lease = manager.admit();
    expect(lease.directory).toBe(tmpdir());
    expect(() => lease.reserveBuild()).not.toThrow();
    lease.dispose();
    expect(() => manager.acquire()).toThrow('predates managed build admission');
    expect(existsSync(join(gate, 'leases'))).toBe(false);
  });
  // A Repair can provision the host while an unmanaged attempt is still staging.
  // Without a second look, its solve would start without the lock and host
  // maintenance would see no lease and restart the worker underneath it.
  it('takes the host lock for remote work once a Repair provisions mid-attempt', async () => {
    const { spawn, spawnSync } = await import('node:child_process');
    const { readdirSync } = await import('node:fs');
    const f = fixture();
    const gate = join(f.directory, 'gate');
    mkdirSync(gate);
    const manager = new BuildStorage(f.root, f.report, f.policy, () => f.local, gate);
    const lease = manager.admit();
    await lease.run('true', [], commandOptions);
    expect(existsSync(join(gate, 'leases'))).toBe(false);

    mkdirSync(join(gate, 'leases'));
    writeFileSync(join(gate, 'build-admission.lock'), '');
    const lock = join(gate, 'build-admission.lock');
    // Its own process group: the sleeping child inherits the lock and must end too.
    const maintenance = spawn('flock', ['-x', lock, 'sleep', '5'], { detached: true });
    try {
      await setTimeout(200);
      await expect(
        lease.run('true', [], { ...commandOptions, remoteOperation: 'build-export' }),
      ).rejects.toThrow('maintenance is in progress');
    } finally {
      process.kill(-(maintenance.pid ?? 0), 'SIGKILL');
      await once(maintenance, 'exit');
    }

    await lease.run('true', [], { ...commandOptions, remoteOperation: 'build-export' });
    expect(spawnSync('flock', ['-xn', lock, 'true']).status).toBe(1);
    expect(readdirSync(join(gate, 'leases'))).toHaveLength(1);
    lease.dispose();
    expect(spawnSync('flock', ['-xn', lock, 'true']).status).toBe(0);
    expect(readdirSync(join(gate, 'leases'))).toHaveLength(0);
  });
  it('fails closed on partial provisioning, pending recovery and held maintenance', async () => {
    const { spawn } = await import('node:child_process');
    const partial = admission();
    rmSync(join(partial.gate, 'build-admission.lock'));
    expect(() => partial.manager.admit()).toThrow('missing build-admission.lock');

    const pending = admission();
    rmSync(join(pending.gate, 'build-admission.lock'));
    rmSync(join(pending.gate, 'leases'), { recursive: true });
    writeFileSync(join(pending.gate, 'migration-pending'), '');
    expect(() => pending.manager.admit()).toThrow('migration recovery is pending');

    const held = admission();
    const maintenance = spawn('flock', [
      '-x',
      join(held.gate, 'build-admission.lock'),
      'sleep',
      '5',
    ]);
    try {
      await setTimeout(200);
      expect(() => held.manager.admit()).toThrow('builder maintenance is in progress');
    } finally {
      maintenance.kill();
    }
  });
  it('admits through the host lock once provisioned', () => {
    const f = admission();
    const lease = f.manager.admit();
    expect(lease).toBeDefined();
    lease?.dispose();
  });
  it('keeps a durable host blocker after an ambiguous remote failure', async () => {
    const { readdirSync } = await import('node:fs');
    const f = admission();
    const lease = f.manager.acquire();
    await expect(
      lease.run('false', [], { ...commandOptions, remoteOperation: 'build-export' }),
    ).rejects.toThrow();
    lease.dispose();
    expect(readdirSync(join(f.gate, 'leases'))).toHaveLength(1);
    expect(existsSync(join(lease.directory, 'remote-operation.json'))).toBe(true);
  });
});

// A build that failed on its own used to keep its record, and every later build on the host
// was refused until someone rebooted it into offline reconciliation.
describe('remote operation release', () => {
  const solveFailure = [
    '#9 [dev_containers_target_stage 3/5] RUN pip3 install -r /tmp/requirements.txt',
    '#9 ERROR: process "/bin/sh -c pip3 install -r /tmp/requirements.txt" did not complete successfully: exit code: 1',
    'ERROR: failed to solve: process "/bin/sh -c pip3 install" did not complete successfully: exit code: 1',
  ].join('\n');

  it('recognises only answers from the worker or the Engine as definitive', () => {
    expect(remoteOperationEnded('build-export', solveFailure)).toBe(true);
    // Only a step's exit is the solve's own verdict; anything else is decided later.
    expect(
      remoteOperationEnded('build-export', 'ERROR: failed to solve: failed to read dockerfile'),
    ).toBe(false);
    // A build step can print anything, including BuildKit's own verdict; the client's
    // last report after a lost connection is what counts.
    expect(
      remoteOperationEnded(
        'build-export',
        `${solveFailure}\nERROR: failed to solve: Unavailable: http2: client connection lost`,
      ),
    ).toBe(false);
    expect(
      remoteOperationEnded(
        'build-export',
        '#9 ERROR: process "/bin/sh -c x" did not complete successfully: exit code: 1\nERROR: failed to solve: failed to receive status: EOF',
      ),
    ).toBe(false);
    for (const transport of [
      'Canceled: grpc: the client connection is closing',
      'DeadlineExceeded: context deadline exceeded',
      'i/o timeout',
    ])
      expect(remoteOperationEnded('image-import', `Error response from daemon: ${transport}`)).toBe(
        false,
      );
    // A lost connection says nothing about whether the solve is still running.
    expect(
      remoteOperationEnded(
        'build-export',
        'ERROR: failed to solve: rpc error: code = Unavailable desc = error reading from server: EOF',
      ),
    ).toBe(false);
    expect(remoteOperationEnded('build-export', 'Build command exited 1')).toBe(false);
    // Newer buildx wraps the same verdict; a later transport report under either
    // prefix still wins over the earlier step verdict.
    const wrapped = solveFailure.replace(
      'ERROR: failed to solve:',
      'ERROR: failed to build: failed to solve:',
    );
    expect(remoteOperationEnded('build-export', wrapped)).toBe(true);
    for (const transport of [
      'ERROR: failed to build: failed to solve: Unavailable: connection reset',
      'ERROR: failed to build: failed to receive status: rpc error: code = Unavailable',
    ]) {
      expect(remoteOperationEnded('build-export', `${solveFailure}\n${transport}`)).toBe(false);
      expect(remoteOperationEnded('build-export', `${wrapped}\n${transport}`)).toBe(false);
    }
    expect(
      remoteOperationEnded('image-import', 'Error response from daemon: invalid tar header'),
    ).toBe(true);
    expect(remoteOperationEnded('image-import', 'Build command exited 1')).toBe(false);
    expect(remoteOperationEnded('image-import', solveFailure)).toBe(false);
    expect(
      remoteOperationEnded(
        'image-import',
        'Error response from daemon: invalid tar header\nLoaded image: example:latest',
      ),
    ).toBe(false);
  });

  // The Server's own disposed attempts carry its own live pid; they once read as a
  // build still running and refused every build until the Server restarted.
  it('releases this process’s own ambiguous attempt once reconciliation proves it ended', async () => {
    const f = fixture();
    const storage = f.manager();
    const lease = storage.acquire();
    await expect(
      lease.run(
        process.execPath,
        [
          '-e',
          'process.stderr.write("ERROR: failed to solve: Unavailable: connection reset"); process.exit(1)',
        ],
        { ...commandOptions, remoteOperation: 'build-export' },
      ),
    ).rejects.toThrow();
    lease.dispose();
    expect(existsSync(lease.directory)).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await setTimeout(5);
      expect(await storage.reconcile({ buildkitIdle: async () => true })).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(lease.directory)).toBe(false);
    storage.acquire().dispose();
  });

  it('releases a deterministic build failure so the next project builds right away', async () => {
    const f = fixture();
    const storage = f.manager();
    const lease = storage.acquire();
    lease.reserveBuild();
    await expect(
      lease.run(
        process.execPath,
        ['-e', `process.stderr.write(${JSON.stringify(solveFailure)}); process.exit(1)`],
        { ...commandOptions, remoteOperation: 'build-export' },
      ),
    ).rejects.toThrow();
    expect(lease.retainArtifacts).toBe(false);
    lease.dispose();
    expect(existsSync(lease.directory)).toBe(false);
    const next = storage.acquire();
    expect(storage.unresolvedAttempts()).toEqual([]);
    next.dispose();
  });

  it('keeps a transport failure reserved, bounded to its own estimate', async () => {
    const f = fixture();
    const storage = f.manager();
    const lease = storage.acquire();
    lease.reserveBuild(10 * GiB);
    await expect(
      lease.run(
        process.execPath,
        [
          '-e',
          'process.stderr.write("ERROR: failed to solve: rpc error: code = Unavailable desc = connection reset"); process.exit(1)',
        ],
        { ...commandOptions, remoteOperation: 'build-export' },
      ),
    ).rejects.toThrow();
    expect(lease.retainArtifacts).toBe(true);
    lease.dispose();
    const estimate = estimateBuildStorageBytes(f.policy, 10 * GiB);
    const next = storage.acquire();
    expect(storage.unresolvedAttempts()).toEqual([
      expect.objectContaining({ operation: 'build-export', reservedBytes: estimate }),
    ]);
    // The reservation counts against admission, and names itself when it decides it.
    f.local.availableBytes = estimate + f.policy.reserveBytes + f.policy.estimateBytes - 1;
    expect(() => next.reserveBuild()).toThrow(lease.directory.slice(f.root.length + 1));
    f.local.availableBytes = 100 * GiB;
    next.dispose();
  });
});

describe('build storage reconciliation', () => {
  const namespace = () => readlinkSync('/proc/self/ns/pid');
  const attempt = (
    f: ReturnType<typeof fixture>,
    name: string,
    owner: Record<string, unknown>,
    record?: Record<string, unknown>,
  ) => {
    const directory = join(f.root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'owner.json'),
      JSON.stringify({ version: 1, pid: 2147483647, start: '0', namespace: namespace(), ...owner }),
    );
    if (record !== undefined)
      writeFileSync(
        join(directory, 'remote-operation.json'),
        JSON.stringify({
          version: 1,
          hostBootId: '11111111-1111-4111-8111-111111111111',
          hostIdentity: 'a'.repeat(64),
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          ...record,
        }),
      );
    writeFileSync(join(directory, 'image.tar'), 'archive');
    return directory;
  };
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('releases a finished build once the worker reports no running build', async () => {
    const f = fixture();
    // The incident's shape: a failed solve left behind by an older Server.
    const directory = attempt(f, 'attempt-HS9hLo', {}, { operation: 'build-export' });
    const storage = f.manager();
    const warn = quiet();
    try {
      // An unanswered question keeps the reservation.
      expect(await storage.reconcile({ buildkitIdle: async () => undefined })).toHaveLength(1);
      expect(await storage.reconcile({ buildkitIdle: async () => false })).toHaveLength(1);
      expect(existsSync(directory)).toBe(true);
      expect(await storage.reconcile({ buildkitIdle: async () => true })).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(directory)).toBe(false);
  });

  // The record is written before the client submits its solve, so an idle worker says
  // nothing while that client can still submit.
  it('trusts the worker only once the build client is gone', async () => {
    const f = fixture();
    const directory = attempt(f, 'attempt-orphan', {}, { operation: 'build-export' });
    const foreign = attempt(
      f,
      'attempt-foreign',
      { namespace: 'old-container' },
      { operation: 'build-export' },
    );
    const live = async (slot: number) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      await once(child, 'spawn');
      writeFileSync(join(directory, `child-${slot}`), String(child.pid));
      return child;
    };
    const stop = async (child: ReturnType<typeof spawn>) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
    };
    const storage = f.manager();
    const warn = quiet();
    const children: ReturnType<typeof spawn>[] = [await live(0)];
    try {
      expect(await storage.reconcile({ buildkitIdle: async () => true })).toHaveLength(2);
      await stop(children[0]!);
      // A client that appears while the worker is asked keeps the record too.
      expect(
        await storage.reconcile({
          buildkitIdle: async () => {
            children.push(await live(1));
            return true;
          },
        }),
      ).toHaveLength(2);
      expect(existsSync(join(directory, 'remote-operation.json'))).toBe(true);
      await stop(children[1]!);
      expect(await storage.reconcile({ buildkitIdle: async () => true })).toHaveLength(1);
      expect(existsSync(directory)).toBe(false);
      // Another PID namespace's client cannot be seen; it is trusted gone only once it
      // outlived every command bound.
      expect(existsSync(join(foreign, 'remote-operation.json'))).toBe(true);
      expect(
        await storage.reconcile({ buildkitIdle: async () => true }, Date.now() + 2 * 3600_000),
      ).toEqual([]);
      expect(existsSync(join(foreign, 'remote-operation.json'))).toBe(false);
    } finally {
      warn.mockRestore();
      for (const child of children) await stop(child);
    }
  });

  it('stops charging a released attempt to a build that holds a lease', async () => {
    const f = fixture();
    attempt(f, 'attempt-earlier', {}, { operation: 'image-import' });
    const storage = f.manager();
    const lease = storage.acquire();
    const warn = quiet();
    try {
      // Admission saw the earlier import; reconciliation proves it ended mid-lease.
      expect(storage.unresolvedAttempts()).toEqual([
        expect.objectContaining({ attempt: 'attempt-earlier' }),
      ]);
      expect(await storage.reconcile()).toEqual([]);
      expect(storage.unresolvedAttempts()).toEqual([]);
    } finally {
      warn.mockRestore();
      lease.dispose();
    }
  });

  it('applies the worker’s answer only to operations that began before it was asked', async () => {
    const f = fixture();
    const directory = attempt(f, 'attempt-late', {}, { operation: 'build-export' });
    const storage = f.manager();
    const warn = quiet();
    try {
      const left = await storage.reconcile({
        buildkitIdle: async () => {
          // A new operation is recorded while the worker is being asked.
          await setTimeout(5);
          writeFileSync(
            join(directory, 'remote-operation.json'),
            JSON.stringify({
              version: 1,
              operation: 'build-export',
              hostBootId: '11111111-1111-4111-8111-111111111111',
              hostIdentity: 'a'.repeat(64),
              startedAt: new Date().toISOString(),
            }),
          );
          return true;
        },
      });
      expect(left).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(join(directory, 'remote-operation.json'))).toBe(true);
  });

  it('treats a host restart as proof and an unreachable worker as no answer', async () => {
    const f = fixture();
    const rebooted = attempt(
      f,
      'attempt-rebooted',
      { namespace: 'old-container' },
      { operation: 'build-export', hostBootId: '22222222-2222-4222-8222-222222222222' },
    );
    const storage = f.manager();
    const warn = quiet();
    try {
      await storage.reconcile({ buildkitIdle: async () => Promise.reject(new Error('down')) });
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(join(rebooted, 'remote-operation.json'))).toBe(false);
    // Its files belong to an older Server process and stay until that is proven over.
    expect(existsSync(rebooted)).toBe(true);
  });

  it('releases an import once its client has exited', async () => {
    const f = fixture();
    const directory = attempt(f, 'attempt-import', {}, { operation: 'image-import' });
    const storage = f.manager();
    const warn = quiet();
    try {
      expect(await storage.reconcile()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(directory)).toBe(false);
  });

  it('removes a previous Server attempt only after its boot changed or it outlived every command', async () => {
    const f = fixture();
    const young = attempt(f, 'attempt-young', { namespace: 'old-container' });
    const otherBoot = attempt(f, 'attempt-boot', {
      namespace: 'old-container',
      hostBootId: '22222222-2222-4222-8222-222222222222',
    });
    const storage = f.manager();
    expect(await storage.reconcile()).toEqual([
      expect.objectContaining({ attempt: 'attempt-young' }),
    ]);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(otherBoot)).toBe(false);
    expect(await storage.reconcile({}, Date.now() + 3 * 60 * 60 * 1000)).toEqual([]);
    expect(existsSync(young)).toBe(false);
  });
});

describe('admission reclamation', () => {
  it('reclaims once and measures capacity again before admitting', async () => {
    const f = fixture();
    f.local.availableBytes = 0;
    f.writeReport(0);
    const manager = f.manager();
    const reclaim = vi.fn(async () => {
      f.local.availableBytes = 100 * GiB;
      f.writeReport();
    });
    manager.setReclaimer(reclaim);
    const lease = await manager.admitInTurn();
    expect(reclaim).toHaveBeenCalledOnce();
    lease.dispose();
  });
  it('reclaims after the later full build reservation rejects host capacity', async () => {
    const f = fixture();
    f.writeReport(6 * GiB);
    const manager = f.manager();
    const reclaim = vi.fn(async () => {
      f.writeReport();
    });
    manager.setReclaimer(reclaim);
    const lease = await manager.admitInTurn();
    expect(reclaim).not.toHaveBeenCalled();
    await lease.reserveBuildWithReclamation?.();
    expect(reclaim).toHaveBeenCalledOnce();
    lease.dispose();
  });
  it('retries full build reservations only once without discarding evidence', async () => {
    const f = fixture();
    f.writeReport(6 * GiB);
    const manager = f.manager();
    const reclaim = vi.fn(async () => {});
    manager.setReclaimer(reclaim);
    const lease = await manager.admitInTurn();
    await expect(lease.reserveBuildWithReclamation?.()).rejects.toThrow('admission rejected');
    expect(reclaim).toHaveBeenCalledOnce();
    lease.dispose();
  });
  it('keeps FIFO ownership while reclamation awaits', async () => {
    const f = fixture();
    f.local.availableBytes = 0;
    f.writeReport(0);
    const manager = f.manager();
    let finish!: () => void;
    const reclaim = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            f.local.availableBytes = 100 * GiB;
            f.writeReport();
            resolve();
          };
        }),
    );
    manager.setReclaimer(reclaim);
    const first = manager.admitInTurn();
    const queued = vi.fn();
    const second = manager.admitInTurn(queued);
    expect(queued).toHaveBeenCalledOnce();
    expect(reclaim).toHaveBeenCalledOnce();
    finish();
    const firstLease = await first;
    let secondAdmitted = false;
    void second.then(() => {
      secondAdmitted = true;
    });
    await Promise.resolve();
    expect(secondAdmitted).toBe(false);
    firstLease.dispose();
    (await second).dispose();
  });
  it('does not loop or override reservation/capacity refusals', async () => {
    const f = fixture();
    f.local.availableBytes = 0;
    f.writeReport(0);
    const manager = f.manager();
    const reclaim = vi.fn(async () => {});
    manager.setReclaimer(reclaim);
    await expect(manager.admitInTurn()).rejects.toThrow('admission rejected');
    expect(reclaim).toHaveBeenCalledOnce();
  });
});
