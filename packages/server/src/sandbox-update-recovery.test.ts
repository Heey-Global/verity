import type { EventStore } from '@verity/store';
import { expect, it, vi } from 'vitest';
import { createSandboxUpdateRecovery } from './sandbox-update-recovery.js';

function fixture() {
  let time = 0;
  const instance = {
    id: 'i',
    serverId: 'web',
    state: 'running',
    desired: 'running',
    detail: null as string | null,
  };
  let verified = true,
    localLive = true,
    publicLive = true;
  const store = {
    managedDevServers: {
      listInstances: async () => [instance],
      getInstance: async () => instance,
      get: async () => ({ name: 'web' }),
    },
    listPublicPreviewShares: async () => [{ id: 'public' }],
    getPublicPreviewShare: async () => ({ id: 'public' }),
  } as unknown as EventStore;
  const wait = vi.fn(async (ms: number) => {
    time += ms;
  });
  const capture = createSandboxUpdateRecovery({
    store,
    now: () => time,
    wait,
    timeoutMs: 10,
    pollMs: 5,
    devServers: () => ({ tick: async () => {}, hasVerifiedInstance: () => verified }) as never,
    local: () =>
      ({
        reconcile: async () => {},
        liveProjectShares: () => (localLive ? [{ id: 'local' }] : []),
      }) as never,
    public: () => ({ reconcile: async () => {}, isOnline: async () => publicLive }) as never,
  }).capture;
  return {
    instance,
    capture,
    wait,
    setVerified: (value: boolean) => {
      verified = value;
    },
    setLocal: (value: boolean) => {
      localLive = value;
    },
    setPublic: (value: boolean) => {
      publicLive = value;
    },
  };
}

it('reports success when all captured identities recover', async () => {
  const f = fixture();
  const check = await f.capture('p');
  f.setVerified(false);
  f.setLocal(false);
  f.setPublic(false);
  f.wait.mockImplementationOnce(async () => {
    f.setVerified(true);
    f.setLocal(true);
    f.setPublic(true);
  });
  expect(await check()).toEqual({
    state: 'ready',
    detail: 'Update applied; all services recovered',
  });
});
it('times out with the concrete dev server failure and offline shares', async () => {
  const f = fixture();
  const check = await f.capture('p');
  f.instance.state = 'crashed';
  f.instance.detail = 'Process exited with code 1';
  f.setVerified(false);
  f.setLocal(false);
  f.setPublic(false);
  expect(await check()).toEqual({
    state: 'failed',
    detail: expect.stringContaining('Dev server “web” did not restart: Process exited with code 1'),
  });
  expect(f.wait).toHaveBeenCalledTimes(2);
});
it('does not demand recovery of services that were already offline', async () => {
  const f = fixture();
  f.setVerified(false);
  f.setLocal(false);
  f.setPublic(false);
  expect(await (await f.capture('p'))()).toMatchObject({ state: 'ready' });
  expect(f.wait).not.toHaveBeenCalled();
});

it('bounds a stalled supervisor probe by the overall recovery deadline', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recovery = createSandboxUpdateRecovery({
    store: {
      managedDevServers: { listInstances: async () => [] },
      listPublicPreviewShares: async () => [],
    } as unknown as EventStore,
    devServers: () => ({ tick: () => blocked }) as never,
    local: () => undefined,
    public: () => undefined,
    timeoutMs: 5,
  });
  const check = await recovery.capture('p');
  expect(await check()).toMatchObject({
    state: 'failed',
    detail: expect.stringContaining('deadline exceeded'),
  });
  release();
  await blocked;
});
it('bounds a stalled pre-replacement capture without retiring the sandbox', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recovery = createSandboxUpdateRecovery({
    store: {
      managedDevServers: { listInstances: async () => [] },
      listPublicPreviewShares: async () => [],
    } as unknown as EventStore,
    devServers: () => undefined,
    local: () => ({ reconcile: () => blocked }) as never,
    public: () => undefined,
    timeoutMs: 5,
  });
  await expect(recovery.capture('p')).rejects.toThrow('capture deadline exceeded');
  release();
  await blocked;
});
