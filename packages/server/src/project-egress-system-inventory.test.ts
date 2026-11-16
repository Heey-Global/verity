import { ProjectEgressInventoryError } from './project-egress-inventory-error.js';
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
  expect(command.mock.calls.map(([request]) => request.operation)).toEqual([
    'inventory-begin',
    'inventory-abort',
  ]);
});

it('serializes preactivation writes with opt-in and skips controller and DB work while disabled', async () => {
  let enabled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = vi.fn(
    async (request: ProjectEgressHostRequest): Promise<ProjectEgressHostResponse> => ({
      state: request.operation === 'inventory-begin' ? 'inventory-denied' : 'inventory-ready',
      token: 'token' in request ? request.token : '',
    }),
  );
  const transaction = vi.fn(async <T>(action: () => Promise<T>) => action());
  const synchronize = createProjectEgressInventorySynchronizer({
    enabled: () => enabled,
    command,
    transaction: async (action) => {
      await transaction(async () => undefined);
      return action();
    },
    readUrls: async () => [],
  });
  await synchronize.refresh();
  const write = synchronize.mutate(async () => {
    await gate;
    enabled = true;
  });
  const refresh = synchronize.refresh();
  await Promise.resolve();
  expect(command).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  release();
  await write;
  await refresh;
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ operation: 'inventory-renew' }));
  expect(transaction).toHaveBeenCalledTimes(1);
});

it('does not persist or renew when the inventory contract cannot be read', async () => {
  const action = vi.fn(async () => undefined);
  const transaction = vi.fn(async <T>(run: () => Promise<T>) => run());
  const synchronize = createProjectEgressInventorySynchronizer({
    enabled: () => {
      throw new Error('invalid contract');
    },
    command: vi.fn(),
    transaction: async (action) => {
      await transaction(async () => undefined);
      return action();
    },
    readUrls: async () => [],
  });
  await expect(synchronize.mutate(action)).rejects.toThrow('invalid contract');
  await expect(synchronize.refresh()).rejects.toThrow('invalid contract');
  expect(action).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
});

it('releases failed replacement immediately while preserving denial and fixed reasons', async () => {
  const replace = vi.fn<() => Promise<void>>(async () => {
    throw new Error('private DNS or disk details');
  });
  const inventory = createManagedSystemInventory({ managed: true, replace, invalidate: vi.fn() });
  inventory.begin('one');
  await expect(inventory.commit('one', [])).rejects.toMatchObject({
    reason: 'inventory_replace_failed',
  });
  expect(inventory.ready()).toBe(false);
  inventory.begin('two');
  inventory.abort('one');
  expect(() => inventory.begin('three')).toThrow('inventory_busy');
  replace.mockResolvedValue(undefined);
  await inventory.commit('two', []);
  expect(inventory.ready()).toBe(true);
  inventory.abort('one');
  expect(inventory.ready()).toBe(true);
  inventory.abort('two');
  expect(inventory.ready()).toBe(false);
  expect(() => inventory.renew(projectEgressSystemInventoryHash([]))).toThrow();
  inventory.begin('three');
});

