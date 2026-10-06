import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  classifyRuntimeLog,
  createDiagnosticDockerRead,
  createRuntimeDiagnostics,
  hostDiagnosticSnapshotSchema,
  resolveRuntimeWindow,
} from './runtime-diagnostics.js';

const now = Date.parse('2026-10-06T18:15:00Z');
const id = 'a'.repeat(64);
const projectId = 'b'.repeat(64);
const image = `sha256:${'c'.repeat(64)}`;
const hostSnapshot = {
  schemaVersion: 1,
  observedAt: '2026-10-06T18:14:00Z',
  since: '2026-10-05T18:14:00Z',
  until: '2026-10-06T18:14:00Z',
  sources: { kernel: 'available', runtime: 'available' },
  truncated: false,
  records: [
    {
      at: '2026-10-06T18:09:11Z',
      source: 'runtime',
      code: 'runtime_disconnect',
      containerId: projectId,
    },
  ],
};
function fixture() {
  const readDocker = vi.fn(async (path: string) => {
    let value: unknown;
    if (path === '/version') value = { Version: '28.0.1', secret: 'credential' };
    else if (path.startsWith('/containers/json'))
      value = [
        {
          Id: id,
          Labels: {
            'com.docker.compose.project': 'verity',
            'com.docker.compose.service': 'verity',
          },
        },
        {
          Id: 'd'.repeat(64),
          Labels: {
            'com.docker.compose.project': 'unrelated',
            'com.docker.compose.service': 'verity',
          },
        },
      ];
    else if (path.includes('/stats?'))
      value = {
        read: '2026-10-06T18:14:00Z',
        memory_stats: { usage: 2400, max_usage: 5000, limit: 6000, failcnt: 0 },
        pids_stats: { current: 10 },
        secret: 'credential',
      };
    else if (path.includes('/logs?'))
      return {
        bytes: Buffer.from(
          '2026-10-06T18:09:11Z runner reconciliation failed credential\n2026-10-06T18:09:12Z private normal message\n',
        ),
        truncated: false,
      };
    else if (path.startsWith('/events?'))
      return {
        bytes: Buffer.from(
          JSON.stringify({
            Type: 'container',
            Action: 'die',
            time: Date.parse('2026-10-06T18:09:11Z') / 1000,
            Actor: {
              ID: projectId,
              Attributes: {
                'verity.project-id': 'project',
                exitCode: '137',
                credential: 'credential',
              },
            },
          }) + '\n',
        ),
        truncated: false,
      };
    else {
      const isProject = path.includes('project-container') || path.includes(projectId);
      value = {
        Id: isProject ? projectId : id,
        Image: image,
        Config: {
          Labels: isProject
            ? { 'verity.project-id': 'project' }
            : { 'com.docker.compose.project': 'verity' },
          Env: ['TOKEN=credential'],
        },
        State: {
          Running: true,
          Status: 'running',
          StartedAt: '2026-10-06T18:09:12Z',
          FinishedAt: '0001-01-01T00:00:00Z',
          OOMKilled: false,
          ExitCode: 0,
        },
        HostConfig: {
          Runtime: 'runsc-project',
          Memory: 6000,
          MemorySwap: 6000,
          NanoCpus: 1e9,
          PidsLimit: 512,
        },
        RestartCount: 0,
      };
    }
    return { bytes: Buffer.from(JSON.stringify(value)), truncated: false };
  });
  return {
    readDocker,
    serverContainerId: id,
    now: () => now,
    readHostSnapshot: async () => JSON.stringify(hostSnapshot),
  };
}
describe('runtime diagnostics', () => {
  it('correlates scoped lifecycle, memory and technical errors without exposing raw source data', async () => {
    const deps = fixture();
    const result = await createRuntimeDiagnostics(deps)({
      projectId: 'project',
      containerName: 'project-container',
    });
    expect(result.docker.containers.map((container) => container.role)).toEqual([
      'project',
      'server',
    ]);
    expect(result.docker.containers[0]).toMatchObject({
      imageId: image,
      oomKilled: false,
      finishedAt: null,
      memoryLimitBytes: 6000,
      stats: { memoryUsageBytes: 2400, memoryPeakBytes: 5000 },
      logs: { state: 'unavailable' },
    });
    expect(result.docker.containers[1]?.logs.records[0]?.code).toBe('runner_reconcile_failed');
    expect(result.docker.events.records[0]).toMatchObject({
      code: 'die',
      exitCode: 137,
      containerId: projectId,
    });
    expect(result.host.snapshot?.records[0]?.code).toBe('runtime_disconnect');
    expect(JSON.stringify(result)).not.toMatch(
      /credential|private normal message|TOKEN|unrelated/u,
    );
    const paths = deps.readDocker.mock.calls.map(([path]) => path);
    expect(paths.some((path) => path.includes(`${projectId}/logs`))).toBe(false);
    expect(paths.find((path) => path.startsWith('/events?'))).toContain('until=');
    expect(decodeURIComponent(paths.find((path) => path.startsWith('/events?'))!)).toContain(
      'verity.project-id=project',
    );
  });
  it.each([true, false])(
    'verifies managed Compose companions through the attached network (%s)',
    async (verified) => {
      const compose = parse(await readFile('deploy/docker-compose.yml', 'utf8')) as {
        services: Record<string, unknown>;
        networks: { default: { name: string } };
      };
      const services = [
        'verity-updater',
        'verity-agent-gateway',
        'verity-managed-gateway',
        'postgres',
      ];
      for (const service of services) expect(compose.services).toHaveProperty(service);
      const companions = services.map((service, index) => ({
        Id: String(index + 1).repeat(64),
        Labels: { 'com.docker.compose.project': 'stack', 'com.docker.compose.service': service },
      }));
      const server = {
        Id: id,
        Labels: { 'verity.managed-deployment-id': 'deployment', 'verity.managed-role': 'server' },
      };
      const networkId = 'e'.repeat(64);
      const base = fixture();
      const readDocker = vi.fn(async (path: string) => {
        const response = (value: unknown) => ({
          bytes: Buffer.from(JSON.stringify(value)),
          truncated: false,
        });
        if (path.startsWith('/networks/'))
          return response({
            Id: verified ? networkId : 'f'.repeat(64),
            Name: compose.networks.default.name,
            Labels: {
              'com.docker.compose.project': 'stack',
              'com.docker.compose.network': 'default',
            },
          });
        if (path.startsWith('/containers/json'))
          return response(
            decodeURIComponent(path).includes('verity.managed-deployment-id=')
              ? [server]
              : [
                  ...companions,
                  {
                    Id: 'f'.repeat(64),
                    Labels: {
                      'com.docker.compose.project': 'unrelated',
                      'com.docker.compose.service': 'postgres',
                    },
                  },
                ],
          );
        if (path.startsWith('/events?')) {
          const scoped = decodeURIComponent(path).includes('com.docker.compose.project=');
          return {
            bytes: Buffer.from(
              JSON.stringify({
                Type: 'container',
                Action: 'die',
                time: now / 1000,
                Actor: {
                  ID: scoped ? companions[0]!.Id : id,
                  Attributes: scoped ? companions[0]!.Labels : server.Labels,
                },
              }) + '\n',
            ),
            truncated: false,
          };
        }
        if (path.endsWith('/json')) {
          const original = await base.readDocker(path);
          const value = JSON.parse(original.bytes.toString()) as Record<string, unknown>;
          const target = [server, ...companions].find((entry) => path.includes(entry.Id))!;
          return response({
            ...value,
            Id: target.Id,
            Config: { Labels: target.Labels },
            ...(target.Id === id
              ? {
                  NetworkSettings: {
                    Networks: { [compose.networks.default.name]: { NetworkID: networkId } },
                  },
                }
              : {}),
          });
        }
        return base.readDocker(path);
      });
      const result = await createRuntimeDiagnostics({ ...base, readDocker })({});
      expect(result.docker.containers.map((container) => container.role)).toEqual(
        verified ? ['server', 'updater', 'gateway', 'gateway', 'database'] : ['server'],
      );
      expect(result.docker.events.records.map((record) => record.containerId)).toEqual(
        verified ? [id, companions[0]!.Id] : [id],
      );
      expect(
        result.docker.containers.every(
          (container) =>
            container.stats.state === 'available' && container.logs.state === 'available',
        ),
      ).toBe(true);
      expect(
        readDocker.mock.calls.some(([path]) =>
          decodeURIComponent(path).includes('com.docker.compose.project=stack'),
        ),
      ).toBe(verified);
    },
  );
  it('does not enumerate an unrelated host fleet when deployment identity is unavailable', async () => {
    const deps = fixture();
    const result = await createRuntimeDiagnostics({ readDocker: deps.readDocker, now: deps.now })(
      {},
    );
    expect(result.docker.containers).toEqual([]);
    expect(result.docker.events.state).toBe('unavailable');
    expect(deps.readDocker.mock.calls.map(([path]) => path)).toEqual(['/version']);
  });
  it('does not let a failed Docker version probe hide the remaining container evidence', async () => {
    const deps = fixture();
    const readDocker = async (path: string) => {
      if (path === '/version') throw new Error('version endpoint unavailable');
      return deps.readDocker(path);
    };
    const result = await createRuntimeDiagnostics({ ...deps, readDocker })({});
    expect(result.docker.state).toBe('failed');
    expect(result.docker.containers[0]?.role).toBe('server');
  });

  it('keeps unavailable and failed evidence distinct and never fabricates an OOM verdict', async () => {
    const result = await createRuntimeDiagnostics({ now: () => now })({});
    expect(result.docker.state).toBe('unavailable');
    expect(result.host.state).toBe('unavailable');
    expect(result.resources.rssBytes).toBeGreaterThan(0);
    const failed = await createRuntimeDiagnostics({
      now: () => now,
      readDocker: async () => {
        throw new Error('credential');
      },
      readHostSnapshot: async () => 'malformed credential',
    })({});
    expect(failed.docker.state).toBe('failed');
    expect(failed.host.state).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('credential');
  });
  it('reports stale host evidence and filters historical records to the requested interval', async () => {
    const deps = fixture();
    const result = await createRuntimeDiagnostics({ ...deps, now: () => now + 10 * 60_000 })({
      window: { since: '2026-10-06T18:10:00Z', until: '2026-10-06T18:15:00Z' },
    });
    expect(result.host.stale).toBe(true);
    expect(result.host.snapshot?.records).toEqual([]);
    expect(result.docker.events.records).toEqual([]);
  });
  it('rejects unsafe query windows before reading data', async () => {
    const deps = fixture();
    const read = createRuntimeDiagnostics(deps);
    await expect(read({ window: { since: '2026-10-01T00:00:00Z' } })).rejects.toThrow('24 hours');
    await expect(read({ window: { until: '2027-01-01T00:00:00Z' } })).rejects.toThrow('future');
    await expect(read({ window: { since: '2026-10-06T18:15:00Z' } })).rejects.toThrow('ordered');
    expect(deps.readDocker).not.toHaveBeenCalled();
    expect(resolveRuntimeWindow({}, now)).toEqual({
      since: '2026-10-06T17:15:00.000Z',
      until: '2026-10-06T18:15:00.000Z',
    });
  });
  it('classifies the observed disconnect while treating unrecognized messages as absent evidence', () => {
    expect(classifyRuntimeLog('containerManager.WaitPID failed: EOF')).toBe('runtime_disconnect');
    expect(classifyRuntimeLog('Killed process 123 (node)')).toBe('oom_kill');
    expect(classifyRuntimeLog('container exited with 137')).toBeUndefined();
    expect(classifyRuntimeLog('sandbox image update completed')).toBe('update_completed');
    expect(classifyRuntimeLog('node segfault at 0')).toBe('kernel_fault');
    expect(classifyRuntimeLog('write failed: no space left on device')).toBe('disk_pressure');
    expect(classifyRuntimeLog('Daemon has completed initialization')).toBe('runtime_started');
    expect(classifyRuntimeLog('new unfamiliar operation failed')).toBe('runtime_error');
  });
  it('projects exported host metadata and rejects oversized snapshots', () => {
    const parsed = hostDiagnosticSnapshotSchema.parse({
      ...hostSnapshot,
      token: 'credential',
      records: hostSnapshot.records.map((record) => ({ ...record, message: 'credential' })),
    });
    expect(JSON.stringify(parsed)).not.toContain('credential');
    expect(
      hostDiagnosticSnapshotSchema.safeParse({
        ...hostSnapshot,
        records: Array(401).fill(hostSnapshot.records[0]),
      }).success,
    ).toBe(false);
  });
  it('reads a bounded host snapshot file and distinguishes an absent file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'verity-diagnostics-'));
    try {
      const path = join(directory, 'snapshot.json');
      const read = createRuntimeDiagnostics({ hostSnapshotPath: path, now: () => now });
      expect((await read({})).host.state).toBe('unavailable');
      await writeFile(path, JSON.stringify(hostSnapshot));
      expect((await read({})).host.state).toBe('available');
      await writeFile(path, 'x'.repeat(512 * 1024 + 1));
      expect((await read({})).host.state).toBe('failed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('bounds Docker diagnostic bodies over the Unix transport and makes only GET requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-diagnostic-socket-'));
  const socket = join(directory, 'docker.sock');
  const server = createServer((request, response) => {
    expect(request.method).toBe('GET');
    if (request.url === '/v1.41/version') response.end('{"Version":"28.0.1"}');
    else response.end('x'.repeat(512 * 1024 + 1));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const read = createDiagnosticDockerRead(`unix://${socket}:/v1.41`);
    expect((await read('/version')).bytes.toString()).toContain('28.0.1');
    await expect(read('/events')).rejects.toThrow('exceeded limit');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
