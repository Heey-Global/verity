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
