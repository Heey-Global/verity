import { VerityApiError, type GmailSessionConnection, type VerityClient } from '@verity/mobile';
import { runGmailAuth, runCalendarAuth, runContactsAuth } from './googleDrive';

export type GoogleService = 'gmail' | 'calendar' | 'contacts';

function sessionMethods(client: VerityClient, service: GoogleService) {
  if (service === 'gmail')
    return {
      get: client.getSessionGmailConnection.bind(client),
      connect: client.connectGmail.bind(client),
      auth: runGmailAuth,
    };
  if (service === 'calendar')
    return {
      get: client.getSessionCalendarConnection.bind(client),
      connect: client.connectCalendar.bind(client),
      auth: runCalendarAuth,
    };
  return {
    get: client.getSessionContactsConnection.bind(client),
    connect: client.connectContacts.bind(client),
    auth: runContactsAuth,
  };
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
  const methods = sessionMethods(client, service);
  let selectedId = accountId;
  if (selectedId === undefined) {
    const accounts = (await client.listGoogleAccounts()).filter((account) => {
      const suffixes = {
        gmail: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'],
        calendar: ['calendar.calendarlist.readonly', 'calendar.events'],
        contacts: ['contacts.readonly'],
      }[service];
      return suffixes.every((scope) =>
        account.scopes.includes(`https://www.googleapis.com/auth/${scope}`),
      );
    });
    if (accounts.length > 1) throw new Error('Choose a Google account');
    selectedId = accounts[0]?.id;
  }
  if (!selectedId) {
    const connection = await client.getGoogleDriveConnection();
    if (!connection.clientId) throw new Error('Google sign-in is not configured on this server.');
    const auth = await methods.auth(connection.clientId);
    if (auth.kind === 'cancelled') return { kind: 'cancelled' };
    const connected = await methods.connect({
      code: auth.code,
      codeVerifier: auth.codeVerifier,
      redirectUri: auth.redirectUri,
    });
    if (!connected.accountId)
      throw new Error('The connected Google account could not be identified');
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
): Promise<boolean> {
  try {
    return (await client.listGoogleAccounts()).length > 0;
  } catch (error) {
    if (!(error instanceof VerityApiError) || error.status !== 404) throw error;
    const connections = await Promise.all(
      (['gmail', 'calendar', 'contacts'] as const).map((service) =>
        sessionMethods(client, service).get(sessionId),
      ),
    );
    return connections.some((connection) => connection.connected);
  }
}
