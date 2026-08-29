import { type Kysely, sql } from 'kysely';

import type { Database, ProjectKind, ProjectRecord, ProjectState } from '@verity/store';

const PROJECT_COLUMNS = [
  'id',
  'owner',
  'repo',
  'container_name',
  'kind',
  'clone_dir',
  'image_ref',
  'image_override_ref',
  'toolkit_identity',
  'state',
  'archived',
  'provision_error',
  'provision_warning',
  'hidden_at',
  'sort_order',
  'latest_release_tag',
  'latest_release_name',
  'latest_release_url',
  'latest_release_published_at',
  'created_at',
  'updated_at',
  'state_changed_at',
] as const;

interface ProjectRow {
  id: string;
  owner: string;
  repo: string;
  container_name: string;
  kind: string;
  clone_dir: string | null;
  image_ref: string | null;
  image_override_ref: string | null;
  toolkit_identity: string | null;
  state: string;
  archived: boolean | null;
  provision_error: string | null;
  provision_warning: string | null;
  hidden_at: Date | null;
  sort_order: number | null;
  latest_release_tag: string | null;
  latest_release_name: string | null;
  latest_release_url: string | null;
  latest_release_published_at: string | null;
  created_at: Date;
  updated_at: Date;
  state_changed_at: Date;
}

function projectRowToRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    containerName: row.container_name,
    kind: row.kind as ProjectKind,
    cloneDir: row.clone_dir,
    imageRef: row.image_ref,
    imageOverrideRef: row.image_override_ref,
    toolkitIdentity: row.toolkit_identity,
    state: row.state as ProjectState,
    archived: row.archived ?? false,
    provisionError: row.provision_error,
    provisionWarning: row.provision_warning,
    hiddenAt: row.hidden_at,
    sortOrder: row.sort_order,
    latestReleaseTag: row.latest_release_tag,
    latestReleaseName: row.latest_release_name,
    latestReleaseUrl: row.latest_release_url,
    latestReleasePublishedAt: row.latest_release_published_at,
    createdAt: row.created_at,
    stateChangedAt: row.state_changed_at,
    updatedAt: row.updated_at,
  };
}

export async function getProjectInTx(
  tx: Kysely<Database>,
  projectId: string,
): Promise<ProjectRecord | undefined> {
  const row = await tx
    .selectFrom('projects')
    .select(PROJECT_COLUMNS)
    .where('id', '=', projectId)
    .executeTakeFirst();
  return row === undefined ? undefined : projectRowToRecord(row);
}

export async function updateProjectStateInTx(
  tx: Kysely<Database>,
  projectId: string,
  state: ProjectState,
  provisionError: string | null = null,
  provisionWarning: string | null = null,
): Promise<ProjectRecord | undefined> {
  await tx
    .updateTable('projects')
    .set({
      state,
      provision_error: provisionError,
      provision_warning: provisionWarning,
      // Mirrors EventStore.updateProjectState: the state writer owns
      // `state_changed_at`, and the stale-provisioning sweep reads it instead of
      // `updated_at` (which unrelated writers bump).
      state_changed_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .where('id', '=', projectId)
    .execute();
  return getProjectInTx(tx, projectId);
}

/** Lock a `projects` row for the duration of `work`. SELECT … FOR UPDATE per
 *  §19.3 — pins the row's state under a row lock so concurrent workers wait
 *  instead of clobbering each other's transitions. The `Kysely.transaction`
 *  wrapper gives a tx-scoped connection; the SELECT … FOR UPDATE runs through
 *  raw `sql` (kysely's typed query DSL doesn't expose `FOR UPDATE` on a
 *  `selectFrom`). */
export async function withProjectLock<T>(
  db: Kysely<Database>,
  projectId: string,
  work: (tx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    // SELECT … FOR UPDATE the row; if not found no lock acquired (the caller
    // will re-check existence inside `work` and decide, since a small race
    // window exists between the outer `getProject` lookup and the lock — for
    // a freshly-deleted project the loop just exits with `state='absent'`
    // re-found and short-circuits).
    await sql`select id from projects where id = ${projectId} for update`.execute(tx);
    return work(tx);
  });
}
