import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

export class BackupRepositoryStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /** Stable server-owned bookkeeping; identities never come from sandbox-written markers. */
  async backupGitRepositoryKey(projectId: string | null, path: string): Promise<string> {
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Invalid backup Git bookkeeping path');
    const key = randomUUID();
    if (projectId === null) {
      await this.db
        .insertInto('backup_unassigned_git_repositories')
        .values({ path, repo_key: key })
        .onConflict((conflict) => conflict.column('path').doNothing())
        .execute();
      return (
        await this.db
          .selectFrom('backup_unassigned_git_repositories')
          .select('repo_key')
          .where('path', '=', path)
          .executeTakeFirstOrThrow()
      ).repo_key;
    }
    await this.db
      .insertInto('backup_git_repositories')
      .values({ project_id: projectId, path, repo_key: key })
      .onConflict((conflict) => conflict.columns(['project_id', 'path']).doNothing())
      .execute();
    const row = await this.db
      .selectFrom('backup_git_repositories')
      .select('repo_key')
      .where('project_id', '=', projectId)
      .where('path', '=', path)
      .executeTakeFirstOrThrow();
    return row.repo_key;
  }
}
