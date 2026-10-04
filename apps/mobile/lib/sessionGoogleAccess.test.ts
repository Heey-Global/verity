import { VerityApiError, type VerityClient } from '@verity/mobile';
import { connectSessionGoogleService, disconnectSessionGoogleService } from './sessionGoogleAccess';

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
  'enables %s in a projectless session without broadening access',
  async (service) => {
    const { client, project, enable } = fixture();
    const result = await connectSessionGoogleService(client, 's1', undefined, service);
    expect(result).toMatchObject({ kind: 'session', connection: { enabled: true } });
    expect(project).not.toHaveBeenCalled();
    expect(enable).toHaveBeenCalledWith('s1');
    expect(mockAuth).not.toHaveBeenCalled();
  },
);

it.each(['gmail', 'calendar', 'contacts'] as const)(
  'toggles only the selected project %s grant directly',
  async (service) => {
    const { client, enable, disable } = fixture();
    expect(await connectSessionGoogleService(client, 's1', 'p1', service)).toMatchObject({
      kind: 'session',
      connection: { enabled: true },
    });
    expect(client.enableProjectGoogleConnection).toHaveBeenCalledWith('p1', service);
    expect(await disconnectSessionGoogleService(client, 's1', 'p1', service)).toBe('project');
    expect(client.disableProjectGoogleConnection).toHaveBeenCalledWith('p1', service);
    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  },
);

it('does not bypass project authorization errors', async () => {
  const { client, project, enable, disable } = fixture();
  project.mockRejectedValue(new VerityApiError(403, 'Forbidden'));
  await expect(disconnectSessionGoogleService(client, 's1', 'p1', 'gmail')).rejects.toThrow(
    'Forbidden',
  );
  await expect(connectSessionGoogleService(client, 's1', 'p1', 'gmail')).rejects.toThrow(
    'Forbidden',
  );
  expect(enable).not.toHaveBeenCalled();
  expect(disable).not.toHaveBeenCalled();
});

it('honors cancellation and authorizes before enabling legacy access', async () => {
  const { client, project, get, connect, enable } = fixture();
  project.mockRejectedValue(new VerityApiError(404, 'Not found'));
  get.mockResolvedValue({ connected: false, enabled: false, clientId: 'google-client' });
  mockAuth.mockResolvedValueOnce({ kind: 'cancelled' });
  expect(await connectSessionGoogleService(client, 's1', 'p1', 'calendar')).toEqual({
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
  expect(await connectSessionGoogleService(client, 's1', 'p1', 'calendar')).toMatchObject({
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
  const result = await connectSessionGoogleService(client, 's1', undefined, 'gmail');
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

it('authorizes a missing project scope before enabling the selected service', async () => {
  const { client, project, connect, enable } = fixture();
  project.mockResolvedValue({ connected: false, enabled: false, clientId: 'google-client' });
  mockAuth.mockResolvedValueOnce({ kind: 'cancelled' });
  await expect(connectSessionGoogleService(client, 's1', 'p1', 'gmail')).resolves.toEqual({
    kind: 'cancelled',
  });
  expect(client.enableProjectGoogleConnection).not.toHaveBeenCalled();
  mockAuth.mockResolvedValueOnce({
    kind: 'success',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'app:/oauth',
  });
  await connectSessionGoogleService(client, 's1', 'p1', 'gmail');
  expect(connect).toHaveBeenCalled();
  expect(client.enableProjectGoogleConnection).toHaveBeenCalledWith('p1', 'gmail');
  expect(enable).not.toHaveBeenCalled();
});
