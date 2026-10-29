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
