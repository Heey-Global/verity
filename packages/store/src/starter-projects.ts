import { sql, type Kysely } from 'kysely';
import { ensureProjectKnowledgeSpace } from './knowledge-spaces.js';
import {
  defaultProjectName,
  projectRowToRecord,
  type ProjectRecord,
  type ProjectUpsertInput,
} from './project-record.js';
import type { Database } from './schema.js';

export class StarterProjectStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /**
   * Record the starter project a fresh installation created for itself. Only the
   * first call wins; the record keeps pointing at that project after it is
   * deleted (projects are soft-deleted), so it is never recreated.
   */
  async recordStarterProject(projectId: string): Promise<boolean> {
    const result = await this.db
      .insertInto('starter_project')
      .values({ singleton: true, project_id: projectId })
      .onConflict((oc) => oc.column('singleton').doNothing())
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  /** Explicit tour replay restores only the recorded starter, never a name match. */
  async ensureReplayStarterProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    const row = await this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const recorded = await tx
        .selectFrom('starter_project')
        .select('project_id')
        .executeTakeFirst();
      if (recorded) {
        const existing = await tx
          .selectFrom('projects')
          .selectAll()
          .where('id', '=', recorded.project_id)
          .forUpdate()
          .executeTakeFirst();
        if (existing) {
          if (existing.hidden_at === null) return existing;
          const restored = await tx
            .updateTable('projects')
            .set({
              hidden_at: null,
              archived: false,
              overview_visible: true,
              state: 'absent',
              provision_error: null,
              provision_warning: null,
              sleep_compatibility_fingerprint: null,
              sleeping_since: null,
              wake_started_at: null,
              state_changed_at: sql`now()`,
              updated_at: sql`now()`,
            })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await ensureProjectKnowledgeSpace(tx, restored.id, restored.repo);
          return restored;
        }
      }
      // A unique replay identity cannot claim a user's similarly named project.
      await tx
        .insertInto('project_identity_claims')
        .values({ owner: input.owner, repo: input.repo, project_id: input.id })
        .execute();
      const created = await tx
        .insertInto('projects')
        .values({
          id: input.id,
          name: input.name ?? defaultProjectName(input),
          owner: input.owner,
          repo: input.repo,
          container_name: input.containerName,
          kind: 'local',
          clone_dir: input.cloneDir ?? null,
          state: 'absent',
          overview_visible: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('starter_project')
        .values({ singleton: true, project_id: created.id })
        .onConflict((oc) => oc.column('singleton').doUpdateSet({ project_id: created.id }))
        .execute();
      await ensureProjectKnowledgeSpace(tx, created.id, created.repo);
      return created;
    });
    return projectRowToRecord(row);
  }

  async getStarterWelcomeSessionId(): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('starter_project')
      .select('welcome_session_id')
      .executeTakeFirst();
    return row?.welcome_session_id ?? undefined;
  }

  async recordStarterWelcomeSession(sessionId: string): Promise<void> {
    await this.db
      .updateTable('starter_project')
      .set({ welcome_session_id: sessionId })
      .where('singleton', '=', true)
      .execute();
  }

  async getStarterProjectId(): Promise<string | undefined> {
    const row = await this.db.selectFrom('starter_project').select('project_id').executeTakeFirst();
    return row?.project_id;
  }
}
