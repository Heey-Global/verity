import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  SECRET_AUDIT_GENESIS_HASH,
  verifySecretAuditChain,
  type RunGrantClaims,
  type SecretAuditEvent,
  type SecretAuditEventInput,
} from '@verity/secret-contracts';

import {
  createInMemorySecretAuditLog,
  createPostgresSecretAuditLog,
  secretAuditProjectionFromClaims,
  secretAuditSha256Hex,
  type SecretAuditLog,
} from './secret-audit-log.js';

const REQUEST_HASH = 'a'.repeat(64);
const POLICY_HASH = 'b'.repeat(64);

function event(overrides: Partial<SecretAuditEventInput> = {}): SecretAuditEventInput {
  return {
    projectId: 'project-1',
    kind: 'grant_issued',
    requestHash: REQUEST_HASH,
    grantId: 'grant-1',
    aliases: [{ id: 'alias-1', version: 1 }],
    providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
    profile: { id: 'kubernetes-read', version: 1, policyHash: POLICY_HASH },
    recordedAt: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

const REQUEST_MAC = 'c'.repeat(64);

/** One gateway call record (ADR 0014 D3): a keyed MAC in place of the lifecycle requestHash. */
function gatewayEvent(
  kind: 'gateway_call_received' | 'gateway_call_served' | 'gateway_call_rejected',
  gateway: Partial<NonNullable<SecretAuditEventInput['gateway']>> = {},
): SecretAuditEventInput {
  return {
    ...event({ kind, grantId: undefined, requestHash: undefined }),
    gateway: {
      channel: 'acp-mcp',
      callId: 'gateway-call-1',
      toolName: 'verity_http_request',
      requestMac: REQUEST_MAC,
      macKeyId: 'mac-key-1',
      ...gateway,
    },
  };
}

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

describe.each<[string, () => SecretAuditLog]>([
  ['in-memory', () => createInMemorySecretAuditLog()],
  ['postgres', () => createPostgresSecretAuditLog(ctx.db)],
])('secret audit log (%s)', (_name, makeLog) => {
  it('appends a contiguous, genesis-anchored, verifiable chain', async () => {
    const log = makeLog();
    const e0 = await log.append(event({ kind: 'grant_issued', grantId: 'grant-1' }));
    const e1 = await log.append(
      event({ kind: 'grant_redeemed', grantId: 'grant-1', jobId: 'job-1' }),
    );
    const e2 = await log.append(
      event({ kind: 'job_succeeded', grantId: 'grant-1', jobId: 'job-1' }),
    );

    expect([e0.sequence, e1.sequence, e2.sequence]).toEqual([0, 1, 2]);
    expect(e0.prevHash).toBe(SECRET_AUDIT_GENESIS_HASH);
    expect(e1.prevHash).toBe(e0.eventHash);
    expect(e2.prevHash).toBe(e1.eventHash);
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 3 });
  });

  it('filters by kind, grant, and job, and paginates by sinceSequence', async () => {
    const log = makeLog();
    await log.append(event({ kind: 'grant_issued', grantId: 'grant-1' }));
    await log.append(event({ kind: 'grant_redeemed', grantId: 'grant-1', jobId: 'job-1' }));
    await log.append(event({ kind: 'grant_issued', grantId: 'grant-2' }));

    const redeemed = await log.query({ projectId: 'project-1', kind: 'grant_redeemed' });
    expect(redeemed.map((e) => e.sequence)).toEqual([1]);

    const byGrant2 = await log.query({ projectId: 'project-1', grantId: 'grant-2' });
    expect(byGrant2.map((e) => e.sequence)).toEqual([2]);

    const byJob = await log.query({ projectId: 'project-1', jobId: 'job-1' });
    expect(byJob.map((e) => e.sequence)).toEqual([1]);

    const afterFirst = await log.query({ projectId: 'project-1', sinceSequence: 0 });
    expect(afterFirst.map((e) => e.sequence)).toEqual([1, 2]);

    const firstPage = await log.query({ projectId: 'project-1', limit: 2 });
    expect(firstPage.map((e) => e.sequence)).toEqual([0, 1]);
  });

  it('keeps project chains independent, each anchored at genesis', async () => {
    const log = makeLog();
    const a = await log.append(event({ projectId: 'project-a', grantId: 'grant-a' }));
    const b = await log.append(event({ projectId: 'project-b', grantId: 'grant-b' }));

    expect(a.sequence).toBe(0);
    expect(b.sequence).toBe(0);
    expect(a.prevHash).toBe(SECRET_AUDIT_GENESIS_HASH);
    expect(b.prevHash).toBe(SECRET_AUDIT_GENESIS_HASH);
    expect(await log.query({ projectId: 'project-a' })).toHaveLength(1);
    expect(await log.query({ projectId: 'project-b' })).toHaveLength(1);
    expect(await log.verifyChain('project-a')).toEqual({ ok: true, checked: 1 });
  });

  it('records only the safe projection — no secret-bearing field survives', async () => {
    const log = makeLog();
    const recorded = await log.append(event());
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toMatch(/secret|envelope|capability|ciphertext|private/i);
    expect(Object.keys(recorded).sort()).toEqual(
      [
        'aliases',
        'eventHash',
        'grantId',
        'kind',
        'prevHash',
        'profile',
        'projectId',
        'protocolVersion',
        'providerBindings',
        'recordedAt',
        'requestHash',
        'sequence',
      ].sort(),
    );
  });

  it('threads a gateway call through the same chain as the grant it redeemed', async () => {
    const log = makeLog();
    // The start record is written before the secret resolves, so a call that crashes
    // mid-flight leaves `received` with no outcome — indeterminate, not absent.
    const received = await log.append(gatewayEvent('gateway_call_received'));
    const redeemed = await log.append(
      event({ kind: 'grant_redeemed', grantId: 'grant-1', jobId: 'job-1' }),
    );
    const served = await log.append(gatewayEvent('gateway_call_served', { decision: 'grant' }));

    // One chain, not two logs: the call and the grant it redeemed are ordered against each
    // other, so neither can be produced or dropped without breaking the other's links.
    expect([received.sequence, redeemed.sequence, served.sequence]).toEqual([0, 1, 2]);
    expect(served.prevHash).toBe(redeemed.eventHash);
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 3 });
    expect(received.requestHash).toBeUndefined();
    expect(served.gateway).toMatchObject({ requestMac: REQUEST_MAC, macKeyId: 'mac-key-1' });
  });

  it('reconciles the records of one call by its request MAC', async () => {
    const log = makeLog();
    await log.append(gatewayEvent('gateway_call_received'));
    await log.append(gatewayEvent('gateway_call_received', { requestMac: 'd'.repeat(64) }));
    await log.append(gatewayEvent('gateway_call_served', { decision: 'card' }));

    const call = await log.query({ projectId: 'project-1', requestMac: REQUEST_MAC });
    expect(call.map((e) => e.sequence)).toEqual([0, 2]);
    // A rejected malformed body has no canonical request, so it reconciles with nothing —
    // and must not fall into another call's MAC by matching on absence.
    await log.append(
      gatewayEvent('gateway_call_rejected', {
        rejection: 'malformed_request',
        toolName: undefined,
        requestMac: undefined,
        macKeyId: undefined,
      }),
    );
    expect(
      (await log.query({ projectId: 'project-1', requestMac: REQUEST_MAC })).map((e) => e.sequence),
    ).toEqual([0, 2]);
  });
});

