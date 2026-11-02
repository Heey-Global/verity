import type { ProjectEgressStore } from '@verity/store';
import { createProjectEgressAdmission } from './project-egress-admission.js';
import type { ProjectDeadlineRelayEnforcer } from './project-egress-deadline.js';
import type {
  ProjectFenceBinding,
  ProjectFenceDependencies,
  ProjectFenceRelay,
} from './project-egress-fence.js';
import type {
  ProjectEgressHostEnforcement,
  ProjectEgressNetworkBinding,
} from './project-egress-host.js';
import type { EgressDirectCorridor } from './project-egress-transport.js';

const key = (b: { projectId: string; generation: string }) => `${b.projectId}:${b.generation}`;
type Admission = ReturnType<typeof createProjectEgressAdmission>;
interface Generation {
  binding: ProjectFenceBinding;
  corridor: EgressDirectCorridor;
  relay: ProjectFenceRelay | undefined;
  admission: Admission;
  ready: boolean;
}

/** Owned by the serialized host controller, outside every project namespace.
 * Policy and sponsorship are loaded by trusted host configuration, not commands.
 * No renewal timer runs here: a lost Server cannot keep direct authority alive.
 */
export function createProjectEgressHostEnforcement(options: {
  deadline: ProjectDeadlineRelayEnforcer;
  store: Pick<ProjectEgressStore, 'readForAdmission'>;
  sponsor(binding: ProjectEgressNetworkBinding): string;
  directAuthority(binding: ProjectEgressNetworkBinding): boolean;
  inspect(
    binding: ProjectEgressNetworkBinding,
    ids: { sandbox: string; relay: string },
  ): Promise<{
    corridor: EgressDirectCorridor;
    relayEndpointId: string;
  }>;
  dependencies: Omit<ProjectFenceDependencies, 'deadline' | 'policyCurrent' | 'relay'>;
}): ProjectEgressHostEnforcement {
  const generations = new Map<string, Generation>();
  const current = (binding: ProjectEgressNetworkBinding) => {
    const state = generations.get(key(binding));
    if (!state?.ready) throw new Error('Host packet enforcement is not ready');
    return state;
  };
  return {
    directAuthority: (binding) => options.directAuthority(binding),
    invalidate(binding) {
      generations.get(key(binding))?.admission.invalidate();
    },
    async connect(binding, ids, relay) {
      const facts = await options.inspect(binding, ids);
      const b = facts.corridor.binding;
      if (
        b.projectId !== binding.projectId ||
        b.generation !== binding.generation ||
        b.networkId !== binding.networkId ||
        b.bridge !== binding.bridge ||
        b.containerId !== ids.sandbox ||
        b.ipv4 !== relay.transport.sandbox.address
      )
        throw new Error('Host direct attachment mismatch');
      let state = generations.get(key(binding));
      if (state && JSON.stringify(state.corridor) !== JSON.stringify(facts.corridor))
        throw new Error('Endpoint replacement requires a fresh generation');
      if (!state) {
        const generation: Generation = {
          binding: structuredClone(b),
          corridor: structuredClone(facts.corridor),
          relay: undefined,
          ready: false,
          admission: undefined as unknown as Admission,
        };
        generation.admission = createProjectEgressAdmission({
          continuous: true,
          binding: b,
          sponsorUserId: options.sponsor(binding),
          store: options.store,
          dependencies: {
            ...options.dependencies,
            deadline: options.deadline,
            relay: () => generation.relay,
          },
        });
        state = generation;
        generations.set(key(binding), state);
      }
      state.ready = false;
      state.relay = undefined;
      try {
        await state.admission.prepare();
        state.relay = structuredClone(relay);
        // Only the exact inspected pair bypasses the direct destination chain.
        await state.admission.revoke();
        await options.deadline.configureRelay(b, {
          containerId: ids.relay,
          endpointId: facts.relayEndpointId,
          codex: relay.transport.codex,
        });
        const confirmed = await options.inspect(binding, ids);
        if (JSON.stringify(confirmed) !== JSON.stringify(facts))
          throw new Error('Host endpoints changed during packet admission');
        state.ready = true;
        return structuredClone(state.corridor);
      } catch (error) {
        state.relay = undefined;
        const containment = await Promise.allSettled([
          state.admission.revoke(),
          options.deadline.clearRelay(b),
        ]);
        throw new AggregateError(
          [
            error,
            ...containment.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : [])),
          ],
          'Host packet admission failed',
          { cause: error },
        );
      }
    },
    async deny(binding) {
      const state = generations.get(key(binding));
      if (!state) return; // Bootstrap denial covers restored or not-yet-started endpoints.
      state.ready = false;
      state.relay = undefined;
      const results = await Promise.allSettled([
        state.admission.revoke(),
        options.deadline.clearRelay(state.binding),
      ]);
      const failures = results.flatMap((r) =>
        r.status === 'rejected' ? [r.reason as unknown] : [],
      );
      if (failures.length) throw new AggregateError(failures, 'Host packet revocation failed');
    },
    async refresh(binding) {
      return current(binding).admission.refresh();
    },
    async revoke(binding) {
      return current(binding).admission.revoke();
    },
  };
}
