import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, ProjectRepositoriesTable } from './schema.js';
import type { ProjectKind, ProjectRecord } from './store.js';

export interface ProjectRepositoryRecord {
  id: string;
  projectId: string;
  name: string;
  kind: ProjectKind;
  owner: string;
  repo: string;
  forgeConnectionId: string | null;
  defaultBranch: string | null;
  isDefault: boolean;
  removedAt: Date | null;
}

export interface AddProjectRepositoryInput {
  id?: string;
  projectId: string;
  name: string;
  kind: 'github' | 'forgejo';
  owner: string;
  repo: string;
  forgeConnectionId?: string | null;
  defaultBranch?: string | null;
}

export interface SessionRepositoryWorkspaceRecord {
  sessionId: string;
  repositoryId: string;
  projectId: string;
  worktree: string;
  branch: string;
  createdAt: Date;
  pullRequest?: unknown;
}

export function defaultProjectRepository(project: ProjectRecord): ProjectRepositoryRecord {
  return {
    id: `default:${project.id}`,
    projectId: project.id,
    name: project.repo,
    kind: project.kind ?? 'github',
    owner: project.owner,
    repo: project.repo,
    forgeConnectionId: project.forgeConnectionId ?? null,
    defaultBranch: null,
    isDefault: true,
    removedAt: null,
  };
}

/** Reuse forge implementations without granting a caller a different project. */
export function projectForRepository(
  project: ProjectRecord,
  repository: ProjectRepositoryRecord,
): ProjectRecord {
  if (repository.projectId !== project.id || repository.removedAt !== null)
    throw new Error('repository is not connected to this project');
  return {
    ...project,
    kind: repository.kind,
    owner: repository.owner,
    repo: repository.repo,
    forgeConnectionId: repository.forgeConnectionId,
  };
}

function record(row: Selectable<ProjectRepositoriesTable>): ProjectRepositoryRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    owner: row.owner,
    repo: row.repo,
    forgeConnectionId: row.forge_connection_id,
    defaultBranch: row.default_branch,
    isDefault: false,
    removedAt: row.removed_at,
  };
}

export class ProjectRepositoryStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly getProject: (id: string) => Promise<ProjectRecord | undefined>,
  ) {}

  async list(
    projectId: string,
    options: { includeRemoved?: boolean } = {},
  ): Promise<ProjectRepositoryRecord[]> {
    const project = await this.getProject(projectId);
    if (project === undefined) return [];
    let query = this.db
      .selectFrom('project_repositories')
      .selectAll()
      .where('project_id', '=', projectId);
    if (!options.includeRemoved) query = query.where('removed_at', 'is', null);
    const rows = await query.orderBy('name').orderBy('id').execute();
    return [defaultProjectRepository(project), ...rows.map(record)];
  }

  async get(projectId: string, id?: string): Promise<ProjectRepositoryRecord | undefined> {
    if (id === undefined || id === `default:${projectId}`) {
      const project = await this.getProject(projectId);
      return project === undefined ? undefined : defaultProjectRepository(project);
    }
    const row = await this.db
      .selectFrom('project_repositories')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('id', '=', id)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : record(row);
  }

  async add(input: AddProjectRepositoryInput): Promise<ProjectRepositoryRecord> {
    const id = input.id ?? randomUUID();
    if (
      id.startsWith('default:') ||
      !id ||
      !input.name.trim() ||
      !input.owner.trim() ||
      !input.repo.trim()
    )
      throw new Error('invalid repository identity');
    if (input.kind !== 'github' && input.kind !== 'forgejo')
      throw new Error('unsupported code host');
    return this.db.transaction().execute(async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', input.projectId)
        .forUpdate()
        .executeTakeFirst();
      if (project === undefined || project.hidden_at !== null) throw new Error('project not found');
      const owner = input.owner.trim().toLowerCase();
      const repo = input.repo.trim().toLowerCase();
      if (
        project.owner.toLowerCase() === owner &&
        project.repo.toLowerCase() === repo &&
        (project.kind ?? 'github') === input.kind &&
        (project.forge_connection_id ?? 'legacy-github') ===
          (input.forgeConnectionId ?? 'legacy-github')
      )
        throw new Error('repository is already the project default');
      const row = await tx
        .insertInto('project_repositories')
        .values({
          id,
          project_id: input.projectId,
          name: input.name.trim(),
          kind: input.kind,
          owner,
          repo,
          forge_connection_id: input.forgeConnectionId ?? null,
          default_branch: input.defaultBranch ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return record(row);
    });
  }

  async remove(projectId: string, id: string): Promise<boolean> {
    if (id === `default:${projectId}`)
      throw new Error('disconnect the default repository through project settings');
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('projects')
        .select('id')
        .where('id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      const removed = await tx
        .updateTable('project_repositories')
        .set({ removed_at: sql`now()` })
        .where('project_id', '=', projectId)
        .where('id', '=', id)
        .where('removed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return removed !== undefined;
    });
  }

  async listWorkspaces(sessionId: string): Promise<SessionRepositoryWorkspaceRecord[]> {
    const rows = await this.db
      .selectFrom('session_repository_workspaces')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('repository_id')
      .execute();
    return rows.map((row) => ({
      sessionId: row.session_id,
      projectId: row.project_id,
      repositoryId: row.repository_id,
      worktree: row.worktree,
      branch: row.branch,
      createdAt: row.created_at,
      pullRequest: row.pull_request,
    }));
  }

  async upsertWorkspace(
    input: Omit<SessionRepositoryWorkspaceRecord, 'createdAt'>,
  ): Promise<SessionRepositoryWorkspaceRecord> {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('projects')
        .select('id')
        .where('id', '=', input.projectId)
        .forUpdate()
        .executeTakeFirst();
      const session = await tx
        .selectFrom('sessions')
        .select('project_id')
        .where('session_id', '=', input.sessionId)
        .executeTakeFirst();
      if (session?.project_id !== input.projectId)
        throw new Error('session does not belong to this project');
      if (input.repositoryId !== `default:${input.projectId}`) {
        const repository = await tx
          .selectFrom('project_repositories')
          .select('id')
          .where('project_id', '=', input.projectId)
          .where('id', '=', input.repositoryId)
          .where('removed_at', 'is', null)
          .executeTakeFirst();
        if (repository === undefined)
          throw new Error('repository is not connected to this project');
      }
      await tx
        .insertInto('session_repository_workspaces')
        .values({
          session_id: input.sessionId,
          project_id: input.projectId,
          repository_id: input.repositoryId,
          worktree: input.worktree,
          branch: input.branch,
        })
        .onConflict((conflict) => conflict.columns(['session_id', 'repository_id']).doNothing())
        .execute();
      const row = await tx
        .selectFrom('session_repository_workspaces')
        .selectAll()
        .where('session_id', '=', input.sessionId)
        .where('repository_id', '=', input.repositoryId)
        .executeTakeFirstOrThrow();
      return {
        sessionId: row.session_id,
        projectId: row.project_id,
        repositoryId: row.repository_id,
        worktree: row.worktree,
        branch: row.branch,
        createdAt: row.created_at,
        pullRequest: row.pull_request,
      };
    });
  }
}
