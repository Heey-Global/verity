import type { VerityClient } from '@verity/mobile';
import { Alert, Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import {
  ensureGoogleWorkspaceAccess,
  runCalendarAuth,
  runContactsAuth,
  runGmailAuth,
  runGoogleDriveAuth,
  runGoogleWorkspaceAuth,
} from './googleDrive';

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

it.each([
  ['Gmail', runGmailAuth, ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic']],
  [
    'Calendar',
    runCalendarAuth,
    ['calendar.calendarlist.readonly', 'calendar.events', 'userinfo.email'],
  ],
  ['Contacts', runContactsAuth, ['contacts.readonly', 'userinfo.email']],
  ['Drive', runGoogleDriveAuth, ['drive']],
] as const)(
  'explains %s and requests only its own incremental scopes',
  async (_name, authorize, scopes) => {
    await authorize('client.apps.googleusercontent.com');
    expect(Alert.alert).toHaveBeenCalled();
    expect(AuthSession.AuthRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: scopes.map((scope) => `https://www.googleapis.com/auth/${scope}`),
        extraParams: expect.objectContaining({ include_granted_scopes: 'true' }),
      }),
    );
  },
);

it('requests the Docs, Sheets, and Slides editing bundle together', async () => {
  const mime = 'application/vnd.google-apps.document';
  await runGoogleWorkspaceAuth('client.apps.googleusercontent.com', mime);
  expect(AuthSession.AuthRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      scopes: ['documents', 'spreadsheets', 'presentations'].map(
        (name) => `https://www.googleapis.com/auth/${name}`,
      ),
    }),
  );
});

it('does not open Google sign-in after purpose consent is cancelled', async () => {
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) =>
      buttons?.find((button) => button.text === 'Cancel')?.onPress?.(),
    );
  await expect(runContactsAuth('client')).resolves.toEqual({ kind: 'cancelled' });
  expect(AuthSession.AuthRequest).not.toHaveBeenCalled();
});

it('expands a partial legacy Workspace grant to the whole bundle', async () => {
  const client = {
    getGoogleDriveConnection: jest.fn().mockResolvedValue({
      clientId: 'client',
      scopes: ['https://www.googleapis.com/auth/documents'],
    }),
    connectGoogleDrive: jest.fn().mockResolvedValue({}),
  } as unknown as VerityClient;
  await ensureGoogleWorkspaceAccess(client, 'application/vnd.google-apps.document');
  expect(client.connectGoogleDrive).toHaveBeenCalled();
  expect(AuthSession.AuthRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      scopes: ['documents', 'spreadsheets', 'presentations'].map(
        (name) => `https://www.googleapis.com/auth/${name}`,
      ),
    }),
  );
});

it('uses a complete Workspace bundle without asking for consent again', async () => {
  const client = {
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
    const result = await runContactsAuth('client');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('calendar invitations'));
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(result.kind).toBe(accepted ? 'success' : 'cancelled');
    expect(AuthSession.AuthRequest).toHaveBeenCalledTimes(accepted ? 1 : 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'confirm', original);
    else Reflect.deleteProperty(globalThis, 'confirm');
  }
});
