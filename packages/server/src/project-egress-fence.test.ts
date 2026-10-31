import { expect, it, vi } from 'vitest';
import {
  ProjectEgressFence,
  projectFenceRules,
  type ProjectFenceBinding,
} from './project-egress-fence.js';
import { verifyProjectFenceAttachment } from './project-egress-attachment.js';
import { projectDeadlineLease, type ProjectDeadlineClock } from './project-egress-deadline.js';
const sample: ProjectDeadlineClock = {
  bootId: 'c5bc8433-b1ee-424e-94fe-fb91b0f77f69',
  realNs: '1000000000',
  bootBeforeNs: '1000000000',
  bootAfterNs: '1000000000',
};
const binding: ProjectFenceBinding = {
  projectId: 'a',
  generation: 'g1',
  containerId: 'a'.repeat(64),
  networkId: 'b'.repeat(64),
  endpointId: 'c'.repeat(64),
  bridge: 've-a-g1',
  ipv4: '172.30.1.2',
  ipv6: 'fd42::2',
};
const grant = {
  id: 'grant',
  target: { host: 'downloads.example.com', protocol: 'tcp' as const, port: 443 },
  approvedBy: 'manager',
  approvedAt: 100,
  expiresAt: 5000,
};
function fixture() {
  let now = 1000;
  const deps = {
    deadline: {
      prepare: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      clock: vi.fn(async () => ({
        ...sample,
        realNs: (BigInt(now) * 1000000n).toString(),
        bootBeforeNs: (BigInt(now) * 1000000n).toString(),
        bootAfterNs: (BigInt(now) * 1000000n).toString(),
      })),
      arm: vi.fn(async () => undefined),
    },
    inspect: vi.fn(async (value: ProjectFenceBinding) => ({ ...value })),
    directTargetAllowed: vi.fn(async () => true),
    destinationAllowed: vi.fn(async () => true),
    resolve: vi.fn(async () => ({ addresses: ['8.8.8.8'], expiresAt: now + 10000 })),
    policyCurrent: vi.fn(async () => true),
    apply: vi.fn(async (script: string) => {
      void script;
    }),
    now: () => now,
  };
  return {
    deps,
    fence: new ProjectEgressFence(deps),
    setNow: (value: number) => {
      now = value;
    },
  };
}
it('installs denial first and expires grants in the kernel without an established-flow exception', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  expect(deps.apply.mock.calls[0]![0]).not.toContain('elements =');
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  const rules = deps.apply.mock.calls.at(-1)![0];
  expect(rules).toContain('8.8.8.8 . tcp . 443 timeout 1000ms');
  expect(rules).toContain('table bridge');
  expect(rules).toContain('meta ibrname "ve-a-g1" counter drop');
  expect(rules).not.toContain('ct state established');
  expect(rules).toContain('iifname "ve-a-g1" counter drop');
});
it('rejects stale generations/revisions and bridge reuse after retirement', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  await fence.refresh({ binding, revision: 2, grants: [grant] });
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow('Stale');
  await fence.prepare(binding);
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow('Stale');
  await fence.retire(binding);
  await expect(fence.refresh({ binding, revision: 3, grants: [grant] })).rejects.toThrow(
    'Inactive',
  );
  await expect(
    fence.prepare({ ...binding, bridge: 've-a-fresh', endpointId: 'f'.repeat(64) }),
  ).rejects.toThrow('Retired');
  await expect(fence.prepare({ ...binding, generation: 'g2' })).rejects.toThrow('fresh bridge');
  await fence.prepare({
    ...binding,
    generation: 'g2',
    bridge: 've-a-g2',
    networkId: 'd'.repeat(64),
    endpointId: 'e'.repeat(64),
  });
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('delete table');
});
it('closes previous access before failed resolution, including private and mixed DNS results', async () => {
  for (const addresses of [[], ['127.0.0.1'], ['8.8.8.8', '::ffff:127.0.0.1'], ['fd42::2']]) {
    const { deps, fence } = fixture();
    await fence.prepare(binding);
    deps.resolve.mockResolvedValue({ addresses, expiresAt: 11000 });
    await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow(
      'resolution',
    );
    expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
  }
});
it('does not resolve before policy classification and rejects attachment changes during resolution', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  deps.directTargetAllowed.mockResolvedValue(false);
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow('broker');
  expect(deps.resolve).not.toHaveBeenCalled();
  deps.directTargetAllowed.mockResolvedValue(true);
  deps.resolve.mockImplementation(async () => {
    deps.inspect.mockResolvedValue({ ...binding, endpointId: 'd'.repeat(64) });
    return { addresses: ['8.8.8.8'], expiresAt: 11000 };
  });
  await expect(fence.refresh({ binding, revision: 2, grants: [grant] })).rejects.toThrow(
    'attachment',
  );
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});
it('rejects foreign-project destinations and does not renew revoked or expired grants', async () => {
  const { deps, fence, setNow } = fixture();
  await fence.prepare(binding);
  deps.destinationAllowed.mockResolvedValue(false);
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow(
    'Protected',
  );
  deps.resolve.mockClear();
  setNow(5000);
  await fence.refresh({
    binding,
    revision: 2,
    grants: [grant, { ...grant, expiresAt: null, revokedAt: 2000 }],
  });
  expect(deps.resolve).not.toHaveBeenCalled();
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});
it('never emits a zero timeout and rejects nft syntax injection in bindings', () => {
  expect(
    projectFenceRules(
      binding,
      [{ address: '8.8.8.8', protocol: 'tcp', port: 443, expiresAt: 1000.5 }],
      1000,
      false,
      projectDeadlineLease(binding, 1, null, sample),
    ),
  ).not.toContain('timeout 0ms');
  expect(() => projectFenceRules({ ...binding, bridge: 'x";accept' }, [], 1000, false)).toThrow();
});
it('binds daemon network/endpoint IDs and dual-stack addresses rather than labels', () => {
  const container = [
    {
      Id: binding.containerId,
      HostConfig: { NetworkMode: 'project' },
      NetworkSettings: {
        Networks: {
          project: {
            NetworkID: binding.networkId,
            EndpointID: binding.endpointId,
            IPAddress: binding.ipv4,
            GlobalIPv6Address: binding.ipv6,
          },
        },
      },
    },
  ];
  const network = [
    {
      Id: binding.networkId,
      Driver: 'bridge',
      Options: { 'com.docker.network.bridge.name': binding.bridge },
    },
  ];
  expect(verifyProjectFenceAttachment(binding, container, network)).toEqual(binding);
  for (const patch of [
    { endpointId: 'd'.repeat(64) },
    { networkId: 'e'.repeat(64) },
    { ipv6: 'fd42::3' },
    { bridge: 've-other' },
  ])
    expect(() =>
      verifyProjectFenceAttachment({ ...binding, ...patch }, container, network),
    ).toThrow();
});

