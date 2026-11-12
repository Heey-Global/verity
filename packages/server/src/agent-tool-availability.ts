import type { EventStore } from '@verity/store';
import type { GatewayToolName } from '@verity/secret-contracts';
import {
  hasGoogleCalendarScopes,
  hasGoogleContactsScopes,
  hasGoogleDriveScopes,
  hasGoogleGmailScopes,
  hasGoogleWorkspaceScope,
} from './google-oauth-scopes.js';

/** Metadata-only discovery; listing tools must never decrypt connector credentials. */
export async function connectorToolAvailable(
  store: EventStore,
  input: {
    projectId: string;
    sessionId: string;
    toolName: GatewayToolName;
    /** The person the turn runs for; only their Google accounts make a tool available. */
    userId: string | undefined;
  },
): Promise<boolean> {
  const service =
    input.toolName === 'verity_gmail'
      ? 'gmail'
      : input.toolName === 'verity_google_contacts'
        ? 'contacts'
        : ['verity_google_calendar', 'verity_scheduling'].includes(input.toolName)
          ? 'calendar'
          : undefined;
  if (service) {
    const access = await store.googleAccounts.effectiveAccess(
      input.sessionId,
      service,
      input.userId,
    );
    return (
      !!access &&
      {
        gmail: hasGoogleGmailScopes,
        calendar: hasGoogleCalendarScopes,
        contacts: hasGoogleContactsScopes,
      }[service](access.account.scopes)
    );
  }
  if (input.toolName === 'verity_google_drive') {
    // URL reads can use an authorized account without a project folder. Folder
    // operations still validate their binding in resolveGoogleDriveAuthority.
    if (input.userId === undefined) return false;
    return (await store.googleAccounts.list(input.userId)).some((account) =>
      hasGoogleDriveScopes(account.scopes),
    );
  }
  if (
    ['verity_google_docs', 'verity_google_sheets', 'verity_google_slides'].includes(input.toolName)
  ) {
    const file = await store.getSessionWorkspaceFile(input.sessionId);
    const kind = input.toolName.slice('verity_google_'.length);
    if (!file?.accountId || file.kind !== kind) return false;
    return hasGoogleWorkspaceScope(
      (await store.googleAccounts.getOwned(file.accountId, input.userId))?.scopes,
      file.kind,
    );
  }
  if (input.toolName === 'verity_matrix') {
    const config = await store.integrations.matrixConfigSummary();
    if (!config) return false;
    const accounts = await store.integrations.listAccounts();
    return (await store.integrations.listSources(input.projectId)).some(
      (source) =>
        source.status === 'active' &&
        source.accountId === config.username &&
        accounts.some(
          (account) => account.id === source.accountId && account.endpoint === config.endpoint,
        ),
    );
  }
  return true;
}
