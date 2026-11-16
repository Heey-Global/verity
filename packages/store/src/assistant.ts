import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** What the assistant may do in a project: nothing, file tasks, or also hand off work to sessions. */
export type AssistantMode = 'off' | 'tasks' | 'delegate';

export interface AssistantSettings {
  enabled: boolean;
  revision: number;
  sponsor_user_id: string | null;
  session_id: string | null;
}

/** A device message to the assistant, or an answer to one of its questions. */
export type AssistantRequestKind = 'message' | 'answer';

export interface AssistantRequest {
  request_id: string;
  session_id: string;
  user_id: string;
  kind: AssistantRequestKind;
  question_id: string | null;
  state: 'pending' | 'accepted';
  created_at: Date;
}

/** Outcome of {@link AssistantStore.claimRequest}. */
export type AssistantRequestClaim =
  | { claimed: true }
  /** The id was used before; `request` is that first delivery. */
  | { claimed: false; request: AssistantRequest }
  /** Another request already answered this question. */
  | { claimed: false; answeredBy: AssistantRequest };

export interface AssistantGrant {
  project_id: string;
  mode: AssistantMode;
  sponsor_user_id: string;
  revision: number;
}

/** The installation-wide assistant: one Verity Control session plus per-project grants. */
export class AssistantStore {
  constructor(private readonly db: Kysely<Database>) {}

  async settings(): Promise<AssistantSettings> {
    const row = (
      await sql<AssistantSettings>`select enabled, revision, sponsor_user_id, session_id from assistant_settings where id = 1`.execute(
        this.db,
      )
    ).rows[0];
    return row ?? { enabled: false, revision: 0, sponsor_user_id: null, session_id: null };
  }

  async configure(enabled: boolean, sponsor: string): Promise<void> {
    await sql`insert into assistant_settings(id, enabled, sponsor_user_id, revision) values (1, ${enabled}, ${sponsor}, 1) on conflict (id) do update set enabled = excluded.enabled, sponsor_user_id = case when excluded.enabled then excluded.sponsor_user_id else assistant_settings.sponsor_user_id end, revision = assistant_settings.revision + 1, updated_at = now()`.execute(
      this.db,
    );
  }

  /** Records the assistant session once; concurrent callers all get the first id. */
  async session(candidate: string): Promise<string> {
    const row = (
      await sql<{
        session_id: string;
      }>`update assistant_settings set session_id = coalesce(session_id, ${candidate}) where id = 1 returning session_id`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw new Error('The assistant is not configured');
    return row.session_id;
  }

  /** Swaps a stale session id for a fresh one; returns whichever id is stored afterwards. */
  async replaceSession(stale: string, candidate: string): Promise<string> {
    const row = (
      await sql<{
        session_id: string;
      }>`update assistant_settings set session_id = ${candidate} where id = 1 and session_id = ${stale} returning session_id`.execute(
        this.db,
      )
    ).rows[0];
    return row?.session_id ?? (await this.session(candidate));
  }

  async grants(): Promise<AssistantGrant[]> {
    return (
      await sql<AssistantGrant>`select project_id, mode, sponsor_user_id, revision from assistant_project_grants order by project_id`.execute(
        this.db,
      )
    ).rows;
  }

  async grant(projectId: string): Promise<AssistantGrant | undefined> {
    return (
      await sql<AssistantGrant>`select project_id, mode, sponsor_user_id, revision from assistant_project_grants where project_id = ${projectId}`.execute(
        this.db,
      )
    ).rows[0];
  }

  async setGrant(projectId: string, sponsor: string, mode: AssistantMode): Promise<void> {
    await sql`insert into assistant_project_grants (project_id, sponsor_user_id, mode) values (${projectId}, ${sponsor}, ${mode}) on conflict (project_id) do update set mode = excluded.mode, sponsor_user_id = excluded.sponsor_user_id, revision = assistant_project_grants.revision + 1, updated_at = now()`.execute(
      this.db,
    );
  }

  /**
   * Claims a client-minted request id before its turn is dispatched. A replay of
   * the same id returns the first row; a second answer to the same question is
   * refused through the partial unique index, so two devices cannot both answer.
   * A pending row older than `staleAfterMs` was left by a dispatch that never
   * finished (a crash between claim and turn) and is claimed again.
   */
  async claimRequest(input: {
    requestId: string;
    sessionId: string;
    userId: string;
    kind: AssistantRequestKind;
    questionId?: string;
    staleAfterMs?: number;
  }): Promise<AssistantRequestClaim> {
    const questionId = input.kind === 'answer' ? (input.questionId ?? null) : null;
    const inserted = await sql`insert into assistant_requests
        (request_id, session_id, user_id, kind, question_id)
      values (${input.requestId}, ${input.sessionId}, ${input.userId}, ${input.kind}, ${questionId})
      on conflict do nothing returning request_id`.execute(this.db);
    if (inserted.rows.length > 0) return { claimed: true };
    const existing = await this.request(input.requestId);
    if (existing !== undefined) {
      const stale = input.staleAfterMs ?? 120_000;
      if (
        existing.state === 'pending' &&
        existing.user_id === input.userId &&
        existing.session_id === input.sessionId &&
        existing.kind === input.kind &&
        existing.question_id === questionId
      ) {
        const reclaimed = await sql`update assistant_requests set created_at = now()
          where request_id = ${input.requestId} and state = 'pending'
            and created_at < now() - make_interval(secs => ${stale / 1000})
          returning request_id`.execute(this.db);
        if (reclaimed.rows.length > 0) return { claimed: true };
      }
      return { claimed: false, request: existing };
    }
    const answeredBy = (
      await sql<AssistantRequest>`select * from assistant_requests
        where session_id = ${input.sessionId} and question_id = ${questionId} and kind = 'answer'`.execute(
        this.db,
      )
    ).rows[0];
    if (answeredBy === undefined) throw new Error('assistant request claim lost a concurrent race');
    return { claimed: false, answeredBy };
  }

  async request(requestId: string): Promise<AssistantRequest | undefined> {
    return (
      await sql<AssistantRequest>`select * from assistant_requests where request_id = ${requestId}`.execute(
        this.db,
      )
    ).rows[0];
  }

  /** Marks a claimed request as delivered to the assistant session. */
  async acceptRequest(requestId: string): Promise<void> {
    await sql`update assistant_requests set state = 'accepted' where request_id = ${requestId}`.execute(
      this.db,
    );
  }

  /** Drops a claim whose turn was refused, so the device can retry the same id. */
  async releaseRequest(requestId: string): Promise<void> {
    await sql`delete from assistant_requests where request_id = ${requestId} and state = 'pending'`.execute(
      this.db,
    );
  }
}
