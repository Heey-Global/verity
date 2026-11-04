import {
  createManagedSystemInventory,
  projectEgressSystemInventoryHash,
} from './project-egress-system-inventory.js';
import { expect, it, vi } from 'vitest';
import { createProjectEgressHostEnforcement } from './project-egress-host-enforcement.js';
import {
  projectEgressBootstrapRules,
  projectEgressStartupRules,
  ProjectEgressHost,
} from './project-egress-host.js';
import { projectFenceRules } from './project-egress-fence.js';
import type { EgressDirectCorridor } from './project-egress-transport.js';

const network = {
  projectId: 'a',
  generation: 'g1',
  networkId: 'a'.repeat(64),
  networkName: 'a-g1',
  bridge: 'vep0123456789ab',
};
const ids = { sandbox: 'b'.repeat(64), relay: 'c'.repeat(64) };
const corridor: EgressDirectCorridor = {
  binding: {
    projectId: network.projectId,
    generation: network.generation,
    networkId: network.networkId,
    bridge: network.bridge,
    containerId: ids.sandbox,
    endpointId: 'd'.repeat(64),
    ipv4: '172.30.1.2',
    ipv6: 'fd42::2',
  },
  gateway4: '172.30.1.1',
  gateway6: 'fd42::1',
};
const relay = {
  transport: {
    sandbox: {
      address: corridor.binding.ipv4,
      mac: '02:42:ac:1e:01:02',
      device: 'veth1',
      index: 11,
    },
    relay: { address: '172.30.1.3', mac: '02:42:ac:1e:01:03', device: 'veth2', index: 12 },
    codex: false,
  },
  flowLabel: '1'.repeat(32),
};
const grant = {
  id: 'one',
  target: { host: '8.8.8.8', protocol: 'tcp' as const, port: 443 },
  approvedBy: 'manager',
  approvedAt: 100,
  expiresAt: null,
};
function fixture(ready: () => boolean = () => true) {
  const events: string[] = [];
  const deadline = {
    prepare: vi.fn(async () => {
      events.push('tc-prepare');
    }),
    revoke: vi.fn(async () => {
      events.push('tc-revoke');
    }),
    arm: vi.fn(async () => {
      events.push('tc-arm');
    }),
    clock: vi.fn(async () => ({
      bootId: 'c5bc8433-b1ee-424e-94fe-fb91b0f77f69',
      realNs: '1000000000',
      bootBeforeNs: '1000000000',
      bootAfterNs: '1000000000',
    })),
    configureRelay: vi.fn(async () => {
      events.push('relay-configure');
    }),
    clearRelay: vi.fn(async () => {
      events.push('relay-clear');
    }),
  };
  const readForAdmission = vi.fn(async (_project: string, _revision?: number) => {
    void _project;
    void _revision;
    if (!ready()) throw new Error('System inventory expired');
    return { revision: 1, grants: [grant], requests: {} };
  });
  const inspect = vi.fn(async () => ({
    corridor: structuredClone(corridor),
    relayEndpointId: 'e'.repeat(64),
  }));
  const apply = vi.fn(async (_script: string) => {
    void _script;
    events.push('nft');
  });
  const enforcement = createProjectEgressHostEnforcement({
    deadline,
    store: { readForAdmission },
    directAuthority: () => true,
    inspect,
    dependencies: {
      inspect: async (b) => ({ ...b }),
      apply,
      now: () => 1000,
      directTargetAllowed: async () => ready(),
      destinationAllowed: async () => ready(),
      resolve: async () => {
        throw new Error('Unexpected DNS');
      },
    },
  });
  return { enforcement, deadline, readForAdmission, inspect, apply, events };
}
it('requires TC and direct denial before enabling the exact relay pair, without reading grants', async () => {
  const f = fixture();
  await expect(f.enforcement.refresh(network)).rejects.toThrow('not ready');
  expect(await f.enforcement.connect(network, ids, relay)).toEqual(corridor);
  expect(f.events).toEqual(['tc-prepare', 'nft', 'tc-revoke', 'nft', 'relay-configure']);
  expect(f.readForAdmission).not.toHaveBeenCalled();
  expect(f.deadline.configureRelay).toHaveBeenCalledWith(corridor.binding, {
    containerId: ids.relay,
    endpointId: 'e'.repeat(64),
    codex: false,
  });
  const rules = f.apply.mock.calls.at(-1)![0];
  expect(rules).toContain('tcp dport { 53, 8080, 8443 }');
  expect(rules).not.toContain('elements =');
  await f.enforcement.refresh(network);
  expect(f.readForAdmission).toHaveBeenCalledWith('a', 1);
  expect(f.deadline.arm).toHaveBeenCalledOnce();
});
it('direct revocation retains the relay but complete denial clears both paths', async () => {
  const f = fixture();
  await f.enforcement.connect(network, ids, relay);
  await f.enforcement.refresh(network);
  await f.enforcement.revoke(network);
  expect(f.deadline.clearRelay).not.toHaveBeenCalled();
  expect(f.apply.mock.calls.at(-1)![0]).toContain('tcp dport { 53, 8080, 8443 }');
  await f.enforcement.deny(network);
  expect(f.deadline.clearRelay).toHaveBeenCalledWith(corridor.binding);
  expect(f.apply.mock.calls.at(-1)![0]).not.toContain('tcp dport { 53, 8080, 8443 }');
  await expect(f.enforcement.refresh(network)).rejects.toThrow('not ready');
});
it('clears kernel exceptions and refuses readiness after a post-install endpoint change', async () => {
  const f = fixture();
  f.inspect.mockResolvedValueOnce({ corridor, relayEndpointId: 'e'.repeat(64) });
  f.inspect.mockResolvedValue({
    corridor: { ...corridor, gateway4: '172.30.1.9' },
    relayEndpointId: 'e'.repeat(64),
  });
  await expect(f.enforcement.connect(network, ids, relay)).rejects.toThrow('admission failed');
  expect(f.deadline.clearRelay).toHaveBeenCalledOnce();
  expect(f.apply.mock.calls.at(-1)![0]).not.toContain('tcp dport { 53, 8080, 8443 }');
  await expect(f.enforcement.refresh(network)).rejects.toThrow('not ready');
});
it('invalidates pending authority reads immediately when a lifecycle operation arrives', async () => {
  const f = fixture();
  await f.enforcement.connect(network, ids, relay);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.readForAdmission.mockImplementationOnce(async () => {
    await waiting;
    return { revision: 1, grants: [grant], requests: {} };
  });
  const refreshing = f.enforcement.refresh(network);
  await vi.waitFor(() => expect(f.readForAdmission).toHaveBeenCalled());
  f.enforcement.invalidate(network);
  release();
  await expect(refreshing).rejects.toThrow('superseded');
  expect(f.deadline.arm).not.toHaveBeenCalled();
});
it('routes only bound routed addresses through the later direct fence and preserves switched denial', () => {
  const admission = { ...relay, direct: corridor };
  const boot = projectEgressBootstrapRules([{ binding: network, ...admission }]);
  const startup = projectEgressStartupRules(network, admission);
  const fence = projectFenceRules(corridor.binding, [], 1000, false, undefined, relay);
  for (const rules of [boot, startup]) {
    expect(rules).toContain(
      `oifname != "${network.bridge}" ip saddr ${corridor.binding.ipv4} return`,
    );
    expect(rules).toContain('counter drop');
    expect(rules).not.toContain('ct state established accept');
  }
  expect(fence).toContain('tcp dport { 53, 8080, 8443 }');
  expect(fence).toContain(`meta ibrname "${network.bridge}" counter drop`);
  expect(fence).not.toContain('elements =');
  expect(() =>
    projectEgressStartupRules(network, {
      ...admission,
      direct: { ...corridor, binding: { ...corridor.binding, generation: 'foreign' } },
    }),
  ).toThrow('mismatch');
});
it('never acknowledges connected before packet enforcement succeeds and contains a failed install', async () => {
  const f = fixture();
  const stop = vi.fn(async () => undefined);
  const host = new ProjectEgressHost(
    { version: 1, records: [{ binding: network, containers: ids, retired: false }] },
    {
      enforcement: f.enforcement,
      save: async () => undefined,
      apply: async () => undefined,
      inspectContainer: async () => undefined,
      inspectNetwork: async () => undefined,
      inspectTransport: async () => relay.transport,
      startContainer: async () => undefined,
      stopContainer: stop,
    },
  );
  f.deadline.configureRelay.mockRejectedValueOnce(new Error('injected map failure'));
  await expect(
    host.execute({ operation: 'connect', projectId: 'a', generation: 'g1' }),
  ).rejects.toThrow();
  expect(f.deadline.clearRelay).toHaveBeenCalled();
  await expect(
    host.execute({ operation: 'refresh-direct', projectId: 'a', generation: 'g1' }),
  ).rejects.toThrow('not ready');
});

