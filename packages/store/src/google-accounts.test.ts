import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { migrationProvider } from './migrations.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretCipher } from './crypto.js';
import { GoogleAccountStore } from './google-accounts.js';
import { createTestDb, createIsolatedTestDb, type TestDb } from './testing.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const BOB = 'google-bob';

let ctx: TestDb;
let accounts: GoogleAccountStore;
beforeAll(async () => {
  ctx = await createTestDb();
  accounts = new GoogleAccountStore(ctx.db, createSecretCipher('ab'.repeat(32)));
  await ctx.store.createSession({
    sessionId: 'google-test',
    worktree: '/google-test',
    model: 'test',
  });
  await ctx.db.insertInto('users').values({ id: BOB, role: 'member', status: 'active' }).execute();
});
afterAll(async () => {
  await ctx.close();
});

describe('Google account isolation', () => {
  it('encrypts credentials and keeps two accounts independently addressable', async () => {
    const first = await accounts.save({
      ownerUserId: ADMIN,
      email: 'One@example.com',
      clientId: 'client',
      refreshToken: 'first-secret',
      scopes: ['gmail'],
    });
    const second = await accounts.save({
      ownerUserId: ADMIN,
      email: 'two@example.com',
      clientId: 'client',
      refreshToken: 'second-secret',
      scopes: ['drive'],
    });
    expect(first.id).not.toBe(second.id);
    expect(first.email).toBe('one@example.com');
    expect(JSON.stringify(await accounts.list(ADMIN))).not.toContain('secret');
    const stored = await ctx.db
      .selectFrom('google_accounts')
      .select('refresh_token')
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow();
    expect(stored.refresh_token).toMatch(/^enc:v1:/);
    expect((await accounts.credentials(first.id))?.refreshToken).toBe('first-secret');
    expect((await accounts.credentials(second.id))?.refreshToken).toBe('second-secret');
    await expect(
      accounts.save({
        ownerUserId: ADMIN,
        email: second.email,
        expectedAccountId: first.id,
        clientId: 'client',
        refreshToken: 'replacement',
        scopes: [],
      }),
    ).rejects.toThrow('different account');
    expect((await accounts.credentials(second.id))?.refreshToken).toBe('second-secret');
  });

  it('keeps project defaults live while preserving session exceptions', async () => {
    await ctx.store.upsertProject({
      id: 'google-project',
      owner: 'local',
      repo: 'google',
      containerName: 'google',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 'google-inherit',
      worktree: '/google-inherit',
      model: 'test',
      projectId: 'google-project',
    });
    const one = await accounts.save({
      ownerUserId: ADMIN,
      email: 'default-one@example.test',
      clientId: 'client',
      refreshToken: 'one',
      scopes: [],
    });
    const two = await accounts.save({
      ownerUserId: ADMIN,
      email: 'default-two@example.test',
      clientId: 'client',
      refreshToken: 'two',
      scopes: [],
    });
    await accounts.setProjectAccess('google-project', 'gmail', ADMIN, one.id);
    expect((await accounts.effectiveAccess('google-inherit', 'gmail', ADMIN))?.account.id).toBe(
      one.id,
    );
    await accounts.setProjectAccess('google-project', 'gmail', ADMIN, two.id);
    expect((await accounts.effectiveAccess('google-inherit', 'gmail', ADMIN))?.account.id).toBe(
      two.id,
    );
    await accounts.setSessionAccess('google-inherit', 'gmail', {
      mode: 'account',
      accountId: one.id,
    });
    await accounts.setProjectAccess('google-project', 'gmail', ADMIN, null);
    expect((await accounts.effectiveAccess('google-inherit', 'gmail', ADMIN))?.source).toBe(
      'session',
    );
    await accounts.setSessionAccess('google-inherit', 'gmail', { mode: 'disabled' });
    await accounts.setProjectAccess('google-project', 'gmail', ADMIN, two.id);
    expect(await accounts.effectiveAccess('google-inherit', 'gmail', ADMIN)).toBeUndefined();
    await accounts.setSessionAccess('google-inherit', 'gmail', { mode: 'inherit' });
    expect((await accounts.effectiveAccess('google-inherit', 'gmail', ADMIN))?.account.id).toBe(
      two.id,
    );
  });

  it('invalidates pending approvals after resetting exceptions without coupling overrides to project changes', async () => {
    const one = await accounts.save({
      ownerUserId: ADMIN,
      email: 'snapshot-one@example.test',
      clientId: 'client',
      refreshToken: 'one',
      scopes: [],
    });
    const two = await accounts.save({
      ownerUserId: ADMIN,
      email: 'snapshot-two@example.test',
      clientId: 'client',
      refreshToken: 'two',
      scopes: [],
    });
    await accounts.setSessionAccess('google-test', 'calendar', {
      mode: 'account',
      accountId: one.id,
    });
    const before = await accounts.authorizationSnapshot('google-test', 'calendar', ADMIN);
    await accounts.setSessionAccess('google-test', 'calendar', { mode: 'disabled' });
    await accounts.setSessionAccess('google-test', 'calendar', {
      mode: 'account',
      accountId: one.id,
    });
    expect(await accounts.authorizationSnapshot('google-test', 'calendar', ADMIN)).not.toEqual(
      before,
    );
    await accounts.rename(one.id, 'Personal');
    expect((await accounts.get(one.id))?.credentialVersion).toBe(one.credentialVersion);
    expect((await accounts.credentials(two.id))?.refreshToken).toBe('two');
    await expect(
      ctx.store.enableSessionCalendar('google-test', 'unconnected@example.test', ADMIN),
    ).rejects.toThrow('not connected');
    expect((await accounts.effectiveAccess('google-test', 'calendar', ADMIN))?.account.id).toBe(
      one.id,
    );
  });

  it('keeps folder permissions and recents separate and retains cleanup credentials until cleanup completes', async () => {
    const first = await accounts.save({
      ownerUserId: ADMIN,
      email: 'folder-one@example.test',
      clientId: 'client',
      refreshToken: 'one',
      scopes: [],
    });
    const second = await accounts.save({
      ownerUserId: ADMIN,
      email: 'folder-two@example.test',
      clientId: 'client',
      refreshToken: 'two',
      scopes: [],
    });
    await ctx.store.upsertProject({
      id: 'folder-project',
      owner: 'local',
      repo: 'folders',
      containerName: 'folders',
      state: 'active',
    });
    const one = await accounts.linkFolder({
      projectId: 'folder-project',
      accountId: first.id,
      folderId: 'shared-id',
      name: 'One',
      accessMode: 'read-only',
    });
    const two = await accounts.linkFolder({
      projectId: 'folder-project',
      accountId: second.id,
      folderId: 'shared-id',
      name: 'Two',
      accessMode: 'read-write',
    });
    const links = await accounts.folders('folder-project');
    expect(links.map((link) => [link.accountId, link.accessMode])).toEqual([
      [first.id, 'read-only'],
      [second.id, 'read-write'],
    ]);
    const common = {
      sessionId: 'google-test',
      kind: 'docs' as const,
      name: 'Doc',
      webViewLink: 'https://docs.google.com/document/d/doc/edit',
    };
    await ctx.store.setSessionWorkspaceFile({
      ...common,
      fileId: 'first-doc',
      accountId: first.id,
      folderLinkId: one.id,
    });
    await ctx.store.setSessionWorkspaceFile({
      ...common,
      fileId: 'second-doc',
      accountId: second.id,
      folderLinkId: two.id,
    });
    expect(await ctx.store.listRecentGoogleWorkspaceFileIds(8, first.id)).toEqual(['first-doc']);
    expect(await ctx.store.listRecentGoogleWorkspaceFileIds(8, second.id)).toEqual(['second-doc']);
    await ctx.store.updateProjectSettings('folder-project', {
      googleDriveFolderId: 'shared-id',
      googleDriveFolderName: 'Legacy folder',
    });
    await accounts.unlinkFolder('folder-project', two.id);
    expect((await ctx.store.getProjectSettings('folder-project'))?.googleDriveFolderId).toBeNull();
    expect(await ctx.store.getSessionWorkspaceFile('google-test')).toBeUndefined();
    await ctx.store.createGoogleSlideImageCleanup({
      id: 'account-cleanup',
      sessionId: 'google-test',
      fileId: 'image',
      accountId: first.id,
    });
    await expect(accounts.remove(first.id)).rejects.toThrow('cleanup');
    expect((await accounts.credentials(first.id))?.refreshToken).toBe('one');
    await ctx.store.completeGoogleSlideImageCleanup('account-cleanup');
    await accounts.remove(first.id);
    expect(await accounts.folders('folder-project')).toEqual([]);
    expect((await accounts.credentials(second.id))?.refreshToken).toBe('two');
  });

  it('distinguishes inheritance, explicit account, and disabled; removal never restores inheritance', async () => {
    const account = await accounts.save({
      ownerUserId: ADMIN,
      email: 'removed@example.test',
      clientId: 'client',
      refreshToken: 'removed',
      scopes: [],
    });
    expect(await accounts.sessionAccess('google-test', 'gmail')).toEqual({ mode: 'inherit' });
    await accounts.setSessionAccess('google-test', 'gmail', {
      mode: 'account',
      accountId: account.id,
    });
    expect(await accounts.sessionAccess('google-test', 'gmail')).toEqual({
      mode: 'account',
      accountId: account.id,
    });
    await accounts.remove(account.id);
    expect(await accounts.sessionAccess('google-test', 'gmail')).toEqual({ mode: 'disabled' });
    await accounts.setSessionAccess('google-test', 'gmail', { mode: 'inherit' });
    expect(await accounts.sessionAccess('google-test', 'gmail')).toEqual({ mode: 'inherit' });
    await accounts.setSessionAccess('google-test', 'gmail', { mode: 'disabled' });
    expect(await accounts.sessionAccess('google-test', 'gmail')).toEqual({ mode: 'disabled' });
  });
});

