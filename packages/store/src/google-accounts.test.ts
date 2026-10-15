import { Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { migrationProvider } from './migrations.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretCipher } from './crypto.js';
import { GoogleAccountStore } from './google-accounts.js';
import { createTestDb, createIsolatedTestDb, type TestDb } from './testing.js';

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
});
afterAll(async () => {
  await ctx.close();
});

describe('Google account isolation', () => {
  it('encrypts credentials and keeps two accounts independently addressable', async () => {
    const first = await accounts.save({
      email: 'One@example.com',
      clientId: 'client',
      refreshToken: 'first-secret',
      scopes: ['gmail'],
    });
    const second = await accounts.save({
      email: 'two@example.com',
      clientId: 'client',
      refreshToken: 'second-secret',
      scopes: ['drive'],
    });
    expect(first.id).not.toBe(second.id);
    expect(first.email).toBe('one@example.com');
    expect(JSON.stringify(await accounts.list())).not.toContain('secret');
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
      email: 'default-one@example.test',
      clientId: 'client',
      refreshToken: 'one',
      scopes: [],
    });
    const two = await accounts.save({
      email: 'default-two@example.test',
      clientId: 'client',
      refreshToken: 'two',
      scopes: [],
    });
    await accounts.setProjectAccess('google-project', 'gmail', one.id);
    expect((await accounts.effectiveAccess('google-inherit', 'gmail'))?.account.id).toBe(one.id);
    await accounts.setProjectAccess('google-project', 'gmail', two.id);
    expect((await accounts.effectiveAccess('google-inherit', 'gmail'))?.account.id).toBe(two.id);
    await accounts.setSessionAccess('google-inherit', 'gmail', {
      mode: 'account',
      accountId: one.id,
    });
    await accounts.setProjectAccess('google-project', 'gmail', null);
    expect((await accounts.effectiveAccess('google-inherit', 'gmail'))?.source).toBe('session');
    await accounts.setSessionAccess('google-inherit', 'gmail', { mode: 'disabled' });
    await accounts.setProjectAccess('google-project', 'gmail', two.id);
    expect(await accounts.effectiveAccess('google-inherit', 'gmail')).toBeUndefined();
    await accounts.setSessionAccess('google-inherit', 'gmail', { mode: 'inherit' });
    expect((await accounts.effectiveAccess('google-inherit', 'gmail'))?.account.id).toBe(two.id);
  });

  it('invalidates pending approvals after resetting exceptions without coupling overrides to project changes', async () => {
    const one = await accounts.save({
      email: 'snapshot-one@example.test',
      clientId: 'client',
      refreshToken: 'one',
      scopes: [],
    });
    const two = await accounts.save({
      email: 'snapshot-two@example.test',
      clientId: 'client',
      refreshToken: 'two',
      scopes: [],
    });
    await accounts.setSessionAccess('google-test', 'calendar', {
      mode: 'account',
      accountId: one.id,
    });
    const before = await accounts.authorizationSnapshot('google-test', 'calendar');
    await accounts.setSessionAccess('google-test', 'calendar', { mode: 'disabled' });
    await accounts.setSessionAccess('google-test', 'calendar', {
      mode: 'account',
      accountId: one.id,
    });
    expect(await accounts.authorizationSnapshot('google-test', 'calendar')).not.toEqual(before);
    await accounts.rename(one.id, 'Personal');
    expect((await accounts.get(one.id))?.credentialVersion).toBe(one.credentialVersion);
    expect((await accounts.credentials(two.id))?.refreshToken).toBe('two');
    await expect(
      ctx.store.enableSessionCalendar('google-test', 'unconnected@example.test'),
    ).rejects.toThrow('not connected');
    expect((await accounts.effectiveAccess('google-test', 'calendar'))?.account.id).toBe(one.id);
  });

  it('keeps folder permissions and recents separate and retains cleanup credentials until cleanup completes', async () => {
    const first = await accounts.save({
      email: 'folder-one@example.test',
      clientId: 'client',
      refreshToken: 'one',
      scopes: [],
    });
    const second = await accounts.save({
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
      await legacy.store.createSession({
        sessionId: 'legacy-match',
        worktree: '/legacy-match',
        model: 'test',
      });
      await legacy.store.createSession({
        sessionId: 'legacy-stale',
        worktree: '/legacy-stale',
        model: 'test',
      });
      await sql`insert into session_gmail_connections(session_id, account_email) values
        ('legacy-match', 'legacy@example.com'), ('legacy-stale', 'other@example.com')`.execute(
        legacy.db,
      );
      await legacy.store.upsertProject({
        id: 'legacy-project',
        owner: 'local',
        repo: 'legacy',
        containerName: 'legacy',
        state: 'active',
      });
      await legacy.store.setSessionProject('legacy-match', 'legacy-project');
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
      expect((await migrated.list()).map((account) => account.email)).toEqual([
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
});
