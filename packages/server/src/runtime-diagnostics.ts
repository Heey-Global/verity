import { request as httpRequest } from 'node:http';
import { open, statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { z } from 'zod';
import { parseUnixBaseUrl } from './docker.js';

const number = z.number().finite().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const containerId = z.string().regex(/^[a-f0-9]{12,64}$/u);
export const runtimeWindowSchema = z
  .object({ since: timestamp.optional(), until: timestamp.optional() })
  .strict();
export type RuntimeWindow = z.infer<typeof runtimeWindowSchema>;
export const runtimeEvidenceSchema = z.object({
  at: timestamp,
  source: z.enum(['kernel', 'runtime', 'server', 'runner', 'updater', 'docker']),
  code: z.enum([
    'oom_kill',
    'memory_pressure',
    'kernel_fault',
    'disk_pressure',
    'resource_limit',
    'runtime_started',
    'runtime_stopped',
    'runtime_error',
    'runtime_disconnect',
    'runtime_failure',
    'runner_reconcile_failed',
    'update_started',
    'update_completed',
    'update_failed',
    'create',
    'start',
    'die',
    'destroy',
    'oom',
    'kill',
    'stop',
    'restart',
    'pause',
    'unpause',
    'health_status',
  ]),
  containerId: containerId.optional(),
  bootId: z
    .string()
    .regex(/^[a-f0-9]{32}$/u)
    .optional(),
  exitCode: z.number().int().optional(),
  signal: z.number().int().optional(),
});
const sourceState = z.enum(['available', 'unavailable', 'failed']);
export const hostDiagnosticSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: timestamp,
  since: timestamp,
  until: timestamp,
  sources: z.object({ kernel: sourceState, runtime: sourceState }),
  truncated: z.boolean(),
  records: z.array(runtimeEvidenceSchema).max(400),
});
const containerSchema = z.object({
  id: containerId,
  role: z.enum(['project', 'server', 'runner', 'updater', 'gateway', 'database', 'connector']),
  state: z.enum([
    'created',
    'running',
    'paused',
    'restarting',
    'removing',
    'exited',
    'dead',
    'unknown',
  ]),
  imageId: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .nullable(),
  runtime: z.enum(['runsc', 'runsc-project', 'runc', 'other', 'unknown']),
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  exitCode: z.number().int().nullable(),
  oomKilled: z.boolean().nullable(),
  restartCount: number.nullable(),
  memoryLimitBytes: number.nullable(),
  memorySwapLimitBytes: z.number().finite().nullable(),
  nanoCpus: number.nullable(),
  pidsLimit: z.number().finite().nullable(),
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none', 'unknown']),
  stats: z.object({
    state: sourceState,
    observedAt: timestamp.nullable(),
    memoryUsageBytes: number.nullable(),
    memoryPeakBytes: number.nullable(),
    memoryLimitBytes: number.nullable(),
    memoryFailures: number.nullable(),
    pids: number.nullable(),
  }),
  logs: z.object({
    state: sourceState,
    truncated: z.boolean(),
    records: z.array(runtimeEvidenceSchema).max(100),
  }),
});
export const runtimeDiagnosticSnapshotSchema = z.object({
  observedAt: timestamp,
  window: z.object({ since: timestamp, until: timestamp }),
  resources: z.object({
    scope: z.literal('server_process_and_visible_host'),
    uptimeSeconds: number,
    rssBytes: number,
    heapUsedBytes: number,
    heapLimitBytes: number,
    externalBytes: number,
    arrayBuffersBytes: number,
    constrainedMemoryBytes: number.nullable(),
    totalMemoryBytes: number,
    freeMemoryBytes: number,
    availableCpus: number,
    loadAverage: z.array(number).length(3),
    disk: z.object({ totalBytes: number, availableBytes: number, freeInodes: number }).nullable(),
    cgroup: z.object({
      currentBytes: number.nullable(),
      peakBytes: number.nullable(),
      limitBytes: number.nullable(),
      oom: number.nullable(),
      oomKill: number.nullable(),
      high: number.nullable(),
      max: number.nullable(),
      cpuThrottledPeriods: number.nullable(),
      cpuQuotaCores: number.nullable(),
    }),
  }),
  docker: z.object({
    state: sourceState,
    version: z.string().max(80).nullable(),
    containers: z.array(containerSchema).max(12),
    truncated: z.boolean(),
    events: z.object({
      state: sourceState,
      truncated: z.boolean(),
      records: z.array(runtimeEvidenceSchema).max(256),
    }),
  }),
  host: z.object({
    state: sourceState,
    stale: z.boolean(),
    snapshot: hostDiagnosticSnapshotSchema.nullable(),
  }),
  limitations: z.array(z.string().max(300)).max(12),
});
export type RuntimeDiagnosticSnapshot = z.infer<typeof runtimeDiagnosticSnapshotSchema>;
type Evidence = z.infer<typeof runtimeEvidenceSchema>;
type DockerRead = (path: string) => Promise<{ bytes: Buffer; truncated: boolean }>;
const MAX_BYTES = 512 * 1024;
const MAX_WINDOW_MS = 24 * 60 * 60_000;

