import { expect, it, vi } from 'vitest';
import type { EgressPolicy } from '@verity/store';
import { createProjectEgressAdmission } from './project-egress-admission.js';

function fixture() {
  const binding = {
    projectId: 'project',
    generation: 'generation',
    containerId: 'a'.repeat(64),
    networkId: 'b'.repeat(64),
    endpointId: 'c'.repeat(64),
    bridge: 've-project',
    ipv4: '172.30.1.2',
    ipv6: 'fd42::2',
  };
  let policy: EgressPolicy = {
    revision: 1,
    requests: {},
    grants: [
      {
        id: 'grant',
        target: { host: 'downloads.example.com', protocol: 'tcp', port: 443 },
        approvedBy: 'manager',
        approvedAt: 0,
        expiresAt: 10000,
      },
    ],
  };
  const events: string[] = [];
  const store = {
    readForAdmission: vi.fn(async (projectId: string, sponsor: string, revision?: number) => {
      events.push('read');
      if (
        projectId !== binding.projectId ||
        sponsor !== 'sponsor' ||
        (revision !== undefined && revision !== policy.revision)
      )
        throw new Error('stale authority');
      return structuredClone(policy);
    }),
  };
  const dependencies = {
    deadline: {
      prepare: vi.fn(async () => undefined),
      revoke: vi.fn(async () => {
        events.push('revoke');
      }),
      arm: vi.fn(async () => undefined),
      clock: vi.fn(async () => ({
        bootId: 'c5bc8433-b1ee-424e-94fe-fb91b0f77f69',
        realNs: '1000000000',
        bootBeforeNs: '1000000000',
        bootAfterNs: '1000000000',
      })),
    },
    inspect: vi.fn(async () => ({ ...binding })),
    directTargetAllowed: vi.fn(async () => true),
    destinationAllowed: vi.fn(async () => true),
    resolve: vi.fn(async () => ({ addresses: ['8.8.8.8'], expiresAt: 30000 })),
    apply: vi.fn(async (script: string) => {
      events.push(script.includes('elements =') ? 'allow' : 'deny');
    }),
    now: () => 1000,
  };
  return {
    binding,
    store,
    dependencies,
    events,
    admission: createProjectEgressAdmission({
      binding,
      sponsorUserId: 'sponsor',
      store,
      dependencies,
    }),
    setPolicy: (value: EgressPolicy) => {
      policy = value;
    },
  };
}

it('loads durable policy after denial and rechecks sponsor and revision before admission', async () => {
  const f = fixture();
  await f.admission.prepare();
  f.events.length = 0;
  await f.admission.refresh();
  expect(f.events.slice(0, 3)).toEqual(['revoke', 'deny', 'read']);
  expect(f.store.readForAdmission.mock.calls).toEqual([
    ['project', 'sponsor'],
    ['project', 'sponsor', 1],
    ['project', 'sponsor', 1],
  ]);
  expect(f.events.at(-1)).toBe('allow');
});

it('closes existing access before a sponsor loses authority or the store fails', async () => {
  const f = fixture();
  await f.admission.prepare();
  await f.admission.refresh();
  f.store.readForAdmission.mockRejectedValue(new Error('forbidden'));
  await expect(f.admission.refresh()).rejects.toThrow('forbidden');
  expect(f.dependencies.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});

it('does not read or admit replacement authority when revocation fails', async () => {
  const f = fixture();
  await f.admission.prepare();
  f.dependencies.deadline.revoke.mockRejectedValue(new Error('guard unavailable'));
  await expect(f.admission.refresh()).rejects.toThrow('guard unavailable');
  expect(f.store.readForAdmission).not.toHaveBeenCalled();
  expect(f.dependencies.deadline.arm).not.toHaveBeenCalled();
  expect(f.dependencies.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});

it.each([1, 2, 3])(
  'invalidates a refresh paused at authority read %i before completing a concurrent revoke',
  async (pauseAt) => {
    const f = fixture();
    await f.admission.prepare();
    const policy = await f.store.readForAdmission('project', 'sponsor');
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reads = 0;
    f.store.readForAdmission.mockImplementation(async () => {
      if (++reads === pauseAt) {
        entered();
        await paused;
      }
      return policy;
    });
    const refreshing = f.admission.refresh();
    const rejected = expect(refreshing).rejects.toThrow(/superseded|authority changed/u);
    await reading;
    const revoked = f.admission.revoke();
    release();
    await rejected;
    await revoked;
    expect(f.dependencies.deadline.arm).not.toHaveBeenCalled();
    expect(f.dependencies.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
    await f.admission.refresh();
    expect(f.dependencies.deadline.arm).toHaveBeenCalledOnce();
  },
);

it('rejects policy changes during DNS work and keeps the generation denied', async () => {
  const f = fixture();
  await f.admission.prepare();
  f.dependencies.resolve.mockImplementation(async () => {
    f.setPolicy({ revision: 2, requests: {}, grants: [] });
    return { addresses: ['8.8.8.8'], expiresAt: 30000 };
  });
  await expect(f.admission.refresh()).rejects.toThrow('stale');
  expect(f.dependencies.deadline.arm).not.toHaveBeenCalled();
  expect(f.dependencies.apply.mock.calls.at(-1)![0]).not.toContain('elements =');
});

it('rejects same-revision grant tampering and does not reactivate a retired generation', async () => {
  const f = fixture();
  await f.admission.prepare();
  f.dependencies.resolve.mockImplementation(async () => {
    f.setPolicy({ revision: 1, requests: {}, grants: [] });
    return { addresses: ['8.8.8.8'], expiresAt: 30000 };
  });
  await expect(f.admission.refresh()).rejects.toThrow('authority changed');
  expect(f.dependencies.deadline.arm).not.toHaveBeenCalled();
  await f.admission.retire();
  await expect(f.admission.refresh()).rejects.toThrow('Inactive');
});
