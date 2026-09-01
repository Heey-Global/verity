import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql, type Kysely } from 'kysely';

import { migrationProvider } from './migrations.js';
import { createEmbeddedDb } from './pglite.js';
import type { Database } from './schema.js';

/**
 * Pre-built pglite clusters on disk, so a test file opens a PostgreSQL instead
 * of building one.
 *
 * The cost this removes is `initdb`, and it is much larger than it looks.
 * pglite is real PostgreSQL compiled to WebAssembly, and a WASM module has one
 * linear memory that holds its heap AND its emulated filesystem — so building a
 * cluster builds PGDATA inside that memory, and a `WebAssembly.Memory` only ever
 * grows. Measured in this repo's sandbox (2 cores, 4 GiB), one call to
 * `createEmbeddedDb()`:
 *
 * | | wall | RSS |
 * |---|---|---|
 * | in-memory, `initdb` + 85 migrations | ~5.5 s | 1026 MiB |
 * | on-disk dataDir, `initdb` + 85 migrations | 5.2 s | 718 MiB |
 * | on-disk dataDir, pre-built: copy + open | 0.7 s | 387 MiB |
 *
 * 645 of those 1026 MiB are spent before the first migration runs — that is the
 * empty cluster plus the `initdb` machinery that produced it, not this repo's
 * schema. `close()` and `destroy()` give none of it back, because nothing can
 * shrink a linear memory; only losing the whole instance to the garbage
 * collector does, and the peak has already happened by then. Multiply by the
 * files that take this path and it is the single largest term in the suite's
 * memory.
 *
 * Two templates, because the two callers want different things:
 * `createRawDb()` wants a cluster with no migration table, `createIsolatedTestDb()`
 * wants one migrated to head. Both live in a container-wide cache and survive
 * across runs, so the build cost is paid once per machine per schema change
 * rather than once per run — which is why this needs no `globalSetup` hook and
 * is independent of whether a shared PostgreSQL is available.
 *
 * Every entry point here returns `undefined` rather than throwing. The caller's
 * fallback is the unchanged `createEmbeddedDb()` path, so a read-only home
 * directory, a full disk, or a pglite upgrade this cache has never seen costs
 * speed and nothing else.
 */

/**
 * Bumped when the layout of the cache directory changes, NOT when a migration
 * does — the migrated template carries its own fingerprint below.
 */
const TEMPLATE_FORMAT = 'v1';

/** Overridable so tests can point the cache somewhere disposable. */
export const TEMPLATE_CACHE_VAR = 'VERITY_TEST_PGLITE_CACHE';

/**
 * Set to `0` to build every cluster from scratch again.
 *
 * An escape hatch for exactly one situation: a suspicion that a cached template
 * differs from what `initdb` and the migrations would produce right now. There
 * is no known way for that to happen — the cache key covers the pglite version
 * and every migration body — but the whole point of this module is to be
 * skippable, and a developer chasing a phantom should not have to find this file
 * to skip it.
 */
const TEMPLATE_ENABLED_VAR = 'VERITY_TEST_PGLITE_TEMPLATE';

/**
 * How long a working copy may sit around before it is assumed abandoned.
 *
 * Directory mtimes do not change when PostgreSQL edits files below them, so
 * this must comfortably exceed even a test process left open for debugging.
 * Abandoned copies cost ~40 MB; deleting a live database is much worse.
 */
export const WORK_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Building a cluster takes seconds; this only has to catch a wedged one. */
const BUILD_TIMEOUT_MS = 120_000;

/**
 * How long an unused template is kept.
 *
 * Templates are keyed by migration fingerprint, so every schema change strands
 * the previous one — 40 MB each, in a cache shared by every session in the
 * container, with nothing that would ever remove them. Age is measured from last
 * use, not from creation: {@link openTemplate} touches the directory it copies
 * from, so a template still in daily use is never a candidate however old it is.
 */
export const TEMPLATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a half-built template is kept. Comfortably past the point where the
 * build that owns it would have been killed for running too long.
 */
const SCRATCH_MAX_AGE_MS = 2 * BUILD_TIMEOUT_MS;

/** Scratch directories, mid-build. Skipped by every lookup; swept when stale. */
const SCRATCH_PREFIX = '.building-';

/** Atomically created beside the template while one process builds it. */
const BUILD_LOCK_SUFFIX = '.building-lock';

const waitCell = new Int32Array(new SharedArrayBuffer(4));

/** Working copies, one per live database. */
export const WORK_SUBDIR = 'work';

