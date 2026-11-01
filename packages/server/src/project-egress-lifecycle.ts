import { createHash } from 'node:crypto';
import type { DockerClient } from './docker.js';
import type { InternalConnectionIdentity } from './internal-listener.js';
import type {
  ProjectEgressHostRequest,
  ProjectEgressHostResponse,
  ProjectEgressNetworkBinding,
} from './project-egress-host.js';

/** Experimental, fixed relay-transport integration. Not installed by production configuration.
 * Every selected generation must be registered with the authoritative host; no
 * labels, missing host state or transport errors permit a legacy network fallback.
 */
export class ProjectEgressLifecycle {
  private readonly renewals = new Map<
    string,
    { identity: InternalConnectionIdentity; timer?: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private stopRenewal(identity: InternalConnectionIdentity): void {
    const pending = this.renewals.get(identity.projectId);
    if (!pending || pending.identity.containerGeneration !== identity.containerGeneration) return;
    clearTimeout(pending.timer);
    this.renewals.delete(identity.projectId);
  }
  private async renew(identity: InternalConnectionIdentity): Promise<void> {
    this.stopRenewal(identity);
    if (this.closed) throw new Error('Project egress lifecycle is closed');
    const state: { identity: InternalConnectionIdentity; timer?: ReturnType<typeof setTimeout> } = {
      identity: { ...identity },
    };
    this.renewals.set(identity.projectId, state);
    const tick = async () => {
      if (this.renewals.get(identity.projectId) !== state || this.closed) return;
      const started = performance.now();
      try {
        await this.refreshDirect(identity);
      } catch (error) {
        if (this.renewals.get(identity.projectId) === state) {
          this.stopRenewal(identity);
          await this.revokeDirect(identity).catch(() => undefined);
        }
        throw error;
      }
      if (this.renewals.get(identity.projectId) !== state || this.closed) return;
      state.timer = setTimeout(
        () => {
          void tick().catch(() => undefined);
        },
        Math.max(0, 250 - (performance.now() - started)),
      );
      state.timer.unref();
    };
    await tick();
  }
  async requiresFreshWakeGeneration(projectId: string): Promise<boolean> {
    const reply = await this.command({ operation: 'current', projectId });
    if (
      reply.state !== 'current' ||
      reply.projectId !== projectId ||
      (reply.binding !== null && reply.binding.projectId !== projectId)
    )
      throw new Error('Mismatched host binding');
    return reply.packetEnforcement === true;
  }
  async close(): Promise<void> {
    this.closed = true;
    const identities = [...this.renewals.values()].map((item) => item.identity);
    for (const identity of identities) this.stopRenewal(identity);
    const errors: unknown[] = [];
    for (const identity of identities) {
      try {
        await this.revokeDirect(identity);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Direct admission shutdown failed');
  }
  constructor(
    private readonly command: (
      input: ProjectEgressHostRequest,
    ) => Promise<ProjectEgressHostResponse>,
    private readonly docker: Pick<DockerClient, 'createEgressNetwork'>,
    private readonly renewDirect = true,
  ) {}
  async current(projectId: string): Promise<ProjectEgressNetworkBinding | undefined> {
    const result = await this.command({ operation: 'current', projectId });
    if (
      result.state !== 'current' ||
      result.projectId !== projectId ||
      (result.binding !== null && result.binding.projectId !== projectId)
    )
      throw new Error('Mismatched host binding');
    return result.binding ?? undefined;
  }
  async create(identity: InternalConnectionIdentity): Promise<ProjectEgressNetworkBinding> {
    if (this.docker.createEgressNetwork === undefined)
      throw new Error('Generation network creation is unavailable');
    const prior = await this.current(identity.projectId);
    if (prior !== undefined) throw new Error('Retire the current generation before replacement');
    const hash = createHash('sha256')
      .update(`${identity.projectId}\0${identity.containerGeneration}`)
      .digest('hex');
    const networkName = `verity-egress-${hash.slice(0, 32)}`;
    const bridge = `vep${hash.slice(0, 12)}`;
    const network = await this.docker.createEgressNetwork(networkName, bridge);
    const binding = {
      projectId: identity.projectId,
      generation: identity.containerGeneration,
      networkId: network.id,
      networkName,
      bridge,
    };
    await this.acknowledge({ operation: 'register', binding }, 'denied', binding.generation);
    return binding;
  }
  async binding(identity: InternalConnectionIdentity): Promise<ProjectEgressNetworkBinding> {
    const binding = await this.current(identity.projectId);
    if (binding?.generation !== identity.containerGeneration)
      throw new Error('Unknown or stale host generation');
    return binding;
  }
  async prepare(identity: InternalConnectionIdentity): Promise<ProjectEgressNetworkBinding> {
    this.stopRenewal(identity);
    const binding = await this.binding(identity);
    await this.acknowledge(
      { operation: 'prepare', ...this.reference(identity) },
      'denied',
      identity.containerGeneration,
    );
    return binding;
  }
  async start(
    identity: InternalConnectionIdentity,
    role: 'sandbox' | 'relay',
    containerId: string,
  ): Promise<void> {
    if (this.closed) throw new Error('Project egress lifecycle is closed');
    this.stopRenewal(identity);
    const result = await this.command({
      operation: 'start',
      ...this.reference(identity),
      role,
      containerId,
    });
    if (
      (result.state !== 'started-denied' && result.state !== 'started-connected') ||
      result.generation !== identity.containerGeneration
    )
      throw new Error('Mismatched host acknowledgement');
    if (result.state === 'started-connected' && result.directAuthority === true && this.renewDirect)
      await this.renew(identity);
  }
  async connect(identity: InternalConnectionIdentity): Promise<string> {
    if (this.closed) throw new Error('Project egress lifecycle is closed');
    const result = await this.command({ operation: 'connect', ...this.reference(identity) });
    if (result.state !== 'connected' || result.generation !== identity.containerGeneration)
      throw new Error('Transport readiness was not acknowledged');
    if (result.directAuthority === true && this.renewDirect) await this.renew(identity);
    return result.relayAddress;
  }
  async refreshDirect(identity: InternalConnectionIdentity): Promise<void> {
    const reply = await this.command({ operation: 'refresh-direct', ...this.reference(identity) });
    if (reply.state !== 'direct-refreshed' || reply.generation !== identity.containerGeneration)
      throw new Error('Direct admission was not acknowledged');
  }
  async revokeDirect(identity: InternalConnectionIdentity): Promise<void> {
    this.stopRenewal(identity);
    const reply = await this.command({ operation: 'revoke-direct', ...this.reference(identity) });
    if (reply.state !== 'direct-revoked' || reply.generation !== identity.containerGeneration)
      throw new Error('Direct revocation was not acknowledged');
  }
  async retire(identity: InternalConnectionIdentity): Promise<void> {
    this.stopRenewal(identity);
    await this.acknowledge(
      { operation: 'retire', ...this.reference(identity) },
      'retired',
      identity.containerGeneration,
    );
  }
  private reference(identity: InternalConnectionIdentity) {
    return { projectId: identity.projectId, generation: identity.containerGeneration };
  }
  private async acknowledge(
    command: ProjectEgressHostRequest,
    state: 'denied' | 'started-denied' | 'retired',
    generation: string,
  ): Promise<void> {
    const result = await this.command(command);
    if (result.state !== state || result.generation !== generation)
      throw new Error('Mismatched host acknowledgement');
  }
}
