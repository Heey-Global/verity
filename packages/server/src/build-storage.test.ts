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
import { afterEach, describe, expect, it } from 'vitest';
import { BuildStorage, buildStoragePolicy } from './build-storage.js';

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
    expect(buildStoragePolicy({}).estimateBytes).toBeGreaterThan(100 * GiB);
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
    for (const value of ['0', '-1', '1.5', 'Infinity', '1000000', '']) {
      expect(() => buildStoragePolicy({ VERITY_BUILD_FREE_GIB: value })).toThrow('Invalid');
    }
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

  it('rejects unavailable, stale or exhausted independent project filesystems', () => {
    const f = fixture();
    const lease = f.manager().acquire();
    for (const patch of [
      { state: 'unavailable' },
      { observedAt: new Date(Date.now() - 121_000).toISOString() },
      { availableBytes: 9 * GiB },
      { freeInodes: 999 },
    ]) {
      f.writeReport();
      const report = JSON.parse(readFileSync(f.report, 'utf8')) as {
        roots: { kind: string; filesystemId: string }[];
      };
      const project = report.roots.find((root) => root.kind === 'project')!;
      project.filesystemId = 'independent-project-filesystem';
      Object.assign(project, patch);
      writeFileSync(f.report, JSON.stringify(report));
      expect(() => lease.reserveBuild()).toThrow(/project filesystem|admission rejected/);
    }
    lease.dispose();
  });

  it('rejects missing, stale, incomplete and ambiguous host reports without assuming topology', () => {
    const f = fixture();
    const lease = f.manager().acquire();
    rmSync(f.report);
    expect(() => lease.reserveBuild()).toThrow('missing or invalid');
    f.writeReport(100 * GiB, 100_000, 121_000);
    expect(() => lease.reserveBuild()).toThrow('stale');
    f.writeReport();
    const report = JSON.parse(readFileSync(f.report, 'utf8')) as { roots: { kind: string }[] };
    report.roots = report.roots.filter((root: { kind: string }) => root.kind !== 'buildkit');
    writeFileSync(f.report, JSON.stringify(report));
    expect(() => lease.reserveBuild()).toThrow('buildkit filesystem');
    f.writeReport();
    const duplicate = JSON.parse(readFileSync(f.report, 'utf8')) as { roots: { kind: string }[] };
    duplicate.roots.push(duplicate.roots[0]!);
    writeFileSync(f.report, JSON.stringify(duplicate));
    expect(() => lease.reserveBuild()).toThrow('buildkit filesystem');
    f.writeReport();
    const staleRoot = JSON.parse(readFileSync(f.report, 'utf8')) as {
      roots: { observedAt: string }[];
    };
    staleRoot.roots[0]!.observedAt = new Date(Date.now() - 121_000).toISOString();
    writeFileSync(f.report, JSON.stringify(staleRoot));
    expect(() => lease.reserveBuild()).toThrow('filesystem sample is stale');
    lease.dispose();
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
      expect(() => f.manager().acquire()).toThrow('recovery');
      expect(existsSync(abandoned)).toBe(true);
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
    expect(() => f.manager().acquire()).toThrow('recovery');
    writeFileSync(
      join(unknown, 'owner.json'),
      JSON.stringify({ version: 1, pid: 2147483647, start: '0', namespace: 'another-namespace' }),
    );
    expect(() => f.manager().acquire()).toThrow('recovery');
    expect(existsSync(unknown)).toBe(true);
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
      expect(() => storage.acquire()).toThrow('termination is unconfirmed');
      expect(() => f.manager().acquire()).toThrow('termination is unconfirmed');
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
    expect(() => f.manager().acquire()).toThrow('termination is unconfirmed');
    expect(existsSync(lease.directory)).toBe(true);
  });
});

it('refuses remote work without host identity before starting any command', async () => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.report, 'utf8'));
  delete data.hostIdentity;
  writeFileSync(f.report, JSON.stringify(data));
  const lease = f.manager().acquire();
  const marker = join(f.directory, 'command-started');
  await expect(
    lease.run(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      {
        ...commandOptions,
        remoteOperation: 'build-export',
      },
    ),
  ).rejects.toThrow('host identity is missing');
  expect(existsSync(marker)).toBe(false);
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
