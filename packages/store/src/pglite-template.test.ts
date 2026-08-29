import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import type { MigrationProvider } from 'kysely/migration';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  TEMPLATE_CACHE_VAR,
  TEMPLATE_MAX_AGE_MS,
  WORK_DIR_MAX_AGE_MS,
  WORK_SUBDIR,
  migrationsFingerprint,
  migratedTemplateDir,
  openTemplate,
  pgliteVersion,
  publishTemplate,
  rawTemplateDir,
  removeStaleDirs,
  resetTemplateCacheForTests,
  templateCacheRoot,
  templatesEnabled,
  tryOpenTemplate,
} from './pglite-template.js';

// Its own cache root, not the container-wide one: these tests build a cluster
// and delete it again, and doing that to the shared cache would make every
// concurrent run pay for an `initdb` it had already paid for.
let cacheRoot: string;

beforeAll(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'pglite-template-test-'));
});

afterAll(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetTemplateCacheForTests();
});

describe('the switches', () => {
  it('is on unless the environment says otherwise', () => {
    expect(templatesEnabled({})).toBe(true);
    expect(templatesEnabled({ VERITY_TEST_PGLITE_TEMPLATE: '1' })).toBe(true);
    expect(templatesEnabled({ VERITY_TEST_PGLITE_TEMPLATE: '0' })).toBe(false);
  });

  it('caches under the home directory by default and where told otherwise', () => {
    expect(templateCacheRoot({})).toMatch(/\.cache\/verity-test-pglite$/u);
    expect(templateCacheRoot({ [TEMPLATE_CACHE_VAR]: '/somewhere' })).toBe('/somewhere');
  });
});

describe('the cache key', () => {
  it('names the pglite version this package depends on', () => {
    // Against this package's own manifest, not the installed one: pglite's
    // `exports` map does not publish `./package.json`, which is the whole reason
    // `pgliteVersion` resolves the entry point and walks up to the package root
    // instead of importing the manifest. Comparing to the declared version works
    // because this repo pins exactly — a range here would need the resolved
    // version, and there would be no second way to read it.
    const declared = (
      JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
      ) as { devDependencies: Record<string, string> }
    ).devDependencies['@electric-sql/pglite'];
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(pgliteVersion()).toBe(declared);
  });

  it('changes when a migration body changes, not just when a name does', async () => {
    const provider = (migrations: Record<string, () => Promise<void>>): MigrationProvider => ({
      getMigrations: () =>
        Promise.resolve(
          Object.fromEntries(Object.entries(migrations).map(([k, up]) => [k, { up }])),
        ),
    });
    const before = await migrationsFingerprint(provider({ '0001': () => Promise.resolve() }));

    expect(await migrationsFingerprint(provider({ '0001': () => Promise.resolve() }))).toBe(before);
    // Same name, different body — the stale-template case, and the only one a
    // name-only key would miss.
    expect(
      await migrationsFingerprint(
        provider({
          '0001': async () => {
            await Promise.resolve(1);
          },
        }),
      ),
    ).not.toBe(before);
    expect(await migrationsFingerprint(provider({ '0002': () => Promise.resolve() }))).not.toBe(
      before,
    );
  });

  it('does not depend on the order the provider lists migrations in', async () => {
    const a = { up: () => Promise.resolve() };
    const b = {
      up: async () => {
        await Promise.resolve(1);
      },
    };
    const forwards: MigrationProvider = {
      getMigrations: () => Promise.resolve({ '0001': a, '0002': b }),
    };
    const backwards: MigrationProvider = {
      getMigrations: () => Promise.resolve({ '0002': b, '0001': a }),
    };
    expect(await migrationsFingerprint(forwards)).toBe(await migrationsFingerprint(backwards));
  });
});

