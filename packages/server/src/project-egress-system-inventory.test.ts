import { expect, it, vi } from 'vitest';
import {
  createManagedSystemInventory,
  createProjectEgressInventorySynchronizer,
  projectEgressSystemDestinations,
  projectEgressSystemInventoryHash,
} from './project-egress-system-inventory.js';
import type { ProjectEgressHostRequest, ProjectEgressHostResponse } from './project-egress-host.js';

it('canonicalizes only endpoint hostnames, including resource and distinct OAuth origins', () => {
  expect(
    projectEgressSystemDestinations([
      'https://user:private@MCP.example.org/private?token=secret',
      'https://oauth.example.org/token',
      'https://mcp.example.org/other',
    ]),
  ).toEqual({ hosts: ['mcp.example.org', 'oauth.example.org'], addresses: [] });
  for (const endpoint of ['file:///private', 'https://singlelabel/api'])
    expect(() => projectEgressSystemDestinations([endpoint])).toThrow();
});

it('requires fresh exclusive mutation ownership and does not renew an expired inventory', async () => {
  let now = 0;
  const replace = vi.fn(async () => undefined);
  const inventory = createManagedSystemInventory({
    managed: true,
    now: () => now,
    replace,
    invalidate: vi.fn(),
  });
  expect(inventory.ready()).toBe(false);
  expect(() => inventory.verify()).toThrow();
  inventory.begin('one');
  expect(() => inventory.begin('two')).toThrow('busy');
  await expect(inventory.commit('two', ['broker.example.org'])).rejects.toThrow('expired');
  await inventory.commit('one', ['broker.example.org']);
  expect(inventory.ready()).toBe(true);
  now = 10_000;
  inventory.renew(projectEgressSystemInventoryHash(['broker.example.org']));
  expect(replace).toHaveBeenCalledTimes(1);
  expect(() => inventory.renew(projectEgressSystemInventoryHash([]))).toThrow();
  now = 35_001;
  expect(inventory.ready()).toBe(false);
  expect(() => inventory.renew(projectEgressSystemInventoryHash(['broker.example.org']))).toThrow();
  expect(() => inventory.verify()).toThrow();
});

it('awaits fencing before persistence and publishes old/new union before transaction commit', async () => {
  const steps: string[] = [];
  let urls = ['https://old.example.org/'];
  let committed: string[] = [];
  const synchronize = createProjectEgressInventorySynchronizer({
    transaction: async (action) => {
      steps.push('sql-begin');
      const value = await action();
      steps.push('sql-commit');
      return value;
    },
    readUrls: async () => [...urls],
    command: async (request) => {
      if (request.operation === 'inventory-begin') {
        steps.push('fenced');
        return { state: 'inventory-denied', token: request.token };
      }
      if (request.operation === 'inventory-commit') {
        steps.push('host-ack');
        committed = request.hosts;
        return { state: 'inventory-ready', token: request.token };
      }
      throw new Error('Unexpected command');
    },
  });
  await synchronize.mutate(async () => {
    steps.push('write');
    urls = ['https://new.example.org/'];
  });
  expect(steps).toEqual(['sql-begin', 'fenced', 'write', 'host-ack', 'sql-commit']);
  expect(committed).toEqual(['new.example.org', 'old.example.org']);
});

it('never persists after failed fencing and never acknowledges unsupported endpoint completeness', async () => {
  const write = vi.fn(async () => undefined);
  const command = vi.fn<(request: ProjectEgressHostRequest) => Promise<ProjectEgressHostResponse>>(
    async () => {
      throw new Error('unavailable');
    },
  );
  const synchronize = createProjectEgressInventorySynchronizer({
    command,
    transaction: (action) => action(),
    readUrls: async () => ['file:///private'],
  });
  await expect(synchronize.mutate(write)).rejects.toThrow('unavailable');
  expect(write).not.toHaveBeenCalled();
  command.mockImplementation(async (request) => {
    if (request.operation === 'inventory-begin')
      return { state: 'inventory-denied', token: request.token };
    throw new Error('Unexpected complete acknowledgement');
  });
  await synchronize.mutate(write);
  await expect(synchronize.refresh()).rejects.toThrow();
  expect(command.mock.calls.map(([request]) => request.operation)).not.toContain(
    'inventory-commit',
  );
});

it('renews an unchanged inventory without fencing or interrupting existing corridors', async () => {
  const command = vi.fn<(request: ProjectEgressHostRequest) => Promise<ProjectEgressHostResponse>>(
    async (request) => {
      if (request.operation !== 'inventory-renew') throw new Error('Unnecessary fencing');
      return { state: 'inventory-ready', token: request.token };
    },
  );
  const synchronize = createProjectEgressInventorySynchronizer({
    command,
    transaction: (action) => action(),
    readUrls: async () => ['https://broker.example.org'],
  });
  await synchronize.refresh();
  expect(command).toHaveBeenCalledTimes(1);
  expect(command.mock.calls[0]?.[0]).toMatchObject({
    operation: 'inventory-renew',
    hash: projectEgressSystemInventoryHash(['broker.example.org']),
  });
});

it('carries explicit IP endpoints into protected-address inventory instead of omitting them', () => {
  expect(
    projectEgressSystemDestinations(['https://192.0.2.4/api', 'https://[2001:db8::4]/api']),
  ).toEqual({ hosts: [], addresses: ['192.0.2.4', '2001:db8::4'] });
});

it('represents localhost explicitly as protected loopback endpoints', () => {
  expect(projectEgressSystemDestinations(['http://localhost:1234/v1'])).toEqual({
    hosts: [],
    addresses: ['127.0.0.1', '::1'],
  });
});

it('leaves the host fenced when the source transaction fails', async () => {
  const command = vi.fn<(request: ProjectEgressHostRequest) => Promise<ProjectEgressHostResponse>>(
    (request) => {
      if (request.operation !== 'inventory-begin') throw new Error('Unexpected inventory grant');
      return Promise.resolve({ state: 'inventory-denied', token: request.token });
    },
  );
  const synchronize = createProjectEgressInventorySynchronizer({
    command,
    transaction: (action) => action(),
    readUrls: () => Promise.resolve(['https://broker.example.org']),
  });
  await expect(synchronize.mutate(() => Promise.reject(new Error('write failed')))).rejects.toThrow(
    'write failed',
  );
  expect(command.mock.calls.map(([request]) => request.operation)).toEqual(['inventory-begin']);
});
