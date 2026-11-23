import { sql, type Kysely, type Transaction } from 'kysely';
import { retireInstallationPlaceholder } from './installation-placeholders.js';
import type { Database } from './schema.js';

/** What GitHub reported for a repository Verity asked about by name or by ID. */
export interface GitHubRepositoryObservation {
  /** The coordinates the caller used. Rows that still carry them and have no
   *  recorded ID are bound to {@link id}: either GitHub answered for exactly that
   *  name, or a row already bound to {@link id} carries it, in which case the
   *  unbound rows are further projects registered under that same repository. */
  requestedOwner: string;
  requestedRepo: string;
  /** GitHub's numeric repository ID, as a decimal string. */
  id: string;
  /** The repository's current, canonical coordinates. */
  owner: string;
  repo: string;
}

export interface GitHubRepositoryReconciliation {
  /** Projects whose default repository coordinates changed. */
  renamedProjectIds: string[];
  /** Projects with an additional repository whose coordinates changed. */
  renamedRepositoryProjectIds: string[];
}

/** At most 15 digits, so the ID always survives a round trip through a JS number. */
const GITHUB_REPOSITORY_ID = /^[1-9][0-9]{0,14}$/u;
const LEGACY_GITHUB_SCOPE = 'legacy-github';

/**
 * GitHub repository identity for projects on the GitHub App connection.
 *
 * Projects were keyed by `(owner, repo)` alone, so a rename on GitHub left the
 * project pointing at a name the App could no longer mint a token for. The
 * numeric repository ID survives a rename; this store records it and moves the
 * stored name to the canonical one by that ID. A row is only ever bound to an ID
 * GitHub reported for the row's own name, or matched by an ID already recorded,
 * so a different repository that later takes over an old name is never adopted.
 */
export class GitHubRepositoryIdentityStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** The recorded ID for repositories currently stored under `(owner, repo)`, or
   *  undefined when none is recorded yet. Throws when rows under that name are
   *  bound to different repositories: which one a caller means is unknowable, and
   *  falling back to the name would hand out whichever repository holds it now. */
  async lookup(owner: string, repo: string): Promise<string | undefined> {
    const o = owner.toLowerCase();
    const r = repo.toLowerCase();
    const rows = await sql<{ id: string }>`
      select github_repository_id as id from projects
        where forge_scope = ${LEGACY_GITHUB_SCOPE} and kind = 'github'
          and owner = ${o} and repo = ${r} and github_repository_id is not null
      union
      select github_repository_id as id from project_repositories
        where kind = 'github' and forge_connection_id is null and removed_at is null
          and lower(owner) = ${o} and lower(repo) = ${r} and github_repository_id is not null
    `.execute(this.db);
    if (rows.rows.length > 1)
      throw new Error(`${o}/${r} is bound to more than one GitHub repository`);
    return rows.rows[0]?.id;
  }

  /**
   * Record `observation.id` and move every row bound to it to the canonical name.
   *
   * Clone directories are pinned to the path the clone occupies, so sessions,
   * worktrees and the container keep their data. Project, repository and session
   * IDs never change. Idempotent: repeating an observation changes nothing.
   */
  async reconcile(
    observation: GitHubRepositoryObservation,
  ): Promise<GitHubRepositoryReconciliation> {
    if (!GITHUB_REPOSITORY_ID.test(observation.id)) throw new Error('invalid GitHub repository ID');
    const id = observation.id;
    const requested = {
      owner: observation.requestedOwner.toLowerCase(),
      repo: observation.requestedRepo.toLowerCase(),
    };
    const canonical = {
      owner: observation.owner.toLowerCase(),
      repo: observation.repo.toLowerCase(),
    };
    if (!canonical.owner || !canonical.repo) throw new Error('invalid GitHub repository name');
    return this.db.transaction().execute(async (tx) => {
      // Serialize with project creation, linking and the installation sync, which
      // allocate the same `(owner, repo, repository_instance)` identities.
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const renamedProjectIds = await this.reconcileProjects(tx, id, requested, canonical);
      const renamedRepositoryProjectIds = await this.reconcileRepositories(
        tx,
        id,
        requested,
        canonical,
      );
      return { renamedProjectIds, renamedRepositoryProjectIds };
    });
  }

  private async reconcileProjects(
    tx: Transaction<Database>,
    id: string,
    requested: { owner: string; repo: string },
    canonical: { owner: string; repo: string },
  ): Promise<string[]> {
    const rows = await tx
      .selectFrom('projects')
      .select(['id', 'owner', 'repo', 'repository_instance', 'clone_dir', 'github_repository_id'])
      .where('forge_scope', '=', LEGACY_GITHUB_SCOPE)
      .where('kind', '=', 'github')
      .where((eb) =>
        eb.or([
          eb('github_repository_id', '=', id),
          eb.and([
            eb('github_repository_id', 'is', null),
            eb('owner', '=', requested.owner),
            eb('repo', '=', requested.repo),
          ]),
        ]),
      )
      .orderBy('repository_instance')
      .orderBy('id')
      .forUpdate()
      .execute();
    const renamed: string[] = [];
    for (const row of rows) {
      if (row.owner === canonical.owner && row.repo === canonical.repo) {
        if (row.github_repository_id === null)
          await tx
            .updateTable('projects')
            .set({ github_repository_id: id })
            .where('id', '=', row.id)
            .execute();
        continue;
      }
      const instance = await this.canonicalInstance(tx, row.id, row.repository_instance, canonical);
      // A claim the project holds moves with it; `canonicalInstance` chose a free slot.
      await sql`update project_identity_claims
        set owner = ${canonical.owner}, repo = ${canonical.repo}, repository_instance = ${instance}
        where project_id = ${row.id} and forge_scope = ${LEGACY_GITHUB_SCOPE}
          and owner = ${row.owner} and repo = ${row.repo}`.execute(tx);
      await tx
        .updateTable('projects')
        .set({
          ...canonical,
          repository_instance: instance,
          github_repository_id: id,
          // The clone stays where it is: sessions persist absolute paths below it.
          clone_dir: row.clone_dir ?? `${row.owner}-${row.repo}`,
          updated_at: sql`now()`,
        })
        .where('id', '=', row.id)
        .execute();
      // Running sandboxes keep their capability; it names the current repository.
      await tx
        .updateTable('gh_token_capabilities')
        .set(canonical)
        .where('project_id', '=', row.id)
        .where('forge_connection_id', 'is', null)
        .where('owner', '=', row.owner)
        .where('repo', '=', row.repo)
        .execute();
      renamed.push(row.id);
    }
    return renamed;
  }

  /** Keep the project's instance number under the new name when it is free —
   *  adopting a sync placeholder that already took it — else take the next one. */
  private async canonicalInstance(
    tx: Transaction<Database>,
    projectId: string,
    current: number,
    canonical: { owner: string; repo: string },
  ): Promise<number> {
    const taken = async (instance: number): Promise<boolean> => {
      const holder = await sql<{ project_id: string }>`
        select id as project_id from projects
          where forge_scope = ${LEGACY_GITHUB_SCOPE} and owner = ${canonical.owner}
            and repo = ${canonical.repo} and repository_instance = ${instance}
        union all
        select project_id from project_identity_claims
          where forge_scope = ${LEGACY_GITHUB_SCOPE} and owner = ${canonical.owner}
            and repo = ${canonical.repo} and repository_instance = ${instance}
      `.execute(tx);
      return holder.rows.some((row) => row.project_id !== projectId);
    };
    if (!(await taken(current))) return current;
    if (
      current === 1 &&
      (await retireInstallationPlaceholder(tx, canonical.owner, canonical.repo, projectId)) &&
      !(await taken(current))
    )
      return current;
    const next = await sql<{ instance: number }>`
      select coalesce(max(repository_instance), 0) + 1 as instance from (
        select repository_instance from projects
          where forge_scope = ${LEGACY_GITHUB_SCOPE} and owner = ${canonical.owner}
            and repo = ${canonical.repo}
        union all
        select repository_instance from project_identity_claims
          where forge_scope = ${LEGACY_GITHUB_SCOPE} and owner = ${canonical.owner}
            and repo = ${canonical.repo}
      ) taken
    `.execute(tx);
    return Number(next.rows[0]?.instance ?? 1);
  }

  private async reconcileRepositories(
    tx: Transaction<Database>,
    id: string,
    requested: { owner: string; repo: string },
    canonical: { owner: string; repo: string },
  ): Promise<string[]> {
    const rows = await tx
      .selectFrom('project_repositories')
      .select(['id', 'project_id', 'name', 'owner', 'repo', 'github_repository_id'])
      .where('kind', '=', 'github')
      .where('forge_connection_id', 'is', null)
      .where('removed_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('github_repository_id', '=', id),
          eb.and([
            eb('github_repository_id', 'is', null),
            eb(sql<string>`lower(owner)`, '=', requested.owner),
            eb(sql<string>`lower(repo)`, '=', requested.repo),
          ]),
        ]),
      )
      .orderBy('id')
      .forUpdate()
      .execute();
    const renamed = new Set<string>();
    for (const row of rows) {
      const owner = row.owner.toLowerCase();
      const repo = row.repo.toLowerCase();
      const unchanged = owner === canonical.owner && repo === canonical.repo;
      // A project that already lists the new name keeps both rows as they are
      // rather than merging them; the ID still binds this one.
      const duplicate =
        !unchanged &&
        (await tx
          .selectFrom('project_repositories')
          .select('id')
          .where('project_id', '=', row.project_id)
          .where('id', '!=', row.id)
          .where('kind', '=', 'github')
          .where('forge_connection_id', 'is', null)
          .where('removed_at', 'is', null)
          .where(sql<string>`lower(owner)`, '=', canonical.owner)
          .where(sql<string>`lower(repo)`, '=', canonical.repo)
          .executeTakeFirst()) !== undefined;
      const rename = !unchanged && !duplicate;
      const displayName = row.name.trim().toLowerCase();
      await tx
        .updateTable('project_repositories')
        .set({
          github_repository_id: id,
          ...(rename ? canonical : {}),
          // Rename only a display name that merely repeated the old coordinates.
          ...(rename && (displayName === repo || displayName === `${owner}/${repo}`)
            ? {
                name:
                  displayName === repo ? canonical.repo : `${canonical.owner}/${canonical.repo}`,
              }
            : {}),
        })
        .where('id', '=', row.id)
        .execute();
      if (rename) renamed.add(row.project_id);
    }
    return [...renamed];
  }
}
