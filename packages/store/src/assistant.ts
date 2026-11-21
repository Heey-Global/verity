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

/** The longest result summary kept for a handoff card. */
export const ASSISTANT_HANDOFF_SUMMARY_MAX = 300;

/** A handoff's recorded result; see {@link AssistantStore.claimResult}. */
export interface AssistantHandoffResult {
  target_session_id: string;
  delivered: boolean;
  summary: string;
  blocker: string | null;
  at: Date;
}

/** A session the assistant handed work to, recorded so it can read back the outcome. */
export interface AssistantHandoff {
  target_session_id: string;
  assistant_session_id: string;
  project_id: string;
  user_id: string | null;
  title: string;
  handed_off_at: Date;
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

  /** Records a delivered handoff. A later handoff to the same session — for any user —
   *  replaces the row, so its result is read from the most recent briefing on and belongs to
   *  whoever sent that one. */
  async recordHandoff(input: {
    targetSessionId: string;
    assistantSessionId: string;
    projectId: string;
    userId: string | undefined;
    title: string;
    handedOffAt: Date;
  }): Promise<void> {
    await sql`insert into assistant_handoffs
        (target_session_id, assistant_session_id, project_id, user_id, title, handed_off_at)
      values (${input.targetSessionId}, ${input.assistantSessionId}, ${input.projectId},
        ${input.userId ?? null}, ${input.title}, ${input.handedOffAt})
      on conflict (target_session_id) do update set
        assistant_session_id = excluded.assistant_session_id, project_id = excluded.project_id,
        user_id = excluded.user_id, title = excluded.title,
        handed_off_at = excluded.handed_off_at,
        result_seq = null, result_delivered = null, result_summary = null,
        result_blocker = null, result_at = null`.execute(this.db);
  }

  /** The handoff recorded for `targetSessionId`, if the assistant briefed it. */
  async handoff(targetSessionId: string): Promise<AssistantHandoff | undefined> {
    return (
      await sql<AssistantHandoff>`select * from assistant_handoffs
        where target_session_id = ${targetSessionId}`.execute(this.db)
    ).rows[0];
  }

  /**
   * Records the result published at `seq` for a handoff, once. Returns true only for the caller
   * that recorded it: a repeat of the same publication, a concurrent one, an older one, or one
   * matched against a handoff that has since been replaced records nothing, so each
   * publication is announced exactly once.
   */
  async claimResult(input: {
    assistantSessionId: string;
    targetSessionId: string;
    /** The handoff the result was matched against; a newer handoff refuses the claim. */
    handedOffAt: Date;
    seq: number;
    delivered: boolean;
    summary: string;
    blocker?: string | undefined;
    at: Date;
  }): Promise<boolean> {
    const updated = await sql`update assistant_handoffs
      set result_seq = ${input.seq}, result_delivered = ${input.delivered},
        result_summary = ${input.summary.slice(0, ASSISTANT_HANDOFF_SUMMARY_MAX)},
        result_blocker = ${input.blocker?.slice(0, ASSISTANT_HANDOFF_SUMMARY_MAX) ?? null},
        result_at = ${input.at}
      where target_session_id = ${input.targetSessionId}
        and assistant_session_id = ${input.assistantSessionId}
        -- Exact: recordHandoff stores the same JS Date (millisecond precision) it was given.
        and handed_off_at = ${input.handedOffAt}
        and (result_seq is null or result_seq < ${input.seq})
      returning target_session_id`.execute(this.db);
    return updated.rows.length > 0;
  }

  /** The recorded results among `targetSessionIds`, for the conversation's handoff cards. */
  async recordedResults(
    assistantSessionId: string,
    targetSessionIds: readonly string[],
  ): Promise<AssistantHandoffResult[]> {
    if (targetSessionIds.length === 0) return [];
    return (
      await sql<AssistantHandoffResult>`select target_session_id, result_delivered as delivered,
          result_summary as summary, result_blocker as blocker, result_at as at
        from assistant_handoffs where assistant_session_id = ${assistantSessionId}
          and target_session_id in (${sql.join([...targetSessionIds])})
          and result_seq is not null`.execute(this.db)
    ).rows;
  }

  /** The newest handoffs made for `userId` (null when auth is off) since `since`. */
  async handoffs(input: {
    userId: string | undefined;
    since: Date;
    limit: number;
  }): Promise<AssistantHandoff[]> {
    return (
      await sql<AssistantHandoff>`select * from assistant_handoffs
        where user_id is not distinct from ${input.userId ?? null} and handed_off_at >= ${input.since}
        order by handed_off_at desc limit ${input.limit}`.execute(this.db)
    ).rows;
  }
}
