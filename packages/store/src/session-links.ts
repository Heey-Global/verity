import { sql, type Kysely } from 'kysely';
import { egressDestinationDb } from './egress-destination-mutation.js';
import type { Database } from './schema.js';
import { isSessionLinkProject, type SessionLinkProject } from './project-session-links.js';
import { SessionCoordinationStore } from './session-coordination.js';

/** The link and its coordination receipt must commit together to preserve revocation on retry. */
export async function createStoredSessionLink(
  db: Kysely<Database>,
  leftId: string,
  rightId: string,
  available: (project: SessionLinkProject) => boolean,
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
            kind: project.kind,
            state: project.state,
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

export interface SessionLinkRecord {
  sessionId: string;
  peerSessionId: string;
  peerProjectId: string;
  peerName: string | null;
}

export type SessionLinkReservation = 'reserved' | 'duplicate' | 'exhausted' | 'unlinked';

export interface PendingSessionLinkMessage {
  id: string;
  invocationId: string;
  sourceSessionId: string;
  targetSessionId: string;
  sourceProjectId: string;
  requestMac: string;
  macKeyId: string;
  message: string;
  approvedAt: Date | null;
  createdAt: Date;
}

export class SessionLinkStore {
  constructor(private readonly rootDb: Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return egressDestinationDb(this.rootDb);
  }

  /** One delivery at a time leaves pool capacity for conductor acceptance. */
  private sessionLinkDeliveryTail: Promise<void> = Promise.resolve();

  async createSessionLink(leftId: string, rightId: string, requestId?: string): Promise<boolean> {
    return createStoredSessionLink(this.db, leftId, rightId, isSessionLinkProject, requestId);
  }

  async deleteSessionLink(leftId: string, rightId: string): Promise<boolean> {
    const [sessionA, sessionB] = [leftId, rightId].sort() as [string, string];
    const deleted = await this.db
      .deleteFrom('session_links')
      .where('session_a', '=', sessionA)
      .where('session_b', '=', sessionB)
      .returning('session_a')
      .executeTakeFirst();
    return deleted !== undefined;
  }

  /** Both endpoints are marked using one query for the overview. */
  async linkedSessionIds(): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('session_links')
      .select(['session_a', 'session_b'])
      .execute();
    return new Set(rows.flatMap((row) => [row.session_a, row.session_b]));
  }

  async listSessionLinks(sessionId: string): Promise<SessionLinkRecord[]> {
    const rows = await this.db
      .selectFrom('session_links')
      .innerJoin('sessions', (join) =>
        join
          .onRef('sessions.session_id', '=', 'session_links.session_a')
          .on('session_links.session_b', '=', sessionId),
      )
      .select(['sessions.session_id as peer_id', 'sessions.project_id', 'sessions.name'])
      .unionAll(
        this.db
          .selectFrom('session_links')
          .innerJoin('sessions', (join) =>
            join
              .onRef('sessions.session_id', '=', 'session_links.session_b')
              .on('session_links.session_a', '=', sessionId),
          )
          .select(['sessions.session_id as peer_id', 'sessions.project_id', 'sessions.name']),
      )
      .execute();
    return rows
      .filter((row) => row.project_id !== null)
      .map((row) => ({
        sessionId,
        peerSessionId: row.peer_id,
        peerProjectId: row.project_id!,
        peerName: row.name,
      }));
  }

  async sessionLinkHasAllowance(sourceId: string, targetId: string): Promise<boolean> {
    const [sessionA, sessionB] = [sourceId, targetId].sort() as [string, string];
    const row = await this.db
      .selectFrom('session_links')
      .select(['remaining_a', 'remaining_b'])
      .where('session_a', '=', sessionA)
      .where('session_b', '=', sessionB)
      .executeTakeFirst();
    return row !== undefined && (sourceId === sessionA ? row.remaining_a : row.remaining_b) > 0;
  }

  async sessionLinkHasDelivery(
    sourceId: string,
    targetId: string,
    invocationId: string,
  ): Promise<boolean> {
    const [sessionA, sessionB] = [sourceId, targetId].sort() as [string, string];
    const row = await this.db
      .selectFrom('session_link_deliveries')
      .select('invocation_id')
      .where('invocation_id', '=', invocationId)
      .where('session_a', '=', sessionA)
      .where('session_b', '=', sessionB)
      .where('source_session_id', '=', sourceId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async createPendingSessionLinkMessage(input: {
    id: string;
    invocationId: string;
    sourceSessionId: string;
    targetSessionId: string;
    sourceProjectId: string;
    requestMac: string;
    macKeyId: string;
    message: string;
  }): Promise<boolean> {
    const [sessionA, sessionB] = [input.sourceSessionId, input.targetSessionId].sort() as [
      string,
      string,
    ];
    return this.db.transaction().execute(async (trx) => {
      // Several links may share one source. Lock that session before counting so
      // concurrent requests to different peers cannot each fill the last slot.
      const source = await trx
        .selectFrom('sessions')
        .select('session_id')
        .where('session_id', '=', input.sourceSessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!source) return false;
      const link = await trx
        .selectFrom('session_links')
        .select('session_a')
        .where('session_a', '=', sessionA)
        .where('session_b', '=', sessionB)
        .forUpdate()
        .executeTakeFirst();
      if (!link) return false;
      const count = await trx
        .selectFrom('session_link_pending_messages')
        .select(sql<number>`count(*)::int`.as('count'))
        .where('source_session_id', '=', input.sourceSessionId)
        .executeTakeFirstOrThrow();
      if (count.count >= 6) throw new Error('too many linked messages awaiting approval');
      const inserted = await trx
        .insertInto('session_link_pending_messages')
        .values({
          id: input.id,
          invocation_id: input.invocationId,
          session_a: sessionA,
          session_b: sessionB,
          source_session_id: input.sourceSessionId,
          target_session_id: input.targetSessionId,
          source_project_id: input.sourceProjectId,
          request_mac: input.requestMac,
          mac_key_id: input.macKeyId,
          message: input.message,
          approved_at: null,
        })
        .onConflict((oc) => oc.column('invocation_id').doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted !== undefined;
    });
  }

  async listPendingSessionLinkMessages(
    sourceSessionId: string,
  ): Promise<PendingSessionLinkMessage[]> {
    const rows = await this.db
      .selectFrom('session_link_pending_messages')
      .selectAll()
      .where('source_session_id', '=', sourceSessionId)
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      invocationId: row.invocation_id,
      sourceSessionId: row.source_session_id,
      targetSessionId: row.target_session_id,
      sourceProjectId: row.source_project_id,
      requestMac: row.request_mac,
      macKeyId: row.mac_key_id,
      message: row.message,
      approvedAt: row.approved_at,
      createdAt: row.created_at,
    }));
  }

  async pendingSessionLinkMessageIds(
    sessionIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (sessionIds.length === 0) return result;
    const rows = await this.db
      .selectFrom('session_link_pending_messages')
      .select(['id', 'source_session_id'])
      .where('source_session_id', 'in', [...sessionIds])
      .execute();
    for (const row of rows) {
      const ids = result.get(row.source_session_id) ?? [];
      ids.push(row.id);
      result.set(row.source_session_id, ids);
    }
    return result;
  }

  async getPendingSessionLinkMessage(
    sourceSessionId: string,
    id: string,
  ): Promise<PendingSessionLinkMessage | undefined> {
    const row = await this.db
      .selectFrom('session_link_pending_messages')
      .selectAll()
      .where('source_session_id', '=', sourceSessionId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: row.id,
          invocationId: row.invocation_id,
          sourceSessionId: row.source_session_id,
          targetSessionId: row.target_session_id,
          sourceProjectId: row.source_project_id,
          requestMac: row.request_mac,
          macKeyId: row.mac_key_id,
          message: row.message,
          approvedAt: row.approved_at,
          createdAt: row.created_at,
        };
  }

  async approvePendingSessionLinkMessage(sourceSessionId: string, id: string): Promise<boolean> {
    const updated = await this.db
      .updateTable('session_link_pending_messages')
      .set({ approved_at: sql`coalesce(approved_at, now())` })
      .where('source_session_id', '=', sourceSessionId)
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return updated !== undefined;
  }

  async deletePendingSessionLinkMessage(sourceSessionId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .deleteFrom('session_link_pending_messages')
      .where('source_session_id', '=', sourceSessionId)
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return deleted !== undefined;
  }

  async reserveSessionLinkMessage(
    sourceId: string,
    targetId: string,
    invocationId: string,
    approvedRenewal: boolean,
    deliver?: () => Promise<void>,
  ): Promise<SessionLinkReservation> {
    const [sessionA, sessionB] = [sourceId, targetId].sort() as [string, string];
    const previous = this.sessionLinkDeliveryTail;
    let release = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionLinkDeliveryTail = finished;
    try {
      await previous;
      return await this.db.transaction().execute(async (trx) => {
        const link = await trx
          .selectFrom('session_links')
          .selectAll()
          .where('session_a', '=', sessionA)
          .where('session_b', '=', sessionB)
          .forUpdate()
          .executeTakeFirst();
        if (!link) return 'unlinked';
        const prior = await trx
          .selectFrom('session_link_deliveries')
          .select(['invocation_id', 'session_a', 'session_b', 'source_session_id'])
          .where('invocation_id', '=', invocationId)
          .executeTakeFirst();
        if (prior) {
          if (
            prior.session_a !== sessionA ||
            prior.session_b !== sessionB ||
            prior.source_session_id !== sourceId
          )
            throw new Error('linked message invocation was reused for a different target');
          await deliver?.();
          return 'duplicate';
        }
        const column = sourceId === sessionA ? 'remaining_a' : 'remaining_b';
        const remaining = link[column];
        if (remaining === 0 && !approvedRenewal) return 'exhausted';
        await trx
          .updateTable('session_links')
          .set({ [column]: remaining === 0 ? 5 : remaining - 1 })
          .where('session_a', '=', sessionA)
          .where('session_b', '=', sessionB)
          .execute();
        await trx
          .insertInto('session_link_deliveries')
          .values({
            invocation_id: invocationId,
            session_a: sessionA,
            session_b: sessionB,
            source_session_id: sourceId,
          })
          .execute();
        // The row lock keeps unlink and project changes from completing until
        // the target has accepted this turn. Global serialization leaves pool
        // capacity for conductor work that uses the same store.
        await deliver?.();
        return 'reserved';
      });
    } finally {
      release();
    }
  }
}