/**
 * The child that runs `initdb`, as source rather than as a file on disk.
 *
 * It runs in its own process for the reason the module comment gives: the memory
 * a cluster build consumes is not returned when the build finishes, so a build
 * done in-process would leave a worker several hundred megabytes heavier for the
 * rest of the run. A process that exits gives all of it back, unconditionally.
 *
 * Inline via `node -e` and not a `.mjs` file next to this one because this module
 * is compiled: the sibling would have to be copied into `dist/` by a build step
 * that does not exist today, and would go missing in exactly the environment
 * nobody tests. It needs nothing from this repo — pglite is a plain JavaScript
 * package — so there is nothing here that a file would make more readable.
 */
const BUILD_RAW_CLUSTER = `
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite(process.argv[1]);
await db.waitReady;
await db.close();
`;

/** Bare specifiers in the child resolve from here. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const require_ = createRequire(import.meta.url);

/** Memoized per process. `isolate: true` gives each test file a fresh registry. */
let rawTemplate: { dir: string | undefined } | undefined;
let migratedTemplate: Promise<string | undefined> | undefined;
let sweptCacheRoot: string | undefined;

export function templatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TEMPLATE_ENABLED_VAR] !== '0';
}

/**
 * Where templates and working copies live.
 *
 * Under the home directory rather than the repository, and deliberately shared
 * by every session in the container: several Verity sessions run in one sandbox
 * out of separate worktrees, and a per-worktree cache would have each of them
 * build and store its own copy of an identical cluster. The fingerprint in the
 * directory name is what keeps two worktrees on different migrations apart.
 */
export function templateCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[TEMPLATE_CACHE_VAR] ?? join(homedir(), '.cache', 'verity-test-pglite');
}

/**
 * The installed pglite version, or `undefined` if it cannot be established.
 *
 * Part of every template's name. PGDATA is a versioned on-disk format, and a
 * pglite upgrade that changes it would otherwise be met with a cluster the new
 * binary refuses to open — a failure a long way from its cause, in a cache
 * nobody remembers exists. Not being able to read the version disables the
 * cache rather than defaulting to a constant, because a constant is precisely
 * the collision this avoids.
 */
export function pgliteVersion(): string | undefined {
  try {
    let dir = dirname(require_.resolve('@electric-sql/pglite'));
    // Up from the resolved entry point (`dist/index.cjs`) to the package root.
    // Bounded rather than `while (true)`: a symlinked or oddly nested install
    // should give up and disable the cache, not walk to `/`.
    for (let depth = 0; depth < 5; depth += 1) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name === '@electric-sql/pglite' && typeof parsed.version === 'string') {
          return parsed.version.replace(/[^0-9A-Za-z.-]/g, '-');
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Falls through to `undefined`: no version, no cache.
  }
  return undefined;
}

/**
 * A digest of the migrations as they exist in this build.
 *
 * Over the function bodies, not just the names: a migration edited in place
 * keeps its name, and a template built from the old body would then be handed to
 * tests asserting the new one — the stale-cache failure, arriving silently.
 * `Function.prototype.toString()` returns the source the loader actually
 * evaluated, so it tracks edits without this module knowing where migrations are
 * stored or how they got here.
 */
export async function migrationsFingerprint(provider = migrationProvider): Promise<string> {
  const migrations = await provider.getMigrations();
  const hash = createHash('sha256');
  for (const name of Object.keys(migrations).sort((a, b) => a.localeCompare(b))) {
    // The source text is the point: this reference is stringified, never
    // called, so there is no `this` for it to lose.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const up: unknown = migrations[name]?.up;
    hash.update(name).update('\0').update(String(up)).update('\0');
  }
  // Some migrations delegate data changes to helpers imported from store.ts.
  // Their function text above only contains the call, so changing a helper
  // would otherwise keep the old template even though rerunning the migration
  // would produce different data. Hash the two implementation units as well.
  // Source runs have .ts siblings; compiled runs have .js siblings.
  for (const stem of ['migrations', 'store']) {
    const implementation = [`${stem}.ts`, `${stem}.js`]
      .map((name) => join(MODULE_DIR, name))
      .find((path) => existsSync(path));
    if (implementation !== undefined) hash.update(readFileSync(implementation)).update('\0');
  }
  // Kysely compiles the schema-builder calls above into SQL. A dependency
  // update can therefore change a migration without changing repository source.
  // The workspace lockfile is the reproducible description of that input.
  const lockfile = join(MODULE_DIR, '..', '..', '..', 'package-lock.json');
  if (existsSync(lockfile)) hash.update(readFileSync(lockfile)).update('\0');
  return hash.digest('hex').slice(0, 16);
}

