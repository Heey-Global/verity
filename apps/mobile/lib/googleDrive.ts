// Native Google Workspace OAuth (PKCE) for the connect flow (ADRs 0009/0016/0017). The Verity
// server is never publicly reachable, so the redirect must return into THIS app,
// not the server: we run the authorization request in the system browser against
// the iOS OAuth client and hand the resulting one-time `code` + PKCE verifier to
// the server, which does the token exchange outbound and keeps the refresh token.
import type { VerityClient } from '@verity/mobile';
import { Alert, Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { isDemoMode } from './demoMode';
import { GOOGLE_SERVICES, googleScope as scope, missingGoogleServices } from './googleServices';

// Dismisses any lingering auth session view when the app is re-focused. Safe to
// call at module load; a no-op on native but recommended by expo-auth-session.
void WebBrowser.maybeCompleteAuthSession();

const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

// The account email identifies the connection even when every service is deselected.
const ACCOUNT_SCOPES = [
  ...GOOGLE_SERVICES.flatMap((service) => service.scopes),
  scope('userinfo.email'),
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
 * Run the interactive Google authorization for every service at once. Returns the one-time
 * code + PKCE verifier + redirect uri to forward to the server, or `cancelled` if the user
 * dismissed the browser. `access_type=offline` + `prompt=consent` force Google to mint a
 * refresh token every time (so a reconnect always yields a fresh token).
 */
export async function runGoogleAccountAuth(clientId: string): Promise<GoogleDriveAuthResult> {
  if (!(await explainGoogleAccess())) return { kind: 'cancelled' };
  return runGoogleAuth(clientId, ACCOUNT_SCOPES);
}

function googleWorkspaceScope(mimeType: string): string | null {
  const names: Record<string, string> = {
    'application/vnd.google-apps.document': 'documents',
    'application/vnd.google-apps.spreadsheet': 'spreadsheets',
    'application/vnd.google-apps.presentation': 'presentations',
  };
  const name = names[mimeType];
  return name ? scope(name) : null;
}

const GOOGLE_ACCESS_TITLE = 'Connect Google account?';
const GOOGLE_ACCESS_PURPOSE =
  'Verity requests Drive, Gmail, Calendar, Contacts, and Docs, Sheets & Slides together. You can deselect any of them on the Google screen. Each project decides which account it uses, and sending email or changing events still needs your approval.';

function explainGoogleAccess(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(
      typeof globalThis.confirm === 'function' &&
        globalThis.confirm(`${GOOGLE_ACCESS_TITLE}\n\n${GOOGLE_ACCESS_PURPOSE}`),
    );
  }
  return new Promise((resolve) =>
    Alert.alert(
      GOOGLE_ACCESS_TITLE,
      GOOGLE_ACCESS_PURPOSE,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

async function runGoogleAuth(clientId: string, scopes: string[]): Promise<GoogleDriveAuthResult> {
  if (isDemoMode())
    throw new Error('Google sign-in requires your own Verity server. Exit the demo to connect.');
  const redirectUri = googleDriveRedirectUri(clientId);
  const request = new AuthSession.AuthRequest({
    clientId,
    scopes,
    redirectUri,
    usePKCE: true,
    responseType: AuthSession.ResponseType.Code,
    extraParams: {
      access_type: 'offline',
      prompt: 'select_account consent',
      include_granted_scopes: 'true',
    },
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
  accountId?: string,
): Promise<boolean> {
  if (!googleWorkspaceScope(mimeType)) throw new Error('Unsupported Google Workspace file type');
  const connection = await client.getGoogleDriveConnection();
  const accounts = await client.listGoogleAccounts();
  if (!accountId && accounts.length > 1) throw new Error('Choose a Google account');
  const selected = accountId ? accounts.find((account) => account.id === accountId) : accounts[0];
  if (accountId && !selected) throw new Error('The Google account is no longer connected');
  if (
    !missingGoogleServices(selected?.scopes ?? connection.scopes).includes('Docs, Sheets & Slides')
  )
    return true;
  if (!connection.clientId) throw new Error('Google sign-in is not configured');
  const auth = await runGoogleAccountAuth(connection.clientId);
  if (auth.kind === 'cancelled') return false;
  const connected = await client.connectGoogleAccount({
    ...auth,
    ...(selected ? { accountId: selected.id } : {}),
  });
  if (missingGoogleServices(connected.scopes).includes('Docs, Sheets & Slides'))
    throw new Error('Google did not grant access to Docs, Sheets & Slides');
  return true;
}