describe('Google accounts belong to the person who connected them', () => {
  const connect = (ownerUserId: string, email: string, refreshToken: string) =>
    accounts.save({ ownerUserId, email, clientId: 'client', refreshToken, scopes: [] });

  // Per-installation dedupe by email would let Bob's reconnect overwrite the
  // administrator's refresh token, so Bob's turns would read the admin's mailbox.
  it('keeps the same email connected by two people as separate accounts with separate credentials', async () => {
    const admin = await connect(ADMIN, 'Shared@example.test', 'admin-secret');
    const bob = await connect(BOB, 'shared@example.test', 'bob-secret');
    expect(bob.id).not.toBe(admin.id);
    expect(admin.ownerUserId).toBe(ADMIN);
    expect(bob.ownerUserId).toBe(BOB);

    const rotated = await connect(ADMIN, 'shared@example.test', 'admin-rotated');
    expect(rotated.id).toBe(admin.id);
    expect((await accounts.credentials(admin.id))?.refreshToken).toBe('admin-rotated');
    expect(await accounts.credentials(bob.id)).toMatchObject({
      refreshToken: 'bob-secret',
      credentialVersion: bob.credentialVersion,
    });
  });

  // A route that lists or resolves accounts must not offer one person another's mailbox.
  it("hides another person's account from list and getOwned", async () => {
    const admin = await connect(ADMIN, 'admin-only@example.test', 'admin');
    const bob = await connect(BOB, 'bob-only@example.test', 'bob');
    expect((await accounts.list(BOB)).map((account) => account.id)).not.toContain(admin.id);
    expect((await accounts.list(ADMIN)).map((account) => account.id)).not.toContain(bob.id);
    expect((await accounts.listAll()).map((account) => account.id)).toEqual(
      expect.arrayContaining([admin.id, bob.id]),
    );
    expect(await accounts.getOwned(admin.id, BOB)).toBeUndefined();
    expect(await accounts.getOwned(admin.id, undefined)).toBeUndefined();
    expect((await accounts.getOwned(admin.id, ADMIN))?.id).toBe(admin.id);
    expect((await accounts.get(admin.id))?.ownerUserId).toBe(ADMIN);
  });

  // A shared session pinned to the administrator's account must not hand its
  // credentials to a turn Bob sends, nor to a turn with no known sender.
  it("gives no effective account to someone who does not own the session's explicit account", async () => {
    await ctx.store.createSession({
      sessionId: 'google-owned-session',
      worktree: '/google-owned-session',
      model: 'test',
    });
    const admin = await connect(ADMIN, 'session-owner@example.test', 'admin');
    await accounts.setSessionAccess('google-owned-session', 'contacts', {
      mode: 'account',
      accountId: admin.id,
    });
    expect(
      (await accounts.effectiveAccess('google-owned-session', 'contacts', ADMIN))?.account.id,
    ).toBe(admin.id);
    expect(await accounts.effectiveAccess('google-owned-session', 'contacts', BOB)).toBeUndefined();
    expect(
      await accounts.effectiveAccess('google-owned-session', 'contacts', undefined),
    ).toBeUndefined();
    expect(
      await ctx.store.getGoogleServiceCredentials('google-owned-session', 'contacts', BOB),
    ).toBeUndefined();
    expect(
      await ctx.store.getGoogleServiceCredentials('google-owned-session', 'contacts', undefined),
    ).toBeUndefined();
  });

  // One shared project row would make the administrator's choice the account
  // every member's turns use.
  it('keeps project access per member', async () => {
    await ctx.store.upsertProject({
      id: 'google-member-project',
      owner: 'local',
      repo: 'google-member',
      containerName: 'google-member',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 'google-member-session',
      worktree: '/google-member-session',
      model: 'test',
      projectId: 'google-member-project',
    });
    const admin = await connect(ADMIN, 'project-admin@example.test', 'admin');
    const bob = await connect(BOB, 'project-bob@example.test', 'bob');

    await accounts.setProjectAccess('google-member-project', 'calendar', ADMIN, admin.id);
    expect((await accounts.projectAccess('google-member-project', 'calendar', ADMIN))?.id).toBe(
      admin.id,
    );
    expect(await accounts.projectAccess('google-member-project', 'calendar', BOB)).toBeUndefined();
    expect(
      await accounts.effectiveAccess('google-member-session', 'calendar', BOB),
    ).toBeUndefined();
    await expect(
      accounts.setProjectAccess('google-member-project', 'calendar', BOB, admin.id),
    ).rejects.toThrow('not found');

    await accounts.setProjectAccess('google-member-project', 'calendar', BOB, bob.id);
    expect(
      (await accounts.effectiveAccess('google-member-session', 'calendar', BOB))?.account.id,
    ).toBe(bob.id);
    expect(
      (await accounts.effectiveAccess('google-member-session', 'calendar', ADMIN))?.account.id,
    ).toBe(admin.id);

    await accounts.setProjectAccess('google-member-project', 'calendar', ADMIN, null);
    expect(
      await accounts.effectiveAccess('google-member-session', 'calendar', ADMIN),
    ).toBeUndefined();
    expect(
      (await accounts.effectiveAccess('google-member-session', 'calendar', BOB))?.account.id,
    ).toBe(bob.id);

    // The administrator pins their own account on the shared session: their
    // turns use it, Bob's keep his own project choice instead of losing Google.
    await accounts.setSessionAccess('google-member-session', 'calendar', {
      mode: 'account',
      accountId: admin.id,
    });
    expect(
      await accounts.effectiveAccess('google-member-session', 'calendar', ADMIN),
    ).toMatchObject({ account: { id: admin.id }, source: 'session' });
    expect(await accounts.effectiveAccess('google-member-session', 'calendar', BOB)).toMatchObject({
      account: { id: bob.id },
      source: 'project',
    });
  });
});

