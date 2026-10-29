import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createPostgresDb, migrateToLatest } from '@verity/store';
import { seedRestoreContent } from '../../../../scripts/backup-restore-content.mjs';
import { captureInstallation } from './capture.js';
import { generateBackupKeys } from './crypto.js';
import { BackupDestination } from './destination.js';
import { readCaptureInventory } from './inventory.js';
import { BackupLifecycleCoordinator } from './lifecycle.js';
import { BackupRepository } from './repository.js';
import { sanitizeRestoredDatabase } from './restore-database.js';
import { writeBackupIdentityFixture } from './testing.js';

const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;
it.skipIf(!adminUrl)(
  'captures the complete restored schema and Git fixtures using installer-only read grants',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'readonly-capture-'));
    const suffix = randomBytes(16).toString('hex');
    const name = 'verity_restore_' + suffix;
    const role = 'backup_' + suffix;
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    const url = new URL(adminUrl!);
    url.pathname = '/' + name;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    const database = createPostgresDb(url.toString());
    const readerUrl = new URL(url);
    readerUrl.username = role;
    readerUrl.password = 'a'.repeat(64);
    readerUrl.searchParams.delete('user');
    readerUrl.searchParams.delete('password');
    const reader = new pg.Pool({ connectionString: readerUrl.toString(), max: 1 });
    let destination: BackupDestination | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      await migrateToLatest(database);
      await seedRestoreContent(root, pool);
      const client = await pool.connect();
      try {
        await sanitizeRestoredDatabase(client, {
          sourceRoot: root,
          liveRoot: root,
          activeTurns: [],
          revokedIds: [],
          newIdentity: false,
        });
      } finally {
        client.release();
      }
      await pool.query(
        "INSERT INTO projects(id,owner,repo,clone_dir,container_name,state,kind) VALUES ('verity-control','verity','control','control','verity-control','active','control_plane')",
      );
      const script = await readFile(
        new URL('../../../../deploy/host/verity-backup-prerequisites', import.meta.url),
        'utf8',
      );
      const sql = script
        .match(/<<SQL\n([\s\S]*?)^SQL$/m)![1]!
        .replaceAll('\\$', '$')
        .replaceAll('verity_backup', role)
        .replaceAll('$password', 'a'.repeat(64))
        .replaceAll('ON DATABASE verity ', `ON DATABASE "${name}" `)
        .replaceAll(
          'FOR ROLE verity ',
          `FOR ROLE "${(await pool.query('SELECT current_user AS name')).rows[0].name}" `,
        );
      await pool.query(sql);
      const { host } = await generateBackupKeys();
      const installationId = randomUUID();
      const identity = join(root, 'identity-fixture');
      await writeBackupIdentityFixture(identity, host, installationId);
      const backup = join(root, 'destination');
      await mkdir(backup);
      const targetId = randomUUID();
      await writeFile(join(backup, '.verity-backup-target'), targetId);
      destination = await BackupDestination.open(backup, targetId);
      const repository = new BackupRepository(
        backup,
        join(root, 'host-state'),
        installationId + '-r1',
        host,
        destination,
      );
      await repository.initialize();
      const schema = (
        await pool.query('SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1')
      ).rows[0].name;
      const keys = new Map<string, string>();
      const manifest = await captureInstallation({
        root,
        identityRoot: join(identity, 'identity'),
        caCiphertext: join(identity, 'ca.age'),
        installationId,
        keyGeneration: 1,
        image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
        release: 'test',
        schema,
        architecture: 'amd64',
        kind: 'scheduled',
        connect: () => reader.connect(),
        inventory: (c) => readCaptureInventory(c, root, schema),
        repository,
        destination,
        lifecycle: new BackupLifecycleCoordinator(),
        signal: new AbortController().signal,
        repoKey: async (id, path) => {
          const key = id + '\0' + path;
          if (!keys.has(key)) keys.set(key, randomUUID());
          return keys.get(key)!;
        },
      });
      expect(manifest.kind).toBe('scheduled');
      expect(
        manifest.files.filter((f) => f.path.startsWith('database/tables/')).length,
      ).toBeGreaterThan(100);
    } finally {
      await destination?.close();
      await reader.end();
      await pool.end();
      await database.destroy();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
