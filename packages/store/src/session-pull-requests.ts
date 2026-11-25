import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export class SessionPullRequestStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /** Keep a terminal PR hidden after the workspace first changes, across restarts. */
  async observeSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
    fingerprint: string,
  ): Promise<boolean> {
    const result = await sql<{ hidden: boolean }>`
      insert into session_pr_visibility(session_id, worktree, pr_url, fingerprint, hidden)
      values (${sessionId}, ${worktree}, ${url}, ${fingerprint}, false)
      on conflict (session_id, worktree, pr_url) do update set
        hidden = session_pr_visibility.hidden or
          session_pr_visibility.fingerprint <> excluded.fingerprint
      returning hidden
    `.execute(this.db);
    return result.rows[0]!.hidden;
  }

  async getSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
  ): Promise<{ fingerprint: string; hidden: boolean } | undefined> {
    return this.db
      .selectFrom('session_pr_visibility')
      .select(['fingerprint', 'hidden'])
      .where('session_id', '=', sessionId)
      .where('worktree', '=', worktree)
      .where('pr_url', '=', url)
      .executeTakeFirst();
  }

  /** Seed the final baseline after managed post-merge housekeeping has settled. */
  async clearSessionPrVisibility(sessionId: string, worktree: string, url: string): Promise<void> {
    await this.db
      .deleteFrom('session_pr_visibility')
      .where('session_id', '=', sessionId)
      .where('worktree', '=', worktree)
      .where('pr_url', '=', url)
      .execute();
  }

  async resetSessionPrVisibility(
    sessionId: string,
    worktree: string,
    url: string,
    fingerprint: string,
  ): Promise<void> {
    await this.db
      .insertInto('session_pr_visibility')
      .values({ session_id: sessionId, worktree, pr_url: url, fingerprint, hidden: false })
      .onConflict((oc) =>
        oc
          .columns(['session_id', 'worktree', 'pr_url'])
          .doUpdateSet({ fingerprint, hidden: false }),
      )
      .execute();
  }

  /** Reserve before transport: a crash spends a bounded attempt instead of resetting it. */
  async claimPrReadyDelivery(
    sessionId: string,
    marker: string,
    now: number,
  ): Promise<string | undefined> {
    const claim = randomUUID();
    const result = await sql<{ claim_id: string }>`
      insert into pr_ready_delivery(session_id, marker, attempts, next_attempt_at, claim_id, lease_until)
      values (${sessionId}, ${marker}, 1, ${now + 60_000}, ${claim}, ${now + 300_000})
      on conflict (session_id, marker) do update set
        attempts = pr_ready_delivery.attempts + 1,
        next_attempt_at = case when pr_ready_delivery.attempts = 0 then ${now + 60_000}::bigint else ${now + 300_000}::bigint end, claim_id = ${claim}, lease_until = ${now + 300_000}
      where not pr_ready_delivery.completed and pr_ready_delivery.attempts < 3
        and pr_ready_delivery.next_attempt_at <= ${now} and pr_ready_delivery.lease_until <= ${now}
      returning claim_id
    `.execute(this.db);
    return result.rows[0]?.claim_id;
  }

  async finishPrReadyDelivery(
    sessionId: string,
    marker: string,
    claim: string,
    outcome: 'done' | 'failed' | 'unattempted',
    now: number,
  ): Promise<void> {
    // Claim identity fences a slow former sender after its lease expired.
    await sql`update pr_ready_delivery set
      attempts = attempts - ${outcome === 'unattempted' ? 1 : 0},
      next_attempt_at = case when ${outcome === 'unattempted'} then ${now + 30_000} else next_attempt_at end,
      completed = ${outcome === 'done'}, claim_id = null, lease_until = 0
      where session_id = ${sessionId} and marker = ${marker} and claim_id = ${claim}`.execute(
      this.db,
    );
  }
}
