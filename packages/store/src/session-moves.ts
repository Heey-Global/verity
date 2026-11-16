import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** The workspace a session leaves behind, durably named before anything touches disk. */
export interface SessionRelayoutInput {
  sessionId: string;
  operationId: string;
  projectId: string;
  sourceWorktree: string;
  targetWorktree: string;
  branch: string;
}

/**
 * Session moves and same-project relayouts share `session_moves`: both retain the
 * old workspace, carry a notice to the agent and start the backend from history.
 */
export class SessionMoveStore {
  constructor(private readonly db: Kysely<Database>) {}

  async commit(
    sessionId: string,
    operationId: string,
    notice: string,
    resultJson: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const move = await tx
        .selectFrom('session_moves')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('operation_id', '=', operationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (move.result_json !== null) return;
      for (const projectId of [move.source_project_id, move.target_project_id].sort()) {
        const project = await tx
          .selectFrom('projects')
          .select(['hidden_at', 'kind'])
          .where('id', '=', projectId)
          .forShare()
          .executeTakeFirst();
        if (!project || project.hidden_at !== null || project.kind !== 'local')
          throw new Error('Move project is unavailable');
      }
      const session = await tx
        .selectFrom('sessions')
        .selectAll()
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        session.project_id !== move.source_project_id ||
        session.worktree !== move.source_worktree
      )
        throw new Error('Session workspace changed during move');
      await tx
        .deleteFrom('session_links')
        .where((eb) => eb.or([eb('session_a', '=', sessionId), eb('session_b', '=', sessionId)]))
        .execute();
      await tx
        .updateTable('sessions')
        .set({ project_id: move.target_project_id, worktree: move.target_worktree })
        .where('session_id', '=', sessionId)
        .execute();
      // Assigned work stays in its source project; moving the session revokes
      // the assignment and invalidates updates authorized before the move.
      await tx
        .updateTable('tasks')
        .set({ session_id: null, revision: sql`revision + 1`, updated_at: sql`now()` })
        .where('session_id', '=', sessionId)
        .execute();
      // The operator confirmed a check script against the source project. In the
      // target it would run against another repository and other secrets without
      // anyone having seen it there, so it waits until they resume it.
      await tx
        .updateTable('session_automations')
        .set({ status: 'paused', next_run_at: null, updated_at: sql`now()` })
        .where('session_id', '=', sessionId)
        .where('script', 'is not', null)
        .execute();
      await tx
        .updateTable('dev_servers')
        .set({ preview_session_id: null })
        .where('preview_session_id', '=', sessionId)
        .where('project_id', '=', move.source_project_id)
        .execute();
      const currentBindings = await tx
        .selectFrom('session_backend_state')
        .select('backend_session_id')
        .where('session_id', '=', sessionId)
        .execute();
      const retainedBackendIds = [
        ...new Set([
          ...(JSON.parse(move.backend_ids_json) as string[]),
          sessionId,
          ...currentBindings.map((binding) => binding.backend_session_id),
        ]),
      ];
      await tx.deleteFrom('session_backend_state').where('session_id', '=', sessionId).execute();
      await tx
        .updateTable('secret_provider_permissions')
        .set({ state: 'revoked', updated_at: new Date().toISOString() })
        .where('session_id', '=', sessionId)
        .where('project_id', '=', move.source_project_id)
        .execute();
      await tx
        .deleteFrom('secret_approvals')
        .where('session_id', '=', sessionId)
        .where('project_id', '=', move.source_project_id)
        .execute();
      await sql`delete from secret_run_grants where claims_json::jsonb->>'sessionId' = ${sessionId}
        and claims_json::jsonb->>'projectId' = ${move.source_project_id}`.execute(tx);
      await tx
        .updateTable('session_moves')
        .set({
          notice,
          result_json: resultJson,
          backend_ids_json: JSON.stringify(retainedBackendIds),
        })
        .where('session_id', '=', sessionId)
        .where('operation_id', '=', operationId)
        .execute();
    });
  }

  /** Reserve a relayout before touching disk. A retry with the same key keeps the first reservation. */
  async prepareRelayout(input: SessionRelayoutInput): Promise<void> {
    const bindings = await this.db
      .selectFrom('session_backend_state')
      .select('backend_session_id')
      .where('session_id', '=', input.sessionId)
      .execute();
    await this.db
      .insertInto('session_moves')
      .values({
        session_id: input.sessionId,
        operation_id: input.operationId,
        source_project_id: input.projectId,
        source_worktree: input.sourceWorktree,
        target_project_id: input.projectId,
        target_worktree: input.targetWorktree,
        branch: input.branch,
        on_commits: 'leave',
        backend_ids_json: JSON.stringify([
          input.sessionId,
          ...bindings.map((row) => row.backend_session_id),
        ]),
        notice: '',
        result_json: null,
      })
      .onConflict((oc) => oc.columns(['session_id', 'operation_id']).doNothing())
      .execute();
  }

  /**
   * Point the session at its new workspace within the same project. Unlike a move it
   * keeps tasks, automations, links and secret approvals, which all still apply. Backend
   * bindings are dropped: a native thread remembers the old working directory, so the
   * next turn starts from the session history instead.
   */
  async commitRelayout(
    sessionId: string,
    operationId: string,
    notice: string,
    resultJson: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const move = await tx
        .selectFrom('session_moves')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('operation_id', '=', operationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (move.result_json !== null) return;
      if (move.source_project_id !== move.target_project_id)
        throw new Error('A relayout stays within its project');
      const session = await tx
        .selectFrom('sessions')
        .select(['project_id', 'worktree'])
        .where('session_id', '=', sessionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        session.project_id !== move.source_project_id ||
        session.worktree !== move.source_worktree
      )
        throw new Error('Session workspace changed during relayout');
      const bindings = await tx
        .selectFrom('session_backend_state')
        .select('backend_session_id')
        .where('session_id', '=', sessionId)
        .execute();
      const retained = [
        ...new Set([
          ...(JSON.parse(move.backend_ids_json) as string[]),
          sessionId,
          ...bindings.map((row) => row.backend_session_id),
        ]),
      ];
      await tx.deleteFrom('session_backend_state').where('session_id', '=', sessionId).execute();
      await tx
        .updateTable('sessions')
        .set({ worktree: move.target_worktree })
        .where('session_id', '=', sessionId)
        .execute();
      await tx
        .updateTable('session_moves')
        .set({ notice, result_json: resultJson, backend_ids_json: JSON.stringify(retained) })
        .where('session_id', '=', sessionId)
        .where('operation_id', '=', operationId)
        .execute();
    });
  }
}