describe('publishing a freshly built template', () => {
  it('renames it into place', () => {
    const scratch = mkdtempSync(join(cacheRoot, 'scratch-'));
    const final = join(cacheRoot, 'published');
    publishTemplate(scratch, final);
    expect(existsSync(final)).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  it('discards its own copy when another worker published first', () => {
    // The expected outcome for every worker but one. The winner's cluster is as
    // good as this one's, so losing has to be silent — an exception here would
    // fail a test file for winning a race it did not know it was in.
    const final = join(cacheRoot, 'contended');
    mkdirSync(join(final, 'base'), { recursive: true });
    const scratch = mkdtempSync(join(cacheRoot, 'scratch-'));
    mkdirSync(join(scratch, 'base'));

    expect(() => publishTemplate(scratch, final)).not.toThrow();
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(final)).toBe(true);
  });

  it('reports a failure that left nothing behind', () => {
    // Distinct from losing the race: nothing is at the destination, so the
    // caller has no template and swallowing this would hide a broken cache.
    const scratch = mkdtempSync(join(cacheRoot, 'scratch-'));
    expect(() => publishTemplate(scratch, join(cacheRoot, 'no', 'such', 'parent'))).toThrow();
  });
});

describe('sweeping what the cache leaks', () => {
  const aged = (path: string, ms: number): void => {
    mkdirSync(path, { recursive: true });
    const when = new Date(Date.now() - ms);
    utimesSync(path, when, when);
  };

  it('removes the old candidates and leaves the live ones alone', () => {
    const parent = mkdtempSync(join(cacheRoot, 'sweep-'));
    aged(join(parent, 'db-fresh'), 0);
    aged(join(parent, 'db-stale'), 8 * 24 * 60 * 60 * 1000);

    removeStaleDirs(parent, () => true, WORK_DIR_MAX_AGE_MS);

    expect(existsSync(join(parent, 'db-fresh'))).toBe(true);
    expect(existsSync(join(parent, 'db-stale'))).toBe(false);
  });

  it('leaves alone what the predicate does not name, however old it is', () => {
    // The predicate is the only thing standing between this and the `work`
    // directory, whose entries have their own much shorter lifetime.
    const parent = mkdtempSync(join(cacheRoot, 'sweep-'));
    aged(join(parent, 'migrated-v1-0.0.0-abc'), 30 * 24 * 60 * 60 * 1000);
    aged(join(parent, WORK_SUBDIR), 30 * 24 * 60 * 60 * 1000);

    removeStaleDirs(parent, (name) => name.startsWith('migrated-'), TEMPLATE_MAX_AGE_MS);

    expect(existsSync(join(parent, 'migrated-v1-0.0.0-abc'))).toBe(false);
    expect(existsSync(join(parent, WORK_SUBDIR))).toBe(true);
  });

  it('survives an empty directory, a plain file, and one that vanishes mid-sweep', () => {
    const parent = mkdtempSync(join(cacheRoot, 'sweep-'));
    expect(() => removeStaleDirs(parent, () => true, 0)).not.toThrow();
    writeFileSync(join(parent, 'not-a-directory'), '');
    // A directory removed by its owner between the listing and the stat is the
    // normal shape of the race, and is nothing to report.
    const doomed = join(parent, 'db-doomed');
    mkdirSync(doomed);
    rmSync(doomed, { recursive: true });
    expect(() => removeStaleDirs(parent, () => true, 0)).not.toThrow();
    expect(existsSync(join(parent, 'not-a-directory'))).toBe(true);
  });
});

describe('the template itself', () => {
  it('builds a cluster once and hands out independent copies of it', async () => {
    vi.stubEnv(TEMPLATE_CACHE_VAR, cacheRoot);
    const template = rawTemplateDir();
    // Not a conditional skip: a sandbox that cannot build this falls back to the
    // old path silently, and a test that quietly agreed would be the only thing
    // between that fallback and nobody noticing it became permanent.
    expect(template).toBeDefined();
    expect(existsSync(join(template as string, 'PG_VERSION'))).toBe(true);

    const first = openTemplate(template as string);
    const second = openTemplate(template as string);
    try {
      // Two working copies of one template are two databases, not two handles on
      // the same one — the property that makes a copy-per-file correct at all.
      await sql`create table only_in_the_first (id int)`.execute(first.db);
      await expect(sql`select * from only_in_the_first`.execute(second.db)).rejects.toThrow();
    } finally {
      await first.close();
      await second.close();
    }

    // And neither handle wrote through to the template: a copy opened after
    // both were closed still has the pristine catalog.
    const fresh = openTemplate(template as string);
    try {
      await expect(sql`select * from only_in_the_first`.execute(fresh.db)).rejects.toThrow();
    } finally {
      await fresh.close();
    }

    // `close` takes the working copy with it; nothing accumulates per test file.
    expect(readdirSync(join(cacheRoot, 'work'))).toEqual([]);
  }, 120_000);

  it('answers with nothing at all when it is switched off', () => {
    vi.stubEnv(TEMPLATE_CACHE_VAR, cacheRoot);
    vi.stubEnv('VERITY_TEST_PGLITE_TEMPLATE', '0');
    expect(rawTemplateDir()).toBeUndefined();
  });

  it('persists a migrated template and reuses it without migrating again', async () => {
    vi.stubEnv(TEMPLATE_CACHE_VAR, cacheRoot);
    let migrations = 0;
    const template = await migratedTemplateDir(async (db) => {
      migrations += 1;
      await sql`create table migrated_template_marker (id int)`.execute(db);
    });
    expect(template).toBeDefined();
    expect(migrations).toBe(1);

    const opened = openTemplate(template as string);
    try {
      await expect(
        sql`select * from migrated_template_marker`.execute(opened.db),
      ).resolves.toBeDefined();
    } finally {
      await opened.close();
    }

    resetTemplateCacheForTests();
    expect(
      await migratedTemplateDir(() => {
        throw new Error('an existing template must not migrate again');
      }),
    ).toBe(template);
  });

  it('falls back cleanly when building the migrated template fails', async () => {
    const failingRoot = mkdtempSync(join(cacheRoot, 'failed-migration-'));
    vi.stubEnv(TEMPLATE_CACHE_VAR, failingRoot);
    expect(
      await migratedTemplateDir(() => Promise.reject(new Error('migration failed'))),
    ).toBeUndefined();
    expect(readdirSync(failingRoot).filter((name) => name.includes('building'))).toEqual([]);
  });

  it('preserves the fallback when a template cannot be copied', () => {
    vi.stubEnv(TEMPLATE_CACHE_VAR, cacheRoot);
    expect(tryOpenTemplate(join(cacheRoot, 'missing-template'))).toBeUndefined();
    expect(readdirSync(join(cacheRoot, WORK_SUBDIR))).toEqual([]);
  });
});
