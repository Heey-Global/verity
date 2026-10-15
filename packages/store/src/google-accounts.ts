import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

export type GoogleService = 'gmail' | 'calendar' | 'contacts';
export interface GoogleAccount {
  id: string;
  email: string;
  subject: string | null;
  displayName: string | null;
  clientId: string;
  scopes: string[];
  credentialVersion: number;
}
export type GoogleSessionAccess =
  { mode: 'inherit' } | { mode: 'disabled' } | { mode: 'account'; accountId: string };

export class GoogleAccountCleanupPendingError extends Error {
  constructor() {
    super(
      'Temporary Slides images still need cleanup. Retry disconnecting after cleanup finishes.',
    );
  }
}

/** Account metadata never includes credentials; decrypt only for an actual operation. */
export class GoogleAccountStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  async list(): Promise<GoogleAccount[]> {
    const rows = await this.db
      .selectFrom('google_accounts')
      .select([
        'id',
        'email',
        'subject',
        'display_name',
        'client_id',
        'scopes',
        'credential_version',
      ])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      subject: row.subject,
      displayName: row.display_name,
      clientId: row.client_id,
      scopes: row.scopes,
      credentialVersion: row.credential_version,
    }));
  }

  async get(id: string): Promise<GoogleAccount | undefined> {
    return (await this.list()).find((account) => account.id === id);
  }

  async credentials(id: string) {
    const row = await this.db
      .selectFrom('google_accounts')
      .select(['client_id', 'refresh_token', 'credential_version'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          clientId: row.client_id,
          refreshToken: this.cipher.decrypt(row.refresh_token),
          credentialVersion: row.credential_version,
        };
  }

  async save(input: {
    email: string;
    subject?: string;
    clientId: string;
    refreshToken: string;
    scopes: string[];
    expectedAccountId?: string;
  }): Promise<GoogleAccount> {
    const email = input.email.trim().toLowerCase();
    if (!email || !input.clientId.trim() || !input.refreshToken.trim())
      throw new Error('Verified Google identity and credentials are required');
    const encrypted = this.cipher.encrypt(input.refreshToken);
    return this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom('google_accounts')
        .selectAll()
        .where(sql<boolean>`lower(email) = ${email}`)
        .executeTakeFirst();
      if (input.expectedAccountId !== undefined && existing?.id !== input.expectedAccountId)
        throw new Error('Google returned a different account');
      if (existing?.subject && input.subject && existing.subject !== input.subject)
        throw new Error('Google account identity changed');
      const id = existing?.id ?? randomUUID();
      await tx
        .insertInto('google_accounts')
        .values({
          id,
          email,
          subject: input.subject ?? null,
          display_name: null,
          client_id: input.clientId,
          refresh_token: encrypted,
          scopes: JSON.stringify(input.scopes),
        })
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet({
            email,
            subject: input.subject ?? existing?.subject ?? null,
            client_id: input.clientId,
            refresh_token: encrypted,
            scopes: JSON.stringify(input.scopes),
            credential_version: sql`google_accounts.credential_version + 1`,
          }),
        )
        .execute();
      return {
        id,
        email,
        subject: input.subject ?? existing?.subject ?? null,
        displayName: existing?.display_name ?? null,
        clientId: input.clientId,
        scopes: input.scopes,
        credentialVersion: (existing?.credential_version ?? 0) + 1,
      };
    });
  }

  async rename(id: string, name: string | null): Promise<void> {
    await this.db
      .updateTable('google_accounts')
      .set({ display_name: name?.trim() || null })
      .where('id', '=', id)
      .execute();
  }

  async usage(id: string) {
    const projects = await sql<{ id: string; name: string }>`select distinct p.id, p.repo as name
      from projects p where p.id in (
        select project_id from project_google_connections where account_id = ${id}
        union select project_id from project_google_drive_folders where account_id = ${id}
        union select s.project_id from sessions s join google_service_overrides o using (session_id)
          where o.account_id = ${id}
        union select s.project_id from sessions s join session_slide_decks f using (session_id)
          where f.account_id = ${id}
      ) order by p.repo, p.id`.execute(this.db);
    return { projects: projects.rows };
  }

  async remove(id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const account = await tx
        .selectFrom('google_accounts')
        .select('email')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!account) return;
      const cleanup = await tx
        .selectFrom('google_slide_image_cleanup')
        .select('id')
        .where('account_id', '=', id)
        .executeTakeFirst();
      if (cleanup) throw new GoogleAccountCleanupPendingError();

      for (const table of [
        'session_gmail_connections',
        'session_calendar_connections',
        'session_contacts_connections',
      ] as const) {
        await tx
          .deleteFrom(table)
          .where(sql<boolean>`lower(account_email) = ${account.email.toLowerCase()}`)
          .execute();
      }
      await tx.deleteFrom('project_google_connections').where('account_id', '=', id).execute();
      await sql`update project_settings p set google_drive_folder_id = null, google_drive_folder_name = null
        where exists (select 1 from project_google_drive_folders f where f.account_id = ${id}
          and f.project_id = p.project_id and f.folder_id = p.google_drive_folder_id)`.execute(tx);
      // Legacy clients must not retain access through the former singleton credentials.
      await tx
        .updateTable('verity_settings')
        .set({
          google_drive_client_id: null,
          google_drive_refresh_token: null,
          google_drive_account_email: null,
          google_granted_scopes: '[]',
          gmail_authorized: false,
          calendar_authorized: false,
          contacts_authorized: false,
        })
        .where(sql<boolean>`lower(google_drive_account_email) = ${account.email.toLowerCase()}`)
        .execute();
      // ON DELETE SET NULL keeps explicit session exceptions disabled after removal.
      await tx.deleteFrom('google_accounts').where('id', '=', id).execute();
    });
  }

  async sessionAccess(sessionId: string, service: GoogleService): Promise<GoogleSessionAccess> {
    const row = await this.db
      .selectFrom('google_service_overrides')
      .select(['account_id', 'mode'])
      .where('session_id', '=', sessionId)
      .where('service', '=', service)
      .executeTakeFirst();
    return row === undefined || row.mode === 'inherit'
      ? { mode: 'inherit' }
      : row.account_id === null
        ? { mode: 'disabled' }
        : { mode: 'account', accountId: row.account_id };
  }

  async setSessionAccess(sessionId: string, service: GoogleService, access: GoogleSessionAccess) {
    const accountId = access.mode === 'account' ? access.accountId : null;
    await this.db
      .insertInto('google_service_overrides')
      .values({
        mode: access.mode,
        revision: randomUUID(),
        session_id: sessionId,
        service,
        account_id: accountId,
      })
      .onConflict((conflict) =>
        conflict.columns(['session_id', 'service']).doUpdateSet({
          mode: access.mode,
          revision: randomUUID(),
          account_id: accountId,
          updated_at: new Date().toISOString(),
        }),
      )
      .execute();
  }

  async projectAccess(projectId: string, service: GoogleService) {
    const grant = await this.db
      .selectFrom('project_google_connections')
      .select('account_id')
      .where('project_id', '=', projectId)
      .where('service', '=', service)
      .executeTakeFirst();
    return grant?.account_id ? await this.get(grant.account_id) : undefined;
  }

  async setProjectAccess(projectId: string, service: GoogleService, accountId: string | null) {
    if (accountId === null) {
      await this.db
        .deleteFrom('project_google_connections')
        .where('project_id', '=', projectId)
        .where('service', '=', service)
        .execute();
      return;
    }
    const account = await this.get(accountId);
    if (!account) throw new Error('Google account not found');
    await this.db
      .insertInto('project_google_connections')
      .values({
        revision: randomUUID(),
        project_id: projectId,
        service,
        account_email: account.email,
        account_id: account.id,
      })
      .onConflict((conflict) =>
        conflict.columns(['project_id', 'service']).doUpdateSet({
          revision: randomUUID(),
          account_email: account.email,
          account_id: account.id,
        }),
      )
      .execute();
  }

  async effectiveAccess(sessionId: string, service: GoogleService) {
    const access = await this.sessionAccess(sessionId, service);
    if (access.mode === 'disabled') return undefined;
    if (access.mode === 'account') {
      const account = await this.get(access.accountId);
      return account ? { account, source: 'session' as const } : undefined;
    }
    const session = await this.db
      .selectFrom('sessions')
      .select('project_id')
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    const account = session?.project_id
      ? await this.projectAccess(session.project_id, service)
      : undefined;
    return account ? { account, source: 'project' as const } : undefined;
  }

  async authorizationSnapshot(sessionId: string, service: GoogleService) {
    const session = await this.db
      .selectFrom('sessions')
      .select('project_id')
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    const override = await this.db
      .selectFrom('google_service_overrides')
      .select('revision')
      .where('session_id', '=', sessionId)
      .where('service', '=', service)
      .executeTakeFirst();
    const project = session?.project_id
      ? await this.db
          .selectFrom('project_google_connections')
          .select(['revision', 'enabled_at'])
          .where('project_id', '=', session.project_id)
          .where('service', '=', service)
          .executeTakeFirst()
      : undefined;
    const effective = await this.effectiveAccess(sessionId, service);
    return {
      projectId: session?.project_id,
      sessionRevision: override?.revision ?? null,
      projectRevision:
        effective?.source === 'project'
          ? (project?.revision ?? project?.enabled_at.toISOString() ?? null)
          : null,
      accountId: effective?.account.id,
      accountEmail: effective?.account.email,
      credentialVersion: effective?.account.credentialVersion,
      source: effective?.source,
    };
  }

  async folders(projectId: string) {
    return this.db
      .selectFrom('project_google_drive_folders as f')
      .innerJoin('google_accounts as a', 'a.id', 'f.account_id')
      .select([
        'f.revision',
        'f.id',
        'f.project_id as projectId',
        'f.account_id as accountId',
        'f.folder_id as folderId',
        'f.name',
        'f.access_mode as accessMode',
        'a.email as accountEmail',
        'a.display_name as accountName',
      ])
      .where('f.project_id', '=', projectId)
      .orderBy('f.created_at')
      .orderBy('f.id')
      .execute();
  }

  async linkFolder(input: {
    projectId: string;
    accountId: string;
    folderId: string;
    name: string;
    accessMode: 'read-only' | 'read-write';
  }) {
    return this.db
      .insertInto('project_google_drive_folders')
      .values({
        id: randomUUID(),
        revision: randomUUID(),
        project_id: input.projectId,
        account_id: input.accountId,
        folder_id: input.folderId,
        name: input.name,
        access_mode: input.accessMode,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['project_id', 'account_id', 'folder_id'])
          .doUpdateSet({ name: input.name, access_mode: input.accessMode, revision: randomUUID() }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  async unlinkFolder(projectId: string, id: string) {
    await this.db.transaction().execute(async (tx) => {
      const link = await tx
        .selectFrom('project_google_drive_folders')
        .select(['id', 'folder_id'])
        .where('project_id', '=', projectId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!link) return;
      await tx
        .updateTable('project_settings')
        .set({ google_drive_folder_id: null, google_drive_folder_name: null })
        .where('project_id', '=', projectId)
        .where('google_drive_folder_id', '=', link.folder_id)
        .execute();
      await tx.deleteFrom('session_slide_decks').where('folder_link_id', '=', id).execute();
      await tx.deleteFrom('project_google_drive_folders').where('id', '=', id).execute();
    });
  }
}
