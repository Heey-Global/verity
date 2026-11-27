import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';
import { storedMockupScreens, storedMockupState, type SessionMockups } from './session-mockups.js';

/** `active`: turns run without permission to change files until the operator
 *  ends planning. `implemented` / `discarded`: how the last planning round ended,
 *  which tells the app whether the newest plan was carried out. */
export type SessionPlanning = 'active' | 'implemented' | 'discarded';

export class SessionPlanningStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /** Move a session into or out of planning mode. `from` makes the write
   *  conditional, so two racing decisions (a tap on "Implement plan" and the
   *  approval of an agent's request) cannot both win. Answers whether it changed. */
  async setSessionPlanning(
    sessionId: string,
    planning: SessionPlanning,
    from?: readonly (SessionPlanning | null)[],
    expectedRevision?: number,
  ): Promise<boolean> {
    let query = this.db
      .updateTable('sessions')
      .set({ planning })
      .where('session_id', '=', sessionId);
    if (from !== undefined) {
      const states = from.filter((state): state is SessionPlanning => state !== null);
      query = query.where((eb) =>
        eb.or([
          ...(states.length > 0 ? [eb('planning', 'in', states)] : []),
          ...(from.includes(null) ? [eb('planning', 'is', null)] : []),
        ]),
      );
    }
    // A device can approve an old card while another device is publishing its revision.
    // Checking in this UPDATE prevents the read-before-write race from accepting it.
    if (expectedRevision !== undefined) {
      query = query.where('planning_revision', '=', expectedRevision);
      if (planning !== 'discarded') query = query.where('planning_plan', 'is not', null);
    }
    const result = await query.executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async startSessionPlanning(sessionId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({
        planning: 'active',
        // A new plan revokes reviews belonging to the previous accepted work.
        mockup_review: null,
        mockup_screens: '[]',
        mockup_revision: sql`mockup_revision + 1`,
        planning_plan: null,
        planning_revision: sql`planning_revision + 1`,
      })
      .where('session_id', '=', sessionId)
      .where((eb) => eb.or([eb('planning', 'is', null), eb('planning', '!=', 'active')]))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async presentSessionPlan(sessionId: string, plan: string): Promise<number | undefined> {
    const row = await this.db
      .updateTable('sessions')
      .set({ planning_plan: plan, planning_revision: sql`planning_revision + 1` })
      .where('session_id', '=', sessionId)
      .where('planning', '=', 'active')
      .returning('planning_revision')
      .executeTakeFirst();
    return row?.planning_revision;
  }

  /**
   * Change a session's mockup review under a row lock. `change` sees the current
   * review and answers the next one, or `undefined` to leave it as is; two devices
   * deciding different screens at once therefore both keep their verdict. Answers
   * the stored review, or `undefined` when the session is missing or nothing changed.
   */
  async updateSessionMockups(
    sessionId: string,
    change: (current: SessionMockups) => SessionMockups | undefined,
    expectedPlanningRevision?: number,
  ): Promise<SessionMockups | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('sessions')
        .select(['mockup_review', 'mockup_revision', 'mockup_screens', 'planning_revision'])
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      if (
        expectedPlanningRevision !== undefined &&
        row.planning_revision !== expectedPlanningRevision
      )
        return undefined;
      const next = change({
        state: storedMockupState(row.mockup_review),
        revision: row.mockup_revision,
        screens: storedMockupScreens(row.mockup_screens),
      });
      if (next === undefined) return undefined;
      await tx
        .updateTable('sessions')
        .set({
          mockup_review: next.state,
          mockup_revision: next.revision,
          mockup_screens: JSON.stringify(next.screens),
        })
        .where('session_id', '=', sessionId)
        .execute();
      return next;
    });
  }
}