export function resolveRuntimeWindow(window: RuntimeWindow = {}, now = Date.now()) {
  const until = window.until === undefined ? now : Date.parse(window.until);
  const since = window.since === undefined ? until - 60 * 60_000 : Date.parse(window.since);
  if (
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    since >= until ||
    until > now + 60_000 ||
    until - since > MAX_WINDOW_MS
  )
    throw new Error('Diagnostic window must be ordered, at most 24 hours, and not in the future');
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

/** A fixed GET-only transport. Stop retaining bytes before parsing untrusted daemon output. */
export function createDiagnosticDockerRead(baseUrl: string, deadline?: AbortSignal): DockerRead {
  const base = baseUrl.replace(/\/$/u, '');
  return async (path) => {
    const signal =
      deadline === undefined
        ? AbortSignal.timeout(5_000)
        : AbortSignal.any([deadline, AbortSignal.timeout(5_000)]);
    if (base.startsWith('unix:')) {
      const parsed = parseUnixBaseUrl(base);
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            socketPath: parsed.socketPath,
            path: `${parsed.apiPrefix}${path}`,
            method: 'GET',
            signal,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            if ((res.statusCode ?? 500) >= 400) {
              res.resume();
              reject(new Error('Docker diagnostic read failed'));
              return;
            }
            res.on('data', (chunk: Buffer) => {
              if (size + chunk.length > MAX_BYTES) {
                req.destroy(new Error('Docker diagnostic response exceeded limit'));
                return;
              }
              size += chunk.length;
              chunks.push(chunk);
            });
            res.on('end', () => resolve({ bytes: Buffer.concat(chunks), truncated: false }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end();
      });
    }
    const response = await fetch(`${base}${path}`, { method: 'GET', signal, redirect: 'error' });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error('Docker diagnostic read failed');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const chunk: unknown = part.value;
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid Docker response chunk');
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('Docker diagnostic response exceeded limit');
        chunks.push(Buffer.from(chunk));
      }
      return { bytes: Buffer.concat(chunks), truncated: false };
    } finally {
      await reader.cancel();
    }
  };
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function signedNumeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function time(value: unknown): string | null {
  const parsed = timestamp.safeParse(value);
  return parsed.success && !parsed.data.startsWith('0001-') ? parsed.data : null;
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only allowlisted classifications escape; raw log text and arbitrary JSON fields never do. */
export function classifyRuntimeLog(message: string): Evidence['code'] | undefined {
  if (/out of memory|oom-kill|killed process|memory cgroup out of memory/iu.test(message))
    return 'oom_kill';
  if (/memory pressure|memory allocation failed/iu.test(message)) return 'memory_pressure';
  if (/segfault|general protection fault|kernel panic/iu.test(message)) return 'kernel_fault';
  if (/no space left on device|\bENOSPC\b/iu.test(message)) return 'disk_pressure';
  if (/too many open files|\bEMFILE\b|resource temporarily unavailable|pids limit/iu.test(message))
    return 'resource_limit';
  if (
    /daemon has completed initialization|starting docker application container engine/iu.test(
      message,
    )
  )
    return 'runtime_started';
  if (
    /daemon shutdown complete|processing signal.*(?:terminated|SIGTERM)|stopping docker application container engine/iu.test(
      message,
    )
  )
    return 'runtime_stopped';
  if (
    /WaitPID.*EOF|containerManager.*EOF|sandbox.*(?:disconnect|connection.*closed)/iu.test(message)
  )
    return 'runtime_disconnect';
  if (/runner.*reconcil.*(?:fail|error)|(?:fail|error).*runner.*reconcil/iu.test(message))
    return 'runner_reconcile_failed';
  if (/(?:runsc|sandbox runtime|containerd).*(?:panic|fatal|crash|failed)/iu.test(message))
    return 'runtime_failure';
  if (/(?:image|sandbox|server).*update.*(?:completed|succeeded)/iu.test(message))
    return 'update_completed';
  if (/(?:image|sandbox|server).*update.*(?:failed|error)/iu.test(message)) return 'update_failed';
  if (/(?:image|sandbox|server).*update.*(?:started|starting)/iu.test(message))
    return 'update_started';
  if (/\b(?:error|failed|fatal|panic)\b/iu.test(message)) return 'runtime_error';
  return undefined;
}

function logRecords(
  bytes: Buffer,
  id: string,
  source: Evidence['source'],
  window: { since: string; until: string },
) {
  // Docker uses 8-byte multiplex headers unless the container has a TTY.
  let text = '';
  let offset = 0;
  if (
    bytes.length >= 8 &&
    bytes[0] !== undefined &&
    bytes[0] <= 2 &&
    bytes.subarray(1, 4).every((byte) => byte === 0)
  ) {
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset + 4);
      if (offset + 8 + length > bytes.length) break;
      text += bytes.subarray(offset + 8, offset + 8 + length).toString('utf8');
      offset += 8 + length;
    }
  } else text = bytes.toString('utf8');
  const lines = text.split('\n');
  const records: Evidence[] = [];
  for (const line of lines) {
    const match = /^(\S+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const at = time(match[1]);
    const code = classifyRuntimeLog(match[2] ?? '');
    if (
      at === null ||
      code === undefined ||
      Date.parse(at) < Date.parse(window.since) ||
      Date.parse(at) > Date.parse(window.until)
    )
      continue;
    records.push({ at, source, code, containerId: id });
  }
  return {
    records: records.slice(-100),
    truncated: lines.length >= 201 || records.length > 100 || (offset > 0 && offset < bytes.length),
  };
}