it('rechecks revocation after asynchronous DNS work', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  deps.resolve.mockImplementation(async () => {
    deps.policyCurrent.mockResolvedValue(false);
    return { addresses: ['8.8.8.8'], expiresAt: 11000 };
  });
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow(
    'authority changed',
  );
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});

it('bounds destination leases by DNS expiry and denies stale answers', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  deps.resolve.mockResolvedValue({ addresses: ['8.8.8.8'], expiresAt: 2500 });
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  expect(deps.apply.mock.calls.at(-1)![0]).toContain('8.8.8.8 . tcp . 443 timeout 500ms');
  deps.resolve.mockResolvedValue({ addresses: ['8.8.8.8'], expiresAt: 1000 });
  await expect(fence.refresh({ binding, revision: 2, grants: [grant] })).rejects.toThrow(
    'resolution',
  );
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});

it('coalesces overlapping grants and canonical IPv6 addresses into one set element', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  await fence.refresh({
    binding,
    revision: 1,
    grants: [grant, { ...grant, id: 'overlap', expiresAt: 1500 }],
  });
  expect(deps.apply.mock.calls.at(-1)![0].match(/8\.8\.8\.8 \. tcp \. 443 timeout/g)).toHaveLength(
    1,
  );
  const rules = projectFenceRules(
    binding,
    [
      { address: '2001:4860:4860::8888', protocol: 'tcp', port: 443, expiresAt: 1500 },
      { address: '2001:4860:4860:0:0:0:0:8888', protocol: 'tcp', port: 443, expiresAt: 3000 },
    ],
    1000,
    false,
    projectDeadlineLease(binding, 1, null, sample),
  );
  expect(rules.match(/2001:4860:4860::8888 \. tcp \. 443 timeout 1000ms/g)).toHaveLength(1);
});

