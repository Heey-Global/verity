import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPostgresDb, migrateToLatest, createSecretCipher } from '@verity/store';
import { describe, expect, it } from 'vitest';
import { RESTORE_EPHEMERAL_TABLES, sanitizeRestoredDatabase } from './restore-database.js';
const adminUrl = process.env.VERITY_TEST_SHARED_POSTGRES_URL;
describe.skipIf(!adminUrl)('restored database startup safety', () => {
  it('applies snapshot and destination revocations, suspends work, preserves secret metadata and rolls back failed resets', async () => {
    const admin = new pg.Pool({ connectionString: adminUrl!, max: 1 });
    const name = 'verity_restore_' + randomBytes(16).toString('hex');
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(adminUrl!);
    url.pathname = '/' + name;
    const migrated = createPostgresDb(url.toString());
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    try {
      await migrateToLatest(migrated);
      await pool.query(`INSERT INTO projects(id,owner,repo,container_name,state,kind) VALUES ('p','test','repo','old-container','active','local');
        INSERT INTO sessions(session_id,worktree,model,project_id) VALUES ('s','/old/sessions/p/s','test','p'),('outside','/outside/worktree','test','p');
        INSERT INTO auth_tokens(id,token_hash) VALUES ('kept','kept-hash'),('journal','journal-hash'),('outbox','outbox-hash');
        UPDATE backup_policy SET journal_enabled = true;
        INSERT INTO backup_revocation_outbox(id,device_id) VALUES ('event','outbox');
        INSERT INTO secret_key_meta(id,salt,verifier) VALUES ('master','unchanged-salt','unchanged-verifier');
        INSERT INTO queued_turns(id,session_id,prompt,opts) VALUES ('queued','s','must not run','{}');
        INSERT INTO running_turns(session_id,prompt_seq) VALUES ('s',1);
        INSERT INTO gh_token_capabilities(project_id,cap_hash,owner,repo) VALUES ('p','old-capability','test','repo');
        INSERT INTO secret_jobs(job_id,actor_id,authorization_hash,state) VALUES ('job','actor','old-auth','queued');
        INSERT INTO session_automations(id,session_id,name,status,schedule,prompt,next_run_at) VALUES ('automatic','s','Scheduled','enabled','{}','must not run',now())`);
      // Execute the Docker fixture's own seed against an empty migrated settings table.
      // An UPDATE can silently affect zero rows and leave recovery credential proof untested.
      const fixture = await readFile('.github/scripts/backup-restore-docker.mjs', 'utf8');
      const seed = fixture.match(/(['"`])((?:INSERT INTO|UPDATE) verity_settings[^\n]*?)\1/)?.[2];
      expect(seed).toBeDefined();
      const cipher = createSecretCipher(Buffer.alloc(32, 17).toString('hex'));
      expect(
        (await pool.query(seed!, ['Recovery fixture', cipher.encrypt('restored credential')]))
          .rowCount,
      ).toBe(1);
      const options = {
        sourceRoot: '/old',
        liveRoot: '/new',
        activeTurns: ['s'],
        revokedIds: ['journal'],
        newIdentity: false,
      };
      const client = await pool.connect();
      try {
        await expect(sanitizeRestoredDatabase(client, options)).rejects.toThrow(
          'Unsafe backup path',
        );
        expect((await client.query('SELECT count(*)::int AS n FROM auth_tokens')).rows[0].n).toBe(
          3,
        );
        expect(
          (await client.query('SELECT journal_enabled FROM backup_policy')).rows[0].journal_enabled,
        ).toBe(true);
        expect((await client.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(0);
        await client.query("DELETE FROM sessions WHERE session_id = 'outside'");
        const result = await sanitizeRestoredDatabase(client, options);
        expect(result.devices).toEqual(['kept']);
        const settings = (
          await client.query<{ git_user_name: string; transcribe_api_key: string }>(
            "SELECT git_user_name,transcribe_api_key FROM verity_settings WHERE id='global'",
          )
        ).rows[0];
        if (!settings) throw new Error('Restored global settings row missing');
        expect(settings.git_user_name).toBe('Recovery fixture');
        expect(cipher.decrypt(settings.transcribe_api_key)).toBe('restored credential');
        expect([...result.revokedIds].sort()).toEqual(['journal', 'outbox']);
        expect(result.interrupted).toEqual(['s']);
        for (const table of RESTORE_EPHEMERAL_TABLES)
          expect(
            (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
            table,
          ).toBe(0);
        expect((await client.query('SELECT salt,verifier FROM secret_key_meta')).rows).toEqual([
          { salt: 'unchanged-salt', verifier: 'unchanged-verifier' },
        ]);
        expect((await client.query('SELECT worktree FROM sessions')).rows[0].worktree).toBe(
          '/new/sessions/p/s',
        );
        expect((await client.query('SELECT state FROM projects')).rows[0].state).toBe('absent');
        expect(
          (await client.query('SELECT status,next_run_at FROM session_automations')).rows[0],
        ).toEqual({ status: 'paused', next_run_at: null });
        expect((await client.query('SELECT payload FROM events')).rows[0].payload).toEqual({
          t: 'interrupted',
        });
        expect(
          (await client.query('SELECT journal_enabled FROM backup_policy')).rows[0].journal_enabled,
        ).toBe(false);
        const reset = await sanitizeRestoredDatabase(client, {
          ...options,
          sourceRoot: '/new',
          activeTurns: [],
          newIdentity: true,
        });
        expect(reset.devices).toEqual([]);
        expect(
          (await client.query('SELECT count(*)::int AS n FROM backup_revocation_outbox')).rows[0].n,
        ).toBe(0);
      } finally {
        client.release();
      }
      const live = await admin.connect();
      try {
        await expect(sanitizeRestoredDatabase(live, options)).rejects.toThrow(
          'disposable staging database',
        );
      } finally {
        live.release();
      }
    } finally {
      await pool.end();
      await migrated.destroy();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  });
});
