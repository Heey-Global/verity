import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * GitHub's numeric repository ID survives renames and transfers, unlike the
 * `(owner, repo)` name a project was registered under. Recording it lets token
 * requests name the repository by ID and lets the stored name follow a rename.
 * Nullable: existing rows learn their ID the next time Verity reaches them.
 */
export const githubRepositoryIdentityMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    for (const table of ['projects', 'project_repositories']) {
      await sql`alter table ${sql.table(table)} add column github_repository_id text
        check (github_repository_id ~ '^[1-9][0-9]{0,14}$')`.execute(db);
      await sql`create index ${sql.id(`${table}_github_repository_id`)}
        on ${sql.table(table)}(github_repository_id) where github_repository_id is not null`.execute(
        db,
      );
    }
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await sql`alter table projects drop column github_repository_id`.execute(db);
    await sql`alter table project_repositories drop column github_repository_id`.execute(db);
  },
};