it('does not release a newer lease or acknowledge a late commit', async () => {
  let now = 0;
  let release!: () => void;
  const inventory = createManagedSystemInventory({
    managed: true,
    now: () => now,
    invalidate: vi.fn(),
    replace: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  inventory.begin('old');
  const commit = inventory.commit('old', []);
  now = 30_001;
  inventory.begin('new');
  release();
  await expect(commit).rejects.toMatchObject({ reason: 'inventory_lease_expired' });
  inventory.abort('old');
  expect(() => inventory.begin('third')).toThrow('inventory_busy');
  expect(inventory.ready()).toBe(false);
  inventory.abort('new');
  inventory.begin('third');
});

it('retries after source rollback without waiting for the host lease', async () => {
  const inventory = createManagedSystemInventory({
    managed: true,
    invalidate: vi.fn(),
    replace: async () => undefined,
  });
  const operations: string[] = [];
  const sync = createProjectEgressInventorySynchronizer({
    transaction: (action) => action(),
    readUrls: async () => [],
    command: async (request) => {
      operations.push(request.operation);
      if (request.operation === 'inventory-begin') inventory.begin(request.token);
      else if (request.operation === 'inventory-abort') inventory.abort(request.token);
      else if (request.operation === 'inventory-commit')
        await inventory.commit(request.token, request.hosts, request.addresses);
      else throw new Error('Unexpected operation');
      return {
        state: request.operation === 'inventory-commit' ? 'inventory-ready' : 'inventory-denied',
        token: request.token,
      };
    },
  });
  await expect(
    sync.mutate(async () => {
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(inventory.ready()).toBe(false);
  await sync.mutate(async () => undefined);
  expect(inventory.ready()).toBe(true);
  expect(operations).toEqual([
    'inventory-begin',
    'inventory-abort',
    'inventory-begin',
    'inventory-commit',
  ]);
});

it('aborts a host commit if the surrounding SQL commit fails', async () => {
  const inventory = createManagedSystemInventory({
    managed: true,
    invalidate: vi.fn(),
    replace: async () => undefined,
  });
  const sync = createProjectEgressInventorySynchronizer({
    readUrls: async () => [],
    transaction: async (action) => {
      await action();
      throw new Error('SQL commit failed');
    },
    command: async (request) => {
      if (request.operation === 'inventory-begin') inventory.begin(request.token);
      else if (request.operation === 'inventory-commit')
        await inventory.commit(request.token, request.hosts, request.addresses);
      else if (request.operation === 'inventory-abort') inventory.abort(request.token);
      else throw new Error('Unexpected');
      return {
        state: request.operation === 'inventory-commit' ? 'inventory-ready' : 'inventory-denied',
        token: request.token,
      };
    },
  });
  await expect(sync.mutate(async () => undefined)).rejects.toThrow('SQL commit failed');
  expect(inventory.ready()).toBe(false);
  inventory.begin('retry');
});

it('evaluates unchanged-destination predicates under the serialized transaction without host commands', async () => {
  const command = vi.fn();
  let locked = false;
  const sync = createProjectEgressInventorySynchronizer({
    command,
    readUrls: async () => [],
    transaction: async (action) => {
      locked = true;
      try {
        return await action();
      } finally {
        locked = false;
      }
    },
  });
  const changes = vi.fn(async () => {
    expect(locked).toBe(true);
    return false;
  });
  await expect(
    sync.mutate(async () => {
      expect(locked).toBe(true);
      return 'updated';
    }, changes),
  ).resolves.toBe('updated');
  expect(changes).toHaveBeenCalledOnce();
  expect(command).not.toHaveBeenCalled();
});

it.each(['inventory_dns_failed', 'inventory_persistence_failed'] as const)(
  'preserves %s and retries immediately after a failed host replacement',
  async (reason) => {
    const replace = vi.fn<() => Promise<void>>(async () => {
      throw new ProjectEgressInventoryError(reason);
    });
    const inventory = createManagedSystemInventory({ managed: true, replace, invalidate: vi.fn() });
    inventory.begin('failed');
    await expect(inventory.commit('failed', [])).rejects.toMatchObject({ reason });
    expect(inventory.ready()).toBe(false);
    inventory.begin('retry');
    replace.mockResolvedValue(undefined);
    await inventory.commit('retry', []);
    expect(inventory.ready()).toBe(true);
  },
);

it('retains denial and bounded expiry when the connection loses Begin and Abort acknowledgements', async () => {
  let now = 0;
  const inventory = createManagedSystemInventory({
    managed: true,
    now: () => now,
    replace: async () => undefined,
    invalidate: vi.fn(),
  });
  const sync = createProjectEgressInventorySynchronizer({
    transaction: (action) => action(),
    readUrls: async () => [],
    command: async (request) => {
      if (request.operation === 'inventory-begin') inventory.begin(request.token);
      throw new Error('connection lost');
    },
  });
  await expect(sync.mutate(async () => undefined)).rejects.toThrow('connection lost');
  expect(inventory.ready()).toBe(false);
  expect(() => inventory.begin('retry')).toThrow('inventory_busy');
  now = 30_001;
  inventory.begin('retry');
  await inventory.commit('retry', []);
  expect(inventory.ready()).toBe(true);
});

it('does not revoke a newer completed snapshot when an older replacement finishes late', async () => {
  let now = 0;
  let release!: () => void;
  const replace = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const inventory = createManagedSystemInventory({
    managed: true,
    now: () => now,
    replace,
    invalidate: vi.fn(),
  });
  inventory.begin('old');
  const oldCommit = inventory.commit('old', []);
  now = 30_001;
  inventory.begin('new');
  await inventory.commit('new', []);
  expect(inventory.ready()).toBe(true);
  release();
  await expect(oldCommit).rejects.toMatchObject({ reason: 'inventory_lease_expired' });
  expect(inventory.ready()).toBe(true);
  inventory.abort('old');
  expect(inventory.ready()).toBe(true);
});
