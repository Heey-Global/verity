import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { egressDestinationDb } from './egress-destination-mutation.js';
import { computeNextRun } from './schedule.js';
import type { Database, ScheduleConfig } from './schema.js';

export type SessionAutomationOutcome = 'ok' | 'acted' | 'error' | 'skipped';

/** Only an `enabled` automation fires. */
export type SessionAutomationStatus = 'enabled' | 'paused';

/** Consecutive failed runs after which an automation pauses itself. */
export const SESSION_AUTOMATION_MAX_CONSECUTIVE_ERRORS = 5;

/** A recurring prompt bound to one session. */
export interface SessionAutomationRecord {
  id: string;
  sessionId: string;
  name: string;
  status: SessionAutomationStatus;
  schedule: ScheduleConfig;
  /** The task the session's agent receives on every run. */
  prompt: string;
  /** Optional check script; when present the agent is only woken on its signal. */
  script: string | null;
  /** Model for the dispatched turn; null keeps the session's model. */
  model: string | null;
  consecutiveErrorCount: number;
  lastRunAt: Date | null;
  lastOutcome: SessionAutomationOutcome | null;
  /** Short operator-facing explanation of the last outcome, if any. */
  lastDetail: string | null;
  nextRunAt: Date | null;
  /** The local user who confirmed it; null for automations confirmed before
   * sponsors were recorded. */
  sponsorUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Raised when a confirmed automation targets a workspace that has moved. */
export class SessionAutomationWorkspaceChangedError extends Error {
  constructor() {
    super('The session workspace changed. Confirm the automation again in its current project.');
    this.name = 'SessionAutomationWorkspaceChangedError';
  }
}

export interface SessionAutomationInput {
  sessionId: string;
  name: string;
  schedule: ScheduleConfig;
  prompt: string;
  script?: string | null;
  model?: string | null;
  sponsorUserId?: string | null;
}

export class SessionAutomationStore {
  constructor(private readonly rootDb: Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return egressDestinationDb(this.rootDb);
  }

  private sessionAutomationRowToRecord(row: {
    id: string;
    session_id: string;
    name: string;
    status: string;
    schedule: ScheduleConfig;
    prompt: string;
    script: string | null;
    model: string | null;
    consecutive_error_count: number;
    last_run_at: Date | null;
    last_outcome: string | null;
    last_detail: string | null;
    next_run_at: Date | null;
    sponsor_user_id: string | null;
    created_at: Date;
    updated_at: Date;
  }): SessionAutomationRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      status: row.status as SessionAutomationStatus,
      schedule: row.schedule,
      prompt: row.prompt,
      script: row.script,
      model: row.model,
      consecutiveErrorCount: row.consecutive_error_count,
      lastRunAt: row.last_run_at,
      lastOutcome: row.last_outcome as SessionAutomationOutcome | null,
      lastDetail: row.last_detail,
      nextRunAt: row.next_run_at,
      sponsorUserId: row.sponsor_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Create or replace the automation of one session. A session owns at most one
   * automation, so confirming a new proposal replaces the previous one in place.
   * The result is enabled immediately and armed for its next slot: the operator's
   * confirmation is the gate, not a separate enable step.
   */
  async setSessionAutomation(
    input: SessionAutomationInput,
    now: Date = new Date(),
    checkedWorkspace?: { projectId: string | null; worktree: string },
  ): Promise<SessionAutomationRecord> {
    const values = {
      name: input.name,
      status: 'enabled',
      schedule: JSON.stringify(input.schedule),
      prompt: input.prompt,
      script: input.script ?? null,
      model: input.model ?? null,
      consecutive_error_count: 0,
      last_run_at: null,
      last_outcome: null,
      last_detail: null,
      next_run_at: computeNextRun(input.schedule, now).toISOString(),
      // A replacement is confirmed by whoever confirmed it, so it re-sponsors.
      sponsor_user_id: input.sponsorUserId ?? null,
    };
    return this.db.transaction().execute(async (tx) => {
      // Serialize with commitSessionMove: a script checked in the old workspace
      // must not overwrite the move's pause or become enabled in the new one.
      const session = await tx
        .selectFrom('sessions')
        .select(['project_id', 'worktree'])
        .where('session_id', '=', input.sessionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        checkedWorkspace !== undefined &&
        (session.project_id !== checkedWorkspace.projectId ||
          session.worktree !== checkedWorkspace.worktree)
      ) {
        throw new SessionAutomationWorkspaceChangedError();
      }
      const row = await tx
        .insertInto('session_automations')
        .values({ id: randomUUID(), session_id: input.sessionId, ...values })
        // A replacement gets a fresh id. Claims and outcomes are keyed by id, so a
        // run of the previous configuration still in flight cannot record its result
        // (or its errors) against the one the operator just confirmed.
        .onConflict((oc) =>
          oc
            .column('session_id')
            .doUpdateSet({ ...values, id: randomUUID(), updated_at: sql`now()` }),
        )
        .returningAll()
        .executeTakeFirst();
      if (!row)
        throw new Error('verity: setSessionAutomation RETURNING yielded no row — dialect bug');
      return this.sessionAutomationRowToRecord(row);
    });
  }

