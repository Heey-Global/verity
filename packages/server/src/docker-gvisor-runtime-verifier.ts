import type { DockerClient } from './docker.js';
export interface DockerGvisorRuntimeVerifierOptions {
  docker: DockerClient;
  runtimeName?: string;
  expectedPath: string;
  expectedArgs: readonly string[];
}

/**
 * Attests the host daemon's registered gVisor runtime through Docker `/info` on every call. Any
 * missing endpoint, runtime, path, or argument mismatch fails closed. The path is
 * versioned by the host GitOps asset, so Docker cannot silently redirect `runsc` to `runc`.
 */
export function createDockerGvisorRuntimeVerifier(options: DockerGvisorRuntimeVerifierOptions): {
  verify(runtimeName: string): Promise<void>;
} {
  const expectedName = options.runtimeName ?? 'runsc';

  return {
    async verify(runtimeName) {
      if (runtimeName !== expectedName) {
        throw new Error(`unexpected gVisor runtime name: ${runtimeName}`);
      }
      if (options.docker.inspectRuntime === undefined) {
        throw new Error('Docker runtime inspection is unavailable');
      }
      const registration = await options.docker.inspectRuntime(expectedName);
      if (registration === undefined) throw new Error(`Docker runtime ${expectedName} is missing`);
      if (registration.path !== options.expectedPath) {
        throw new Error(`Docker runtime ${expectedName} path mismatch`);
      }
      if (JSON.stringify(registration.args) !== JSON.stringify(options.expectedArgs)) {
        throw new Error(`Docker runtime ${expectedName} arguments mismatch`);
      }
    },
  };
}
