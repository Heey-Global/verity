import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { BackupDeviceReview } from './device-review.js';
import { assertRestoreDatabaseAuthority } from './restore-database-authority.js';
import { authenticateRestoreAdministrator } from './restore-auth.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import { readRevocations } from './revocations.js';
import { readSnapshot } from './repository.js';
import { createHash } from 'node:crypto';
import type { RestoreJob } from './restore-job.js';

/** Revalidate both recovery factors and revocations at the final acceptance boundary. */
export async function recheckRestoreDevices(options: {
  root: string;
  job: RestoreJob;
  client: PoolClient;
  recoveryKey: string;
  masterPassword: string;
  target?: 'staging' | 'canonical';
  signal?: AbortSignal;
}): Promise<readonly string[]> {
  const { job, client, signal } = options;
  signal?.throwIfAborted();
  if (!job.verified) throw new Error('Verified restore required');
  const snapshot = await readSnapshot(
    join(job.selection.source, 'repositories'),
    job.selection.repository,
    job.selection.sequence,
    options.recoveryKey,
    job.selection.kind,
    signal,
  );
  if (
    createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') !==
    job.verified.manifestHash
  )
    throw new Error('Snapshot changed since restore verification');
  const review = await new BackupDeviceReview(join(options.root, job.id, 'trial')).load();
  if (review?.status !== 'complete') throw new Error('Explicit device review required');
  if (job.selection.newIdentity && review.keptIds.length)
    throw new Error('New identity cannot retain devices');
  const target = await client.query<{ name: string }>('SELECT current_database() AS name');
  const expectedDatabase =
    options.target === 'canonical' ? 'verity' : restoreDatabaseResources(job).database;
  if (target.rows[0]?.name !== expectedDatabase)
    throw new Error('Final device review requires this job’s isolated database');
  await assertRestoreDatabaseAuthority(client, job);
  await client.query('BEGIN');
  try {
    if (!(await authenticateRestoreAdministrator(client, options.masterPassword)))
      throw new Error('Administrator authentication required for restore acceptance');
    const devices = await client.query<{ id: string }>(
      'SELECT id FROM auth_tokens LIMIT 10001 FOR UPDATE',
    );
    if (devices.rows.length > 10000) throw new Error('Restore device limit exceeded');
    const journal = await readRevocations(
      job.selection.source,
      options.recoveryKey,
      signal,
      new Set(devices.rows.map((device) => device.id)),
    );
    if (journal.findings.some((finding) => !review.findings.includes(finding)))
      throw new Error(
        'Revocation history changed after device review; restore complete history before acceptance',
      );
    const outbox = await client.query<{ device_id: string }>(
      'SELECT device_id FROM backup_revocation_outbox LIMIT 100001',
    );
    if (outbox.rows.length > 100000) throw new Error('Restore revocation outbox limit exceeded');
    const revoked = new Set([
      ...journal.revokedIds,
      ...review.revokedIds,
      ...outbox.rows.map((row) => row.device_id),
    ]);
    const keep = job.selection.newIdentity ? [] : review.keptIds.filter((id) => !revoked.has(id));
    await client.query('DELETE FROM auth_tokens WHERE NOT (id = ANY($1::text[]))', [keep]);
    signal?.throwIfAborted();
    await client.query('COMMIT');
    return keep;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
