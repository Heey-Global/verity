/**
 * Multi-repo fleet-registry project state (concept §19.3, #174). Mirrors the
 * `projects.state` column as a closed string-enum at the app layer. Transitions
 * guarded by a `SELECT … FOR UPDATE` lock (§19.3):
 *   `absent → cloning → container_starting → active`
 *   `cloning|container_starting → failed`
 *   `failed → cloning` (retry via deprovision + re-provision, §19.8).
 */
export type ProjectState =
  | 'absent'
  | 'cloning'
  | 'container_starting'
  | 'active'
  | 'sleeping_starting'
  | 'sleeping'
  | 'waking'
  | 'failed';

export type ProjectSetupState = 'pending' | 'secrets_skipped' | 'complete';

export type ProjectKind = 'github' | 'forgejo' | 'control_plane' | 'local';

/** Reserved `owner` for projects created without a GitHub repository. Keeps them
 *  inside the existing `UNIQUE(owner, repo)` identity without a nullable owner,
 *  and makes "is this project on GitHub yet" a single-column question. The
 *  leading underscores are forbidden by GitHub's account-name grammar, so this
 *  namespace cannot collide with an installation repository. */
export const LOCAL_PROJECT_OWNER = '__local__';

/** Thrown when `(owner, repo)` is spoken for by a DIFFERENT project than the one
 *  writing. Carries the driver's unique-violation code so existing callers that
 *  branch on `23505` keep working; exported so the installation sync can tell
 *  "a link is mid-flight" apart from a genuine write failure. */
export class ProjectIdentityClaimConflict extends Error {
  readonly code = '23505';
}

/** Whether a project has no GitHub repository behind it (yet). */
export function isLocalProject(project: Pick<ProjectRecord, 'kind'>): boolean {
  return project.kind === 'local';
}

/** Multi-repo fleet-registry project record (`projects` row, concept §19.2). */
export interface ProjectRecord {
  id: string;
  /** The project's own name, independent of its repositories. Set when the
   *  project is created, changed only by {@link EventStore.renameProject}. */
  name: string;
  owner: string;
  repo: string;
  /** GitHub's rename-stable repository ID, once learned; `null` = not yet; absent = not loaded. */
  githubRepositoryId?: string | null | undefined;
  containerName: string;
  kind?: ProjectKind;
  forgeConnectionId?: string | null;
  /** 1 for the first project of a repository; a further project of the same
   *  repository takes the next number. Absent on records from older readers. */
  repositoryInstance?: number;
  /** Host clone-directory name override; `null` = derive `<owner>-<repo>`. Set
   *  for `local` projects and preserved when they are linked to GitHub, so the
   *  clone (and every session worktree persisted under it) never moves. */
  cloneDir?: string | null;
  imageRef: string | null;
  /** The image the operator pinned for this project, or `null` when Verity
   *  chooses the default. Configuration, not observation: it says what the next
   *  provisioning must start from.
   *
   *  {@link imageRef} is normally what the last provisioning selected, but a pin
   *  is written into BOTH, so between the pin and the next provisioning the two
   *  agree while the Sandbox still runs the older image. Equal values therefore
   *  mean the effective image is the pinned one — which is what settles that
   *  Verity did not build it, whatever the image is named. */
  imageOverrideRef?: string | null;
  /** Content identity of the runner-boundary trust root the last provisioning
   *  judged this project against. `null`/absent = unknown, which is NOT the same
   *  as current — see `projects.toolkit_identity`. */
  toolkitIdentity?: string | null;
  state: ProjectState;
  /** Fingerprint of the runtime contract retained by a sleeping Sandbox. */
  sleepCompatibilityFingerprint?: string | null;
  /** When the Sandbox most recently completed the transition to sleeping. */
  sleepingSince?: Date | null;
  /** When the current wake attempt claimed the project. */
  wakeStartedAt?: Date | null;
  archived?: boolean;
  provisionError: string | null;
  provisionWarning: string | null;
  /** Soft-delete marker: `null` = visible, a `Date` = operator-hidden. Hidden
   *  projects are excluded from {@link EventStore.listProjects} by default. */
  hiddenAt: Date | null;
  /** Operator-defined overview order; `null` for projects never manually sorted. */
  sortOrder?: number | null;
  /** Overview fold state; `true` when the project group is collapsed. The store
   *  fills in the legacy shared column; the server replaces it with the requesting
   *  person's state from {@link ViewStateStore}. */
  collapsed?: boolean;
  /** True once the repo was explicitly added as a Verity project. Paused
   *  (`state='absent'`) projects with this flag stay visible in the overview. */
  overviewVisible?: boolean;
  setupStatus?: ProjectSetupState;
  /** Persisted display-cache of the repo's latest GitHub release (overview version
   *  badge). All `null` until a lookup resolves / for a repo with no releases.
   *  `latestReleasePublishedAt` is GitHub's ISO string (display-only). Written by
   *  {@link EventStore.updateProjectReleaseStatus}; the live freshness is owned by
   *  the server's in-memory release service. */
  latestReleaseTag: string | null;
  latestReleaseName: string | null;
  latestReleaseUrl: string | null;
  latestReleasePublishedAt: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** When {@link EventStore.updateProjectState} last wrote `state`. Use this —
   *  never `updatedAt` — to reason about how long a project has been in its
   *  current provisioning state: `updatedAt` is bumped by unrelated writers
   *  (installation sync, release badge, sort order) that leave `state` alone. */
  stateChangedAt: Date;
}

/** Input to {@link EventStore.updateProjectReleaseStatus} — the latest-release
 *  fields refreshed independently of the installation-sync upsert. A plain shape
 *  (not the server's `ReleaseSummary`) so the store stays free of server types. */
