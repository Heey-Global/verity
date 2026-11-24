import type { ColumnType, Generated } from 'kysely';

export interface ProjectRepositoriesTable {
  id: string;
  project_id: string;
  name: string;
  kind: 'github' | 'forgejo';
  owner: string;
  repo: string;
  forge_connection_id: string | null;
  default_branch: string | null;
  removed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** GitHub's rename-stable repository ID, once learned; NULL for other code hosts. */
  github_repository_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface SessionRepositoryWorkspacesTable {
  session_id: string;
  repository_id: string;
  project_id: string;
  worktree: string;
  branch: string;
  pull_request: ColumnType<unknown, unknown, unknown>;
  pull_request_history: ColumnType<unknown, unknown, unknown>;
  created_at: Generated<Date>;
}
