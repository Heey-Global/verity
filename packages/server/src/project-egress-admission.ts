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
  const fence = new ProjectEgressFence({
    ...options.dependencies,
    policyCurrent: async (snapshot) => {
      const policy = await store.readForAdmission(
        binding.projectId,
        sponsorUserId,
        snapshot.revision,
      );
      // A revision identifies the complete persisted grant set, not caller authority.
      return JSON.stringify(policy.grants) === JSON.stringify(snapshot.grants);
    },
  });
  return {
    prepare: () => fence.prepare(binding),
    refresh: async () => {
      // Permission revocation or a failed database read cannot retain old access.
      await fence.revoke(binding);
      const policy = await store.readForAdmission(binding.projectId, sponsorUserId);
      await fence.refresh({ binding, revision: policy.revision, grants: policy.grants });
    },
    revoke: () => fence.revoke(binding),
    retire: () => fence.retire(binding),
  };
}
