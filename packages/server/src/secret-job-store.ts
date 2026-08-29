import {
  secretJobStateSchema,
  secretJobTerminalResultSchema,
  type SecretJobState,
  type SecretJobTerminalResult,
} from '@verity/secret-contracts';
import type { Database } from '@verity/store';
import type { Kysely } from 'kysely';
import type { AuthenticatedApprovalActor } from './secret-authorization.js';

export interface StoredSecretJob {
  jobId: string;
  actorId: string;
  authorizationHash: string;
  state: SecretJobState | 'authorizing';
  result?: SecretJobTerminalResult;
}

export interface SecretJobStore {
  /** Exclusive startup recovery. Verity runs one embedded control-plane process per database. */
  recoverInterrupted(finishedAt: string, staleBefore: string): Promise<number>;
  reserve(jobId: string, actor: AuthenticatedApprovalActor): Promise<boolean>;
  get(jobId: string): Promise<StoredSecretJob | undefined>;
  update(
    jobId: string,
    state: SecretJobState | 'authorizing',
    result?: SecretJobTerminalResult,
  ): Promise<void>;
  delete(jobId: string): Promise<void>;
}

export function createInMemorySecretJobStore(): SecretJobStore {
  const jobs = new Map<string, StoredSecretJob & { updatedAt: string }>();
  return {
    recoverInterrupted(finishedAt, staleBefore) {
      let recovered = 0;
      for (const [jobId, job] of jobs) {
        if (
          (job.state !== 'authorizing' && job.state !== 'pending' && job.state !== 'running') ||
          Date.parse(job.updatedAt) > Date.parse(staleBefore)
        )
          continue;
        jobs.set(jobId, {
          ...job,
          state: 'reaped',
          result: { protocolVersion: 1, jobId, outcome: 'failed', finishedAt },
          updatedAt: finishedAt,
        });
        recovered += 1;
      }
      return Promise.resolve(recovered);
    },
    reserve(jobId, actor) {
      if (jobs.has(jobId)) return Promise.resolve(false);
      jobs.set(jobId, {
        jobId,
        actorId: actor.actorId,
        authorizationHash: actor.authorizationHash,
        state: 'authorizing',
        updatedAt: new Date().toISOString(),
      });
      return Promise.resolve(true);
    },
    get: (jobId) => Promise.resolve(jobs.get(jobId)),
    update(jobId, state, result) {
      const job = jobs.get(jobId);
      if (job === undefined) return Promise.reject(new Error('unknown secret job'));
      jobs.set(jobId, {
        ...job,
        state,
        ...(result !== undefined ? { result } : {}),
        updatedAt: new Date().toISOString(),
      });
      return Promise.resolve();
    },
    delete(jobId) {
      jobs.delete(jobId);
      return Promise.resolve();
    },
  };
}

export function createPostgresSecretJobStore(db: Kysely<Database>): SecretJobStore {
  return {
    async recoverInterrupted(finishedAt, staleBefore) {
      return db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('secret_jobs')
          .select('job_id')
          .where('state', 'in', ['authorizing', 'pending', 'running'])
          .where('updated_at', '<=', new Date(staleBefore))
          .forUpdate()
          .execute();
        let recovered = 0;
        for (const row of rows) {
          const result = await trx
            .updateTable('secret_jobs')
            .set({
              state: 'reaped',
              result_json: JSON.stringify({
                protocolVersion: 1,
                jobId: row.job_id,
                outcome: 'failed',
                finishedAt,
              }),
              updated_at: finishedAt,
            })
            .where('job_id', '=', row.job_id)
            .where('state', 'in', ['authorizing', 'pending', 'running'])
            .where('updated_at', '<=', new Date(staleBefore))
            .executeTakeFirst();
          recovered += Number(result.numUpdatedRows);
        }
        return recovered;
      });
    },
    async reserve(jobId, actor) {
      const row = await db
        .insertInto('secret_jobs')
        .values({
          job_id: jobId,
          actor_id: actor.actorId,
          authorization_hash: actor.authorizationHash,
          state: 'authorizing',
          result_json: null,
        })
        .onConflict((conflict) => conflict.column('job_id').doNothing())
        .returning('job_id')
        .executeTakeFirst();
      return row !== undefined;
    },
    async get(jobId) {
      const row = await db
        .selectFrom('secret_jobs')
        .select(['job_id', 'actor_id', 'authorization_hash', 'state', 'result_json'])
        .where('job_id', '=', jobId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        jobId: row.job_id,
        actorId: row.actor_id,
        authorizationHash: row.authorization_hash,
        state: row.state === 'authorizing' ? 'authorizing' : secretJobStateSchema.parse(row.state),
        ...(row.result_json !== null
          ? { result: secretJobTerminalResultSchema.parse(JSON.parse(row.result_json) as unknown) }
          : {}),
      };
    },
    async update(jobId, state, result) {
      const updated = await db
        .updateTable('secret_jobs')
        .set({
          state,
          ...(result !== undefined ? { result_json: JSON.stringify(result) } : {}),
          updated_at: new Date().toISOString(),
        })
        .where('job_id', '=', jobId)
        .executeTakeFirst();
      if (updated === undefined || Number(updated.numUpdatedRows) !== 1) {
        throw new Error('secret job state update did not match exactly one row');
      }
    },
    async delete(jobId) {
      await db.deleteFrom('secret_jobs').where('job_id', '=', jobId).execute();
    },
  };
}
