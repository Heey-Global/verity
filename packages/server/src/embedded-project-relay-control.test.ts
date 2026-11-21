import { describe, expect, it, vi } from 'vitest';
import { DockerError, type ContainerInspect } from './docker.js';
import type { ProjectRelayActivation, ProjectRelayBinding } from './project-relay-lifecycle.js';
import { projectRelayContainerName } from './project-relay-identity.js';
import {
  createEmbeddedProjectRelayControl,
  validateEmbeddedProjectRelay,
} from './embedded-project-relay-control.js';

type Validation = Parameters<typeof validateEmbeddedProjectRelay>[0];
type Control = Parameters<typeof createEmbeddedProjectRelayControl>[0];
type Lifecycle = NonNullable<ReturnType<Control['getLifecycle']>>;
const identity = {
  projectId: 'project',
  userId: 'person',
  projectDefault: false,
  containerGeneration: 'generation',
};
const binding: ProjectRelayBinding = {
  ...identity,
  owner: 'owner',
  repo: 'repo',
  claudeGateway: { host: 'gateway', port: 443 },
};
const activation: ProjectRelayActivation = {
  identity,
  signingCapability: 'signing',
  githubCapability: 'github',
};
const valid: Validation = {
  projectRelayEnabled: true,
  agentGatewayUrl: new URL('https://gateway'),
  config: {
    dockerBaseUrl: 'http://docker',
    hostCloneRoot: '/clones',
    dataVolume: 'data',
    dataVolumeRoot: '/data',
    claudeEgressGatewayUrl: 'https://claude',
    codexEgressGatewayUrl: 'https://codex',
    claudeConnectorPort: 8080,
    projectRelayImage: `relay@sha256:${'a'.repeat(64)}`,
  },
};
function fixture() {
  const installed = {
    start: vi.fn<Lifecycle['start']>(async () => activation),
    resume: vi.fn<Lifecycle['resume']>(async () => undefined),
    sleep: vi.fn<NonNullable<ReturnType<Control['getLifecycle']>>['sleep']>(async () => undefined),
    reactivate: vi.fn<Lifecycle['reactivate']>(async () => activation),
    stop: vi.fn<NonNullable<ReturnType<Control['getLifecycle']>>['stop']>(async () => undefined),
    isActive: vi.fn<NonNullable<ReturnType<Control['getLifecycle']>>['isActive']>(() => true),
    heldRelays: vi.fn<Lifecycle['heldRelays']>(() => []),
  };
  let lifecycle: ReturnType<Control['getLifecycle']>;
  const inspectContainer = vi.fn<(name: string) => Promise<ContainerInspect>>(async () => ({
    id: 'relay',
    running: true,
  }));
  const stopContainer = vi.fn<(id: string) => Promise<void>>(async () => undefined);
  const removeContainer = vi.fn<(id: string) => Promise<void>>(async () => undefined);
  const context: Control = {
    projectRelayEnabled: true,
    getLifecycle: () => lifecycle,
    projectDocker: { inspectContainer, stopContainer, removeContainer },
  };
  const control = createEmbeddedProjectRelayControl(context)!;
  return {
    installed,
    inspectContainer,
    stopContainer,
    removeContainer,
    context,
    control,
    activate: () => {
      lifecycle = installed;
    },
  };
}