describe('secret audit log (postgres durability)', () => {
  it('detects a mutated stored event via chain verification', async () => {
    const log = createPostgresSecretAuditLog(ctx.db);
    await log.append(event({ kind: 'grant_issued', grantId: 'grant-1' }));
    const target = await log.append(
      event({ kind: 'grant_redeemed', grantId: 'grant-1', jobId: 'job-1' }),
    );
    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 2 });

    // Rewrite the stored projection without fixing its event hash — a silent tamper.
    const forged = JSON.stringify({ ...target, requestHash: 'd'.repeat(64) });
    await ctx.db
      .updateTable('secret_audit_events')
      .set({ event_json: forged })
      .where('project_id', '=', 'project-1')
      .where('sequence', '=', 1)
      .execute();

    expect(await log.verifyChain('project-1')).toMatchObject({
      ok: false,
      brokenAtSequence: 1,
      reason: 'event hash mismatch',
    });
  });

  it('detects tail truncation of stored rows against a trusted head', async () => {
    const log = createPostgresSecretAuditLog(ctx.db);
    await log.append(event({ kind: 'grant_issued', grantId: 'grant-1' }));
    const head = await log.append(
      event({ kind: 'grant_redeemed', grantId: 'grant-1', jobId: 'job-1' }),
    );
    const trustedHead = { sequence: head.sequence, eventHash: head.eventHash };

    // Drop the newest row — a bare prefix remains and still verifies without a head.
    await ctx.db
      .deleteFrom('secret_audit_events')
      .where('project_id', '=', 'project-1')
      .where('sequence', '=', 1)
      .execute();

    expect(await log.verifyChain('project-1')).toEqual({ ok: true, checked: 1 });
    expect(await log.verifyChain('project-1', trustedHead)).toMatchObject({
      ok: false,
      brokenAtSequence: 1,
      reason: 'unexpected chain head',
    });
  });

  it('never surfaces a row whose tampered index column falsely matches a filter', async () => {
    const log = createPostgresSecretAuditLog(ctx.db);
    await log.append(event({ kind: 'grant_issued', grantId: 'grant-1' }));
    await log.append(event({ kind: 'grant_issued', grantId: 'grant-2' }));

    // Tamper only the denormalized grant_id column of the first row (event_json stays 'grant-1').
    await ctx.db
      .updateTable('secret_audit_events')
      .set({ grant_id: 'grant-2' })
      .where('project_id', '=', 'project-1')
      .where('sequence', '=', 0)
      .execute();

    // The query re-applies the hash-covered predicate, so only the genuine grant-2 row is returned.
    const rows = await log.query({ projectId: 'project-1', grantId: 'grant-2' });
    expect(rows.map((e) => e.sequence)).toEqual([1]);
  });

  it('rejects a duplicated event hash at the storage boundary', async () => {
    const log = createPostgresSecretAuditLog(ctx.db);
    const first = await log.append(event({ kind: 'grant_issued', grantId: 'grant-1' }));
    await expect(
      ctx.db
        .insertInto('secret_audit_events')
        .values({
          project_id: 'project-1',
          sequence: 99,
          kind: first.kind,
          request_hash: first.requestHash ?? null,
          grant_id: first.grantId ?? null,
          job_id: null,
          approval_id: null,
          event_json: JSON.stringify(first),
          prev_hash: first.prevHash,
          event_hash: first.eventHash,
          recorded_at: first.recordedAt,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('stores a gateway call with its MAC denormalized and no request hash', async () => {
    const log = createPostgresSecretAuditLog(ctx.db);
    await log.append(gatewayEvent('gateway_call_served', { decision: 'grant' }));

    const row = await ctx.db
      .selectFrom('secret_audit_events')
      .select(['kind', 'request_hash', 'request_mac'])
      .where('project_id', '=', 'project-1')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      kind: 'gateway_call_served',
      request_hash: null,
      request_mac: REQUEST_MAC,
    });
  });

  it('refuses a served call stored with no identifier at all', async () => {
    const log = createPostgresSecretAuditLog(ctx.db);
    const served = await log.append(gatewayEvent('gateway_call_served', { decision: 'grant' }));
    // Dropping the MAC would leave a record that says a call was served and reconciles with
    // nothing — the one shape that looks like evidence while supporting none. Only a
    // rejected malformed body is allowed to identify neither, having parsed nothing.
    await expect(
      ctx.db
        .updateTable('secret_audit_events')
        .set({ request_mac: null })
        .where('project_id', '=', 'project-1')
        .where('sequence', '=', served.sequence)
        .execute(),
    ).rejects.toThrow(/secret_audit_events_identifier_check/);
  });

  it('refuses a stored row that carries both an unkeyed hash and a MAC', async () => {
    const log = createPostgresSecretAuditLog(ctx.db);
    const served = await log.append(gatewayEvent('gateway_call_served', { decision: 'grant' }));
    // The schema already refuses this, but the column pair is writable by anything holding
    // the connection. The CHECK is what keeps the guessable digest out of the table itself,
    // so a writer bypassing the recorder cannot smuggle it in beside the MAC.
    await expect(
      ctx.db
        .updateTable('secret_audit_events')
        .set({ request_hash: REQUEST_HASH })
        .where('project_id', '=', 'project-1')
        .where('sequence', '=', served.sequence)
        .execute(),
    ).rejects.toThrow(/secret_audit_events_identifier_check/);
  });
});

describe('secret audit chain verifier', () => {
  async function realChain(): Promise<SecretAuditEvent[]> {
    const log = createInMemorySecretAuditLog();
    const e0 = await log.append(event({ kind: 'grant_issued', grantId: 'grant-1' }));
    const e1 = await log.append(
      event({ kind: 'grant_redeemed', grantId: 'grant-1', jobId: 'job-1' }),
    );
    const e2 = await log.append(
      event({ kind: 'job_succeeded', grantId: 'grant-1', jobId: 'job-1' }),
    );
    return [e0, e1, e2];
  }

  it('accepts a well-formed chain', async () => {
    expect(verifySecretAuditChain(await realChain(), secretAuditSha256Hex)).toEqual({
      ok: true,
      checked: 3,
    });
  });

  it('detects a mutated event (hash no longer matches)', async () => {
    const [e0, e1, e2] = await realChain();
    const tampered = [e0!, { ...e1!, requestHash: 'd'.repeat(64) }, e2!];
    expect(verifySecretAuditChain(tampered, secretAuditSha256Hex)).toMatchObject({
      ok: false,
      brokenAtSequence: 1,
      reason: 'event hash mismatch',
    });
  });

  it('detects a broken prev-hash link', async () => {
    const [e0, e1] = await realChain();
    const relinked = [e0!, { ...e1!, prevHash: 'e'.repeat(64) }];
    expect(verifySecretAuditChain(relinked, secretAuditSha256Hex)).toMatchObject({
      ok: false,
      brokenAtSequence: 1,
      reason: 'prev hash mismatch',
    });
  });

  it('detects a deleted event via the sequence gap', async () => {
    const [e0, , e2] = await realChain();
    expect(verifySecretAuditChain([e0!, e2!], secretAuditSha256Hex)).toMatchObject({
      ok: false,
      brokenAtSequence: 1,
      reason: 'non-contiguous sequence',
    });
  });

  it('accepts a chain that ends exactly at the trusted head', async () => {
    const events = await realChain();
    const head = { sequence: 2, eventHash: events[2]!.eventHash };
    expect(verifySecretAuditChain(events, secretAuditSha256Hex, head)).toEqual({
      ok: true,
      checked: 3,
    });
  });

  it('detects tail truncation past the trusted head (bare prefix still verifies)', async () => {
    const events = await realChain();
    const head = { sequence: 2, eventHash: events[2]!.eventHash };
    const truncated = events.slice(0, 2);
    // Without a head the shorter prefix still verifies — the documented bare-chain limitation.
    expect(verifySecretAuditChain(truncated, secretAuditSha256Hex)).toEqual({
      ok: true,
      checked: 2,
    });
    // With the trusted head, the missing newest event is caught.
    expect(verifySecretAuditChain(truncated, secretAuditSha256Hex, head)).toMatchObject({
      ok: false,
      brokenAtSequence: 2,
      reason: 'unexpected chain head',
    });
  });

  it('detects a forged head at the right sequence but wrong hash', async () => {
    const events = await realChain();
    const head = { sequence: 2, eventHash: 'f'.repeat(64) };
    expect(verifySecretAuditChain(events, secretAuditSha256Hex, head)).toMatchObject({
      ok: false,
      brokenAtSequence: 2,
      reason: 'head hash mismatch',
    });
  });
});

describe('secretAuditProjectionFromClaims', () => {
  it('narrows claims to the safe audit projection', () => {
    const claims: RunGrantClaims = {
      protocolVersion: 1,
      grantId: 'grant-1',
      requestHash: REQUEST_HASH,
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      profile: { id: 'kubernetes-read', version: 1, policyHash: POLICY_HASH },
      aliases: [{ id: 'alias-1', version: 1 }],
      providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
      audience: 'verity-secret-job-executor',
      issuedAt: '2026-07-20T00:00:00Z',
      expiresAt: '2026-07-20T00:05:00Z',
      nonce: 'n'.repeat(32),
    };
    expect(secretAuditProjectionFromClaims(claims)).toEqual({
      projectId: 'project-1',
      requestHash: REQUEST_HASH,
      grantId: 'grant-1',
      profile: { id: 'kubernetes-read', version: 1, policyHash: POLICY_HASH },
      aliases: [{ id: 'alias-1', version: 1 }],
      providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
    });
  });
});
