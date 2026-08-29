import { Kysely, sql } from 'kysely';
import { Migrator, NO_MIGRATIONS, type MigrationProvider } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import { createPostgresDb, migrateToLatest } from './db.js';
import { latestMigrationKey, migrationProvider } from './migrations.js';
import type { Database } from './schema.js';
import { createIsolatedTestDb, createRawDb } from './testing.js';

async function seedProject(
  db: Kysely<Database>,
  project: {
    id: string;
    owner: string;
    repo: string;
    containerName: string;
    state: string;
  },
): Promise<void> {
  await sql`
    insert into projects (id, owner, repo, container_name, state)
    values (
      ${project.id},
      ${project.owner},
      ${project.repo},
      ${project.containerName},
      ${project.state}
    )
  `.execute(db);
}

describe('createPostgresDb', () => {
  it('builds a Kysely instance without connecting', async () => {
    // pg.Pool is lazy — no connection is opened until the first query.
    const db = createPostgresDb('postgresql://user:pw@localhost:5432/verity');
    expect(db).toBeInstanceOf(Kysely);
    await db.destroy();
  });
});

describe('migrateToLatest', () => {
  it('is idempotent — a second run is a no-op and does not throw', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      // createIsolatedTestDb already migrated once; running again must be safe.
      await expect(migrateToLatest(ctx.db)).resolves.toBeUndefined();
      // schema is usable afterwards
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt', model: 'm' });
      expect(await ctx.store.getSession('s1')).toBeDefined();
    } finally {
      await ctx.close();
    }
  });

  it('throws when a migration fails (never half-migrates)', async () => {
    const { db, close } = createRawDb();
    try {
      const failing: MigrationProvider = {
        getMigrations: () =>
          Promise.resolve({
            '0001_boom': {
              up: () => Promise.reject(new Error('boom in migration')),
              down: () => Promise.resolve(),
            },
          }),
      };
      await expect(migrateToLatest(db, failing)).rejects.toThrow(/boom in migration/);
    } finally {
      await close();
    }
  });

  // ADR 0008 D9: release N advances the schema, and a candidate that fails its
  // readiness window is rolled back onto N−1, which then has to START against
  // the database N already migrated. Kysely refuses that outright, so until the
  // promise below was honoured here no release that added a single migration was
  // rollback-safe — which is what the live self-update smoke caught on
  // `0083_drop_local_transcribe_backend_mode` against the published v13.2.12.
  describe('a database ahead of this build', () => {
    /** Write a ledger row for a generation this build does not carry. */
    const recordAhead = async (db: Kysely<Database>, name: string): Promise<void> => {
      await sql`
        insert into kysely_migration (name, timestamp)
        values (${name}, ${new Date().toISOString()})
      `.execute(db);
    };

    const ledgerSize = async (db: Kysely<Database>): Promise<number> =>
      (await sql<{ name: string }>`select name from kysely_migration`.execute(db)).rows.length;

    /**
     * True while THIS session holds Kysely's migration lock.
     *
     * The two halves are `kysely/dist/dialect/postgres/postgres-adapter.js`'s
     * `LOCK_ID = 3853314791062309107n`, which `pg_locks` splits into `classid`
     * (high 32 bits) and `objid` (low 32 bits) for a bigint advisory lock. Pinned
     * to that exact lock rather than to `locktype = 'advisory'`: Verity takes
     * advisory locks of its own (the control-plane one in this same file), and a
     * test that accepted any of them would keep passing if the migration lock
     * were the one that went missing.
     */
    const holdsMigrationLock = async (db: Kysely<Database>): Promise<boolean> =>
      (
        await sql<{ held: boolean }>`
          select exists (
            select 1 from pg_locks
            where locktype = 'advisory' and classid = 897169763 and objid = 17238259
              and pid = pg_backend_pid() and granted
          ) as held
        `.execute(db)
      ).rows[0]?.held === true;

    /**
     * Run `migrateToLatest` with a provider that records whether the migration
     * lock was held each time Kysely asked it for the migration set — which is
     * the moment the forward-compatibility decision reads the ledger, because
     * that decision lives inside the provider for exactly this reason.
     */
    const observeLockAtDecision = async (
      db: Kysely<Database>,
      options: Parameters<typeof migrateToLatest>[2],
    ): Promise<{ readonly locked: boolean[]; readonly failure: unknown }> => {
      const locked: boolean[] = [];
      const provider: MigrationProvider = {
        getMigrations: async () => {
          locked.push(await holdsMigrationLock(db));
          return await migrationProvider.getMigrations();
        },
      };
      const failure = await migrateToLatest(db, provider, options).then(
        () => undefined,
        (error: unknown) => error,
      );
      return { locked, failure };
    };

    it('refuses it when the build promised nothing', async () => {
      const ctx = await createIsolatedTestDb();
      try {
        await recordAhead(ctx.db, '9998_from_a_newer_release');
        await expect(migrateToLatest(ctx.db)).rejects.toThrow(
          'database schema generation "9998_from_a_newer_release" is newer than this ' +
            `build's maximum readable generation "${latestMigrationKey()}"`,
        );
      } finally {
        await ctx.close();
      }
    });

    it('starts on it when the build promised that exact generation', async () => {
      const ctx = await createIsolatedTestDb();
      try {
        const before = await ledgerSize(ctx.db);
        await recordAhead(ctx.db, '9998_from_a_newer_release');
        await expect(
          migrateToLatest(ctx.db, migrationProvider, {
            forwardMax: '9998_from_a_newer_release',
          }),
        ).resolves.toBeUndefined();
        // Tolerated, not applied: the promise lets the build read the database,
        // it never lets it write a generation it does not carry.
        expect(await ledgerSize(ctx.db)).toBe(before + 1);
      } finally {
        await ctx.close();
      }
    });

    it('refuses a generation past the promise', async () => {
      const ctx = await createIsolatedTestDb();
      try {
        await recordAhead(ctx.db, '9999_two_releases_on');
        await expect(
          migrateToLatest(ctx.db, migrationProvider, {
            forwardMax: '9998_from_a_newer_release',
          }),
        ).rejects.toThrow(
          'database schema generation "9999_two_releases_on" is newer than this ' +
            'build\'s maximum readable generation "9998_from_a_newer_release"',
        );
      } finally {
        await ctx.close();
      }
    });

    // The rest of this block asserts WHAT is decided. These two assert WHERE,
    // which is the half that makes the decision sound: a newer generation that is
    // mid-migration holds Kysely's migration lock for its whole batch, so a
    // decision taken under that same lock cannot observe a half-applied schema,
    // and one taken before the migrator can. Accepting a partially migrated
    // database is strictly worse than the crash loop this mechanism removes — the
    // crash loop is loud and self-healing; a Server serving on half-applied
    // structures is neither.
    it('takes the accepting decision while holding the migration lock', async () => {
      const ctx = await createIsolatedTestDb();
      try {
        await recordAhead(ctx.db, '9998_from_a_newer_release');
        const { locked, failure } = await observeLockAtDecision(ctx.db, {
          forwardMax: '9998_from_a_newer_release',
        });
        expect(failure).toBeUndefined();
        expect(locked).toEqual([true]);
        // Kysely releases in a `finally`, so a run that decided under the lock
        // must not still be holding it.
        expect(await holdsMigrationLock(ctx.db)).toBe(false);
      } finally {
        await ctx.close();
      }
    });

    it('takes the refusing decision while holding the migration lock, and releases it', async () => {
      const ctx = await createIsolatedTestDb();
      try {
        await recordAhead(ctx.db, '9999_two_releases_on');
        const { locked, failure } = await observeLockAtDecision(ctx.db, {
          forwardMax: '9998_from_a_newer_release',
        });
        expect((failure as Error).message).toContain('"9999_two_releases_on" is newer than');
        expect(locked).toEqual([true]);
        // A refusal that stranded the lock would wedge every later Server start.
        expect(await holdsMigrationLock(ctx.db)).toBe(false);
      } finally {
        await ctx.close();
      }
    });

    it('judges a multi-generation batch by its newest row, not its oldest', async () => {
      const ctx = await createIsolatedTestDb();
      try {
        // The shape a partially-observed batch presents: the head is inside the
        // promise, the tail is not. Accepting on the strength of the head is the
        // "starts against a partially migrated schema" bug in its observable
        // form, so the newest row has to be what the promise is compared against.
        await recordAhead(ctx.db, '9998_from_a_newer_release');
        await recordAhead(ctx.db, '9999_two_releases_on');
        await expect(
          migrateToLatest(ctx.db, migrationProvider, {
            forwardMax: '9998_from_a_newer_release',
          }),
        ).rejects.toThrow(
          'database schema generation "9999_two_releases_on" is newer than this ' +
            'build\'s maximum readable generation "9998_from_a_newer_release"',
        );
      } finally {
        await ctx.close();
      }
    });

    it('refuses an unknown generation that is not ahead, promise or not', async () => {
      const ctx = await createIsolatedTestDb();
      try {
        // Sorts BEFORE this build's latest migration: a different database's
        // ledger, not a newer one, and no forward promise may accept it.
        await recordAhead(ctx.db, '0001_from_another_installation');
        await expect(
          migrateToLatest(ctx.db, migrationProvider, { forwardMax: '9999_two_releases_on' }),
        ).rejects.toThrow(
          'corrupted migrations: previously executed migration 0001_from_another_installation is missing',
        );
      } finally {
        await ctx.close();
      }
    });

    it('refuses to run its own pending migrations underneath a newer generation', async () => {
      const { db, close } = createRawDb();
      try {
        const applied: MigrationProvider = {
          getMigrations: () =>
            Promise.resolve({
              '0001_applied': { up: () => Promise.resolve(), down: () => Promise.resolve() },
            }),
        };
        const withPending: MigrationProvider = {
          getMigrations: () =>
            Promise.resolve({
              '0001_applied': { up: () => Promise.resolve(), down: () => Promise.resolve() },
              '0002_still_pending': {
                up: () => Promise.reject(new Error('0002 must not run here')),
                down: () => Promise.resolve(),
              },
            }),
        };
        await migrateToLatest(db, applied);
        await recordAhead(db, '9998_from_a_newer_release');
        // The promise covers the ahead generation, but 0002 is not applied, so
        // accepting would write a generation BELOW one already in the ledger.
        await expect(
          migrateToLatest(db, withPending, { forwardMax: '9998_from_a_newer_release' }),
        ).rejects.toThrow(
          'corrupted migrations: previously executed migration 9998_from_a_newer_release is missing',
        );
      } finally {
        await close();
      }
    });
  });

  it('0016 adds verity_settings.doppler_service_token on up and drops it on down (#320)', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      // createIsolatedTestDb migrated to latest, so 0016 already ran → the column exists.
      const present = await ctx.db
        .selectFrom('verity_settings')
        .select('doppler_service_token')
        .where('id', '=', 'global')
        .execute();
      expect(present).toEqual([]); // no rows yet, but the column resolves (query runs)

      // Roll back everything after 0015 (0016 + any later migrations) → 0016's
      // column is gone; selecting it now throws. (Targeting 0015 rather than a
      // single migrateDown keeps this stable as newer migrations are appended.)
      const { error } = await migrator.migrateTo('0015_project_hidden');
      expect(error).toBeUndefined();
      await expect(
        ctx.db.selectFrom('verity_settings').select('doppler_service_token').execute(),
      ).rejects.toThrow(/doppler_service_token/);

      // Re-apply 0016 (up) → the column resolves again.
      const reapply = await migrator.migrateTo('0016_verity_doppler_service_token');
      expect(reapply.error).toBeUndefined();
      await expect(
        ctx.db.selectFrom('verity_settings').select('doppler_service_token').execute(),
      ).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('0017 adds the project Doppler binding + minted-token columns on up and drops them on down (#320)', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      // createIsolatedTestDb migrated to latest, so 0017 already ran → the columns exist.
      await expect(
        ctx.db
          .selectFrom('project_settings')
          .select(['doppler_project', 'doppler_config', 'doppler_minted_token'])
          .execute(),
      ).resolves.toEqual([]);

      // Roll back everything after 0016 (0017 + any later migrations) → 0017's
      // columns are gone. (Targeting 0016 rather than a single migrateDown keeps
      // this stable as newer migrations are appended.)
      const { error } = await migrator.migrateTo('0016_verity_doppler_service_token');
      expect(error).toBeUndefined();
      await expect(
        ctx.db.selectFrom('project_settings').select('doppler_minted_token').execute(),
      ).rejects.toThrow(/doppler_minted_token/);
      await expect(
        ctx.db.selectFrom('project_settings').select('doppler_project').execute(),
      ).rejects.toThrow(/doppler_project/);

      // Re-apply 0017 (up) → the columns resolve again (up→down→up idempotent).
      const reapply = await migrator.migrateTo('0017_project_doppler_binding');
      expect(reapply.error).toBeUndefined();
      await expect(
        ctx.db
          .selectFrom('project_settings')
          .select(['doppler_project', 'doppler_config', 'doppler_minted_token'])
          .execute(),
      ).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('0074 adds transcription settings on up and drops them on down', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      await expect(
        ctx.db
          .selectFrom('verity_settings')
          .select(['transcribe_base_url', 'transcribe_api_key', 'transcribe_model'])
          .execute(),
      ).resolves.toEqual([]);

      const rollback = await migrator.migrateTo('0073_project_identity_claims');
      expect(rollback.error).toBeUndefined();
      await expect(
        ctx.db.selectFrom('verity_settings').select('transcribe_base_url').execute(),
      ).rejects.toThrow(/transcribe_base_url/);

      const reapply = await migrator.migrateTo('0074_verity_transcription_backend');
      expect(reapply.error).toBeUndefined();
      await expect(
        ctx.db
          .selectFrom('verity_settings')
          .select(['transcribe_base_url', 'transcribe_api_key', 'transcribe_model'])
          .execute(),
      ).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('0075 adds the explicit transcription backend mode on up and drops it on down', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      await expect(
        ctx.db.selectFrom('verity_settings').select('transcribe_backend_mode').execute(),
      ).resolves.toEqual([]);

      const rollback = await migrator.migrateTo('0074_verity_transcription_backend');
      expect(rollback.error).toBeUndefined();
      await expect(
        ctx.db.selectFrom('verity_settings').select('transcribe_backend_mode').execute(),
      ).rejects.toThrow(/transcribe_backend_mode/);

      const reapply = await migrator.migrateTo('0075_verity_transcription_backend_mode');
      expect(reapply.error).toBeUndefined();
      await expect(
        ctx.db.selectFrom('verity_settings').select('transcribe_backend_mode').execute(),
      ).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it("0083 clears an upgraded installation's obsolete local transcription choice", async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      // Rewind to the generation an installation ran on while the bundled local
      // backend still existed, so the obsolete preference can be written exactly
      // the way that installation stored it.
      const rollback = await migrator.migrateTo('0082_uplink_pending_share_removals');
      expect(rollback.error).toBeUndefined();
      await sql`
        insert into verity_settings (id, transcribe_backend_mode)
        values ('global', 'local')
      `.execute(ctx.db);

      const upgrade = await migrator.migrateTo('0083_drop_local_transcribe_backend_mode');
      expect(upgrade.error).toBeUndefined();

      // Not only the column: what the server actually reads must come out as
      // "no backend chosen" — the only state left that an operator can satisfy.
      // A retained `local` would show as the selected backend while every upload
      // is rejected as not configured.
      await expect(
        ctx.db.selectFrom('verity_settings').select('transcribe_backend_mode').execute(),
      ).resolves.toEqual([{ transcribe_backend_mode: null }]);
      expect((await ctx.store.getVeritySettings())?.transcribeBackendMode).toBeNull();
      expect((await ctx.store.getVeritySettingsRaw())?.transcribeBackendMode).toBeNull();

      // A real choice is left alone: only the unsatisfiable one is cleared.
      await ctx.store.updateVeritySettings({ transcribeBackendMode: 'external' });
      const rewind = await migrator.migrateTo('0082_uplink_pending_share_removals');
      expect(rewind.error).toBeUndefined();
      const reapply = await migrator.migrateTo('0083_drop_local_transcribe_backend_mode');
      expect(reapply.error).toBeUndefined();
      expect((await ctx.store.getVeritySettings())?.transcribeBackendMode).toBe('external');
    } finally {
      await ctx.close();
    }
  });

  it('0085 quarantines Doppler credentials until broker access is validated', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect(
        (await migrator.migrateTo('0083_drop_local_transcribe_backend_mode')).error,
      ).toBeUndefined();
      await seedProject(ctx.db, {
        id: 'legacy-doppler',
        owner: 'heey-global',
        repo: 'legacy-doppler',
        containerName: 'legacy-doppler',
        state: 'active',
      });
      await seedProject(ctx.db, {
        id: 'other-provider-project',
        owner: 'heey-global',
        repo: 'other-provider',
        containerName: 'other-provider',
        state: 'active',
      });
      await sql`
        insert into project_settings (
          project_id, doppler_token, doppler_token_ref, doppler_project, doppler_config,
          doppler_minted_token, doppler_minted_token_slug
        ) values (
          'legacy-doppler', 'encrypted-legacy-token', 'env:LEGACY_TOKEN', 'cluster', 'production',
          'encrypted-minted-token', 'legacy-slug'
        )
      `.execute(ctx.db);
      await sql`
        insert into secret_provider_credentials (credential_ref, project_id, ciphertext)
        values
          ('secretref:projects/legacy-doppler/doppler/main/1', 'legacy-doppler', 'encrypted'),
          ('secretref:projects/legacy-doppler/other/main/1', 'legacy-doppler', 'other-encrypted'),
          ('secretref:projects/legacy-doppler/shared/main/1', 'legacy-doppler', 'shared-encrypted')
      `.execute(ctx.db);
      await sql`
        insert into secret_provider_bindings (
          id, project_id, version, provider, credential_ref, doppler_project, doppler_config, state
        ) values
          (
            'main', 'legacy-doppler', 1, 'doppler',
            'secretref:projects/legacy-doppler/doppler/main/1', 'cluster', 'production', 'active'
          ),
          (
            'other', 'legacy-doppler', 1, 'other',
            'secretref:projects/legacy-doppler/other/main/1', 'other', 'production', 'active'
          ),
          (
            'shared-doppler', 'legacy-doppler', 1, 'doppler',
            'secretref:projects/legacy-doppler/shared/main/1', 'cluster', 'production', 'active'
          ),
          (
            'shared-other', 'other-provider-project', 1, 'other',
            'secretref:projects/legacy-doppler/shared/main/1', 'other', 'production', 'active'
          )
      `.execute(ctx.db);

      expect(
        (await migrator.migrateTo('0085_broker_only_doppler_credentials')).error,
      ).toBeUndefined();
      await expect(
        ctx.db.selectFrom('secret_provider_credentials').select('credential_ref').execute(),
      ).resolves.toEqual([
        { credential_ref: 'secretref:projects/legacy-doppler/doppler/main/1' },
        { credential_ref: 'secretref:projects/legacy-doppler/other/main/1' },
        { credential_ref: 'secretref:projects/legacy-doppler/shared/main/1' },
      ]);
      await expect(
        ctx.db
          .selectFrom('secret_provider_bindings')
          .select(['id', 'credential_ref'])
          .orderBy('id')
          .execute(),
      ).resolves.toEqual([
        {
          id: 'main',
          credential_ref: 'secretref:projects/legacy-doppler/doppler/main/1',
        },
        { id: 'other', credential_ref: 'secretref:projects/legacy-doppler/other/main/1' },
        {
          id: 'shared-doppler',
          credential_ref: 'secretref:projects/legacy-doppler/shared/main/1',
        },
        {
          id: 'shared-other',
          credential_ref: 'secretref:projects/legacy-doppler/shared/main/1',
        },
      ]);
      await expect(
        sql`
          insert into secret_provider_bindings (
            id, project_id, version, provider, credential_ref,
            doppler_project, doppler_config, state
          ) values (
            'invalid-other', 'legacy-doppler', 1, 'other', 'secretref:missing',
            'other', 'production', 'active'
          )
        `.execute(ctx.db),
      ).rejects.toThrow(/non-Doppler secret provider binding requires an existing credential/);
      await expect(
        sql`
          delete from secret_provider_credentials
          where credential_ref = 'secretref:projects/legacy-doppler/other/main/1'
        `.execute(ctx.db),
      ).rejects.toThrow(/credential is still referenced by a non-Doppler binding/);
      await expect(
        sql<{
          project_id: string;
          container_name: string;
          doppler_project: string | null;
          doppler_config: string | null;
          token_slug: string | null;
          token_ref: string | null;
          manual_credential: boolean;
          catalog_credential: boolean;
        }>`
          select project_id, container_name, doppler_project, doppler_config, token_slug, token_ref,
                 manual_credential, catalog_credential
          from doppler_legacy_cutovers
        `.execute(ctx.db),
      ).resolves.toMatchObject({
        rows: [
          {
            project_id: 'legacy-doppler',
            container_name: 'legacy-doppler',
            doppler_project: 'cluster',
            doppler_config: 'production',
            token_slug: 'legacy-slug',
            token_ref: 'env:LEGACY_TOKEN',
            manual_credential: true,
            catalog_credential: true,
          },
        ],
      });
      await expect(
        ctx.db
          .selectFrom('project_settings')
          .select([
            'doppler_token',
            'doppler_token_ref',
            'doppler_project',
            'doppler_config',
            'doppler_minted_token',
            'doppler_minted_token_slug',
          ])
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        doppler_token: 'encrypted-legacy-token',
        doppler_token_ref: 'env:LEGACY_TOKEN',
        doppler_project: 'cluster',
        doppler_config: 'production',
        doppler_minted_token: 'encrypted-minted-token',
        doppler_minted_token_slug: 'legacy-slug',
      });
      await expect(
        sql`delete from projects where id = 'legacy-doppler'`.execute(ctx.db),
      ).rejects.toThrow(/credential is still referenced by a non-Doppler binding/);
      await sql`
        delete from secret_provider_bindings
        where project_id = 'other-provider-project' and id = 'shared-other'
      `.execute(ctx.db);
      await sql`delete from projects where id = 'legacy-doppler'`.execute(ctx.db);
      await expect(
        sql<{ project_id: string; token_slug: string | null }>`
          select project_id, token_slug from doppler_legacy_cutovers
        `.execute(ctx.db),
      ).resolves.toMatchObject({
        rows: [{ project_id: 'legacy-doppler', token_slug: 'legacy-slug' }],
      });
    } finally {
      await ctx.close();
    }
  });

  it('0085 classifies a catalog-only Doppler credential as broker-managed', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect(
        (await migrator.migrateTo('0083_drop_local_transcribe_backend_mode')).error,
      ).toBeUndefined();
      await seedProject(ctx.db, {
        id: 'catalog-only',
        owner: 'heey-global',
        repo: 'catalog-only',
        containerName: 'catalog-only',
        state: 'active',
      });
      await sql`
        insert into secret_provider_credentials (credential_ref, project_id, ciphertext)
        values ('secretref:catalog-only', 'catalog-only', 'encrypted-fixture')
      `.execute(ctx.db);
      await sql`
        insert into secret_provider_bindings (
          id, project_id, version, provider, credential_ref,
          doppler_project, doppler_config, state
        ) values (
          'main', 'catalog-only', 1, 'doppler', 'secretref:catalog-only',
          'cluster', 'production', 'active'
        )
      `.execute(ctx.db);

      expect(
        (await migrator.migrateTo('0085_broker_only_doppler_credentials')).error,
      ).toBeUndefined();
      await expect(
        sql<{ manual_credential: boolean; catalog_credential: boolean }>`
          select manual_credential, catalog_credential
          from doppler_legacy_cutovers where project_id = 'catalog-only'
        `.execute(ctx.db),
      ).resolves.toMatchObject({
        rows: [{ manual_credential: false, catalog_credential: true }],
      });
      await expect(
        ctx.db.selectFrom('secret_provider_credentials').select('credential_ref').execute(),
      ).resolves.toEqual([{ credential_ref: 'secretref:catalog-only' }]);
    } finally {
      await ctx.close();
    }
  });

  it('0078 rolls back only while no gateway call has been recorded', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      // An empty trail has nothing to lose, so the rollback is a plain schema drop.
      const rollback = await migrator.migrateTo('0077_brokered_grant_channel_approvals');
      expect(rollback.error).toBeUndefined();
      await expect(ctx.db.selectFrom('audit_mac_keys').select('key_id').execute()).rejects.toThrow(
        /audit_mac_keys/,
      );

      const reapply = await migrator.migrateTo('0078_gateway_audit_events');
      expect(reapply.error).toBeUndefined();
      await ctx.db
        .insertInto('secret_audit_events')
        .values({
          project_id: 'project-1',
          sequence: 0,
          kind: 'gateway_call_served',
          request_hash: null,
          request_mac: 'c'.repeat(64),
          grant_id: null,
          job_id: null,
          approval_id: null,
          event_json: '{}',
          prev_hash: '0'.repeat(64),
          event_hash: 'e'.repeat(64),
          recorded_at: '2026-07-20T00:00:00Z',
        })
        .execute();

      // Now it does: the rows are interior nodes of a hash chain that covers their own
      // sequence, so removing them — or renumbering what follows — breaks the trail exactly
      // the way the tampering it exists to detect would. Refusing is the only honest option.
      const refused = await migrator.migrateTo('0077_brokered_grant_channel_approvals');
      expect(refused.error).toMatchObject({ message: expect.stringMatching(/gateway/) });
      await expect(
        ctx.db.selectFrom('secret_audit_events').select('request_mac').execute(),
      ).resolves.toEqual([{ request_mac: 'c'.repeat(64) }]);
    } finally {
      await ctx.close();
    }
  });

  it('0020 adds the project Doppler minted-token slug column on up and drops it on down (#320 follow-up)', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      // createIsolatedTestDb migrated to latest, so 0020 already ran → the column exists.
      await expect(
        ctx.db.selectFrom('project_settings').select('doppler_minted_token_slug').execute(),
      ).resolves.toEqual([]);

      // Roll back to BEFORE 0020 (target 0019) → the slug column is gone. Targeting
      // the named predecessor rather than a single migrateDown keeps this stable as
      // newer migrations are appended (mirrors the 0016/0017 tests above).
      const { error } = await migrator.migrateTo('0019_tool_result_text_to_refs');
      expect(error).toBeUndefined();
      await expect(
        ctx.db.selectFrom('project_settings').select('doppler_minted_token_slug').execute(),
      ).rejects.toThrow(/doppler_minted_token_slug/);

      // Re-apply 0020 (up) → the column resolves again (up→down→up idempotent).
      const reapply = await migrator.migrateTo('0020_project_doppler_minted_token_slug');
      expect(reapply.error).toBeUndefined();
      await expect(
        ctx.db.selectFrom('project_settings').select('doppler_minted_token_slug').execute(),
      ).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('0036 adds device_push_tokens on up and drops it on down', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      await expect(ctx.db.selectFrom('device_push_tokens').selectAll().execute()).resolves.toEqual(
        [],
      );

      const { error } = await migrator.migrateTo('0034_runner_frames');
      expect(error).toBeUndefined();
      await expect(ctx.db.selectFrom('device_push_tokens').selectAll().execute()).rejects.toThrow(
        /device_push_tokens/,
      );

      const reapply = await migrator.migrateTo('0036_device_push_tokens');
      expect(reapply.error).toBeUndefined();
      await expect(ctx.db.selectFrom('device_push_tokens').selectAll().execute()).resolves.toEqual(
        [],
      );
    } finally {
      await ctx.close();
    }
  });

  it('0037 adds durable push receipts on up and drops them on down', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      await expect(ctx.db.selectFrom('push_receipts').selectAll().execute()).resolves.toEqual([]);

      const { error } = await migrator.migrateTo('0036_device_push_tokens');
      expect(error).toBeUndefined();
      await expect(ctx.db.selectFrom('push_receipts').selectAll().execute()).rejects.toThrow(
        /push_receipts/,
      );

      const reapply = await migrator.migrateTo('0037_push_receipts');
      expect(reapply.error).toBeUndefined();
      await expect(ctx.db.selectFrom('push_receipts').selectAll().execute()).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('upgrades a database at main migration 0037 with Agent Loops in 0038', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      const rollback = await migrator.migrateTo('0037_push_receipts');
      expect(rollback.error).toBeUndefined();
      await expect(ctx.db.selectFrom('agent_loops').select('id').execute()).rejects.toThrow();
      await expect(ctx.db.selectFrom('sessions').select('kind').execute()).rejects.toThrow();

      const upgrade = await migrator.migrateTo('0038_agent_loops');
      expect(upgrade.error).toBeUndefined();
      await expect(ctx.db.selectFrom('agent_loops').select('id').execute()).resolves.toEqual([]);
      await expect(ctx.db.selectFrom('sessions').select('kind').execute()).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('backfills the legacy singular dev server when upgrading to 0039', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      const rollback = await migrator.migrateTo('0038_running_turns_turn_identity');
      expect(rollback.error).toBeUndefined();
      await expect(ctx.db.selectFrom('dev_servers').select('id').execute()).rejects.toThrow();

      await seedProject(ctx.db, {
        id: 'p1',
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'verity-heey-global--verity',
        state: 'active',
      });
      await seedProject(ctx.db, {
        id: 'p2',
        owner: 'heey-global',
        repo: 'docs',
        containerName: 'verity-heey-global--docs',
        state: 'active',
      });
      await seedProject(ctx.db, {
        id: 'p3',
        owner: 'heey-global',
        repo: 'api',
        containerName: 'verity-heey-global--api',
        state: 'active',
      });
      await sql`insert into project_settings
        (project_id, dev_server_command, dev_server_url, dev_server_host_port)
        values ('p1', 'npm run dev', 'http://localhost:3000', '3000')`.execute(ctx.db);
      await sql`insert into project_settings (project_id, dev_server_command)
        values ('p3', 'npm run old-api')`.execute(ctx.db);
      // Legacy settings allowed a useful URL/port-only configuration too.
      await sql`insert into project_settings
        (project_id, dev_server_url, dev_server_container_port)
        values ('p2', 'http://localhost:4173', '4173')`.execute(ctx.db);

      const upgrade = await migrator.migrateTo('0039_dev_servers');
      expect(upgrade.error).toBeUndefined();
      const rows = await ctx.db.selectFrom('dev_servers').selectAll().execute();
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.project_id === 'p1')).toMatchObject({
        project_id: 'p1',
        name: 'Dev server',
        command: 'npm run dev',
        url: 'http://localhost:3000',
        host_port: '3000',
        sort_order: 0,
      });
      expect(rows.find((row) => row.project_id === 'p2')).toMatchObject({
        command: null,
        url: 'http://localhost:4173',
        container_port: '4173',
      });

      // Changes made while 0039 is active survive a rollback to the legacy model.
      await ctx.db
        .updateTable('dev_servers')
        .set({ command: 'pnpm dev', host_port: '5173' })
        .where('project_id', '=', 'p1')
        .execute();
      await ctx.db.deleteFrom('dev_servers').where('project_id', '=', 'p3').execute();
      const downgrade = await migrator.migrateTo('0038_running_turns_turn_identity');
      expect(downgrade.error).toBeUndefined();
      const legacy = await sql<{
        dev_server_command: string | null;
        dev_server_host_port: string | null;
      }>`select dev_server_command, dev_server_host_port from project_settings
          where project_id = 'p1'`.execute(ctx.db);
      expect(legacy.rows[0]).toEqual({
        dev_server_command: 'pnpm dev',
        dev_server_host_port: '5173',
      });
      const cleared = await sql<{ dev_server_command: string | null }>`
        select dev_server_command from project_settings where project_id = 'p3'`.execute(ctx.db);
      expect(cleared.rows[0]?.dev_server_command).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it('deduplicates host ports before enabling the global lease constraint', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0039_dev_servers')).error).toBeUndefined();
      await seedProject(ctx.db, {
        id: 'p1',
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'verity-heey-global--verity',
        state: 'active',
      });
      await ctx.db
        .insertInto('dev_servers')
        .values([
          { id: 'a', project_id: 'p1', name: 'A', host_port: '3000' },
          { id: 'b', project_id: 'p1', name: 'B', host_port: '3000' },
        ])
        .execute();
      expect(
        (await migrator.migrateTo('0040_dev_server_host_port_registry')).error,
      ).toBeUndefined();
      expect(
        await ctx.db.selectFrom('dev_servers').select(['id', 'host_port']).orderBy('id').execute(),
      ).toEqual([
        { id: 'a', host_port: '3000' },
        { id: 'b', host_port: null },
      ]);
      await expect(
        ctx.db
          .updateTable('dev_servers')
          .set({ host_port: '3000' })
          .where('id', '=', 'b')
          .execute(),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it('drops the singular dev-server settings and restores the first server on rollback', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect(
        (await migrator.migrateTo('0040_dev_server_host_port_registry')).error,
      ).toBeUndefined();
      await seedProject(ctx.db, {
        id: 'p1',
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'verity-heey-global--verity',
        state: 'active',
      });
      await ctx.db.insertInto('project_settings').values({ project_id: 'p1' }).execute();
      await ctx.db
        .insertInto('dev_servers')
        .values({
          id: 'web',
          project_id: 'p1',
          name: 'Web',
          command: 'npm run dev',
          url: 'http://localhost:3000',
          container_port: '3000',
        })
        .execute();

      expect(
        (await migrator.migrateTo('0041_drop_legacy_dev_server_settings')).error,
      ).toBeUndefined();
      await expect(
        sql`select dev_server_command from project_settings`.execute(ctx.db),
      ).rejects.toThrow();

      expect(
        (await migrator.migrateTo('0040_dev_server_host_port_registry')).error,
      ).toBeUndefined();
      const restored = await sql<{
        dev_server_command: string | null;
        dev_server_url: string | null;
        dev_server_container_port: string | null;
      }>`select dev_server_command, dev_server_url, dev_server_container_port
          from project_settings where project_id = 'p1'`.execute(ctx.db);
      expect(restored.rows[0]).toEqual({
        dev_server_command: 'npm run dev',
        dev_server_url: 'http://localhost:3000',
        dev_server_container_port: '3000',
      });
    } finally {
      await ctx.close();
    }
  });

  it('adds stable detector identities and project detection state', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect(
        (await migrator.migrateTo('0041_drop_legacy_dev_server_settings')).error,
      ).toBeUndefined();
      await seedProject(ctx.db, {
        id: 'p1',
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'verity-heey-global--verity',
        state: 'active',
      });
      await ctx.db
        .insertInto('dev_servers')
        .values({ id: 'web', project_id: 'p1', name: 'Web' })
        .execute();

      expect(
        (await migrator.migrateTo('0042_dev_server_detection_identity')).error,
      ).toBeUndefined();
      expect(
        await ctx.db
          .selectFrom('dev_servers')
          .select(['id', 'source_key'])
          .where('id', '=', 'web')
          .executeTakeFirst(),
      ).toEqual({ id: 'web', source_key: null });
      await ctx.db
        .insertInto('dev_server_detection_state')
        .values({ project_id: 'p1', fingerprint: 'abc' })
        .execute();
      // Keep this historical migration test on the 0042 schema. The current
      // EventStore also maintains tables introduced by later migrations, so
      // calling it here would couple this test to the latest schema generation.
      await ctx.db.deleteFrom('projects').where('id', '=', 'p1').execute();
      expect(await ctx.db.selectFrom('dev_server_detection_state').selectAll().execute()).toEqual(
        [],
      );
    } finally {
      await ctx.close();
    }
  });

  it('backfills and rolls back the runner terminal-frame column', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0052_secret_revocations')).error).toBeUndefined();
      // Seed through the schema shape that actually existed at 0052. Using the
      // current EventStore here couples this historical migration test to every
      // future additive sessions column (for example 0059.initial_model).
      await ctx.db
        .insertInto('sessions')
        .values({ session_id: 's1', worktree: '/wt/s1', model: 'm' })
        .execute();
      await ctx.db
        .insertInto('runner_frames')
        .values({
          turn_id: 'turn-legacy',
          frame_seq: 1,
          runner_instance_id: 'runner-legacy',
          session_id: 's1',
          payload_hash: 'hash-legacy',
          event_id: null,
        })
        .execute();

      expect((await migrator.migrateTo('0053_runner_frame_terminal')).error).toBeUndefined();
      expect(
        await ctx.db
          .selectFrom('runner_frames')
          .select('terminal')
          .where('turn_id', '=', 'turn-legacy')
          .executeTakeFirst(),
      ).toEqual({ terminal: false });

      expect((await migrator.migrateTo('0052_secret_revocations')).error).toBeUndefined();
      const column = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'runner_frames' and column_name = 'terminal'
      `.execute(ctx.db);
      expect(column.rows).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('leaves pre-0070 permission rows unattributed rather than guessing an issuer', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0069_projects_state_changed_at')).error).toBeUndefined();
      await seedProject(ctx.db, {
        id: 'p1',
        owner: 'acme',
        repo: 'app',
        containerName: 'verity-acme-app',
        state: 'active',
      });
      // Pre-0070 this row is indistinguishable from an operator's brokered grant: the
      // catalog authorization path writes the same columns, and `verity_http_request:<x>`
      // is a legal catalog tool id. Claiming it for the grant store would let a catalog
      // row auto-approve a brokered secret prompt no one ever answered.
      await sql`
        insert into secret_provider_permissions (
          id, project_id, binding_id, binding_version, secret_name,
          tool_id, scope, session_id, granted_by, state
        ) values (
          'ambiguous-1', 'p1', 'project-doppler:b1', 1, 'REVENUECAT_ADMIN_KEY',
          'verity_http_request:api.revenuecat.com', 'project', null, 'operator', 'active'
        )
      `.execute(ctx.db);

      expect((await migrator.migrateTo('0070_brokered_grants_issuer')).error).toBeUndefined();

      // Unattributed, so the grant store's issuer-scoped reads skip it entirely: it cannot
      // be listed, revoked through the grant route, or satisfy the auto-approval check.
      await expect(
        ctx.db
          .selectFrom('secret_provider_permissions')
          .select(['issuer', 'state'])
          .where('id', '=', 'ambiguous-1')
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ issuer: null, state: 'active' });

      // A grant issued after the migration may share that exact key — the two live in
      // different index predicates — so the rollback has to survive the collision.
      await sql`
        insert into secret_provider_permissions (
          id, project_id, binding_id, binding_version, secret_name,
          tool_id, scope, session_id, granted_by, issuer, state
        ) values (
          'granted-1', 'p1', 'project-doppler:b1', 1, 'REVENUECAT_ADMIN_KEY',
          'verity_http_request:api.revenuecat.com', 'project', null, 'operator',
          'brokered-prompt', 'active'
        )
      `.execute(ctx.db);
      expect((await migrator.migrateTo('0069_projects_state_changed_at')).error).toBeUndefined();
      const survivors = await sql<{ id: string }>`
        select id from secret_provider_permissions where state = 'active'
      `.execute(ctx.db);
      expect(survivors.rows).toEqual([{ id: 'granted-1' }]);
    } finally {
      await ctx.close();
    }
  });

  it('rolls back cleanly — the down migration drops the schema', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      // Roll back ALL migrations (not just the latest) so the full schema drops.
      const { error } = await migrator.migrateTo(NO_MIGRATIONS);
      expect(error).toBeUndefined();
      // With the schema dropped, inserting a session must now fail.
      await expect(
        ctx.store.createSession({ sessionId: 's', worktree: '/w', model: 'm' }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it('separates an existing image override from the subsequently observed image', async () => {
    const ctx = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0070_brokered_grants_issuer')).error).toBeUndefined();
      await seedProject(ctx.db, {
        id: 'p-image',
        owner: 'acme',
        repo: 'image',
        containerName: 'verity-acme-image',
        state: 'active',
      });
      await sql`UPDATE projects SET image_ref = 'custom:configured' WHERE id = 'p-image'`.execute(
        ctx.db,
      );

      expect((await migrator.migrateTo('0071_project_image_override')).error).toBeUndefined();
      await expect(
        ctx.db
          .selectFrom('projects')
          .select(['image_ref', 'image_override_ref'])
          .where('id', '=', 'p-image')
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        image_ref: 'custom:configured',
        image_override_ref: 'custom:configured',
      });

      await sql`UPDATE projects SET image_ref = 'custom:configured@sha256:resolved' WHERE id = 'p-image'`.execute(
        ctx.db,
      );
      expect((await migrator.migrateTo('0070_brokered_grants_issuer')).error).toBeUndefined();
      await expect(
        ctx.db
          .selectFrom('projects')
          .select('image_ref')
          .where('id', '=', 'p-image')
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ image_ref: 'custom:configured' });
    } finally {
      await ctx.close();
    }
  });
});
