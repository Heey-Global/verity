// Shared by the provisioner suites: a recording fake Docker client and Git runner, and a
// ProvisionerImpl with the defaults no test here cares about.
import { vi } from 'vitest';
import type { ContainerSpec, DockerClient } from './docker.js';
import {
  ProvisionerImpl,
  type GitRunner,
  type ProjectRelayControl,
  type ProvisionerOptions,
} from './provisioner.js';

/** Build a fake {@link DockerClient} that records all calls + returns canned
 *  success/id/{inspect} so a provisioner test doesn't hit a real daemon. */
export function fakeDocker(overrides?: Partial<DockerClient> & { createdContainerId?: string }): {
  client: DockerClient;
  calls: Array<{ method: string; payload: unknown }>;
} {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const createdId = overrides?.createdContainerId ?? 'container-abc';
  const base: Pick<
    DockerClient,
    | 'createContainer'
    | 'startContainer'
    | 'stopContainer'
    | 'removeContainer'
    | 'inspectContainer'
    | 'ensureNetwork'
    | 'listContainers'
  > = {
    listContainers: vi.fn(async () => []),
    ensureNetwork: vi.fn(async (name: string) => {
      calls.push({ method: 'ensureNetwork', payload: name });
    }),
    createContainer: vi.fn(async (spec: ContainerSpec) => {
      calls.push({ method: 'createContainer', payload: spec });
      return { id: createdId, warnings: [] };
    }),
    startContainer: vi.fn(async (id: string) => {
      calls.push({ method: 'startContainer', payload: id });
    }),
    stopContainer: vi.fn(async (id: string) => {
      calls.push({ method: 'stopContainer', payload: id });
    }),
    removeContainer: vi.fn(async (id: string) => {
      calls.push({ method: 'removeContainer', payload: id });
    }),
    inspectContainer: vi.fn(async (id: string) => {
      calls.push({ method: 'inspectContainer', payload: id });
      return { id, running: true };
    }),
  };
  return { client: { ...base, ...overrides }, calls };
}

export function defaultProjectRelay(): ProjectRelayControl {
  return {
    async start(binding) {
      return {
        identity: {
          projectId: binding.projectId,
          containerGeneration: binding.containerGeneration,
        },
        signingCapability: 'test-signing-capability',
        githubCapability: 'test-github-capability',
      };
    },
    async resume() {
      return true;
    },
    async stop() {},
    brokerUrl: () => 'http://relay:8080',
    claudeGatewayUrl: () => 'https://relay:8443',
  };
}

export function createProvisioner(
  options: Omit<ProvisionerOptions, 'projectRelay' | 'claudeEgressGatewayUrl'> & {
    projectRelay?: ProjectRelayControl;
    claudeEgressGatewayUrl?: string;
  },
): ProvisionerImpl {
  const {
    projectRelay = defaultProjectRelay(),
    claudeEgressGatewayUrl = 'https://verity:9443',
    ...rest
  } = options;
  return new ProvisionerImpl({
    // No real supervisor runs here; tests that care pass their own.
    supervisorReachable: async () => undefined,
    supervisorStackHealth: async () => undefined,
    prepareLocalWorkspace: async () => undefined,
    // A host larger than any quota asserted here, so CPU expectations do not depend
    // on the machine running the suite. The clamp itself is tested on its own.
    hostCpuCount: () => 64,
    ...rest,
    projectRelay,
    claudeEgressGatewayUrl,
  });
}

/** Build a fake {@link GitRunner} that records call args + returns canned
 *  output, dispatching on the first arg to"/><sub-command>" for canned stdout. */
export function fakeGit(canned: Array<{ match: RegExp; stdout?: string; reject?: boolean }>): {
  runner: GitRunner;
  calls: Array<{ args: readonly string[] }>;
} {
  const calls: Array<{ args: readonly string[] }> = [];
  const runner: GitRunner = async (args) => {
    calls.push({ args });
    const joined = args.join(' ');
    for (const c of canned) {
      if (c.match.test(joined)) {
        if (c.reject === true) {
          throw new Error(`fake git: simulated failure for ${joined}`);
        }
        return { stdout: c.stdout ?? '', stderr: '' };
      }
    }
    // Most provisioner fixtures model an established repository. Individual
    // empty-repository tests override this with an explicit empty response.
    if (joined.includes('ls-remote --heads')) {
      return { stdout: `${'a'.repeat(40)}\trefs/heads/main\n`, stderr: '' };
    }
    throw new Error(`fake git: no canned response for ${joined}`);
  };
  return { runner, calls };
}
