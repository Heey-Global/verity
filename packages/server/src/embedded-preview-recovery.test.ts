import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import {
  installEmbeddedLocalPreviewRecovery,
  installEmbeddedPublicPreviewRecovery,
} from './embedded-preview-recovery.js';
import { sweepOrphanedLocalPreviews } from './local-preview-orphans.js';
import { sweepOrphanedPreviewShares } from './preview-share-manager.js';

vi.mock('./local-preview-orphans.js', () => ({
  sweepOrphanedLocalPreviews: vi.fn(async () => undefined),
}));
vi.mock('./preview-share-manager.js', () => ({ sweepOrphanedPreviewShares: vi.fn(async () => 0) }));
type Local = Parameters<typeof installEmbeddedLocalPreviewRecovery>[1];
type Public = Parameters<typeof installEmbeddedPublicPreviewRecovery>[1];
const apps: FastifyInstance[] = [];
function app() {
  const instance = Fastify();
  apps.push(instance);
  return instance;
}
function local(): Local {
  return {
    projectDocker: {} as NonNullable<Local['projectDocker']>,
    secretCipher: { isSealed: () => false },
    localPreviewManager: {
      reconcile: vi.fn(async () => undefined),
      ownsConnector: vi.fn(() => true),
      close: vi.fn(async () => undefined),
    },
    managedDevServerManager: { close: vi.fn(async () => undefined) },
    setPreviewRecoveryReady: vi.fn(),
  };
}
function publicContext(): Public {
  return {
    projectDocker: {} as NonNullable<Public['projectDocker']>,
    secretCipher: { isSealed: () => false },
    eventStore: {} as Public['eventStore'],
    managedLinkEnded: {},
    previewShareManager: { reconcile: vi.fn(async () => undefined) },
    uplinkControl: { stop: vi.fn(async () => undefined) },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(sweepOrphanedLocalPreviews).mockResolvedValue();
  vi.mocked(sweepOrphanedPreviewShares).mockResolvedValue(0);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.useRealTimers();
});

describe('local preview recovery', () => {
  it('adopts ownership before readiness and cleanup, then retries every ten seconds', async () => {
    const ctx = local();
    const order: string[] = [];
    const reconcile = vi.fn(async () => {
      order.push('adopt');
    });
    ctx.localPreviewManager!.reconcile = reconcile;
    ctx.setPreviewRecoveryReady = () => {
      order.push('ready');
    };
    vi.mocked(sweepOrphanedLocalPreviews).mockImplementation(async (_docker, owner, owns) => {
      order.push('sweep');
      expect(owner).toBe(hostname());
      expect(owns('container', 'share')).toBe(true);
    });
    await installEmbeddedLocalPreviewRecovery(app(), ctx);
    expect(order).toEqual(['adopt', 'ready', 'sweep']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
  it('waits for unlock and leaves readiness closed after failed adoption', async () => {
    const ctx = local();
    let sealed = true;
    ctx.secretCipher.isSealed = () => sealed;
    const reconcile = vi.fn(async () => {
      throw new Error('offline');
    });
    ctx.localPreviewManager!.reconcile = reconcile;
    await installEmbeddedLocalPreviewRecovery(app(), ctx);
    expect(reconcile).not.toHaveBeenCalled();
    sealed = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(ctx.setPreviewRecoveryReady).not.toHaveBeenCalled();
    expect(sweepOrphanedLocalPreviews).not.toHaveBeenCalled();
  });
  it('revokes readiness and drains an active recovery before closing managers', async () => {
    const ctx = local();
    const instance = app();
    const order: string[] = [];
    const readiness = vi.fn();
    ctx.setPreviewRecoveryReady = readiness;
    await installEmbeddedLocalPreviewRecovery(instance, ctx);
    let release!: () => void;
    ctx.localPreviewManager!.reconcile = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const managedClose = vi.fn(async () => {
      order.push('managed');
    });
    const localClose = vi.fn(async () => {
      order.push('local');
    });
    ctx.managedDevServerManager!.close = managedClose;
    ctx.localPreviewManager!.close = localClose;
    await vi.advanceTimersByTimeAsync(10_000);
    const closing = instance.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(readiness).toHaveBeenLastCalledWith(false);
    expect(managedClose).not.toHaveBeenCalled();
    release();
    await closing;
    expect(order).toEqual(['managed', 'local']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(localClose).toHaveBeenCalledOnce();
  });
});

describe('public preview recovery', () => {
  it('waits for unlock, retries adoption, and drains the watchdog before stopping Uplink', async () => {
    const ctx = publicContext();
    const instance = app();
    let sealed = true;
    ctx.secretCipher.isSealed = () => sealed;
    const reconcile = vi.fn(async () => undefined);
    ctx.previewShareManager!.reconcile = reconcile;
    await installEmbeddedPublicPreviewRecovery(instance, ctx);
    expect(reconcile).not.toHaveBeenCalled();
    sealed = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledOnce();
    let release!: () => void;
    ctx.previewShareManager!.reconcile = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const stop = vi.fn(async () => undefined);
    ctx.uplinkControl!.stop = stop;
    await vi.advanceTimersByTimeAsync(30_000);
    const closing = instance.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).not.toHaveBeenCalled();
    release();
    await closing;
    expect(stop).toHaveBeenCalledOnce();
    expect(sweepOrphanedPreviewShares).not.toHaveBeenCalled();
  });
  it('retries orphan cleanup after failure, uses the current link callback and stops after success', async () => {
    const ctx = publicContext();
    ctx.previewShareManager = undefined;
    vi.mocked(sweepOrphanedPreviewShares)
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async ({ onShareEnded }) => {
        onShareEnded?.({ managedInstanceId: 'instance', id: 'share' });
        return 1;
      });
    await installEmbeddedPublicPreviewRecovery(app(), ctx);
    await vi.advanceTimersByTimeAsync(0);
    const ended = vi.fn();
    ctx.managedLinkEnded.current = ended;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ended).toHaveBeenCalledWith('instance', 'share');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweepOrphanedPreviewShares).toHaveBeenCalledTimes(2);
  });
  it('does not overlap orphan sweeps and cancels retries on close', async () => {
    const ctx = publicContext();
    ctx.previewShareManager = undefined;
    let release!: () => void;
    vi.mocked(sweepOrphanedPreviewShares).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(0);
        }),
    );
    const instance = app();
    await installEmbeddedPublicPreviewRecovery(instance, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweepOrphanedPreviewShares).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await instance.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweepOrphanedPreviewShares).toHaveBeenCalledOnce();
  });
  it('creates no recovery timers when Docker and managers are absent', async () => {
    const ctx = publicContext();
    ctx.projectDocker = undefined;
    ctx.previewShareManager = undefined;
    await installEmbeddedPublicPreviewRecovery(app(), ctx);
    const localCtx = local();
    localCtx.projectDocker = undefined;
    await installEmbeddedLocalPreviewRecovery(app(), localCtx);
    expect(vi.getTimerCount()).toBe(0);
  });
});
