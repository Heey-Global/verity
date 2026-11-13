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
