import { sql, type Transaction } from 'kysely';
import type { Database } from './schema.js';
import type { ProjectKind, ProjectRecord, ProjectState } from './project-record.js';

/**
 * Whether a project row is an unadopted installation-sync placeholder — a row
 * {@link syncProjectsFromInstallation} minted purely because the GitHub App can
 * SEE the repository, not because anyone added it as a project.
 *
 * This exists because those placeholders otherwise make `link-github`
 * unreachable: the sync registers every visible repo within seconds of its
 * creation, so by the time an operator points a local project at a freshly
 * created empty repo, Verity already holds `(owner, repo)` itself and reports
 * its own bookkeeping row as "already registered as a project". The set of repos
 * the linker can push to and the set the sync claims are the SAME set, so
 * without adoption the feature can never succeed.
 *
 * `overviewVisible=false` is the durable provenance marker: explicit project
 * addition sets it true and installation sync deliberately leaves it false.
 * Record-level half of the test only; the authoritative check
 * additionally requires that nothing was ever worked on in the project, which
 * needs a query — see the store's `retireInstallationPlaceholder`. Callers
 * that only hold a {@link ProjectRecord} use this for an early-out and let the
 * store transaction have the final word.
 */
export function isInstallationPlaceholder(
  project: Pick<ProjectRecord, 'kind' | 'state' | 'overviewVisible'>,
): boolean {
  return (
    project.kind === 'github' && project.state === 'absent' && project.overviewVisible !== true
  );
}

/**
 * Drop the installation sync's placeholder row for `(owner, repo)` so a link
 * can take the identity over, and report whether it did.
 *
 * Adoption is deliberately narrow. The row must be a picker-only GitHub
 * project (`overview_visible=false`) that is `absent` AND carry no sessions —
 * `sessions.project_id` is `ON DELETE SET NULL`, so
 * deleting a project that was ever worked in would silently orphan its
 * transcripts rather than fail loudly. Everything else about the row IS
 * discarded with it via `ON DELETE CASCADE` (project settings, secret
 * bindings, dev-server config). That is acceptable precisely here: a link only
 * reaches this path for a repository the provisioner has verified to be EMPTY
 * on GitHub, and a rename only for the repository the adopting project is bound
 * to by its GitHub ID. Either way the placeholder holds configuration for a
 * project nobody worked in, and its identity belongs to the adopting project.
 *
 * Runs inside the caller's transaction so the delete, the claim, and the
 * project rewrite commit as one unit — a concurrent installation sync can
 * neither observe a half-adopted identity nor recreate the placeholder
 * between the steps.
 */
export async function retireInstallationPlaceholder(
  tx: Transaction<Database>,
  owner: string,
  repo: string,
  forProjectId: string,
  forgeConnectionId?: string | null,
): Promise<boolean> {
  const holder = await tx
    .selectFrom('projects')
    .select(['id', 'kind', 'state', 'overview_visible'])
    .where('forge_scope', '=', forgeConnectionId ?? 'legacy-github')
    .where('owner', '=', owner)
    .where('repo', '=', repo)
    .where('repository_instance', '=', 1)
    .where('id', '!=', forProjectId)
    .executeTakeFirst();
  if (holder === undefined) return false;
  if (
    !isInstallationPlaceholder({
      kind: holder.kind as ProjectKind,
      state: holder.state as ProjectState,
      overviewVisible: holder.overview_visible,
    })
  ) {
    return false;
  }
  if (await installationPlaceholderHasDependents(tx, holder.id)) return false;
  await tx.deleteFrom('project_identity_claims').where('project_id', '=', holder.id).execute();
  await tx.deleteFrom('projects').where('id', '=', holder.id).execute();
  return true;
}

/** A sync placeholder is disposable only while no project-scoped durable
 * state has attached to it. Keep this list aligned with direct `projects.id`
 * foreign keys in migrations; identity claims are excluded because adoption
 * deliberately transfers/deletes that bookkeeping row. */
export async function installationPlaceholderHasDependents(
  tx: Transaction<Database>,
  projectId: string,
): Promise<boolean> {
  const result = await sql<{ has_dependents: boolean }>`
    select exists (
      select 1 from sessions where project_id = ${projectId}
      union all select 1 from project_settings where project_id = ${projectId}
      union all select 1 from project_google_connections where project_id = ${projectId}
      union all select 1 from dev_servers where project_id = ${projectId}
      union all select 1 from dev_server_detection_state where project_id = ${projectId}
      union all select 1 from claude_egress_client_certs where project_id = ${projectId}
      union all select 1 from signing_capabilities where project_id = ${projectId}
      union all select 1 from secret_provider_credentials where project_id = ${projectId}
      union all select 1 from secret_provider_bindings where project_id = ${projectId}
      union all select 1 from secret_aliases where project_id = ${projectId}
      union all select 1 from secret_provider_permissions where project_id = ${projectId}
      union all select 1 from secret_execution_profiles where project_id = ${projectId}
      union all select 1 from brokered_http_consumptions where project_id = ${projectId}
      union all select 1 from public_preview_shares where project_id = ${projectId}
      union all select 1 from local_preview_shares where project_id = ${projectId}
    ) as has_dependents
  `.execute(tx);
  return result.rows[0]?.has_dependents === true;
}
