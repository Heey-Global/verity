import AsyncStorage from '@react-native-async-storage/async-storage';
import { dispatchTaskIssue, taskIssueRetry, taskIssueSessions } from './taskIssueDispatch';
import { createSessionConfirmingWarnings } from './startSession';
const mockClient = {
  sendTurn: jest.fn(async () => ({ accepted: true })),
  listSessions: jest.fn(async () => [{ sessionId: 's', projectId: 'p', resumable: true }]),
};
jest.mock('./client', () => ({
  getVerityBaseUrl: () => 'https://example.test',
  createVerityClient: () => mockClient,
}));
jest.mock('./authToken', () => ({
  getAuthToken: () => 'secret',
  getAuthTokenId: () => 'identity',
}));
jest.mock('./browserSession', () => ({ getBrowserSession: () => null }));
jest.mock('./startSession', () => ({
  createSessionConfirmingWarnings: jest.fn(async () => ({ existing: false })),
}));
let mockCounter = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockCounter}` }));
const issue = {
  number: 42,
  title: 'Fix keyboard',
  url: 'https://github.com/example/repo/issues/42',
};
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockCounter = 0;
  mockClient.listSessions.mockResolvedValue([{ sessionId: 's', projectId: 'p', resumable: true }]);
});
it('retries a lost turn response with the same session and reply IDs', async () => {
  mockClient.sendTurn.mockRejectedValueOnce(new Error('Network lost'));
  await expect(dispatchTaskIssue('p', issue)).rejects.toThrow('Network lost');
  expect(await taskIssueRetry('p', issue.number)).toEqual({});
  mockClient.listSessions.mockResolvedValue([
    { sessionId: 'uuid-1', projectId: 'p', resumable: true },
  ]);
  const id = await dispatchTaskIssue('p', issue);
  expect(await taskIssueRetry('p', issue.number)).toBeNull();
  expect(id).toBe('uuid-1');
  expect(createSessionConfirmingWarnings).toHaveBeenCalledWith(mockClient, {
    sessionId: id,
    projectId: 'p',
    issue: 42,
  });
  expect(mockClient.sendTurn.mock.calls[1]).toEqual(mockClient.sendTurn.mock.calls[0]);
  mockClient.listSessions.mockResolvedValue([{ sessionId: id, projectId: 'p', resumable: true }]);
  await dispatchTaskIssue('p', issue);
  expect(mockClient.sendTurn).toHaveBeenCalledTimes(2);
});
it('rejects dispatch into a different project', async () => {
  await expect(dispatchTaskIssue('other', issue, 's')).rejects.toThrow(
    'Choose a resumable session',
  );
  expect(mockClient.sendTurn).not.toHaveBeenCalled();
});
it('sends to the existing project session without provisioning one', async () => {
  expect(await dispatchTaskIssue('p', issue, 's')).toBe('s');
  expect(createSessionConfirmingWarnings).not.toHaveBeenCalled();
  expect(mockClient.sendTurn).toHaveBeenCalledWith(
    's',
    expect.objectContaining({ clientReplyId: 'uuid-1', prompt: expect.stringContaining('#42') }),
  );
});

it.each([
  { sessions: [] },
  { sessions: [{ sessionId: 'uuid-1', projectId: 'p', resumable: false }] },
])(
  'starts fresh when the previously dispatched session is gone or unusable: %j',
  async ({ sessions }) => {
    await dispatchTaskIssue('p', issue);
    mockClient.listSessions.mockResolvedValue(sessions);
    expect(await dispatchTaskIssue('p', issue)).toBe('uuid-3');
    expect(mockClient.sendTurn).toHaveBeenCalledTimes(2);
  },
);
it('revalidates explicit targets even after a completed dispatch', async () => {
  await dispatchTaskIssue('p', issue, 's');
  mockClient.listSessions.mockResolvedValue([]);
  await expect(dispatchTaskIssue('p', issue, 's')).rejects.toThrow('Choose a resumable session');
  expect(mockClient.sendTurn).toHaveBeenCalledTimes(1);
});

it('discovers an unsent This Session turn after leaving that session', async () => {
  mockClient.sendTurn.mockRejectedValueOnce(new Error('Lost response'));
  await expect(dispatchTaskIssue('p', issue, 's')).rejects.toThrow('Lost response');
  expect(await taskIssueRetry('p', issue.number)).toEqual({ targetSessionId: 's' });
  await dispatchTaskIssue('p', issue, 's');
  expect(mockClient.sendTurn.mock.calls[1]).toEqual(mockClient.sendTurn.mock.calls[0]);
});
it.each([
  { sessions: [] },
  { sessions: [{ sessionId: 'uuid-1', projectId: 'p', resumable: false }] },
])(
  'recovers an unsent issue turn after its created session becomes unavailable: %j',
  async ({ sessions }) => {
    mockClient.sendTurn.mockRejectedValueOnce(new Error('Lost response'));
    await expect(dispatchTaskIssue('p', issue)).rejects.toThrow('Lost response');
    mockClient.listSessions.mockResolvedValue(sessions);
    expect(await dispatchTaskIssue('p', issue)).toBe('uuid-3');
    expect(mockClient.sendTurn).toHaveBeenLastCalledWith('uuid-3', expect.anything());
  },
);

it.each([
  { sessions: [] },
  { sessions: [{ sessionId: 'uuid-1', projectId: 'p', resumable: false }] },
])(
  'keeps the original ID after a lost create response while provisioning is unresolved: %j',
  async ({ sessions }) => {
    jest
      .mocked(createSessionConfirmingWarnings)
      .mockRejectedValueOnce(new Error('Lost create response'));
    await expect(dispatchTaskIssue('p', issue)).rejects.toThrow('Lost create response');
    mockClient.listSessions.mockResolvedValue(sessions);
    expect(await dispatchTaskIssue('p', issue)).toBe('uuid-1');
    expect(createSessionConfirmingWarnings).toHaveBeenNthCalledWith(
      2,
      mockClient,
      expect.objectContaining({ sessionId: 'uuid-1' }),
    );
    expect(mockClient.sendTurn).toHaveBeenCalledTimes(1);
  },
);

it.each([{ sessions: [] }, { sessions: [{ sessionId: 's', projectId: 'p', resumable: false }] }])(
  'retires unsent invalid explicit targets before starting a new session: %j',
  async ({ sessions }) => {
    mockClient.sendTurn.mockRejectedValueOnce(new Error('Lost response'));
    await expect(dispatchTaskIssue('p', issue, 's')).rejects.toThrow('Lost response');
    expect(await taskIssueRetry('p', issue.number)).toEqual({ targetSessionId: 's' });
    mockClient.listSessions.mockResolvedValue(sessions);
    await expect(dispatchTaskIssue('p', issue, 's')).rejects.toThrow('Choose a resumable session');
    expect(await taskIssueRetry('p', issue.number)).toBeNull();
    await dispatchTaskIssue('p', issue);
    expect(await taskIssueRetry('p', issue.number)).toBeNull();
  },
);

describe('issues of several repositories', () => {
  const site = {
    id: 'site',
    kind: 'forgejo' as const,
    owner: 'acme',
    repo: 'site',
    isDefault: false,
  };
  const main = { ...site, id: 'default:p', kind: 'github' as const, repo: 'app', isDefault: true };

  // Issue #42 exists in both repositories; a shared record would offer the
  // default repository's pending retry on the other repository's issue.
  it('keeps pending retries apart per repository', async () => {
    mockClient.sendTurn.mockRejectedValueOnce(new Error('Network lost'));
    await expect(dispatchTaskIssue('p', issue, undefined, site)).rejects.toThrow('Network lost');
    expect(await taskIssueRetry('p', issue.number, site)).toEqual({});
    expect(await taskIssueRetry('p', issue.number)).toBeNull();
    expect(await taskIssueRetry('p', issue.number, main)).toBeNull();
  });

  // A retry recorded before projects had several repositories must still be
  // found once the list passes the default repository along.
  it('finds a default-repository retry recorded without a repository', async () => {
    mockClient.sendTurn.mockRejectedValueOnce(new Error('Network lost'));
    await expect(dispatchTaskIssue('p', issue)).rejects.toThrow('Network lost');
    expect(await taskIssueRetry('p', issue.number, main)).toEqual({});
  });

  it('remembers the session a sent issue turn went to, per repository', async () => {
    mockClient.sendTurn.mockRejectedValueOnce(new Error('Network lost'));
    await expect(dispatchTaskIssue('p', issue, undefined, site)).rejects.toThrow('Network lost');
    // Not yet: the turn was not accepted.
    expect(await taskIssueSessions('p', issue.number, site)).toEqual([]);
    mockClient.listSessions.mockResolvedValue([
      { sessionId: 'uuid-1', projectId: 'p', resumable: true },
      { sessionId: 's', projectId: 'p', resumable: true },
    ]);
    await dispatchTaskIssue('p', issue, undefined, site);
    // Handed to an existing session too, as "This session" does.
    await dispatchTaskIssue('p', issue, 's', site);
    expect((await taskIssueSessions('p', issue.number, site)).sort()).toEqual(['s', 'uuid-1']);
    expect(await taskIssueSessions('p', issue.number, main)).toEqual([]);
  });

  it('names the repository and leaves the branch unnumbered for another repository', async () => {
    await dispatchTaskIssue('p', issue, undefined, site);
    expect(createSessionConfirmingWarnings).toHaveBeenCalledWith(
      mockClient,
      expect.not.objectContaining({ issue: expect.anything() }),
    );
    expect(mockClient.sendTurn).toHaveBeenCalledWith(
      'uuid-1',
      expect.objectContaining({
        prompt: expect.stringMatching(/^Work on Forgejo issue acme\/site#42: Fix keyboard/),
      }),
    );
  });
});
