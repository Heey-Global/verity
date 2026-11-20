import { describe, expect, it, vi } from 'vitest';
import { DockerError, type ContainerInspect } from './docker.js';
import { AGENT_GATEWAY_PEER_FINGERPRINT_LABEL } from './agent-gateway-projection.js';
import { CONTAINER_GENERATION_LABEL } from './project-relay-migration.js';
import { CONTROL_PLANE_RUNNER_PROJECT_ID } from './embedded-support.js';
import { sandboxIdentity } from './sandbox-identity.js';
import {
  createEmbeddedAgentGatewayReadiness,
  createEmbeddedAgentGatewayRouting,
} from './embedded-agent-gateway-routing.js';

type Routing = Parameters<typeof createEmbeddedAgentGatewayRouting>[0];
const binding = (fingerprint256 = 'known', userId = 'person') => ({
  projectId: 'project',
  userId,
  fingerprint256,
});
const inspected: ContainerInspect = {
  id: 'container',
  running: true,
  labels: {
    [CONTAINER_GENERATION_LABEL]: 'generation',
    [AGENT_GATEWAY_PEER_FINGERPRINT_LABEL]: 'known',
  },
};
function fixture() {
  const state = { bindings: [binding()], bindingProjection: Promise.resolve() };
  const readiness = createEmbeddedAgentGatewayReadiness({ secretRoot: undefined, state });
  const isHealthy = vi.fn<
    NonNullable<NonNullable<typeof readiness.projectRelayControlRef.current>['isHealthy']>
  >(async () => true);
  readiness.projectRelayControlRef.current = { isHealthy };
  const inspectContainer = vi.fn<(name: string) => Promise<ContainerInspect>>(
    async () => inspected,
  );
  let docker: Routing['getDocker'] extends () => infer T ? T : never;
  const project = { id: 'project', containerName: 'original' };
  const getProject = vi.fn<Routing['eventStore']['getProject']>();
  // Only the project identity fields are consumed by routing.
  getProject.mockResolvedValue(project as Awaited<ReturnType<typeof getProject>>);
  const projectDefault = vi.fn(async () => ({
    projectId: 'project',
    userId: 'default',
    projectDefault: true,
  }));
  const context: Routing = {
    config: {},
    agentGatewayUrl: new URL('https://gateway'),
    getDocker: () => docker,
    eventStore: {
      getProject,
      projectSandboxes: { projectDefault } as unknown as Routing['eventStore']['projectSandboxes'],
    },
    state,
    healthyRelayGeneration: readiness.healthyRelayGeneration,
  };
  const route = createEmbeddedAgentGatewayRouting(context);
  return {
    state,
    readiness,
    isHealthy,
    inspectContainer,
    getProject,
    projectDefault,
    context,
    route,
    project,
    activate: () => {
      docker = { inspectContainer };
    },
  };
}

describe('embedded gateway routing', () => {
  it('reads Docker lazily and checks each person against their own relay', async () => {
    const f = fixture();
    expect(await f.route([binding()])).toEqual([]);
    f.activate();
    const bindings = [binding(), binding('default-cert', 'default')];
    expect(await f.route(bindings)).toEqual(bindings);
    expect(f.inspectContainer.mock.calls).toEqual([
      [sandboxIdentity(f.project, { userId: 'person', projectDefault: false }).containerName],
      ['original'],
    ]);
    expect(f.isHealthy.mock.calls).toEqual([
      [
        {
          sandbox: { projectId: 'project', userId: 'person', projectDefault: false },
          containerGeneration: 'generation',
        },
      ],
      [
        {
          sandbox: { projectId: 'project', projectDefault: true },
          containerGeneration: 'generation',
        },
      ],
    ]);
    expect(f.projectDefault).toHaveBeenCalledTimes(2);
    f.isHealthy.mockResolvedValue(false);
    expect(await f.route([binding()])).toEqual([]);
  });

  it('requires a gateway URL and explicitly enabled control-plane runner', async () => {
    const f = fixture();
    f.activate();
    const runner = { projectId: CONTROL_PLANE_RUNNER_PROJECT_ID, fingerprint256: 'runner' };
    f.getProject.mockResolvedValue(undefined);
    expect(await f.route([runner])).toEqual([]);
    f.context.config.controlPlaneRunner = true;
    expect(await f.route([runner])).toEqual([runner]);
    expect(
      await createEmbeddedAgentGatewayRouting({ ...f.context, agentGatewayUrl: undefined })([
        runner,
      ]),
    ).toEqual([]);
  });

  it.each([
    new DockerError({ kind: 'network', cause: new Error('offline') }),
    new DockerError({ kind: 'other', status: 503, message: 'unavailable' }),
  ])('retains only an exact cached binding on transient failure: %s', async (error) => {
    const f = fixture();
    f.activate();
    f.inspectContainer.mockRejectedValue(error);
    expect(
      await f.route([
        binding(),
        binding('rotated'),
        binding('known', 'other'),
        { ...binding(), projectId: 'other' },
      ]),
    ).toEqual([binding()]);
  });

  it.each([new Error('unknown'), new DockerError({ kind: 'container_not_found', id: 'gone' })])(
    'withdraws cached bindings on definitive failure: %s',
    async (error) => {
      const f = fixture();
      f.activate();
      f.inspectContainer.mockRejectedValue(error);
      expect(await f.route([binding()])).toEqual([]);
    },
  );
});

describe('embedded gateway readiness', () => {
  it('waits for projection and requires the matching person, certificate and healthy generation', async () => {
    const f = fixture();
    let release!: () => void;
    f.state.bindingProjection = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sandbox = { projectId: 'project', userId: 'person', projectDefault: false };
    const ready = f.readiness.agentGatewayReady(sandbox, inspected);
    await Promise.resolve();
    expect(f.isHealthy).not.toHaveBeenCalled();
    release();
    expect(await ready).toBe(true);
    f.state.bindings = [binding('known', 'other')];
    expect(await f.readiness.agentGatewayReady(sandbox, inspected)).toBe(false);
    f.state.bindings = [binding('rotated')];
    expect(await f.readiness.agentGatewayReady(sandbox, inspected)).toBe(false);
    f.state.bindings = [binding()];
    expect(await f.readiness.agentGatewayReady(sandbox, { ...inspected, labels: {} })).toBe(false);
    expect(await f.readiness.agentGatewayReady(sandbox, { ...inspected, running: false })).toBe(
      false,
    );
    f.readiness.projectRelayControlRef.current = undefined;
    expect(await f.readiness.agentGatewayReady(sandbox, inspected)).toBe(false);
  });
});
