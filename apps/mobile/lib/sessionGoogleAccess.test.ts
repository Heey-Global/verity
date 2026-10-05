import { VerityApiError, type VerityClient } from '@verity/mobile';
import {
  getProjectGoogleAccess,
  hasConnectedGoogleAccount,
  connectSessionGoogleService,
  disconnectSessionGoogleService,
} from './sessionGoogleAccess';

const mockAuth = jest.fn();
jest.mock('./googleDrive', () => ({
  runGmailAuth: (...args: unknown[]) => mockAuth(...args),
  runCalendarAuth: (...args: unknown[]) => mockAuth(...args),
  runContactsAuth: (...args: unknown[]) => mockAuth(...args),
}));

function fixture() {
  const get = jest.fn().mockResolvedValue({
    connected: true,
    enabled: false,
    clientId: 'google-client',
    accountEmail: 'me@example.test',
  });
  const enable = jest.fn().mockResolvedValue({
    connected: true,
    enabled: true,
    clientId: 'google-client',
    accountEmail: 'me@example.test',
  });
  const disable = jest.fn().mockResolvedValue(undefined);
  const connect = jest.fn().mockResolvedValue(undefined);
  const project = jest.fn().mockResolvedValue({ connected: true, enabled: false });
  const client = {
    getProjectGoogleConnection: project,
    enableProjectGoogleConnection: jest.fn().mockResolvedValue({ connected: true, enabled: true }),
    disableProjectGoogleConnection: jest.fn().mockResolvedValue(undefined),
    getSessionGmailConnection: get,
    getSessionCalendarConnection: get,
    getSessionContactsConnection: get,
    enableSessionGmail: enable,
    enableSessionCalendar: enable,
    enableSessionContacts: enable,
    disableSessionGmail: disable,
    disableSessionCalendar: disable,
    disableSessionContacts: disable,
    connectGmail: connect,
    connectCalendar: connect,
    connectContacts: connect,
  } as unknown as VerityClient;
  return { client, get, enable, disable, connect, project };
}

beforeEach(() => {
  mockAuth.mockReset();
});

it.each(['gmail', 'calendar', 'contacts'] as const)(
  'revokes legacy %s access on an older server',
  async (service) => {
    const { client, project, disable } = fixture();
    project.mockRejectedValue(new VerityApiError(404, 'Not found'));
    expect(await disconnectSessionGoogleService(client, 's1', 'p1', service)).toBe('session');
    expect(disable).toHaveBeenCalledWith('s1');
  },
);

it.each(['gmail', 'calendar', 'contacts'] as const)(
  'enables %s for the session only, even inside a project',
  async (service) => {
    const { client, project, enable } = fixture();
    const result = await connectSessionGoogleService(client, 's1', service);
    expect(result).toMatchObject({ kind: 'session', connection: { enabled: true } });
    // A project grant would silently extend access to every sibling chat.
    expect(client.enableProjectGoogleConnection).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(enable).toHaveBeenCalledWith('s1');
    expect(mockAuth).not.toHaveBeenCalled();
  },
);

it.each(['gmail', 'calendar', 'contacts'] as const)(
  'revokes only the session %s grant when the project has none',
  async (service) => {
    const { client, disable } = fixture();
    expect(await disconnectSessionGoogleService(client, 's1', 'p1', service)).toBe('session');
    expect(disable).toHaveBeenCalledWith('s1');
    expect(client.disableProjectGoogleConnection).not.toHaveBeenCalled();
  },
);

it.each(['gmail', 'calendar', 'contacts'] as const)(
  'revokes an enabled project %s grant that keeps the session enabled',
  async (service) => {
    const { client, project, disable } = fixture();
    project.mockResolvedValue({ connected: true, enabled: true });
    expect(await disconnectSessionGoogleService(client, 's1', 'p1', service)).toBe('project');
    expect(client.disableProjectGoogleConnection).toHaveBeenCalledWith('p1', service);
    expect(disable).not.toHaveBeenCalled();
  },
);

