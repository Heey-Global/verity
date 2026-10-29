import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresDb, migrateToLatest } from '@verity/store';
import { sanitizeRestoredDatabase } from '../packages/server/src/backup/restore-database.js';
import { readCaptureInventory } from '../packages/server/src/backup/inventory.js';
import {
  assertRestoredDatabaseContent,
  assertRestoredFiles,
  contentProjects,
  seedRestoreContent,
} from './backup-restore-content.mjs';

const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;
describe.skipIf(!adminUrl)('separate-daemon recovery content fixture', () => {
  it('seeds real inventory and detects missing worktree bytes, old revisions and attachment corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restore-content-'));
    const name = 'verity_restore_' + randomBytes(16).toString('hex');
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl!);
    url.pathname = '/' + name;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    const database = createPostgresDb(url.toString());
    try {
      await migrateToLatest(database);
      const expected = await seedRestoreContent(root, pool);
      const client = await pool.connect();
      try {
        const inventory = await readCaptureInventory(client, root);
        expect(
          inventory.projects.map(({ id, state, archived }) => ({ id, state, archived })),
        ).toEqual(
          contentProjects
            .map(({ id, state, archived }) => ({ id, state, archived }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        );
        expect(expected.git).toHaveLength(12);
        expect(expected.sessions).toHaveLength(8);
        expect(expected.revisions).toHaveLength(8);
        expect(expected.originals).toHaveLength(8);
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
      await assertRestoredFiles(root, expected);
      await assertRestoredDatabaseContent(pool, root, expected);

      // Missing a second linked worktree must fail independently of manifest contents.
      const file = expected.files.find(
        ({ path }) => path === 'sessions/retained/second/uncommitted',
      )!;
      const bytes = await readFile(join(root, file.path));
      await rm(join(root, file.path));
      await expect(assertRestoredFiles(root, expected)).rejects.toThrow();
      await writeFile(join(root, file.path), bytes);

      const revision = expected.revisions.find(({ id }) => id.endsWith('-v1'))!;
      await pool.query(
        "UPDATE knowledge_document_revisions SET body_markdown='lost history' WHERE id=$1",
        [revision.id],
      );
      await expect(assertRestoredDatabaseContent(pool, root, expected)).rejects.toThrow();
      await pool.query('UPDATE knowledge_document_revisions SET body_markdown=$1 WHERE id=$2', [
        revision.body_markdown,
        revision.id,
      ]);
      const original = (
        await pool.query(
          'SELECT revision_id,bytes FROM knowledge_source_revisions ORDER BY revision_id LIMIT 1',
        )
      ).rows[0] as { revision_id: string; bytes: Buffer };
      await pool.query('UPDATE knowledge_source_revisions SET bytes=$1 WHERE revision_id=$2', [
        Buffer.from('corrupt'),
        original.revision_id,
      ]);
      await expect(assertRestoredDatabaseContent(pool, root, expected)).rejects.toThrow();
      await pool.query('UPDATE knowledge_source_revisions SET bytes=$1 WHERE revision_id=$2', [
        original.bytes,
        original.revision_id,
      ]);
      const attachment = (
        await pool.query('SELECT hash,bytes FROM attachments ORDER BY hash LIMIT 1')
      ).rows[0] as { hash: string; bytes: Buffer };
      await pool.query('UPDATE attachments SET bytes=$1 WHERE hash=$2', [
        Buffer.from('corrupt'),
        attachment.hash,
      ]);
      await expect(assertRestoredDatabaseContent(pool, root, expected)).rejects.toThrow();
      await pool.query('UPDATE attachments SET bytes=$1 WHERE hash=$2', [
        attachment.bytes,
        attachment.hash,
      ]);
      await assertRestoredFiles(root, expected);
      await assertRestoredDatabaseContent(pool, root, expected);
    } finally {
      await database.destroy();
      await pool.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
