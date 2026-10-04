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
  projectId: string | null | undefined,
  service: GoogleService,
): Promise<
  | { kind: 'cancelled' }
  | {
      kind: 'session';
      connection: GmailSessionConnection;
      connections: Record<GoogleService, GmailSessionConnection | null>;
    }
> {
  const grant = await projectGrant(client, projectId, service);
  const methods = sessionMethods(client, service);
  const connection = grant ?? (await methods.get(sessionId));
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
  const enabled =
    grant && projectId
      ? await client.enableProjectGoogleConnection(projectId, service)
      : await methods.enable(sessionId);
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
  if (await projectGrant(client, projectId, service)) {
    await client.disableProjectGoogleConnection(projectId!, service);
    return 'project';
  }
  await sessionMethods(client, service).disable(sessionId);
  return 'session';
}
