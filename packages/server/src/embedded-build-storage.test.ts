import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmbeddedBuildStorage,
  installEmbeddedBuildStorage,
} from './embedded-build-storage.js';
import { startNativeRetirementEvidence } from './native-buildkit.js';
import { createProtectedBuildClient } from './project-egress-build-client.js';
import { devcontainerBuilderIdle } from './provisioner.js';

const command = vi.hoisted(() => vi.fn(async () => ({ version: 1 as const, idle: true })));
vi.mock('./native-buildkit.js', () => ({
  startNativeRetirementEvidence: vi.fn(() => ({ stop: vi.fn(), tick: vi.fn() })),
}));
vi.mock('./project-egress-build-client.js', () => ({
  createProtectedBuildClient: vi.fn(() => command),
}));
vi.mock('./provisioner.js', () => ({ devcontainerBuilderIdle: vi.fn(async () => true) }));

type Context = Parameters<typeof installEmbeddedBuildStorage>[1];
type Reconcile = NonNullable<Context['buildStorage']>['reconcile'];
const apps: FastifyInstance[] = [];
const roots: string[] = [];
function app() {
  const instance = Fastify();
  apps.push(instance);
  return instance;
}
function context() {
  return {
    config: {} as Context['config'],
    buildStorage: {
      setReleaseListener: vi.fn<NonNullable<Context['buildStorage']>['setReleaseListener']>(),
      reconcile: vi.fn<Reconcile>(async () => []),
    },
    provisioner: { resetStorageRefusedRepairBackoff: vi.fn() },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('embedded build storage bootstrap', () => {
  it.each([
    [{ dataVolumeRoot: '/volume', dataDir: '/data', workspacesDir: '/workspaces' }, '/volume'],
    [{ dataDir: '/data', workspacesDir: '/workspaces' }, '/data'],
    [{ workspacesDir: '/workspaces' }, '/workspaces'],
    [{}, join(tmpdir(), 'verity')],
  ] as const)('chooses the durable root for %j', (config, root) => {
    const runtime = createEmbeddedBuildStorage(config);
    expect(runtime.buildStorage.root).toBe(join(root, 'build-storage'));
    const inventory = vi.mocked(startNativeRetirementEvidence).mock.calls[0]![0];
    const empty = vi.spyOn(runtime.buildStorage, 'retirementInventoryEmpty').mockReturnValue(false);
    expect(inventory()).toBe(false);
    empty.mockReturnValue(true);
    expect(inventory()).toBe(true);
    runtime.stopNativeEvidence();
    expect(
      vi.mocked(startNativeRetirementEvidence).mock.results[0]!.value.stop,
    ).toHaveBeenCalledOnce();
  });
});

describe('embedded build storage reconciliation', () => {
  it('does nothing without build storage', () => {
    installEmbeddedBuildStorage(app(), { ...context(), buildStorage: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts immediately, prevents overlap, resets repair backoff and cancels future passes on close', async () => {
    const ctx = context();
    let release!: () => void;
    ctx.buildStorage.reconcile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const instance = app();
    installEmbeddedBuildStorage(instance, ctx);
    expect(ctx.buildStorage.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ctx.buildStorage.reconcile).toHaveBeenCalledOnce();
    const listener = ctx.buildStorage.setReleaseListener.mock.calls[0]![0];
    listener();
    expect(ctx.provisioner.resetStorageRefusedRepairBackoff).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ctx.buildStorage.reconcile).toHaveBeenCalledTimes(2);
    await instance.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ctx.buildStorage.reconcile).toHaveBeenCalledTimes(2);
  });

  it('keeps close nonblocking while an already started pass finishes', async () => {
    const ctx = context();
    let release!: () => void;
    ctx.buildStorage.reconcile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const instance = app();
    installEmbeddedBuildStorage(instance, ctx);
    await instance.close();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('warns about unresolved attempts and retries after probe failure', async () => {
    const ctx = context();
    const error = new Error('host offline');
    const attempts = [
      { attempt: 'old-build', operation: 'local' as const, reservedBytes: 1, reason: 'unknown' },
    ];
    ctx.buildStorage.reconcile.mockRejectedValueOnce(error).mockResolvedValueOnce(attempts);
    const instance = app();
    const warn = vi.spyOn(instance.log, 'warn');
    installEmbeddedBuildStorage(instance, ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith({ err: error }, 'Build storage reconciliation failed');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(warn).toHaveBeenCalledWith(
      { attempts },
      'Build storage holds space for earlier build attempts whose end is not yet confirmed',
    );
  });

  it('normalizes the Docker socket for the BuildKit idle probe', async () => {
    const ctx = context();
    ctx.config.dockerBaseUrl = 'unix:///var/run/docker.sock:/v1.41';
    installEmbeddedBuildStorage(app(), ctx);
    const probes = ctx.buildStorage.reconcile.mock.calls[0]![0]!;
    await expect(probes.buildkitIdle?.()).resolves.toBe(true);
    expect(devcontainerBuilderIdle).toHaveBeenCalledWith('unix:///var/run/docker.sock');
  });

  it('reads rotated credentials for both protected-build probes and forwards attempt identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'build-wiring-'));
    roots.push(root);
    const key = join(root, 'key');
    writeFileSync(key, ' first-key\n');
    const ctx = context();
    ctx.config = { projectEgressSocketPath: '/host/control.sock', projectEgressKeyPath: key };
    installEmbeddedBuildStorage(app(), ctx);
    const probes = ctx.buildStorage.reconcile.mock.calls[0]![0]!;
    await probes.protectedBuildStatus?.({ projectId: 'project', attemptId: 'attempt' });
    expect(command).toHaveBeenLastCalledWith({
      operation: 'status',
      projectId: 'project',
      attemptId: 'attempt',
    });
    const options = vi.mocked(createProtectedBuildClient).mock.calls[0]![0];
    expect(options.socketPath).toBe('/host/control.sock');
    expect(options.token()).toBe('first-key');
    writeFileSync(key, ' rotated-key\n');
    expect(options.token()).toBe('rotated-key');
    await probes.protectedBuildSlot?.();
    expect(command).toHaveBeenLastCalledWith({ operation: 'slot' });
    expect(vi.mocked(createProtectedBuildClient).mock.calls[1]![0].token()).toBe('rotated-key');
  });

  it.each([
    { projectEgressSocketPath: '/host/control.sock' },
    { projectEgressKeyPath: '/host/key' },
    {},
  ])('omits protected probes for incomplete config %j', (config) => {
    const ctx = context();
    ctx.config = config;
    installEmbeddedBuildStorage(app(), ctx);
    expect(ctx.buildStorage.reconcile).toHaveBeenCalledWith({});
  });
});
