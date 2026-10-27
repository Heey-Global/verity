import { act, renderHook } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { useSessionGoogleStatus } from './useSessionGoogleStatus';
import { connectSessionGoogleService } from '../lib/sessionGoogleAccess';

// Exercise Expo's real focus/blur cleanup, supplying only its navigation boundary.
const mockListeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
let mockFocused = true;
const mockNavigation = {
  isFocused: () => mockFocused,
  addListener: (event: 'focus' | 'blur', listener: () => void) => {
    mockListeners[event].add(listener);
    return () => mockListeners[event].delete(listener);
  },
};
jest.mock('expo-router', () => jest.requireActual('expo-router/build/useFocusEffect'));
jest.mock('expo-router/build/link/useLoadedNavigation', () => ({
  useOptionalNavigation: () => mockNavigation,
}));
jest.mock('expo-router/build/useNavigation', () => ({ useNavigation: () => mockNavigation }));
jest.mock('../lib/liveConnection', () => ({ subscribeLiveRefresh: jest.fn(() => jest.fn()) }));
const mockAuth = jest.fn();
jest.mock('../lib/googleDrive', () => ({
  runGoogleAccountAuth: (...args: unknown[]) => mockAuth(...args),
}));

function focus(value: boolean) {
  act(() => {
    mockFocused = value;
    for (const listener of [...mockListeners[value ? 'focus' : 'blur']]) listener();
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const drive = deferred<{ clientId: string }>();
  const getDrive = jest.fn(() => drive.promise);
  const connect = jest.fn().mockResolvedValue({
    accountId: 'new',
    scopes: ['gmail.readonly', 'gmail.compose', 'gmail.settings.basic'].map(
      (scope) => `https://www.googleapis.com/auth/${scope}`,
    ),
  });
  const connection = {
    enabled: true,
    connected: true,
    clientId: 'client',
    accountEmail: 'a@example.test',
  };
  const access = jest.fn().mockResolvedValue(connection);
  const get = jest.fn().mockResolvedValue(connection);
  const client = {
    getGoogleDriveConnection: getDrive,
    connectGoogleAccount: connect,
    setSessionGoogleAccess: access,
    getSessionGmailConnection: get,
    getSessionCalendarConnection: get,
    getSessionContactsConnection: get,
  } as unknown as VerityClient;
  const hook = renderHook(
    ({ ready }: { ready: boolean }) => useSessionGoogleStatus(client, 's', undefined, false, ready),
    { initialProps: { ready: false } },
  );
  return { ...hook, client, drive, getDrive, connect, access };
}
beforeEach(() => {
  mockFocused = true;
  mockListeners.focus.clear();
  mockListeners.blur.clear();
  mockAuth.mockReset();
});

it.each(['blur', 'unmount', 'return'] as const)(
  'does not start OAuth after pending discovery loses ownership on %s',
  async (leave) => {
    const hook = setup();
    const current = hook.result.current.invalidate();
    expect(current()).toBe(true);
    const pending = connectSessionGoogleService(hook.client, 's', 'gmail', null, current);
    expect(hook.getDrive).toHaveBeenCalledTimes(1);
    if (leave === 'unmount') hook.unmount();
    else {
      focus(false);
      if (leave === 'return') focus(true);
    }
    await act(async () => {
      hook.drive.resolve({ clientId: 'client' });
      expect(await pending).toEqual({ kind: 'cancelled' });
    });
    expect(current()).toBe(false);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(hook.connect).not.toHaveBeenCalled();
    expect(hook.access).not.toHaveBeenCalled();
  },
);

it('rejects actions started while blurred and permits a new action after returning', () => {
  const hook = setup();
  const old = hook.result.current.invalidate();
  focus(false);
  expect(hook.result.current.invalidate()()).toBe(false);
  focus(true);
  expect(old()).toBe(false);
  const current = hook.result.current.invalidate();
  expect(current()).toBe(true);
  hook.rerender({ ready: true });
  expect(current()).toBe(true);
  hook.unmount();
  expect(current()).toBe(false);
});

it('does not bind an OAuth result delivered after leaving the session', async () => {
  const hook = setup();
  const auth = deferred<{
    kind: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }>();
  mockAuth.mockReturnValueOnce(auth.promise);
  const current = hook.result.current.invalidate();
  const pending = connectSessionGoogleService(hook.client, 's', 'gmail', null, current);
  await act(async () => {
    hook.drive.resolve({ clientId: 'client' });
  });
  expect(mockAuth).toHaveBeenCalledTimes(1);
  focus(false);
  await act(async () => {
    auth.resolve({
      kind: 'success',
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'app:/oauth',
    });
    expect(await pending).toEqual({ kind: 'cancelled' });
  });
  expect(hook.connect).not.toHaveBeenCalled();
  expect(hook.access).not.toHaveBeenCalled();
});

it('does not grant session access after account exchange completes on a departed screen', async () => {
  const hook = setup();
  const exchanged = deferred<{ accountId: string; scopes: string[] }>();
  hook.connect.mockReturnValueOnce(exchanged.promise);
  mockAuth.mockResolvedValueOnce({
    kind: 'success',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  const pending = connectSessionGoogleService(
    hook.client,
    's',
    'gmail',
    null,
    hook.result.current.invalidate(),
  );
  await act(async () => {
    hook.drive.resolve({ clientId: 'client' });
  });
  expect(hook.connect).toHaveBeenCalledTimes(1);
  focus(false);
  await act(async () => {
    exchanged.resolve({ accountId: 'new', scopes: [] });
    expect(await pending).toEqual({ kind: 'cancelled' });
  });
  expect(hook.access).not.toHaveBeenCalled();
});

it('completes a newly authorized connection while the session remains focused', async () => {
  const hook = setup();
  mockAuth.mockResolvedValueOnce({
    kind: 'success',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  const pending = connectSessionGoogleService(
    hook.client,
    's',
    'gmail',
    null,
    hook.result.current.invalidate(),
  );
  await act(async () => {
    hook.drive.resolve({ clientId: 'client' });
    expect(await pending).toMatchObject({ kind: 'session' });
  });
  expect(hook.access).toHaveBeenCalledWith('s', 'gmail', { mode: 'account', accountId: 'new' });
});