/**
 * Move a freshly built template to the name others will look it up by.
 *
 * Built under a scratch name and renamed because the lookup is `existsSync`:
 * building in place would publish a half-written cluster the moment the
 * directory appeared, and the second worker would open it. Rename is atomic, so
 * a template is either absent or complete.
 *
 * Losing the race is the expected outcome for all but one worker and is not an
 * error — the winner's template is as good as ours, so ours is discarded. A
 * failure with nothing at the destination is a real failure and is rethrown.
 */
export function publishTemplate(scratch: string, final: string): void {
  try {
    renameSync(scratch, final);
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    if (!existsSync(final)) throw error;
  }
}

/**
 * Become the only builder for `final`, or wait for the current builder.
 *
 * `mkdir` is the cross-process compare-and-set available on every filesystem
 * this cache can live on. A process killed while holding it leaves a directory;
 * once older than the build timeout, the next contender removes and replaces
 * it. Waiting is synchronous because the raw-template caller is synchronous and
 * every Vitest worker is a separate process — blocking this worker cannot block
 * the owner that is doing the build.
 */
function claimTemplateBuild(final: string): number | false | undefined {
  const lock = `${final}${BUILD_LOCK_SUFFIX}`;
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  for (;;) {
    if (existsSync(final)) return false;
    try {
      mkdirSync(lock);
      return statSync(lock).ino;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > BUILD_TIMEOUT_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The owner may have released it between mkdir/stat, or the cache entry
        // may be unreadable. Fall through to the bounded wait either way; an
        // inaccessible entry must not turn this retry loop into a CPU spin.
      }
    }
    if (Date.now() >= deadline) return undefined;
    Atomics.wait(waitCell, 0, 0, 100);
  }
}

function releaseTemplateBuild(final: string, claim: number): void {
  const lock = `${final}${BUILD_LOCK_SUFFIX}`;
  try {
    // A timed-out contender may have replaced a stale lock. The old owner must
    // not remove that new owner's lock when it eventually unwinds.
    if (statSync(lock).ino === claim) rmSync(lock, { recursive: true, force: true });
  } catch {
    // Already released or replaced.
  }
}

/**
 * Remove directories under `parent` that `isCandidate` names and that nothing
 * has touched for `maxAgeMs`.
 *
 * By age rather than by ownership because there is nothing to ask: whatever a
 * killed run — Ctrl-C, an OOM kill, a crashed worker — left behind, the process
 * that made it is gone. Every removal is individually guarded: losing a race
 * against the owner of an entry is the normal shape of a shared cache, and the
 * next sweep will find it again if it really is abandoned.
 */
export function removeStaleDirs(
  parent: string,
  isCandidate: (name: string) => boolean,
  maxAgeMs: number,
  now: number = Date.now(),
): void {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isCandidate(entry.name)) continue;
    const path = join(parent, entry.name);
    try {
      if (now - statSync(path).mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Raced with its owner, or is not ours to remove.
    }
  }
}

/**
 * Everything this cache can leak, removed once per process.
 *
 * Three separate lifetimes, because they leak for three different reasons: a
 * working copy outlives the test file that opened it only if that file's process
 * died, a scratch directory outlives its build only if the build died, and a
 * template outlives its usefulness the moment a migration is added. Nothing else
 * in the container is going to clean any of them up.
 */
function sweepCacheOnce(root: string): void {
  if (sweptCacheRoot === root) return;
  sweptCacheRoot = root;
  try {
    removeStaleDirs(root, (name) => name.startsWith(SCRATCH_PREFIX), SCRATCH_MAX_AGE_MS);
    removeStaleDirs(
      root,
      (name) => name.startsWith('raw-') || name.startsWith('migrated-'),
      TEMPLATE_MAX_AGE_MS,
    );
    const workRoot = join(root, WORK_SUBDIR);
    if (existsSync(workRoot)) removeStaleDirs(workRoot, () => true, WORK_DIR_MAX_AGE_MS);
  } catch {
    // A cache that cannot be swept still works; it only grows.
  }
}

/**
 * The template of a cluster that has had `initdb` run and nothing else — what
 * `createRawDb()` hands out.
 */
export function rawTemplateDir(): string | undefined {
  rawTemplate ??= { dir: buildRawTemplateDir() };
  return rawTemplate.dir;
}

function buildRawTemplateDir(): string | undefined {
  if (!templatesEnabled()) return undefined;
  const version = pgliteVersion();
  if (version === undefined) return undefined;
  let scratch: string | undefined;
  try {
    const root = templateCacheRoot();
    mkdirSync(root, { recursive: true });
    sweepCacheOnce(root);
    const final = join(root, `raw-${TEMPLATE_FORMAT}-${version}`);
    const claimed = claimTemplateBuild(final);
    if (claimed === false) return final;
    if (claimed === undefined) return undefined;
    try {
      scratch = mkdtempSync(join(root, SCRATCH_PREFIX));
      execFileSync(process.execPath, ['--input-type=module', '-e', BUILD_RAW_CLUSTER, scratch], {
        cwd: MODULE_DIR,
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: BUILD_TIMEOUT_MS,
      });
      publishTemplate(scratch, final);
      scratch = undefined;
      return final;
    } finally {
      releaseTemplateBuild(final, claimed);
    }
  } catch {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    return undefined;
  }
}

