import { sql, type Kysely, type Transaction } from 'kysely';
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
  PROJECT_NAME_MAX_CHARS,
  InvalidProjectNameError,
  projectRowToRecord,
  LOCAL_PROJECT_OWNER,
  ProjectIdentityClaimConflict,
  defaultProjectName,
  type ProjectUpsertInput,
  type ProjectRecord,
  type ProjectKind,
  type ProjectState,
  type ProjectSetupState,
  type ProjectReleaseStatus,
} from './project-record.js';

export class ProjectLifecycleStore {
  constructor(
    private readonly currentDb: () => Kysely<Database>,
    private readonly readProject: (id: string) => Promise<ProjectRecord | undefined>,
  ) {}
  private get db(): Kysely<Database> {
    return this.currentDb();
  }

  /**
   * Idempotent upsert on `(owner, repo)`. Re-running the GitHub-installation sync
   * (slice 2) calls this with the same `(owner, repo)` and an `absent` state; the
   * ON CONFLICT branch keeps the existing `state`/`provision_error`-state (the
   * provisioning worker owns those fields, GitHub-sync must not clobber them).
   * `container_name` and an explicitly supplied image override are refreshed
   * from the input. Provisioning separately records its effective image.
   *
   * This method is the single lowercase-canonicalization site for the
   * `projects` table: `owner`, `repo`, `container_name` are passed through
   * `.toLowerCase()` BEFORE the write. The schema's `CHECK (owner = lower(owner)
   * AND repo = lower(repo))` constraint (§19.2 lowercase-persist guarantee) is
   * the DB-side backstop against direct writers; calling code that bypasses
   * `upsertProject` and hits the table via raw SQL must lowercase itself or
   * the CHECK throws.
   *
   * @returns the post-upsert row (CREATE form for a brand-new repo, UPDATE form
   *          for an existing one with the merged fields). Returned via
   *          `INSERT … ON CONFLICT DO UPDATE … RETURNING *` — atomic with the
   *          write, no separate SELECT that could race a concurrent
   *          `deleteProject` (slice 3) between insert and lookup.
   */
  async upsertProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    const row = await this.db.transaction().execute(async (tx) => {
      // Knowledge lifecycle mutations take this lock before touching a project
      // row. Match that order here so sync cannot deadlock with hide/delete.
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      return this.upsertPrimaryProject(tx, input);
    });
    if (!row) {
      // The only way `RETURNING *` returns undefined here is if the ORM/dialect
      // drops the returning clause — a contract bug, not a runtime path.
      throw new Error('verity: upsertProject RETURNING yielded no row — dialect bug');
    }
    return projectRowToRecord(row);
  }

  /** The body of {@link upsertProject}: always targets the repository's first
   *  project (instance 1). The caller holds the project lifecycle lock. */
  private async upsertPrimaryProject(tx: Transaction<Database>, input: ProjectUpsertInput) {
    // Lowercase the canonical (owner, repo) and the derived container_name so
    // the persisted form honours §19.0/§19.2's lowercase-persist contract
    // (without forcing every caller — including GitHub-sync — to remember).
    const owner = input.owner.toLowerCase();
    const repo = input.repo.toLowerCase();
    const containerName = input.containerName.toLowerCase();
    const legacyContainerNames = [`dev-${owner}--${repo}`, `dev-${owner}-${repo}`];
    const shouldMigrateLegacyContainerName = containerName.startsWith('verity-');

    // A sync may omit the connection, but must never change the provider of
    // an existing project identified by its durable ID.
    const byId = await tx
      .selectFrom('projects')
      .select(['kind', 'forge_connection_id', 'repository_instance'])
      .where('id', '=', input.id)
      .executeTakeFirst();
    // The upsert resolves by the repository's first project. A further project
    // of the same repository must never be rewritten into, or confused with, it.
    if (byId && byId.repository_instance !== 1) {
      throw new ProjectIdentityClaimConflict(
        'Project is a further project of its repository and cannot be upserted',
      );
    }
    if (byId && (byId.kind === 'forgejo') !== (input.kind === 'forgejo')) {
      throw new ProjectIdentityClaimConflict(
        'Project identity belongs to another forge connection',
      );
    }
    if (input.forgeConnectionId === undefined && byId?.forge_connection_id) {
      input = { ...input, forgeConnectionId: byId.forge_connection_id };
    }
    const existingBinding = await tx
      .selectFrom('projects')
      .select(['kind', 'forge_connection_id'])
      .where('forge_scope', '=', input.forgeConnectionId ?? 'legacy-github')
      .where('owner', '=', owner)
      .where('repo', '=', repo)
      .where('repository_instance', '=', 1)
      .executeTakeFirst();
    if (
      existingBinding !== undefined &&
      ((existingBinding.kind === 'forgejo') !== (input.kind === 'forgejo') ||
        (input.forgeConnectionId !== undefined &&
          existingBinding.forge_connection_id !== null &&
          existingBinding.forge_connection_id !== input.forgeConnectionId))
    ) {
      throw new ProjectIdentityClaimConflict(
        'Project identity belongs to another forge connection',
      );
    }
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
      const [claim, existing] = await Promise.all([
        tx
          .selectFrom('project_identity_claims')
          .select('project_id')
          .where('forge_scope', '=', input.forgeConnectionId ?? 'legacy-github')
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .where('repository_instance', '=', 1)
          .executeTakeFirstOrThrow(),
        tx
          .selectFrom('projects')
          .select('id')
          .where('forge_scope', '=', input.forgeConnectionId ?? 'legacy-github')
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .where('repository_instance', '=', 1)
          .executeTakeFirst(),
      ]);
      if (existing === undefined || claim.project_id !== existing.id) {
        throw new ProjectIdentityClaimConflict(`project identity ${owner}/${repo} is reserved`);
      }
    }
    const project = await tx
      .insertInto('projects')
      .values({
        id: input.id,
        name: input.name ?? defaultProjectName({ repo }),
        owner,
        repo,
        container_name: containerName,
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
      .onConflict((oc) =>
        oc.columns(['forge_scope', 'owner', 'repo', 'repository_instance']).doUpdateSet({
          // Preserve custom adopted container names, but migrate old deterministic
          // `dev-<owner>--<repo>` / `dev-<owner>-<repo>` rows to the current
          // canonical `verity-<owner>--<repo>` name. Without this, fresh servers
          // can keep pointing at a legacy Dogfood container and miss current
          // runtime mounts and gateway routing configuration.
          container_name: shouldMigrateLegacyContainerName
            ? sql`case when projects.container_name in (${sql.join(legacyContainerNames)}) then ${containerName} else projects.container_name end`
            : sql`projects.container_name`,
          // Provisioning-owned state stays untouched (the worker's
          // `cloning/container_starting/active/failed` survives a sync pass).
          // The image fields are only touched when the caller EXPLICITLY sets an
          // override: `input.imageRef === undefined` means
          // "I have no opinion, leave what's pinned" (preserves a slice-3 pin
          // across slice-2 list refreshes), while `null` means "explicitly
          // clear the pin" (operator-driven unpin). Slice 2's sync passes
          // undefined → no-op.
          // `toolkit_identity` travels with `image_ref` because it is a
          // statement ABOUT that image: an operator pinning a NEW one has
          // pinned something nothing has attested, and carrying the old
          // verdict forward would let the new image inherit an all-clear it
          // never earned. The next provisioning writes the real answer.
          //
          // Which is why the clear is conditional on the image actually
          // moving. Re-saving the same pin — an idempotent settings write, a
          // re-add of a project that never changed — leaves the effective
          // image exactly as attested, so discarding the verdict there would
          // manufacture an "unknown toolkit" warning about an image that was
          // checked and passed, and it would stay wrong until the next
          // provisioning. `is distinct from` compares against the PRE-update
          // row (`projects.` in an ON CONFLICT update), and treats a null on
          // either side as a difference rather than as unknown.
          ...(input.imageRef !== undefined
            ? {
                image_ref: input.imageRef,
                image_override_ref: input.imageRef,
                toolkit_identity: sql<
                  string | null
                >`case when projects.image_ref is distinct from ${input.imageRef} then null else projects.toolkit_identity end`,
              }
            : {}),
          ...(input.forgeConnectionId !== undefined
            ? { forge_connection_id: input.forgeConnectionId }
            : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.archived !== undefined ? { archived: input.archived } : {}),
          ...(input.overviewVisible !== undefined
            ? { overview_visible: input.overviewVisible }
            : {}),
          // `restore` (the POST /projects re-add path) un-hides an existing
          // row. Omitted by the installation sync, so a re-sync of a repo the
          // operator deleted keeps it hidden rather than resurrecting it.
          ...(input.restore === true ? { hidden_at: null } : {}),
          updated_at: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirst();
    if (project && input.archived !== undefined) {
      // Every project of the repository shares its archive state.
      await tx
        .updateTable('projects')
        .set({ archived: input.archived, updated_at: sql`now()` })
        .where('forge_scope', '=', project.forge_scope)
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('repository_instance', '>', 1)
        .where('archived', '!=', input.archived)
        .execute();
    }
    if (project) await ensureProjectKnowledgeSpace(tx, project.id, project.repo);
    return project;
  }

  /**
   * Add a repository-backed project the operator chose. While the repository's
   * first project (instance 1) is only an installation placeholder, it is
   * adopted; when the operator had removed it, it is restored — both exactly as
   * {@link upsertProject} does. Once that repository already backs a visible
   * project (or a link is reserving it), a separate project is created as the
   * next instance, with its own ID, clone directory and container. An existing
   * project is never returned or reset for another project's request.
   */
  async createRepositoryProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    const owner = input.owner.toLowerCase();
    const repo = input.repo.toLowerCase();
    const scope = input.forgeConnectionId ?? 'legacy-github';
    const row = await this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const [primary, claim] = await Promise.all([
        tx
          .selectFrom('projects')
          .select(['id', 'kind', 'state', 'overview_visible', 'hidden_at', 'archived'])
          .where('forge_scope', '=', scope)
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .where('repository_instance', '=', 1)
          .executeTakeFirst(),
        tx
          .selectFrom('project_identity_claims')
          .select('project_id')
          .where('forge_scope', '=', scope)
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .where('repository_instance', '=', 1)
          .executeTakeFirst(),
      ]);
      const adoptable =
        primary === undefined
          ? claim === undefined
          : claim?.project_id === primary.id &&
            (primary.hidden_at !== null ||
              isInstallationPlaceholder({
                kind: primary.kind as ProjectKind,
                state: primary.state as ProjectState,
                overviewVisible: primary.overview_visible,
              }));
      const repositoryArchive =
        primary ??
        (await tx
          .selectFrom('projects')
          .select('archived')
          .where('forge_scope', '=', scope)
          .where('owner', '=', owner)
          .where('repo', '=', repo)
          .orderBy('repository_instance', 'asc')
          .executeTakeFirst());
      if (adoptable)
        return this.upsertPrimaryProject(tx, {
          ...input,
          archived: input.archived ?? repositoryArchive?.archived ?? false,
        });
      const instance = await claimNextRepositoryInstance(
        tx,
        { owner, repo, forgeConnectionId: input.forgeConnectionId },
        input.id,
      );
      // The project ID keeps the directory and container apart from every other
      // project of this repository, whatever the repository is called.
      const project = await tx
        .insertInto('projects')
        .values({
          id: input.id,
          name: input.name ?? defaultProjectName({ repo }),
          owner,
          repo,
          repository_instance: instance,
          container_name: `${input.containerName}--${input.id}`.toLowerCase(),
          kind: input.kind ?? 'github',
          forge_connection_id: input.forgeConnectionId ?? null,
          clone_dir: `${input.cloneDir ?? `${owner}-${repo}`}-${input.id}`,
          image_ref: input.imageRef ?? null,
          image_override_ref: input.imageRef ?? null,
          state: input.state,
          // Archival is a property of the repository, recorded by the
          // installation sync on its first project.
          archived: input.archived ?? repositoryArchive?.archived ?? false,
          overview_visible: input.overviewVisible ?? true,
          provision_error: null,
          provision_warning: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await ensureProjectKnowledgeSpace(tx, project.id, project.repo);
      return project;
    });
    if (!row) throw new Error('verity: createRepositoryProject RETURNING yielded no row');
    return projectRowToRecord(row);
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

  /**
   * Atomic state transition for a project (concept §19.3, used by the
   * provisioning worker). The body of this method runs a single UPDATE through
   * the store's outer connection — it does NOT hold the `SELECT … FOR UPDATE`
   * lock the worker needs around the `state != 'active' → clone → run → active`
   * transition. Slice 3 will refactor this (likely to accept a caller-supplied
   * `Kysely<Database>` so the lock + the UPDATE go through the same tx); until
   * then, slice-1 callers are testing-only and the concurrency invariant is
   * documented but not enforced here.
   *
   * @param provisionError NULL-binding: pass `null` to clear. A non-null value
   *                       is ONLY written alongside `state='failed'`.
   * @param provisionWarning NULL-binding: pass `null` to clear. A non-null value
   *                         is only used for active projects that provisioned
   *                         with non-fatal operator-visible caveats.
   * @returns the resulting row; `undefined` if the project id is unknown.
   *
   * Together with the provisioner's in-transaction twin (`updateProjectStateInTx`)
   * this is the only writer of `state_changed_at`, and it moves it on every call
   * — including a repeat write of the same state, which is a fresh provisioning
   * attempt entering that phase, not a no-op. That makes the column mean "when
   * the worker last claimed this state", which is exactly the age the
   * stale-provisioning sweep needs.
   */
  async updateProjectState(
    id: string,
    state: ProjectState,
    provisionError: string | null = null,
    provisionWarning: string | null = null,
  ): Promise<ProjectRecord | undefined> {
    const leavesSleepLifecycle =
      state !== 'sleeping_starting' && state !== 'sleeping' && state !== 'waking';
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('projects')
        .set({
          state,
          ...(leavesSleepLifecycle
            ? {
                sleep_compatibility_fingerprint: null,
                sleeping_since: null,
                wake_started_at: null,
              }
            : {}),
          provision_error: provisionError,
          provision_warning: provisionWarning,
          state_changed_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .execute();
      if (['absent', 'sleeping_starting', 'sleeping', 'waking'].includes(state)) {
        await trx.deleteFrom('sandbox_repair_intents').where('project_id', '=', id).execute();
      }
    });
    return this.readProject(id);
  }

  /** Persist a sleep/wake lifecycle transition and its recovery metadata in one
   * statement. Callers explicitly supply every nullable field so a new state
   * cannot silently inherit timestamps or a compatibility verdict from an old
   * transition. */
  async updateProjectSleepState(
    id: string,
    state: Extract<ProjectState, 'sleeping_starting' | 'sleeping' | 'waking' | 'active'>,
    metadata: {
      sleepCompatibilityFingerprint: string | null;
      sleepingSince: Date | null;
      wakeStartedAt: Date | null;
    },
  ): Promise<ProjectRecord | undefined> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('projects')
        .set({
          state,
          sleep_compatibility_fingerprint: metadata.sleepCompatibilityFingerprint,
          sleeping_since: metadata.sleepingSince,
          wake_started_at: metadata.wakeStartedAt,
          provision_error: null,
          provision_warning: null,
          state_changed_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .execute();
      if (['absent', 'sleeping_starting', 'sleeping', 'waking'].includes(state)) {
        await trx.deleteFrom('sandbox_repair_intents').where('project_id', '=', id).execute();
      }
    });
    return this.readProject(id);
  }

  /** Record the effective image selected by provisioning without changing the
   * operator-configured override in `image_override_ref`.
   *
   * `toolkitIdentity` is the content identity of the runner-boundary trust root
   * that this provisioning verified the image against, and it is written in the
   * SAME statement as the image on purpose: the two are one verdict about one
   * image. It is required, and `null` — "nothing verified this" — is a real
   * answer a caller must give rather than omit. An optional argument would let
   * a new image silently inherit the previous image's verdict, which is the
   * exact false all-clear the drift report exists to remove. */
  async recordProjectImageRef(
    id: string,
    imageRef: string,
    toolkitIdentity: string | null,
  ): Promise<void> {
    await this.db
      .updateTable('projects')
      .set({
        image_ref: imageRef,
        toolkit_identity: toolkitIdentity,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async setProjectSetupStatus(
    id: string,
    status: ProjectSetupState,
  ): Promise<ProjectRecord | undefined> {
    await this.db
      .updateTable('projects')
      .set({ setup_status: status, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    return this.readProject(id);
  }

  /**
   * Refresh a project's latest-release display cache (overview version badge).
   * Independent of provisioning state and project upserts: touches ONLY
   * the `latest_release_*` columns (and `updated_at`), so a release refresh never
   * disturbs the provisioning-worker-owned `state` or the installation-sync fields.
   * A no-op (0 rows) for an unknown id. `published_at` is stored verbatim as
   * GitHub's ISO string (display-only, never queried).
   */
  async updateProjectReleaseStatus(id: string, status: ProjectReleaseStatus): Promise<void> {
    await this.db
      .updateTable('projects')
      .set({
        latest_release_tag: status.tag,
        latest_release_name: status.name,
        latest_release_url: status.url,
        latest_release_published_at: status.publishedAt,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Gives a project a new name. Only the name changes: owner, repo, container,
   * clone directory and every repository link stay as they are. Duplicate names
   * across projects are allowed — the ID identifies a project, not its name.
   *
   * @throws {InvalidProjectNameError} when the trimmed name is empty or longer
   *         than {@link PROJECT_NAME_MAX_CHARS}.
   * @returns the renamed project, or `undefined` when it does not exist.
   */
  async renameProject(id: string, name: string): Promise<ProjectRecord | undefined> {
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new InvalidProjectNameError('project name is required');
    if (trimmed.length > PROJECT_NAME_MAX_CHARS)
      throw new InvalidProjectNameError(
        `project name is limited to ${PROJECT_NAME_MAX_CHARS} characters`,
      );
    const row = await this.db
      .updateTable('projects')
      .set({ name: trimmed, updated_at: sql`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? projectRowToRecord(row) : undefined;
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    const row = await this.db
      .selectFrom('projects')
      .select(projectColumns)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? projectRowToRecord(row) : undefined;
  }

  /** Every project of one repository, hidden ones included, first instance first. */
  async listProjectsByOwnerRepo(
    owner: string,
    repo: string,
    forgeConnectionId?: string | null,
  ): Promise<ProjectRecord[]> {
    const rows = await this.db
      .selectFrom('projects')
      .select(projectColumns)
      .where('forge_scope', '=', forgeConnectionId ?? 'legacy-github')
      .where('owner', '=', owner.toLowerCase())
      .where('repo', '=', repo.toLowerCase())
      .orderBy('repository_instance')
      .execute();
    return rows.map((row) => projectRowToRecord(row));
  }

  /**
   * All registered projects, ordered by operator-defined `sort_order` first and
   * then `(created_at, id)` so listing is stable across paginated runs. Rows with
   * no manual order sort after manually ordered rows.
   *
   * Soft-deleted (hidden) projects are excluded by default so the mobile picker
   * and the installation-sync return value never show a repo the operator
   * removed. Pass `{ includeHidden: true }` for the first-run-bootstrap check
   * (embedded startup) that must know whether ANY project row exists, hidden or
   * not, before it seeds the config file.
   */
  async listProjects(opts?: { includeHidden?: boolean }): Promise<ProjectRecord[]> {
    let query = this.db
      .selectFrom('projects')
      .select(projectColumns)
      .orderBy(sql`sort_order is null`)
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc');
    if (opts?.includeHidden !== true) {
      query = query.where('hidden_at', 'is', null);
    }
    const rows = await query.execute();
    return rows.map((r) => projectRowToRecord(r));
  }

  async reorderProjects(
    ids: string[],
    listProjects: () => Promise<ProjectRecord[]>,
  ): Promise<ProjectRecord[]> {
    if (new Set(ids).size !== ids.length) {
      throw new Error('duplicate project id in reorderProjects');
    }
    await this.db.transaction().execute(async (tx) => {
      const visibleRows = await tx
        .selectFrom('projects')
        .select('id')
        .where('hidden_at', 'is', null)
        .where('kind', '!=', 'control_plane')
        .where((eb) => eb.or([eb('state', '!=', 'absent'), eb('setup_status', '=', 'pending')]))
        .execute();
      const visibleIds = new Set(visibleRows.map((row) => row.id));
      if (visibleIds.size !== ids.length || ids.some((id) => !visibleIds.has(id))) {
        throw new Error('project order must include every visible project exactly once');
      }
      const sortOrderCase = sql<number>`(case ${sql.ref('id')} ${sql.join(
        ids.map((id, index) => sql`when ${id} then ${index}`),
        sql.raw(' '),
      )} end)::integer`;
      await tx
        .updateTable('projects')
        .set({ sort_order: sortOrderCase, updated_at: sql`now()` })
        .where('hidden_at', 'is', null)
        .where('kind', '!=', 'control_plane')
        .where((eb) => eb.or([eb('state', '!=', 'absent'), eb('setup_status', '=', 'pending')]))
        .execute();
    });
    return listProjects();
  }
}
