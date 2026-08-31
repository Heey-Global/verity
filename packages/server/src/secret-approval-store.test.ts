import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RunGrantClaims } from '@verity/secret-contracts';

import {
  createInMemorySecretApprovalStore,
  createPostgresSecretApprovalStore,
  SecretAuthorizationRejectedError,
  type SecretDecisionRecorder,
} from './secret-authorization.js';
import { createPostgresSecretAuditLog } from './secret-audit-log.js';
import { createSecretAuditRecorder } from './secret-audit-recorder.js';
import { createPostgresSecretGrantStore } from './secret-grant-broker.js';

const hash = 'a'.repeat(64);
const claims: RunGrantClaims = {
  protocolVersion: 1,
  grantId: 'grant-1',
  requestHash: hash,
  projectId: 'project-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  profile: { id: 'profile-1', version: 1, policyHash: hash },
  aliases: [{ id: 'alias-1', version: 1 }],
  providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
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

async function insert() {
  await createPostgresSecretApprovalStore(ctx.db).insert(
    {
      id: 'approval-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      toolCallId: 'call-1',
      claims,
    },
    hash,
  );
}

describe('Postgres secret approval store', () => {
  it('returns one durable approval for matching tool-call retries and rejects altered retries', async () => {
    const store = createPostgresSecretApprovalStore(ctx.db);
    await expect(
      store.insert(
        {
          id: 'approval-1',
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims,
        },
        hash,
      ),
    ).resolves.toEqual({ approvalId: 'approval-1' });
    await expect(
      store.insert(
        {
          id: 'approval-other-actor',
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims,
        },
        'c'.repeat(64),
      ),
    ).rejects.toThrow(/replay does not match/);
    await store.decide('approval-1', 'user-1', hash, false, '2026-07-19T00:01:00Z');
    await expect(
      store.insert(
        {
          id: 'approval-after-decision',
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims,
        },
        hash,
      ),
    ).resolves.toEqual({ approvalId: 'approval-1' });
    await expect(
      store.insert(
        {
          id: 'approval-retry',
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims: { ...claims, grantId: 'grant-retry', nonce: 'r'.repeat(32) },
        },
        hash,
      ),
    ).resolves.toEqual({ approvalId: 'approval-1' });
    await expect(
      store.insert(
        {
          id: 'approval-altered',
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims: { ...claims, requestHash: 'b'.repeat(64) },
        },
        hash,
      ),
    ).rejects.toThrow(/replay does not match/);
    await expect(
      store.insert(
        {
          id: 'approval-next-turn',
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims: { ...claims, turnId: 'turn-2', grantId: 'grant-next-turn' },
        },
        hash,
      ),
    ).resolves.toEqual({ approvalId: 'approval-next-turn' });
    await expect(ctx.db.selectFrom('secret_approvals').select('id').execute()).resolves.toEqual([
      { id: 'approval-1' },
      { id: 'approval-next-turn' },
    ]);
  });

  it('atomically binds a legacy pending approval on its first authenticated retry', async () => {
    await insert();
    await ctx.db
      .updateTable('secret_approvals')
      .set({ requester_authorization_hash: null })
      .where('id', '=', 'approval-1')
      .execute();
    await expect(
      createPostgresSecretApprovalStore(ctx.db).insert(
        {
          id: 'approval-retry',
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims,
        },
        hash,
      ),
    ).resolves.toEqual({ approvalId: 'approval-1' });
    await expect(
      ctx.db
        .selectFrom('secret_approvals')
        .select('requester_authorization_hash')
        .where('id', '=', 'approval-1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ requester_authorization_hash: hash });
  });

  it('rejects retries of legacy decided approvals whose requester cannot be reconstructed', async () => {
    await insert();
    const store = createPostgresSecretApprovalStore(ctx.db);
    await store.decide('approval-1', 'user-1', hash, false, '2026-07-19T00:01:00Z');
    await ctx.db
      .updateTable('secret_approvals')
      .set({ requester_authorization_hash: null })
      .where('id', '=', 'approval-1')
      .execute();
    await expect(
      store.insert(
        {
          id: 'approval-retry',
          projectId: claims.projectId,
          sessionId: claims.sessionId,
          toolCallId: claims.toolCallId,
          claims,
        },
        hash,
      ),
    ).rejects.toThrow(/replay does not match/);
  });

  it('persists and audits the exact finalized grant claims', async () => {
    await insert();
    const finalized = {
      ...claims,
      issuedAt: '2026-07-19T00:01:00Z',
      expiresAt: '2026-07-19T00:02:00Z',
      nonce: 'f'.repeat(32),
    };
    let recorded: RunGrantClaims | undefined;
    const decided = await createPostgresSecretApprovalStore(ctx.db).decide(
      'approval-1',
      'user-1',
      hash,
      true,
      '2026-07-19T00:01:00Z',
      (_transaction, decision) => {
        recorded = decision.claims;
        return Promise.resolve();
      },
      () => finalized,
    );
    expect(decided.claims).toEqual(finalized);
    expect(recorded).toEqual(finalized);
    const row = await ctx.db.selectFrom('secret_approvals').selectAll().executeTakeFirstOrThrow();
    expect(JSON.parse(row.claims_json)).toEqual(finalized);
  });

  it('survives restart and retains the exact decision provenance', async () => {
    await insert();
    const afterRestart = createPostgresSecretApprovalStore(ctx.db);
    const decided = await afterRestart.decide(
      'approval-1',
      'user-1',
      hash,
      true,
      '2026-07-19T00:01:00Z',
    );
    expect(decided.approval.decision).toBe('approved');
    expect(decided.claims).toEqual(claims);
    const row = await ctx.db.selectFrom('secret_approvals').selectAll().executeTakeFirstOrThrow();
    expect(row.state).toBe('approved');
    expect(row.authorization_hash).toBe(hash);
    expect(row.claims_json).not.toContain('secret-value');
  });

  it('allows only one server to reserve grant issuance', async () => {
    await insert();
    await createPostgresSecretApprovalStore(ctx.db).decide(
      'approval-1',
      'user-1',
      hash,
      true,
      '2026-07-19T00:01:00Z',
    );
    const results = await Promise.allSettled([
      ctx.db
        .transaction()
        .execute((transaction) =>
          createPostgresSecretApprovalStore(ctx.db).reserveGrantIssue('approval-1', transaction),
        ),
      ctx.db
        .transaction()
        .execute((transaction) =>
          createPostgresSecretApprovalStore(ctx.db).reserveGrantIssue('approval-1', transaction),
        ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects durable reservation without a shared transaction', async () => {
    await insert();
    await createPostgresSecretApprovalStore(ctx.db).decide(
      'approval-1',
      'user-1',
      hash,
      true,
      '2026-07-19T00:01:00Z',
    );
    await expect(
      createPostgresSecretApprovalStore(ctx.db).reserveGrantIssue('approval-1'),
    ).rejects.toThrow(/shared transaction/);
  });

  it('rolls reservation back atomically when grant insertion fails', async () => {
    await insert();
    const approvals = createPostgresSecretApprovalStore(ctx.db);
    await approvals.decide('approval-1', 'user-1', hash, true, '2026-07-19T00:01:00Z');
    await expect(
      createPostgresSecretGrantStore(ctx.db).insert(
        { capabilityHash: 'b'.repeat(64), claims },
        async (transaction) => {
          await approvals.reserveGrantIssue('approval-1', transaction);
          throw new Error('issuer transaction failed');
        },
      ),
    ).rejects.toThrow(/issuer transaction failed/);
    const approval = await ctx.db
      .selectFrom('secret_approvals')
      .select('state')
      .where('id', '=', 'approval-1')
      .executeTakeFirstOrThrow();
    expect(approval.state).toBe('approved');
    expect(await ctx.db.selectFrom('secret_run_grants').selectAll().execute()).toEqual([]);
    await expect(
      ctx.db
        .transaction()
        .execute((transaction) => approvals.reserveGrantIssue('approval-1', transaction)),
    ).resolves.toBeUndefined();
  });

  it('rejects a conflicting decision after another server commits', async () => {
    await insert();
    const first = createPostgresSecretApprovalStore(ctx.db);
    await first.decide('approval-1', 'user-1', hash, false, '2026-07-19T00:01:00Z');
    await expect(
      createPostgresSecretApprovalStore(ctx.db).decide(
        'approval-1',
        'user-1',
        hash,
        true,
        '2026-07-19T00:01:01Z',
      ),
    ).rejects.toThrow(SecretAuthorizationRejectedError);
  });

  it('rejects persisted row context that disagrees with frozen claims', async () => {
    const store = createPostgresSecretApprovalStore(ctx.db);
    await expect(
      store.insert(
        {
          id: 'approval-1',
          projectId: 'other-project',
          sessionId: 'session-1',
          toolCallId: 'call-1',
          claims,
        },
        hash,
      ),
    ).rejects.toThrow(/context/);
  });

  it('enforces approval states in the database', async () => {
    await expect(
      ctx.db
        .insertInto('secret_approvals')
        .values({
          id: 'approval-1',
          project_id: 'project-1',
          session_id: 'session-1',
          tool_call_id: 'call-1',
          claims_json: JSON.stringify(claims),
          state: 'unknown',
          actor_id: null,
          authorization_hash: null,
          decision_hash: null,
          decided_at: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects a tampered persisted decision hash on restart', async () => {
    await insert();
    const store = createPostgresSecretApprovalStore(ctx.db);
    await store.decide('approval-1', 'user-1', hash, true, '2026-07-19T00:01:00Z');
    await ctx.db
      .updateTable('secret_approvals')
      .set({ decision_hash: 'b'.repeat(64) })
      .where('id', '=', 'approval-1')
      .execute();
    await expect(
      createPostgresSecretApprovalStore(ctx.db).decide(
        'approval-1',
        'user-1',
        hash,
        true,
        '2026-07-19T00:01:00Z',
      ),
    ).rejects.toThrow(/hash mismatch/);
  });

  function recordApprovalInTx(): SecretDecisionRecorder {
    const recorder = createSecretAuditRecorder(createPostgresSecretAuditLog(ctx.db));
    return (txn, decided) =>
      recorder.approvalDecided(
        {
          claims: decided.claims,
          approvalId: 'approval-1',
          actorHash: hash,
          approved: true,
          at: '2026-07-19T00:01:00Z',
        },
        txn,
      );
  }

  it('co-commits the decision and its audit event in one transaction', async () => {
    await insert();
    const store = createPostgresSecretApprovalStore(ctx.db);
    await store.decide(
      'approval-1',
      'user-1',
      hash,
      true,
      '2026-07-19T00:01:00Z',
      recordApprovalInTx(),
    );

    const row = await ctx.db.selectFrom('secret_approvals').selectAll().executeTakeFirstOrThrow();
    expect(row.state).toBe('approved');
    const auditLog = createPostgresSecretAuditLog(ctx.db);
    const events = await auditLog.query({ projectId: 'project-1' });
    expect(events.map((event) => event.kind)).toEqual(['approval_approved']);
    expect(events[0]!.approvalId).toBe('approval-1');
    expect(await auditLog.verifyChain('project-1')).toEqual({ ok: true, checked: 1 });
  });

  it('rolls the decision back when the co-committed audit append fails', async () => {
    await insert();
    const store = createPostgresSecretApprovalStore(ctx.db);
    const failing: SecretDecisionRecorder = () => Promise.reject(new Error('audit append failed'));
    await expect(
      store.decide('approval-1', 'user-1', hash, true, '2026-07-19T00:01:00Z', failing),
    ).rejects.toThrow(/audit append failed/);

    // Atomic: the failed append rolled the decision back — the approval is still pending, unaudited.
    const row = await ctx.db.selectFrom('secret_approvals').selectAll().executeTakeFirstOrThrow();
    expect(row.state).toBe('pending');
    const events = await createPostgresSecretAuditLog(ctx.db).query({ projectId: 'project-1' });
    expect(events).toHaveLength(0);
  });

  it('records once and does not re-emit on an idempotent repeat decision', async () => {
    await insert();
    const store = createPostgresSecretApprovalStore(ctx.db);
    // A millisecond-precise timestamp survives the timestamptz round-trip so the idempotent-replay
    // path reconstructs the same decision hash and returns instead of rejecting.
    const decidedAt = '2026-07-19T00:01:00.000Z';
    await store.decide('approval-1', 'user-1', hash, true, decidedAt, recordApprovalInTx());
    // Idempotent repeat (same actor + decision) returns without invoking the recorder again.
    await store.decide('approval-1', 'user-1', hash, true, decidedAt, recordApprovalInTx());

    const events = await createPostgresSecretAuditLog(ctx.db).query({ projectId: 'project-1' });
    expect(events.map((event) => event.kind)).toEqual(['approval_approved']);
  });
});

describe('in-memory secret approval store', () => {
  it('keeps an approval pending when claim finalization fails', async () => {
    const store = createInMemorySecretApprovalStore();
    await store.insert(
      {
        id: 'approval-1',
        projectId: claims.projectId,
        sessionId: claims.sessionId,
        toolCallId: claims.toolCallId,
        claims,
      },
      hash,
    );
    await expect(
      store.decide('approval-1', 'user-1', hash, true, '2026-07-19T00:01:00Z', undefined, () => {
        throw new Error('finalization failed');
      }),
    ).rejects.toThrow(/finalization failed/);
    await expect(
      store.decide('approval-1', 'user-1', hash, false, '2026-07-19T00:01:01Z'),
    ).resolves.toMatchObject({ approval: { decision: 'denied' } });
  });
});
