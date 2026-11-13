import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** A person's sandbox in a project (ADR 0023 §4). */
export interface ProjectSandboxRecord {
  projectId: string;
  userId: string;
  /** The project's original container, kept under its pre-multi-user names. */
  projectDefault: boolean;
}

/** Container lifecycle of a person's sandbox (not the project default's). */
export interface ProjectSandboxState {
  state: string;
  provisionError: string | null;
  stateChangedAt: Date;
}

export class ProjectSandboxStore {
  constructor(private readonly db: Kysely<Database>) {}

  async get(projectId: string, userId: string): Promise<ProjectSandboxRecord | undefined> {
    const row = await this.db
      .selectFrom('project_sandboxes')
      .select(['project_id', 'user_id', 'project_default'])
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row && record(row);
  }

  /** The sandbox that serves work without a person: the project's original one. */
  async projectDefault(projectId: string): Promise<ProjectSandboxRecord | undefined> {
    const row = await this.db
      .selectFrom('project_sandboxes')
      .select(['project_id', 'user_id', 'project_default'])
      .where('project_id', '=', projectId)
      .where('project_default', '=', true)
      .executeTakeFirst();
    return row && record(row);
  }

  async list(projectId?: string): Promise<ProjectSandboxRecord[]> {
    let query = this.db
      .selectFrom('project_sandboxes')
      .select(['project_id', 'user_id', 'project_default'])
      .orderBy('project_id')
      .orderBy('created_at');
    if (projectId !== undefined) query = query.where('project_id', '=', projectId);
    return (await query.execute()).map(record);
  }

  /** The person's sandbox in the project, recorded on first use. */
  async ensure(projectId: string, userId: string): Promise<ProjectSandboxRecord> {
    await this.db
      .insertInto('project_sandboxes')
      .values({ project_id: projectId, user_id: userId })
      .onConflict((conflict) => conflict.columns(['project_id', 'user_id']).doNothing())
      .execute();
    const row = await this.get(projectId, userId);
    if (row === undefined) throw new Error('project sandbox could not be recorded');
    return row;
  }

  async state(projectId: string, userId: string): Promise<ProjectSandboxState | undefined> {
    const row = await this.db
      .selectFrom('project_sandboxes')
      .select(['state', 'provision_error', 'state_changed_at'])
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          state: row.state,
          provisionError: row.provision_error,
          stateChangedAt: row.state_changed_at,
        };
  }

  async setState(
    projectId: string,
    userId: string,
    state: string,
    provisionError: string | null = null,
  ): Promise<void> {
    await this.db
      .updateTable('project_sandboxes')
      .set({ state, provision_error: provisionError, state_changed_at: sql`now()` })
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .execute();
  }

  /** Record the project's original container as this person's sandbox. Used for a
   *  project created after the upgrade, whose first container is its default. */
  async ensureProjectDefault(projectId: string, userId: string): Promise<ProjectSandboxRecord> {
    const existing = await this.projectDefault(projectId);
    if (existing !== undefined) return existing;
    await this.db
      .insertInto('project_sandboxes')
      .values({ project_id: projectId, user_id: userId, project_default: true })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const row = await this.projectDefault(projectId);
    if (row === undefined) throw new Error('project default sandbox could not be recorded');
    return row;
  }
}

function record(row: {
  project_id: string;
  user_id: string;
  project_default: boolean;
}): ProjectSandboxRecord {
  return { projectId: row.project_id, userId: row.user_id, projectDefault: row.project_default };
}
