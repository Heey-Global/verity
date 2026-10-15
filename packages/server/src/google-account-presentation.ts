import type { EventStore } from '@verity/store';
import {
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
  hasGoogleDriveScopes,
  hasGoogleGmailScopes,
} from './google-oauth-scopes.js';
import { resolveGoogleDriveAuthority } from './google-drive-authority.js';

/** Legacy status fields remain useful, but credentials belong to the account registry. */
export async function googleAccountSettingsStatus(store: Pick<EventStore, 'googleAccounts'>) {
  const accounts = await store.googleAccounts.list();
  return {
    googleDriveConnected: accounts.some((account) => hasGoogleDriveScopes(account.scopes)),
    gmailAuthorized: accounts.some((account) => hasGoogleGmailScopes(account.scopes)),
    calendarAuthorized: accounts.some((account) => hasGoogleCalendarScopes(account.scopes)),
    contactsAuthorized: accounts.some((account) => hasGoogleContactsScopes(account.scopes)),
    googleDriveAccountEmail: accounts.length === 1 ? accounts[0]!.email : null,
  };
}

/** Resolve display identity on the server; tool arguments cannot label another account's consent. */
export async function googleApprovalAccount(
  store: Pick<EventStore, 'googleAccounts' | 'getSessionWorkspaceFile'>,
  input: { sessionId: string; projectId: string; toolName: string; request: unknown },
): Promise<{ id: string; email: string } | undefined> {
  const service =
    input.toolName === 'verity_gmail'
      ? 'gmail'
      : input.toolName === 'verity_google_calendar'
        ? 'calendar'
        : input.toolName === 'verity_google_contacts'
          ? 'contacts'
          : undefined;
  if (service) {
    const effective = await store.googleAccounts.effectiveAccess(input.sessionId, service);
    if (!effective) throw new Error('Google access is no longer available');
    return { id: effective.account.id, email: effective.account.email };
  }
  if (input.toolName === 'verity_google_drive') {
    const authority = await resolveGoogleDriveAuthority(
      store,
      input.projectId,
      input.request as { action: string; accountId?: string; folderLinkId?: string },
    );
    return { id: authority.accountId, email: authority.accountEmail };
  }
  if (
    ['verity_google_docs', 'verity_google_sheets', 'verity_google_slides'].includes(input.toolName)
  ) {
    const file = await store.getSessionWorkspaceFile(input.sessionId);
    const account = file?.accountId ? await store.googleAccounts.get(file.accountId) : undefined;
    if (!account) throw new Error('The assigned Google account is no longer available');
    return { id: account.id, email: account.email };
  }
  return undefined;
}
