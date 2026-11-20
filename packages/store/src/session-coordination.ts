import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export type SessionCoordinationPhase = 'reserved' | 'created' | 'linked' | 'delivered';
export interface SessionCoordinationReceipt {
  phase: SessionCoordinationPhase;
  result?: Record<string, unknown>;
}
const phases: SessionCoordinationPhase[] = ['reserved', 'created', 'linked', 'delivered'];

/** Keeps retries attached to one exact request, even when its target was deleted. */
export class SessionCoordinationStore {
  constructor(private readonly db: Kysely<Database>) {}

  async claim(
    sourceSessionId: string,
    requestId: string,
    fingerprint: string,
    targetSessionId: string,
  ): Promise<SessionCoordinationReceipt> {
    await sql`insert into session_coordination_requests
      (source_session_id, request_id, fingerprint, target_session_id)
      values (${sourceSessionId}, ${requestId}, ${fingerprint}, ${targetSessionId})
      on conflict (source_session_id, request_id) do nothing`.execute(this.db);
    const { rows } = await sql<{
      fingerprint: string;
      target_session_id: string;
      phase: SessionCoordinationPhase;
      result: Record<string, unknown> | null;
    }>`select fingerprint, target_session_id, phase, result from session_coordination_requests
      where source_session_id = ${sourceSessionId} and request_id = ${requestId}`.execute(this.db);
    const row = rows[0];
    if (!row) throw new Error('Session coordination source is unavailable');
    if (row.fingerprint !== fingerprint || row.target_session_id !== targetSessionId)
      throw new Error('Session coordination requestId was already used for a different request');
    return { phase: row.phase, ...(row.result === null ? {} : { result: row.result }) };
  }

  /** Locks the recovery receipt before a link can be created or reused. */
  async beginLink(
    sourceSessionId: string,
    requestId: string,
    targetSessionId: string,
  ): Promise<boolean> {
    const { rows } = await sql<{ target_session_id: string; phase: SessionCoordinationPhase }>`
      select target_session_id, phase from session_coordination_requests
      where source_session_id = ${sourceSessionId} and request_id = ${requestId}
      for update`.execute(this.db);
    const receipt = rows[0];
    if (!receipt || receipt.target_session_id !== targetSessionId)
      throw new Error('Session coordination request is unavailable');
    if (receipt.phase === 'linked' || receipt.phase === 'delivered') {
      const [left, right] = [sourceSessionId, targetSessionId].sort();
      const existing = await sql`select 1 from session_links
        where session_a = ${left} and session_b = ${right}`.execute(this.db);
      if (!existing.rows.length) throw new Error('Session link was revoked');
      return false;
    }
    return true;
  }

  async update(
    sourceSessionId: string,
    requestId: string,
    receipt: SessionCoordinationReceipt,
  ): Promise<void> {
    const preceding = phases.slice(0, phases.indexOf(receipt.phase) + 1);
    const result = await sql`update session_coordination_requests
      set phase = ${receipt.phase}, result = ${JSON.stringify(receipt.result ?? null)}::jsonb
      where source_session_id = ${sourceSessionId} and request_id = ${requestId}
      and phase in (${sql.join(preceding.map((phase) => sql`${phase}`))})`.execute(this.db);
    if (result.numAffectedRows === 0n) {
      const found = await sql`select 1 from session_coordination_requests
        where source_session_id = ${sourceSessionId} and request_id = ${requestId}`.execute(
        this.db,
      );
      if (found.rows.length === 0) throw new Error('Session coordination request is unavailable');
    }
  }
}
