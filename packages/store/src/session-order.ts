import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export class SessionOrderStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  async sessionSortOrders(
    sessions: readonly { projectId: string | null; sessionId: string }[],
  ): Promise<Map<string, number>> {
    const groups = await this.getDb().selectFrom('session_overview_order').selectAll().execute();
    const result = new Map<string, number>();
    for (const group of groups) {
      const members = sessions.filter((session) => session.projectId === group.project_id);
      const live = new Set(members.map((session) => session.sessionId));
      const stored = new Set(group.ids);
      // Append new sessions so creating one does not shift the manual order.
      const ids = [
        ...group.ids.filter((id) => live.has(id)),
        ...members
          .filter((session) => !stored.has(session.sessionId))
          .map((session) => session.sessionId),
      ];
      ids.forEach((id, index) => result.set(id, index));
    }
    return result;
  }

  async reorderSessions(projectId: string | null, ids: readonly string[]): Promise<string[]> {
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate session IDs');
    return this.getDb()
      .transaction()
      .execute(async (tx) => {
        // Serialize reorders against membership changes, including moves and inserts.
        // Reordering is infrequent; a short registry lock avoids lost concurrent additions.
        await sql`lock table sessions in share row exclusive mode`.execute(tx);
        if (
          projectId !== null &&
          !(await tx
            .selectFrom('projects')
            .select('id')
            .where('id', '=', projectId)
            .executeTakeFirst())
        ) {
          throw new Error('Project not found');
        }
        const sessions = await tx
          .selectFrom('sessions')
          .select(['session_id', 'project_id'])
          .orderBy('created_at', 'asc')
          .orderBy('session_id', 'asc')
          .execute();
        const requested = new Set(ids);
        if (
          sessions.some(
            (session) => requested.has(session.session_id) && session.project_id !== projectId,
          )
        ) {
          throw new Error('Session belongs to another project');
        }
        const members = sessions.filter((session) => session.project_id === projectId);
        const live = new Set(members.map((session) => session.session_id));
        const canonical = [
          ...ids.filter((id) => live.has(id)),
          ...members
            .filter((session) => !requested.has(session.session_id))
            .map((session) => session.session_id),
        ];
        await tx
          .insertInto('session_overview_order')
          .values({
            group_key: JSON.stringify(projectId),
            project_id: projectId,
            ids: sql<string[]>`${JSON.stringify(canonical)}::jsonb`,
          })
          .onConflict((conflict) =>
            conflict
              .column('group_key')
              .doUpdateSet({ ids: sql<string[]>`${JSON.stringify(canonical)}::jsonb` }),
          )
          .execute();
        return canonical;
      });
  }
}
