import { isDemoMode } from './demoMode';
import type { VerityClient } from '@verity/mobile';
import { Alert, Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import { ensureGoogleWorkspaceAccess, runGoogleAccountAuth } from './googleDrive';
import { GOOGLE_SERVICES, missingGoogleServices } from './googleServices';

jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('expo-auth-session', () => ({
  ResponseType: { Code: 'code' },
  AuthRequest: jest.fn().mockImplementation(() => ({
    codeVerifier: 'verifier',
    makeAuthUrlAsync: jest.fn(),
    promptAsync: jest.fn().mockResolvedValue({ type: 'success', params: { code: 'code' } }),
  })),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) =>
      buttons?.find((button) => button.text === 'Continue')?.onPress?.(),
    );
});
afterEach(() => jest.restoreAllMocks());

const allScopes = GOOGLE_SERVICES.flatMap((service) => service.scopes);

it('explains once and requests every service plus the identifying email together', async () => {
  await runGoogleAccountAuth('client.apps.googleusercontent.com');
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  expect(AuthSession.AuthRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      scopes: [...allScopes, 'https://www.googleapis.com/auth/userinfo.email'],
      extraParams: expect.objectContaining({
        include_granted_scopes: 'true',
        prompt: 'select_account consent',
      }),
    }),
  );
});

// A service missing only one of its scopes is still unusable on the server.
it('lists services whose grant is incomplete as missing', () => {
  expect(missingGoogleServices(allScopes)).toEqual([]);
  expect(
    missingGoogleServices(
      allScopes.filter(
        (scope) => !scope.endsWith('/calendar.events') && !scope.includes('contacts'),
      ),
    ),
  ).toEqual(['Calendar', 'Contacts']);
  expect(missingGoogleServices([])).toEqual(GOOGLE_SERVICES.map((service) => service.name));
});

it('does not open Google sign-in after purpose consent is cancelled', async () => {
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) =>
      buttons?.find((button) => button.text === 'Cancel')?.onPress?.(),
    );
  await expect(runGoogleAccountAuth('client')).resolves.toEqual({ kind: 'cancelled' });
  expect(AuthSession.AuthRequest).not.toHaveBeenCalled();
});

it('adds a partial Workspace grant to the selected account through the shared login', async () => {
  const client = {
    listGoogleAccounts: jest
      .fn()
      .mockResolvedValue([{ id: 'one', scopes: ['https://www.googleapis.com/auth/documents'] }]),
    getGoogleDriveConnection: jest.fn().mockResolvedValue({ clientId: 'client', scopes: [] }),
    connectGoogleAccount: jest.fn().mockResolvedValue({ accountId: 'one', scopes: allScopes }),
  } as unknown as VerityClient;
  await expect(
    ensureGoogleWorkspaceAccess(client, 'application/vnd.google-apps.document', 'one'),
  ).resolves.toBe(true);
  expect(client.connectGoogleAccount).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'one', code: 'code' }),
  );
  expect(AuthSession.AuthRequest).toHaveBeenCalledWith(
    expect.objectContaining({ scopes: expect.arrayContaining(allScopes) }),
  );
});

// Without this, a declined grant would assign a file the agent then cannot open.
it('reports a Workspace grant that was deselected on the Google screen', async () => {
  const client = {
    listGoogleAccounts: jest.fn().mockResolvedValue([]),
    getGoogleDriveConnection: jest.fn().mockResolvedValue({ clientId: 'client', scopes: [] }),
    connectGoogleAccount: jest.fn().mockResolvedValue({
      accountId: 'one',
      scopes: GOOGLE_SERVICES[0].scopes,
    }),
  } as unknown as VerityClient;
  await expect(
    ensureGoogleWorkspaceAccess(client, 'application/vnd.google-apps.document'),
  ).rejects.toThrow('Google did not grant access to Docs, Sheets & Slides');
});

it('uses a complete Workspace bundle without asking for consent again', async () => {
  const client = {
    listGoogleAccounts: jest.fn().mockResolvedValue([]),
    getGoogleDriveConnection: jest.fn().mockResolvedValue({
      clientId: 'client',
      scopes: ['documents', 'spreadsheets', 'presentations'].map(
        (name) => `https://www.googleapis.com/auth/${name}`,
      ),
    }),
  } as unknown as VerityClient;
  await expect(
    ensureGoogleWorkspaceAccess(client, 'application/vnd.google-apps.document'),
  ).resolves.toBe(true);
  expect(AuthSession.AuthRequest).not.toHaveBeenCalled();
});

// Web Alert callbacks never run; consent must resolve without the native dialog.
it.each([true, false])('resolves browser consent with acceptance=%s', async (accepted) => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  const confirm = jest.fn().mockReturnValue(accepted);
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: confirm });
  try {
    const result = await runGoogleAccountAuth('client');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('deselect'));
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(result.kind).toBe(accepted ? 'success' : 'cancelled');
    expect(AuthSession.AuthRequest).toHaveBeenCalledTimes(accepted ? 1 : 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'confirm', original);
    else Reflect.deleteProperty(globalThis, 'confirm');
  }
});

jest.mock('./demoMode', () => ({ isDemoMode: jest.fn().mockReturnValue(false) }));
afterEach(() => jest.mocked(isDemoMode).mockReturnValue(false));

it('does not launch Google OAuth from the local demo', async () => {
  jest.mocked(isDemoMode).mockReturnValue(true);
  await expect(runGoogleAccountAuth('client.apps.googleusercontent.com')).rejects.toThrow(
    'Exit the demo',
  );
  expect(AuthSession.AuthRequest).not.toHaveBeenCalled();
});

it('rejects ambiguous Workspace consent instead of trusting combined scopes', async () => {
  const client = {
    listGoogleAccounts: jest.fn().mockResolvedValue([{ id: 'one' }, { id: 'two' }]),
    getGoogleDriveConnection: jest.fn().mockResolvedValue({
      clientId: 'client',
      scopes: ['documents', 'spreadsheets', 'presentations'].map(
        (scope) => 'https://www.googleapis.com/auth/' + scope,
      ),
    }),
  } as unknown as VerityClient;
  await expect(
    ensureGoogleWorkspaceAccess(client, 'application/vnd.google-apps.document'),
  ).rejects.toThrow('Choose a Google account');
  expect(AuthSession.AuthRequest).not.toHaveBeenCalled();
});
