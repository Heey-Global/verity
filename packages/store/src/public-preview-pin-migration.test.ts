import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, it } from 'vitest';
import { migrationProvider } from './migrations.js';
import { createTestDb } from './testing.js';

it('requires live preview links to be stopped before the PIN migration', async () => {
  const ctx = await createTestDb();
  try {
    await ctx.store.upsertProject({
      id: 'pin-migration-project',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'verity-pin-migration',
      state: 'active',
    });
    const devServer = await ctx.store.createDevServer({
      projectId: 'pin-migration-project',
      name: 'Web',
      containerPort: '3000',
    });
    await ctx.store.createPublicPreviewShare({
      id: 'old-share',
      projectId: 'pin-migration-project',
      devServerId: devServer.id,
      containerGeneration: 'generation-1',
      targetPort: 3000,
      publicOrigin: 'https://old.preview.example',
      edgeUrl: 'wss://old.preview.example/__verity/connector',
      pinHash: 'scrypt:salt:hash',
      pin: '123456',
      connectorToken: 'connector',
      sessionSecret: 'session',
      connectorContainerName: 'verity-preview-old',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    const expiredDevServer = await ctx.store.createDevServer({
      projectId: 'pin-migration-project',
      name: 'Expired',
      containerPort: '3001',
    });
    await ctx.store.createPublicPreviewShare({
      id: 'expired-share',
      projectId: 'pin-migration-project',
      devServerId: expiredDevServer.id,
      containerGeneration: 'generation-1',
      targetPort: 3001,
      publicOrigin: 'https://expired.preview.example',
      edgeUrl: 'wss://expired.preview.example/__verity/connector',
      pinHash: 'scrypt:salt:hash',
      pin: '654321',
      connectorToken: 'connector',
      sessionSecret: 'session',
      connectorContainerName: 'verity-preview-expired',
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    });

    const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
    expect((await migrator.migrateDown()).error).toBeUndefined();
    const blocked = await migrator.migrateToLatest();
    expect(String(blocked.error)).toContain('Stop all active preview links before upgrading');

    await sql`update public_preview_shares set state = 'revoked' where id = 'old-share'`.execute(
      ctx.db,
    );
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(await ctx.store.listPublicPreviewShares('pin-migration-project')).toMatchObject([
      { id: 'expired-share', state: 'revoking', pin: null },
    ]);
  } finally {
    await ctx.close();
  }
});
