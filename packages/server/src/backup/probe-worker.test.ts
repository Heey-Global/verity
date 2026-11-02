import { expect, it, vi } from 'vitest';
import type { BackupManifest } from './format.js';
import { runPinnedProbeMigration } from './probe-worker.js';

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
  return {
    manifest,
    architecture: 'amd64' as const,
    databaseUrl: 'postgres://probe:example@probe/verity_probe_' + 'a'.repeat(32),
    network: 'probe-network',
    docker: {
      createContainer: vi.fn(async () => ({ id: 'worker', warnings: [] })),
      startContainer: vi.fn(async () => undefined),
      waitContainer: vi.fn(async () => 0),
      removeContainer: vi.fn(async () => undefined),
    },
  };
}
it('uses the snapshot digest, native platform and dedicated command without live mounts', async () => {
  const options = fixture();
  await runPinnedProbeMigration(options);
  expect(options.docker.createContainer).toHaveBeenCalledWith(
    expect.objectContaining({
      image: options.manifest.capture!.image,
      platform: 'linux/amd64',
      command: ['backup-probe-migrate'],
      readOnlyRootfs: true,
      restartPolicy: 'no',
      env: [
        `VERITY_BACKUP_PROBE_DATABASE_URL=${options.databaseUrl}`,
        `VERITY_BACKUP_PROBE_SCHEMA=${options.manifest.schema}`,
      ],
    }),
  );
  const spec = options.docker.createContainer.mock.calls[0] as unknown as [Record<string, unknown>];
  expect(spec[0]['binds']).toBeUndefined();
  expect(spec[0]['volumeMounts']).toBeUndefined();
  expect(options.docker.removeContainer).toHaveBeenCalledExactlyOnceWith('worker');
});
it('rejects foreign architecture and floating images before creating a worker', async () => {
  const options = fixture();
  await expect(runPinnedProbeMigration({ ...options, architecture: 'arm64' })).rejects.toThrow(
    'native image',
  );
  options.manifest.capture!.image = 'ghcr.io/heey-global/verity/verity-server:latest';
  await expect(runPinnedProbeMigration(options)).rejects.toThrow();
  expect(options.docker.createContainer).not.toHaveBeenCalled();
});
it('removes failed and timed-out workers without exposing their environment or logs', async () => {
  const options = fixture();
  options.docker.waitContainer.mockResolvedValueOnce(1);
  await expect(runPinnedProbeMigration(options)).rejects.toThrow('migration failed');
  options.docker.waitContainer.mockImplementationOnce(() => new Promise(() => {}));
  await expect(runPinnedProbeMigration({ ...options, timeoutMs: 10 })).rejects.toThrow('timed out');
  expect(options.docker.removeContainer).toHaveBeenCalledTimes(2);
});
it('honors shutdown before allocation and while waiting', async () => {
  const options = fixture();
  const signal = AbortSignal.abort();
  await expect(runPinnedProbeMigration({ ...options, signal })).rejects.toThrow();
  expect(options.docker.createContainer).not.toHaveBeenCalled();
  const controller = new AbortController();
  options.docker.waitContainer.mockImplementationOnce(async () => {
    controller.abort();
    return 0;
  });
  await expect(runPinnedProbeMigration({ ...options, signal: controller.signal })).rejects.toThrow(
    'aborted',
  );
  expect(options.docker.removeContainer).toHaveBeenCalledOnce();
});