async function readSmallFile(path: string, limit = MAX_BYTES) {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Diagnostic source is not a regular file');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('Diagnostic file exceeded limit');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

async function readResources(dataRoot: string) {
  let cgroupRoot: string | undefined;
  try {
    const group = /^0::(\/[^\n]*)$/mu.exec(await readSmallFile('/proc/self/cgroup', 4096))?.[1];
    if (group !== undefined && !group.split('/').includes('..'))
      cgroupRoot = `/sys/fs/cgroup${group === '/' ? '' : group}`;
  } catch {
    /* Cgroup v1 and hidden process metadata remain unavailable. */
  }

  const readCounter = async (path: string) => {
    try {
      if (cgroupRoot === undefined) return null;
      const value = (await readSmallFile(`${cgroupRoot}/${path}`, 4096)).trim();
      return /^\d+$/u.test(value) ? numeric(Number(value)) : null;
    } catch {
      return null;
    }
  };
  const readCounters = async (path: string): Promise<Record<string, number | null>> => {
    try {
      if (cgroupRoot === undefined) return {};
      return Object.fromEntries<number | null>(
        (await readSmallFile(`${cgroupRoot}/${path}`, 4096))
          .trim()
          .split('\n')
          .map((line): [string, number | null] => {
            const [key, value] = line.split(/\s+/u);
            return [key ?? '', numeric(Number(value))];
          }),
      );
    } catch {
      return {};
    }
  };
  let cpuQuotaCores = null;
  if (cgroupRoot !== undefined) {
    try {
      const [quota, period] = (await readSmallFile(`${cgroupRoot}/cpu.max`, 4096))
        .trim()
        .split(/\s+/u);
      if (quota !== 'max' && Number(period) > 0)
        cpuQuotaCores = numeric(Number(quota) / Number(period));
    } catch {
      /* No visible CPU quota. */
    }
  }
  const [currentBytes, peakBytes, limitBytes, events, cpu] = await Promise.all([
    readCounter('memory.current'),
    readCounter('memory.peak'),
    readCounter('memory.max'),
    readCounters('memory.events'),
    readCounters('cpu.stat'),
  ]);
  let disk = null;
  try {
    const stats = await statfs(dataRoot);
    disk = {
      totalBytes: stats.blocks * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
      freeInodes: stats.ffree,
    };
  } catch {
    /* Unsupported filesystems remain explicit. */
  }
  const memory = process.memoryUsage();
  return {
    scope: 'server_process_and_visible_host' as const,
    uptimeSeconds: process.uptime(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    constrainedMemoryBytes: process.constrainedMemory() || null,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    availableCpus: availableParallelism(),
    loadAverage: loadavg(),
    disk,
    cgroup: {
      currentBytes,
      peakBytes,
      limitBytes,
      oom: events.oom ?? null,
      oomKill: events.oom_kill ?? null,
      high: events.high ?? null,
      max: events.max ?? null,
      cpuThrottledPeriods: cpu.nr_throttled ?? null,
      cpuQuotaCores,
    },
  };
}

export function createRuntimeDiagnostics(deps: {
  dockerBaseUrl?: string | undefined;
  readDocker?: DockerRead;
  serverContainerId?: string | undefined;
  dataRoot?: string | undefined;
  hostSnapshotPath?: string | undefined;
  readHostSnapshot?: (() => Promise<string>) | undefined;
  now?: () => number;
}) {
  return async (request: {
    window?: RuntimeWindow | undefined;
    projectId?: string | undefined;
    containerName?: string | undefined;
  }): Promise<RuntimeDiagnosticSnapshot> => {
    const readDocker =
      deps.readDocker ??
      (deps.dockerBaseUrl
        ? createDiagnosticDockerRead(deps.dockerBaseUrl, AbortSignal.timeout(30_000))
        : undefined);
    const now = deps.now?.() ?? Date.now();
    const window = resolveRuntimeWindow(request.window, now);
    const resources = await readResources(deps.dataRoot ?? process.cwd());
    const host: RuntimeDiagnosticSnapshot['host'] = {
      state: 'unavailable',
      stale: false,
      snapshot: null,
    };
    if (deps.readHostSnapshot || deps.hostSnapshotPath) {
      try {
        const snapshot = hostDiagnosticSnapshotSchema.parse(
          JSON.parse(await (deps.readHostSnapshot?.() ?? readSmallFile(deps.hostSnapshotPath!))),
        );
        const age = now - Date.parse(snapshot.observedAt);
        host.stale = age > 5 * 60_000 || age < -60_000;
        snapshot.records = snapshot.records.filter(
          (record) =>
            Date.parse(record.at) >= Date.parse(window.since) &&
            Date.parse(record.at) <= Date.parse(window.until),
        );
        host.snapshot = snapshot;
        host.state = 'available';
      } catch (error) {
        host.state = object(error).code === 'ENOENT' ? 'unavailable' : 'failed';
      }
    }
    const docker: RuntimeDiagnosticSnapshot['docker'] = {
      state: 'unavailable',
      version: null,
      containers: [],
      truncated: false,
      events: { state: 'unavailable', truncated: false, records: [] },
    };
    if (readDocker) {
      const json = async (path: string) =>
        JSON.parse((await readDocker(path)).bytes.toString('utf8')) as unknown;
      docker.state = 'available';
      let labels: Record<string, unknown> = {};
      let ownId: string | undefined;
      let controlNetworkId: string | undefined;
      try {
        const version = object(await json('/version'));
        const parsed = z
          .string()
          .regex(/^[a-zA-Z0-9.+_-]{1,80}$/u)
          .safeParse(version.Version);
        docker.version = parsed.success ? parsed.data : null;
      } catch {
        docker.state = 'failed';
      }
      if (deps.serverContainerId && containerId.safeParse(deps.serverContainerId).success) {
        try {
          const self = object(
            await json(`/containers/${encodeURIComponent(deps.serverContainerId)}/json`),
          );
          labels = object(object(self.Config).Labels);
          if (containerId.safeParse(self.Id).success) ownId = String(self.Id);
          const controlNetwork = object(
            object(object(self.NetworkSettings).Networks)['verity-net'],
          );
          if (containerId.safeParse(controlNetwork.NetworkID).success)
            controlNetworkId = String(controlNetwork.NetworkID);
        } catch {
          docker.state = 'failed';
        }
      }
      const selected: Array<{ id: string; role: z.infer<typeof containerSchema>['role'] }> = [];
      // The Server's own deployment labels anchor infrastructure scope; never list an unrelated fleet.
      const deployment =
        typeof labels['verity.managed-deployment-id'] === 'string'
          ? labels['verity.managed-deployment-id']
          : undefined;
      let compose =
        typeof labels['com.docker.compose.project'] === 'string'
          ? labels['com.docker.compose.project']
          : undefined;
      // Managed Servers are created outside Compose. Verify the attached control
      // network's identity before using its owning Compose project as another scope.
      if (deployment && !compose && controlNetworkId) {
        try {
          const network = object(await json(`/networks/${controlNetworkId}`));
          const networkLabels = object(network.Labels);
          if (
            network.Id === controlNetworkId &&
            network.Name === 'verity-net' &&
            networkLabels['com.docker.compose.network'] === 'default' &&
            typeof networkLabels['com.docker.compose.project'] === 'string'
          )
            compose = networkLabels['com.docker.compose.project'];
        } catch {
          docker.state = 'failed';
        }
      }
      const scopes = [
        ...(deployment ? [`verity.managed-deployment-id=${deployment}`] : []),
        ...(compose ? [`com.docker.compose.project=${compose}`] : []),
      ];
      const roleFor = (raw: unknown): z.infer<typeof containerSchema>['role'] | undefined => {
        const roles: Record<string, z.infer<typeof containerSchema>['role']> = {
          server: 'server',
          verity: 'server',
          'verity-control-runner': 'runner',
          'verity-updater': 'updater',
          'verity-agent-gateway': 'gateway',
          'verity-managed-gateway': 'gateway',
          'managed-gateway': 'gateway',
          'verity-matrix-connector': 'connector',
          'verity-preview-connector': 'connector',
          'control-plane-runner': 'runner',
          'runner-supervisor': 'runner',
          updater: 'updater',
          'agent-gateway': 'gateway',
          postgres: 'database',
          'matrix-connector': 'connector',
          'preview-connector': 'connector',
        };
        return typeof raw === 'string' ? roles[raw] : undefined;
      };
      if (scopes.length > 0) {
        for (const scope of scopes) {
          try {
            const filters = { label: [scope] };
            const list = z
              .array(z.unknown())
              .parse(
                await json(
                  `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify(filters))}`,
                ),
              );
            for (const value of list) {
              const item = object(value);
              const ownLabels = object(item.Labels);
              const separator = scope.indexOf('=');
              if (ownLabels[scope.slice(0, separator)] !== scope.slice(separator + 1)) continue;
              const role = roleFor(
                ownLabels['verity.managed-role'] ?? ownLabels['com.docker.compose.service'],
              );
              if (
                role &&
                containerId.safeParse(item.Id).success &&
                !selected.some((entry) => entry.id === item.Id)
              )
                selected.push({ id: String(item.Id), role });
            }
          } catch {
            docker.state = 'failed';
          }
        }
      } else if (ownId !== undefined) selected.push({ id: ownId, role: 'server' });
      if (request.containerName && request.projectId) {
        try {
          const project = object(
            await json(`/containers/${encodeURIComponent(request.containerName)}/json`),
          );
          if (
            object(object(project.Config).Labels)['verity.project-id'] === request.projectId &&
            containerId.safeParse(project.Id).success
          )
            selected.unshift({ id: String(project.Id), role: 'project' });
        } catch {
          docker.state = 'failed';
        }
      }
      docker.truncated = selected.length > 12;
      for (const selectedContainer of selected.slice(0, 12)) {
        try {
          const value = object(await json(`/containers/${selectedContainer.id}/json`));
          const state = object(value.State);
          const config = object(value.HostConfig);
          if (value.Id !== selectedContainer.id) throw new Error('Container identity changed');
          if (
            selectedContainer.role === 'project' &&
            object(object(value.Config).Labels)['verity.project-id'] !== request.projectId
          )
            throw new Error('Project container identity changed');
          const stats: z.infer<typeof containerSchema>['stats'] = {
            state: 'unavailable',
            observedAt: null,
            memoryUsageBytes: null,
            memoryPeakBytes: null,
            memoryLimitBytes: null,
            memoryFailures: null,
            pids: null,
          };
          if (state.Running === true) {
            try {
              const sample = object(
                await json(`/containers/${selectedContainer.id}/stats?stream=false&one-shot=true`),
              );
              const memory = object(sample.memory_stats);
              stats.state = 'available';
              stats.observedAt = time(sample.read);
              stats.memoryUsageBytes = numeric(memory.usage);
              stats.memoryPeakBytes = numeric(memory.max_usage);
              stats.memoryLimitBytes = numeric(memory.limit);
              stats.memoryFailures = numeric(memory.failcnt);
              stats.pids = numeric(object(sample.pids_stats).current);
            } catch {
              stats.state = 'failed';
            }
          }
          const logs: z.infer<typeof containerSchema>['logs'] = {
            state: 'unavailable',
            truncated: false,
            records: [],
          };
          // Project output can contain transcripts. Technical infrastructure logs are classified only.
          if (selectedContainer.role !== 'project') {
            try {
              const query = new URLSearchParams({
                stdout: '1',
                stderr: '1',
                timestamps: '1',
                tail: '200',
                since: String(Date.parse(window.since) / 1000),
                until: String(Date.parse(window.until) / 1000),
              });
              const output = await readDocker(
                `/containers/${selectedContainer.id}/logs?${query.toString()}`,
              );
              const source =
                selectedContainer.role === 'updater'
                  ? 'updater'
                  : selectedContainer.role === 'runner'
                    ? 'runner'
                    : selectedContainer.role === 'server'
                      ? 'server'
                      : 'runtime';
              Object.assign(logs, logRecords(output.bytes, selectedContainer.id, source, window), {
                state: 'available',
              });
              logs.truncated ||= output.truncated;
            } catch {
              logs.state = 'failed';
            }
          }
          const runtime = z.enum(['runsc', 'runsc-project', 'runc']).safeParse(config.Runtime);
          const status = containerSchema.shape.state.safeParse(state.Status);
          const health = containerSchema.shape.health.safeParse(object(state.Health).Status);
          docker.containers.push({
            ...selectedContainer,
            state: status.success ? status.data : 'unknown',
            imageId: /^sha256:[a-f0-9]{64}$/u.test(String(value.Image))
              ? String(value.Image)
              : null,
            runtime: runtime.success ? runtime.data : config.Runtime ? 'other' : 'unknown',
            startedAt: time(state.StartedAt),
            finishedAt: time(state.FinishedAt),
            exitCode: Number.isInteger(state.ExitCode) ? Number(state.ExitCode) : null,
            oomKilled: typeof state.OOMKilled === 'boolean' ? state.OOMKilled : null,
            restartCount: numeric(value.RestartCount),
            memoryLimitBytes: numeric(config.Memory),
            memorySwapLimitBytes: signedNumeric(config.MemorySwap),
            nanoCpus: numeric(config.NanoCpus),
            pidsLimit: signedNumeric(config.PidsLimit),
            health: health.success ? health.data : state.Health === undefined ? 'none' : 'unknown',
            stats,
            logs,
          });
        } catch {
          docker.state = 'failed';
        }
      }
      const eventScopes = request.projectId ? [`verity.project-id=${request.projectId}`] : scopes;
      if (eventScopes.length > 0) {
        docker.events.state = 'available';
        for (const eventScope of eventScopes) {
          const eventLabels = [eventScope];
          try {
            const query = new URLSearchParams({
              since: String(Math.floor(Date.parse(window.since) / 1000)),
              until: String(Math.floor(Date.parse(window.until) / 1000)),
              filters: JSON.stringify({
                type: ['container'],
                label: eventLabels,
                event: [
                  'create',
                  'start',
                  'die',
                  'destroy',
                  'oom',
                  'kill',
                  'stop',
                  'restart',
                  'pause',
                  'unpause',
                  'health_status',
                ],
              }),
            });
            const output = await readDocker(`/events?${query.toString()}`);
            const lines = output.bytes.toString('utf8').trim().split('\n').filter(Boolean);
            const records: Evidence[] = [];
            for (const line of lines.slice(-256)) {
              const event = object(JSON.parse(line));
              if (event.Type !== 'container') continue;
              const actor = object(event.Actor);
              const attributes = object(actor.Attributes);
              const [label, expected] = eventLabels[0]!.split('=');
              if (attributes[label!] !== expected) continue;
              const rawCode =
                typeof event.Action === 'string' ? event.Action.split(':')[0] : event.status;
              const seconds = numeric(event.time);
              const id = containerId.safeParse(actor.ID ?? event.id);
              const code = runtimeEvidenceSchema.shape.code.safeParse(rawCode);
              if (seconds === null || !id.success || !code.success) continue;
              const at = new Date(seconds * 1000).toISOString();
              if (
                Date.parse(at) < Date.parse(window.since) ||
                Date.parse(at) > Date.parse(window.until)
              )
                continue;
              const exit =
                typeof attributes.exitCode === 'string' && /^-?\d+$/u.test(attributes.exitCode)
                  ? Number(attributes.exitCode)
                  : undefined;
              const signal =
                typeof attributes.signal === 'string' && /^\d+$/u.test(attributes.signal)
                  ? Number(attributes.signal)
                  : undefined;
              records.push({
                at,
                source: 'docker',
                code: code.data,
                containerId: id.data,
                ...(exit !== undefined ? { exitCode: exit } : {}),
                ...(signal !== undefined ? { signal } : {}),
              });
            }
            const combined = [...docker.events.records, ...records]
              .filter(
                (record, index, all) =>
                  all.findIndex(
                    (other) =>
                      other.at === record.at &&
                      other.containerId === record.containerId &&
                      other.code === record.code,
                  ) === index,
              )
              .sort((a, b) => a.at.localeCompare(b.at));
            docker.events.truncated ||=
              output.truncated || lines.length >= 256 || combined.length > 256;
            docker.events.records = combined.slice(-256);
          } catch {
            docker.events.state = 'failed';
          }
        }
      }
    }
    return runtimeDiagnosticSnapshotSchema.parse({
      observedAt: new Date(now).toISOString(),
      window,
      resources,
      docker,
      host,
      limitations: [
        'Memory, load and disk are current samples of the Server and its visible filesystem; they do not establish a historical host peak.',
        'Cgroup counters describe the Server cgroup when visible; null means unavailable, not zero. CPU availability is not a CPU quota.',
        'Docker retains only a bounded recent event history and may lose it on daemon restart. Missing events do not prove no failure occurred.',
        'At most 12 containers, 256 Docker events and 200 log lines per infrastructure container are inspected; project transcripts are excluded.',
        'Host records depend on the installed journal exporter, journal retention and source coverage. Stale or unavailable evidence cannot exclude OOM or runtime failure.',
        'Classified log records are evidence, not a root-cause verdict. Exit code 137 alone does not establish an OOM kill.',
      ],
    });
  };
}