export interface ProjectReleaseStatus {
  tag: string | null;
  name: string | null;
  url: string | null;
  publishedAt: string | null;
}

/** Input to {@link EventStore.upsertProject} — everything but the DB-managed
 * `created_at`/`updated_at`/`provision_error` columns. `id` is caller-supplied
 * (UUID) so an upsert can target an existing row. */
export interface ProjectUpsertInput {
  id: string;
  owner: string;
  repo: string;
  containerName: string;
  kind?: ProjectKind;
  forgeConnectionId?: string | null;
  /** Explicit host clone-directory name; omit to derive `<owner>-<repo>`. Only
   *  written on INSERT — an existing row keeps whatever directory its clone
   *  already lives in. */
  cloneDir?: string | null;
  imageRef?: string | null;
  state: ProjectState;
  archived?: boolean;
  /** When `true`, an upsert that hits an existing (owner, repo) row clears its
   *  `hidden_at` — the "re-add a previously deleted project" path (POST
   *  /projects). The GitHub-installation sync omits it, so a re-sync never
   *  un-hides an operator-removed project. */
  restore?: boolean;
  /** Mark this repo as intentionally added to the project overview. Installation
   *  sync omits it so unadded `absent` repos stay picker-only. */
  overviewVisible?: boolean;
  /** The project's name. Only written on INSERT; omitted, it is derived with
   *  {@link defaultProjectName}. An existing project keeps its name. */
  name?: string;
}

/** Maximum UTF-16 length, matching API validation and native text input limits. */
export const PROJECT_NAME_MAX_CHARS = 100;

/** The name a project carries when none was given: its repository name, or a
 *  local project's directory name — what the app showed before projects had
 *  names of their own, and what migration 0204 copied into existing rows. */
export function defaultProjectName(project: { repo: string }): string {
  return project.repo;
}

/** A rename the store refuses: empty after trimming, or over the limit. */
export class InvalidProjectNameError extends Error {}

// ─── Multi-repo fleet registry (concept §19, #174) ─────────────────────────

export function projectRowToRecord(row: {
  id: string;
  name?: string | null;
  owner: string;
  repo: string;
  github_repository_id?: string | null;
  container_name: string;
  kind?: string | null;
  forge_connection_id?: string | null;
  repository_instance?: number | null;
  clone_dir?: string | null;
  image_ref: string | null;
  image_override_ref?: string | null;
  toolkit_identity?: string | null;
  state: string;
  sleep_compatibility_fingerprint?: string | null;
  sleeping_since?: Date | null;
  wake_started_at?: Date | null;
  archived?: boolean | null;
  provision_error: string | null;
  provision_warning: string | null;
  hidden_at: Date | null;
  sort_order: number | null;
  collapsed?: boolean | null;
  overview_visible?: boolean | null;
  setup_status: string;
  latest_release_tag: string | null;
  latest_release_name: string | null;
  latest_release_url: string | null;
  latest_release_published_at: string | null;
  created_at: Date;
  updated_at: Date;
  state_changed_at?: Date | null;
}): ProjectRecord {
  return {
    id: row.id,
    name: row.name ?? defaultProjectName(row),
    owner: row.owner,
    repo: row.repo,
    githubRepositoryId: row.github_repository_id,
    containerName: row.container_name,
    kind: (row.kind ?? 'github') as ProjectKind,
    forgeConnectionId: row.forge_connection_id ?? null,
    repositoryInstance: row.repository_instance ?? 1,
    cloneDir: row.clone_dir ?? null,
    imageRef: row.image_ref,
    imageOverrideRef: row.image_override_ref ?? null,
    toolkitIdentity: row.toolkit_identity ?? null,
    // Trusting the column to only ever hold one of the five state values; the
    // app layer writes through {@link upsertProject}/{@link updateProjectState}
    // which take a {@link ProjectState}. A drift here means a stray writer ATK-
    // bypassed those — assertable by a future CHECK constraint, not in v1.
    state: row.state as ProjectState,
    sleepCompatibilityFingerprint: row.sleep_compatibility_fingerprint ?? null,
    sleepingSince: row.sleeping_since ?? null,
    wakeStartedAt: row.wake_started_at ?? null,
    archived: row.archived ?? false,
    provisionError: row.provision_error,
    provisionWarning: row.provision_warning,
    hiddenAt: row.hidden_at,
    sortOrder: row.sort_order,
    collapsed: row.collapsed ?? false,
    overviewVisible: row.overview_visible ?? false,
    setupStatus: row.setup_status as ProjectSetupState,
    latestReleaseTag: row.latest_release_tag,
    latestReleaseName: row.latest_release_name,
    latestReleaseUrl: row.latest_release_url,
    latestReleasePublishedAt: row.latest_release_published_at,
    createdAt: row.created_at,
    // Falls back to `updated_at` only for a row read through a projection that
    // predates the column (test doubles); the migration backfills the same
    // value, so the two agree for every real row.
    stateChangedAt: row.state_changed_at ?? row.updated_at,
    updatedAt: row.updated_at,
  };
}

export const projectColumns = [
  'forge_connection_id',
  'id',
  'name',
  'kind',
  'owner',
  'repo',
  'github_repository_id',
  'container_name',
  'repository_instance',
  'clone_dir',
  'image_ref',
  'image_override_ref',
  'toolkit_identity',
  'state',
  'sleep_compatibility_fingerprint',
  'sleeping_since',
  'wake_started_at',
  'archived',
  'provision_error',
  'provision_warning',
  'hidden_at',
  'sort_order',
  'collapsed',
  'overview_visible',
  'setup_status',
  'latest_release_tag',
  'latest_release_name',
  'latest_release_url',
  'latest_release_published_at',
  'created_at',
  'updated_at',
  'state_changed_at',
] as const;
