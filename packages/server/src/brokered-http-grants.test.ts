import type { Database } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createBrokeredHttpGrantStore } from './brokered-http-grants.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
beforeEach(async () => {
  await ctx.store.upsertProject({
    id: 'project-1',
    owner: 'acme',
    repo: 'app',
    containerName: 'verity-acme-app',
    state: 'active',
  });
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

// The attested native relay, which is where every grant below is approved and redeemed
// unless a test says otherwise. ADR 0014's ceiling applies to `acp` only, so `native`
// is also the control: it shows the ceiling changed nothing on the shipped path.
const target = {
  projectId: 'project-1',
  bindingId: 'project-doppler:test-binding',
  sessionId: 'session-1',
  secretAlias: 'REVENUECAT_ADMIN_KEY',
  toolName: 'verity_http_request' as const,
  target: 'api.revenuecat.com',
  channel: 'acp' as const,
};

const acp = { ...target, channel: 'acp' as const };

/**
 * The same database, except that writing a `brokered_grant_approvals` row always
 * fails — standing in for a crash or a failed statement between the grant row and the
 * approval that justifies it. Delegation is explicit rather than a Proxy so every call
 * keeps the real Kysely as `this`; a method the store starts using and this forwarder
 * lacks fails the test loudly instead of passing quietly.
 */
function dbWithFailingApprovalWrite(db: Kysely<Database>): Kysely<Database> {
  const wrapTx = (tx: Kysely<Database>): Kysely<Database> =>
    ({
      selectFrom: tx.selectFrom.bind(tx),
      updateTable: tx.updateTable.bind(tx),
      insertInto: (table: string) => {
        if (table === 'brokered_grant_approvals') throw new Error('approval write failed');
        return tx.insertInto(table as 'secret_provider_permissions');
      },
    }) as unknown as Kysely<Database>;
  return {
    transaction: () => ({
      execute: async <T>(run: (tx: Kysely<Database>) => Promise<T>): Promise<T> =>
        db.transaction().execute(async (tx) => run(wrapTx(tx))),
    }),
  } as unknown as Kysely<Database>;
}

/**
 * The same database, except that the grant-row insert silently writes nothing —
 * standing in for the window where our `ON CONFLICT DO NOTHING` loses to another
 * writer whose row is revoked before we read it back.
 */
function dbWithSwallowedGrantInsert(db: Kysely<Database>): Kysely<Database> {
  const wrapTx = (tx: Kysely<Database>): Kysely<Database> =>
    ({
      selectFrom: tx.selectFrom.bind(tx),
      updateTable: tx.updateTable.bind(tx),
      insertInto: (table: string) =>
        table === 'secret_provider_permissions'
          ? { values: () => ({ onConflict: () => ({ execute: () => Promise.resolve([]) }) }) }
          : tx.insertInto(table as 'brokered_grant_approvals'),
    }) as unknown as Kysely<Database>;
  return {
    transaction: () => ({
      execute: async <T>(run: (tx: Kysely<Database>) => Promise<T>): Promise<T> =>
        db.transaction().execute(async (tx) => run(wrapTx(tx))),
    }),
  } as unknown as Kysely<Database>;
}

/** Backdate every ACP approval record, standing in for the passage of time. */
async function ageAcpApprovals(byMs: number): Promise<void> {
  await ctx.db
    .updateTable('brokered_grant_approvals')
    .set({ approved_at: new Date(Date.now() - byMs).toISOString() })
    .where('channel', '=', 'acp')
    .execute();
}

describe('brokered HTTP grant store (ADR 0011 D2)', () => {
  it('covers matching requests after a project-scoped grant, keyed by alias + origin', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await expect(store.check(target)).resolves.toBe(false);
    await store.grant({ ...target, scope: 'project' });
    await expect(store.check(target)).resolves.toBe(true);
    const projectGrant = await ctx.db
      .selectFrom('secret_provider_permissions')
      .select('expires_at')
      .where('scope', '=', 'project')
      .executeTakeFirstOrThrow();
    expect(projectGrant.expires_at).not.toBeNull();
    expect(new Date(projectGrant.expires_at!).getTime()).toBeGreaterThan(Date.now());
    // Project scope covers other sessions of the same project.
    await expect(store.check({ ...target, sessionId: 'session-2' })).resolves.toBe(true);
    // Different alias or destination host is NOT covered.
    await expect(store.check({ ...target, secretAlias: 'OTHER_KEY' })).resolves.toBe(false);
    await expect(store.check({ ...target, target: 'evil.example' })).resolves.toBe(false);
    await expect(store.check({ ...target, target: 'api.revenuecat.com:8443' })).resolves.toBe(
      false,
    );
    await expect(
      store.check({ ...target, bindingId: 'project-doppler:replacement-binding' }),
    ).resolves.toBe(false);
  });

  it('binds a session-scoped grant to exactly that session', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await store.grant({ ...target, scope: 'session' });
    await expect(store.check(target)).resolves.toBe(true);
    await expect(store.check({ ...target, sessionId: 'session-2' })).resolves.toBe(false);
  });

  it('does not duplicate an already active matching grant', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await Promise.all(
      Array.from({ length: 8 }, async () => store.grant({ ...target, scope: 'project' })),
    );
    const rows = await ctx.db
      .selectFrom('secret_provider_permissions')
      .select('id')
      .where('state', '=', 'active')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('renews an existing project grant for a fresh 30-day window', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await store.grant({ ...target, scope: 'project' });
    await ctx.db
      .updateTable('secret_provider_permissions')
      .set({ expires_at: new Date(Date.now() + 1_000).toISOString() })
      .execute();

    await store.grant({ ...target, scope: 'project' });

    const renewed = await ctx.db
      .selectFrom('secret_provider_permissions')
      .select('expires_at')
      .executeTakeFirstOrThrow();
    expect(new Date(renewed.expires_at!).getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1_000,
    );
  });

  it('lists live grants for review and drops expired ones', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await store.grant({ ...target, scope: 'project' });
    await store.grant({
      ...target,
      toolName: 'verity_secret_run',
      target: `v1:/usr/bin/python3#${'a'.repeat(64)}`,
      scope: 'project',
    });
    const grants = await store.list('project-1', target.bindingId);
    expect(grants).toHaveLength(2);
    // An expired row is still `state = 'active'` until something renews it, but it no
    // longer auto-approves anything, so listing it would overstate the operator's exposure.
    await ctx.db
      .updateTable('secret_provider_permissions')
      .set({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .where('scope', '=', 'project')
      .execute();
    await expect(store.list('project-1', target.bindingId)).resolves.toHaveLength(0);
  });

  it('lists rows it owns, and only those', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await store.grant({ ...target, scope: 'project' });
    // `secret_provider_permissions` is shared with the catalog authorization path, which
    // writes rows this store does not own. A 'once' row never passes check(), so listing
    // it would overstate the operator's exposure — and its scope is not in the client's
    // response schema, so a single such row would break the whole list.
    await ctx.db
      .insertInto('secret_provider_permissions')
      .values({
        id: 'catalog-once',
        project_id: 'project-1',
        binding_id: target.bindingId,
        binding_version: 1,
        secret_name: target.secretAlias,
        tool_id: `verity_http_request:${target.target}`,
        scope: 'once',
        session_id: null,
        expires_at: null,
        remaining_uses: 1,
        granted_by: 'operator',
        state: 'active',
      })
      .execute();
    const grants = await store.list('project-1', target.bindingId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ scope: 'project' });

    // A grant against a superseded binding approves nothing today, but binding ids are
    // derived deterministically, so restoring that binding revives it. It stays listed —
    // flagged, not hidden — because a grant the operator cannot see cannot be revoked.
    const current = 'project-doppler:replacement-binding';
    await expect(store.check({ ...target, bindingId: current })).resolves.toBe(false);
    await expect(store.list('project-1', current)).resolves.toMatchObject([{ appliesNow: false }]);
    await expect(store.list('project-1', target.bindingId)).resolves.toMatchObject([
      { appliesNow: true },
    ]);
    // A project with no binding at all is the same situation, not an absent question:
    // nothing can auto-approve, so nothing may be reported as live.
    await expect(store.list('project-1', null)).resolves.toMatchObject([{ appliesNow: false }]);
    // And it really is revocable through the same route, before any such revival.
    const [dormant] = await store.list('project-1', current);
    await expect(store.revoke('project-1', dormant!.id)).resolves.toBe(true);
    await expect(store.check(target)).resolves.toBe(false);
  });

  it('never lets a foreign row auto-approve a prompt', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    // The catalog authorization path writes to this table too, and `SAFE_ID` permits ':'
    // inside a profile id — so `verity_http_request:<host>` is a legal catalog tool id.
    // Provenance therefore has to be explicit: without this store's issuer, the row must
    // approve nothing, list as nothing, and revoke as nothing.
    await ctx.db
      .insertInto('secret_provider_permissions')
      .values({
        id: 'catalog-forever',
        project_id: 'project-1',
        binding_id: target.bindingId,
        binding_version: 1,
        secret_name: target.secretAlias,
        tool_id: `${target.toolName}:${target.target}`,
        scope: 'forever',
        session_id: null,
        expires_at: null,
        remaining_uses: null,
        granted_by: 'operator',
        state: 'active',
      })
      .execute();
    await expect(store.check(target)).resolves.toBe(false);
    await expect(store.list('project-1', target.bindingId)).resolves.toEqual([]);
    await expect(store.revoke('project-1', 'catalog-forever')).resolves.toBe(false);
  });

  it('never revokes a permission row it did not issue', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    // Rows belonging to the catalog authorization path share this table. An id alone must
    // not be enough to end one through the brokered-grant route.
    const foreign = [
      { id: 'catalog-once', scope: 'once', tool_id: `verity_http_request:${target.target}` },
      { id: 'catalog-tool', scope: 'project', tool_id: 'secret-job:deploy' },
    ];
    for (const row of foreign) {
      await ctx.db
        .insertInto('secret_provider_permissions')
        .values({
          id: row.id,
          project_id: 'project-1',
          binding_id: target.bindingId,
          binding_version: 1,
          secret_name: target.secretAlias,
          tool_id: row.tool_id,
          scope: row.scope,
          session_id: null,
          expires_at: null,
          remaining_uses: null,
          granted_by: 'operator',
          state: 'active',
        })
        .execute();
      await expect(store.revoke('project-1', row.id)).resolves.toBe(false);
      const after = await ctx.db
        .selectFrom('secret_provider_permissions')
        .select('state')
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      expect(after.state).toBe('active');
    }
  });

  it('ends a session-scoped grant when its session is deleted', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await ctx.store.createSession({
      sessionId: target.sessionId,
      worktree: '/worktrees/session-1',
      model: 'codex/default',
      projectId: 'project-1',
    });
    await store.grant({ ...target, scope: 'session' });
    await store.grant({ ...target, scope: 'project' });
    await expect(store.check(target)).resolves.toBe(true);

    await expect(ctx.store.deleteSession(target.sessionId)).resolves.toBe(true);
    // The session grant is gone; the project-wide one is untouched by a session delete.
    const remaining = await store.list('project-1', target.bindingId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ scope: 'project', sessionId: null });
    await ctx.db
      .updateTable('secret_provider_permissions')
      .set({ state: 'revoked' })
      .where('scope', '=', 'project')
      .execute();
    // A restored or reused session id must not inherit the deleted session's grant.
    await expect(store.check(target)).resolves.toBe(false);
  });

  it('never revokes a grant through another project', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await ctx.store.upsertProject({
      id: 'project-2',
      owner: 'acme',
      repo: 'other',
      containerName: 'verity-acme-other',
      state: 'active',
    });
    await store.grant({ ...target, scope: 'project' });
    const [grant] = await store.list('project-1', target.bindingId);
    await expect(store.revoke('project-2', grant!.id)).resolves.toBe(false);
    await expect(store.check(target)).resolves.toBe(true);
  });

  it('creates and redeems a hash-bound trusted CLI grant', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    const run = {
      ...target,
      toolName: 'verity_secret_run' as const,
      target: `v1:/usr/bin/python3#${'a'.repeat(64)}`,
    };
    await store.grant({ ...run, scope: 'project' });
    await expect(store.check(run)).resolves.toBe(true);
  });

  it('keeps legacy generic trusted CLI grants inert', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    const legacy = {
      ...target,
      toolName: 'verity_secret_run' as const,
      target: '/usr/bin/kubectl',
    };
    await expect(store.grant({ ...legacy, scope: 'project' })).rejects.toThrow(/hash-bound/u);
    await expect(store.check(legacy)).resolves.toBe(false);
  });

  it('ignores expired and non-active grants', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await store.grant({ ...target, scope: 'project' });
    await ctx.db
      .updateTable('secret_provider_permissions')
      .set({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .execute();
    await expect(store.check(target)).resolves.toBe(false);
    await store.grant({ ...target, scope: 'project' });
    await expect(store.check(target)).resolves.toBe(true);
    await ctx.db
      .updateTable('secret_provider_permissions')
      .set({ expires_at: null, state: 'revoked' })
      .execute();
    await expect(store.check(target)).resolves.toBe(false);
  });
});