it('preserves same-boot generations but permanently retires them before a new host boot or daemon start', async () => {
  const bootId = 'c5bc8433-b1ee-424e-94fe-fb91b0f77f69';
  let saved: unknown;
  const dependencies = {
    bootId,
    save: async (state: unknown) => {
      saved = state;
    },
    apply: async () => undefined,
    inspectContainer: async () => undefined,
    inspectNetwork: async () => undefined,
    startContainer: async () => undefined,
    stopContainer: async () => undefined,
  };
  const initial = {
    version: 1,
    records: [{ binding: network, retired: false, containers: ids, bootId }],
  };
  const same = new ProjectEgressHost(initial, dependencies);
  await same.restore();
  expect(await same.execute({ operation: 'current', projectId: 'a' })).toMatchObject({
    binding: network,
  });
  await same.restore(true);
  expect(await same.execute({ operation: 'current', projectId: 'a' })).toMatchObject({
    binding: null,
  });
  expect(saved).toMatchObject({ records: [{ retired: true }] });
  const nextBoot = new ProjectEgressHost(initial, {
    ...dependencies,
    bootId: '95e0c359-e907-4d92-bab6-c011dfec9924',
  });
  await nextBoot.restore();
  await expect(
    nextBoot.execute({ operation: 'connect', projectId: 'a', generation: 'g1' }),
  ).rejects.toThrow('Retired');
});

