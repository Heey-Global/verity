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
  constructor(
    private readonly command: (
      input: ProjectEgressHostRequest,
    ) => Promise<ProjectEgressHostResponse>,
    private readonly docker: Pick<DockerClient, 'createEgressNetwork'>,
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
  }
  async connect(identity: InternalConnectionIdentity): Promise<string> {
    const result = await this.command({ operation: 'connect', ...this.reference(identity) });
    if (result.state !== 'connected' || result.generation !== identity.containerGeneration)
      throw new Error('Transport readiness was not acknowledged');
    return result.relayAddress;
  }
  async retire(identity: InternalConnectionIdentity): Promise<void> {
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
