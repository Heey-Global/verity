import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRecord } from '@verity/store';
import { dockerHostFor } from './project-backend.js';
import {
  dockerEnvPassthrough,
  projectSettingsEnv,
  type ProjectEnvironmentSettings,
} from './project-settings-env.js';

const execFileAsync = promisify(execFile);

export interface ProjectRuntimeSettings extends ProjectEnvironmentSettings {
  /** Stable dev_servers.id. Absent only for legacy callers predating multi-server
   * runtime; those keep using the historical `dev-server.*` files. */
  devServerId?: string | null;
  /** Adopt the historical singular pid/log files into this server's ID-scoped
   * files. Set only for the project's first ordered server during migration. */
  adoptLegacyDevServerFiles?: boolean;
  devServerCommand: string | null;
  devServerUrl: string | null;
  devServerWorkdir?: string | null;
  devServerHostPort?: string | null;
  devServerContainerPort?: string | null;
  /** In-container checkout root the server runs from. Set to a session
   * worktree's container path to preview that session's branch; absent/null =
   * the main checkout (`containerProjectRoot`). Relative `devServerWorkdir`
   * values are anchored here. */
  devServerCheckoutRoot?: string | null;
}

export interface ProjectRuntimeStarted {
  projectId: string;
  url: string | null;
  running: boolean;
  pid: string | null;
}

export interface ProjectRuntimeLogs {
  projectId: string;
  logs: string;
}

export interface ProjectRuntimeHealth {
  projectId: string;
  url: string | null;
  reachable: boolean;
  status: number | null;
  checkedAt: string;
  error: string | null;
}

export interface ProjectRuntime {
  runAgentLoopScript?(
    project: ProjectRecord,
    settings: ProjectEnvironmentSettings,
    input: { workdir: string; script: string; timeoutMs: number; maxOutputBytes: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;
  startDevServer(
    project: ProjectRecord,
    settings: ProjectRuntimeSettings,
  ): Promise<ProjectRuntimeStarted>;
  devServerStatus(
    project: ProjectRecord,
    settings: ProjectRuntimeSettings,
  ): Promise<ProjectRuntimeStarted>;
  stopDevServer(
    project: ProjectRecord,
    settings: ProjectRuntimeSettings,
  ): Promise<ProjectRuntimeStarted>;
  devServerLogs(
    project: ProjectRecord,
    settings?: Pick<ProjectRuntimeSettings, 'devServerId'>,
  ): Promise<ProjectRuntimeLogs>;
  devServerHealth(
    project: ProjectRecord,
    settings: ProjectRuntimeSettings,
  ): Promise<ProjectRuntimeHealth>;
}

interface RuntimeRunResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export type RuntimeRunner = (
  command: string,
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number },
) => Promise<RuntimeRunResult | void>;

export type RuntimeHealthFetch = (
  input: string,
  init: { method: 'HEAD' | 'GET'; signal: AbortSignal; redirect: 'manual' },
) => Promise<{ status: number }>;

function safeHealthCheckUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]')
  ) {
    throw new Error('project dev server health URL must use HTTP(S) loopback without credentials');
  }
  return url;
}

function dockerHostHealthCheckUrl(value: string, dockerBaseUrl: string | undefined): URL {
  const url = safeHealthCheckUrl(value);
  if (dockerBaseUrl === undefined) return url;
  const docker = new URL(dockerBaseUrl);
  if (docker.protocol === 'http:' || docker.protocol === 'https:') url.hostname = docker.hostname;
  return url;
}