it.each([false, true])(
  'contains admission failures but closes topology failures with batched inspection=%s',
  async (batched) => {
    const f = fixture();
    const inspectTransport = vi.fn(async () => relay.transport);
    const host = new ProjectEgressHost(
      { version: 1, records: [{ binding: network, containers: ids, retired: false }] },
      {
        enforcement: f.enforcement,
        save: async () => undefined,
        apply: async () => undefined,
        inspectContainer: async () => undefined,
        inspectNetwork: async () => undefined,
        inspectTransport,
        ...(batched ? { inspectDirectTransport: inspectTransport } : {}),
        startContainer: async () => undefined,
        stopContainer: async () => undefined,
      },
    );
    await host.execute({ operation: 'connect', projectId: 'a', generation: 'g1' });
    f.readForAdmission.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      host.execute({ operation: 'refresh-direct', projectId: 'a', generation: 'g1' }),
    ).rejects.toThrow('database unavailable');
    expect(f.deadline.clearRelay).not.toHaveBeenCalled();
    expect(f.apply.mock.calls.at(-1)![0]).toContain('tcp dport { 53, 8080, 8443 }');
    await expect(
      host.execute({ operation: 'refresh-direct', projectId: 'a', generation: 'g1' }),
    ).resolves.toMatchObject({ state: 'direct-refreshed' });
    inspectTransport.mockRejectedValueOnce(new Error('endpoint changed'));
    await expect(
      host.execute({ operation: 'refresh-direct', projectId: 'a', generation: 'g1' }),
    ).rejects.toThrow('endpoint changed');
    expect(f.deadline.clearRelay).toHaveBeenCalled();
  },
);

