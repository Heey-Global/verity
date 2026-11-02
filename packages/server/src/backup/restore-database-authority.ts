import type { PoolClient } from 'pg';
import type { RestoreJob } from './restore-job.js';

/** Kept outside public snapshot tables; copied only with this job's isolated PostgreSQL volume. */
export async function createRestoreDatabaseAuthority(
  client: PoolClient,
  job: RestoreJob,
): Promise<void> {
  if (!job.verified) throw new Error('Verified restore required');
  await client.query('CREATE SCHEMA verity_restore_authority');
  await client.query(
    "CREATE TABLE verity_restore_authority.installation (singleton boolean PRIMARY KEY CHECK (singleton), job_id uuid NOT NULL, installation_id uuid NOT NULL, manifest_hash text NOT NULL, phase text NOT NULL CHECK (phase IN ('prepared','canonicalizing','canonical')))",
  );
  await client.query(
    "INSERT INTO verity_restore_authority.installation VALUES (true, $1, $2, $3, 'prepared')",
    [job.id, job.installationId, job.verified.manifestHash],
  );
}
export async function assertRestoreDatabaseAuthority(
  client: Pick<PoolClient, 'query'>,
  job: Pick<RestoreJob, 'id' | 'installationId'> & { verified: { manifestHash: string } | null },
): Promise<'prepared' | 'canonicalizing' | 'canonical'> {
  const result = await client.query<{
    job_id: string;
    installation_id: string;
    manifest_hash: string;
    phase: string;
  }>(
    'SELECT job_id, installation_id, manifest_hash, phase FROM verity_restore_authority.installation WHERE singleton',
  );
  const row = result.rows[0];
  if (
    !job.verified ||
    result.rows.length !== 1 ||
    row?.job_id !== job.id ||
    row.installation_id !== job.installationId ||
    row.manifest_hash !== job.verified.manifestHash ||
    !['prepared', 'canonicalizing', 'canonical'].includes(row.phase)
  )
    throw new Error('Restore database authority mismatch');
  return row.phase as 'prepared' | 'canonicalizing' | 'canonical';
}
