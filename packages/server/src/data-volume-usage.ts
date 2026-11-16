import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where the Server's data volume goes, by what holding it means.
 *
 * Build admission and low-disk warnings used to report only free space, so an
 * operator could not tell whether automatic reclamation could ever cover a
 * shortfall or whether source, history and knowledge filled the volume. This
 * module measures the volume read-only, in bounded runs that resume where the
 * previous one stopped, and publishes a breakdown only once a whole round has
 * finished. It never deletes anything.
 */

/** Data that the Server or the sandbox toolkit regenerates on demand. */
const REGENERABLE = [
  'dependencies',
  'preservedDependencies',
  'dependencyStore',
  'packageCache',
  'toolCaches',
] as const;
/** Data whose loss loses work, history or state; no automatic step removes it. */
const PROTECTED = [
  'sources',
  'git',
  'sessionHomes',
  'turns',
  'runnerState',
  'knowledge',
  'documentArchives',
  'backups',
  'buildStorage',
] as const;
type Category = (typeof REGENERABLE)[number] | (typeof PROTECTED)[number] | 'unknown';

/** Most entries one run visits, independent of its time budget. */
const ENTRY_BUDGET = 250_000;
const TIME_BUDGET_MS = 20_000;
/** Spacing of the follow-up runs while a round is unfinished. */
const CONTINUE_AFTER_MS = 15 * 60_000;
const UNKNOWN_SHOWN = 10;
/** Multi-link files remembered per round; beyond it they may be counted twice. */
const LINKED_LIMIT = 500_000;
/** Errors that leave one entry unmeasured without invalidating the round. */
const SKIPPED = ['EACCES', 'EPERM', 'ELOOP', 'EIO', 'ENAMETOOLONG'];

/** Category of a path given as segments relative to the volume root. */
export function classifyDataVolumePath(segments: readonly string[]): Category {
  const [top, owner, area, ...rest] = segments;
  switch (top) {
    case 'workspaces':
      // <project>/.git/... — central store and preserved copies first: both
      // hold dependency trees but not under a `node_modules` segment.
      if (area === '.git') {
        if (rest[0] === 'verity-dependencies') return 'dependencyStore';
        if (rest[0] === 'worktrees' && rest[2] === 'verity-dependencies-preserved')
          return 'preservedDependencies';
        return 'git';
      }
      return segments.includes('node_modules') ? 'dependencies' : 'sources';
    case 'runners':
      if (owner === undefined) return 'runnerState';
      if (area === 'package-cache') return 'packageCache';
      if (area === 'session-homes') return rest[1] === 'cache' ? 'toolCaches' : 'sessionHomes';
      if (area === 'turns') return 'turns';
      return 'runnerState';
    case 'knowledge':
      return 'knowledge';
    case 'document-archives':
      return 'documentArchives';
    case 'backup-state':
      return 'backups';
    case 'build-storage':
      return 'buildStorage';
    default:
      return 'unknown';
  }
}

export interface DataVolumeBreakdown {
  /** When the round that produced this breakdown started and finished. */
  startedAt: string;
  observedAt: string;
  /** Run time spent on the round, excluding the pauses between runs. */
  durationMs: number;
  entries: number;
  /** Directories and entries that could not be read; their contents are not counted. */
  unreadable: number;
  /** True when more multi-link files existed than were remembered: totals may count some twice. */
  approximate: boolean;
  categories: Record<Category, number>;
  regenerableBytes: number;
  protectedBytes: number;
  unknownBytes: number;
  /** Largest unattributed top-level entries, by name under the volume root. */
  unknown: Array<{ name: string; bytes: number }>;
}

interface Pending {
  path: string;
  segments: string[];
  names?: string[];
  next: number;
}

interface Round {
  startedAt: number;
  durationMs: number;
  entries: number;
  unreadable: number;
  approximate: boolean;
  categories: Record<Category, number>;
  unknown: Map<string, number>;
  /** `dev:ino` of files with several links, so each is counted once. */
  linked: Set<string>;
  stack: Pending[];
  device: number;
  /** The root's identity: a replaced or vanished root restarts the round.
   *  Inode numbers are reused, so its creation time is part of it. */
  inode: number;
  born: number;
}

function emptyCategories(): Record<Category, number> {
  return Object.fromEntries(
    [...REGENERABLE, ...PROTECTED, 'unknown'].map((name) => [name, 0]),
  ) as Record<Category, number>;
}

