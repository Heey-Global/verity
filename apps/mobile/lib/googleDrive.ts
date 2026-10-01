// Native Google Workspace OAuth (PKCE) for the connect flow (ADRs 0009/0016/0017). The Verity
// server is never publicly reachable, so the redirect must return into THIS app,
// not the server: we run the authorization request in the system browser against
// the iOS OAuth client and hand the resulting one-time `code` + PKCE verifier to
// the server, which does the token exchange outbound and keeps the refresh token.
import type { VerityClient } from '@verity/mobile';
import { Alert } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

// Dismisses any lingering auth session view when the app is re-focused. Safe to
// call at module load; a no-op on native but recommended by expo-auth-session.
void WebBrowser.maybeCompleteAuthSession();

const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

// A linked folder is a read/write project workspace. Google does not grant
// folder-wide access to existing children through `drive.file`, so request the
// Drive scope and enforce the selected folder at Verity's project boundary.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

/**
 * The redirect URI for a Google *iOS* OAuth client: the reversed client id as a
 * URL scheme. Google requires exactly this shape for iOS clients — e.g. client
 * `123-abc.apps.googleusercontent.com` → `com.googleusercontent.apps.123-abc:/oauthredirect`.
 */
function googleDriveRedirectUri(clientId: string): string {
  const suffix = clientId.replace(/\.apps\.googleusercontent\.com$/, '');
  return `com.googleusercontent.apps.${suffix}:/oauthredirect`;
}

export type GoogleDriveAuthResult =
  | { kind: 'success'; code: string; codeVerifier: string; redirectUri: string }
  | { kind: 'cancelled' };

/**
 * Run the interactive Google authorization. Returns the one-time code + PKCE
 * verifier + redirect uri to forward to the server, or `cancelled` if the user
 * dismissed the browser. `access_type=offline` + `prompt=consent` force Google to
 * mint a refresh token every time (so a reconnect always yields a fresh token).
 */
export async function runGoogleDriveAuth(clientId: string): Promise<GoogleDriveAuthResult> {
  if (
    !(await explainGoogleAccess(
      'Google Drive',
      'Browse and import files, and use connected project folders as read/write workspaces. Docs, Sheets, and Slides editing is requested together when you first select a native file.',
    ))
  )
    return { kind: 'cancelled' };
  return runGoogleAuth(clientId, SCOPES);
}

/** Incremental authorization retains existing grants without requesting unrelated services. */
export async function runGmailAuth(clientId: string): Promise<GoogleDriveAuthResult> {
  if (
    !(await explainGoogleAccess(
      'Gmail',
      'Read email, create drafts, and send only after your approval. Verity also reads your Gmail signature for drafts.',
    ))
  )
    return { kind: 'cancelled' };
  return runGoogleAuth(clientId, GMAIL_SCOPES);
}

/** Calendar mutations are gated by per-action approval on the server. */
export async function runCalendarAuth(clientId: string): Promise<GoogleDriveAuthResult> {
  if (
    !(await explainGoogleAccess(
      'Google Calendar',
      'Read calendars and events. Creating, changing, or deleting events requires your approval, including attendee invitations and Google Meet links. Your account email identifies the connection.',
    ))
  )
    return { kind: 'cancelled' };
  return runGoogleAuth(clientId, [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
  ]);
}

export async function runContactsAuth(clientId: string): Promise<GoogleDriveAuthResult> {
  if (
    !(await explainGoogleAccess(
      'Google Contacts',
      'Read contact names and email addresses to find recipients for email and calendar invitations. Verity cannot change your contacts. Your account email identifies the connection.',
    ))
  )
    return { kind: 'cancelled' };
  return runGoogleAuth(clientId, [
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ]);
}

const WORKSPACE_SCOPES = ['documents', 'spreadsheets', 'presentations'].map(
  (name) => `https://www.googleapis.com/auth/${name}`,
);

function googleWorkspaceScope(mimeType: string): string | null {
  const scopes: Record<string, string> = {
    'application/vnd.google-apps.document': 'documents',
    'application/vnd.google-apps.spreadsheet': 'spreadsheets',
    'application/vnd.google-apps.presentation': 'presentations',
  };
  const name = scopes[mimeType];
  return name ? `https://www.googleapis.com/auth/${name}` : null;
}

export async function runGoogleWorkspaceAuth(
  clientId: string,
  mimeType: string,
): Promise<GoogleDriveAuthResult> {
  const scope = googleWorkspaceScope(mimeType);
  if (!scope) throw new Error('Unsupported Google Workspace file type');
  if (
    !(await explainGoogleAccess(
      'Workspace editing',
      'Read and edit Google Docs, Sheets, and Slides together. Google grants access to all three file types across your account; Verity limits edits to the file you select for this session.',
    ))
  )
    return { kind: 'cancelled' };
  return runGoogleAuth(clientId, WORKSPACE_SCOPES);
}

function explainGoogleAccess(service: string, purpose: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      `Connect ${service}?`,
      purpose,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

async function runGoogleAuth(clientId: string, scopes: string[]): Promise<GoogleDriveAuthResult> {
  const redirectUri = googleDriveRedirectUri(clientId);
  const request = new AuthSession.AuthRequest({
    clientId,
    scopes,
    redirectUri,
    usePKCE: true,
    responseType: AuthSession.ResponseType.Code,
    extraParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  });
  // Building the URL generates and stores the PKCE code verifier on the request.
  await request.makeAuthUrlAsync(DISCOVERY);
  const result = await request.promptAsync(DISCOVERY);
  if (result.type !== 'success' || typeof result.params.code !== 'string') {
    return { kind: 'cancelled' };
  }
  const codeVerifier = request.codeVerifier;
  if (codeVerifier === undefined || codeVerifier.length === 0) {
    throw new Error('Google authorization did not produce a PKCE verifier');
  }
  return { kind: 'success', code: result.params.code, codeVerifier, redirectUri };
}

export async function ensureGoogleWorkspaceAccess(
  client: VerityClient,
  mimeType: string,
): Promise<boolean> {
  const scope = googleWorkspaceScope(mimeType);
  if (!scope) throw new Error('Unsupported Google Workspace file type');
  const connection = await client.getGoogleDriveConnection();
  if (WORKSPACE_SCOPES.every((required) => connection.scopes.includes(required))) return true;
  if (!connection.clientId) throw new Error('Google sign-in is not configured');
  const auth = await runGoogleWorkspaceAuth(connection.clientId, mimeType);
  if (auth.kind === 'cancelled') return false;
  await client.connectGoogleDrive(auth);
  return true;
}
