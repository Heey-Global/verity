import { expect, it, vi } from 'vitest';
import { ProjectEgressHost, type ProjectEgressHostState } from './project-egress-host.js';
import { ProjectEgressLifecycle } from './project-egress-lifecycle.js';

const identity = { projectId: 'p1', containerGeneration: 'g1' };
function fixture() {
  let state: ProjectEgressHostState = { version: 1, records: [] };
  const starts = vi.fn(async () => {});
  const apply = vi.fn(async () => {});
  const deps = {
    save: async (value: ProjectEgressHostState) => {
      state = value;
    },
    apply,
    inspectNetwork: async () => {},
    inspectContainer: async () => {},
    startContainer: starts,
    stopContainer: async () => {},
  };
  const host = new ProjectEgressHost(state, deps);
  const createEgressNetwork = vi.fn(async () => ({ id: 'a'.repeat(64) }));
  const lifecycle = new ProjectEgressLifecycle((command) => host.execute(command), {
    createEgressNetwork,
  });
  return {
    host,
    lifecycle,
    starts,
    apply,
    createEgressNetwork,
    reconstruct: () =>
      new ProjectEgressLifecycle((command) => new ProjectEgressHost(state, deps).execute(command), {
        createEgressNetwork,
      }),
  };
}
it('creates an isolated generation and recovers its authority across Server reconstruction', async () => {
  const h = fixture();
  const binding = await h.lifecycle.create(identity);
  expect(binding.networkName).toMatch(/^verity-egress-[a-f0-9]{32}$/u);
  expect(binding.bridge).toMatch(/^vep[a-f0-9]{12}$/u);
  expect(await h.reconstruct().prepare(identity)).toEqual(binding);
  await h.lifecycle.start(identity, 'sandbox', 'b'.repeat(64));
  expect(h.starts).toHaveBeenCalledWith('b'.repeat(64));
  await h.lifecycle.retire(identity);
  await expect(h.reconstruct().prepare(identity)).rejects.toThrow('Unknown or stale');
  await expect(h.lifecycle.start(identity, 'sandbox', 'b'.repeat(64))).rejects.toThrow('Retired');
});
it('never adopts another generation or starts after a failed fence', async () => {
  const h = fixture();
  await h.lifecycle.create(identity);
  await expect(h.lifecycle.create({ ...identity, containerGeneration: 'g2' })).rejects.toThrow(
    'Retire',
  );
  expect(h.createEgressNetwork).toHaveBeenCalledTimes(1);
  await expect(h.lifecycle.prepare({ ...identity, containerGeneration: 'g2' })).rejects.toThrow(
    'stale',
  );
  h.apply.mockRejectedValueOnce(new Error('fence unavailable'));
  await expect(h.lifecycle.start(identity, 'sandbox', 'b'.repeat(64))).rejects.toThrow();
  expect(h.starts).not.toHaveBeenCalled();
});
it('does not retry failed network creation or register a guessed network ID', async () => {
  const h = fixture();
  h.createEgressNetwork.mockRejectedValueOnce(new Error('conflict'));
  await expect(h.lifecycle.create(identity)).rejects.toThrow('conflict');
  expect(await h.lifecycle.current(identity.projectId)).toBeUndefined();
  expect(h.createEgressNetwork).toHaveBeenCalledTimes(1);
});

it('renews only a host-acknowledged direct authority and stops on prepare or Server shutdown', async () => {
  vi.useFakeTimers();
  const commands: string[] = [];
  const binding = {
    projectId: 'p1',
    generation: 'g1',
    networkId: 'a'.repeat(64),
    networkName: 'p1-g1',
    bridge: 'vep0123456789ab',
  };
  const lifecycle = new ProjectEgressLifecycle(async (input) => {
    commands.push(input.operation);
    if (input.operation === 'current') return { state: 'current', projectId: 'p1', binding };
    if (input.operation === 'connect')
      return {
        state: 'connected',
        generation: 'g1',
        relayAddress: '172.30.1.3',
        directAuthority: true,
      };
    if (input.operation === 'refresh-direct')
      return { state: 'direct-refreshed', generation: 'g1' };
    if (input.operation === 'revoke-direct') return { state: 'direct-revoked', generation: 'g1' };
    return { state: 'denied', generation: 'g1' };
  }, {});
  try {
    await lifecycle.connect(identity);
    expect(commands.filter((command) => command === 'refresh-direct')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(commands.filter((command) => command === 'refresh-direct')).toHaveLength(3);
    await lifecycle.prepare(identity);
    await vi.advanceTimersByTimeAsync(1000);
    expect(commands.filter((command) => command === 'refresh-direct')).toHaveLength(3);
    await lifecycle.connect(identity);
    await lifecycle.close();
    expect(commands.at(-1)).toBe('revoke-direct');
    const count = commands.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(commands).toHaveLength(count);
    await expect(lifecycle.connect(identity)).rejects.toThrow('closed');
  } finally {
    await lifecycle.close();
    vi.useRealTimers();
  }
});

it('stops renewing after an ambiguous host failure and attempts direct revocation without retrying admission', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const operations: string[] = [];
  const lifecycle = new ProjectEgressLifecycle(async (input) => {
    operations.push(input.operation);
    if (input.operation === 'connect')
      return {
        state: 'connected',
        generation: 'g1',
        relayAddress: '172.30.1.3',
        directAuthority: true,
      };
    if (input.operation === 'refresh-direct') {
      if (++calls > 1) throw new Error('unknown execution outcome');
      return { state: 'direct-refreshed', generation: 'g1' };
    }
    return { state: 'direct-revoked', generation: 'g1' };
  }, {});
  try {
    await lifecycle.connect(identity);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    expect(operations.at(-1)).toBe('revoke-direct');
  } finally {
    await lifecycle.close();
    vi.useRealTimers();
  }
});

it('does not let an obsolete failed refresh cancel a replacement renewal', async () => {
  vi.useFakeTimers();
  let rejectOld!: (error: Error) => void;
  let calls = 0;
  const operations: string[] = [];
  const lifecycle = new ProjectEgressLifecycle(async (input) => {
    operations.push(input.operation);
    if (input.operation === 'connect')
      return {
        state: 'connected',
        generation: 'g1',
        relayAddress: '172.30.1.3',
        directAuthority: true,
      };
    if (input.operation === 'refresh-direct') {
      if (++calls === 2)
        await new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        });
      return { state: 'direct-refreshed', generation: 'g1' };
    }
    return { state: 'direct-revoked', generation: 'g1' };
  }, {});
  try {
    await lifecycle.connect(identity);
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(2);
    await lifecycle.connect(identity);
    rejectOld(new Error('obsolete request failed'));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(5);
    expect(operations).not.toContain('revoke-direct');
  } finally {
    await lifecycle.close();
    vi.useRealTimers();
  }
});