export class DataVolumeUsage {
  private round: Round | undefined;
  private flight: Promise<void> | undefined;
  private continuation: ReturnType<typeof setTimeout> | undefined;
  private readonly shutdown = new AbortController();
  /** The latest finished round; never a partial one. */
  lastComplete: DataVolumeBreakdown | undefined;

  constructor(
    private readonly deps: {
      root: string;
      now?: () => number;
      timeBudgetMs?: number;
      entryBudget?: number;
      /** 0 disables continuation runs. */
      continueAfterMs?: number;
      /** Test seams for filesystems and permissions a test cannot create. */
      lstat?: typeof lstat;
      readdir?: (path: string) => Promise<string[]>;
      linkedLimit?: number;
    },
  ) {}

  stop(): Promise<void> {
    this.shutdown.abort();
    clearTimeout(this.continuation);
    this.continuation = undefined;
    return this.flight ?? Promise.resolve();
  }

  /** One bounded run; joins a run in flight. Never rejects. */
  runOnce(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    if (this.flight) return this.flight;
    clearTimeout(this.continuation);
    this.continuation = undefined;
    this.flight = this.run()
      .catch(() => {
        // An unreadable root or a vanished volume restarts the round; the last
        // complete breakdown stays published with its own timestamp.
        this.round = undefined;
      })
      .finally(() => {
        this.flight = undefined;
        if (this.round !== undefined && !this.shutdown.signal.aborted) this.scheduleContinuation();
      });
    return this.flight;
  }

  /** See {@link describeDataVolumeCapacity}. */
  describe(shortfallBytes?: number): string {
    return describeDataVolumeCapacity(this.lastComplete, shortfallBytes);
  }

  /** The latest complete breakdown and the unfinished round, for runtime diagnostics. */
  diagnostics(): {
    complete: DataVolumeBreakdown | null;
    round: { startedAt: string; entries: number } | null;
  } {
    return { complete: this.lastComplete ?? null, round: this.progress() };
  }

  /** Progress of the unfinished round, for diagnostics. */
  progress(): { startedAt: string; entries: number } | null {
    return this.round
      ? { startedAt: new Date(this.round.startedAt).toISOString(), entries: this.round.entries }
      : null;
  }

  private scheduleContinuation(): void {
    const delay = this.deps.continueAfterMs ?? CONTINUE_AFTER_MS;
    if (delay <= 0) return;
    this.continuation = setTimeout(() => {
      this.continuation = undefined;
      void this.runOnce();
    }, delay);
    this.continuation.unref?.();
  }