it('reports only enabled project grants as project access', async () => {
  const { client, project } = fixture();
  project.mockImplementation(async (_projectId: string, service: string) => {
    if (service === 'contacts') throw new VerityApiError(404, 'Not found');
    return { connected: true, enabled: service === 'calendar' };
  });
  await expect(getProjectGoogleAccess(client, 'p1')).resolves.toEqual({
    gmail: false,
    calendar: true,
    contacts: false,
  });
  await expect(getProjectGoogleAccess(client, undefined)).resolves.toEqual({
    gmail: false,
    calendar: false,
    contacts: false,
  });
});

it('does not bypass project authorization errors when revoking', async () => {
  const { client, project, disable } = fixture();
  project.mockRejectedValue(new VerityApiError(403, 'Forbidden'));
  await expect(disconnectSessionGoogleService(client, 's1', 'p1', 'gmail')).rejects.toThrow(
    'Forbidden',
  );
  expect(disable).not.toHaveBeenCalled();
});

it('honors cancellation and authorizes before enabling session access', async () => {
  const { client, get, connect, enable } = fixture();
  get.mockResolvedValue({ connected: false, enabled: false, clientId: 'google-client' });
  mockAuth.mockResolvedValueOnce({ kind: 'cancelled' });
  expect(await connectSessionGoogleService(client, 's1', 'calendar')).toEqual({
    kind: 'cancelled',
  });
  expect(connect).not.toHaveBeenCalled();
  expect(enable).not.toHaveBeenCalled();
  mockAuth.mockResolvedValueOnce({
    kind: 'success',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  expect(await connectSessionGoogleService(client, 's1', 'calendar')).toMatchObject({
    kind: 'session',
  });
  expect(connect).toHaveBeenCalledWith({
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  expect(enable).toHaveBeenCalledWith('s1');
});

it('refreshes sibling permissions after an OAuth account change', async () => {
  const { client, get, connect } = fixture();
  get.mockResolvedValue({ connected: false, enabled: false, clientId: 'google-client' });
  const gmail = jest
    .fn()
    .mockResolvedValue({ connected: true, enabled: true, accountEmail: 'new@example.test' });
  const calendar = jest
    .fn()
    .mockResolvedValue({ connected: true, enabled: false, accountEmail: 'new@example.test' });
  const contacts = jest
    .fn()
    .mockResolvedValue({ connected: false, enabled: false, accountEmail: null });
  Object.assign(client, {
    getSessionCalendarConnection: calendar,
    getSessionContactsConnection: contacts,
  });
  connect.mockImplementationOnce(() => {
    Object.assign(client, { getSessionGmailConnection: gmail });
    return Promise.resolve();
  });
  mockAuth.mockResolvedValueOnce({
    kind: 'success',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  const result = await connectSessionGoogleService(client, 's1', 'gmail');
  expect(result).toMatchObject({
    kind: 'session',
    connections: {
      gmail: { enabled: true, accountEmail: 'new@example.test' },
      calendar: { enabled: false },
      contacts: { enabled: false },
    },
  });
  expect(calendar).toHaveBeenCalledWith('s1');
  expect(contacts).toHaveBeenCalledWith('s1');
});

it('uses legacy account status only when the central endpoint is missing', async () => {
  const { client, get } = fixture();
  const central = jest.fn().mockRejectedValue(new VerityApiError(404, 'Not found'));
  Object.assign(client, { getGoogleConnection: central });
  await expect(hasConnectedGoogleAccount(client, 's1')).resolves.toBe(true);
  get.mockResolvedValue({ connected: false });
  await expect(hasConnectedGoogleAccount(client, 's1')).resolves.toBe(false);
  central.mockRejectedValue(new VerityApiError(403, 'Forbidden'));
  await expect(hasConnectedGoogleAccount(client, 's1')).rejects.toThrow('Forbidden');
});
it('does not expose legacy shortcuts when the central account is disconnected', async () => {
  const { client, get } = fixture();
  Object.assign(client, { getGoogleConnection: jest.fn().mockResolvedValue({ connected: false }) });
  await expect(hasConnectedGoogleAccount(client, 's1')).resolves.toBe(false);
  expect(get).not.toHaveBeenCalled();
});
