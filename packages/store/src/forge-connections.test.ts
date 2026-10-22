import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { createSealableSecretCipher, createSecretCipher, SealedError } from './crypto.js';
import { migrationProvider } from './migrations.js';
import { EventStore } from './store.js';
import { createRawDb } from './testing.js';

it('migrates GitHub credentials while sealed and binds only GitHub projects and their capabilities', async () => {
  const ctx = createRawDb();
  const cipher = createSecretCipher(Buffer.alloc(32, 17).toString('hex'));
  const envelope = cipher.encrypt('private-key-fixture');
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    expect((await migrator.migrateTo('0159_google_accounts')).error).toBeUndefined();
    await sql`insert into verity_settings(id, github_app_id, github_app_installation_id, github_app_private_key)
      values ('global', 'app', 'installation', ${envelope})`.execute(ctx.db);
    await sql`insert into projects(id,owner,repo,container_name,state,kind) values
      ('p','test','repo','container','absent','github'),
      ('local','__local__','local','local','absent','local')`.execute(ctx.db);
    await sql`insert into gh_token_capabilities(project_id, cap_hash, owner, repo)
      values ('p','hash','test','repo')`.execute(ctx.db);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    const sealed = createSealableSecretCipher();
    const store = new EventStore(ctx.db, sealed);
    expect(await store.forgeConnections.list()).toEqual([
      {
        id: 'legacy-github',
        provider: 'github',
        baseUrl: 'https://github.com',
        label: 'GitHub',
      },
    ]);
    expect(
      (
        await ctx.db
          .selectFrom('forge_connections')
          .select('github_app_private_key')
          .executeTakeFirstOrThrow()
      ).github_app_private_key,
    ).toBe(envelope);
    expect((await store.getProject('p'))?.forgeConnectionId).toBe('legacy-github');
    expect((await store.getProject('local'))?.forgeConnectionId).toBeNull();
    expect(
      (
        await ctx.db
          .selectFrom('gh_token_capabilities')
          .select('forge_connection_id')
          .executeTakeFirstOrThrow()
      ).forge_connection_id,
    ).toBe('legacy-github');
    await expect(store.forgeConnections.credentials('legacy-github')).rejects.toBeInstanceOf(
      SealedError,
    );
    sealed.unlock(Buffer.alloc(32, 17).toString('hex'));
    expect(await store.forgeConnections.credentials('legacy-github')).toMatchObject({
      githubAppId: 'app',
      githubAppPrivateKey: 'private-key-fixture',
    });
    expect((await store.getVeritySettings())?.githubAppPrivateKey).toBe('private-key-fixture');
    await expect(store.forgeConnections.delete('legacy-github')).rejects.toMatchObject({
      code: '23001',
    });
    expect((await migrator.migrateTo('0159_google_accounts')).error).toBeUndefined();
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(await store.forgeConnections.list()).toHaveLength(1);
  } finally {
    await ctx.close();
  }
});

it('encrypts Forgejo tokens, preserves project bindings on sync, and protects connection identity', async () => {
  const ctx = createRawDb();
  try {
    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    const cipher = createSealableSecretCipher();
    cipher.unlock(Buffer.alloc(32, 23).toString('hex'));
    const store = new EventStore(ctx.db, cipher);
    const input = {
      id: 'forge',
      provider: 'forgejo' as const,
      baseUrl: 'https://forge.example.test/',
      label: 'My forge',
      personalToken: 'token-fixture',
      githubAppId: null,
      githubAppInstallationId: null,
      githubAppPrivateKey: null,
    };
    await store.forgeConnections.upsert(input);
    const raw = await ctx.db
      .selectFrom('forge_connections')
      .select('personal_token')
      .executeTakeFirstOrThrow();
    expect(raw.personal_token).toMatch(/^enc:v1:/u);
    expect(raw.personal_token).not.toContain('token-fixture');
    expect((await store.forgeConnections.credentials('forge'))?.personalToken).toBe(
      'token-fixture',
    );
    const project = {
      id: 'p',
      owner: 'test',
      repo: 'repo',
      containerName: 'container',
      kind: 'forgejo' as const,
      state: 'absent' as const,
      forgeConnectionId: 'forge',
    };
    expect((await store.upsertProject(project)).forgeConnectionId).toBe('forge');
    const sync: Omit<typeof project, 'forgeConnectionId'> & { forgeConnectionId?: string } = {
      ...project,
    };
    delete sync.forgeConnectionId;
    expect((await store.upsertProject(sync)).forgeConnectionId).toBe('forge');
    await expect(
      store.forgeConnections.upsert({ ...input, baseUrl: 'https://other.test' }),
    ).rejects.toThrow('Cannot change');
    await expect(
      store.forgeConnections.upsert({ ...input, baseUrl: 'http://forge.test' }),
    ).rejects.toThrow('HTTPS');
    await expect(store.upsertProject({ ...sync, kind: 'github' })).rejects.toThrow(
      'another forge connection',
    );
    const { kind, ...legacySync } = sync;
    expect(kind).toBe('forgejo');
    await expect(store.upsertProject(legacySync)).rejects.toThrow('another forge connection');
    cipher.seal();
    expect(await store.forgeConnections.get('forge')).toMatchObject({ label: 'My forge' });
    await expect(store.forgeConnections.credentials('forge')).rejects.toBeInstanceOf(SealedError);
    await expect(store.forgeConnections.upsert(input)).rejects.toBeInstanceOf(SealedError);
    await store.deleteProject('p');
    await store.forgeConnections.delete('forge');
    expect(await store.forgeConnections.list()).toEqual([]);
  } finally {
    await ctx.close();
  }
});
