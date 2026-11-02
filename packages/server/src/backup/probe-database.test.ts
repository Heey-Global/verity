import { beforeEach, expect, it, vi } from 'vitest';
import type { BackupManifest } from './format.js';
import { createProbeDatabase } from './probe-database.js';

const fake = vi.hoisted(() => ({
  migrate: vi.fn(),
  space: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  release: vi.fn(),
  pools: [] as Record<string, unknown>[],
  idle: undefined as ((error: Error) => void) | undefined,
}));
vi.mock('./probe-space.js', () => ({ checkProbeDatabaseSpace: fake.space }));
vi.mock('./probe-worker.js', () => ({ runPinnedProbeMigration: fake.migrate }));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: Record<string, unknown>) {
        fake.pools.push(options);
      }
      query = fake.query;
      connect = fake.connect;
      end = fake.end;
      on(_event: string, listener: (error: Error) => void) {
        fake.idle = listener;
        return this;
      }
    },
  },
}));
const postgresImage = `postgres:18-alpine@sha256:${'b'.repeat(64)}`;
beforeEach(() => {
  vi.resetAllMocks();
  fake.pools.length = 0;
  fake.idle = undefined;
  fake.query.mockResolvedValue({ rows: [] });
  fake.connect.mockResolvedValue({ release: fake.release });
});
function fixture() {
  const manifest: BackupManifest = {
    format: 1,
    repository: 'test',
    sequence: 1,
    capturedAt: '2026-10-01T00:00:00Z',
    release: '1',
    schema: '2026_schema',
    files: [],
    capture: {
      startedAt: '2026-10-01T00:00:00Z',
      finishedAt: '2026-10-01T00:01:00Z',
      databaseAt: '2026-10-01T00:00:00Z',
      barrierMs: 1,
      sourceRoot: '/original',
      architecture: 'amd64',
      image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
      scope: ['database', 'workspaces', 'sessions', 'knowledge', 'identity'],
      activeTurns: [],
      projects: [],
      exclusions: [],
      warnings: [],
      identity: [
        'deployment-id',
        'pairing-identity.pem',
        'tls-key.pem',
        'tls-cert.pem',
        'tls-ca-cert.pem',
      ],
      caKey: {
        installationId: '12345678-1234-4234-8234-123456789abc',
        keyGeneration: 1,
        path: 'identity/ca-key.age',
      },
      git: [],
    },
  };
  const options = {
    architecture: 'amd64' as const,
    network: 'private-network',
    checkSpace: vi.fn<(_bytes: bigint) => Promise<void>>(async () => undefined),
    docker: {
      inspectImageLabels: vi.fn(async () => ({ 'org.verity.postgres-image': postgresImage })),
      createContainer: vi.fn(async () => ({ id: 'postgres', warnings: [] })),
      startContainer: vi.fn(async () => undefined),
      waitContainer: vi.fn(async () => 0),
      removeContainer: vi.fn(async () => undefined),
    },
  };
  return { manifest, options };
}
it('uses a fresh cluster pinned by the snapshot image, migrates before import and tears everything down', async () => {
  const { manifest, options } = fixture();
  const run = vi.fn(async () => {
    expect(fake.migrate).toHaveBeenCalledOnce();
  });
  await createProbeDatabase(options)(manifest, 123n, run);
  expect(options.checkSpace).toHaveBeenCalledWith(123n + 256n * 1024n * 1024n);
  expect(options.docker.inspectImageLabels).toHaveBeenCalledWith(manifest.capture!.image);
  const spec = options.docker.createContainer.mock.calls[0] as unknown as [Record<string, unknown>];
  expect(spec[0]).toMatchObject({
    image: postgresImage,
    platform: 'linux/amd64',
    restartPolicy: 'no',
    network: options.network,
  });
  expect(spec[0]['binds']).toBeUndefined();
  expect(spec[0]['volumeMounts']).toBeUndefined();
  const migration = fake.migrate.mock.calls[0]![0] as { databaseUrl: string };
  const url = new URL(migration.databaseUrl);
  expect(url.pathname).toMatch(/^\/verity_probe_[a-f0-9]{32}$/);
  expect(url.password).toMatch(/^[a-f0-9]{64}$/);
  expect(fake.pools[0]).toMatchObject({ connectionString: migration.databaseUrl, max: 1 });
  expect(run).toHaveBeenCalledOnce();
  expect(fake.release).toHaveBeenCalledOnce();
  expect(fake.end).toHaveBeenCalledOnce();
  expect(options.docker.removeContainer).toHaveBeenCalledExactlyOnceWith('postgres');
});
it('refuses missing pins and insufficient Docker filesystem space before allocation', async () => {
  const { manifest, options } = fixture();
  options.docker.inspectImageLabels.mockResolvedValueOnce({ 'org.verity.postgres-image': '' });
  await expect(createProbeDatabase(options)(manifest, 0n, vi.fn())).rejects.toThrow(
    'PostgreSQL pin',
  );
  options.checkSpace.mockRejectedValueOnce(new Error('insufficient disk'));
  await expect(createProbeDatabase(options)(manifest, 0n, vi.fn())).rejects.toThrow(
    'insufficient disk',
  );
  expect(options.docker.createContainer).not.toHaveBeenCalled();
  expect(fake.pools).toHaveLength(0);
});
it('retains teardown when migration or import fails, and never imports after migration failure', async () => {
  const { manifest, options } = fixture();
  const run = vi.fn(async () => {
    throw new Error('import failed');
  });
  fake.migrate.mockRejectedValueOnce(new Error('migration failed'));
  await expect(createProbeDatabase(options)(manifest, 0n, run)).rejects.toThrow('migration failed');
  expect(run).not.toHaveBeenCalled();
  await expect(createProbeDatabase(options)(manifest, 0n, run)).rejects.toThrow('import failed');
  expect(fake.release).toHaveBeenCalledOnce();
  expect(fake.end).toHaveBeenCalledTimes(2);
  expect(options.docker.removeContainer).toHaveBeenCalledTimes(2);
});
it('removes an allocated cluster on failed startup and even if closing the pool fails', async () => {
  const { manifest, options } = fixture();
  options.docker.startContainer.mockRejectedValueOnce(new Error('start failed'));
  await expect(createProbeDatabase(options)(manifest, 0n, vi.fn())).rejects.toThrow('start failed');
  expect(fake.pools).toHaveLength(0);
  fake.end.mockRejectedValueOnce(new Error('pool close failed'));
  await expect(createProbeDatabase(options)(manifest, 0n, vi.fn())).rejects.toThrow(
    'pool close failed',
  );
  expect(options.docker.removeContainer).toHaveBeenCalledTimes(2);
});
it('aborts before allocation and during PostgreSQL startup without leaking resources', async () => {
  const { manifest, options } = fixture();
  await expect(
    createProbeDatabase({ ...options, signal: AbortSignal.abort() })(manifest, 0n, vi.fn()),
  ).rejects.toThrow();
  expect(options.docker.createContainer).not.toHaveBeenCalled();
  const controller = new AbortController();
  fake.query.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('not ready');
  });
  await expect(
    createProbeDatabase({ ...options, signal: controller.signal })(manifest, 0n, vi.fn()),
  ).rejects.toThrow();
  expect(fake.migrate).not.toHaveBeenCalled();
  expect(fake.end).toHaveBeenCalledOnce();
  expect(options.docker.removeContainer).toHaveBeenCalledOnce();
});

