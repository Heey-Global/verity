import { sql, type Transaction } from 'kysely';
import type { Database } from './schema.js';

/** Reserve the next free instance of a repository for `projectId`. The
 *  caller holds the project lifecycle lock, which serializes allocation. */
export async function claimNextRepositoryInstance(
  tx: Transaction<Database>,
  target: { owner: string; repo: string; forgeConnectionId?: string | null | undefined },
  projectId: string,
): Promise<number> {
  const scope = target.forgeConnectionId ?? 'legacy-github';
  const next = await sql<{ instance: number }>`
      select coalesce(max(repository_instance), 0) + 1 as instance from (
        select repository_instance from projects
          where forge_scope = ${scope} and owner = ${target.owner} and repo = ${target.repo}
        union all
        select repository_instance from project_identity_claims
          where forge_scope = ${scope} and owner = ${target.owner} and repo = ${target.repo}
      ) taken
    `.execute(tx);
  const instance = Number(next.rows[0]?.instance ?? 2);
  await tx
    .insertInto('project_identity_claims')
    .values({
      owner: target.owner,
      repo: target.repo,
      repository_instance: instance,
      project_id: projectId,
      forge_connection_id: target.forgeConnectionId ?? null,
    })
    .execute();
  return instance;
}
