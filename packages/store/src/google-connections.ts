import type { Kysely } from 'kysely';
import type { GoogleAccountStore, GoogleService } from './google-accounts.js';
import type { Database } from './schema.js';

export interface SessionGmailConnection {
  accountId?: string;
  source?: 'project' | 'session';
  sessionId: string;
  accountEmail: string;
  enabledAt: Date;
}

export interface SessionCalendarConnection {
  accountId?: string;
  source?: 'project' | 'session';
  sessionId: string;
  accountEmail: string;
  enabledAt: Date;
}

export interface SessionContactsConnection {
  accountId?: string;
  source?: 'project' | 'session';
  sessionId: string;
  accountEmail: string;
  enabledAt: Date;
}

/** Project and session grants, including reads of legacy connection rows. */
export class GoogleConnectionStore {
  constructor(
    private readonly currentDb: () => Kysely<Database>,
    private readonly currentAccounts: () => GoogleAccountStore,
    private readonly readSession: (
      sessionId: string,
    ) => Promise<{ projectId?: string | null } | undefined>,
    private readonly readProjectConnection: (
      projectId: string,
      service: GoogleService,
    ) => Promise<{ accountEmail: string; enabledAt: Date } | undefined>,
  ) {}

  private get db(): Kysely<Database> {
    return this.currentDb();
  }

  private get googleAccounts(): GoogleAccountStore {
    return this.currentAccounts();
  }

  /** Credentials for the Google account `userId` uses in this session; none for
   *  anyone else's account and none without a person (ADR 0023 §3). */
  async getGoogleServiceCredentials(
    sessionId: string,
    service: GoogleService,
    userId: string | undefined,
  ) {
    const effective = await this.googleAccounts.effectiveAccess(sessionId, service, userId);
    if (!effective) return undefined;
    const credentials = await this.googleAccounts.credentials(effective.account.id);
    if (!credentials) return undefined;
    return {
      ...credentials,
      accountId: effective.account.id,
      accountEmail: effective.account.email,
      scopes: effective.account.scopes,
      source: effective.source,
    };
  }

