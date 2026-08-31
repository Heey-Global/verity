import { describe, expect, it, vi } from 'vitest';

import type { RunGrantClaims, RunGrantRedemption, SecretEnvelope } from '@verity/secret-contracts';

import {
  createSecretJobGrantResolver,
  SecretJobGrantResolverError,
  type SecretJobGrant,
} from './secret-job-grant-resolver.js';

const ENVELOPE = { envelopeId: 'env-1' } as unknown as SecretEnvelope;

function claims(expiresAt = '2999-01-01T00:00:00Z'): RunGrantClaims {
  return { grantId: 'grant-1', expiresAt } as unknown as RunGrantClaims;
}

function grant(capability = 'cap-1', expiresAt?: string): SecretJobGrant {
  return { capability, claims: claims(expiresAt) };
}

function redemption(jobId: string): RunGrantRedemption {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    jobId,
    requestHash: 'a'.repeat(64),
    workload: {
      executorInstanceId: 'exec-1',
      jobId,
      publicKeyId: 'key-1',
      attestationHash: 'b'.repeat(64),
    },
  } as unknown as RunGrantRedemption;
}

describe('secret job grant resolver', () => {
  it('resolves a bound job to a claims + job-bound seal that redeems the capability', async () => {
    const redeem = vi.fn(() => Promise.resolve(ENVELOPE));
    const resolver = createSecretJobGrantResolver({ redeem });
    resolver.bind('job-1', grant('cap-1'));

    const binding = await resolver.resolve('job-1');
    expect(binding.claims.grantId).toBe('grant-1');

    await expect(binding.sealEnvelope(redemption('job-1'))).resolves.toBe(ENVELOPE);
    expect(redeem).toHaveBeenCalledWith('cap-1', expect.objectContaining({ jobId: 'job-1' }));
  });

  it('rejects resolving a job with no bound grant', async () => {
    const resolver = createSecretJobGrantResolver({ redeem: vi.fn() });
    await expect(resolver.resolve('job-x')).rejects.toBeInstanceOf(SecretJobGrantResolverError);
  });

  it('refuses to bind a second grant onto an existing job', () => {
    const resolver = createSecretJobGrantResolver({ redeem: vi.fn() });
    resolver.bind('job-1', grant('cap-1'));
    expect(() => resolver.bind('job-1', grant('cap-2'))).toThrow(/already bound/);
  });

  it('rejects a seal whose redemption targets a different job, without redeeming', async () => {
    const redeem = vi.fn(() => Promise.resolve(ENVELOPE));
    const resolver = createSecretJobGrantResolver({ redeem });
    resolver.bind('job-1', grant('cap-1'));
    const binding = await resolver.resolve('job-1');

    await expect(binding.sealEnvelope(redemption('job-2'))).rejects.toThrow(/different job/);
    expect(redeem).not.toHaveBeenCalled();
    // The binding is untouched, so a correct seal still works afterwards.
    await expect(binding.sealEnvelope(redemption('job-1'))).resolves.toBe(ENVELOPE);
  });

  it('makes the seal single-use per job and frees the binding on redeem', async () => {
    const redeem = vi.fn(() => Promise.resolve(ENVELOPE));
    const resolver = createSecretJobGrantResolver({ redeem });
    resolver.bind('job-1', grant('cap-1'));
    const binding = await resolver.resolve('job-1');

    await expect(binding.sealEnvelope(redemption('job-1'))).resolves.toBe(ENVELOPE);
    await expect(binding.sealEnvelope(redemption('job-1'))).rejects.toThrow(/already redeemed/);
    expect(redeem).toHaveBeenCalledTimes(1);
    // The binding was consumed, so the job can no longer be resolved.
    await expect(resolver.resolve('job-1')).rejects.toThrow(/no grant bound/);
    expect(resolver.size()).toBe(0);
  });

  it('fails closed when a second resolve of the same job seals after the first consumed it', async () => {
    const redeem = vi.fn(() => Promise.resolve(ENVELOPE));
    const resolver = createSecretJobGrantResolver({ redeem });
    resolver.bind('job-1', grant('cap-1'));

    const first = await resolver.resolve('job-1');
    const second = await resolver.resolve('job-1'); // a second, independent binding for the same job

    await expect(first.sealEnvelope(redemption('job-1'))).resolves.toBe(ENVELOPE);
    // The first seal consumed the shared binding; the second must not redeem a stale capability.
    await expect(second.sealEnvelope(redemption('job-1'))).rejects.toThrow(/already redeemed/);
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it('unbinds a job idempotently and tracks size', async () => {
    const resolver = createSecretJobGrantResolver({ redeem: vi.fn() });
    resolver.bind('job-1', grant());
    resolver.bind('job-2', grant());
    expect(resolver.size()).toBe(2);

    resolver.unbind('job-1');
    resolver.unbind('job-1'); // idempotent
    expect(resolver.size()).toBe(1);
    await expect(resolver.resolve('job-1')).rejects.toThrow(/no grant bound/);
  });

  it('rejects a stale binding held across an unbind + rebind of the same job', async () => {
    const redeem = vi.fn(() => Promise.resolve(ENVELOPE));
    const resolver = createSecretJobGrantResolver({ redeem });
    resolver.bind('job-1', grant('cap-old'));
    const stale = await resolver.resolve('job-1');

    resolver.unbind('job-1');
    resolver.bind('job-1', grant('cap-new')); // a fresh grant for the same jobId

    // The stale binding captured cap-old, which is no longer the bound grant → refuse, don't redeem.
    await expect(stale.sealEnvelope(redemption('job-1'))).rejects.toThrow(/already redeemed/);
    expect(redeem).not.toHaveBeenCalled();
  });

  it('consumes the binding even when the broker redeem rejects (no retry)', async () => {
    const redeem = vi.fn(() => Promise.reject(new Error('broker rejected')));
    const resolver = createSecretJobGrantResolver({ redeem });
    resolver.bind('job-1', grant('cap-1'));
    const binding = await resolver.resolve('job-1');

    await expect(binding.sealEnvelope(redemption('job-1'))).rejects.toThrow(/broker rejected/);
    // The capability was consumed before the await, so a retry through the resolver fails closed.
    await expect(binding.sealEnvelope(redemption('job-1'))).rejects.toThrow(/already redeemed/);
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(resolver.size()).toBe(0);
  });

  it('rejects a concurrent double seal so the capability is redeemed at most once', async () => {
    const redeem = vi.fn(() => Promise.resolve(ENVELOPE));
    const resolver = createSecretJobGrantResolver({ redeem });
    resolver.bind('job-1', grant('cap-1'));
    const binding = await resolver.resolve('job-1');

    const [a, b] = await Promise.allSettled([
      binding.sealEnvelope(redemption('job-1')),
      binding.sealEnvelope(redemption('job-1')),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it('self-expires a bound-but-never-sealed grant past its claims expiry', async () => {
    const clock = { value: new Date('2026-07-19T00:00:00Z') };
    const resolver = createSecretJobGrantResolver({
      redeem: vi.fn(),
      now: () => clock.value,
    });
    resolver.bind('job-1', grant('cap-1', '2026-07-19T00:05:00Z'));
    expect(resolver.size()).toBe(1);

    clock.value = new Date('2026-07-19T00:05:01Z'); // past the grant's expiry
    expect(resolver.size()).toBe(0); // lazily pruned even though unbind was never called
    await expect(resolver.resolve('job-1')).rejects.toThrow(/no grant bound/);
  });
});
