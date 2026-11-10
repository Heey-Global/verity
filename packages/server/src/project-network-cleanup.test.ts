import { expect, it, vi } from 'vitest';
import { createDockerClient, type HttpFetchInit } from './docker.js';
import type { HttpFetch } from './github.js';
import {
  dockerNetworkSchema,
  generationNetworkIdentity,
  generationNetworkLabels,
  removeLegacyProjectNetwork,
} from './project-network-cleanup.js';
import { createHostProjectNetworks } from './project-egress-network-cleanup.js';

const id = 'a'.repeat(64);
function fixture(
  name = 'verity-proj-p1',
  labels: Record<string, string> = { 'verity.project-id': 'p1' },
) {
  let exists = true;
  let containers: unknown[] = [];
  const network = {
    Id: id,
    Name: name,
    Driver: 'bridge',
    Labels: labels,
    Options: {},
    Containers: {} as Record<string, unknown>,
  };
  const fetch: HttpFetch = vi.fn(async (url: string, init?: HttpFetchInit) => {
    const path = new URL(url).pathname;
    if (path === '/containers/json') return { ok: true, status: 200, json: async () => containers };
    if (path.startsWith('/containers/'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Id: 'b'.repeat(64),
          State: { Running: false },
          HostConfig: { NetworkMode: name },
          NetworkSettings: { Networks: {} },
        }),
      };
    if (init?.method === 'DELETE') {
      exists = false;
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: exists, status: exists ? 200 : 404, json: async () => network };
  });
  const docker = createDockerClient({ baseUrl: 'http://docker', fetch });
  return {
    docker,
    fetch,
    network,
    clearContainers: () => {
      containers = [];
    },
    setContainers: () => {
      containers = [
        {
          Id: 'b'.repeat(64),
          ImageID: 'sha256:test',
          Names: ['/stopped'],
          State: 'exited',
          Labels: {},
        },
      ];
    },
  };
}
it('repeated cleanup removes an owned empty network once, by immutable ID', async () => {
  const f = fixture();
  await removeLegacyProjectNetwork(f.docker, 'p1');
  await removeLegacyProjectNetwork(f.docker, 'p1');
  expect(
    vi
      .mocked(f.fetch)
      .mock.calls.filter(([, init]) => init?.method === 'DELETE')
      .map(([url]) => url),
  ).toEqual([`http://docker/networks/${id}`]);
});
it('preserves foreign networks, live endpoints and stopped configured containers', async () => {
  const foreign = fixture('verity-proj-p1', { 'verity.project-id': 'other' });
  await expect(removeLegacyProjectNetwork(foreign.docker, 'p1')).rejects.toThrow('ownership');
  const attached = fixture();
  attached.network.Containers['b'.repeat(64)] = {};
  await removeLegacyProjectNetwork(attached.docker, 'p1');
  const stopped = fixture();
  stopped.setContainers();
  await removeLegacyProjectNetwork(stopped.docker, 'p1');
  for (const f of [foreign, attached, stopped])
    expect(vi.mocked(f.fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});
it('rejects missing attachment information instead of treating it as empty', () => {
  expect(
    dockerNetworkSchema.safeParse({ Id: id, Name: 'n', Driver: 'bridge', Labels: {}, Options: {} })
      .success,
  ).toBe(false);
});
it('rechecks endpoints immediately before deletion', async () => {
  const f = fixture();
  const inspect = f.docker.inspectNetwork!.bind(f.docker);
  let reads = 0;
  f.docker.inspectNetwork = async (name) => {
    const value = await inspect(name);
    if (++reads === 2) f.network.Containers['b'.repeat(64)] = {};
    return value ? { ...value, Containers: { ...f.network.Containers } } : value;
  };
  await removeLegacyProjectNetwork(f.docker, 'p1');
  expect(vi.mocked(f.fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});
it('retired exact bindings support old unlabelled networks but pending intents require ownership labels', async () => {
  const names = generationNetworkIdentity('p1', 'g1');
  const f = fixture(names.networkName, {});
  f.network.Options = { 'com.docker.network.bridge.name': names.bridge };
  const host = createHostProjectNetworks(f.docker);
  await expect(host.cleanupPendingNetwork({ projectId: 'p1', generation: 'g1' })).rejects.toThrow(
    'ownership',
  );
  await expect(
    host.cleanupNetwork({ projectId: 'p1', generation: 'g1', networkId: id, ...names }),
  ).resolves.toBe(true);
});
it('recovers a labelled pending creation and refuses a changed bridge', async () => {
  const names = generationNetworkIdentity('p1', 'g1');
  const f = fixture(names.networkName, generationNetworkLabels('p1', 'g1'));
  f.network.Options = { 'com.docker.network.bridge.name': 'other' };
  const host = createHostProjectNetworks(f.docker);
  await expect(host.cleanupPendingNetwork({ projectId: 'p1', generation: 'g1' })).rejects.toThrow();
  f.network.Options = { 'com.docker.network.bridge.name': names.bridge };
  await host.cleanupPendingNetwork({ projectId: 'p1', generation: 'g1' });
  expect(vi.mocked(f.fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
});

it.each([false, true])(
  'removes only recorded stopped containers of the retired generation (owned=%s)',
  async (owned) => {
    const identity = { projectId: 'p1', generation: 'g1' };
    const names = generationNetworkIdentity(identity.projectId, identity.generation);
    const f = fixture(
      names.networkName,
      generationNetworkLabels(identity.projectId, identity.generation),
    );
    f.network.Options = { 'com.docker.network.bridge.name': names.bridge };
    f.setContainers();
    const containerId = 'b'.repeat(64);
    f.docker.inspectContainer = async (id) => ({
      id,
      running: false,
      status: 'exited',
      labels: generationNetworkLabels(identity.projectId, owned ? identity.generation : 'other'),
      networkMode: names.networkName,
      networks: {},
    });
    const remove = vi.fn(async () => {
      f.clearContainers();
    });
    f.docker.removeStoppedContainer = remove;
    await expect(
      createHostProjectNetworks(f.docker).cleanupNetwork(
        { ...identity, ...names, networkId: id },
        { sandbox: containerId },
      ),
    ).resolves.toBe(owned);
    expect(remove).toHaveBeenCalledTimes(owned ? 1 : 0);
  },
);

it('preserves a replacement network with the same name and a different immutable identity', async () => {
  const f = fixture();
  await removeLegacyProjectNetwork(f.docker, 'p1', 'c'.repeat(64));
  expect(vi.mocked(f.fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});

it('uses complete list network facts without unbounded per-container inspection', async () => {
  const f = fixture();
  f.docker.listContainers = async () =>
    Array.from({ length: 1000 }, (_, i) => ({
      id: `container-${i}`,
      imageId: 'image',
      networkMode: 'none',
      networkNames: [],
    }));
  const inspect = vi.fn(async () => {
    throw new Error('unexpected inspection');
  });
  f.docker.inspectContainer = inspect;
  await removeLegacyProjectNetwork(f.docker, 'p1');
  expect(inspect).not.toHaveBeenCalled();
  expect(vi.mocked(f.fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
});

it('defers cleanup when legacy per-container inspections exceed the read budget', async () => {
  const f = fixture();
  f.docker.listContainers = async () =>
    Array.from({ length: 65 }, (_, i) => ({ id: `container-${i}`, imageId: 'image' }));
  const inspect = vi.fn(async (id: string) => ({
    id,
    running: false,
    networkMode: 'none',
    networks: {},
  }));
  f.docker.inspectContainer = inspect;
  await expect(removeLegacyProjectNetwork(f.docker, 'p1')).rejects.toThrow('budget exceeded');
  expect(inspect).toHaveBeenCalledTimes(64);
  expect(vi.mocked(f.fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});

it('reclaims an abandoned stopped container created before its ID was registered with the host', async () => {
  const identity = { projectId: 'p1', generation: 'g1' };
  const names = generationNetworkIdentity(identity.projectId, identity.generation);
  const f = fixture(
    names.networkName,
    generationNetworkLabels(identity.projectId, identity.generation),
  );
  f.network.Options = { 'com.docker.network.bridge.name': names.bridge };
  const containerId = 'b'.repeat(64);
  let remains = true;
  f.docker.listContainers = async () =>
    remains
      ? [
          {
            id: containerId,
            imageId: 'image',
            labels: generationNetworkLabels(identity.projectId, identity.generation),
          },
        ]
      : [];
  f.docker.inspectContainer = async (id) => ({
    id,
    running: false,
    status: 'created',
    networkMode: names.networkName,
    networks: {},
    labels: generationNetworkLabels(identity.projectId, identity.generation),
  });
  const remove = vi.fn(async () => {
    remains = false;
  });
  f.docker.removeStoppedContainer = remove;
  await expect(
    createHostProjectNetworks(f.docker).cleanupNetwork(
      { ...identity, ...names, networkId: id },
      {},
      true,
    ),
  ).resolves.toBe(true);
  expect(remove).toHaveBeenCalledExactlyOnceWith(containerId);
});