describe('embedded relay configuration', () => {
  it('allows a server without project Docker and accepts complete relay configuration', () => {
    expect(() =>
      validateEmbeddedProjectRelay({
        config: {},
        projectRelayEnabled: false,
        agentGatewayUrl: undefined,
      }),
    ).not.toThrow();
    expect(() => validateEmbeddedProjectRelay(valid)).not.toThrow();
  });
  it('rejects missing relay before the gateway, and requires a gateway for project Docker', () => {
    expect(() =>
      validateEmbeddedProjectRelay({
        ...valid,
        projectRelayEnabled: false,
        agentGatewayUrl: undefined,
      }),
    ).toThrow('Project Docker provisioning requires a digest-pinned project relay image');
    expect(() => validateEmbeddedProjectRelay({ ...valid, agentGatewayUrl: undefined })).toThrow(
      'Project Docker provisioning requires the Agent Gateway',
    );
  });
  it.each([
    'dockerBaseUrl',
    'hostCloneRoot',
    'dataVolume',
    'dataVolumeRoot',
    'claudeEgressGatewayUrl',
    'codexEgressGatewayUrl',
  ] as const)('rejects a blank required field: %s', (field) => {
    expect(() =>
      validateEmbeddedProjectRelay({ ...valid, config: { ...valid.config, [field]: '  ' } }),
    ).toThrow(`project relay requires: ${field}`);
  });
  it.each([undefined, 0, -1, 65_536, 1.5, Number.NaN])(
    'rejects invalid connector port: %s',
    (claudeConnectorPort) => {
      expect(() =>
        validateEmbeddedProjectRelay({
          ...valid,
          config: { ...valid.config, claudeConnectorPort },
        }),
      ).toThrow('project relay requires: claudeConnectorPort');
    },
  );
  it.each([1, 65_535])('accepts connector port boundary: %s', (claudeConnectorPort) => {
    expect(() =>
      validateEmbeddedProjectRelay({ ...valid, config: { ...valid.config, claudeConnectorPort } }),
    ).not.toThrow();
  });
  it.each(['relay:latest', `relay@sha256:${'a'.repeat(63)}`, `relay@sha256:${'g'.repeat(64)}`])(
    'requires a digest-pinned image: %s',
    (projectRelayImage) => {
      expect(() =>
        validateEmbeddedProjectRelay({ ...valid, config: { ...valid.config, projectRelayImage } }),
      ).toThrow('project relay image must be digest-pinned');
    },
  );
});

