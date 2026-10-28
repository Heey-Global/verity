import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openBackupRuntime, type BackupRuntimeOptions } from './runtime.js';
const pools = vi.hoisted(
  () => [] as { options: Record<string, unknown>; end: ReturnType<typeof vi.fn> }[],
);
vi.mock('pg', () => ({
  default: {
    Pool: class {
      readonly end = vi.fn(async () => undefined);
      constructor(readonly options: Record<string, unknown>) {
        pools.push(this);
      }
      on(): this {
        return this;
      }
      connect(): never {
        throw new Error('Opening runtime must not capture before server readiness');
      }
    },
  },
}));

it('allocates nothing before acceptance and owns only a single read-only backup pool after capability checks', async () => {
  pools.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'backup-runtime-'));
  const paths = {
    pairing: join(root, 'pairing'),
    destination: join(root, 'destination'),
    identityRequests: join(root, 'requests'),
  };
  const currentImage = vi.fn(
    async () => `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  );
  const onError = vi.fn();
  const options: BackupRuntimeOptions = {
    recoveryAccepted: false,
    root,
    paths,
    databaseUrl: 'postgres://admin:privileged@postgres/verity?sslmode=require&options=unsafe',
    currentImage,
    architecture: 'amd64',
    release: 'test',
    schema: 'test-schema',
    onError,
    store: {
      setBackupJournaling: vi.fn(async () => undefined),
      subscribeBackupRevocations: () => () => undefined,
      listBackupRevocations: vi.fn(async () => []),
      acknowledgeBackupRevocation: vi.fn(async () => undefined),
      backupGitRepositoryKey: vi.fn(async () => randomUUID()),
    },
  };
  try {
    expect((await openBackupRuntime(options)).service).toBeUndefined();
    expect(currentImage).not.toHaveBeenCalled();
    expect(pools).toHaveLength(0);
    expect(
      (await openBackupRuntime({ ...options, recoveryAccepted: true })).unavailableReason,
    ).toBe('installer-required');
    expect(currentImage).not.toHaveBeenCalled();
    for (const path of Object.values(paths)) await mkdir(path);
    await writeFile(join(paths.pairing, 'installation-id'), randomUUID());
    await writeFile(join(paths.pairing, 'backup-postgres-password'), 'b'.repeat(64));
    await writeFile(join(paths.destination, '.verity-backup-target'), randomUUID());
    const stillGated = await openBackupRuntime(options);
    try {
      expect(stillGated.service).toBeUndefined();
      expect(currentImage).not.toHaveBeenCalled();
      expect(pools).toHaveLength(0);
    } finally {
      await stillGated.close();
    }
    const runtime = await openBackupRuntime({ ...options, recoveryAccepted: true });
    try {
      expect(runtime.service).toBeDefined();
      expect(await runtime.service!.status()).toEqual({ configured: false, alerts: [] });
      expect(pools).toHaveLength(1);
      const pool = pools[0]!;
      expect(pool.options['max']).toBe(1);
      const url = new URL(String(pool.options['connectionString']));
      expect(url.username).toBe('verity_backup');
      expect(url.password).toBe('b'.repeat(64));
      expect(url.searchParams.get('sslmode')).toBe('require');
      expect(url.searchParams.has('options')).toBe(false);
      await runtime.close();
      await runtime.close();
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
    const invalid = await openBackupRuntime({
      ...options,
      recoveryAccepted: true,
      currentImage: async () => 'ghcr.io/heey-global/verity/verity-server:latest',
    });
    expect(invalid.unavailableReason).toBe('runtime-unavailable');
    expect(onError).toHaveBeenCalledOnce();
    expect(pools).toHaveLength(1);
    await mkdir(join(root, 'backup-state'));
    await writeFile(join(root, 'backup-state/state'), '{invalid-state');
    const damaged = await openBackupRuntime({ ...options, recoveryAccepted: true });
    expect(damaged.unavailableReason).toBe('runtime-unavailable');
    expect(pools).toHaveLength(2);
    expect(pools[1]!.end).toHaveBeenCalledOnce();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
