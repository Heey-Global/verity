import type { EgressGrant, EgressTarget, ProjectEgressStore } from '@verity/store';
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
  continuous?: boolean;
  sponsorUserId: string;
  store: Pick<ProjectEgressStore, 'readForAdmission'>;
  /** Host-owned destinations admitted alongside the project's grants, never from a card. */
  systemTargets?: readonly EgressTarget[];
  dependencies: Omit<ProjectFenceDependencies, 'policyCurrent'>;
}): {
  invalidate(): void;
  prepare(): Promise<void>;
  refresh(): Promise<void>;
  revoke(): Promise<void>;
  retire(): Promise<void>;
  admitted(name: string): { addresses: readonly string[]; ttlSeconds: number } | undefined;
} {
  const binding = structuredClone(options.binding);
  const sponsorUserId = options.sponsorUserId;
  if (!sponsorUserId) throw new Error('An admission sponsor is required');
  const store = options.store;
  const system: EgressGrant[] = (options.systemTargets ?? []).map((target) => ({
    id: `system:${target.protocol}:${target.host}:${target.port}`,
    target: { ...target },
    approvedBy: 'system',
    approvedAt: 0,
    expiresAt: null,
  }));
  // Both admission reads append the same system grants, so currency still compares equal.
  // A persisted grant can never claim a system id and its exemptions.
  const withSystem = (grants: readonly EgressGrant[]) => [
    ...grants.filter((grant) => !grant.id.startsWith('system:')),
    ...system,
  ];
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
        JSON.stringify(withSystem(policy.grants)) === JSON.stringify(snapshot.grants)
      );
    },
  });
  return {
    invalidate: () => {
      lifecycle = Symbol();
    },
    prepare: () => invalidate(() => fence.prepare(binding)),
    refresh: () => {
      const attempt = lifecycle;
      return serialize(async () => {
        if (attempt !== lifecycle) throw new Error('Admission refresh superseded');
        refreshing = attempt;
        // Permission revocation or a failed database read cannot retain old access.
        try {
          if (!options.continuous) await fence.revoke(binding);
          const policy = await store.readForAdmission(binding.projectId, sponsorUserId);
          if (attempt !== lifecycle) throw new Error('Admission refresh superseded');
          await fence.refresh({
            binding,
            revision: policy.revision,
            grants: withSystem(policy.grants),
            // An unreachable system target excludes only itself, never the project's grants.
            system: system.map((grant) => grant.id),
          });
        } catch (error) {
          await fence.revoke(binding);
          throw error;
        }
      });
    },
    revoke: () => invalidate(() => fence.revoke(binding)),
    retire: () => invalidate(() => fence.retire(binding)),
    admitted: (name) => fence.admitted(binding, name),
  };
}