describe('embedded relay control', () => {
  it('creates no control when disabled and reads lifecycle only on demand', async () => {
    const f = fixture();
    const getLifecycle = vi.fn(() => undefined);
    expect(
      createEmbeddedProjectRelayControl({ ...f.context, projectRelayEnabled: false, getLifecycle }),
    ).toBeUndefined();
    expect(getLifecycle).not.toHaveBeenCalled();
    for (const method of ['start', 'resume', 'sleep', 'reactivate'] as const) {
      await expect(
        Promise.resolve().then(async () => {
          await f.control[method]!(binding);
        }),
      ).rejects.toThrow('project relay runtime is not initialized');
    }
    await expect(f.control.stop(identity)).resolves.toBeUndefined();
    expect(
      await f.control.isHealthy!({
        sandbox: identity,
        containerGeneration: identity.containerGeneration,
      }),
    ).toBe(false);
    expect(f.inspectContainer).not.toHaveBeenCalled();
    f.activate();
    expect(await f.control.start(binding)).toBe(activation);
    expect(await f.control.resume!(binding)).toBe(true);
    expect(await f.control.reactivate!(binding)).toBe(activation);
    await f.control.sleep!(identity);
    await f.control.stop(identity);
    for (const method of ['start', 'resume', 'reactivate'] as const)
      expect(f.installed[method]).toHaveBeenCalledWith(binding);
    expect(f.installed.sleep).toHaveBeenCalledWith(identity);
    expect(f.installed.stop).toHaveBeenCalledWith(identity);
  });

  it('uses generation-specific endpoints with their existing protocols and ports', () => {
    const { control } = fixture();
    const hostname = projectRelayContainerName(identity);
    expect(control.brokerUrl(activation)).toBe(`http://${hostname}:8080`);
    expect(control.claudeGatewayUrl(activation)).toBe(`https://${hostname}:8443`);
    expect(control.codexGatewayUrl!(activation)).toBe(`https://${hostname}:8444`);
  });

  it('requires active local generation ownership before checking the relay container', async () => {
    const f = fixture();
    f.activate();
    const check = { sandbox: identity, containerGeneration: 'other-generation' };
    f.installed.isActive.mockReturnValue(false);
    expect(await f.control.isHealthy!(check)).toBe(false);
    expect(f.inspectContainer).not.toHaveBeenCalled();
    expect(f.installed.isActive).toHaveBeenCalledWith(identity, 'other-generation');
    f.installed.isActive.mockReturnValue(true);
    expect(await f.control.isHealthy!(check)).toBe(true);
    expect(f.inspectContainer).toHaveBeenCalledWith(
      projectRelayContainerName({
        projectId: identity.projectId,
        containerGeneration: 'other-generation',
      }),
    );
    f.inspectContainer.mockResolvedValue({ id: 'relay', running: false });
    expect(await f.control.isHealthy!(check)).toBe(false);
    const withoutDocker = createEmbeddedProjectRelayControl({
      ...f.context,
      projectDocker: undefined,
    })!;
    expect(await withoutDocker.isHealthy!(check)).toBe(true);
  });

  it('treats authoritative container absence as orphaned/unhealthy', async () => {
    const f = fixture();
    f.activate();
    const error = new DockerError({ kind: 'container_not_found', id: 'gone' });
    f.installed.resume.mockRejectedValue(error);
    f.inspectContainer.mockRejectedValue(error);
    expect(await f.control.resume!(binding)).toBe(false);
    expect(
      await f.control.isHealthy!({
        sandbox: identity,
        containerGeneration: identity.containerGeneration,
      }),
    ).toBe(false);
  });

  it.each([
    new DockerError({ kind: 'network', cause: new Error('offline') }),
    new DockerError({ kind: 'other', status: 503, message: 'unavailable' }),
    new Error('listener failed'),
  ])('keeps unknown relay health and resume failures distinct from absence: %s', async (error) => {
    const f = fixture();
    f.activate();
    f.installed.resume.mockRejectedValue(error);
    f.inspectContainer.mockRejectedValue(error);
    await expect(f.control.resume!(binding)).rejects.toBe(error);
    await expect(
      f.control.isHealthy!({
        sandbox: identity,
        containerGeneration: identity.containerGeneration,
      }),
    ).rejects.toBe(error);
  });

  // A parked Sandbox's relay outlives the generation that is now served. Removing
  // it must never reach a relay this process still holds or a container whose
  // labels name another project or generation.
  describe('discardGeneration', () => {
    const generation = { projectId: 'project', containerGeneration: 'parked' };
    const owned: ContainerInspect = {
      id: 'relay-parked',
      running: false,
      labels: { 'verity.project-id': 'project', 'verity.container-generation': 'parked' },
    };

    it('removes the relay container of exactly that generation', async () => {
      const f = fixture();
      f.activate();
      f.inspectContainer.mockResolvedValue(owned);
      await f.control.discardGeneration!(generation);
      expect(f.inspectContainer).toHaveBeenCalledWith(projectRelayContainerName(generation));
      expect(f.removeContainer).toHaveBeenCalledWith('relay-parked');
    });

    it('treats a relay that is already gone as discarded', async () => {
      const f = fixture();
      f.activate();
      f.inspectContainer.mockRejectedValue(
        new DockerError({ kind: 'container_not_found', id: 'gone' }),
      );
      await expect(f.control.discardGeneration!(generation)).resolves.toBeUndefined();
      expect(f.removeContainer).not.toHaveBeenCalled();
    });

    it('refuses a generation the lifecycle still holds', async () => {
      const f = fixture();
      f.activate();
      f.installed.heldRelays.mockReturnValue([generation]);
      f.inspectContainer.mockResolvedValue(owned);
      await expect(f.control.discardGeneration!(generation)).rejects.toThrow('still held');
      expect(f.removeContainer).not.toHaveBeenCalled();
    });

    it('refuses a container whose labels do not prove the generation', async () => {
      const f = fixture();
      f.activate();
      f.inspectContainer.mockResolvedValue({
        ...owned,
        labels: { 'verity.project-id': 'project', 'verity.container-generation': 'other' },
      });
      await expect(f.control.discardGeneration!(generation)).rejects.toThrow('unproven');
      expect(f.removeContainer).not.toHaveBeenCalled();
    });
  });
});
