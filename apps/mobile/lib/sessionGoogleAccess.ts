import { VerityApiError, type GmailSessionConnection, type VerityClient } from '@verity/mobile';
import { runGmailAuth, runCalendarAuth, runContactsAuth } from './googleDrive';

export type GoogleService = 'gmail' | 'calendar' | 'contacts';

function sessionMethods(client: VerityClient, service: GoogleService) {
  if (service === 'gmail')
    return {
      get: client.getSessionGmailConnection.bind(client),
      enable: client.enableSessionGmail.bind(client),
      disable: client.disableSessionGmail.bind(client),
      connect: client.connectGmail.bind(client),
      auth: runGmailAuth,
    };
  if (service === 'calendar')
    return {
      get: client.getSessionCalendarConnection.bind(client),
      enable: client.enableSessionCalendar.bind(client),
      disable: client.disableSessionCalendar.bind(client),
      connect: client.connectCalendar.bind(client),
      auth: runCalendarAuth,
    };
  return {
    get: client.getSessionContactsConnection.bind(client),
    enable: client.enableSessionContacts.bind(client),
    disable: client.disableSessionContacts.bind(client),
    connect: client.connectContacts.bind(client),
    auth: runContactsAuth,
  };
}

async function projectGrant(
  client: VerityClient,
  projectId: string | null | undefined,
  service: GoogleService,
) {
  if (!projectId) return undefined;
  try {
    return await client.getProjectGoogleConnection(projectId, service);
  } catch (error) {
    // Older servers support session grants but have no project-access endpoint.
    // Authentication and transport failures must never be mistaken for that case.
    if (error instanceof VerityApiError && error.status === 404) return undefined;
    throw error;
  }
}

export async function connectSessionGoogleService(
  client: VerityClient,
  sessionId: string,
  service: GoogleService,
): Promise<
  | { kind: 'cancelled' }
  | {
      kind: 'session';
      connection: GmailSessionConnection;
      connections: Record<GoogleService, GmailSessionConnection | null>;
    }
> {
  const methods = sessionMethods(client, service);
  const connection = await methods.get(sessionId);
  if (!connection.connected) {
    if (!connection.clientId) throw new Error('Google sign-in is not configured on this server.');
    const auth = await methods.auth(connection.clientId);
    if (auth.kind === 'cancelled') return { kind: 'cancelled' };
    await methods.connect({
      code: auth.code,
      codeVerifier: auth.codeVerifier,
      redirectUri: auth.redirectUri,
    });
  }
  // A chat toggle grants this session only; project-wide access is an explicit
  // project setting and must never be created as a side effect of a chat.
  const enabled = await methods.enable(sessionId);
  // Consent can switch accounts or remove scopes, revoking sibling grants.
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
  projectId: string | null | undefined,
  service: GoogleService,
): Promise<'project' | 'session'> {
  // A project grant keeps the session enabled, so revoking only the session
  // grant would leave access in place.
  if ((await projectGrant(client, projectId, service))?.enabled) {
    await client.disableProjectGoogleConnection(projectId!, service);
    return 'project';
  }
  await sessionMethods(client, service).disable(sessionId);
  return 'session';
}

export async function getProjectGoogleAccess(
  client: VerityClient,
  projectId: string | null | undefined,
): Promise<Record<GoogleService, boolean>> {
  const services = ['gmail', 'calendar', 'contacts'] as const;
  const grants = await Promise.all(
    services.map((service) =>
      projectGrant(client, projectId, service).then(
        (grant) => grant?.enabled === true,
        () => false,
      ),
    ),
  );
  return Object.fromEntries(services.map((service, index) => [service, grants[index]])) as Record<
    GoogleService,
    boolean
  >;
}

export async function hasConnectedGoogleAccount(
  client: VerityClient,
  sessionId: string,
): Promise<boolean> {
  try {
    return (await client.getGoogleConnection()).connected;
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
