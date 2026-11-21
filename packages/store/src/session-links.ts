import type { Kysely } from 'kysely';
import type { Database } from './schema.js';
import type { ProjectKind, ProjectRecord } from './store.js';
import { SessionCoordinationStore } from './session-coordination.js';

/** The link and its coordination receipt must commit together to preserve revocation on retry. */
export async function createStoredSessionLink(
  db: Kysely<Database>,
  leftId: string,
  rightId: string,
  available: (project: Pick<ProjectRecord, 'kind' | 'state' | 'hiddenAt'>) => boolean,
  requestId?: string,
): Promise<boolean> {
  if (leftId === rightId) throw new Error('a session cannot link to itself');
  const [sessionA, sessionB] = [leftId, rightId].sort() as [string, string];
  return db.transaction().execute(async (tx) => {
    const sessions = await tx
      .selectFrom('sessions')
      .select(['session_id', 'project_id'])
      .where('session_id', 'in', [sessionA, sessionB])
      .orderBy('session_id')
      .forShare()
      .execute();
    if (sessions.length !== 2 || !sessions[0]?.project_id || !sessions[1]?.project_id)
      throw new Error('linked sessions must belong to projects');
    const projectIds = [...new Set([sessions[0].project_id, sessions[1].project_id])];
    const projects = await tx
      .selectFrom('projects')
      .select(['id', 'state', 'hidden_at', 'kind'])
      .where('id', 'in', projectIds)
      .orderBy('id')
      .forShare()
      .execute();
    if (
      projects.length !== projectIds.length ||
      projects.some(
        (project) =>
          !available({
            kind: project.kind as ProjectKind,
            state: project.state as ProjectRecord['state'],
            hiddenAt: project.hidden_at,
          }),
      )
    )
      throw new Error('linked sessions require available projects');
    const coordination = new SessionCoordinationStore(tx);
    if (requestId && !(await coordination.beginLink(leftId, requestId, rightId))) return false;
    const inserted = await tx
      .insertInto('session_links')
      .values({ session_a: sessionA, session_b: sessionB, remaining_a: 6, remaining_b: 6 })
      .onConflict((oc) => oc.columns(['session_a', 'session_b']).doNothing())
      .returning('session_a')
      .executeTakeFirst();
    if (requestId) await coordination.update(leftId, requestId, { phase: 'linked' });
    return inserted !== undefined;
  });
}
