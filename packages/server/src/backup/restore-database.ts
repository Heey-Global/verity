import type { PoolClient } from 'pg';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { validateBackupPath } from './format.js';

/** Restore-only reset set. Durable history, settings and encrypted credentials are retained. */
export const RESTORE_EPHEMERAL_TABLES = [
  'public_preview_shares',
  'local_preview_shares',
  'public_preview_pin_locks',
  'uplink_pending_share_removals',
  'gh_token_capabilities',
  'signing_capabilities',
  'secret_run_grants',
  'secret_approvals',
  'brokered_grant_approvals',
  'brokered_http_consumptions',
  'secret_job_frames',
  'secret_jobs',
  'trusted_cli_outputs',
  'queued_turns',
  'running_turns',
  'session_link_pending_messages',
  'session_moves',
  'matrix_outbound',
  'live_meeting_commands',
  'managed_dev_server_instances',
  'dev_servers',
  'dev_server_detection_state',
  'push_receipts',
] as const;

/** Only disposable, unpublished databases may enter this routine. Ordinary startup never calls it. */
export async function sanitizeRestoredDatabase(
  client: PoolClient,
  options: {
    sourceRoot: string;
    liveRoot: string;
    activeTurns: readonly string[];
    revokedIds: Iterable<string>;
    newIdentity: boolean;
  },
): Promise<{ devices: string[]; revokedIds: Set<string>; interrupted: string[] }> {
  for (const root of [options.sourceRoot, options.liveRoot])
    if (!isAbsolute(root) || resolve(root) !== root || /[\0\r\n]/.test(root))
      throw new Error('Invalid restore database path root');
  if (options.activeTurns.length > 50000) throw new Error('Restore active turn limit exceeded');
  await client.query('BEGIN');
  try {
    const database = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (!/^verity_(restore|probe)_[0-9a-f]{32}$/.test(database.rows[0]?.name ?? ''))
      throw new Error('Restore reset requires a disposable staging database');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('UPDATE backup_policy SET journal_enabled = false WHERE id = 1');
    const revokedIds = new Set(options.revokedIds);
    // A snapshot can contain revocations not yet copied to the destination.
    // Read them before clearing host-owned bookkeeping for the new installation.
    const queued = await client.query<{ device_id: string }>(
      'SELECT device_id FROM backup_revocation_outbox LIMIT 100001',
    );
    if (queued.rows.length > 100000) throw new Error('Restore revocation limit exceeded');
    for (const row of queued.rows) revokedIds.add(row.device_id);
    if (revokedIds.size > 100000) throw new Error('Restore revocation limit exceeded');
    await client.query('DELETE FROM backup_revocation_outbox');
    await client.query('DELETE FROM backup_git_repositories');
    await client.query('DELETE FROM backup_unassigned_git_repositories');
    if (options.newIdentity) await client.query('DELETE FROM auth_tokens');
    else
      await client.query('DELETE FROM auth_tokens WHERE id = ANY($1::text[])', [[...revokedIds]]);
    const devices = await client.query<{ id: string }>(
      'SELECT id FROM auth_tokens ORDER BY id LIMIT 10001',
    );
    if (devices.rows.length > 10000) throw new Error('Restore device limit exceeded');
    const running = await client.query<{ session_id: string }>(
      'SELECT session_id FROM running_turns',
    );
    const active = [
      ...new Set([...options.activeTurns, ...running.rows.map((row) => row.session_id)]),
    ];
    const interrupted = await client.query<{ session_id: string }>(
      `INSERT INTO events(session_id,type,payload)
       SELECT session_id, 'interrupted', '{"t":"interrupted"}'::jsonb
       FROM sessions WHERE session_id = ANY($1::text[]) RETURNING session_id`,
      [active],
    );
    const sessions = await client.query<{ session_id: string; worktree: string }>(
      'SELECT session_id,worktree FROM sessions',
    );
    for (const session of sessions.rows) {
      const local = relative(options.sourceRoot, session.worktree);
      validateBackupPath(local);
      if (!/^(sessions|workspaces)\//.test(local))
        throw new Error('Restored session worktree escapes data scopes');
      await client.query('UPDATE sessions SET worktree = $1 WHERE session_id = $2', [
        join(options.liveRoot, local),
        session.session_id,
      ]);
    }
    for (const table of RESTORE_EPHEMERAL_TABLES) await client.query(`DELETE FROM ${table}`);
    await client.query("UPDATE session_automations SET status = 'paused', next_run_at = NULL");
    await client.query("UPDATE live_meetings SET state = 'interrupted' WHERE state = 'active'");
    await client.query(`UPDATE projects SET state = 'absent', image_ref = NULL, toolkit_identity = NULL,
      sleep_compatibility_fingerprint = NULL, sleeping_since = NULL, wake_started_at = NULL,
      provision_error = NULL, provision_warning = NULL, state_changed_at = now()`);
    await client.query(`UPDATE control_plane_generation SET generation = generation + 1,
      holder_id = NULL, operation_id = NULL, state = 'quiesced', updated_at = now()`);
    await client.query('COMMIT');
    return {
      devices: devices.rows.map((row) => row.id),
      revokedIds,
      interrupted: interrupted.rows.map((row) => row.session_id),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