it('reserves executor delay before absolute grant expiry', async () => {
  for (const remaining of [500, 1000, 1100, 2000, 4000]) {
    const { deps, fence, setNow } = fixture();
    await fence.prepare(binding);
    const deadline = 1000 + remaining;
    deps.apply.mockImplementation(async (script) => {
      // The kernel starts relative timeouts at commit, after executor latency.
      setNow(2000);
      const timeout = script.match(/8\.8\.8\.8 \. tcp \. 443 timeout (\d+)ms/);
      if (timeout) expect(2000 + Number(timeout[1])).toBeLessThanOrEqual(deadline);
    });
    // Deny-first apply is immediate; only the admission transaction is delayed.
    deps.apply.mockImplementationOnce(async () => undefined);
    await fence.refresh({ binding, revision: 1, grants: [{ ...grant, expiresAt: deadline }] });
    const rules = deps.apply.mock.calls.at(-1)![0];
    if (remaining <= 1000) expect(rules).not.toContain('elements =');
    else expect(rules).toContain(`timeout ${Math.min(1000, remaining - 1000)}ms`);
  }
});

it('captures immutable BOOTTIME before DNS and keeps a delayed apply expired', async () => {
  const { deps, fence, setNow } = fixture();
  await fence.prepare(binding);
  deps.resolve.mockImplementation(async () => {
    setNow(5000);
    return { addresses: ['8.8.8.8'], expiresAt: 11000 };
  });
  await fence.refresh({ binding, revision: 1, grants: [{ ...grant, expiresAt: 10000 }] });
  expect(deps.deadline.arm.mock.calls[0]).toEqual([
    binding,
    expect.objectContaining({
      capturedBootNs: '1000000000',
      bootDeadlineNs: '2000000000',
      authorityExpiresAt: 10000,
    }),
  ]);
});

it('captures before the revoke and deny executors can stall', async () => {
  const { deps, fence, setNow } = fixture();
  await fence.prepare(binding);
  deps.deadline.revoke.mockImplementation(async () => {
    setNow(5000);
  });
  await fence.refresh({ binding, revision: 1, grants: [{ ...grant, expiresAt: 10000 }] });
  expect(deps.deadline.arm.mock.calls[0]).toEqual([
    binding,
    expect.objectContaining({ capturedBootNs: '1000000000', bootDeadlineNs: '2000000000' }),
  ]);
});

it('installs nft denial even when the required kernel guard fails', async () => {
  const { deps, fence } = fixture();
  deps.deadline.prepare.mockRejectedValue(new Error('unsupported guard'));
  await expect(fence.prepare(binding)).rejects.toThrow('unsupported guard');
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
  expect(deps.deadline.arm).not.toHaveBeenCalled();
});

it('denies previous access when a new clock sample cannot be trusted', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  deps.deadline.clock.mockRejectedValue(new Error('clock unavailable'));
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow(
    'clock unavailable',
  );
  expect(deps.deadline.revoke).toHaveBeenCalled();
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});

it('preserves denial on revocation or admission failure', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  deps.deadline.revoke.mockRejectedValueOnce(new Error('lost expiry evidence'));
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow(
    'lost expiry evidence',
  );
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
  deps.deadline.arm.mockRejectedValueOnce(new Error('changed endpoint'));
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow(
    'changed endpoint',
  );
  expect(deps.deadline.revoke).toHaveBeenCalledTimes(3);
});