describe('brokered grant channel ceiling (ADR 0014 D3)', () => {
  it('stops auto-approving on ACP after 24 hours', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await store.grant({ ...acp, scope: 'project' });
    await expect(store.check(acp)).resolves.toBe(true);

    await ageAcpApprovals(25 * 60 * 60 * 1_000);

    await expect(store.check(acp)).resolves.toBe(false);
    // The grant row itself remains listed, but no longer auto-approves.
    await expect(store.list('project-1', target.bindingId)).resolves.toHaveLength(1);

    // Answering the card again restarts the window without minting a second grant.
    await store.grant({ ...acp, scope: 'project' });
    await expect(store.check(acp)).resolves.toBe(true);
    const rows = await ctx.db
      .selectFrom('secret_provider_permissions')
      .select('id')
      .where('state', '=', 'active')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('ages out a session-scoped grant on ACP even though the grant row never expires', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await store.grant({ ...acp, scope: 'session' });
    await expect(store.check(acp)).resolves.toBe(true);

    await ageAcpApprovals(25 * 60 * 60 * 1_000);

    // `session` scope stores a NULL expiry, so without the approval record a session
    // grant would auto-approve on ACP for as long as the session lived.
    await expect(store.check(acp)).resolves.toBe(false);
    // Re-approving a live `session` grant writes nothing to the grant row, so the
    // approval record is the only thing that can restart its window.
    await store.grant({ ...acp, scope: 'session' });
    await expect(store.check(acp)).resolves.toBe(true);
  });

  it('refuses a permanent grant on ACP, and never redeems one there', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await expect(store.grant({ ...acp, scope: 'forever' })).rejects.toThrow(/ACP/);
    await expect(
      ctx.db.selectFrom('secret_provider_permissions').select('id').execute(),
    ).resolves.toEqual([]);
  });

  it('keeps a grant redeemable on ACP when the approval row races in from another writer', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    // Concurrent approvals collapse onto one grant row. Each of them still has to leave
    // that row with an ACP approval attached — a grant created by the writer that won
    // the insert but approved by nobody would be dead on this channel from birth.
    await Promise.all(
      Array.from({ length: 8 }, async () => store.grant({ ...acp, scope: 'project' })),
    );
    await expect(store.check(acp)).resolves.toBe(true);
    const approvals = await ctx.db.selectFrom('brokered_grant_approvals').selectAll().execute();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ channel: 'acp' });
  });

  it('leaves nothing behind when the approval record cannot be written', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    const failing = createBrokeredHttpGrantStore(dbWithFailingApprovalWrite(ctx.db));

    // A grant whose approval write fails must not survive the failure. It would be a
    // grant the operator was told did not happen, live on the native channel — which
    // never reads an approval record — while dead on the one that does.
    await expect(failing.grant({ ...acp, scope: 'project' })).rejects.toThrow(
      'approval write failed',
    );
    await expect(
      ctx.db.selectFrom('secret_provider_permissions').selectAll().execute(),
    ).resolves.toEqual([]);
    await expect(store.check(acp)).resolves.toBe(false);
    await expect(store.check(target)).resolves.toBe(false);

    // The same holds for a renewal: the rolling project window must not move when the
    // approval that was supposed to justify it never landed.
    await store.grant({ ...acp, scope: 'project' });
    const before = await ctx.db
      .selectFrom('secret_provider_permissions')
      .select('expires_at')
      .executeTakeFirstOrThrow();
    await expect(failing.grant({ ...acp, scope: 'project' })).rejects.toThrow(
      'approval write failed',
    );
    await expect(
      ctx.db.selectFrom('secret_provider_permissions').select('expires_at').execute(),
    ).resolves.toEqual([before]);
  });

  it('reports failure when the grant it approved is gone by the time it reads it back', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    const racing = createBrokeredHttpGrantStore(dbWithSwallowedGrantInsert(ctx.db));

    // The insert conflicted with a row that no longer exists — a revoke landed in
    // between. Succeeding here would tell the operator the scope was saved and then
    // prompt again on the next call, with nothing to point at.
    await expect(racing.grant({ ...acp, scope: 'project' })).rejects.toThrow(
      'revoked while it was being approved',
    );
    await expect(
      ctx.db.selectFrom('brokered_grant_approvals').selectAll().execute(),
    ).resolves.toEqual([]);
    await expect(store.check(acp)).resolves.toBe(false);
  });

  it('drops approval records with the grant they belong to', async () => {
    const store = createBrokeredHttpGrantStore(ctx.db);
    await store.grant({ ...acp, scope: 'project' });
    const [granted] = await store.list('project-1', target.bindingId);
    await expect(store.revoke('project-1', granted!.id)).resolves.toBe(true);
    await expect(store.check(acp)).resolves.toBe(false);

    // Revocation only flips state, so the approval record outlives it harmlessly: a
    // revoked grant id never matches again, and a re-approval mints a new row with its
    // own record. Deleting the grant is what clears it, via the foreign key.
    await ctx.db.deleteFrom('secret_provider_permissions').where('id', '=', granted!.id).execute();
    await expect(
      ctx.db.selectFrom('brokered_grant_approvals').select('grant_id').execute(),
    ).resolves.toEqual([]);
  });
});