/**
 * The template of a cluster migrated to head — what `createIsolatedTestDb()`
 * hands out.
 *
 * Built from a copy of the raw template rather than from scratch, so the
 * `initdb` half still happens in the child process that gives its memory back.
 * The migrations themselves have to run in this process — they are this repo's
 * TypeScript, and there is no runner a child could use to reach them — so a
 * worker that builds this one does carry the cluster's memory for the rest of
 * the run. That is the whole cost, it lands on one worker, and it lands only on
 * the first run after a migration changes.
 */
export async function migratedTemplateDir(
  migrate: (db: Kysely<Database>) => Promise<void>,
): Promise<string | undefined> {
  migratedTemplate ??= buildMigratedTemplateDir(migrate);
  return await migratedTemplate;
}

async function buildMigratedTemplateDir(
  migrate: (db: Kysely<Database>) => Promise<void>,
): Promise<string | undefined> {
  const raw = rawTemplateDir();
  if (raw === undefined) return undefined;
  const version = pgliteVersion();
  if (version === undefined) return undefined;
  let scratch: string | undefined;
  try {
    const root = templateCacheRoot();
    const fingerprint = await migrationsFingerprint();
    const final = join(root, `migrated-${TEMPLATE_FORMAT}-${version}-${fingerprint}`);
    const claimed = claimTemplateBuild(final);
    if (claimed === false) return final;
    if (claimed === undefined) return undefined;
    try {
      scratch = mkdtempSync(join(root, SCRATCH_PREFIX));
      copyTree(raw, scratch);
      const db = createEmbeddedDb(scratch);
      try {
        // `createEmbeddedDb` returns before PGlite's asynchronous startup has
        // settled. Most migration callbacks issue SQL immediately and therefore
        // await it implicitly, but a callback that rejects before its first query
        // would let the catch below remove PGDATA while startup still reads it.
        // That late filesystem failure surfaces as an unhandled ErrnoError after
        // every assertion passed. Make readiness explicit before handing control
        // to either a real migrator or a failing test callback.
        await sql`select 1`.execute(db);
        await migrate(db);
      } finally {
        // The shutdown checkpoint is what makes the directory openable again:
        // without it the next process to open this template replays WAL, which
        // works but is neither free nor something a template should ever need.
        await db.destroy();
      }
      publishTemplate(scratch, final);
      scratch = undefined;
      return final;
    } finally {
      releaseTemplateBuild(final, claimed);
    }
  } catch {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    return undefined;
  }
}

/**
 * `COPYFILE_FICLONE` asks the filesystem for a copy-on-write clone and silently
 * copies where that is not supported, so this is free on btrfs/XFS and a
 * ~40 MB read-write elsewhere. It cannot be a hardlink: PostgreSQL rewrites
 * pages in place, so a linked working copy would edit the template.
 */
function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
}

/**
 * A private, writable copy of `template`, and the `close` that removes it again.
 */
export function openTemplate(template: string): {
  db: Kysely<Database>;
  close: () => Promise<void>;
} {
  const root = templateCacheRoot();
  const workRoot = join(root, WORK_SUBDIR);
  mkdirSync(workRoot, { recursive: true });
  sweepCacheOnce(root);
  try {
    // What makes {@link TEMPLATE_MAX_AGE_MS} an idle timer rather than a
    // lifetime. Failing is fine — a cache nobody can write to is a cache nobody
    // can evict from either.
    const now = new Date();
    utimesSync(template, now, now);
  } catch {
    // Not ours to touch.
  }
  const dir = mkdtempSync(join(workRoot, 'db-'));
  let db: Kysely<Database>;
  try {
    copyTree(template, dir);
    db = createEmbeddedDb(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    db,
    close: async () => {
      try {
        await db.destroy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Open a template when the cache is usable, otherwise preserve the in-memory
 * fallback promised by this module. Copy failures are environmental (a full or
 * read-only disk), not test failures.
 */
export function tryOpenTemplate(template: string): ReturnType<typeof openTemplate> | undefined {
  try {
    return openTemplate(template);
  } catch {
    return undefined;
  }
}

/** Test seam: drops the per-process memoization. */
export function resetTemplateCacheForTests(): void {
  rawTemplate = undefined;
  migratedTemplate = undefined;
  sweptCacheRoot = undefined;
}
