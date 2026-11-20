import type { EventStore } from '@verity/store';
import {
  hasGoogleGmailScopes,
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
} from './google-oauth-scopes.js';

/** Presentation metadata only: never decrypt credentials or contact Google on chat open. */
export async function sessionGoogleStatus(
  store: Pick<EventStore, 'googleAccounts' | 'getSessionWorkspaceFile'>,
  sessionId: string,
  /** The viewing person: "connected" and the effective account are theirs only. */
  userId: string | undefined,
) {
  if (!store.googleAccounts) return undefined;
  const accounts = userId === undefined ? [] : await store.googleAccounts.list(userId);
  const connection = async (
    service: 'gmail' | 'calendar' | 'contacts',
    eligible: (scopes: string[]) => boolean,
  ) => {
    const effective = await store.googleAccounts.effectiveAccess(sessionId, service, userId);
    const access = await store.googleAccounts.sessionAccess(sessionId, service);
    return {
      enabled: effective !== undefined && eligible(effective.account.scopes),
      connected: accounts.some((account) => eligible(account.scopes)),
      accountId: effective?.account.id ?? null,
      accountEmail: effective?.account.email ?? null,
      source: effective?.source ?? null,
      mode: access.mode,
      // OAuth client selection belongs to the explicit connection action.
      clientId: null,
    };
  };
  const gmail = await connection('gmail', hasGoogleGmailScopes);
  const calendar = await connection('calendar', hasGoogleCalendarScopes);
  const contacts = await connection('contacts', hasGoogleContactsScopes);
  const workspaceFile = (await store.getSessionWorkspaceFile(sessionId)) ?? null;
  return { gmail, calendar, contacts, workspaceFile };
}
export type SessionGoogleStatus = NonNullable<Awaited<ReturnType<typeof sessionGoogleStatus>>>;
