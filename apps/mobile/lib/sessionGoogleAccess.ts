import { VerityApiError, type GmailSessionConnection, type VerityClient } from '@verity/mobile';
import { runGoogleAccountAuth } from './googleDrive';
import { missingGoogleServices, type GoogleServiceName } from './googleServices';

export type GoogleService = 'gmail' | 'calendar' | 'contacts';

export const GOOGLE_SERVICE_NAMES: Record<GoogleService, GoogleServiceName> = {
  gmail: 'Gmail',
  calendar: 'Calendar',
  contacts: 'Contacts',
};

function sessionMethods(client: VerityClient, service: GoogleService) {
  if (service === 'gmail') return { get: client.getSessionGmailConnection.bind(client) };
  if (service === 'calendar') return { get: client.getSessionCalendarConnection.bind(client) };
  return { get: client.getSessionContactsConnection.bind(client) };
}

/**
 * What a pick in the chat's account sheet means. `accountId` is null when the
 * sheet was dismissed or had nothing to offer (`supportingAccounts === 0`).
 */
export function chatAccountPickAction(pick: {
  accountId: string | null;
  supportingAccounts: number;
  currentId: string | null;
  projectAccountId: string | null;
  inheriting: boolean;
}): 'none' | 'inherit' | 'connect' {
  // Dismissed; with no supporting account the connect flow signs one in.
  if (pick.accountId === null) return pick.supportingAccounts > 0 ? 'none' : 'connect';
  // The project's account follows the project default again, so a later
  // project change reaches this chat instead of a stale pin.
  if (pick.accountId === pick.projectAccountId) return pick.inheriting ? 'none' : 'inherit';
  return pick.accountId === pick.currentId ? 'none' : 'connect';
}

export async function connectSessionGoogleService(
  client: VerityClient,
  sessionId: string,
  service: GoogleService,
  accountId?: string | null,
): Promise<
  | { kind: 'cancelled' }
  | {
      kind: 'session';
      connection: GmailSessionConnection;
      connections: Record<GoogleService, GmailSessionConnection | null>;
    }
> {
  const name = GOOGLE_SERVICE_NAMES[service];
  let selectedId = accountId;
  if (selectedId === undefined) {
    const accounts = (await client.listGoogleAccounts()).filter(
      (account) => !missingGoogleServices(account.scopes).includes(name),
    );
    if (accounts.length > 1) throw new Error('Choose a Google account');
    selectedId = accounts[0]?.id;
  }
  if (!selectedId) {
    const connection = await client.getGoogleDriveConnection();
    if (!connection.clientId) throw new Error('Google sign-in is not configured on this server.');
    const auth = await runGoogleAccountAuth(connection.clientId);
    if (auth.kind === 'cancelled') return { kind: 'cancelled' };
    const connected = await client.connectGoogleAccount({
      code: auth.code,
      codeVerifier: auth.codeVerifier,
      redirectUri: auth.redirectUri,
    });
    if (missingGoogleServices(connected.scopes).includes(name))
      throw new Error(`Google did not grant access to ${name}`);
    selectedId = connected.accountId;
  }
  const enabled = await client.setSessionGoogleAccess(sessionId, service, {
    mode: 'account',
    accountId: selectedId,
  });
  // Reload effective access without changing sibling service grants.
  const services = ['gmail', 'calendar', 'contacts'] as const;
  const snapshots = await Promise.all(
    services.map(async (current) => {
      try {
        return await sessionMethods(client, current).get(sessionId);
      } catch {
        return null;
      }
    }),
  );
  return {
    kind: 'session',
    connection: enabled,
    connections: Object.fromEntries(
      services.map((current, index) => [current, snapshots[index]]),
    ) as Record<GoogleService, GmailSessionConnection | null>,
  };
}

export async function disconnectSessionGoogleService(
  client: VerityClient,
  sessionId: string,
  _projectId: string | null | undefined,
  service: GoogleService,
): Promise<'project' | 'session'> {
  await client.setSessionGoogleAccess(sessionId, service, { mode: 'disabled' });
  return 'session';
}

export async function hasConnectedGoogleAccount(
  client: VerityClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    return (await client.listGoogleAccounts(signal)).length > 0;
  } catch (error) {
    if (!(error instanceof VerityApiError) || error.status !== 404) throw error;
    const connections = await Promise.all(
      (['gmail', 'calendar', 'contacts'] as const).map((service) =>
        sessionMethods(client, service).get(sessionId, signal),
      ),
    );
    return connections.some((connection) => connection.connected);
  }
}
