import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildStorage } from './build-storage.js';
import {
  DataVolumeUsage,
  classifyDataVolumePath,
  describeDataVolumeCapacity,
  type DataVolumeBreakdown,
} from './data-volume-usage.js';

const GiB = 1024 ** 3;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** One file per category, each 64 KiB so it allocates blocks on any filesystem. */
const LAYOUT = {
  sources: 'workspaces/p/.verity-sessions/s/src/index.ts',
  dependencies: 'workspaces/p/.verity-sessions/s/node_modules/dep/index.js',
  nestedDependencies: 'workspaces/p/.verity-sessions/s/.cache/wt/node_modules/dep/index.js',
  git: 'workspaces/p/.git/objects/pack/pack.pack',
  dependencyStore: `workspaces/p/.git/verity-dependencies/${'a'.repeat(64)}/node_modules/dep/index.js`,
  preservedDependencies:
    'workspaces/p/.git/worktrees/s/verity-dependencies-preserved/11111111-1111-4111-8111-111111111111/dep/index.js',
  packageCache: 'runners/p/package-cache/npm/_cacache/content',
  toolCaches: 'runners/p/session-homes/h/cache/ms-playwright/chrome',
  sessionHomes: 'runners/p/session-homes/h/.claude/history.jsonl',
  turns: 'runners/p/turns/t/output.json',
  knowledge: 'knowledge/insights/page.md',
  documentArchives: 'document-archives/archive.tar',
  backups: 'backup-state/tuf-cache/root.json',
  buildStorage: 'build-storage/attempt/layer.tar',
  unknown: 'stray-export/big.bin',
} as const;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'data-volume-'));
  directories.push(directory);
  const root = join(directory, 'volume');
  for (const relative of Object.values(LAYOUT)) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), Buffer.alloc(64 * 1024, 1));
  }
  // A hard link to a dependency file must not count its blocks twice.
  linkSync(
    join(root, LAYOUT.dependencies),
    join(root, 'workspaces/p/.verity-sessions/s/node_modules/dep/copy.js'),
  );
  // A link out of the volume is counted as itself and never followed.
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'huge.bin'), Buffer.alloc(1024 * 1024, 1));
  symlinkSync(outside, join(root, 'workspaces/p/.verity-sessions/s/linked'));
  return { root, outside };
}

/** What `du` reports for everything below the root, on the root's filesystem. */
function du(root: string): number {
  return readdirSync(root).reduce(
    (total, name) =>
      total +
      Number(execFileSync('du', ['-sxB1', join(root, name)], { encoding: 'utf8' }).split('\t')[0]),
    0,
  );
}

async function complete(usage: DataVolumeUsage, limit = 1000): Promise<DataVolumeBreakdown> {
  for (let run = 0; run < limit && usage.lastComplete === undefined; run++) await usage.runOnce();
  return usage.lastComplete!;
}

