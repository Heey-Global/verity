import { describe, expect, it } from 'vitest';

import type { RunGrantClaims, RunGrantRedemption, SecretEnvelope } from '@verity/secret-contracts';

import {
  SecretGrantRejectedError,
  createInMemorySecretGrantStore,
  createSecretGrantBroker,
  secretEnvelopeAadHash,
  type SecretGrantStore,
} from './secret-grant-broker.js';
import { createInMemorySecretAuditLog, type SecretAuditLog } from './secret-audit-log.js';
import { createSecretAuditRecorder } from './secret-audit-recorder.js';

const hash = 'a'.repeat(64);
const issuedAt = '2026-07-19T00:00:00Z';
const expiresAt = '2026-07-19T00:05:00Z';
const now = () => new Date('2026-07-19T00:01:00Z');

function claims(): RunGrantClaims {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    requestHash: hash,
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    profile: { id: 'pilot-profile', version: 1, policyHash: hash },
    aliases: [{ id: 'fake-token', version: 1 }],
    providerBindings: [{ id: 'fake-provider', version: 1, provider: 'doppler' }],
    audience: 'verity-secret-job-executor',
    issuedAt,
    expiresAt,
    nonce: 'n'.repeat(32),
  };
}

function redemption(overrides: Partial<RunGrantRedemption> = {}): RunGrantRedemption {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    jobId: 'job-1',
    requestHash: hash,
    workload: {
      executorInstanceId: 'executor-1',
      jobId: 'job-1',
      publicKeyId: 'key-1',
      attestationHash: hash,
    },
    ...overrides,
  };
}

const envelope: SecretEnvelope = {
  protocolVersion: 1,
  envelopeId: 'envelope-1',
  grantId: 'grant-1',
  jobId: 'job-1',
  recipientKeyId: 'key-1',
  algorithm: 'x25519-hkdf-sha256-aes-256-gcm',
  ephemeralPublicKey: Buffer.alloc(32).toString('base64'),
  nonce: Buffer.alloc(12).toString('base64'),
  aadHash: hash,
  ciphertext: Buffer.from('fake-ciphertext').toString('base64'),
  expiresAt,
};

function broker(store: SecretGrantStore = createInMemorySecretGrantStore()) {
  return createSecretGrantBroker({
    store,
    now,
    authorizeWorkload: async () => true,
    authorizeCurrentClaims: async () => true,
    resolveSecrets: async () => new Map([['fake-token', Buffer.from('marker-secret')]]),
    sealEnvelope: async (grantClaims, grantRedemption) => ({
      ...envelope,
      aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
    }),
  });
}

