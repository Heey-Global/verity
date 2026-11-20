import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** Longest failure message kept; the message is shown to project members. */
export const SANDBOX_REPAIR_MESSAGE_LIMIT = 500;

/**
 * An automatic Sandbox repair the Server still owes a project.
 *
 * Written before an automatic recreate, updated on failure, and removed
 * when a rebuild succeeds or the project leaves the states automatic repair may
 * act on. Persisted because a failed recreate can leave the project `failed`,
 * and before this record existed only process memory remembered that the
 * failure was Verity's own repair to retry: after a Server restart such a
 * project waited for a manual Repair.
 */
export interface SandboxRepairIntent {
  projectId: string;
  version: 1;
  attemptId: string;
  status: 'running' | 'waiting';
  sourceGeneration: string | null;
  targetImageRef: string | null;
  /** Consecutive failed automatic recreates. */
  failures: number;
  /** Earliest time the reconciler may retry. */
  retryAt: Date;
  /** The last failure was a build-storage capacity refusal, so released
   *  storage may let the retry run early. */
  storageRefused: boolean;
  lastFailureAt: Date;
  lastFailureMessage: string;
}

interface Row {
  project_id: string;
  version: 1;
  attempt_id: string;
  status: 'running' | 'waiting';
  source_generation: string | null;
  target_image_ref: string | null;
  failures: number;
  retry_at: Date;
  storage_refused: boolean;
  last_failure_at: Date;
  last_failure_message: string;
}

const fromRow = (row: Row): SandboxRepairIntent => ({
  projectId: row.project_id,
  version: row.version,
  attemptId: row.attempt_id,
  status: row.status,
  sourceGeneration: row.source_generation,
  targetImageRef: row.target_image_ref,
  failures: Number(row.failures),
  retryAt: new Date(row.retry_at),
  storageRefused: row.storage_refused,
  lastFailureAt: new Date(row.last_failure_at),
  lastFailureMessage: row.last_failure_message,
});

export class SandboxRepairIntentStore {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<SandboxRepairIntent[]> {
    const result =
      await sql<Row>`select project_id,version,attempt_id,status,source_generation,target_image_ref,failures,retry_at,storage_refused,
      last_failure_at,last_failure_message from sandbox_repair_intents
      order by project_id`.execute(this.db);
    return result.rows.map(fromRow);
  }

  /** Starts an automatic recreate. Deleted or explicitly stopped projects cannot
   * acquire a new automatic repair mandate from a stale reconcile snapshot. */
  async record(intent: SandboxRepairIntent): Promise<void> {
    const message = intent.lastFailureMessage.slice(0, SANDBOX_REPAIR_MESSAGE_LIMIT);
    await sql`insert into sandbox_repair_intents(project_id,version,attempt_id,status,source_generation,target_image_ref,failures,retry_at,storage_refused,
        last_failure_at,last_failure_message)
      select ${intent.projectId},${intent.version},${intent.attemptId},${intent.status},${intent.sourceGeneration},${intent.targetImageRef},${Math.max(0, Math.trunc(intent.failures))},${intent.retryAt},
        ${intent.storageRefused},${intent.lastFailureAt},${message}
      where exists (select 1 from projects where id=${intent.projectId} and state in ('active','failed','container_starting'))
      on conflict(project_id) do update set version=excluded.version,
        attempt_id=excluded.attempt_id,status=excluded.status,
        source_generation=excluded.source_generation,target_image_ref=excluded.target_image_ref,
        failures=excluded.failures,
        retry_at=excluded.retry_at, storage_refused=excluded.storage_refused,
        last_failure_at=excluded.last_failure_at,
        last_failure_message=excluded.last_failure_message`.execute(this.db);
  }

  /** A cancelled or superseded attempt must never recreate its durable intent. */
  async recordFailure(intent: SandboxRepairIntent): Promise<void> {
    await sql`update sandbox_repair_intents set status='waiting',
      failures=${intent.failures},retry_at=${intent.retryAt},storage_refused=${intent.storageRefused},
      last_failure_at=${intent.lastFailureAt},
      last_failure_message=${intent.lastFailureMessage.slice(0, SANDBOX_REPAIR_MESSAGE_LIMIT)}
      where project_id=${intent.projectId} and attempt_id=${intent.attemptId}`.execute(this.db);
  }

  /** Makes a storage-refused retry due now, once storage was released. */
  async releaseStorageBackoff(now: Date): Promise<void> {
    await sql`update sandbox_repair_intents set retry_at=${now}
      where storage_refused and retry_at > ${now}`.execute(this.db);
  }

  async clear(projectId: string): Promise<void> {
    await sql`delete from sandbox_repair_intents where project_id=${projectId}`.execute(this.db);
  }
}
