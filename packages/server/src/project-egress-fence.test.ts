import { expect, it, vi } from 'vitest';
import {
  ProjectEgressFence,
  projectFenceRules,
  type ProjectFenceBinding,
} from './project-egress-fence.js';
import { verifyProjectFenceAttachment } from './project-egress-attachment.js';
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
    inspect: vi.fn(async (value: ProjectFenceBinding) => ({ ...value })),
    directTargetAllowed: vi.fn(async () => true),
    destinationAllowed: vi.fn(async () => true),
    resolve: vi.fn(async () => ['8.8.8.8']),
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
    deps.resolve.mockResolvedValue(addresses);
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
    return ['8.8.8.8'];
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
    return ['8.8.8.8'];
  });
  await expect(fence.refresh({ binding, revision: 1, grants: [grant] })).rejects.toThrow(
    'authority changed',
  );
  expect(deps.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});
