import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';
import { ensureProjectKnowledgeSpace } from './knowledge-spaces.js';
import {
  installationPlaceholderHasDependents,
  isInstallationPlaceholder,
  retireInstallationPlaceholder,
} from './installation-placeholders.js';
import { claimNextRepositoryInstance } from './project-identity-allocation.js';
import {
  projectColumns,
  projectRowToRecord,
  LOCAL_PROJECT_OWNER,
  ProjectIdentityClaimConflict,
  defaultProjectName,
  type ProjectUpsertInput,
  type ProjectRecord,
  type ProjectKind,
  type ProjectState,
} from './project-record.js';

export class ProjectLifecycleStore {
  constructor(private readonly currentDb: () => Kysely<Database>) {}
  private get db(): Kysely<Database> {
    return this.currentDb();
  }

  /** Insert a project without adopting an existing `(owner, repo)` row. Used for
   * operator-named local projects, where returning another concurrent request's
   * clone would cross an ownership boundary. A conflict is surfaced atomically
   * as the database's unique violation. */
  async createProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    const owner = input.owner.toLowerCase();
    const repo = input.repo.toLowerCase();
    const row = await this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const claimed = await tx
        .insertInto('project_identity_claims')
        .values({
          owner,
          repo,
          project_id: input.id,
          forge_connection_id: input.forgeConnectionId ?? null,
        })
        .onConflict((conflict) =>
          conflict.columns(['forge_scope', 'owner', 'repo', 'repository_instance']).doNothing(),
        )
        .returning('project_id')
        .executeTakeFirst();
      if (claimed === undefined) {
        throw new ProjectIdentityClaimConflict(`project identity ${owner}/${repo} is reserved`);
      }
      const project = await tx
        .insertInto('projects')
        .values({
          id: input.id,
          name: input.name ?? defaultProjectName({ repo }),
          owner,
          repo,
          container_name: input.containerName.toLowerCase(),
          kind: input.kind ?? 'github',
          forge_connection_id: input.forgeConnectionId ?? null,
          clone_dir: input.cloneDir ?? null,
          image_ref: input.imageRef ?? null,
          image_override_ref: input.imageRef ?? null,
          state: input.state,
          archived: input.archived ?? false,
          overview_visible: input.overviewVisible ?? false,
          provision_error: null,
          provision_warning: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (project) await ensureProjectKnowledgeSpace(tx, project.id, project.repo);
      return project;
    });
    return projectRowToRecord(row);
  }

  /**
   * Move a `local` project onto a GitHub repository: rewrite `(owner, repo)` and
   * flip `kind` to `github`, by ID rather than through the `(owner, repo)` upsert
   * (whose ON CONFLICT branch would target the WRONG row — the GitHub-side
   * identity we are moving TO).
   *
   * `container_name` stays (renaming would recreate the container); `clone_dir` is
   * pinned to the clone's current directory, as sessions persist absolute worktree
   * paths under it. Any GitHub repository ID is cleared; the new one is learned.
   *
   * Returns `undefined` when the project no longer exists. Throws the driver's
   * unique-violation when `(owner, repo)` is already registered — the caller maps
   * that to a conflict rather than silently merging two projects.
   */
  async linkProjectToGitHub(
    id: string,
    target: { owner: string; repo: string; forgeConnectionId?: string | null; kind?: ProjectKind },
  ): Promise<ProjectRecord | undefined> {
    const row = await this.db.transaction().execute(async (tx) => {
      // Serialize archive inheritance with installation sync and identity allocation.
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const existing = await tx
        .selectFrom('projects')
        .select(projectColumns)
        .forUpdate()
        .where('id', '=', id)
        .where('kind', '=', 'local')
        .executeTakeFirst();
      if (existing === undefined) return undefined;
      const targetOwner = target.owner.toLowerCase();
      const targetRepo = target.repo.toLowerCase();
      const targetProject = await tx
        .selectFrom('projects')
        .select('archived')
        .where('forge_scope', '=', target.forgeConnectionId ?? 'legacy-github')
        .where('owner', '=', targetOwner)
        .where('repo', '=', targetRepo)
        .orderBy('repository_instance', 'asc')
        .executeTakeFirst();
      const findClaim = () =>
        tx
          .selectFrom('project_identity_claims')
          .select('repository_instance')
          .where('project_id', '=', id)
          .where('forge_scope', '=', target.forgeConnectionId ?? 'legacy-github')
          .where('owner', '=', targetOwner)
          .where('repo', '=', targetRepo)
          .executeTakeFirst();
      let claim = await findClaim();
      if (claim === undefined || claim.repository_instance === 1) {
        // The placeholder stays intact while publication runs. Retire it only in
        // this final transaction, alongside the local project's identity rewrite,
        // so a pre-publication failure can restore its claim without losing any of
        // its dependent configuration.
        await retireInstallationPlaceholder(
          tx,
          targetOwner,
          targetRepo,
          id,
          target.forgeConnectionId,
        );
      }
      if (claim === undefined) {
        await tx
          .insertInto('project_identity_claims')
          .values({
            owner: targetOwner,
            repo: targetRepo,
            project_id: id,
            forge_connection_id: target.forgeConnectionId ?? null,
          })
          .onConflict((conflict) =>
            conflict.columns(['forge_scope', 'owner', 'repo', 'repository_instance']).doNothing(),
          )
          .execute();
        claim = await findClaim();
      }
      if (claim === undefined) {
        throw new ProjectIdentityClaimConflict(
          `project identity ${targetOwner}/${targetRepo} is not reserved`,
        );
      }
      const updated = await tx
        .updateTable('projects')
        .set({
          owner: targetOwner,
          repo: targetRepo,
          repository_instance: claim.repository_instance,
          archived: targetProject?.archived ?? false,
          kind: target.kind ?? 'github',
          forge_connection_id: target.forgeConnectionId ?? null,
          clone_dir: existing.clone_dir ?? `${existing.owner}-${existing.repo}`,
          github_repository_id: null,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .where('kind', '=', 'local')
        .returningAll()
        .executeTakeFirst();
      if (updated !== undefined) {
        await tx
          .deleteFrom('project_identity_claims')
          .where('forge_scope', '=', existing.forge_connection_id ?? 'legacy-github')
          .where('owner', '=', existing.owner)
          .where('repo', '=', existing.repo)
          .where('project_id', '=', id)
          .execute();
      }
      return updated;
    });
    return row ? projectRowToRecord(row) : undefined;
  }

  /** Disconnect by stable ID; pin the existing clone and preserve all dependent records. */
  async disconnectProjectFromGitHub(id: string): Promise<ProjectRecord | undefined> {
    const row = await this.db.transaction().execute(async (tx) => {
      // Match project creation and lifecycle lock order before allocating a local identity.
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const existing = await tx
        .selectFrom('projects')
        .select(projectColumns)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!existing || existing.hidden_at !== null || !['github', 'local'].includes(existing.kind))
        return undefined;
      if (existing.kind === 'local') return existing;
      let localRepo = existing.repo;
      for (let attempt = 1; ; attempt++) {
        const collision = await tx
          .selectFrom('projects')
          .select('id')
          .where('owner', '=', LOCAL_PROJECT_OWNER)
          .where('repo', '=', localRepo)
          .executeTakeFirst();
        const claim = await tx
          .selectFrom('project_identity_claims')
          .select('project_id')
          .where('owner', '=', LOCAL_PROJECT_OWNER)
          .where('repo', '=', localRepo)
          .executeTakeFirst();
        if (!collision && (!claim || claim.project_id === id)) break;
        localRepo = `${existing.repo}-${id}${attempt === 1 ? '' : `-${attempt}`}`;
      }
      const updated = await tx
        .updateTable('projects')
        .set({
          kind: 'local',
          owner: LOCAL_PROJECT_OWNER,
          repo: localRepo,
          repository_instance: 1,
          forge_connection_id: null,
          clone_dir: existing.clone_dir ?? `${existing.owner}-${existing.repo}`,
          github_repository_id: null,
          latest_release_tag: null,
          latest_release_name: null,
          latest_release_url: null,
          latest_release_published_at: null,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      await tx.deleteFrom('project_identity_claims').where('project_id', '=', id).execute();
      return updated;
    });
    return row ? projectRowToRecord(row) : undefined;
  }

  async reserveProjectIdentity(
    id: string,
    target: { owner: string; repo: string; forgeConnectionId?: string | null; kind?: ProjectKind },
  ): Promise<boolean> {
    const owner = target.owner.toLowerCase();
    const repo = target.repo.toLowerCase();
    const scope = target.forgeConnectionId ?? 'legacy-github';
    return this.db.transaction().execute(async (tx) => {
      // Serializes instance allocation with project creation and other links.
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const project = await tx
        .selectFrom('projects')
        .select(['id', 'owner', 'repo', 'forge_scope'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (project === undefined) return false;
      const claims = await tx
        .selectFrom('project_identity_claims')
        .select(['owner', 'repo', 'forge_scope'])
        .where('project_id', '=', id)
        .execute();
      // A local project normally owns its current local identity plus at most
      // one pending GitHub target. If a prior push was ambiguous, only that
      // exact target may be retried; reserving a second target would strand the
      // first claim and could publish the same project to multiple repositories.
      const hasDifferentPendingTarget = claims.some(
        (claim) =>
          (claim.forge_scope !== project.forge_scope ||
            claim.owner !== project.owner ||
            claim.repo !== project.repo) &&
          (claim.forge_scope !== (target.forgeConnectionId ?? 'legacy-github') ||
            claim.owner !== owner ||
            claim.repo !== repo),
      );
      if (hasDifferentPendingTarget) return false;
      // A retry of this project's own pending link keeps the instance it holds.
      if (
        claims.some(
          (claim) => claim.forge_scope === scope && claim.owner === owner && claim.repo === repo,
        )
      ) {
        return true;
      }
      // Keep a sync placeholder (and all of its dependent configuration) intact
      // while publication runs; only transfer its claim temporarily. The final
      // link transaction retires it atomically with the identity rewrite, while
      // releaseProjectIdentity restores the claim after a known failed push.
      const holder = await tx
        .selectFrom('projects')
        .select(['id', 'kind', 'state', 'overview_visible'])
        .forUpdate()
        .where('forge_scope', '=', scope)
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('repository_instance', '=', 1)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (holder !== undefined) {
        // The repository already backs a project: this one becomes another,
        // independent project of the same repository.
        if (
          !isInstallationPlaceholder({
            kind: holder.kind as ProjectKind,
            state: holder.state as ProjectState,
            overviewVisible: holder.overview_visible,
          }) ||
          (await installationPlaceholderHasDependents(tx, holder.id))
        ) {
          await claimNextRepositoryInstance(tx, { ...target, owner, repo }, id);
          return true;
        }
        // Hide the placeholder before releasing its row lock. createSession
        // takes a SHARE lock and rejects hidden projects, so this closes the
        // check-vs-spawn race for the entire external push window. `infinity`
        // marks a row that was visible before reservation; an already-hidden
        // placeholder keeps its original timestamp.
        await tx
          .updateTable('projects')
          .set({
            hidden_at: sql`case when hidden_at is null then 'infinity'::timestamptz else hidden_at end`,
            updated_at: sql`now()`,
          })
          .where('id', '=', holder.id)
          .execute();
        await tx
          .updateTable('project_identity_claims')
          .set({ project_id: id })
          .where('forge_scope', '=', target.forgeConnectionId ?? 'legacy-github')
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .where('project_id', '=', holder.id)
          .execute();
      }
      await tx
        .insertInto('project_identity_claims')
        .values({
          owner,
          repo,
          project_id: id,
          forge_connection_id: target.forgeConnectionId ?? null,
        })
        .onConflict((conflict) =>
          conflict.columns(['forge_scope', 'owner', 'repo', 'repository_instance']).doNothing(),
        )
        .execute();
      const claim = await tx
        .selectFrom('project_identity_claims')
        .select('project_id')
        .where('forge_scope', '=', scope)
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('repository_instance', '=', 1)
        .executeTakeFirst();
      if (claim?.project_id === id) return true;
      // Another link is reserving the first instance; take the next one.
      await claimNextRepositoryInstance(tx, { ...target, owner, repo }, id);
      return true;
    });
  }

  async releaseProjectIdentity(
    id: string,
    target: { owner: string; repo: string; forgeConnectionId?: string | null; kind?: ProjectKind },
  ): Promise<void> {
    const owner = target.owner.toLowerCase();
    const repo = target.repo.toLowerCase();
    await this.db.transaction().execute(async (tx) => {
      // Serialize with finalization on the source project. If another request
      // already completed the link, a failed older attempt must not release the
      // now-canonical GitHub identity claim.
      const local = await tx
        .selectFrom('projects')
        .select('id')
        .forUpdate()
        .where('id', '=', id)
        .where('kind', '=', 'local')
        .executeTakeFirst();
      if (local === undefined) return;
      const claim = await tx
        .selectFrom('project_identity_claims')
        .select('repository_instance')
        .where('project_id', '=', id)
        .where('forge_scope', '=', target.forgeConnectionId ?? 'legacy-github')
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .executeTakeFirst();
      // Only the first instance can have been taken over from a placeholder.
      const placeholder =
        claim?.repository_instance === 1
          ? await tx
              .selectFrom('projects')
              .select(['id', 'kind', 'state', 'overview_visible'])
              .forUpdate()
              .where('forge_scope', '=', target.forgeConnectionId ?? 'legacy-github')
              .where('owner', '=', owner)
              .where('repo', '=', repo)
              .where('repository_instance', '=', 1)
              .where('id', '!=', id)
              .executeTakeFirst()
          : undefined;
      if (
        placeholder !== undefined &&
        isInstallationPlaceholder({
          kind: placeholder.kind as ProjectKind,
          state: placeholder.state as ProjectState,
          overviewVisible: placeholder.overview_visible,
        })
      ) {
        // Only reservations of formerly-visible placeholders use the infinity
        // marker. Preserve a placeholder that was already soft-deleted.
        await tx
          .updateTable('projects')
          .set({ hidden_at: null, updated_at: sql`now()` })
          .where('id', '=', placeholder.id)
          .where('hidden_at', '=', sql<Date>`'infinity'::timestamptz`)
          .execute();
        await tx
          .updateTable('project_identity_claims')
          .set({ project_id: placeholder.id })
          .where('forge_scope', '=', target.forgeConnectionId ?? 'legacy-github')
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .where('project_id', '=', id)
          .execute();
        return;
      }
      await tx
        .deleteFrom('project_identity_claims')
        .where('forge_scope', '=', target.forgeConnectionId ?? 'legacy-github')
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('project_id', '=', id)
        .execute();
    });
  }

  /**
   * Soft-delete: mark a project hidden (`hidden_at = now()`) instead of dropping
   * the row. Keeps the row — and its stable id/settings — so the
   * GitHub-installation sync's re-upsert can't resurrect it (the sync leaves
   * `hidden_at` untouched; only an explicit restore clears it). Idempotent: a
   * second hide just refreshes the timestamp. Returns whether a row matched.
   */
  async hideProject(id: string): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const result = await tx
        .updateTable('projects')
        .set({ hidden_at: sql`now()`, updated_at: sql`now()` })
        .where('id', '=', id)
        .executeTakeFirst();
      const projectSessions = tx
        .selectFrom('sessions')
        .select('session_id')
        .where('project_id', '=', id);
      await tx
        .deleteFrom('session_links')
        .where((eb) =>
          eb.or([eb('session_a', 'in', projectSessions), eb('session_b', 'in', projectSessions)]),
        )
        .execute();
      await tx
        .updateTable('knowledge_folders')
        .set({ archived: true, project_id: null })
        .where('project_id', '=', id)
        .execute();
      await tx.deleteFrom('project_knowledge_spaces').where('project_id', '=', id).execute();
      return result.numUpdatedRows > 0n;
    });
  }

  async deleteProject(id: string): Promise<boolean> {
    const result = await this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      await tx
        .selectFrom('projects')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      const projectSessions = tx
        .selectFrom('sessions')
        .select('session_id')
        .where('project_id', '=', id);
      await tx
        .deleteFrom('session_links')
        .where((eb) =>
          eb.or([eb('session_a', 'in', projectSessions), eb('session_b', 'in', projectSessions)]),
        )
        .execute();
      await tx
        .updateTable('knowledge_folders')
        .set({ archived: true, project_id: null })
        .where('project_id', '=', id)
        .execute();
      await tx.deleteFrom('project_identity_claims').where('project_id', '=', id).execute();
      await tx.deleteFrom('integration_sources').where('project_id', '=', id).execute();
      return tx.deleteFrom('projects').where('id', '=', id).executeTakeFirst();
    });
    return result.numDeletedRows > 0n;
  }
}