const defaultRunner: RuntimeRunner = async (command, args, opts) => {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    env: opts?.env,
    timeout: opts?.timeoutMs,
    maxBuffer: opts?.maxBuffer,
    encoding: 'utf8',
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

export interface DockerProjectRuntimeOptions {
  dockerCommand?: string | undefined;
  dockerBaseUrl?: string | undefined;
  containerProjectRoot?: string | undefined;
  runner?: RuntimeRunner | undefined;
  healthFetch?: RuntimeHealthFetch | undefined;
  healthTimeoutMs?: number | undefined;
}

/** Starts a project's configured dev server inside its already-running project container. */
export class DockerProjectRuntime implements ProjectRuntime {
  private readonly runner: RuntimeRunner;
  private readonly healthFetch: RuntimeHealthFetch;

  constructor(private readonly opts: DockerProjectRuntimeOptions = {}) {
    this.runner = opts.runner ?? defaultRunner;
    this.healthFetch = opts.healthFetch ?? fetch;
  }

  async runAgentLoopScript(
    project: ProjectRecord,
    settings: ProjectEnvironmentSettings,
    input: { workdir: string; script: string; timeoutMs: number; maxOutputBytes: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    // Loop output is persisted in run history and may be sent to an agent. Do not
    // expose Verity-managed credentials to the script: explicitly blank both the
    // token and its ref, including values inherited from the container itself.
    const loopSettings = projectSettingsEnv({ ...settings });
    const passthrough = dockerEnvPassthrough({
      ...loopSettings,
      DOPPLER_TOKEN: '',
      VERITY_DOPPLER_TOKEN_REF: '',
    });
    const timeoutSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
    try {
      const result = await this.runner(
        this.opts.dockerCommand ?? 'docker',
        [
          'exec',
          '-i',
          ...passthrough.args,
          '-w',
          input.workdir,
          project.containerName,
          // The timeout must run INSIDE the container. A Node timeout alone only
          // terminates the local `docker exec` client and can leave its child alive.
          'timeout',
          '--signal=TERM',
          '--kill-after=5s',
          `${String(timeoutSeconds)}s`,
          'sh',
          '-lc',
          input.script,
        ],
        {
          env: { ...this.dockerEnv(), ...passthrough.env },
          // Allow the in-container watchdog time to terminate and reap the child.
          timeoutMs: input.timeoutMs + 10_000,
          maxBuffer: input.maxOutputBytes,
        },
      );
      return {
        exitCode: result?.exitCode ?? 0,
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
        timedOut: false,
      };
    } catch (error) {
      const failure = error as {
        code?: string | number;
        killed?: boolean;
        signal?: string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      return {
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        stdout: String(failure.stdout ?? ''),
        stderr: String(failure.stderr ?? (error instanceof Error ? error.message : error)),
        timedOut: failure.code === 124 || failure.killed === true || failure.signal === 'SIGTERM',
      };
    }
  }

  async startDevServer(
    project: ProjectRecord,
    settings: ProjectRuntimeSettings,
  ): Promise<ProjectRuntimeStarted> {
    const command = settings.devServerCommand?.trim();
    if (!command) {
      throw new Error('project dev server command is not configured');
    }
    await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        project.containerName,
        'sh',
        '-lc',
        stopScript(project, settings.devServerId, settings.adoptLegacyDevServerFiles),
      ],
      {
        env: this.dockerEnv(),
      },
    );
    // Detection persists workdirs relative to the repo root (`apps/web`), but
    // `docker exec -w` rejects anything non-absolute, so anchor those at the
    // active checkout root: a session worktree while previewing, else the
    // container project root.
    const containerProjectRoot = this.opts.containerProjectRoot || '/work';
    const projectRoot = settings.devServerCheckoutRoot?.trim() || containerProjectRoot;
    const configuredWorkdir = settings.devServerWorkdir?.trim();
    const workdir =
      configuredWorkdir === undefined || configuredWorkdir === ''
        ? projectRoot
        : configuredWorkdir.startsWith('/')
          ? rebaseProjectWorkdir(configuredWorkdir, containerProjectRoot, projectRoot)
          : posix.join(projectRoot, configuredWorkdir);
    // Project settings contain mapping metadata only. Broker credentials are never
    // projected into the project container or passed on the Docker command line.
    const passthrough = dockerEnvPassthrough(projectSettingsEnv(settings));
    await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        '-d',
        ...passthrough.args,
        '-w',
        workdir,
        project.containerName,
        'sh',
        '-lc',
        startScript(project, command, settings.devServerId, settings.adoptLegacyDevServerFiles),
      ],
      { env: { ...this.dockerEnv(), ...passthrough.env } },
    );
    return this.devServerStatus(project, settings);
  }

  async devServerStatus(
    project: ProjectRecord,
    settings: ProjectRuntimeSettings,
  ): Promise<ProjectRuntimeStarted> {
    const result = await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        project.containerName,
        'sh',
        '-lc',
        statusScript(project, settings.devServerId, settings.adoptLegacyDevServerFiles),
      ],
      { env: this.dockerEnv() },
    );
    const line = result?.stdout.trim() ?? '';
    const [state, pid] = line.split(/\s+/, 2);
    return {
      projectId: project.id,
      url: settings.devServerUrl,
      running: state === 'running',
      pid: state === 'running' && pid ? pid : null,
    };
  }

  async stopDevServer(
    project: ProjectRecord,
    settings: ProjectRuntimeSettings,
  ): Promise<ProjectRuntimeStarted> {
    await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        project.containerName,
        'sh',
        '-lc',
        stopScript(project, settings.devServerId, settings.adoptLegacyDevServerFiles),
      ],
      { env: this.dockerEnv() },
    );
    return { projectId: project.id, url: settings.devServerUrl, running: false, pid: null };
  }

  async devServerLogs(
    project: ProjectRecord,
    settings?: Pick<ProjectRuntimeSettings, 'devServerId' | 'adoptLegacyDevServerFiles'>,
  ): Promise<ProjectRuntimeLogs> {
    const result = await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        project.containerName,
        'sh',
        '-lc',
        logsScript(project, settings?.devServerId, settings?.adoptLegacyDevServerFiles),
      ],
      { env: this.dockerEnv() },
    );
    return { projectId: project.id, logs: result?.stdout ?? '' };
  }

  async devServerHealth(
    project: ProjectRecord,
    settings: ProjectRuntimeSettings,
  ): Promise<ProjectRuntimeHealth> {
    const url = settings.devServerUrl?.trim() || null;
    const checkedAt = new Date().toISOString();
    if (!url) {
      return {
        projectId: project.id,
        url: null,
        reachable: false,
        status: null,
        checkedAt,
        error: 'project dev server URL is not configured',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.healthTimeoutMs ?? 2500);
    try {
      // This probe runs in the privileged control-plane process. Only probe the
      // explicitly supported loopback dev-server surface and never follow a
      // redirect into cloud metadata, the Docker API, or another internal host.
      const checkedUrl = dockerHostHealthCheckUrl(url, this.opts.dockerBaseUrl).href;
      let response = await this.healthFetch(checkedUrl, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status === 405) {
        response = await this.healthFetch(checkedUrl, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'manual',
        });
      }
      return {
        projectId: project.id,
        url,
        reachable: response.status >= 200 && response.status < 400,
        status: response.status,
        checkedAt,
        error: null,
      };
    } catch (caught) {
      return {
        projectId: project.id,
        url,
        reachable: false,
        status: null,
        checkedAt,
        error: caught instanceof Error ? caught.message : 'health check failed',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private dockerEnv(): NodeJS.ProcessEnv {
    return this.opts.dockerBaseUrl !== undefined
      ? { ...process.env, DOCKER_HOST: dockerHostFor(this.opts.dockerBaseUrl) }
      : process.env;
  }
}

function rebaseProjectWorkdir(
  configuredWorkdir: string,
  containerProjectRoot: string,
  activeProjectRoot: string,
): string {
  const relative = posix.relative(containerProjectRoot, configuredWorkdir);
  const isInsideProject = relative === '' || (!relative.startsWith('../') && relative !== '..');
  return isInsideProject ? posix.join(activeProjectRoot, relative) : configuredWorkdir;
}

function runtimeDir(project: ProjectRecord): string {
  return `/tmp/verity-runtime-${project.id.replace(/[^A-Za-z0-9_.-]+/g, '_')}`;
}

function runtimeFileStem(devServerId: string | null | undefined): string {
  if (!devServerId) return 'dev-server';
  const safe = devServerId.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `dev-server-${safe || 'default'}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function adoptionScript(project: ProjectRecord, stem: string, enabled: boolean): string[] {
  if (!enabled || stem === 'dev-server') return [];
  const dir = shellQuote(runtimeDir(project));
  return [
    `if [ ! -e ${dir}/${stem}.pid ] && [ -e ${dir}/dev-server.pid ]; then mv ${dir}/dev-server.pid ${dir}/${stem}.pid; fi`,
    `if [ ! -e ${dir}/${stem}.start ] && [ -e ${dir}/dev-server.start ]; then mv ${dir}/dev-server.start ${dir}/${stem}.start; fi`,
    `if [ ! -e ${dir}/${stem}.log ] && [ -e ${dir}/dev-server.log ]; then mv ${dir}/dev-server.log ${dir}/${stem}.log; fi`,
  ];
}

function startScript(
  project: ProjectRecord,
  command: string,
  devServerId?: string | null,
  adoptLegacy = false,
): string {
  const dir = shellQuote(runtimeDir(project));
  const stem = runtimeFileStem(devServerId);
  return [
    `dir=${dir}`,
    `pidfile="$dir/${stem}.pid"`,
    `identityfile="$dir/${stem}.start"`,
    `logfile="$dir/${stem}.log"`,
    'mkdir -p "$dir"',
    ...adoptionScript(project, stem, adoptLegacy),
    'pid="$(cat "$pidfile" 2>/dev/null || true)"',
    'case "$pid" in ""|*[!0-9]*|0) pid="" ;; esac',
    'if [ -n "$pid" ] && [ -s "$identityfile" ] && [ "$(awk \'{print $22}\' "/proc/$pid/stat" 2>/dev/null)" = "$(cat "$identityfile")" ] && kill -0 "$pid" 2>/dev/null; then exit 0; fi',
    'rm -f "$pidfile" "$identityfile"',
    'command -v setsid >/dev/null 2>&1 || { echo "setsid is required to isolate the dev server process group" >&2; exit 1; }',
    `setsid sh -lc ${shellQuote(command)} >"$logfile" 2>&1 &`,
    'echo $! > "$pidfile"',
    'awk \'{print $22}\' "/proc/$!/stat" > "$identityfile"',
  ].join('\n');
}

function statusScript(
  project: ProjectRecord,
  devServerId?: string | null,
  adoptLegacy = false,
): string {
  const dir = shellQuote(runtimeDir(project));
  const stem = runtimeFileStem(devServerId);
  return [
    ...adoptionScript(project, stem, adoptLegacy),
    `pidfile=${dir}/${stem}.pid`,
    `identityfile=${dir}/${stem}.start`,
    'if [ -s "$pidfile" ]; then',
    'pid="$(cat "$pidfile")"',
    'case "$pid" in ""|*[!0-9]*|0) pid="" ;; esac',
    'if [ -n "$pid" ] && [ -s "$identityfile" ] && [ "$(awk \'{print $22}\' "/proc/$pid/stat" 2>/dev/null)" = "$(cat "$identityfile")" ] && kill -0 "$pid" 2>/dev/null; then echo "running $pid"; exit 0; fi',
    'fi',
    'echo stopped',
  ].join('\n');
}

function stopScript(
  project: ProjectRecord,
  devServerId?: string | null,
  adoptLegacy = false,
): string {
  const dir = shellQuote(runtimeDir(project));
  const stem = runtimeFileStem(devServerId);
  return [
    ...adoptionScript(project, stem, adoptLegacy),
    `pidfile=${dir}/${stem}.pid`,
    `identityfile=${dir}/${stem}.start`,
    'if [ -s "$pidfile" ]; then',
    'pid="$(cat "$pidfile")"',
    'case "$pid" in ""|*[!0-9]*|0) pid="" ;; esac',
    'if [ -z "$pid" ] || [ ! -s "$identityfile" ] || [ "$(awk \'{print $22}\' "/proc/$pid/stat" 2>/dev/null)" != "$(cat "$identityfile")" ]; then rm -f "$pidfile" "$identityfile"; exit 0; fi',
    'if kill -0 "$pid" 2>/dev/null; then',
    'kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    'for _ in 1 2 3 4 5; do',
    'if ! kill -0 "$pid" 2>/dev/null; then break; fi',
    'sleep 1',
    'done',
    'if kill -0 "$pid" 2>/dev/null; then kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi',
    'else',
    'kill -TERM "-$pid" 2>/dev/null || true',
    'fi',
    'rm -f "$pidfile" "$identityfile"',
    'fi',
  ].join('\n');
}

function logsScript(
  project: ProjectRecord,
  devServerId?: string | null,
  adoptLegacy = false,
): string {
  const dir = shellQuote(runtimeDir(project));
  const stem = runtimeFileStem(devServerId);
  return [
    ...adoptionScript(project, stem, adoptLegacy),
    `logfile=${dir}/${stem}.log`,
    'if [ -f "$logfile" ]; then tail -n 200 "$logfile"; fi',
  ].join('\n');
}
