import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRecord } from '@verity/store';
import {
  LISTENING_PORTS_SCRIPT,
  parseListeningProcesses,
  type ListeningProcess,
} from './listening-ports.js';
import { dockerHostFor } from './project-backend.js';
import {
  dockerEnvPassthrough,
  projectSettingsEnv,
  type ProjectEnvironmentSettings,
} from './project-settings-env.js';

const execFileAsync = promisify(execFile);

const IPV4_PORT_PROBE = `const net=require('node:net'),os=require('node:os');
const addresses=Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal).map(x=>x.address);
const probe=(host,port)=>new Promise(resolve=>{const socket=net.connect({host,port});socket.setTimeout(400);socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false)})});
Promise.all(process.argv.slice(1).map(async value=>{const port=Number(value);return (await Promise.all(addresses.map(host=>probe(host,port)))).some(Boolean)})).then(result=>console.log(JSON.stringify(result)));`;

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
  runAutomationScript?(
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
  /** Every TCP listener in the sandbox the exec user can attribute to a process. */
  listListeningProcesses?(project: ProjectRecord): Promise<ListeningProcess[]>;
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

/** The state retains the relay port so active connectors survive helper restarts. */
export const PREVIEW_FORWARDER_SCRIPT = `
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
const address=process.argv[2]||'127.0.0.1';const port=Number(process.argv[1]),dir=process.env.VERITY_PREVIEW_FORWARDER_STATE_DIR||'/tmp/verity-preview-forwarders';
fs.mkdirSync(dir,{recursive:true});const path=dir+'/'+port+'.json';let previous;
function ownsListener(pid,relay){
  try{
    const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0');
    if(!env.includes('VERITY_PREVIEW_FORWARDER='+port))return false;
    const inodes=new Set(fs.readdirSync('/proc/'+pid+'/fd').flatMap(f=>{try{return [fs.readlinkSync('/proc/'+pid+'/fd/'+f).match(/^socket:\\[(\\d+)\\]$/)?.[1]]}catch{return []}}));
    return fs.readFileSync('/proc/net/tcp','utf8').split('\\n').some(line=>{const f=line.trim().split(/\\s+/);return f[3]==='0A'&&parseInt(f[1]?.split(':')[1],16)===relay&&inodes.has(f[9])});
  }catch{return false}
}
try{previous=JSON.parse(fs.readFileSync(path,'utf8'));if(Number.isInteger(previous.port)&&previous.port>0&&previous.port<65536&&ownsListener(previous.pid,previous.port)){const env=fs.readFileSync('/proc/'+previous.pid+'/environ','utf8').split('\\0');if(env.includes('VERITY_PREVIEW_FORWARDER_ADDRESS='+address)){console.log(previous.port);process.exit(0)}process.kill(previous.pid);previous=undefined;}}catch{}
const relay=Number.isInteger(previous?.port)&&previous.port>0&&previous.port<65536?previous.port:0;
const code=\`const net=require('node:net'),fs=require('node:fs');const port=Number(process.env.VERITY_PREVIEW_FORWARDER),relay=Number(process.env.VERITY_PREVIEW_FORWARDER_PORT);const server=net.createServer(client=>{const target=net.connect({host:process.env.VERITY_PREVIEW_FORWARDER_ADDRESS,port});client.pipe(target);target.pipe(client);client.on('error',()=>target.destroy());target.on('error',()=>client.destroy());client.on('close',()=>target.destroy());target.on('close',()=>client.destroy())});server.on('error',()=>process.exit(1));server.listen(relay,'0.0.0.0',()=>{process.send({port:server.address().port});process.disconnect()});setInterval(()=>{try{const present=['/proc/net/tcp','/proc/net/tcp6'].some(p=>fs.readFileSync(p,'utf8').split('\\\\n').some(l=>{const f=l.trim().split(/\\\\s+/);return f[3]==='0A'&&parseInt(f[1]?.split(':')[1],16)===port}));if(!present)process.exit(0)}catch{}},2000).unref();\`;
const child=cp.spawn(process.execPath,['-e',code],{detached:true,env:{...process.env,VERITY_PREVIEW_FORWARDER:String(port),VERITY_PREVIEW_FORWARDER_PORT:String(relay),VERITY_PREVIEW_FORWARDER_ADDRESS:address},stdio:['ignore','ignore','ignore','ipc']});
child.on('message',value=>{fs.writeFileSync(path,JSON.stringify({pid:child.pid,port:value.port}),{mode:0o600});console.log(value.port);child.unref()});child.on('error',()=>process.exit(1));child.on('exit',()=>process.exit(1));setTimeout(()=>process.exit(1),4000).unref();
`;

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
  resolveUser?: (project: ProjectRecord) => Promise<string | undefined>;
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

  async runAutomationScript(
    project: ProjectRecord,
    settings: ProjectEnvironmentSettings,
    input: { workdir: string; script: string; timeoutMs: number; maxOutputBytes: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    // An automation's check script is agent-authored and runs unattended. Do not
    // expose Verity-managed credentials to it: explicitly blank both the token
    // and its ref, including values inherited from the container itself.
    const scriptSettings = projectSettingsEnv({ ...settings });
    const passthrough = dockerEnvPassthrough({
      ...scriptSettings,
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

  /**
   * Starts a managed dev server instance (concept 2.6). Runs as the agent's exec
   * user, resolves the subdirectory with symlinks against the session worktree
   * and refuses one that escapes it, then launches from the resolved directory.
   * Every process inherits `VERITY_DEV_SERVER_INSTANCE`, which is how the
   * supervisor finds the instance again after it forks or daemonizes.
   */
  async startManagedServer(
    project: ProjectRecord,
    input: {
      instanceId: string;
      command: string;
      worktree: string;
      workdir: string;
      env: Record<string, string>;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const passthrough = dockerEnvPassthrough({
      ...input.env,
      VERITY_DEV_SERVER_INSTANCE: input.instanceId,
    });
    try {
      await this.runner(
        this.opts.dockerCommand ?? 'docker',
        [
          'exec',
          ...(await this.userArgs(project)),
          ...passthrough.args,
          project.containerName,
          'sh',
          '-c',
          managedStartScript(project, input.instanceId),
          'verity-managed-start',
          input.worktree,
          input.workdir,
          input.command,
        ],
        { env: { ...this.dockerEnv(), ...passthrough.env }, timeoutMs: 15_000, maxBuffer: 65536 },
      );
      return { ok: true };
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown };
      const reason =
        failure.code === 3
          ? 'The subdirectory does not exist in this session'
          : failure.code === 4
            ? 'The subdirectory leaves the session worktree'
            : String(failure.stderr ?? (error instanceof Error ? error.message : error))
                .trim()
                .slice(0, 300) || 'Could not start the server';
      return { ok: false, reason };
    }
  }

  /** Ends every process tagged with the instance: TERM, up to five seconds, then KILL.
   *  Untagged processes are never touched, even on the instance's port. */
  async stopManagedServer(project: ProjectRecord, instanceId: string): Promise<void> {
    await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        ...(await this.userArgs(project)),
        project.containerName,
        'sh',
        '-c',
        managedStopScript(),
        'verity-managed-stop',
        instanceId,
      ],
      { env: this.dockerEnv(), timeoutMs: 20_000, maxBuffer: 65536 },
    );
  }

  /** Whether any tagged process is alive, and the launcher's exit code once it ended. */
  async managedServerStatus(
    project: ProjectRecord,
    instanceId: string,
  ): Promise<{ alive: boolean; exitCode: number | null }> {
    const result = await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        ...(await this.userArgs(project)),
        project.containerName,
        'sh',
        '-c',
        managedStatusScript(project, instanceId),
        'verity-managed-status',
        instanceId,
      ],
      { env: this.dockerEnv(), timeoutMs: 10_000, maxBuffer: 65536 },
    );
    return parseManagedStatus(result?.stdout ?? '');
  }

  async managedServerLogs(
    project: ProjectRecord,
    instanceId: string,
    lines = 300,
  ): Promise<string> {
    const result = await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        ...(await this.userArgs(project)),
        project.containerName,
        'sh',
        '-c',
        `f=${shellQuote(managedFile(project, instanceId, 'log'))}; [ -f "$f" ] && tail -n ${String(Math.max(1, Math.min(lines, 2000)))} "$f" || true`,
      ],
      { env: this.dockerEnv(), timeoutMs: 10_000, maxBuffer: 1024 * 1024 },
    );
    return result?.stdout ?? '';
  }

  private async userArgs(project: ProjectRecord): Promise<string[]> {
    const user = await this.opts.resolveUser?.(project);
    return user ? ['--user', user] : [];
  }

  /** A separate high port avoids colliding with the original loopback socket. */
  async ensurePreviewTarget(project: ProjectRecord, port: number): Promise<number> {
    const listener = (await this.listListeningProcesses(project)).find(
      (value) => value.port === port,
    );
    if (!listener) throw new Error('the preview target stopped listening');
    if (listener.bind !== 'loopback') return port;
    // Inline execution supports existing sandbox images before their seed refresh.
    const script = PREVIEW_FORWARDER_SCRIPT;
    const result = await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        ...(await this.userArgs(project)),
        project.containerName,
        'node',
        '-e',
        script,
        String(port),
        listener.loopbackAddress ?? '127.0.0.1',
      ],
      { env: this.dockerEnv(), timeoutMs: 5000, maxBuffer: 4096 },
    );
    const targetPort = Number(result?.stdout.trim());
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)
      throw new Error('could not start the loopback preview forwarder');
    return targetPort;
  }

  async listListeningProcesses(project: ProjectRecord): Promise<ListeningProcess[]> {
    const result = await this.runner(
      this.opts.dockerCommand ?? 'docker',
      [
        'exec',
        ...(await this.userArgs(project)),
        project.containerName,
        'sh',
        '-c',
        LISTENING_PORTS_SCRIPT,
      ],
      { env: this.dockerEnv(), timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const processes = parseListeningProcesses(result?.stdout ?? '');
    const ambiguous = processes.filter(
      (process) => process.ipv6Wildcard || process.bind === 'other',
    );
    if (ambiguous.length === 0) return processes;
    let reachable: boolean[] = [];
    try {
      const probe = await this.runner(
        this.opts.dockerCommand ?? 'docker',
        [
          'exec',
          project.containerName,
          'node',
          '-e',
          IPV4_PORT_PROBE,
          ...ambiguous.map((p) => String(p.port)),
        ],
        { env: this.dockerEnv(), timeoutMs: 5_000, maxBuffer: 4096 },
      );
      const parsed: unknown = JSON.parse(probe?.stdout ?? '');
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'boolean')) {
        reachable = parsed;
      }
    } catch {
      // An unverified listener must not be offered as a working public link.
    }
    for (const [index, process] of ambiguous.entries())
      process.reachable = reachable[index] === true;
    return processes;
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

function managedFile(project: ProjectRecord, instanceId: string, kind: 'log' | 'exit'): string {
  const safe = instanceId.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `/tmp/verity-managed-${project.id.replace(/[^A-Za-z0-9_.-]+/g, '_')}/${safe}.${kind}`;
}

/** Arguments: $1 worktree, $2 subdirectory, $3 command. Exit 3: missing
 *  directory, 4: escapes the worktree. The launcher records the command's exit
 *  code so a crash can be reported with it. */
export function managedStartScript(project: ProjectRecord, instanceId: string): string {
  const log = shellQuote(managedFile(project, instanceId, 'log'));
  const exit = shellQuote(managedFile(project, instanceId, 'exit'));
  return [
    'set -u',
    // Check the directory already opened by cd, then launch from that handle.
    // Reopening a resolved path after checking it allows a symlink swap to escape.
    'cd -P -- "$1" 2>/dev/null || exit 3',
    'root=$(pwd -P) || exit 3',
    'cd -P -- "$2" 2>/dev/null || exit 3',
    'target=$(pwd -P) || exit 3',
    'case "$target/" in "$root"/*) ;; *) exit 4 ;; esac',
    `mkdir -p "$(dirname ${log})"`,
    `rm -f ${exit}`,
    'command -v setsid >/dev/null 2>&1 || { echo "setsid is required" >&2; exit 1; }',
    // Appending lets the status check trim the log in place without a gap.
    `: > ${log}`,
    `setsid sh -c 'sh -lc "$1"; echo $? > "$2"' verity-managed "$3" ${exit} </dev/null >>${log} 2>&1 &`,
    'exit 0',
  ].join('\n');
}

function taggedPidsScript(): string[] {
  return [
    'tagged() { for d in /proc/[0-9]*; do',
    '  tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -Fqx "VERITY_DEV_SERVER_INSTANCE=$1" && echo "${d#/proc/}"',
    'done; }',
  ];
}

/** Argument: $1 instance id. */
export function managedStopScript(): string {
  return [
    ...taggedPidsScript(),
    'pids=$(tagged "$1")',
    '[ -z "$pids" ] && exit 0',
    'kill -TERM $pids 2>/dev/null || true',
    'for _ in 1 2 3 4 5; do sleep 1; pids=$(tagged "$1"); [ -z "$pids" ] && exit 0; done',
    'kill -KILL $pids 2>/dev/null || true',
    'exit 0',
  ].join('\n');
}

/** Argument: $1 instance id. Prints `alive` when a tagged process exists, then
 *  `exit <code>` once the launcher recorded one. */
export function managedStatusScript(project: ProjectRecord, instanceId: string): string {
  const exit = shellQuote(managedFile(project, instanceId, 'exit'));
  const log = shellQuote(managedFile(project, instanceId, 'log'));
  return [
    ...taggedPidsScript(),
    // Keep the log bounded: past 2 MB, keep its last megabyte.
    `if [ -f ${log} ] && [ "$(wc -c < ${log})" -gt 2097152 ]; then tail -c 1048576 ${log} > ${log}.tmp && cat ${log}.tmp > ${log}; rm -f ${log}.tmp; fi`,
    '[ -n "$(tagged "$1")" ] && echo alive',
    `[ -s ${exit} ] && printf 'exit %s\\n' "$(cat ${exit})"`,
    'exit 0',
  ].join('\n');
}

export function parseManagedStatus(output: string): { alive: boolean; exitCode: number | null } {
  const lines = output.split('\n').map((line) => line.trim());
  const exit = lines.find((line) => line.startsWith('exit '));
  const code = exit === undefined ? Number.NaN : Number(exit.slice(5));
  return { alive: lines.includes('alive'), exitCode: Number.isInteger(code) ? code : null };
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