it('treats idle connection errors as probe failures and still closes all resources', async () => {
  const { manifest, options } = fixture();
  fake.migrate.mockImplementationOnce(async () => {
    fake.idle!(new Error('connection lost'));
  });
  const run = vi.fn();
  await expect(createProbeDatabase(options)(manifest, 0n, run)).rejects.toThrow(
    'connection failed',
  );
  expect(run).not.toHaveBeenCalled();
  expect(fake.end).toHaveBeenCalledOnce();
  expect(options.docker.removeContainer).toHaveBeenCalledOnce();
});
it('bounds PostgreSQL readiness retries and cleans up an unreachable cluster', async () => {
  vi.useFakeTimers();
  try {
    const { manifest, options } = fixture();
    fake.query.mockRejectedValue(new Error('not ready'));
    const result = expect(createProbeDatabase(options)(manifest, 0n, vi.fn())).rejects.toThrow(
      'did not become ready',
    );
    await vi.advanceTimersByTimeAsync(31000);
    await result;
    expect(fake.migrate).not.toHaveBeenCalled();
    expect(fake.end).toHaveBeenCalledOnce();
    expect(options.docker.removeContainer).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('uses the production Docker volume space check before creating a database by default', async () => {
  const { manifest, options } = fixture();
  const { checkSpace: customCheck, ...defaults } = options;
  const run = vi.fn();
  fake.space.mockRejectedValueOnce(new Error('insufficient disk'));
  await expect(createProbeDatabase(defaults)(manifest, 10n, run)).rejects.toThrow(
    'insufficient disk',
  );
  expect(options.docker.createContainer).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  await createProbeDatabase(defaults)(manifest, 10n, run);
  expect(fake.space).toHaveBeenCalledWith({
    docker: options.docker,
    image: postgresImage,
    architecture: options.architecture,
    requiredBytes: 10n + 256n * 1024n * 1024n,
  });
  expect(customCheck).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledOnce();
});

it('destroys the disposable connection on cancellation during import and releases it only once', async () => {
  const { manifest, options } = fixture();
  const controller = new AbortController();
  await expect(
    createProbeDatabase({ ...options, signal: controller.signal })(manifest, 0n, async () => {
      controller.abort();
    }),
  ).rejects.toThrow();
  expect(fake.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(fake.end).toHaveBeenCalledOnce();
  expect(options.docker.removeContainer).toHaveBeenCalledOnce();
});