  async getSessionAutomation(sessionId: string): Promise<SessionAutomationRecord | undefined> {
    const row = await this.db
      .selectFrom('session_automations')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row ? this.sessionAutomationRowToRecord(row) : undefined;
  }

  /**
   * Pause or resume a session's automation. Resuming re-arms it from `now` and
   * closes the error circuit, so an automation paused after repeated failures
   * gets a fresh run of attempts once the operator turns it back on.
   */
  async setSessionAutomationStatus(
    sessionId: string,
    status: SessionAutomationStatus,
    now: Date = new Date(),
  ): Promise<SessionAutomationRecord | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('session_automations')
        .selectAll()
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      // Re-sending the current status must neither reset the error budget nor
      // push an already armed slot further out.
      if (row.status === status) return this.sessionAutomationRowToRecord(row);
      const updated = await tx
        .updateTable('session_automations')
        .set({
          status,
          next_run_at:
            status === 'enabled' ? computeNextRun(row.schedule, now).toISOString() : null,
          ...(status === 'enabled' ? { consecutive_error_count: 0 } : {}),
          updated_at: sql`now()`,
        })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.sessionAutomationRowToRecord(updated);
    });
  }

  async deleteSessionAutomation(sessionId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('session_automations')
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Automation status per session, for the session list's automation marker.
   *  Sessions without an automation are absent from the map. */
  async listSessionAutomationStatuses(
    sessionIds: readonly string[],
  ): Promise<Map<string, SessionAutomationStatus>> {
    const statuses = new Map<string, SessionAutomationStatus>();
    if (sessionIds.length === 0) return statuses;
    const rows = await this.db
      .selectFrom('session_automations')
      .select(['session_id', 'status'])
      .where('session_id', 'in', sessionIds)
      .execute();
    for (const row of rows) statuses.set(row.session_id, row.status as SessionAutomationStatus);
    return statuses;
  }

  /** Enabled automations due at or before `now`, earliest-overdue first. */
  async listDueSessionAutomations(now: Date): Promise<SessionAutomationRecord[]> {
    const rows = await this.db
      .selectFrom('session_automations')
      .selectAll()
      .where('status', '=', 'enabled')
      .where('next_run_at', 'is not', null)
      .where('next_run_at', '<=', now)
      .orderBy('next_run_at', 'asc')
      .execute();
    return rows.map((r) => this.sessionAutomationRowToRecord(r));
  }

  /** The earliest armed due time, or `null` — the scheduler sleeps until then. */
  async nextSessionAutomationDueAt(): Promise<Date | null> {
    const row = await this.db
      .selectFrom('session_automations')
      .select((eb) => eb.fn.min('next_run_at').as('next'))
      .where('status', '=', 'enabled')
      .where('next_run_at', 'is not', null)
      .executeTakeFirst();
    return row?.next ?? null;
  }

  /**
   * Claim one due tick: advance `next_run_at` before any work starts, so a crash
   * mid-run cannot re-fire the same slot after a restart, and two server
   * generations cannot both run it. Returns false when another claimer won or the
   * automation was paused, replaced, or deleted in the meantime.
   */
  async claimSessionAutomationRun(id: string, ranAt: Date, nextRunAt: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('session_automations')
      .set({
        last_run_at: ranAt.toISOString(),
        next_run_at: nextRunAt.toISOString(),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .where('status', '=', 'enabled')
      .where('next_run_at', 'is not', null)
      .where('next_run_at', '<=', ranAt)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Record how a claimed run settled. Five consecutive errors pause the
   * automation so a broken one stops spending turns until the operator resumes it.
   */
  async recordSessionAutomationOutcome(
    id: string,
    result: { outcome: SessionAutomationOutcome; detail: string | null },
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const automation = await tx
        .selectFrom('session_automations')
        .select('consecutive_error_count')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!automation) return;
      const errorCount =
        result.outcome === 'error'
          ? automation.consecutive_error_count + 1
          : result.outcome === 'skipped'
            ? automation.consecutive_error_count
            : 0;
      const circuitOpen = errorCount >= SESSION_AUTOMATION_MAX_CONSECUTIVE_ERRORS;
      await tx
        .updateTable('session_automations')
        .set({
          last_outcome: result.outcome,
          last_detail: result.detail,
          consecutive_error_count: errorCount,
          ...(circuitOpen ? { status: 'paused', next_run_at: null } : {}),
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .execute();
    });
  }
}