  private async run(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const started = now();
    const deadline = started + (this.deps.timeBudgetMs ?? TIME_BUDGET_MS);
    const budget = this.deps.entryBudget ?? ENTRY_BUDGET;
    const root = await (this.deps.lstat ?? lstat)(this.deps.root);
    if (!root.isDirectory()) throw new Error('Data volume root is not a directory');
    if (this.round !== undefined && !this.sameRoot(root)) this.round = undefined;
    if (this.round === undefined) {
      this.round = {
        startedAt: started,
        durationMs: 0,
        entries: 0,
        unreadable: 0,
        approximate: false,
        categories: emptyCategories(),
        unknown: new Map(),
        linked: new Set(),
        stack: [{ path: this.deps.root, segments: [], next: 0 }],
        device: root.dev,
        inode: root.ino,
        born: root.birthtimeMs,
      };
    }
    const round = this.round;
    let visited = 0;
    const endRun = () => {
      round.durationMs += now() - started;
    };
    while (round.stack.length > 0) {
      const top = round.stack[round.stack.length - 1]!;
      if (top.names === undefined) {
        try {
          top.names = (await (this.deps.readdir ?? readdir)(top.path)).sort();
        } catch (error) {
          // Removed or replaced since it was listed: nothing left to count. A
          // vanished root is not an empty volume; the round starts over.
          const code = (error as NodeJS.ErrnoException).code ?? '';
          if (top.segments.length === 0 || ![...SKIPPED, 'ENOENT', 'ENOTDIR'].includes(code))
            throw error;
          // An unreadable directory, such as a sandbox-private home, is reported
          // as unmeasured instead of discarding the whole round.
          if (SKIPPED.includes(code)) round.unreadable++;
          round.stack.pop();
          continue;
        }
      }
      if (top.next >= top.names.length) {
        round.stack.pop();
        continue;
      }
      if (visited >= budget || now() >= deadline || this.shutdown.signal.aborted) {
        endRun();
        return;
      }
      const name = top.names[top.next++]!;
      const path = join(top.path, name);
      const segments = [...top.segments, name];
      visited++;
      round.entries++;
      let stat;
      try {
        stat = await (this.deps.lstat ?? lstat)(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (SKIPPED.includes(code)) round.unreadable++;
        else if (code !== 'ENOENT') throw error;
        continue;
      }
      // Another filesystem mounted inside the volume is not the volume.
      if (stat.dev !== round.device) continue;
      if (!stat.isDirectory() && stat.nlink > 1) {
        const key = `${stat.dev}:${stat.ino}`;
        if (round.linked.has(key)) continue;
        if (round.linked.size < (this.deps.linkedLimit ?? LINKED_LIMIT)) round.linked.add(key);
        else round.approximate = true;
      }
      const bytes = stat.blocks * 512;
      const category = classifyDataVolumePath(segments);
      round.categories[category] += bytes;
      if (category === 'unknown')
        round.unknown.set(segments[0]!, (round.unknown.get(segments[0]!) ?? 0) + bytes);
      // Links are counted as themselves and never followed.
      if (stat.isDirectory()) round.stack.push({ path, segments, next: 0 });
    }
    endRun();
    // A root that vanished or was replaced mid-round left a partial count.
    if (!this.sameRoot(await (this.deps.lstat ?? lstat)(this.deps.root)))
      throw new Error('Data volume root changed during the round');
    this.lastComplete = this.publish(round, now());
    this.round = undefined;
  }

  private sameRoot(stat: { dev: number; ino: number; birthtimeMs: number }): boolean {
    return (
      this.round !== undefined &&
      stat.dev === this.round.device &&
      stat.ino === this.round.inode &&
      stat.birthtimeMs === this.round.born
    );
  }

  private publish(round: Round, at: number): DataVolumeBreakdown {
    const sum = (names: readonly Category[]) =>
      names.reduce((total, name) => total + round.categories[name], 0);
    return {
      startedAt: new Date(round.startedAt).toISOString(),
      observedAt: new Date(at).toISOString(),
      durationMs: round.durationMs,
      entries: round.entries,
      unreadable: round.unreadable,
      approximate: round.approximate,
      categories: { ...round.categories },
      regenerableBytes: sum(REGENERABLE),
      protectedBytes: sum(PROTECTED),
      unknownBytes: round.categories.unknown,
      unknown: [...round.unknown]
        .sort((a, b) => b[1] - a[1])
        .slice(0, UNKNOWN_SHOWN)
        .map(([name, bytes]) => ({ name, bytes })),
    };
  }
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * One sentence for admission refusals and low-disk warnings: what the data
 * volume holds and, given a shortfall, whether reclaiming regenerable data
 * could cover it. Without a finished round it says so; it never reports zero.
 */
export function describeDataVolumeCapacity(
  usage: DataVolumeBreakdown | undefined,
  shortfallBytes?: number,
): string {
  if (usage === undefined) return ' Data volume breakdown is not yet complete.';
  const text =
    ` Data volume as of ${usage.observedAt}: ${gib(usage.regenerableBytes)} regenerable` +
    ` (dependencies and caches), ${gib(usage.protectedBytes)} protected` +
    ` (sources, history, homes, knowledge), ${gib(usage.unknownBytes)} unattributed` +
    (usage.approximate ? ', approximate' : '') +
    (usage.unreadable > 0 ? `; ${String(usage.unreadable)} unreadable entries not measured` : '') +
    '.';
  if (
    shortfallBytes === undefined ||
    shortfallBytes <= 0 ||
    usage.regenerableBytes >= shortfallBytes
  )
    return text;
  const [largest] = (Object.entries(usage.categories) as Array<[Category, number]>)
    .filter(([name]) => !(REGENERABLE as readonly string[]).includes(name))
    .sort((a, b) => b[1] - a[1]);
  return (
    text +
    ` Reclaiming regenerable data-volume content cannot cover the ${gib(shortfallBytes)} shortfall;` +
    ` the largest share is ${largest![0]} (${gib(largest![1])}). Images and build cache are reported separately.`
  );
}
