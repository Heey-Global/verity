import { describe, expect, it } from 'vitest';

import {
  createSecretWorkerRecipientKeyRegistry,
  SecretWorkerRecipientKeyRegistryError,
} from './secret-worker-recipient-key-registry.js';

const clock = { value: new Date('2026-07-22T00:00:00.000Z') };
const now = () => clock.value;
const workload = {
  executorInstanceId: 'executor-1',
  jobId: 'job-1',
  publicKeyId: 'worker-key-1',
  attestationHash: 'a'.repeat(64),
};

function registration(key = new Uint8Array(32).fill(7)) {
  return { workload, recipientPublicKey: key, expiresAt: '2026-07-22T00:01:00.000Z' };
}

describe('secret worker recipient key registry', () => {
  it('returns a defensive copy exactly once for the bound job', async () => {
    const registry = createSecretWorkerRecipientKeyRegistry({ now });
    const source = new Uint8Array(32).fill(7);
    registry.register(registration(source));
    source.fill(9);
    const resolved = await registry.resolve(workload.publicKeyId, workload.jobId);
    expect(resolved).toEqual(new Uint8Array(32).fill(7));
    resolved?.fill(3);
    await expect(registry.resolve(workload.publicKeyId, workload.jobId)).resolves.toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it('consumes a key on a cross-job lookup', async () => {
    const registry = createSecretWorkerRecipientKeyRegistry({ now });
    registry.register(registration());
    await expect(registry.resolve(workload.publicKeyId, 'job-2')).resolves.toBeUndefined();
    await expect(registry.resolve(workload.publicKeyId, workload.jobId)).resolves.toBeUndefined();
  });

  it('purges expiry and rejects stale registration', async () => {
    const registry = createSecretWorkerRecipientKeyRegistry({ now });
    registry.register(registration());
    clock.value = new Date('2026-07-22T00:01:00.000Z');
    expect(registry.size()).toBe(0);
    expect(() => registry.register(registration())).toThrow(/already expired/);
    clock.value = new Date('2026-07-22T00:00:00.000Z');
  });

  it('fails closed on duplicate, malformed, and over-capacity entries', () => {
    const registry = createSecretWorkerRecipientKeyRegistry({ now, maximumEntries: 1 });
    expect(() => registry.register(registration(new Uint8Array(31)))).toThrow(/32 bytes/);
    registry.register(registration());
    expect(() => registry.register(registration())).toThrow(/already registered/);
    expect(() =>
      registry.register({
        ...registration(),
        workload: { ...workload, publicKeyId: 'worker-key-2' },
      }),
    ).toThrow(/capacity exhausted/);
    expect(SecretWorkerRecipientKeyRegistryError).toBeDefined();
  });

  it('revokes idempotently', async () => {
    const registry = createSecretWorkerRecipientKeyRegistry({ now });
    registry.register(registration());
    registry.revoke(workload.publicKeyId);
    registry.revoke(workload.publicKeyId);
    await expect(registry.resolve(workload.publicKeyId, workload.jobId)).resolves.toBeUndefined();
  });
});
