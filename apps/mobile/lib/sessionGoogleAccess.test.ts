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

it('directs project grants to project settings without changing session permissions', async () => {
  const { client, project, enable, disable } = fixture();
  project.mockResolvedValue({ connected: true, enabled: true });
  expect(await disconnectSessionGoogleService(client, 's1', 'p1', 'gmail')).toBe('project');
  expect(await connectSessionGoogleService(client, 's1', 'p1', 'gmail')).toEqual({
    kind: 'project',
  });
  expect(enable).not.toHaveBeenCalled();
  expect(disable).not.toHaveBeenCalled();
});

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
