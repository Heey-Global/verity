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
      await pool.query(`
        INSERT INTO public_preview_shares(id,project_id,container_generation,state,public_origin,edge_url,pin_hash_secret,connector_token_secret,session_secret,connector_container_name,expires_at,target_kind,static_path,session_id) VALUES('public','p','old-gen','active','https://example.invalid','https://example.invalid','cipher','cipher','cipher','old-connector',now()+interval '1 day','static-folder','public','s');
        INSERT INTO local_preview_shares(id,project_id,session_id,network_port,url,target_port,connector_secret,state,expires_at) VALUES('local','p','s',12345,'http://example.invalid',3000,'cipher','active',now()+interval '1 day');
        INSERT INTO public_preview_pin_locks(share_id) VALUES('public');
        INSERT INTO uplink_pending_share_removals(share_id) VALUES('public');
        INSERT INTO signing_capabilities(project_id,cap_hash,container_generation) VALUES('p','sign-cap','old-generation');
        INSERT INTO secret_run_grants(capability_hash,grant_id,claims_json,expires_at) VALUES('run-cap','run-grant','{}',now()+interval '1 day');
        INSERT INTO secret_approvals(id,project_id,session_id,tool_call_id,claims_json,state) VALUES('approval','p','s','tool','{}','approved');
        INSERT INTO secret_job_frames(job_id,protocol_version,sequence,stream,encoding,payload,byte_length,emitted_at) VALUES('job',1,0,'stdout','utf8','old-frame',9,'2026-10-28T00:00:00Z');
        INSERT INTO trusted_cli_outputs(id,project_id,session_id,expires_at,next_sequence,result) VALUES('cli','p','s',now()+interval '1 day',1,'old-result');
        INSERT INTO secret_provider_permissions(id,project_id,binding_id,binding_version,secret_name,tool_id,scope,granted_by,state) VALUES('grant','p','binding',1,'fixture','tool','project','admin','active');
        INSERT INTO brokered_grant_approvals(grant_id,channel) VALUES('grant','http');
        INSERT INTO sessions(session_id,worktree,model,project_id) VALUES('s2','/old/sessions/p/s2','test','p');
        INSERT INTO session_links(session_a,session_b) VALUES('s','s2');
        INSERT INTO session_link_pending_messages(id,invocation_id,session_a,session_b,source_session_id,target_session_id,source_project_id,request_mac,mac_key_id,message) VALUES('pending','invocation','s','s2','s','s2','p','mac','key','must not deliver');
        INSERT INTO session_moves(session_id,operation_id,source_project_id,source_worktree,target_project_id,target_worktree,branch,on_commits,notice,backend_ids_json) VALUES('s','move','p','/old/sessions/p/s','p','/old/sessions/p/new','branch','[]','must not resume','[]');
        INSERT INTO matrix_outbound(invocation_id,session_id,project_id,account_id,source_id,binding_version,payload_secret,transaction_id,state) VALUES('send','s','p','account','source',1,'cipher','txn','queued');
        INSERT INTO live_meetings(id,session_id,engine,started_at,state,transcript,owner_token_hash,recorder_last_seen_at,revision,updated_seq) VALUES('meeting','s','test',1,'active','','old-owner',1,1,1);
        INSERT INTO live_meeting_commands(id,meeting_id,action,state,requested_at) VALUES('command','meeting','resume','pending',1);
        INSERT INTO managed_dev_servers(id,project_id,name,name_key,command) VALUES('managed','p','Managed','managed','must-not-start');
        INSERT INTO managed_dev_server_instances(id,server_id,project_id,session_id,sandbox_port,desired,state) VALUES('instance','managed','p','s',3000,'running','running');
        INSERT INTO dev_servers(id,project_id) VALUES('dev','p');
        INSERT INTO dev_server_detection_state(project_id,fingerprint) VALUES('p','old');
        INSERT INTO device_push_tokens(auth_token_id,expo_token,platform) VALUES('kept','expo-old','ios');
        INSERT INTO push_receipts(receipt_id,expo_token,available_at) VALUES('receipt','expo-old',now());
        INSERT INTO control_plane_generation(singleton,generation,holder_id,operation_id,state) VALUES(true,7,'old-holder','old-operation','active') ON CONFLICT(singleton) DO UPDATE SET generation=7,holder_id='old-holder',operation_id='old-operation',state='active';
        INSERT INTO brokered_http_consumptions(project_id,session_id,turn_id,call_id,request_hash) VALUES('p','s','turn','call','request');
      `);
      // Check real migrated tables rather than accepting vacuous assertions over empty fixtures.
      const seeded = [
        'public_preview_shares',
        'local_preview_shares',
        'public_preview_pin_locks',
        'uplink_pending_share_removals',
        'signing_capabilities',
        'gh_token_capabilities',
        'secret_run_grants',
        'secret_approvals',
        'secret_jobs',
        'secret_job_frames',
        'trusted_cli_outputs',
        'brokered_http_consumptions',
        'brokered_grant_approvals',
        'session_link_pending_messages',
        'session_moves',
        'matrix_outbound',
        'live_meeting_commands',
        'managed_dev_server_instances',
        'dev_servers',
        'dev_server_detection_state',
        'push_receipts',

        'queued_turns',
        'running_turns',
      ];
      expect([...seeded].sort()).toEqual([...RESTORE_EPHEMERAL_TABLES].sort());
      for (const table of seeded)
        expect(
          (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
          table,
        ).toBeGreaterThan(0);
      const schemaTables = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      );
      // There is currently no separate enrollment-recovery store. Fail on schema growth for review.
      expect(
        schemaTables.rows.filter(({ tablename }) => /enroll|recovery/.test(tablename)),
      ).toEqual([]);
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
        expect(
          (
            await client.query(
              'SELECT generation,holder_id,operation_id,state FROM control_plane_generation WHERE singleton',
            )
          ).rows,
        ).toEqual([{ generation: 8, holder_id: null, operation_id: null, state: 'quiesced' }]);
        expect(
          (await client.query("SELECT state FROM live_meetings WHERE id='meeting'")).rows,
        ).toEqual([{ state: 'interrupted' }]);
        expect(
          (await client.query("SELECT id FROM managed_dev_servers WHERE id='managed'")).rows,
        ).toEqual([{ id: 'managed' }]);

        expect(
          (await client.query("SELECT id FROM secret_provider_permissions WHERE id='grant'")).rows,
        ).toEqual([{ id: 'grant' }]);
        // Seeded fixtures are an independent oracle: deleting a reset-list member must fail.
        for (const table of seeded)
          expect(
            (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
            table,
          ).toBe(0);
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
