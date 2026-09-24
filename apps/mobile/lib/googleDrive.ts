// Native Google Workspace OAuth (PKCE) for the connect flow (ADRs 0009/0016/0017). The Verity
// server is never publicly reachable, so the redirect must return into THIS app,
// not the server: we run the authorization request in the system browser against
// the iOS OAuth client and hand the resulting one-time `code` + PKCE verifier to
// the server, which does the token exchange outbound and keeps the refresh token.
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
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
];
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
  return runGoogleAuth(clientId, SCOPES);
}

/** Authorize Gmail while retaining the existing Workspace grants. Google can
 * replace the stored refresh token during incremental authorization, so the
 * request deliberately includes the full union rather than Gmail alone. */
export async function runGmailAuth(clientId: string): Promise<GoogleDriveAuthResult> {
  return runGoogleAuth(clientId, [...SCOPES, ...GMAIL_SCOPES]);
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