  async countLegacyProjectGoogleSessions(
    projectId: string,
    service: GoogleService,
  ): Promise<number> {
    const table =
      service === 'gmail'
        ? 'session_gmail_connections'
        : service === 'calendar'
          ? 'session_calendar_connections'
          : 'session_contacts_connections';
    const result = await this.db
      .selectFrom(table)
      .innerJoin('sessions', 'sessions.session_id', `${table}.session_id`)
      .select((eb) => eb.fn.countAll().as('count'))
      .where('sessions.project_id', '=', projectId)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async getProjectGoogleConnection(projectId: string, service: GoogleService) {
    const row = await this.db
      .selectFrom('project_google_connections')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('service', '=', service)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { accountEmail: row.account_email, enabledAt: row.enabled_at };
  }

  async enableProjectGoogleConnection(
    projectId: string,
    service: GoogleService,
    accountEmail: string,
    userId: string,
  ): Promise<void> {
    const anyAccounts = (await this.googleAccounts.listAll()).length > 0;
    const account = (await this.googleAccounts.list(userId)).find(
      (candidate) => candidate.email.toLowerCase() === accountEmail.toLowerCase(),
    );
    if (anyAccounts && !account) throw new Error('Google account is not connected');
    if (account) {
      await this.googleAccounts.setProjectAccess(projectId, service, userId, account.id);
      return;
    }
    await this.db
      .insertInto('project_google_connections')
      .values({ project_id: projectId, service, user_id: userId, account_email: accountEmail })
      .onConflict((conflict) =>
        conflict
          .columns(['project_id', 'service', 'user_id'])
          .doUpdateSet({ account_email: accountEmail }),
      )
      .execute();
  }

  async disableProjectGoogleConnection(
    projectId: string,
    service: GoogleService,
    userId: string,
  ): Promise<void> {
    if ((await this.googleAccounts.listAll()).length > 0) {
      await this.googleAccounts.setProjectAccess(projectId, service, userId, null);
      return;
    }
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom('project_google_connections')
        .where('project_id', '=', projectId)
        .where('service', '=', service)
        .where('user_id', '=', userId)
        .execute();
      // Disabling the project also revokes legacy grants in its sessions.
      const sessionIds = transaction
        .selectFrom('sessions')
        .select('session_id')
        .where('project_id', '=', projectId);
      const table =
        service === 'gmail'
          ? 'session_gmail_connections'
          : service === 'calendar'
            ? 'session_calendar_connections'
            : 'session_contacts_connections';
      await transaction.deleteFrom(table).where('session_id', 'in', sessionIds).execute();
    });
  }

  private async getProjectGoogleConnectionForSession(sessionId: string, service: GoogleService) {
    const session = await this.readSession(sessionId);
    if (!session?.projectId) return undefined;
    const grant = await this.readProjectConnection(session.projectId, service);
    return grant === undefined ? undefined : { sessionId, ...grant };
  }

  async getSessionGmailConnection(
    sessionId: string,
    userId: string | undefined,
  ): Promise<SessionGmailConnection | undefined> {
    const override = await this.googleAccounts.sessionAccess(sessionId, 'gmail');
    if (override.mode !== 'inherit' || (await this.googleAccounts.listAll()).length > 0) {
      const effective = await this.googleAccounts.effectiveAccess(sessionId, 'gmail', userId);
      return effective
        ? {
            sessionId,
            accountId: effective.account.id,
            accountEmail: effective.account.email,
            enabledAt: new Date(),
            source: effective.source,
          }
        : undefined;
    }
    const row = await this.db
      .selectFrom('session_gmail_connections')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row === undefined
      ? await this.getProjectGoogleConnectionForSession(sessionId, 'gmail')
      : {
          sessionId: row.session_id,
          accountEmail: row.account_email,
          enabledAt: row.enabled_at,
        };
  }

  async enableSessionGmail(
    sessionId: string,
    accountEmail: string,
    userId: string,
    getConnection: (
      sessionId: string,
      userId: string,
    ) => Promise<SessionGmailConnection | undefined>,
  ): Promise<SessionGmailConnection> {
    const anyAccounts = (await this.googleAccounts.listAll()).length > 0;
    const account = (await this.googleAccounts.list(userId)).find(
      (candidate) => candidate.email.toLowerCase() === accountEmail.toLowerCase(),
    );
    if (anyAccounts && !account) throw new Error('Google account is not connected');
    if (account)
      await this.googleAccounts.setSessionAccess(sessionId, 'gmail', {
        mode: 'account',
        accountId: account.id,
      });
    const row = await this.db
      .insertInto('session_gmail_connections')
      .values({ session_id: sessionId, account_email: accountEmail })
      .onConflict((conflict) =>
        conflict.column('session_id').doUpdateSet({ account_email: accountEmail }),
      )
      .returningAll()
      .executeTakeFirst();
    return (
      (await getConnection(sessionId, userId)) ?? {
        sessionId,
        accountEmail,
        enabledAt: row!.enabled_at,
      }
    );
  }

  async disableSessionGmail(sessionId: string): Promise<void> {
    if ((await this.googleAccounts.listAll()).length > 0)
      await this.googleAccounts.setSessionAccess(sessionId, 'gmail', { mode: 'disabled' });
    await this.db
      .deleteFrom('session_gmail_connections')
      .where('session_id', '=', sessionId)
      .execute();
  }

  async clearSessionGmailConnections(): Promise<void> {
    await this.db.deleteFrom('session_gmail_connections').execute();
    await this.db.deleteFrom('project_google_connections').where('service', '=', 'gmail').execute();
  }

  async getSessionCalendarConnection(
    sessionId: string,
    userId: string | undefined,
  ): Promise<SessionCalendarConnection | undefined> {
    const override = await this.googleAccounts.sessionAccess(sessionId, 'calendar');
    if (override.mode !== 'inherit' || (await this.googleAccounts.listAll()).length > 0) {
      const effective = await this.googleAccounts.effectiveAccess(sessionId, 'calendar', userId);
      return effective
        ? {
            sessionId,
            accountId: effective.account.id,
            accountEmail: effective.account.email,
            enabledAt: new Date(),
            source: effective.source,
          }
        : undefined;
    }
    const row = await this.db
      .selectFrom('session_calendar_connections')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row === undefined
      ? await this.getProjectGoogleConnectionForSession(sessionId, 'calendar')
      : {
          sessionId: row.session_id,
          accountEmail: row.account_email,
          enabledAt: row.enabled_at,
        };
  }

  async enableSessionCalendar(
    sessionId: string,
    accountEmail: string,
    userId: string,
    getConnection: (
      sessionId: string,
      userId: string,
    ) => Promise<SessionCalendarConnection | undefined>,
  ): Promise<SessionCalendarConnection> {
    const anyAccounts = (await this.googleAccounts.listAll()).length > 0;
    const account = (await this.googleAccounts.list(userId)).find(
      (candidate) => candidate.email.toLowerCase() === accountEmail.toLowerCase(),
    );
    if (anyAccounts && !account) throw new Error('Google account is not connected');
    if (account)
      await this.googleAccounts.setSessionAccess(sessionId, 'calendar', {
        mode: 'account',
        accountId: account.id,
      });
    const row = await this.db
      .insertInto('session_calendar_connections')
      .values({ session_id: sessionId, account_email: accountEmail })
      .onConflict((conflict) =>
        conflict.column('session_id').doUpdateSet({ account_email: accountEmail }),
      )
      .returningAll()
      .executeTakeFirst();
    return (
      (await getConnection(sessionId, userId)) ?? {
        sessionId,
        accountEmail,
        enabledAt: row!.enabled_at,
      }
    );
  }

  async disableSessionCalendar(sessionId: string): Promise<void> {
    if ((await this.googleAccounts.listAll()).length > 0)
      await this.googleAccounts.setSessionAccess(sessionId, 'calendar', { mode: 'disabled' });
    await this.db
      .deleteFrom('session_calendar_connections')
      .where('session_id', '=', sessionId)
      .execute();
  }

  async clearSessionCalendarConnections(): Promise<void> {
    await this.db.deleteFrom('session_calendar_connections').execute();
    await this.db
      .deleteFrom('project_google_connections')
      .where('service', '=', 'calendar')
      .execute();
  }

  async getSessionContactsConnection(
    sessionId: string,
    userId: string | undefined,
  ): Promise<SessionContactsConnection | undefined> {
    const override = await this.googleAccounts.sessionAccess(sessionId, 'contacts');
    if (override.mode !== 'inherit' || (await this.googleAccounts.listAll()).length > 0) {
      const effective = await this.googleAccounts.effectiveAccess(sessionId, 'contacts', userId);
      return effective
        ? {
            sessionId,
            accountId: effective.account.id,
            accountEmail: effective.account.email,
            enabledAt: new Date(),
            source: effective.source,
          }
        : undefined;
    }
    const row = await this.db
      .selectFrom('session_contacts_connections')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row === undefined
      ? await this.getProjectGoogleConnectionForSession(sessionId, 'contacts')
      : {
          sessionId: row.session_id,
          accountEmail: row.account_email,
          enabledAt: row.enabled_at,
        };
  }

  async enableSessionContacts(
    sessionId: string,
    accountEmail: string,
    userId: string,
    getConnection: (
      sessionId: string,
      userId: string,
    ) => Promise<SessionContactsConnection | undefined>,
  ): Promise<SessionContactsConnection> {
    const anyAccounts = (await this.googleAccounts.listAll()).length > 0;
    const account = (await this.googleAccounts.list(userId)).find(
      (candidate) => candidate.email.toLowerCase() === accountEmail.toLowerCase(),
    );
    if (anyAccounts && !account) throw new Error('Google account is not connected');
    if (account)
      await this.googleAccounts.setSessionAccess(sessionId, 'contacts', {
        mode: 'account',
        accountId: account.id,
      });
    const row = await this.db
      .insertInto('session_contacts_connections')
      .values({ session_id: sessionId, account_email: accountEmail })
      .onConflict((conflict) =>
        conflict.column('session_id').doUpdateSet({ account_email: accountEmail }),
      )
      .returningAll()
      .executeTakeFirst();
    return (
      (await getConnection(sessionId, userId)) ?? {
        sessionId,
        accountEmail,
        enabledAt: row!.enabled_at,
      }
    );
  }

  async disableSessionContacts(sessionId: string): Promise<void> {
    if ((await this.googleAccounts.listAll()).length > 0)
      await this.googleAccounts.setSessionAccess(sessionId, 'contacts', { mode: 'disabled' });
    await this.db
      .deleteFrom('session_contacts_connections')
      .where('session_id', '=', sessionId)
      .execute();
  }

  async clearSessionContactsConnections(): Promise<void> {
    await this.db.deleteFrom('session_contacts_connections').execute();
    await this.db
      .deleteFrom('project_google_connections')
      .where('service', '=', 'contacts')
      .execute();
  }
}