it('binds both directions to fresh labels and absolute expiry tombstones', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  const first = deps.apply.mock.calls.at(-1)![0];
  expect(first).toContain('meta time >= "1970-01-01 00:00:05"');
  expect(first).toContain('add @expired4');
  expect(first).toContain('ct direction reply ct label ==');
  expect(first).toContain('oifname "ve-a-g1" jump reply');
  expect(first).toContain('ct state new ct label == (0 & 1)');
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  expect(deps.apply.mock.calls.at(-1)![0]).not.toBe(first);
  const second = deps.apply.mock.calls.at(-1)![0];
  expect(second).not.toContain('delete table inet');
  expect(second).not.toMatch(/flush set.*expired/u);
  expect(second.match(/set expired4_\w+/u)?.[0]).toBe(first.match(/set expired4_\w+/u)?.[0]);
});

it('never admits capture-expired grants after rollback during revocation', async () => {
  for (const standing of [false, true]) {
    const { deps, fence, setNow } = fixture();
    await fence.prepare(binding);
    deps.deadline.revoke.mockImplementation(async () => {
      setNow(-2000);
    });
    const expired = { ...grant, expiresAt: 900, target: { ...grant.target, port: 444 } };
    await fence.refresh({
      binding,
      revision: 1,
      grants: standing ? [expired, { ...grant, expiresAt: null }] : [expired],
    });
    const rules = deps.apply.mock.calls.at(-1)![0];
    expect(rules).not.toContain('8.8.8.8 . tcp . 444');
    expect(deps.resolve).toHaveBeenCalledTimes(standing ? 1 : 0);
    if (standing) {
      expect(rules).toContain('8.8.8.8 . tcp . 443');
      expect(deps.deadline.arm).toHaveBeenCalledOnce();
    } else {
      expect(rules).not.toContain('elements =');
      expect(deps.deadline.arm).not.toHaveBeenCalled();
    }
  }
});

it('captures and latches every overlapping expiry before an earlier expiry can drop', async () => {
  const { deps, fence } = fixture();
  await fence.prepare(binding);
  await fence.refresh({
    binding,
    revision: 1,
    grants: [grant, { ...grant, id: 'later', expiresAt: 9000 }],
  });
  expect(deps.deadline.arm.mock.calls[0]).toEqual([
    binding,
    expect.objectContaining({
      authorityBootDeadlines: { '5000': '5000000000', '9000': '9000000000' },
    }),
  ]);
  const rules = deps.apply.mock.calls.at(-1)![0];
  const lastLatch = rules.indexOf('meta time >= "1970-01-01 00:00:09" add @expired4');
  const firstDrop = rules.indexOf('meta time >= "1970-01-01 00:00:05" counter name expired drop');
  expect(lastLatch).toBeGreaterThan(0);
  expect(firstDrop).toBeGreaterThan(lastLatch);
  expect(rules).toContain('{ 172.30.1.2 }');
  expect(rules).toContain('{ fd42::2 }');
});

it('preserves live connection labels only through a kernel-checked same-policy handoff', async () => {
  const { fence, deps, setNow } = fixture();
  const renew = vi.fn(async () => undefined);
  Object.assign(deps.deadline, { renew });
  await fence.prepare(binding);
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  const first = deps.apply.mock.calls.at(-1)![0];
  const label = first.match(/ct label set (.+)/u)![1];
  setNow(1250);
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  expect(renew).toHaveBeenCalledOnce();
  expect(renew.mock.calls[0]).toHaveLength(3);
  expect(deps.apply.mock.calls.at(-1)![0]).toContain(`ct label set ${label}`);
  // An expired controller epoch is replaced, even with an unchanged policy.
  setNow(3000);
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  expect(renew).toHaveBeenCalledOnce();
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain(`ct label set ${label}`);
  await fence.revoke(binding);
  setNow(3100);
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  expect(renew).toHaveBeenCalledOnce();
});

it('closes direct authority when the kernel rejects a delayed continuity handoff', async () => {
  const { fence, deps, setNow } = fixture();
  const renew = vi.fn(async () => {
    throw new Error('kernel epoch expired');
  });
  Object.assign(deps.deadline, { renew });
  await fence.prepare(binding);
  await fence.refresh({ binding, revision: 1, grants: [grant] });
  setNow(1250);
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow(
    'kernel epoch expired',
  );
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
  expect(deps.deadline.revoke).toHaveBeenCalled();
});