describe('fake secret grant broker', () => {
  it('issues an opaque capability and redeems it exactly once', async () => {
    const service = broker();
    const issued = await service.issue(claims());
    expect(issued.capability).not.toContain('grant-1');
    const redeemed = await service.redeem(issued.capability, redemption());
    expect(redeemed).toEqual({
      ...envelope,
      aadHash: secretEnvelopeAadHash(claims(), redemption()),
    });
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
      SecretGrantRejectedError,
    );
  });

  it('burns the capability on a context mismatch', async () => {
    const service = broker();
    const issued = await service.issue(claims());
    await expect(
      service.redeem(issued.capability, redemption({ requestHash: 'b'.repeat(64) })),
    ).rejects.toThrow(/context mismatch/);
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(/consumed/);
  });

  it('allows only one winner under concurrent redemption', async () => {
    const service = broker();
    const issued = await service.issue(claims());
    const results = await Promise.allSettled([
      service.redeem(issued.capability, redemption()),
      service.redeem(issued.capability, redemption()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('burns grants rejected by workload authorization', async () => {
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => false,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => new Map(),
      sealEnvelope: async (grantClaims, grantRedemption) => ({
        ...envelope,
        aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
      }),
    });
    const issued = await service.issue(claims());
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
      /workload identity/,
    );
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(/consumed/);
  });

  it('burns a capability when its frozen claims have been revoked', async () => {
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeCurrentClaims: async () => false,
      authorizeWorkload: async () => true,
      resolveSecrets: async () => new Map(),
      sealEnvelope: async () => envelope,
    });
    const issued = await service.issue(claims());
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(/revoked/);
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(/consumed/);
  });

  it('consumes final permission after resolution and before plaintext reaches the sealer', async () => {
    let finalAuthorizations = 0;
    const failing = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeCurrentClaims: async () => true,
      authorizeResolvedClaims: async () => {
        finalAuthorizations += 1;
        return true;
      },
      authorizeWorkload: async () => true,
      resolveSecrets: () => Promise.reject(new Error('provider unavailable')),
      sealEnvelope: async () => envelope,
    });
    const failedGrant = await failing.issue(claims());
    await expect(failing.redeem(failedGrant.capability, redemption())).rejects.toThrow(
      /provider unavailable/,
    );
    expect(finalAuthorizations).toBe(0);

    const successful = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeCurrentClaims: async () => true,
      authorizeResolvedClaims: async () => {
        finalAuthorizations += 1;
        return true;
      },
      authorizeWorkload: async () => true,
      resolveSecrets: async () => new Map([['fake-token', Buffer.from('marker-secret')]]),
      sealEnvelope: async (grantClaims, grantRedemption) => ({
        ...envelope,
        aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
      }),
    });
    const successfulGrant = await successful.issue(claims());
    await expect(
      successful.redeem(successfulGrant.capability, redemption()),
    ).resolves.toBeDefined();
    expect(finalAuthorizations).toBe(1);

    const sealingFailure = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeCurrentClaims: async () => true,
      authorizeResolvedClaims: async () => {
        finalAuthorizations += 1;
        return true;
      },
      authorizeWorkload: async () => true,
      resolveSecrets: async () => new Map([['fake-token', Buffer.from('marker-secret')]]),
      sealEnvelope: () => Promise.reject(new Error('sealing failed')),
    });
    const sealingGrant = await sealingFailure.issue(claims());
    await expect(sealingFailure.redeem(sealingGrant.capability, redemption())).rejects.toThrow(
      /sealing failed/,
    );
    expect(finalAuthorizations).toBe(2);
  });

  it('rejects and burns an envelope whose context was widened by its sealer', async () => {
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => true,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => new Map(),
      sealEnvelope: async (grantClaims, grantRedemption) => ({
        ...envelope,
        jobId: 'other-job',
        aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
      }),
    });
    const issued = await service.issue(claims());
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
      /envelope context/,
    );
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(/consumed/);
  });

  it('rejects an envelope that is already expired', async () => {
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => true,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => new Map(),
      sealEnvelope: async (grantClaims, grantRedemption) => ({
        ...envelope,
        expiresAt: now().toISOString(),
        aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
      }),
    });
    const issued = await service.issue(claims());
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
      /envelope context/,
    );
  });

  function recordingBroker(overrides: Record<string, unknown> = {}) {
    const log = createInMemorySecretAuditLog();
    const errors: unknown[] = [];
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => true,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => new Map([['fake-token', Buffer.from('marker-secret')]]),
      sealEnvelope: async (grantClaims, grantRedemption) => ({
        ...envelope,
        aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
      }),
      recorder: createSecretAuditRecorder(log, { onError: (error) => errors.push(error) }),
      ...overrides,
    });
    return { service, log, errors };
  }

  it('records grant_redeemed on a successful redemption', async () => {
    const { service, log } = recordingBroker();
    const issued = await service.issue(claims());
    await service.redeem(issued.capability, redemption());

    const events = await log.query({ projectId: 'project-1' });
    expect(events.map((event) => event.kind)).toEqual(['grant_redeemed']);
    expect(events[0]!.grantId).toBe('grant-1');
    expect(events[0]!.jobId).toBe('job-1');
    expect(JSON.stringify(events)).not.toContain('marker-secret');
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 1 });
  });

  it('records grant_redemption_refused when a redemption is denied', async () => {
    const { service, log } = recordingBroker({ authorizeWorkload: async () => false });
    const issued = await service.issue(claims());
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
      /workload identity/,
    );

    const events = await log.query({ projectId: 'project-1' });
    expect(events.map((event) => event.kind)).toEqual(['grant_redemption_refused']);
    expect(events[0]!.grantId).toBe('grant-1');
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 1 });
  });

  it('records a redacted refusal when provider resolution fails', async () => {
    const providerSecret = 'provider-secret-must-not-enter-audit';
    const { service, log } = recordingBroker({
      resolveSecrets: async () => {
        throw new Error(`provider unavailable: ${providerSecret}`);
      },
    });
    const issued = await service.issue(claims());
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
      /provider unavailable/,
    );

    const events = await log.query({ projectId: 'project-1' });
    expect(events.map((event) => event.kind)).toEqual(['grant_redemption_refused']);
    expect(JSON.stringify(events)).not.toContain(providerSecret);
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 1 });
  });

  it.each([
    ['successful sealing', false],
    ['a sealing failure', true],
  ])('zeroizes resolved secret buffers after %s', async (_name, sealFails) => {
    const secret = Buffer.from('provider-secret-to-zeroize');
    const resolved = new Map<string, Uint8Array>([['API_TOKEN', secret]]) as unknown as Map<
      string,
      Uint8Array
    > & {
      dispose(): void;
    };
    resolved.dispose = () => secret.fill(0);
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => true,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => resolved,
      sealEnvelope: async (grantClaims, grantRedemption) => {
        if (sealFails) throw new Error('sealer unavailable');
        return {
          ...envelope,
          aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
        };
      },
    });
    const issued = await service.issue(claims());
    if (sealFails) {
      await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
        /sealer unavailable/,
      );
    } else {
      await service.redeem(issued.capability, redemption());
    }
    expect([...secret]).toEqual(new Array(secret.length).fill(0));
  });

  it('does not mutate shared resolver buffers without an ownership hook', async () => {
    const shared = Buffer.from('shared-provider-cache');
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => true,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => new Map([['API_TOKEN', shared]]),
      sealEnvelope: async (grantClaims, grantRedemption) => ({
        ...envelope,
        aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
      }),
    });
    const issued = await service.issue(claims());
    await service.redeem(issued.capability, redemption());
    expect(shared.toString()).toBe('shared-provider-cache');
  });

  it.each([
    ['successful sealing', false],
    ['a sealing failure', true],
  ])('preserves %s when resolver disposal throws', async (_name, sealFails) => {
    const resolved = new Map<string, Uint8Array>([
      ['API_TOKEN', Buffer.from('owned-provider-secret')],
    ]) as unknown as Map<string, Uint8Array> & { dispose(): void };
    resolved.dispose = () => {
      throw new Error('disposal failed');
    };
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => true,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => resolved,
      sealEnvelope: async (grantClaims, grantRedemption) => {
        if (sealFails) throw new Error('authoritative sealer failure');
        return {
          ...envelope,
          aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
        };
      },
    });
    const issued = await service.issue(claims());
    if (sealFails) {
      await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
        /authoritative sealer failure/,
      );
    } else {
      await expect(service.redeem(issued.capability, redemption())).resolves.toMatchObject({
        grantId: 'grant-1',
      });
    }
  });

  it('never lets a failing recorder block envelope delivery', async () => {
    const failing: SecretAuditLog = {
      append: () => Promise.reject(new Error('audit store down')),
      query: () => Promise.resolve([]),
      verifyChain: () => Promise.resolve({ ok: true, checked: 0 }),
    };
    const errors: unknown[] = [];
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => true,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => new Map([['fake-token', Buffer.from('marker-secret')]]),
      sealEnvelope: async (grantClaims, grantRedemption) => ({
        ...envelope,
        aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
      }),
      recorder: createSecretAuditRecorder(failing, { onError: (error) => errors.push(error) }),
    });
    const issued = await service.issue(claims());
    const redeemed = await service.redeem(issued.capability, redemption());
    expect(redeemed.grantId).toBe('grant-1');
    expect(errors).toHaveLength(1);
  });

  it('does not record a refusal when the successful-redemption audit fails', async () => {
    const attemptedKinds: string[] = [];
    const failing: SecretAuditLog = {
      append: (event) => {
        attemptedKinds.push(event.kind);
        return Promise.reject(new Error('audit store down'));
      },
      query: () => Promise.resolve([]),
      verifyChain: () => Promise.resolve({ ok: true, checked: 0 }),
    };
    const service = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      now,
      authorizeWorkload: async () => true,
      authorizeCurrentClaims: async () => true,
      resolveSecrets: async () => new Map([['fake-token', Buffer.from('marker-secret')]]),
      sealEnvelope: async (grantClaims, grantRedemption) => ({
        ...envelope,
        aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
      }),
      recorder: createSecretAuditRecorder(failing, { failureMode: 'fail-closed' }),
    });
    const issued = await service.issue(claims());
    await expect(service.redeem(issued.capability, redemption())).rejects.toThrow(
      /audit store down/,
    );
    expect(attemptedKinds).toEqual(['grant_redeemed']);
  });

  it('does not persist raw capabilities or fake secret values', async () => {
    let inserted = '';
    const backing = createInMemorySecretGrantStore();
    const store: SecretGrantStore = {
      async insert(record) {
        inserted = JSON.stringify(record);
        await backing.insert(record);
      },
      consume: (capabilityHash, consumedAt) => backing.consume(capabilityHash, consumedAt),
      purgeExpired: (before) => backing.purgeExpired(before),
    };
    const service = broker(store);
    const issued = await service.issue(claims());
    expect(inserted).not.toContain(issued.capability);
    expect(inserted).not.toContain('marker-secret');
  });
});
