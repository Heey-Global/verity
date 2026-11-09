import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { InvalidProjectNameError, PROJECT_NAME_MAX_CHARS } from './store.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

it('names a new project by what it was created as, unless a name is given', async () => {
  const repository = await ctx.store.upsertProject({
    id: 'repository',
    owner: 'Team',
    repo: 'Site',
    containerName: 'site',
    state: 'absent',
  });
  expect(repository.name).toBe('site');
  const local = await ctx.store.createProject({
    id: 'local',
    owner: 'local',
    repo: 'kundenportal',
    containerName: 'local-kundenportal',
    kind: 'local',
    state: 'absent',
    name: 'Kundenportal',
  });
  expect(local.name).toBe('Kundenportal');
});

it('renames only the name and keeps the identity behind it', async () => {
  const before = await ctx.store.upsertProject({
    id: 'p',
    owner: 'team',
    repo: 'site',
    containerName: 'site',
    state: 'active',
  });
  const renamed = await ctx.store.renameProject('p', '  Übersetzungen und Website  ');
  expect(renamed?.name).toBe('Übersetzungen und Website');
  expect(renamed).toMatchObject({
    id: before.id,
    owner: before.owner,
    repo: before.repo,
    containerName: before.containerName,
    cloneDir: before.cloneDir,
    kind: before.kind,
  });
  // A repository sync upserts the same project again; it must not take the
  // name back to the repository's.
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'team',
    repo: 'site',
    containerName: 'site',
    state: 'absent',
  });
  expect((await ctx.store.getProject('p'))?.name).toBe('Übersetzungen und Website');
  expect((await ctx.store.listProjects()).find((project) => project.id === 'p')?.name).toBe(
    'Übersetzungen und Website',
  );
});

it('allows the same name twice and refuses an empty or overlong one', async () => {
  for (const id of ['a', 'b'])
    await ctx.store.upsertProject({
      id,
      owner: 'team',
      repo: `repo-${id}`,
      containerName: id,
      state: 'absent',
    });
  await ctx.store.renameProject('a', 'Website');
  expect((await ctx.store.renameProject('b', 'Website'))?.name).toBe('Website');
  await expect(ctx.store.renameProject('a', '   ')).rejects.toBeInstanceOf(InvalidProjectNameError);
  await expect(
    ctx.store.renameProject('a', 'x'.repeat(PROJECT_NAME_MAX_CHARS + 1)),
  ).rejects.toBeInstanceOf(InvalidProjectNameError);
  // Counted in characters, not UTF-16 units: a full-length name of umlauts fits.
  expect((await ctx.store.renameProject('a', 'ü'.repeat(PROJECT_NAME_MAX_CHARS)))?.name).toBe(
    'ü'.repeat(PROJECT_NAME_MAX_CHARS),
  );
  expect(await ctx.store.renameProject('missing', 'Name')).toBeUndefined();
});

it('gives every existing project the name it was shown under', async () => {
  const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
  try {
    expect((await migrator.migrateTo('0203_trusted_cli_output_listing')).error).toBeUndefined();
    await sql`insert into projects
      (id, owner, repo, container_name, kind, state, overview_visible)
      values ('repo', 'heey-global', 'verity', 'verity', 'github', 'absent', true),
             ('local', 'local', 'kundenportal', 'kundenportal', 'local', 'absent', true)`.execute(
      ctx.db,
    );
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect((await ctx.store.getProject('repo'))?.name).toBe('verity');
    expect((await ctx.store.getProject('local'))?.name).toBe('kundenportal');
  } finally {
    await migrator.migrateToLatest();
  }
});
