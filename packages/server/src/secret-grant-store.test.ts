import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RunGrantClaims, SecretEnvelope } from '@verity/secret-contracts';

import {
  createPostgresSecretGrantStore,
  createSecretGrantBroker,
  secretEnvelopeAadHash,
  type SecretGrantIssueRecorder,
} from './secret-grant-broker.js';
import { createPostgresSecretAuditLog } from './secret-audit-log.js';
import { createSecretAuditRecorder } from './secret-audit-recorder.js';

const hash = 'a'.repeat(64);
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
  ciphertext: Buffer.from('ciphertext').toString('base64'),
  expiresAt: '2026-07-19T00:05:00Z',
};

const claims: RunGrantClaims = {
  protocolVersion: 1,
  grantId: 'grant-1',
  requestHash: hash,
  projectId: 'project-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  profile: { id: 'profile-1', version: 1, policyHash: hash },
  aliases: [{ id: 'fake-token', version: 1 }],
  providerBindings: [{ id: 'fake-provider', version: 1, provider: 'doppler' }],
  audience: 'verity-secret-job-executor',
  issuedAt: '2026-07-19T00:00:00Z',
  expiresAt: '2026-07-19T00:05:00Z',
  nonce: 'n'.repeat(32),
};

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

function broker() {
  return createSecretGrantBroker({
    store: createPostgresSecretGrantStore(ctx.db),
    now: () => new Date('2026-07-19T00:01:00Z'),
    authorizeWorkload: async () => true,
    authorizeCurrentClaims: async () => true,
    resolveSecrets: async () => new Map([['fake-token', Buffer.from('marker-secret')]]),
    sealEnvelope: async (grantClaims, grantRedemption) => ({
      ...envelope,
      aadHash: secretEnvelopeAadHash(grantClaims, grantRedemption),
    }),
  });
}

const redemption = {
  protocolVersion: 1 as const,
  grantId: 'grant-1',
  jobId: 'job-1',
  requestHash: hash,
  workload: {
    executorInstanceId: 'executor-1',
    jobId: 'job-1',
    publicKeyId: 'key-1',
    attestationHash: hash,
  },
};

describe('Postgres secret grant store', () => {
  it('survives broker recreation and still permits only one redemption', async () => {
    const issued = await broker().issue(claims);
    const afterRestart = broker();
    const redeemed = await afterRestart.redeem(issued.capability, redemption);
    expect(redeemed).toEqual({ ...envelope, aadHash: secretEnvelopeAadHash(claims, redemption) });
    await expect(broker().redeem(issued.capability, redemption)).rejects.toThrow(/consumed/);
  });

  it('atomically rejects a concurrent redemption from another broker instance', async () => {
    const issued = await broker().issue(claims);
    const results = await Promise.allSettled([
      broker().redeem(issued.capability, redemption),
      broker().redeem(issued.capability, redemption),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('stores claims and hashes but never capabilities or fake secret values', async () => {
    const issued = await broker().issue(claims);
    const row = await ctx.db.selectFrom('secret_run_grants').selectAll().executeTakeFirstOrThrow();
    expect(row.capability_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(issued.capability);
    expect(JSON.stringify(row)).not.toContain('marker-secret');
  });

  it('purges expired grants deterministically', async () => {
    await broker().issue(claims);
    const store = createPostgresSecretGrantStore(ctx.db);
    await expect(store.purgeExpired('2026-07-19T00:04:59Z')).resolves.toBe(0);
    await expect(store.purgeExpired('2026-07-19T00:05:00Z')).resolves.toBe(1);
  });

  it('co-commits the grant row and its grant_issued event in one transaction', async () => {
    const auditLog = createPostgresSecretAuditLog(ctx.db);
    const recorder = createSecretAuditRecorder(auditLog);
    const recordInTx: SecretGrantIssueRecorder = (txn) =>
      recorder.grantIssued({ claims, at: '2026-07-19T00:01:00Z' }, txn);
    await broker().issue(claims, recordInTx);

    const grantRow = await ctx.db
      .selectFrom('secret_run_grants')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(grantRow.grant_id).toBe('grant-1');
    const events = await auditLog.query({ projectId: 'project-1' });
    expect(events.map((event) => event.kind)).toEqual(['grant_issued']);
    expect(events[0]!.grantId).toBe('grant-1');
    expect(JSON.stringify(events)).not.toContain('marker-secret');
    expect(await auditLog.verifyChain('project-1')).toEqual({ ok: true, checked: 1 });
  });

  it('rolls the grant insert back when the co-committed audit append fails', async () => {
    const failing: SecretGrantIssueRecorder = () =>
      Promise.reject(new Error('audit append failed'));
    await expect(broker().issue(claims, failing)).rejects.toThrow(/audit append failed/);

    // Atomic: no grant row exists and nothing was audited — a live capability is never unaudited.
    const grants = await ctx.db.selectFrom('secret_run_grants').selectAll().execute();
    expect(grants).toHaveLength(0);
    const events = await createPostgresSecretAuditLog(ctx.db).query({ projectId: 'project-1' });
    expect(events).toHaveLength(0);
  });
});
