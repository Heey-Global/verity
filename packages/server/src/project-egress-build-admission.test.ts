import { expect, it, vi } from 'vitest';
import {
  createProtectedBuildAdmission,
  protectedBuildRules,
} from './project-egress-build-admission.js';
import { projectDeadlineLease } from './project-egress-deadline.js';
import type { ProjectFenceBinding } from './project-egress-fence.js';
const binding: ProjectFenceBinding = {
  projectId: 'new-project',
  generation: 'attempt',
  containerId: 'a'.repeat(64),
  networkId: 'b'.repeat(64),
  endpointId: 'c'.repeat(64),
  bridge: 'veb123456789abc',
  ipv4: '172.30.1.2',
  ipv6: 'fd42::2',
};
const clock = {
  bootId: 'c5bc8433-b1ee-424e-94fe-fb91b0f77f69',
  realNs: '1000000000',
  bootBeforeNs: '1000000000',
  bootAfterNs: '1000000000',
};
function fixture() {
  const dependencies = {
    inspect: vi.fn(async () => ({ ...binding })),
    apply: vi.fn(async (_script: string) => {
      void _script;
    }),
    resolve: vi.fn(async () => ({ addresses: ['8.8.8.8', '2606:4700::1111'], expiresAt: 10000 })),
    directTargetAllowed: vi.fn(async () => false),
    destinationAllowed: vi.fn(async () => false),
    deadline: {
      prepare: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
      clock: vi.fn(async () => clock),
      arm: vi.fn(async () => undefined),
      renew: vi.fn(async () => undefined),
    },
  };
  const blockedNetworks = vi.fn(async () => ({
    blocked: ['9.9.9.7/24', '2606:4700:abcd::12/64'],
    uplinks: ['eth0'],
  }));
  return {
    dependencies,
    blockedNetworks,
    admission: createProtectedBuildAdmission({
      binding,
      dependencies,
      networkInventory: blockedNetworks,
    }),
  };
}
it('allows Internet build downloads for a project with no grants or approved hostnames', async () => {
  const f = fixture();
  await f.admission.prepare();
  await f.admission.refresh();
  expect(await f.admission.resolve('registry.npmjs.org')).toEqual({
    addresses: ['8.8.8.8', '2606:4700::1111'],
    ttlSeconds: 1,
  });
  for (const host of ['ghcr.io', 'github.com', 'registry.npmjs.org', 'pypi.org']) {
    expect((await f.admission.resolve(host)).addresses).toEqual(['8.8.8.8', '2606:4700::1111']);
  }
  expect(f.dependencies.directTargetAllowed).not.toHaveBeenCalled();
  expect(f.dependencies.destinationAllowed).not.toHaveBeenCalled();
  const rules = f.dependencies.apply.mock.calls.at(-1)![0];
  expect(rules).toContain('0.0.0.0/0 timeout 1000ms');
  expect(rules).toContain('2000::/3 timeout 1000ms');
  expect(rules).toContain('meta l4proto { tcp, udp } ip daddr @public4 oifname { "eth0" } accept');
  expect(rules).not.toContain('th dport');
  expect(rules).toContain('9.9.9.0/24');
  expect(rules).toContain('2606:4700:abcd::/64');
  expect(rules).toContain('ip daddr @blocked4 drop');
  expect(rules.indexOf('ip daddr @blocked4 drop')).toBeLessThan(
    rules.indexOf('ip daddr @public4 oifname'),
  );
  expect(f.dependencies.deadline.arm).toHaveBeenCalledOnce();
  await f.admission.refresh();
  expect(f.blockedNetworks).toHaveBeenCalledTimes(2);
  expect(f.dependencies.deadline.renew).toHaveBeenCalledOnce();
});
it('keeps private, reserved, host and other project traffic blocked including replies', () => {
  const rules = protectedBuildRules(
    binding,
    ['8.8.8.8/32', '2606:4700::/48'],
    projectDeadlineLease(binding, 0, null, clock),
    undefined,
    ['eth0'],
  );
  for (const range of [
    '10.0.0.0/8',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '198.18.0.0/15',
    '2002::/16',
    '8.8.8.8/32',
  ])
    expect(rules).toContain(range);
  expect(rules).toContain('ip saddr @blocked4 drop');
  expect(rules).toContain('ct direction reply ct label ==');
  expect(rules).toContain('meta ibrname "veb123456789abc" drop');
  expect(rules).not.toContain('ct state established accept');
  expect(() => protectedBuildRules({ ...binding, bridge: 'vep123456789abc' }, [])).toThrow(
    'Build-only',
  );
});
it('revokes public access on inventory or renewal failure and after retirement', async () => {
  const f = fixture();
  await f.admission.prepare();
  await f.admission.refresh();
  f.blockedNetworks.mockRejectedValueOnce(new Error('inventory missing'));
  await expect(f.admission.refresh()).rejects.toThrow('inventory missing');
  expect(f.dependencies.apply.mock.calls.at(-1)![0]).not.toContain('0.0.0.0/0 timeout');
  expect(await f.admission.resolve('registry.npmjs.org')).toEqual({ addresses: [], ttlSeconds: 1 });
  await f.admission.refresh();
  f.dependencies.deadline.renew.mockRejectedValueOnce(new Error('expired'));
  await expect(f.admission.refresh()).rejects.toThrow('expired');
  await f.admission.retire();
  await expect(f.admission.refresh()).rejects.toThrow('Inactive');
});