describe('data volume usage', () => {
  it('attributes every category and matches du for the whole tree', async () => {
    const f = fixture();
    const usage = new DataVolumeUsage({ root: f.root, continueAfterMs: 0 });
    const breakdown = await complete(usage);
    for (const [category, relative] of Object.entries(LAYOUT)) {
      const expected = category === 'nestedDependencies' ? 'dependencies' : category;
      expect(classifyDataVolumePath(relative.split('/'))).toBe(expected);
      expect(breakdown.categories[expected as keyof typeof breakdown.categories]).toBeGreaterThan(
        64 * 1024 - 1,
      );
    }
    const total = Object.values(breakdown.categories).reduce((sum, bytes) => sum + bytes, 0);
    expect(total).toBe(du(f.root));
    expect(breakdown.regenerableBytes + breakdown.protectedBytes + breakdown.unknownBytes).toBe(
      total,
    );
    expect(breakdown.unknown).toEqual([
      { name: 'stray-export', bytes: breakdown.categories.unknown },
    ]);
    // du does not follow the link either; the file behind it was never counted.
    expect(breakdown.categories.sources).toBeLessThan(1024 * 1024);
  });

  // A round that has not finished must never be published, and in particular
  // never as an empty breakdown that reads as "nothing to reclaim".
  it('publishes nothing until a round finishes and resumes within the entry budget', async () => {
    const f = fixture();
    const reference = await complete(new DataVolumeUsage({ root: f.root, continueAfterMs: 0 }));
    const usage = new DataVolumeUsage({ root: f.root, entryBudget: 3, continueAfterMs: 0 });
    let previous = 0;
    let runs = 0;
    while (usage.lastComplete === undefined) {
      await usage.runOnce();
      runs++;
      const entries = usage.progress()?.entries;
      if (entries !== undefined) {
        expect(entries - previous).toBeLessThanOrEqual(3);
        previous = entries;
        expect(usage.diagnostics().complete).toBeNull();
      }
    }
    expect(runs).toBeGreaterThan(5);
    expect(usage.lastComplete.categories).toEqual(reference.categories);
    expect(usage.lastComplete.entries).toBe(reference.entries);
    expect(usage.progress()).toBeNull();
  });

  it('stops at its time budget', async () => {
    const f = fixture();
    let clock = 0;
    const usage = new DataVolumeUsage({
      root: f.root,
      now: () => (clock += 10),
      timeBudgetMs: 25,
      continueAfterMs: 0,
    });
    await usage.runOnce();
    expect(usage.lastComplete).toBeUndefined();
    expect(usage.progress()?.entries).toBeLessThanOrEqual(2);
  });

  it('keeps the last complete breakdown while the next round runs', async () => {
    const f = fixture();
    const usage = new DataVolumeUsage({ root: f.root, continueAfterMs: 0 });
    const first = await complete(usage);
    const slow = new DataVolumeUsage({ root: f.root, entryBudget: 2, continueAfterMs: 0 });
    slow.lastComplete = first;
    await slow.runOnce();
    expect(slow.lastComplete).toBe(first);
    expect(slow.describe()).toContain(first.observedAt);
  });

  it('does not descend into another filesystem mounted inside the volume', async () => {
    const f = fixture();
    const mounted = join(f.root, 'knowledge');
    const usage = new DataVolumeUsage({
      root: f.root,
      continueAfterMs: 0,
      lstat: (async (path: string) => {
        const stat = await lstat(path);
        return path.startsWith(mounted) ? Object.assign(stat, { dev: stat.dev + 1 }) : stat;
      }) as typeof lstat,
    });
    const breakdown = await complete(usage);
    expect(breakdown.categories.knowledge).toBe(0);
  });

  // A sandbox-private directory the Server cannot read used to discard every
  // round, leaving refusals at "not yet complete" for good.
  it('reports unreadable entries as unmeasured and still finishes the round', async () => {
    const f = fixture();
    const denied = (path: string) =>
      Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
    const homes = join(f.root, 'runners/p/session-homes/h/.claude');
    const turn = join(f.root, LAYOUT.turns);
    const usage = new DataVolumeUsage({
      root: f.root,
      continueAfterMs: 0,
      readdir: async (path) => {
        if (path === homes) throw denied(path);
        return (await import('node:fs/promises')).readdir(path);
      },
      lstat: (async (path: string) => {
        if (path === turn) throw denied(path);
        return lstat(path);
      }) as typeof lstat,
    });
    const breakdown = await complete(usage);
    expect(breakdown.unreadable).toBe(2);
    expect(breakdown.categories.turns).toBeGreaterThan(0); // its directories still count
    expect(usage.describe()).toContain('2 unreadable entries not measured');
  });

  it('marks the breakdown approximate once it stops remembering hard links', async () => {
    const f = fixture();
    const exact = await complete(new DataVolumeUsage({ root: f.root, continueAfterMs: 0 }));
    expect(exact.approximate).toBe(false);
    const bounded = await complete(
      new DataVolumeUsage({ root: f.root, continueAfterMs: 0, linkedLimit: 0 }),
    );
    expect(bounded.approximate).toBe(true);
    expect(bounded.categories.dependencies).toBeGreaterThan(exact.categories.dependencies);
  });

  it('continues an unfinished round on its own and stops for shutdown', async () => {
    const f = fixture();
    const usage = new DataVolumeUsage({ root: f.root, entryBudget: 5, continueAfterMs: 5 });
    await usage.runOnce();
    await vi.waitFor(() => expect(usage.lastComplete).toBeDefined(), { timeout: 10_000 });

    let seen = 0;
    const stopping = new DataVolumeUsage({
      root: f.root,
      continueAfterMs: 5,
      lstat: (async (path: string) => {
        if (++seen === 4) void stopping.stop();
        return lstat(path);
      }) as typeof lstat,
    });
    await stopping.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopping.lastComplete).toBeUndefined();
    expect(seen).toBeLessThan(6);
    await stopping.runOnce();
    expect(seen).toBeLessThan(6);
  });

  it('restarts the round when the volume root disappears', async () => {
    const f = fixture();
    const usage = new DataVolumeUsage({ root: f.root, entryBudget: 2, continueAfterMs: 0 });
    await usage.runOnce();
    rmSync(f.root, { recursive: true });
    await usage.runOnce();
    await usage.runOnce();
    expect(usage.lastComplete).toBeUndefined();
    expect(usage.progress()).toBeNull();
  });

  it('starts over when the volume root is replaced mid-round', async () => {
    const f = fixture();
    const usage = new DataVolumeUsage({ root: f.root, entryBudget: 4, continueAfterMs: 0 });
    await usage.runOnce();
    rmSync(f.root, { recursive: true });
    mkdirSync(join(f.root, 'knowledge'), { recursive: true });
    writeFileSync(join(f.root, 'knowledge', 'only.md'), Buffer.alloc(64 * 1024, 1));
    const breakdown = await complete(usage);
    expect(breakdown.categories.sources).toBe(0);
    expect(Object.values(breakdown.categories).reduce((a, b) => a + b, 0)).toBe(du(f.root));
  });
});

