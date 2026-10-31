import type { ProjectEgressStore } from '@verity/store';
import {
  ProjectEgressFence,
  type ProjectFenceBinding,
  type ProjectFenceDependencies,
} from './project-egress-fence.js';

/** Experimental host composition. Identity and sponsor must come from the trusted
 * registrar, never a sandbox header or request. No caller-supplied grant list is
 * accepted. Production does not construct this adapter.
 */
export function createProjectEgressAdmission(options: {
  binding: ProjectFenceBinding;
  sponsorUserId: string;
  store: Pick<ProjectEgressStore, 'readForAdmission'>;
  dependencies: Omit<ProjectFenceDependencies, 'policyCurrent'>;
}): {
  prepare(): Promise<void>;
  refresh(): Promise<void>;
  revoke(): Promise<void>;
  retire(): Promise<void>;
} {
  const binding = structuredClone(options.binding);
  const sponsorUserId = options.sponsorUserId;
  if (!sponsorUserId) throw new Error('An admission sponsor is required');
  const store = options.store;
  let lifecycle = Symbol();
  let refreshing: symbol | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const pending = queue.then(operation);
    queue = pending.catch(() => undefined);
    return pending;
  };
  const invalidate = (operation: () => Promise<void>): Promise<void> => {
    lifecycle = Symbol();
    return serialize(operation);
  };
  const fence = new ProjectEgressFence({
    ...options.dependencies,
    policyCurrent: async (snapshot) => {
      if (refreshing !== lifecycle) return false;
      const policy = await store.readForAdmission(
        binding.projectId,
        sponsorUserId,
        snapshot.revision,
      );
      // A revision identifies the complete persisted grant set, not caller authority.
      return (
        refreshing === lifecycle &&
        JSON.stringify(policy.grants) === JSON.stringify(snapshot.grants)
      );
    },
  });
  return {
    prepare: () => invalidate(() => fence.prepare(binding)),
    refresh: () => {
      const attempt = lifecycle;
      return serialize(async () => {
        if (attempt !== lifecycle) throw new Error('Admission refresh superseded');
        refreshing = attempt;
        // Permission revocation or a failed database read cannot retain old access.
        await fence.revoke(binding);
        const policy = await store.readForAdmission(binding.projectId, sponsorUserId);
        if (attempt !== lifecycle) throw new Error('Admission refresh superseded');
        await fence.refresh({ binding, revision: policy.revision, grants: policy.grants });
      });
    },
    revoke: () => invalidate(() => fence.revoke(binding)),
    retire: () => invalidate(() => fence.retire(binding)),
  };
}
