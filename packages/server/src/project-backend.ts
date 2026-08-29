import {
  AcpClaudeBackend,
  nodeSpawner,
  type Backend,
  type QueryInput,
  type RunResult,
  type RunTurnOptions,
  type SpawnOptions,
  type SpawnedProcess,
  type Spawner,
} from '@verity/session';
import { isUnixBaseUrl, parseUnixBaseUrl } from './docker.js';
import { dockerEnvPassthrough } from './project-settings-env.js';

export interface DockerExecBackendOptions {
  /** Canonical Docker container name, e.g. `verity-heey-global--verity`. */
  containerName: string;
  /** Host-side project clone root, e.g. `/data/dev/heey-global-verity`. */
  hostProjectRoot: string;
  /** Container-side project root. Matches the provisioner's `/work` bind. */
  containerProjectRoot?: string | undefined;
  /** Docker CLI binary. Defaults to `docker`. */
  dockerCommand?: string | undefined;
  /** Docker Engine HTTP base URL; mapped to DOCKER_HOST for the Docker CLI. */
  dockerBaseUrl?: string | undefined;
  /** Test seam; defaults to the real node spawner. */
  spawner?: Spawner | undefined;
  /** Backend to execute inside the container. Defaults to Claude. */
  backend?: Backend | undefined;
  /** Explicit environment variables to project into the container process. */
  containerEnv?: Record<string, string> | undefined;
}

// `docker exec` inherits the container's env, so the GitHub-token broker vars the
// provisioner set on the container (VERITY_GH_TOKEN_URL + capability file) flow
// through to agent exec sessions — no gh-token file is projected here. PATH is
// re-set so /opt/agent-seed/bin (the gh wrapper + credential helper) wins.
const AGENT_EXEC_BASE_ENV: Record<string, string> = {
  PATH: '/opt/agent-seed/bin:/usr/local/share/nvm/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
};

function stripTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, '');
}

/** Map a host bind-mount path under the project clone to its in-container path. */
export function containerPathFor(
  hostPath: string,
  hostProjectRoot: string,
  containerProjectRoot = '/work',
): string {
  const hostRoot = stripTrailingSlashes(hostProjectRoot);
  const containerRoot = stripTrailingSlashes(containerProjectRoot);
  if (hostPath === hostRoot) return containerRoot;
  if (!hostPath.startsWith(`${hostRoot}/`)) {
    throw new Error(`project worktree ${hostPath} is not under project root ${hostRoot}`);
  }
  return `${containerRoot}${hostPath.slice(hostRoot.length)}`;
}

export function dockerHostFor(baseUrl: string): string {
  // Unix-socket base URLs may carry an API-version suffix
  // (`unix:///var/run/docker.sock:/v1.41`, ADR 0003 R2) that the DockerClient
  // understands but the `docker` CLI cannot parse — it would try to dial the
  // literal path `/var/run/docker.sock:/v1.41`. Strip the suffix so DOCKER_HOST
  // gets the plain socket URL. The provisioner (createDockerClient) and this
  // CLI-exec path are fed the SAME env var in the standalone R2 deploy, so both
  // must accept the documented suffixed form.
  if (isUnixBaseUrl(baseUrl)) {
    const parsed = parseUnixBaseUrl(baseUrl);
    return `unix://${parsed.socketPath}`;
  }
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') return `tcp://${url.host}`;
  if (url.protocol === 'https:') return `tcp://${url.host}`;
  return baseUrl;
}

/** Runs an agent in a provisioned project container via `docker exec`.
 *
 * The wrapped backend still owns the transport, steering, cancellation, and
 * transcript persistence. This backend only changes the process boundary:
 * `<agent> …` becomes `docker exec -i -w <container-cwd> <container> <agent> …`.
 */
export class DockerExecBackend implements Backend {
  private readonly backend: Backend;
  private readonly spawner: Spawner;
  readonly runnerSupervisorBackend: Backend['runnerSupervisorBackend'];

  constructor(private readonly opts: DockerExecBackendOptions) {
    this.backend = opts.backend ?? new AcpClaudeBackend();
    this.runnerSupervisorBackend = this.backend.runnerSupervisorBackend;
    const baseSpawner = opts.spawner ?? nodeSpawner;
    this.spawner = (command, args, spawnOpts): SpawnedProcess => {
      const cwd = containerPathFor(
        spawnOpts.cwd,
        opts.hostProjectRoot,
        opts.containerProjectRoot ?? '/work',
      );
      // Env passed by REFERENCE (`-e NAME`) with the values injected into the docker
      // CLI's own process env below (audit M8) — keeps DOPPLER_TOKEN etc. off argv.
      const passthrough = dockerEnvPassthrough({
        ...AGENT_EXEC_BASE_ENV,
        VERITY_SIGNING_DOCKER_CONTAINER: opts.containerName,
        VERITY_GH_TOKEN_DOCKER_CONTAINER: opts.containerName,
        ...opts.containerEnv,
      });
      const inContainer = [command, ...args];
      const dockerArgs = [
        'exec',
        '-i',
        ...passthrough.args,
        '-w',
        cwd,
        opts.containerName,
        ...inContainer,
      ];
      const wrapped: SpawnOptions = {
        ...spawnOpts,
        // Base on the caller's env (or process.env when absent, matching the prior
        // inheritance) so docker command resolution is unchanged; then add the
        // pass-through values and DOCKER_HOST.
        env: {
          ...(spawnOpts.env ?? process.env),
          ...passthrough.env,
          ...(opts.dockerBaseUrl !== undefined
            ? { DOCKER_HOST: dockerHostFor(opts.dockerBaseUrl) }
            : {}),
        },
        // The Docker CLI itself runs in the Verity server container. The actual
        // agent cwd is carried by `docker exec -w` above.
        cwd: process.cwd(),
      };
      return baseSpawner(opts.dockerCommand ?? 'docker', dockerArgs, wrapped);
    };
  }

  run(opts: RunTurnOptions): Promise<RunResult> {
    return this.backend.run({
      ...opts,
      // The live backend fingerprints the central OAuth token. A rotation must
      // restart the child because an already-spawned process keeps its old env.
      env: { ...(opts.env ?? process.env), ...this.opts.containerEnv },
      spawner: this.spawner,
    });
  }

  closeSession(sessionId: string): void {
    this.backend.closeSession?.(sessionId);
  }

  /** Delegate a one-shot query to the inner backend, but run it INSIDE the
   * project's container via the same `docker exec` spawner turns use — so a CLI
   * one-shot (e.g. `claude -p` for auto-titling) sees the container's auth/model.
   * Returns undefined if the inner backend has no one-shot. */
  query(input: QueryInput): Promise<string | undefined> {
    return (
      this.backend.query?.({
        ...input,
        env: { ...(input.env ?? process.env), ...this.opts.containerEnv },
        spawner: this.spawner,
      }) ?? Promise.resolve(undefined)
    );
  }
}
