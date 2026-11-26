import { SESSION_COLUMNS, sessionFromRow, type SessionRecord } from './session-rows.js';
import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';
import { resolve } from 'node:path';
import { DeletedProjectError } from './deleted-project-error.js';
import { waitForPendingMessageProjections } from './message-projection.js';
import { mergeSessionDeletionState, type SessionDeletionState } from './session-deletion-state.js';
import { sessionEventAppendLock, sessionEventAppendLockKey } from './session-event-lock.js';
import { recordSessionCreator } from './session-people.js';

interface SessionCreationInput {
  sessionId: string;
  worktree: string;
  model: string;
  name?: string | null;
  projectId?: string | null;
  createdByUserId?: string | null;
}

const sessionDeletionCleanupTails = new WeakMap<Kysely<Database>, Map<string, Promise<void>>>();

export class SessionLifecycleStore {
  constructor(private readonly currentDb: () => Kysely<Database>) {}
  private get db(): Kysely<Database> {
    return this.currentDb();
  }

  /** The immutable model choice of the newest ordinary session in a scope.
   * Legacy rows written before `initial_model` existed fall back to their current
   * model. Used only to seed a subsequent session; runtime model switches never
   * rewrite the remembered creation choice. */
  async getLastCreatedSessionModel(projectId: string | null): Promise<string | undefined> {
    let query = this.db.selectFrom('sessions').select(['initial_model', 'model']);
    query =
      projectId === null
        ? query.where('project_id', 'is', null)
        : query.where('project_id', '=', projectId);
    const row = await query
      .orderBy('created_at', 'desc')
      .orderBy('session_id', 'desc')
      .executeTakeFirst();
    return row?.initial_model ?? row?.model;
  }

  getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.findSession('session_id', sessionId);
  }

  /** The session owning a primary worktree, without loading every session. */
  getSessionByWorktree(worktree: string): Promise<SessionRecord | undefined> {
    return this.findSession('worktree', worktree);
  }

  private async findSession(
    column: 'session_id' | 'worktree',
    value: string,
  ): Promise<SessionRecord | undefined> {
    const row = await this.db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where(column, '=', value)
      .executeTakeFirst();
    return row && sessionFromRow(row);
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = await this.db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      // session_id tiebreaker: `created_at` is `now()` (tx-start), so rapid
      // inserts can share a timestamp — without this the order is unspecified.
      .orderBy('created_at', 'asc')
      .orderBy('session_id', 'asc')
      .execute();
    return rows.map(sessionFromRow);
  }

  /**
   * Register a session. The `worktree` UNIQUE constraint enforces the strict
   * 1:1 session ↔ worktree invariant (§5a) — a duplicate session id or worktree
   * rejects at the database, never silently overwrites.
   *
   * A project-bound session additionally takes a SHARE lock on its project row
   * for the length of the insert, and refuses a project that is already hidden
   * ({@link DeletedProjectError}). Deleting a project reaps its sessions, and
   * the check the route makes before that cannot cover a spawn that is already
   * under way: it read the project a worktree-creation ago. The lock decides
   * that race in the database instead of in wall-clock order — `hideProject`'s
   * UPDATE waits behind an in-flight insert (so the delete's final reap sees
   * that session), and an insert that arrives after the hide committed reads
   * `hidden_at` set and rejects. Without it a session could land after the last
   * reap and outlive its project, which is the whole bug.
   */
  async createSession(session: SessionCreationInput): Promise<void> {
    const values = {
      session_id: session.sessionId,
      worktree: session.worktree,
      model: session.model,
      initial_model: session.model,
      name: session.name ?? null,
      project_id: session.projectId ?? null,
    };
    const projectId = session.projectId;
    const insert = async (tx: Kysely<Database>): Promise<void> => {
      // Never occupy the serving pool waiting behind long physical cleanup.
      const admission = await sql<{
        locked: boolean;
      }>`select pg_try_advisory_xact_lock(hashtext(${sessionEventAppendLockKey(session.sessionId)})) as locked`.execute(
        tx,
      );
      if (admission.rows[0]?.locked !== true) throw new Error('Session is being deleted');
      await this.sessionWorktreeLock(tx, session.worktree);
      if (
        await tx
          .selectFrom('session_deletions')
          .select('session_id')
          .where('session_id', '=', session.sessionId)
          .executeTakeFirst()
      )
        throw new Error('Session is being deleted');
      if (
        await tx
          .selectFrom('session_deletions')
          .select('session_id')
          .where('worktree', '=', resolve(session.worktree))
          .where('cleanup_pending', '=', true)
          .executeTakeFirst()
      )
        throw new Error('Session worktree is being deleted');
      if (projectId !== undefined && projectId !== null) {
        const project = await tx
          .selectFrom('projects')
          .select('hidden_at')
          // SHARE, not UPDATE: unrelated spawns only serialize against a project delete.
          .forShare()
          .where('id', '=', projectId)
          .executeTakeFirst();
        if (project?.hidden_at != null) throw new DeletedProjectError(projectId);
      }
      await tx.insertInto('sessions').values(values).execute();
      if (session.createdByUserId)
        await recordSessionCreator(tx, session.sessionId, session.createdByUserId);
    };
    if (this.db.isTransaction) await insert(this.db);
    else await this.db.transaction().execute(insert);
  }

  /** Permanent admission tombstone; cleanup payload survives the session FK cascade. */
  async queueSessionDeletion(sessionId: string, payload: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sessionEventAppendLock(tx, sessionId);
      if (
        await tx
          .selectFrom('session_deletions')
          .select('session_id')
          .where('session_id', '=', sessionId)
          .executeTakeFirst()
      )
        return;
      const parsed = JSON.parse(payload) as SessionDeletionState;
      const session = await tx
        .selectFrom('sessions')
        .select('worktree')
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      const path = parsed.session?.worktree ?? session?.worktree;
      const worktree = path === undefined ? null : resolve(path);
      if (worktree !== null) {
        await this.sessionWorktreeLock(tx, worktree);
        if (
          await tx
            .selectFrom('session_deletions')
            .select('session_id')
            .where('worktree', '=', worktree)
            .where('cleanup_pending', '=', true)
            .executeTakeFirst()
        )
          throw new Error('Session worktree is being deleted');
      }
      await tx
        .insertInto('session_deletions')
        .values({ session_id: sessionId, payload, worktree })
        .execute();
    });
  }

  private async sessionWorktreeLock(tx: Kysely<Database>, path: string): Promise<void> {
    const result = await sql<{
      locked: boolean;
    }>`select pg_try_advisory_xact_lock(hashtext(${'session-worktree:' + resolve(path)})) as locked`.execute(
      tx,
    );
    if (result.rows[0]?.locked !== true) throw new Error('Session worktree is being deleted');
  }

  async isWorktreeBeingDeleted(path: string): Promise<boolean> {
    return (
      (await this.db
        .selectFrom('session_deletions')
        .select('session_id')
        .where('worktree', '=', resolve(path))
        .where('cleanup_pending', '=', true)
        .executeTakeFirst()) !== undefined
    );
  }

  async getSessionDeletion(
    sessionId: string,
  ): Promise<{ payload: string; cleanupPending: boolean } | undefined> {
    const row = await this.db
      .selectFrom('session_deletions')
      .select(['payload', 'cleanup_pending'])
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { payload: row.payload, cleanupPending: row.cleanup_pending };
  }

  async isSessionDeleting(sessionId: string): Promise<boolean> {
    return (
      (await this.db
        .selectFrom('session_deletions')
        .select('session_id')
        .where('session_id', '=', sessionId)
        .executeTakeFirst()) !== undefined
    );
  }

  async listPendingSessionDeletions(): Promise<{ sessionId: string; payload: string }[]> {
    const rows = await this.db
      .selectFrom('session_deletions')
      .select(['session_id', 'payload'])
      .where('cleanup_pending', '=', true)
      .execute();
    return rows.map((row) => ({ sessionId: row.session_id, payload: row.payload }));
  }

  async updateSessionDeletionPayload(sessionId: string, payload: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sessionEventAppendLock(tx, sessionId);
      const current = await tx
        .selectFrom('session_deletions')
        .select(['payload', 'cleanup_pending'])
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!current?.cleanup_pending) return;
      const merged = mergeSessionDeletionState(
        JSON.parse(current.payload) as SessionDeletionState,
        JSON.parse(payload) as SessionDeletionState,
      );
      await tx
        .updateTable('session_deletions')
        .set({ payload: JSON.stringify(merged) })
        .where('session_id', '=', sessionId)
        .execute();
    });
  }

  /** Hold cross-Server cleanup ownership without a transaction around host I/O.
   * Callback queries need their own pool connections; an open transaction here
   * deadlocks the single-connection test driver and can exhaust a production pool. */
  async withSessionDeletionCleanup(
    sessionId: string,
    work: (payload: string) => Promise<boolean>,
  ): Promise<boolean> {
    let tails = sessionDeletionCleanupTails.get(this.db);
    if (!tails) {
      tails = new Map();
      sessionDeletionCleanupTails.set(this.db, tails);
    }
    const previous = tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => completion);
    tails.set(sessionId, queued);
    await previous.catch(() => undefined);
    try {
      return await this.db.connection().execute(async (connection) => {
        const sessionKey = `session-cleanup:${sessionId}`;
        await sql`select pg_advisory_lock(hashtext(${sessionKey}))`.execute(connection);
        let worktree: string | null = null;
        try {
          const owned = await connection
            .selectFrom('session_deletions')
            .select(['worktree', 'payload', 'cleanup_pending'])
            .where('session_id', '=', sessionId)
            .executeTakeFirst();
          if (!owned?.cleanup_pending) return true;
          worktree = owned.worktree;
          if (worktree !== null)
            await sql`select pg_advisory_lock(hashtext(${'session-worktree:' + worktree}))`.execute(
              connection,
            );
          // A completed tombstone is permanent: stale requests cannot restart cleanup
          // after a different session legitimately reused the released worktree path.
          const current = await connection
            .selectFrom('session_deletions')
            .select(['payload', 'cleanup_pending'])
            .where('session_id', '=', sessionId)
            .executeTakeFirst();
          if (!current?.cleanup_pending) return true;
          if (!(await work(current.payload))) return false;
          await connection
            .updateTable('session_deletions')
            .set({ cleanup_pending: false, payload: '{}', worktree: null })
            .where('session_id', '=', sessionId)
            .execute();
          return true;
        } finally {
          try {
            if (worktree !== null)
              await sql`select pg_advisory_unlock(hashtext(${'session-worktree:' + worktree}))`.execute(
                connection,
              );
          } finally {
            await sql`select pg_advisory_unlock(hashtext(${sessionKey}))`.execute(connection);
          }
        }
      });
    } finally {
      release();
      if (tails.get(sessionId) === queued) tails.delete(sessionId);
    }
  }

  /**
   * Permanently delete a session and its durable log. The `events` and
   * `transcript_lines` foreign keys are `restrict`, so the child rows must go
   * first; all three deletes run in one transaction so a failure can never leave
   * orphaned events/lines pointing at a missing session (or, conversely, a
   * session stripped of its log). Returns `true` if a session row matched,
   * `false` if the id is unknown — the caller (server) maps `false` to a 404.
   *
   * This is the ONE delete path through the otherwise append-only store: it
   * removes a whole session on operator request, not individual events.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    await waitForPendingMessageProjections(this.db);
    return this.db.transaction().execute(async (tx) => {
      await sessionEventAppendLock(tx, sessionId);
      // Freeze FK-backed creations before capturing the IDs the cascade will erase.
      // A start committed after the initial HTTP snapshot must still be cleaned up.
      await tx
        .selectFrom('sessions')
        .select('session_id')
        .where('session_id', '=', sessionId)
        .forUpdate()
        .execute();
      const deletion = await tx
        .selectFrom('session_deletions')
        .select('payload')
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (deletion) {
        const payload = JSON.parse(deletion.payload) as SessionDeletionState;
        if (payload.session?.sessionId === sessionId) {
          const bindings = await tx
            .selectFrom('session_backend_state')
            .select(['backend', 'backend_session_id'])
            .where('session_id', '=', sessionId)
            .execute();
          payload.artifactBindings =
            mergeSessionDeletionState(payload, {
              artifactBindings: bindings.map((row) => ({
                backend: row.backend,
                backendSessionId: row.backend_session_id,
              })),
            }).artifactBindings ?? [];
          const previews = await tx
            .selectFrom('local_preview_shares')
            .select('id')
            .where('session_id', '=', sessionId)
            .execute();
          const instances = await tx
            .selectFrom('managed_dev_server_instances')
            .select(['id', 'project_id'])
            .where('session_id', '=', sessionId)
            .execute();
          payload.previewIds = [
            ...new Set([...(payload.previewIds ?? []), ...previews.map((row) => row.id)]),
          ];
          if (payload.managed || instances.length > 0)
            payload.managed = {
              sessionId,
              projectId:
                payload.managed?.projectId ??
                instances[0]?.project_id ??
                payload.session.projectId ??
                null,
              instanceIds: [
                ...new Set([
                  ...(payload.managed?.instanceIds ?? []),
                  ...instances.map((row) => row.id),
                ]),
              ],
            };
          await tx
            .updateTable('session_deletions')
            .set({ payload: JSON.stringify(payload) })
            .where('session_id', '=', sessionId)
            .execute();
        }
      }
      await tx.deleteFrom('transcript_lines').where('session_id', '=', sessionId).execute();
      await tx.deleteFrom('events').where('session_id', '=', sessionId).execute();
      // A session-scoped secret permission (ADR 0011 D2) is supposed to die with its
      // session, but nothing else expires it: it carries no expiry and no foreign key.
      // Left behind it would stay listed as live forever, and would auto-approve again
      // if this id were ever restored or reused. Ending it belongs in this transaction.
      await tx
        .updateTable('secret_provider_permissions')
        .set({ state: 'revoked', updated_at: new Date().toISOString() })
        .where('session_id', '=', sessionId)
        .where('state', '=', 'active')
        .execute();
      // The agent's unfinished steps were its plan for this session and end with
      // it; the operator's own tasks only lose the assignment (FK set null).
      await tx
        .updateTable('tasks')
        .set((eb) => ({
          status: 'dropped',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          revision: eb('revision', '+', 1),
        }))
        .where('session_id', '=', sessionId)
        .where('origin', '=', 'agent')
        .where('status', 'in', ['open', 'in_progress'])
        .execute();
      await sql`delete from project_inquiries where target_session_id=${sessionId}`.execute(tx);
      const result = await tx
        .deleteFrom('sessions')
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    });
  }
}
