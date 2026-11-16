import type { EventStore } from '@verity/store';
import { legacyAdministratorId } from './view-state-routes.js';

/**
 * The person of a project's original sandbox: the one that serves work without a
 * person and every container that exists from before sandboxes were per person.
 * A project created later gets its default recorded on first use, owned by the
 * installation's administrator, whose container the original always was.
 */
export async function projectDefaultSandboxUser(
  store: Pick<EventStore, 'projectSandboxes'>,
  projectId: string,
): Promise<string> {
  const existing = await store.projectSandboxes.projectDefault(projectId);
  if (existing !== undefined) return existing.userId;
  return (await store.projectSandboxes.ensureProjectDefault(projectId, legacyAdministratorId))
    .userId;
}

/** The same person as `projectDefaultSandboxUser`, without recording anything:
 *  for sleeping, quiescing and health checks, which run on a sandbox that may
 *  never have been provisioned and must not create its record as a side effect.
 *  Only provisioning records the original sandbox. */
export async function originalSandboxUser(
  store: Pick<EventStore, 'projectSandboxes'>,
  projectId: string,
): Promise<string> {
  return (await recordedDefaultSandboxUser(store, projectId)) ?? legacyAdministratorId;
}

/** The person recorded for a project's original sandbox, without recording one:
 *  for lookups on a stop, a sleep or a teardown, which must never create a sandbox. */
export async function recordedDefaultSandboxUser(
  store: Pick<EventStore, 'projectSandboxes'>,
  projectId: string,
): Promise<string | undefined> {
  return (await store.projectSandboxes.projectDefault(projectId))?.userId;
}
