import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSecretCipher } from './crypto.js';
import { dopplerBindingGrantId, legacyDopplerBindingGrantId } from './doppler-binding-identity.js';
import {
  AmbiguousDopplerConnectionError,
  DopplerConnectionStore,
  DopplerConnectionTokenChangedError,
  DopplerConnectionUsageChangedError,
} from './doppler-connections.js';
import { migrationProvider } from './migrations.js';
import {
  DuplicateDopplerBindingError,
  ProjectDopplerBindingStore,
} from './project-doppler-bindings.js';
import { EventStore } from './store.js';
import { createRawDb, createTestDb, truncateAll, type TestDb } from './testing.js';
import { DopplerBindingsChangedError } from './user-doppler-connection.js';

const cipher = createSecretCipher('ab'.repeat(32));
let ctx: TestDb;
let connections: DopplerConnectionStore;
let bindings: ProjectDopplerBindingStore;
beforeAll(async () => {
  ctx = await createTestDb();
  connections = new DopplerConnectionStore(ctx.db, cipher);
  bindings = new ProjectDopplerBindingStore(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.db
    .insertInto('users')
    .values({ id: 'lena', role: 'member', status: 'active' })
    .execute();
  for (const id of ['p1', 'p2'])
    await ctx.store.upsertProject({
      id,
      owner: 'acme',
      repo: id,
      containerName: `dev-acme-${id}`,
      state: 'active',
    });
});

const mirrored = async (projectId: string) => {
  const settings = await ctx.store.getProjectSettings(projectId);
  return [settings?.dopplerProject ?? null, settings?.dopplerConfig ?? null];
};

describe('project Doppler bindings', () => {
  it('makes the first binding the default and mirrors it into the project settings', async () => {
    const platform = await connections.add({
      label: 'Platform',
      token: 'dp.sa.platform',
      workplace: { slug: 'northstar', name: 'Northstar' },
    });
    const first = await bindings.add('p1', {
      connectionId: platform,
      dopplerProject: 'portal',
      dopplerConfig: 'prd',
    });
    const second = await bindings.add('p1', {
      connectionId: platform,
      dopplerProject: 'billing',
      dopplerConfig: 'dev',
    });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(await mirrored('p1')).toEqual(['portal', 'prd']);

    expect(await bindings.setDefault('p1', second.id)).toBe(true);
    expect((await bindings.list('p1')).map((b) => [b.dopplerProject, b.isDefault])).toEqual([
      ['billing', true],
      ['portal', false],
    ]);
    expect(await mirrored('p1')).toEqual(['billing', 'dev']);
    // Another project's binding id never moves this project's default.
    expect(await bindings.setDefault('p2', first.id)).toBe(false);

    // Removing the default promotes the oldest remaining binding.
    expect(await bindings.remove('p1', second.id)).toBe(true);
    expect((await bindings.list('p1')).map((b) => [b.id, b.isDefault])).toEqual([[first.id, true]]);
    expect(await mirrored('p1')).toEqual(['portal', 'prd']);
    await bindings.remove('p1', first.id);
    expect(await mirrored('p1')).toEqual([null, null]);
  });

  // A reference `project/config/NAME` must name exactly one binding, so the same
  // pair from a second workplace is refused rather than silently shadowed.
  it('refuses the same Doppler project and config twice, also from another connection', async () => {
    const platform = await connections.add({
      label: 'Platform',
      token: 'dp.sa.a',
      workplace: { slug: null, name: null },
    });
    const payments = await connections.add({
      label: 'Payments',
      token: 'dp.sa.b',
      workplace: { slug: null, name: null },
    });
    await bindings.add('p1', {
      connectionId: platform,
      dopplerProject: 'app',
      dopplerConfig: 'prd',
    });
    await expect(
      bindings.add('p1', { connectionId: payments, dopplerProject: 'app', dopplerConfig: 'prd' }),
    ).rejects.toBeInstanceOf(DuplicateDopplerBindingError);
    // Other projects may bind the same pair.
    await bindings.add('p2', {
      connectionId: payments,
      dopplerProject: 'app',
      dopplerConfig: 'prd',
    });
  });

  it('invalidates a token when its last binding is removed and rejects a concurrent save of that token', async () => {
    const connectionId = await connections.add({
      label: 'Platform',
      token: 'dp.sa.a',
      workplace: { slug: null, name: null },
    });
    const config = { connectionId, dopplerProject: 'app', dopplerConfig: 'prd' };
    const first = await bindings.add('p1', config);
    const second = await bindings.add('p1', { ...config, dopplerConfig: 'stg' });
    const tokens = ctx.store.userDopplerConnections;
    await tokens.set('lena', 'p1', connectionId, 'dp.st.lena', [first.id, second.id]);
    await bindings.remove('p1', first.id);
    expect(await tokens.tokenBytes('lena', 'p1', connectionId)).toBeDefined();
    await bindings.remove('p1', second.id);
    await bindings.add('p1', config);
    await expect(
      tokens.set('lena', 'p1', connectionId, 'dp.st.lena', [second.id]),
    ).rejects.toBeInstanceOf(DopplerBindingsChangedError);
    expect(await tokens.tokenBytes('lena', 'p1', connectionId)).toBeUndefined();
  });

  it('accepts legacy settings for one binding and refuses ambiguous changes', async () => {
    const platform = await connections.add({
      label: 'Platform',
      token: 'dp.sa.a',
      workplace: { slug: null, name: null },
    });
    await ctx.store.updateProjectSettings('p1', { dopplerProject: 'app' });
    expect(await mirrored('p1')).toEqual(['app', null]);
    expect(await bindings.list('p1')).toEqual([]);
    await ctx.store.updateProjectSettings('p1', { dopplerConfig: 'stg' });
    const [created] = await bindings.list('p1');
    expect(created).toMatchObject({
      connectionId: platform,
      dopplerConfig: 'stg',
      isDefault: true,
    });

    await bindings.add('p1', {
      connectionId: platform,
      dopplerProject: 'app',
      dopplerConfig: 'prd',
    });
    await expect(
      ctx.store.updateProjectSettings('p1', { dopplerProject: 'app', dopplerConfig: 'prd' }),
    ).rejects.toThrow(AmbiguousDopplerConnectionError);
    await expect(
      ctx.store.updateProjectSettings('p1', { dopplerProject: null, dopplerConfig: null }),
    ).rejects.toThrow(AmbiguousDopplerConnectionError);
    expect((await bindings.list('p1')).map((b) => [b.dopplerConfig, b.isDefault])).toEqual([
      ['stg', true],
      ['prd', false],
    ]);
    expect(await mirrored('p1')).toEqual(['app', 'stg']);
  });
});

describe('Doppler connections', () => {
  it('keeps the token encrypted and reports it only as present', async () => {
    const id = await connections.add({
      label: 'Platform',
      token: 'dp.sa.secret',
      workplace: { slug: 'northstar', name: 'Northstar' },
    });
    expect(await connections.get(id)).toMatchObject({
      label: 'Platform',
      hasToken: true,
      workplaceName: 'Northstar',
    });
    expect(JSON.stringify(await connections.list())).not.toContain('dp.sa.');
    const stored = await ctx.db.selectFrom('doppler_connections').select('token').execute();
    expect(stored.map((row) => row.token).join()).not.toContain('dp.sa.');
    expect((await connections.tokenBytes(id))?.toString()).toBe('dp.sa.secret');
    await bindings.add('p1', {
      connectionId: id,
      dopplerProject: 'portal',
      dopplerConfig: 'prd',
    });
    expect((await bindings.list('p1'))[0]?.tokenRevision).toBeUndefined();
    expect(await connections.update(id, { label: 'Core', token: 'dp.sa.rotated' })).toBe(true);
    const revision = (await bindings.list('p1'))[0]?.tokenRevision;
    expect(revision).toBeDefined();
    await connections.update(id, { label: 'Core' });
    expect((await bindings.list('p1'))[0]?.tokenRevision).toBe(revision);
    expect((await connections.tokenBytes(id))?.toString()).toBe('dp.sa.rotated');
    expect((await connections.get(id))?.label).toBe('Core');
    expect(await connections.update('missing', { label: 'x' })).toBe(false);
  });

  it('requires the confirmed bindings to match a connection’s current usage', async () => {
    const connectionId = await connections.add({
      label: 'Platform',
      token: 'dp.sa.a',
      workplace: { slug: null, name: null },
    });
    const first = await bindings.add('p1', {
      connectionId,
      dopplerProject: 'app',
      dopplerConfig: 'prd',
    });
    const second = await bindings.add('p2', {
      connectionId,
      dopplerProject: 'app',
      dopplerConfig: 'stg',
    });
    await expect(connections.remove(connectionId, [first.id])).rejects.toBeInstanceOf(
      DopplerConnectionUsageChangedError,
    );
    expect(await connections.usage(connectionId)).toHaveLength(2);
    await expect(connections.remove(connectionId, [second.id, first.id])).resolves.toBe(true);
  });

  it('accepts a first legacy token after the project settings create a tokenless binding', async () => {
    const store = ctx.store;
    await store.updateProjectSettings('p1', { dopplerProject: 'app', dopplerConfig: 'prd' });
    const before = await store.projectDopplerBindings.list('p1');
    expect(before).toHaveLength(1);
    expect((await store.dopplerConnections.get('legacy-doppler'))?.hasToken).toBe(false);
    await store.updateVeritySettings({ dopplerServiceToken: 'dp.sa.initial' });
    expect((await store.dopplerConnections.get('legacy-doppler'))?.hasToken).toBe(true);
    expect((await store.projectDopplerBindings.list('p1'))[0]?.id).toBe(before[0]?.id);
  });

  it('keeps an unchanged legacy token and rejects unvalidated changes when bindings use it', async () => {
    const store = ctx.store;
    const connectionId = 'legacy-doppler';
    await store.updateVeritySettings({ dopplerServiceToken: 'dp.sa.original' });
    await store.updateVeritySettings({ dopplerServiceToken: 'dp.sa.changed-unbound' });
    const binding = await bindings.add('p1', {
      connectionId,
      dopplerProject: 'app',
      dopplerConfig: 'prd',
    });
    const current = await store.dopplerConnections.get(connectionId);
    await store.userDopplerConnections.set('lena', 'p1', connectionId, 'dp.st.lena', [binding.id]);
    await store.updateVeritySettings({
      dopplerServiceToken: 'dp.sa.changed-unbound',
      gitUserName: 'Updated name',
    });
    expect(await store.dopplerConnections.get(connectionId)).toEqual(current);
    expect(await store.userDopplerConnections.tokenBytes('lena', 'p1', connectionId)).toBeDefined();
    for (const token of ['dp.sa.unvalidated', null]) {
      await expect(
        store.updateVeritySettings({
          dopplerServiceToken: token,
          gitUserName: 'Rejected name',
        }),
      ).rejects.toBeInstanceOf(AmbiguousDopplerConnectionError);
    }
    expect(await store.getVeritySettings()).toMatchObject({
      dopplerServiceToken: 'dp.sa.changed-unbound',
      gitUserName: 'Updated name',
    });
    expect(await store.dopplerConnections.get(connectionId)).toEqual(current);
  });

  it('updates a validated token and its legacy mirror only when the topology still matches', async () => {
    await connections.setLegacyToken('dp.sa.original');
    const connectionId = 'legacy-doppler';
    const oldRevision = (await connections.get(connectionId))?.tokenRevision ?? null;
    const first = await bindings.add('p1', {
      connectionId,
      dopplerProject: 'app',
      dopplerConfig: 'prd',
    });
    const second = await bindings.add('p2', {
      connectionId,
      dopplerProject: 'app',
      dopplerConfig: 'stg',
    });
    const patch = { token: 'dp.sa.replacement' };
    await expect(
      connections.updateRecord(connectionId, patch, {
        bindingIds: [first.id],
        tokenRevision: oldRevision,
      }),
    ).rejects.toBeInstanceOf(DopplerConnectionUsageChangedError);
    expect((await connections.tokenBytes(connectionId))?.toString()).toBe('dp.sa.original');
    const approved = { bindingIds: [first.id, second.id], tokenRevision: oldRevision };
    const updated = await connections.updateRecord(connectionId, patch, approved);
    expect(updated).toMatchObject({ id: connectionId, projectCount: 2, hasToken: true });
    expect(updated?.tokenRevision).not.toBe(oldRevision);
    await expect(
      connections.updateRecord(connectionId, { token: 'dp.sa.stale' }, approved),
    ).rejects.toBeInstanceOf(DopplerConnectionTokenChangedError);
    const settings = await ctx.db
      .selectFrom('verity_settings')
      .select('doppler_service_token')
      .where('id', '=', 'global')
      .executeTakeFirstOrThrow();
    expect(cipher.decryptBytes(settings.doppler_service_token ?? '')?.toString()).toBe(
      'dp.sa.replacement',
    );
    expect((await connections.tokenBytes(connectionId))?.toString()).toBe('dp.sa.replacement');
  });

  it('preserves personal tokens only on a known same-workplace rotation', async () => {
    const workplace = { slug: 'platform', name: 'Platform' };
    const connectionId = await connections.add({ label: 'Platform', token: 'dp.sa.a', workplace });
    const input = { connectionId, dopplerProject: 'app', dopplerConfig: 'prd' };
    const binding = await bindings.add('p1', input, null);
    const tokens = ctx.store.userDopplerConnections;
    await tokens.set('lena', 'p1', connectionId, 'dp.st.token', [binding.id], null);
    await connections.update(connectionId, { token: 'dp.sa.b', workplace });
    expect(await tokens.tokenBytes('lena', 'p1', connectionId)).toBeDefined();
    await expect(
      bindings.add('p1', { ...input, dopplerConfig: 'stg' }, null),
    ).rejects.toBeInstanceOf(DopplerConnectionTokenChangedError);
    await expect(
      tokens.set('lena', 'p1', connectionId, 'dp.st.stale', [binding.id], null),
    ).rejects.toBeInstanceOf(DopplerBindingsChangedError);
    await connections.update(connectionId, { token: 'dp.sa.c' });
    expect(await tokens.tokenBytes('lena', 'p1', connectionId)).toBeUndefined();
    expect((await connections.get(connectionId))?.workplaceSlug).toBeNull();
  });

  it('keeps a surviving default when default selection overlaps connection deletion', async () => {
    const platform = await connections.add({
      label: 'Platform',
      token: 'dp.sa.a',
      workplace: { slug: null, name: null },
    });
    const payments = await connections.add({
      label: 'Payments',
      token: 'dp.sa.b',
      workplace: { slug: null, name: null },
    });
    const surviving = await bindings.add('p1', {
      connectionId: platform,
      dopplerProject: 'portal',
      dopplerConfig: 'prd',
    });
    const removed = await bindings.add('p1', {
      connectionId: payments,
      dopplerProject: 'billing',
      dopplerConfig: 'dev',
    });
    await Promise.all([bindings.setDefault('p1', removed.id), connections.remove(payments)]);
    expect(await bindings.list('p1')).toEqual([surviving]);
    expect(await mirrored('p1')).toEqual(['portal', 'prd']);
  });

  // Deleting a connection in use is allowed after the warning, and must leave
  // nothing behind that could still resolve or auto-approve through it.
  it('removes its bindings, personal tokens and grants in every project', async () => {
    const platform = await connections.add({
      label: 'Platform',
      token: 'dp.sa.a',
      workplace: { slug: null, name: null },
    });
    const payments = await connections.add({
      label: 'Payments',
      token: 'dp.sa.b',
      workplace: { slug: null, name: null },
    });
    await bindings.add('p1', {
      connectionId: platform,
      dopplerProject: 'portal',
      dopplerConfig: 'prd',
    });
    await bindings.add('p1', {
      connectionId: payments,
      dopplerProject: 'billing',
      dopplerConfig: 'dev',
    });
    await bindings.add('p2', {
      connectionId: platform,
      dopplerProject: 'tools',
      dopplerConfig: 'dev',
    });
    await ctx.store.userDopplerConnections.set('lena', 'p1', platform, 'dp.st.lena');
    await ctx.store.userDopplerConnections.set('lena', 'p1', payments, 'dp.st.lena-b');
    const grant = (id: string, bindingId: string) => ({
      id,
      project_id: 'p1',
      binding_id: bindingId,
      binding_version: 1,
      secret_name: 'API_KEY',
      tool_id: 'verity_http_request:api.example.com',
      scope: 'project',
      granted_by: 'lena',
      state: 'active',
    });
    const platformBinding = {
      connectionId: platform,
      dopplerProject: 'portal',
      dopplerConfig: 'prd',
    };
    const paymentsGrantId = dopplerBindingGrantId({
      connectionId: payments,
      dopplerProject: 'billing',
      dopplerConfig: 'dev',
    });
    await connections.update(platform, { token: 'dp.sa.rotated' });
    const [rotated] = await bindings.list('p1');
    if (rotated === undefined) throw new Error('Missing platform binding');
    const rotatedGrantId = dopplerBindingGrantId(rotated);
    await ctx.db
      .insertInto('secret_provider_permissions')
      .values([
        grant('g-platform-previous', dopplerBindingGrantId(platformBinding)),
        grant('g-platform-current', rotatedGrantId),
        grant('g-payments', paymentsGrantId),
        grant('g-mixed', `project-doppler-set:default:${rotatedGrantId},${paymentsGrantId}`),
      ])
      .execute();

    expect(await connections.usage(platform)).toEqual([
      expect.objectContaining({
        projectId: 'p1',
        bindings: [expect.objectContaining({ dopplerProject: 'portal', isDefault: true })],
      }),
      expect.objectContaining({ projectId: 'p2' }),
    ]);

    expect(await connections.remove(platform)).toBe(true);
    expect(await connections.get(platform)).toBeUndefined();
    expect((await bindings.list('p1')).map((b) => [b.dopplerProject, b.isDefault])).toEqual([
      ['billing', true],
    ]);
    expect(await bindings.list('p2')).toEqual([]);
    expect(await mirrored('p1')).toEqual(['billing', 'dev']);
    expect(await mirrored('p2')).toEqual([null, null]);
    expect(
      await ctx.store.userDopplerConnections.tokenBytes('lena', 'p1', platform),
    ).toBeUndefined();
    expect(await ctx.store.userDopplerConnections.tokenBytes('lena', 'p1', payments)).toBeDefined();
    const grants = await ctx.db.selectFrom('secret_provider_permissions').select('id').execute();
    expect(grants.map((row) => row.id)).toEqual(['g-payments']);
    expect(await connections.remove(platform)).toBe(false);
  });
});

// Upgrading must keep every project reading the same Doppler config, every person's
// token and every standing grant working, without unlocking the secret store.
it.each(['rotation', 'replacement'] as const)(
  'migrates Doppler state and rejects stale consent after %s',
  async (change) => {
    const raw = createRawDb();
    try {
      const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
      const before = await migrator.migrateTo('0241_github_repository_ids');
      if (before.error) throw new Error('Migration failed', { cause: before.error });
      const store = new EventStore(raw.db, cipher);
      await sql`insert into users (id, role, status) values ('lena', 'member', 'active')`.execute(
        raw.db,
      );
      for (const id of ['p1', 'p2'])
        await store.upsertProject({
          id,
          owner: 'acme',
          repo: id,
          containerName: `dev-acme-${id}`,
          state: 'active',
        });
      const envelope = cipher.encrypt('dp.sa.instance');
      await sql`insert into verity_settings (id, doppler_service_token) values ('global', ${envelope})
      on conflict (id) do update set doppler_service_token = ${envelope}`.execute(raw.db);
      await sql`insert into project_settings (project_id, doppler_project, doppler_config)
      values ('p1', 'portal', 'prd')`.execute(raw.db);
      await sql`insert into user_doppler_connections (user_id, project_id, token)
      values ('lena', 'p1', ${cipher.encrypt('dp.st.lena')})`.execute(raw.db);
      await sql`insert into users (id, role, status) values ('older', 'member', 'active')`.execute(
        raw.db,
      );
      await sql`insert into user_doppler_connections (user_id, project_id, token, updated_at)
      values ('older', 'p1', ${cipher.encrypt('dp.st.older')}, '2020-01-01')`.execute(raw.db);
      await sql`insert into secret_provider_permissions
        (id, project_id, binding_id, binding_version, secret_name, tool_id, scope, granted_by, state)
      values ('g1', 'p1', ${legacyDopplerBindingGrantId('portal', 'prd')}, 1, 'API_KEY',
        'verity_http_request:api.example.com', 'project', 'lena', 'active')`.execute(raw.db);

      const after = await migrator.migrateToLatest();
      if (after.error) throw new Error('Migration failed', { cause: after.error });

      const upgraded = new EventStore(raw.db, cipher);
      expect(await upgraded.dopplerConnections.list()).toEqual([
        expect.objectContaining({ id: 'legacy-doppler', label: 'Doppler', hasToken: true }),
      ]);
      expect((await upgraded.dopplerConnections.tokenBytes('legacy-doppler'))?.toString()).toBe(
        'dp.sa.instance',
      );
      expect(await upgraded.projectDopplerBindings.list('p1')).toEqual([
        expect.objectContaining({
          connectionId: 'legacy-doppler',
          dopplerProject: 'portal',
          dopplerConfig: 'prd',
          isDefault: true,
        }),
      ]);
      expect(await upgraded.projectDopplerBindings.list('p2')).toEqual([]);
      expect(
        (
          await upgraded.userDopplerConnections.tokenBytes('lena', 'p1', 'legacy-doppler')
        )?.toString(),
      ).toBe('dp.st.lena');
      const [migratedBinding] = await upgraded.projectDopplerBindings.list('p1');
      const personal = await upgraded.userDopplerConnections.statuses('lena', 'p1');
      expect(personal.get('legacy-doppler')?.validatedBindingIds).toEqual([migratedBinding?.id]);
      const older = await upgraded.userDopplerConnections.statuses('older', 'p1');
      expect(older.get('legacy-doppler')?.validatedBindingIds).toEqual([]);
      const grants = await sql<{ binding_id: string }>`
      select binding_id from secret_provider_permissions`.execute(raw.db);
      expect(grants.rows).toEqual([
        {
          binding_id: dopplerBindingGrantId({
            connectionId: 'legacy-doppler',
            dopplerProject: 'portal',
            dopplerConfig: 'prd',
          }),
        },
      ]);
      const otherConnection = await upgraded.dopplerConnections.add({
        label: 'Other',
        token: 'dp.sa.other',
        workplace: { slug: 'other', name: null },
      });
      await upgraded.projectDopplerBindings.add('p2', {
        connectionId: otherConnection,
        dopplerProject: 'tools',
        dopplerConfig: 'dev',
      });
      await sql`insert into users (id, role, status) values ('mia', 'member', 'active')`.execute(
        raw.db,
      );
      await upgraded.userDopplerConnections.set('mia', 'p1', 'legacy-doppler', 'dp.st.unvalidated');
      await sql`insert into sessions (session_id, worktree, model, project_id)
      values ('s1', '/wt/s1', 'test', 'p1')`.execute(raw.db);
      await sql`insert into brokered_tool_approvals
      (id, project_id, session_id, invocation_id, tool_name, canonical_input,
       request_mac, mac_key_id, authorization_snapshot, binding_digest, status, created_at)
      values
        ('legacy', 'p1', 's1', 'legacy', 'verity_http_request', '{}', 'mac', 'key',
         '{"dopplerProject":"portal","dopplerConfig":"prd"}', 'legacy', 'pending', now()),
        ('new-pending', 'p1', 's1', 'new-pending', 'verity_http_request', '{}', 'mac', 'key',
         '{"bindings":[]}', 'new-pending', 'pending', now()),
        ('new-approved', 'p1', 's1', 'new-approved', 'verity_http_request', '{}', 'mac', 'key',
         '{"bindings":[]}', 'new-approved', 'approved', now())`.execute(raw.db);
      await sql`update brokered_tool_approvals set status = 'denied' where id = 'new-pending'`.execute(
        raw.db,
      );
      const blockedByDenial = await migrator.migrateTo('0241_github_repository_ids');
      expect(blockedByDenial.error).toEqual(
        expect.objectContaining({ message: expect.stringContaining('Cannot downgrade') }),
      );
      await sql`update brokered_tool_approvals set status = 'pending' where id = 'new-pending'`.execute(
        raw.db,
      );
      await sql`insert into brokered_http_consumptions (project_id, session_id, turn_id, call_id, request_hash)
      values ('p1', 's1', 't1', 'doppler-v2:claim', 'hash')`.execute(raw.db);
      const blockedByClaim = await migrator.migrateTo('0241_github_repository_ids');
      expect(blockedByClaim.error).toEqual(
        expect.objectContaining({ message: expect.stringContaining('Cannot downgrade') }),
      );
      await sql`delete from brokered_http_consumptions where call_id = 'doppler-v2:claim'`.execute(
        raw.db,
      );
      const downgraded = await migrator.migrateTo('0241_github_repository_ids');
      if (downgraded.error) throw new Error('Downgrade failed', { cause: downgraded.error });
      expect(
        (await sql<{ id: string }>`select id from brokered_tool_approvals`.execute(raw.db)).rows,
      ).toEqual([{ id: 'legacy' }]);
      const personalTokens = await sql<{ user_id: string }>`
      select user_id from user_doppler_connections order by user_id`.execute(raw.db);
      expect(personalTokens.rows).toEqual([{ user_id: 'lena' }, { user_id: 'older' }]);
      const settings = await sql<{
        project_id: string;
        doppler_project: string | null;
        doppler_config: string | null;
      }>`
      select project_id, doppler_project, doppler_config from project_settings order by project_id`.execute(
        raw.db,
      );
      expect(settings.rows).toEqual([
        { project_id: 'p1', doppler_project: 'portal', doppler_config: 'prd' },
        { project_id: 'p2', doppler_project: null, doppler_config: null },
      ]);
      expect(
        (
          await sql<{ binding_id: string }>`
      select binding_id from secret_provider_permissions`.execute(raw.db)
        ).rows,
      ).toEqual([{ binding_id: legacyDopplerBindingGrantId('portal', 'prd') }]);
      await sql`update brokered_tool_approvals set status = 'approved' where id = 'legacy'`.execute(
        raw.db,
      );
      const upgradedAgain = await migrator.migrateToLatest();
      if (upgradedAgain.error)
        throw new Error('Second upgrade failed', { cause: upgradedAgain.error });
      if (change === 'rotation') {
        await upgraded.dopplerConnections.update('legacy-doppler', { token: 'dp.sa.rotated' });
      } else {
        const [original] = await upgraded.projectDopplerBindings.list('p1');
        await upgraded.projectDopplerBindings.remove('p1', original!.id);
        await upgraded.projectDopplerBindings.add('p1', {
          connectionId: 'legacy-doppler',
          dopplerProject: 'portal',
          dopplerConfig: 'prd',
        });
      }
      const rotatedDowngrade = await migrator.migrateTo('0241_github_repository_ids');
      if (rotatedDowngrade.error)
        throw new Error('Downgrade after source change failed', { cause: rotatedDowngrade.error });
      expect((await sql`select id from brokered_tool_approvals`.execute(raw.db)).rows).toEqual([]);
    } finally {
      await raw.close();
    }
  },
);

it('creates no connection on upgrade when Doppler was never used', async () => {
  const raw = createRawDb();
  try {
    const migrator = new Migrator({ db: raw.db, provider: migrationProvider });
    const after = await migrator.migrateToLatest();
    if (after.error) throw new Error('Migration failed', { cause: after.error });
    expect(await new EventStore(raw.db, cipher).dopplerConnections.list()).toEqual([]);
  } finally {
    await raw.close();
  }
});
