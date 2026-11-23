import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

import type { Database } from './schema.js';

/**
 * A member without Code submits a session's changes; members with Code check and
 * add them (ADR 0023). One current submission per session: submitting again after
 * a withdrawal replaces it. A table of its own, so an older server writing
 * sessions during a rolling upgrade never trips over it.
 */
export const changeSubmissionsMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`create table change_submissions (
      session_id text primary key references sessions(session_id) on delete cascade,
      submitted_by text not null references users(id) on delete cascade,
      submitted_at timestamptz not null default now(),
      revision text,
      pull_request_url text,
      pull_request_head text,
      state text not null check (state in ('submitted', 'withdrawn', 'added')),
      updated_at timestamptz not null default now()
    )`.execute(db);
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`drop table change_submissions`.execute(db);
  },
};

export type ChangeSubmissionState = 'submitted' | 'withdrawn' | 'added';

export interface ChangeSubmission {
  sessionId: string;
  submittedBy: string;
  submittedAt: Date;
  /** The commit the session's branch was at when submitted, when it could be read. */
  revision: string | null;
  /** A pull request the session already had when submitted, and its head commit
   *  then: until it changes, that pull request is not this submission's. */
  pullRequestUrl: string | null;
  pullRequestHead: string | null;
  state: ChangeSubmissionState;
}

/** Submitted session changes and who has written in those sessions since. */
export class ChangeSubmissionStore {
  constructor(private readonly db: Kysely<Database>) {}

  async submit(input: {
    sessionId: string;
    userId: string;
    revision?: string | undefined;
    pullRequestUrl?: string | undefined;
    pullRequestHead?: string | undefined;
  }): Promise<ChangeSubmission | undefined> {
    const row = await this.db
      .insertInto('change_submissions')
      .values({
        session_id: input.sessionId,
        submitted_by: input.userId,
        revision: input.revision ?? null,
        pull_request_url: input.pullRequestUrl ?? null,
        pull_request_head: input.pullRequestHead ?? null,
        state: 'submitted',
      })
      .onConflict((conflict) =>
        conflict
          .column('session_id')
          .doUpdateSet({
            submitted_by: input.userId,
            submitted_at: sql`now()`,
            revision: input.revision ?? null,
            pull_request_url: input.pullRequestUrl ?? null,
            pull_request_head: input.pullRequestHead ?? null,
            state: 'submitted',
            updated_at: sql`now()`,
          })
          // An open submission stays as it is: a second submit (a double tap, two
          // devices) must not restart the review or announce it twice.
          .where('change_submissions.state', '<>', 'submitted'),
      )
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : fromRow(row);
  }

  /** Moves an open submission to `state`; false when none was open. */
  async settle(sessionId: string, state: 'withdrawn' | 'added'): Promise<boolean> {
    const result = await this.db
      .updateTable('change_submissions')
      .set({ state, updated_at: sql`now()` })
      .where('session_id', '=', sessionId)
      .where('state', '=', 'submitted')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async get(sessionId: string): Promise<ChangeSubmission | undefined> {
    const row = await this.db
      .selectFrom('change_submissions')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row === undefined ? undefined : fromRow(row);
  }

  /** The open submissions among `sessionIds`. */
  async open(sessionIds: readonly string[]): Promise<Map<string, ChangeSubmission>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('change_submissions')
      .selectAll()
      .where('session_id', 'in', [...sessionIds])
      .where('state', '=', 'submitted')
      .execute();
    return new Map(rows.map((row) => [row.session_id, fromRow(row)]));
  }

  /**
   * The people who started a turn in each session after its submission, first
   * writer first: whoever with Code writes first is the one checking.
   */
  async writersSince(
    submissions: readonly Pick<ChangeSubmission, 'sessionId'>[],
  ): Promise<Map<string, string[]>> {
    const writers = new Map<string, string[]>();
    if (submissions.length === 0) return writers;
    const rows = await this.db
      .selectFrom('events as e')
      .innerJoin('change_submissions as c', 'c.session_id', 'e.session_id')
      .select([
        'e.session_id',
        sql<string | null>`e.payload->'initiatedBy'->>'userId'`.as('user_id'),
      ])
      .where(
        'e.session_id',
        'in',
        submissions.map((s) => s.sessionId),
      )
      .where('e.type', '=', 'prompt')
      .where('c.state', '=', 'submitted')
      // Both stamps come from the database clock.
      .whereRef('e.created_at', '>', 'c.submitted_at')
      .orderBy('e.id')
      .execute();
    for (const row of rows) {
      if (row.user_id === null) continue;
      const list = writers.get(row.session_id) ?? [];
      if (!list.includes(row.user_id)) list.push(row.user_id);
      writers.set(row.session_id, list);
    }
    return writers;
  }
}

function fromRow(row: {
  session_id: string;
  submitted_by: string;
  submitted_at: Date;
  revision: string | null;
  pull_request_url: string | null;
  pull_request_head: string | null;
  state: string;
}): ChangeSubmission {
  return {
    sessionId: row.session_id,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    revision: row.revision,
    pullRequestUrl: row.pull_request_url,
    pullRequestHead: row.pull_request_head,
    state: row.state as ChangeSubmissionState,
  };
}
