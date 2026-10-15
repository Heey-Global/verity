import type { VerityClient } from '@verity/mobile';
import { connectSessionGoogleService, disconnectSessionGoogleService } from './sessionGoogleAccess';
const mockAuth = jest.fn();
jest.mock('./googleDrive', () => ({
  runGmailAuth: (...args: unknown[]) => mockAuth(...args),
  runCalendarAuth: (...args: unknown[]) => mockAuth(...args),
  runContactsAuth: (...args: unknown[]) => mockAuth(...args),
}));
const scopes = [
  'gmail.readonly',
  'gmail.compose',
  'gmail.settings.basic',
  'calendar.calendarlist.readonly',
  'calendar.events',
  'contacts.readonly',
].map((scope) => `https://www.googleapis.com/auth/${scope}`);
function fixture() {
  const get = jest.fn().mockResolvedValue({
    enabled: true,
    connected: true,
    clientId: 'client',
    accountEmail: 'one@example.test',
  });
  const access = jest.fn().mockResolvedValue({
    enabled: true,
    connected: true,
    clientId: 'client',
    accountEmail: 'one@example.test',
  });
  const accounts = jest.fn().mockResolvedValue([{ id: 'one', scopes }]);
  const connect = jest.fn().mockResolvedValue({ accountId: 'new' });
  const client = {
    listGoogleAccounts: accounts,
    setSessionGoogleAccess: access,
    getGoogleDriveConnection: jest.fn().mockResolvedValue({ clientId: 'client' }),
    getSessionGmailConnection: get,
    getSessionCalendarConnection: get,
    getSessionContactsConnection: get,
    connectGmail: connect,
    connectCalendar: connect,
    connectContacts: connect,
    disableProjectGoogleConnection: jest.fn(),
    enableProjectGoogleConnection: jest.fn(),
  } as unknown as VerityClient;
  return { client, get, access, accounts, connect };
}
beforeEach(() => mockAuth.mockReset());
it.each(['gmail', 'calendar', 'contacts'] as const)(
  'selects the only eligible %s account without OAuth',
  async (service) => {
    const { client, access } = fixture();
    expect(await connectSessionGoogleService(client, 's1', service)).toMatchObject({
      kind: 'session',
    });
    expect(access).toHaveBeenCalledWith('s1', service, { mode: 'account', accountId: 'one' });
    expect(mockAuth).not.toHaveBeenCalled();
    expect(client.enableProjectGoogleConnection).not.toHaveBeenCalled();
  },
);
it.each(['gmail', 'calendar', 'contacts'] as const)(
  'disables inherited %s only for this chat',
  async (service) => {
    const { client, access } = fixture();
    expect(await disconnectSessionGoogleService(client, 's1', 'p1', service)).toBe('session');
    expect(access).toHaveBeenCalledWith('s1', service, { mode: 'disabled' });
    expect(client.disableProjectGoogleConnection).not.toHaveBeenCalled();
  },
);
it('refuses an ambiguous account and uses an explicit selection', async () => {
  const { client, access, accounts } = fixture();
  accounts.mockResolvedValue([
    { id: 'one', scopes },
    { id: 'two', scopes },
  ]);
  await expect(connectSessionGoogleService(client, 's1', 'gmail')).rejects.toThrow(
    'Choose a Google account',
  );
  expect(access).not.toHaveBeenCalled();
  await connectSessionGoogleService(client, 's1', 'gmail', 'two');
  expect(access).toHaveBeenCalledWith('s1', 'gmail', { mode: 'account', accountId: 'two' });
});
it('honors OAuth cancellation and binds a newly connected identity', async () => {
  const { client, access, connect } = fixture();
  mockAuth.mockResolvedValueOnce({ kind: 'cancelled' });
  expect(await connectSessionGoogleService(client, 's1', 'gmail', null)).toEqual({
    kind: 'cancelled',
  });
  expect(access).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  mockAuth.mockResolvedValueOnce({
    kind: 'success',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  await connectSessionGoogleService(client, 's1', 'gmail', null);
  expect(access).toHaveBeenCalledWith('s1', 'gmail', { mode: 'account', accountId: 'new' });
});
