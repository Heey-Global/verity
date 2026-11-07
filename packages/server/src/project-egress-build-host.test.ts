import { expect, it, vi } from 'vitest';
import {
  protectedBuildBootstrapRules,
  protectedBuildHostConfig,
  protectedBuildDockerHost,
  protectedBuildResourcesReady,
  protectedBuildResult,
  protectedBuildUnitEnded,
  readProtectedBuildUnit,
} from './project-egress-build-host.js';

const budget = 'LoadState=loaded\nMemoryMax=4294967296\nCPUQuotaPerSecUSec=2s\nTasksMax=1024';
const active =
  'Slice=verity-buildkit.slice\nActiveState=active\nControlGroup=/verity.slice/verity-buildkit.slice/verity-buildkit.service';
it('requires all finite shared limits and actual active daemon membership', () => {
  expect(protectedBuildResourcesReady(budget, active)).toBe(true);
  for (const name of ['MemoryMax', 'CPUQuotaPerSecUSec', 'TasksMax']) {
    expect(
      protectedBuildResourcesReady(
        budget.replace(new RegExp(`${name}=.*`), `${name}=infinity`),
        active,
      ),
    ).toBe(false);
    expect(protectedBuildResourcesReady(budget.replace(new RegExp(`${name}=.*`), ''), active)).toBe(
      false,
    );
  }
  expect(
    protectedBuildResourcesReady(
      budget,
      active.replace('/verity.slice/verity-buildkit.slice/', '/system.slice/'),
    ),
  ).toBe(false);
  expect(
    protectedBuildResourcesReady(
      budget,
      'Slice=verity-buildkit.slice\nActiveState=inactive\nControlGroup=',
    ),
  ).toBe(true);
});
it('never interprets inactive systemd state as whole-cgroup termination', async () => {
  const state = {
    LoadState: 'loaded',
    ActiveState: 'inactive',
    ControlGroup: '/verity.slice/verity-buildkit.slice/verity-protected-build-abc.service',
  };
  const read = vi.fn(async () => 'populated 1\nfrozen 0\n');
  expect(await protectedBuildUnitEnded(state, read)).toBe(false);
  read.mockResolvedValue('populated 0\nfrozen 0\n');
  expect(await protectedBuildUnitEnded(state, read)).toBe(true);
  read.mockResolvedValue('');
  expect(await protectedBuildUnitEnded(state, read)).toBe(false);
  await expect(
    protectedBuildUnitEnded({ ...state, ControlGroup: '/system.slice/foreign.service' }, read),
  ).rejects.toThrow('Untrusted');
  await expect(
    protectedBuildUnitEnded({ ...state, ControlGroup: state.ControlGroup + '/../escape' }, read),
  ).rejects.toThrow('Untrusted');
  read.mockRejectedValue(Object.assign(new Error('permission'), { code: 'EACCES' }));
  await expect(protectedBuildUnitEnded(state, read)).rejects.toThrow('permission');
  read.mockRejectedValue(Object.assign(new Error('removed'), { code: 'ENOENT' }));
  expect(await protectedBuildUnitEnded(state, read)).toBe(true);
});
it('requires versioned helper outcome and immutable anchor identity', () => {
  expect(protectedBuildResult.safeParse({ version: 1, state: 'succeeded' }).success).toBe(true);
  for (const value of [
    undefined,
    { state: 'succeeded' },
    { version: 1, state: 'succeeded', command: 'other' },
  ])
    expect(protectedBuildResult.safeParse(value).success).toBe(false);
  expect(
    protectedBuildHostConfig.safeParse({
      version: 1,
      imageRef: 'sha256:' + 'a'.repeat(64),
      dataVolume: 'verity-data',
    }).success,
  ).toBe(true);
  expect(
    protectedBuildHostConfig.safeParse({
      version: 1,
      imageRef: 'image:latest',
      dataVolume: 'verity-data',
    }).success,
  ).toBe(false);
});
it('restored wildcard fence contains all reserved build bridges without runtime exemptions', () => {
  const denied = protectedBuildBootstrapRules();
  expect(denied).toContain('iifname "veb*" iifname != @active counter drop');
  expect(denied).toContain('meta ibrname "veb*" meta ibrname != @active counter drop');
  expect(denied).not.toContain('elements =');
  expect(denied).not.toContain('vep');
  expect(() => protectedBuildBootstrapRules(['vep123'])).toThrow();
});

it('recognizes systemctl nonzero missing-unit replies without accepting bus or permission failures', async () => {
  const name = 'verity-protected-build-' + 'a'.repeat(32) + '.service';
  const missing = Object.assign(new Error('missing'), {
    code: 1,
    stdout: 'LoadState=not-found\nActiveState=inactive\nControlGroup=\n',
  });
  const run = vi.fn(async (): Promise<string> => {
    throw missing;
  });
  expect(await readProtectedBuildUnit(name, run)).toMatchObject({ LoadState: 'not-found' });
  for (const error of [
    Object.assign(new Error('bus failed'), { code: 1, stdout: '' }),
    Object.assign(new Error('permission'), { code: 'EACCES', stdout: missing.stdout }),
    Object.assign(new Error('changed'), {
      code: 1,
      stdout: missing.stdout.replace('inactive', 'active'),
    }),
  ]) {
    run.mockRejectedValue(error);
    await expect(readProtectedBuildUnit(name, run)).rejects.toThrow();
  }
});

it('requires unified systemd Docker cgroups so the anchor shares the actual builder slice', () => {
  expect(
    protectedBuildDockerHost.safeParse({ CgroupDriver: 'systemd', CgroupVersion: '2' }).success,
  ).toBe(true);
  expect(
    protectedBuildDockerHost.safeParse({ CgroupDriver: 'cgroupfs', CgroupVersion: '2' }).success,
  ).toBe(false);
  expect(
    protectedBuildDockerHost.safeParse({ CgroupDriver: 'systemd', CgroupVersion: '1' }).success,
  ).toBe(false);
});

it('proves retained successful units empty without needing exported Server artifacts', async () => {
  const state = {
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'exited',
    Result: 'success',
    ControlGroup: '/verity.slice/verity-buildkit.slice/verity-protected-build-abc.service',
  };
  const read = vi.fn(async () => 'populated 0\n');
  expect(await protectedBuildUnitEnded(state, read)).toBe(true);
  expect(read).toHaveBeenCalledExactlyOnceWith(
    '/sys/fs/cgroup' + state.ControlGroup + '/cgroup.events',
  );
  read.mockResolvedValue('populated 1\n');
  expect(await protectedBuildUnitEnded(state, read)).toBe(false);
});
