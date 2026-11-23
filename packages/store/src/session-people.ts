import { sql, type Kysely } from 'kysely';

import type { Database } from './schema.js';

/** The people a session belongs to, beyond the turns they start in it. */
export class SessionPeopleStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * The people each session's requests fall to when no turn names one, in order:
   * the session's creator, then its project's creator. Each is a candidate the
   * caller can pass over when that person can no longer answer. Sessions with
   * neither are left out.
   */
  async owners(sessionIds: readonly string[]): Promise<Map<string, string[]>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('sessions as s')
      .leftJoin('session_creators as c', 'c.session_id', 's.session_id')
      .leftJoin('projects as p', 'p.id', 's.project_id')
      .select(['s.session_id', 'c.user_id as creator', 'p.created_by_user_id as projectCreator'])
      .where('s.session_id', 'in', [...sessionIds])
      .execute();
    return new Map(
      rows.flatMap((row) => {
        const people = [row.creator, row.projectCreator].filter(
          (person, index, all): person is string =>
            person !== null && all.indexOf(person) === index,
        );
        return people.length === 0 ? [] : [[row.session_id, people] as const];
      }),
    );
  }
}

/**
 * Record who started a session, inside its creation transaction. Only a known
 * person is recorded: an identity without a user row leaves the session with its
 * project's creator rather than failing its creation.
 */
export async function recordSessionCreator(
  db: Kysely<Database>,
  sessionId: string,
  userId: string,
): Promise<void> {
  await sql`insert into session_creators (session_id, user_id)
    select ${sessionId}, id from users where id = ${userId}`.execute(db);
}
