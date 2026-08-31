import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RunGrantClaims } from '@verity/secret-contracts';

import { createPostgresSecretRevocationStore } from './secret-revocation.js';

const hash = 'a'.repeat(64);
const claims: RunGrantClaims = {
  protocolVersion: 1,
  grantId: 'grant-1',
  requestHash: hash,
  projectId: 'project-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  profile: { id: 'profile-1', version: 2, policyHash: hash },
  aliases: [{ id: 'alias-1', version: 3 }],
  providerBindings: [{ id: 'binding-1', version: 4, provider: 'doppler' }],
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

describe('Postgres secret revocation store', () => {
  it.each([
    { kind: 'project' as const, id: 'project-1', version: 0 as const },
    { kind: 'profile' as const, id: 'profile-1', version: 2 },
    { kind: 'alias' as const, id: 'alias-1', version: 3 },
    { kind: 'provider_binding' as const, id: 'binding-1', version: 4 },
  ])('revokes active claims by $kind', async (subject) => {
    const store = createPostgresSecretRevocationStore(ctx.db);
    await expect(store.isClaimsActive(claims)).resolves.toBe(true);
    await store.revoke(
      'project-1',
      subject,
      'disabled for security review',
      '2026-07-19T00:01:00Z',
    );
    await expect(createPostgresSecretRevocationStore(ctx.db).isClaimsActive(claims)).resolves.toBe(
      false,
    );
  });

  it('does not revoke another version or project', async () => {
    const store = createPostgresSecretRevocationStore(ctx.db);
    await store.revoke(
      'project-1',
      { kind: 'alias', id: 'alias-1', version: 2 },
      'old version',
      '2026-07-19T00:01:00Z',
    );
    await store.revoke(
      'project-2',
      { kind: 'project', id: 'project-2', version: 0 },
      'other project',
      '2026-07-19T00:01:00Z',
    );
    await expect(store.isClaimsActive(claims)).resolves.toBe(true);
  });

  it('rejects a mismatched project revocation subject', async () => {
    const store = createPostgresSecretRevocationStore(ctx.db);
    await expect(
      store.revoke(
        'project-1',
        { kind: 'project', id: 'project-2', version: 0 },
        'mismatch',
        '2026-07-19T00:01:00Z',
      ),
    ).rejects.toThrow(/must match/);
  });

  it('enforces revocation kinds in the database', async () => {
    await expect(
      ctx.db
        .insertInto('secret_revocations')
        .values({
          project_id: 'project-1',
          subject_kind: 'unknown',
          subject_id: 'subject-1',
          subject_version: 1,
          reason: 'invalid writer',
          revoked_at: '2026-07-19T00:01:00Z',
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('enforces project subject identity in the database', async () => {
    await expect(
      ctx.db
        .insertInto('secret_revocations')
        .values({
          project_id: 'project-1',
          subject_kind: 'project',
          subject_id: 'project-2',
          subject_version: 0,
          reason: 'invalid writer',
          revoked_at: '2026-07-19T00:01:00Z',
        })
        .execute(),
    ).rejects.toThrow();
  });
});