it('records one Sandbox HTTPS request per ungranted name and caps a project', async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  try {
    const f = fixture();
    const request = vi.fn(async () => ({ covered: true as const }));
    const reportRequestFailure = vi.fn();
    let authority = true;
    const enforcement = createProjectEgressHostEnforcement({
      deadline: f.deadline,
      store: { readForAdmission: f.readForAdmission },
      requests: { requestFromSandbox: request },
      reportRequestFailure,
      systemTargets: [{ host: 'mcp.exa.ai', protocol: 'tcp', port: 443 }],
      directAuthority: () => authority,
      inspect: f.inspect,
      dependencies: {
        inspect: async (b) => ({ ...b }),
        apply: f.apply,
        // `random.example.com` stands in for a broker-only name.
        directTargetAllowed: async (host) => host !== 'random.example.com',
        destinationAllowed: async () => true,
        resolve: async () => {
          throw new Error('Unexpected DNS');
        },
      },
    });
    const settle = () => vi.advanceTimersByTimeAsync(0);
    enforcement.requestDirect!(network, 'api.example.com');
    enforcement.requestDirect!(network, 'api.example.com');
    // Broker names never become cards that could not take effect.
    enforcement.requestDirect!(network, 'random.example.com');
    enforcement.requestDirect!(network, 'mcp.exa.ai');
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('a', {
      host: 'api.example.com',
      protocol: 'tcp',
      port: 443,
    });
    await vi.advanceTimersByTimeAsync(60_001);
    enforcement.requestDirect!(network, 'api.example.com');
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    // Without configured direct authority no grant could take effect, so nothing is asked.
    authority = false;
    enforcement.requestDirect!(network, 'down.example.com');
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    authority = true;
    request.mockRejectedValueOnce(new Error('store down'));
    enforcement.requestDirect!(network, 'down.example.com');
    await settle();
    expect(reportRequestFailure).toHaveBeenCalledWith(new Error('store down'));
    // A Sandbox resolving many names files at most 20 new requests per project and minute.
    await vi.advanceTimersByTimeAsync(60_001);
    request.mockClear();
    for (let i = 0; i < 30; i++) enforcement.requestDirect!(network, `api.example.com`);
    for (let i = 0; i < 30; i++) enforcement.requestDirect!(network, `n${String(i)}.example.com`);
    await settle();
    expect(request).toHaveBeenCalledTimes(20);
  } finally {
    vi.useRealTimers();
  }
});

it('fences existing packet grants before inventory ACK and leaves unchanged heartbeats connected', async () => {
  let now = 0;
  const inventory = createManagedSystemInventory({
    managed: true,
    now: () => now,
    replace: async () => undefined,
    invalidate: () => undefined,
  });
  const initial = '00000000-0000-4000-8000-000000000001';
  inventory.begin(initial);
  await inventory.commit(initial, []);
  const f = fixture(() => inventory.ready());
  const host = new ProjectEgressHost(
    { version: 1, records: [{ binding: network, containers: ids, retired: false }] },
    {
      enforcement: f.enforcement,
      systemInventory: inventory,
      save: async () => undefined,
      apply: async () => undefined,
      inspectContainer: async () => undefined,
      inspectNetwork: async () => undefined,
      inspectTransport: async () => relay.transport,
      startContainer: async () => undefined,
      stopContainer: async () => undefined,
    },
  );
  await host.execute({ operation: 'connect', projectId: 'a', generation: 'g1' });
  await host.execute({ operation: 'refresh-direct', projectId: 'a', generation: 'g1' });
  expect(f.deadline.arm).toHaveBeenCalledOnce();
  const priorRevokes = f.deadline.revoke.mock.calls.length;
  const token = '00000000-0000-4000-8000-000000000002';
  expect(await host.execute({ operation: 'inventory-begin', token })).toEqual({
    state: 'inventory-denied',
    token,
  });
  expect(f.deadline.revoke.mock.calls.length).toBeGreaterThan(priorRevokes);
  expect(f.deadline.clearRelay).not.toHaveBeenCalled();
  expect(f.apply.mock.calls.at(-1)?.[0]).toContain('tcp dport { 53, 8080, 8443 }');
  await host.execute({ operation: 'inventory-commit', token, hosts: [], addresses: [] });
  const revokes = f.deadline.revoke.mock.calls.length;
  await host.execute({
    operation: 'inventory-renew',
    token,
    hash: projectEgressSystemInventoryHash([]),
  });
  expect(f.deadline.revoke.mock.calls.length).toBe(revokes);
  now = 25_001;
  await expect(
    host.execute({ operation: 'refresh-direct', projectId: 'a', generation: 'g1' }),
  ).rejects.toThrow('System inventory expired');
  expect(f.deadline.arm).toHaveBeenCalledOnce();
  expect(f.deadline.revoke.mock.calls.length).toBeGreaterThan(revokes);
});
