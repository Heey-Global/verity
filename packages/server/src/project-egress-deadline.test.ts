import { expect, it } from 'vitest';
import { projectDeadlineLease, type ProjectDeadlineClock } from './project-egress-deadline.js';
import type { ProjectFenceBinding } from './project-egress-fence.js';

const binding: ProjectFenceBinding = {
  projectId: 'deadline-project',
  generation: 'generation-1',
  containerId: 'a'.repeat(64),
  networkId: 'b'.repeat(64),
  endpointId: 'c'.repeat(64),
  bridge: 've-deadline',
  ipv4: '172.30.106.2',
  ipv6: 'fd42:feed:6::2',
};
const clock: ProjectDeadlineClock = {
  bootId: 'c5bc8433-b1ee-424e-94fe-fb91b0f77f69',
  realNs: '1000000000000',
  bootBeforeNs: '5000000000',
  bootAfterNs: '5000010000',
};

it('caps standing authority to one second captured before asynchronous admission', () => {
  const lease = projectDeadlineLease(binding, 1, null, clock);
  expect(lease.bootDeadlineNs).toBe('6000000000');
  expect(lease.authorityBootDeadlines).toEqual({});
  expect(Object.isFrozen(lease)).toBe(true);
  // Serialization into an executor request must not turn it into a fresh TTL.
  expect(JSON.parse(JSON.stringify(lease)).bootDeadlineNs).toBe(lease.bootDeadlineNs);
});

it('uses the shorter absolute authority budget and omits already expired authority', () => {
  expect(projectDeadlineLease(binding, 1, 1_000_250, clock).bootDeadlineNs).toBe('5250000000');
  expect(projectDeadlineLease(binding, 1, 1_010_000, clock).authorityBootDeadlines['1010000']).toBe(
    '15000000000',
  );
  expect(projectDeadlineLease(binding, 1, 1_000_000, clock).bootDeadlineNs).toBe('0');
  expect(projectDeadlineLease(binding, 1, 999_999, clock).bootDeadlineNs).toBe('0');
});

it('binds exact boot, generation, endpoint and policy identity with fresh admission nonces', () => {
  const first = projectDeadlineLease(binding, 1, null, clock);
  expect(first.bootId).toBe(clock.bootId);
  expect(first.revision).toBe(1);
  expect(projectDeadlineLease(binding, 1, null, clock).nonce).not.toBe(first.nonce);
  for (const change of [
    { generation: 'generation-2' },
    { containerId: 'd'.repeat(64) },
    { endpointId: 'e'.repeat(64) },
    { bridge: 've-other' },
  ]) {
    expect(projectDeadlineLease({ ...binding, ...change }, 1, null, clock).binding).not.toBe(
      first.binding,
    );
  }
});

it('rejects unbounded or reversed cross-clock samples rather than assuming a reserve', () => {
  for (const bootAfterNs of ['4999999999', '5001000001']) {
    expect(() => projectDeadlineLease(binding, 1, null, { ...clock, bootAfterNs })).toThrow(
      'bounded',
    );
  }
});

it('rejects imprecise authority or revision input', () => {
  for (const expires of [
    NaN,
    Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(() => projectDeadlineLease(binding, 1, expires, clock)).toThrow('expiry');
  for (const revision of [-1, 0.5, Infinity])
    expect(() => projectDeadlineLease(binding, revision, null, clock)).toThrow('revision');
});

it('rejects kernel clock overflow before serializing a map update', () => {
  const maximum = ((1n << 64n) - 1n).toString();
  expect(() =>
    projectDeadlineLease(binding, 1, null, {
      ...clock,
      bootBeforeNs: maximum,
      bootAfterNs: maximum,
    }),
  ).toThrow('uint64');
  for (const field of ['realNs', 'bootBeforeNs', 'bootAfterNs']) {
    expect(() =>
      projectDeadlineLease(binding, 1, null, {
        ...clock,
        [field]: (1n << 64n).toString(),
      }),
    ).toThrow('uint64');
  }
});

it('maps every overlapping authority from the same immutable clock sample', () => {
  const lease = projectDeadlineLease(binding, 1, 1_000_250, clock, [1_010_000, 1_000_250]);
  expect(lease.authorityBootDeadlines).toEqual({
    '1000250': '5250000000',
    '1010000': '15000000000',
  });
  expect(Object.isFrozen(lease.authorityBootDeadlines)).toBe(true);
  expect(() => projectDeadlineLease(binding, 1, 1_000_250, clock, [1_010_000])).toThrow(
    'expiry set',
  );
});
