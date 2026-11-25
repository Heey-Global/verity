import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

export interface SessionBackendStateRecord {
  contextFingerprint?: string;
  sessionId: string;
  backend: string;
  backendSessionId: string;
  contextSeq: number;
  updatedAt: Date;
}

/** The person a backend-state key is scoped to, or '' for the unscoped key. */
function backendStateScope(backend: string): string {
  const separator = backend.indexOf('#');
  return separator < 0 ? '' : backend.slice(separator + 1);
}

export class SessionBackendStateStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  async getSessionBackendState(
    sessionId: string,
    backend: string,
  ): Promise<SessionBackendStateRecord | undefined> {
    const row = await this.db
      .selectFrom('session_backend_state')
      .select([
        'session_id',
        'backend',
        'backend_session_id',
        'context_seq',
        'updated_at',
        'context_fingerprint',
      ])
      .where('session_id', '=', sessionId)
      .where('backend', '=', backend)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      backend: row.backend,
      backendSessionId: row.backend_session_id,
      contextSeq: Number(row.context_seq),
      ...(row.context_fingerprint ? { contextFingerprint: row.context_fingerprint } : {}),
      updatedAt: row.updated_at,
    };
  }

  /**
   * Bind a session to one backend's resume state, replacing any other backend's.
   *
   * Returns the bindings that were DISPLACED by this write — the rows for backends the
   * session has just switched away from. They are returned rather than dropped because
   * each one names transcript files on the runner runtime, and this row was the only
   * pointer to them: once it is gone nothing can resolve those paths again, so a caller
   * that wants them cleaned up has exactly this one chance. Losing them is safe (the
   * conversation itself lives in `events`; the on-disk files are materialized back out
   * of it), but leaving the files is a leak that no later session delete can reach.
   */
  async upsertSessionBackendState(input: {
    sessionId: string;
    backend: string;
    backendSessionId: string;
    contextSeq: number;
    contextFingerprint?: string;
  }): Promise<SessionBackendStateRecord[]> {
    return await this.db.transaction().execute(async (tx) => {
      // Read before delete rather than `DELETE … RETURNING`: this runs on every bind,
      // against both the Postgres and PGlite dialects, and the extra round trip inside
      // the transaction is cheaper than a dialect-specific surprise here.
      // A key `backend#person` is one person's own thread (ADR 0023 §3); a bind
      // displaces only the same person's other backend, never someone else's.
      const scope = backendStateScope(input.backend);
      const displaced = (
        await tx
          .selectFrom('session_backend_state')
          .select([
            'session_id',
            'backend',
            'backend_session_id',
            'context_seq',
            'updated_at',
            'context_fingerprint',
          ])
          .where('session_id', '=', input.sessionId)
          .where('backend', '!=', input.backend)
          .execute()
      ).filter((row) => backendStateScope(row.backend) === scope);
      if (displaced.length > 0)
        await tx
          .deleteFrom('session_backend_state')
          .where('session_id', '=', input.sessionId)
          .where(
            'backend',
            'in',
            displaced.map((row) => row.backend),
          )
          .execute();
      await tx
        .insertInto('session_backend_state')
        .values({
          session_id: input.sessionId,
          backend: input.backend,
          backend_session_id: input.backendSessionId,
          context_seq: input.contextSeq,
          context_fingerprint: input.contextFingerprint ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['session_id', 'backend']).doUpdateSet({
            backend_session_id: input.backendSessionId,
            context_seq: input.contextSeq,
            context_fingerprint: input.contextFingerprint ?? null,
            updated_at: sql`now()`,
          }),
        )
        .execute();
      return displaced.map((row) => ({
        sessionId: row.session_id,
        backend: row.backend,
        backendSessionId: row.backend_session_id,
        contextSeq: Number(row.context_seq),
        ...(row.context_fingerprint ? { contextFingerprint: row.context_fingerprint } : {}),
        updatedAt: row.updated_at,
      }));
    });
  }

  async deleteSessionBackendState(sessionId: string, backend: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('session_backend_state')
      .where('session_id', '=', sessionId)
      .where('backend', '=', backend)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async getSessionBackendStates(sessionId: string): Promise<SessionBackendStateRecord[]> {
    const rows = await this.db
      .selectFrom('session_backend_state')
      .select([
        'session_id',
        'backend',
        'backend_session_id',
        'context_seq',
        'updated_at',
        'context_fingerprint',
      ])
      .where('session_id', '=', sessionId)
      .execute();
    return rows.map((row) => ({
      sessionId: row.session_id,
      backend: row.backend,
      backendSessionId: row.backend_session_id,
      contextSeq: Number(row.context_seq),
      ...(row.context_fingerprint ? { contextFingerprint: row.context_fingerprint } : {}),
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Every id under which a backend still knows a LIVE session — the union of the
   * `session_backend_state` bindings and the Verity session ids themselves (a
   * cold-started claude thread is opened under the Verity id, so that id names a file
   * on disk before any binding row exists).
   *
   * This is the spare-list for the startup artifact sweep: a transcript file whose id
   * is not in here belongs to a session that no longer exists. Deliberately one query
   * over both tables rather than per-session lookups — the sweep asks once, for all of
   * them, and a partial answer here would delete a live conversation.
   */
  async listLiveBackendSessionIds(): Promise<string[]> {
    const [bindings, sessions, moves] = await Promise.all([
      this.db.selectFrom('session_backend_state').select('backend_session_id').execute(),
      this.db.selectFrom('sessions').select('session_id').execute(),
      this.db
        .selectFrom('session_moves')
        .innerJoin('projects', 'projects.id', 'session_moves.source_project_id')
        .select('backend_ids_json')
        .where('projects.hidden_at', 'is', null)
        .execute(),
    ]);
    return [
      ...new Set([
        ...bindings.map((row) => row.backend_session_id),
        ...sessions.map((row) => row.session_id),
        ...moves.flatMap((row) => JSON.parse(row.backend_ids_json) as string[]),
      ]),
    ];
  }

  /**
   * The worktree path of every session that still exists. `sessions.worktree` is unique,
   * so this is one entry per session and needs no dedup.
   *
   * The startup artifact sweep needs this because a backend id is not enough to decide
   * ownership of a claude artifact: switching a session to another backend drops the row
   * naming its claude id, so the id stops being live while the session does not. Claude
   * files its transcripts under a directory named for the session's cwd — its worktree —
   * which stays true across every switch, so this is the fact the sweep can trust. See
   * `session-artifact-sweep.ts`.
   */
  async listSessionWorktrees(): Promise<string[]> {
    const rows = await this.db.selectFrom('sessions').select('worktree').execute();
    const retained = await this.db
      .selectFrom('session_moves')
      .innerJoin('projects', 'projects.id', 'session_moves.source_project_id')
      .select('source_worktree')
      .where('projects.hidden_at', 'is', null)
      .where('result_json', 'is not', null)
      .execute();
    return [
      ...new Set([
        ...rows.map((row) => row.worktree),
        ...retained.map((row) => row.source_worktree),
      ]),
    ];
  }

  async deleteSessionBackendStates(sessionId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('session_backend_state')
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async deleteProjectSessionBackendStates(projectId: string): Promise<number> {
    const result = await this.db
      .deleteFrom('session_backend_state')
      .where(
        'session_id',
        'in',
        this.db.selectFrom('sessions').select('session_id').where('project_id', '=', projectId),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