describe('data volume capacity description', () => {
  const breakdown = (regenerable: number, sources: number): DataVolumeBreakdown => ({
    startedAt: '2026-11-16T00:00:00.000Z',
    observedAt: '2026-11-16T01:00:00.000Z',
    durationMs: 1,
    entries: 1,
    unreadable: 0,
    approximate: false,
    categories: {
      dependencies: regenerable,
      preservedDependencies: 0,
      dependencyStore: 0,
      packageCache: 0,
      toolCaches: 0,
      sources,
      git: 1 * GiB,
      sessionHomes: 0,
      turns: 0,
      runnerState: 0,
      knowledge: 0,
      documentArchives: 0,
      backups: 0,
      buildStorage: 0,
      unknown: 0,
    },
    regenerableBytes: regenerable,
    protectedBytes: sources + 1 * GiB,
    unknownBytes: 0,
    unknown: [],
  });

  it('never reports zero for an unfinished breakdown', () => {
    const text = describeDataVolumeCapacity(undefined, 10 * GiB);
    expect(text).toContain('not yet complete');
    expect(text).not.toMatch(/0\.0 GiB/u);
  });

  it('says when reclaiming regenerable data cannot cover the shortfall', () => {
    const short = describeDataVolumeCapacity(breakdown(2 * GiB, 40 * GiB), 10 * GiB);
    expect(short).toContain('2.0 GiB regenerable');
    expect(short).toContain('41.0 GiB protected');
    expect(short).toContain('cannot cover the 10.0 GiB shortfall');
    expect(short).toContain('largest share is sources (40.0 GiB)');
    const covered = describeDataVolumeCapacity(breakdown(20 * GiB, 40 * GiB), 10 * GiB);
    expect(covered).not.toContain('cannot cover');
  });

  it('is appended to a build admission refusal with its shortfall', () => {
    const directory = mkdtempSync(join(tmpdir(), 'build-storage-capacity-'));
    directories.push(directory);
    const report = join(directory, 'storage.json');
    writeFileSync(report, '{}');
    const storage = new BuildStorage(
      join(directory, 'owned'),
      report,
      { estimateBytes: 8 * GiB, reserveBytes: 2 * GiB, reserveInodes: 1000 },
      () => ({ availableBytes: 3 * GiB, freeInodes: 100_000 }),
    );
    const shortfalls: number[] = [];
    storage.setCapacityDescriber((shortfall) => {
      shortfalls.push(shortfall);
      return ' Data volume breakdown is not yet complete.';
    });
    let message = '';
    try {
      storage.acquire();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/admission rejected.*breakdown is not yet complete/su);
    // The shortfall is what the refusal itself names as missing.
    const [, available, growth, reserve] =
      /available (\d+) GiB.*requires (\d+) GiB estimated growth plus (\d+) GiB reserve/su.exec(
        message,
      )!;
    expect(shortfalls).toEqual([(Number(growth) + Number(reserve) - Number(available)) * GiB]);
  });
});