describe('Google account migration', () => {
  it('copies sealed credentials and binds matching legacy access without reviving stale grants', async () => {
    const legacy = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: legacy.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0158_matrix_outbound')).error).toBeUndefined();
      const encrypted = createSecretCipher('ab'.repeat(32)).encrypt('legacy-secret');
      await sql`insert into verity_settings(id, google_drive_account_email, google_drive_client_id,
        google_drive_refresh_token) values ('global', 'Legacy@example.com', 'client', ${encrypted})`.execute(
        legacy.db,
      );
      // Seed the historical schema directly: current store writers require later columns.
      await sql`insert into projects(id, owner, repo, container_name, state)
        values ('legacy-project', 'local', 'legacy', 'legacy', 'active')`.execute(legacy.db);
      await sql`insert into sessions(session_id, worktree, model, project_id) values
        ('legacy-match', '/legacy-match', 'test', 'legacy-project'),
        ('legacy-stale', '/legacy-stale', 'test', null)`.execute(legacy.db);
      await sql`insert into session_gmail_connections(session_id, account_email) values
        ('legacy-match', 'legacy@example.com'), ('legacy-stale', 'other@example.com')`.execute(
        legacy.db,
      );
      await sql`insert into project_settings(project_id, google_drive_folder_id, google_drive_folder_name, google_drive_access_mode)
        values ('legacy-project', 'legacy-folder', 'Legacy folder', 'read-only')`.execute(
        legacy.db,
      );
      await sql`insert into session_slide_decks(session_id, assignment_id, kind, file_id, name, web_view_link, revision_id)
        values ('legacy-match', 'legacy-assignment', 'docs', 'legacy-document', 'Document', 'https://docs.google.com/document/d/legacy-document/edit', null)`.execute(
        legacy.db,
      );
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      const migrated = new GoogleAccountStore(legacy.db, createSecretCipher('ab'.repeat(32)));
      expect((await migrated.listAll()).map((account) => account.email)).toEqual([
        'Legacy@example.com',
      ]);
      const row = await legacy.db
        .selectFrom('google_accounts')
        .select('refresh_token')
        .executeTakeFirstOrThrow();
      expect(row.refresh_token).toBe(encrypted);
      expect(await migrated.sessionAccess('legacy-match', 'gmail')).toEqual({
        mode: 'account',
        accountId: 'legacy-google',
      });
      expect(await migrated.sessionAccess('legacy-stale', 'gmail')).toEqual({ mode: 'disabled' });
      expect(await migrated.sessionAccess('legacy-match', 'calendar')).toEqual({ mode: 'inherit' });
      const folders = await migrated.folders('legacy-project');
      expect(folders).toMatchObject([
        { accountId: 'legacy-google', folderId: 'legacy-folder', accessMode: 'read-only' },
      ]);
      expect(await legacy.store.getSessionWorkspaceFile('legacy-match')).toMatchObject({
        accountId: 'legacy-google',
        folderLinkId: folders[0]!.id,
      });
    } finally {
      await legacy.close();
    }
  }, 60_000);
  // Without an owner, existing accounts and project choices would belong to no
  // one after the upgrade and silently stop working for the administrator.
  it('assigns existing accounts and project connections to the administrator', async () => {
    const legacy = await createIsolatedTestDb();
    try {
      const migrator = new Migrator({ db: legacy.db, provider: migrationProvider });
      expect((await migrator.migrateTo('0205_user_display_name')).error).toBeUndefined();
      await sql`insert into google_accounts(id, email, client_id, refresh_token)
        values ('existing-google', 'existing@example.test', 'client', 'sealed')`.execute(legacy.db);
      await sql`insert into projects(id, owner, repo, container_name, state)
        values ('existing-project', 'local', 'existing', 'existing', 'active')`.execute(legacy.db);
      await sql`insert into project_google_connections(project_id, service, account_email, account_id)
        values ('existing-project', 'gmail', 'existing@example.test', 'existing-google')`.execute(
        legacy.db,
      );
      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      const migrated = new GoogleAccountStore(legacy.db, createSecretCipher('ab'.repeat(32)));
      expect((await migrated.list(ADMIN)).map((account) => account.id)).toEqual([
        'existing-google',
      ]);
      expect(
        await legacy.db
          .selectFrom('project_google_connections')
          .select(['project_id', 'service', 'user_id', 'account_id'])
          .execute(),
      ).toEqual([
        {
          project_id: 'existing-project',
          service: 'gmail',
          user_id: ADMIN,
          account_id: 'existing-google',
        },
      ]);
      expect((await migrated.projectAccess('existing-project', 'gmail', ADMIN))?.id).toBe(
        'existing-google',
      );
    } finally {
      await legacy.close();
    }
  }, 60_000);
});
