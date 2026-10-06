import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Task, TurnRequest } from '@verity/mobile';
import { dispatchTasks } from './taskDispatch';
import { createSessionConfirmingWarnings } from './startSession';
import { getAuthTokenId } from './authToken';

const task: Task = {
  id: 'task-1',
  title: 'Implement outcome',
  detail: 'Context',
  projectId: 'p',
  sessionId: null,
  sourceSessionId: null,
  origin: 'user',
  attachments: [],
  status: 'open',
  result: null,
  sort: 0,
  revision: 2,
  createdAt: '',
  updatedAt: '',
  completedAt: null,
};
let remote: Task[];
const mockClient = {
  listTasks: jest.fn(async () => remote),
  updateTask: jest.fn(
    async (id: string, patch: { sessionId: string; expectedRevision: number }) => {
      remote = remote.map((item) =>
        item.id === id
          ? { ...item, ...patch, status: 'in_progress', revision: patch.expectedRevision + 1 }
          : item,
      );
      return remote.find((item) => item.id === id);
    },
  ),
  sendTurn: jest.fn(async (_id: string, _body: TurnRequest) => ({ accepted: true })),
  readTaskAttachment: jest.fn(),
};
jest.mock('./client', () => ({
  getVerityBaseUrl: () => 'https://example.test',
  createVerityClient: () => mockClient,
}));
jest.mock('./authToken', () => ({
  getAuthToken: () => 'secret',
  getAuthTokenId: jest.fn(() => 'credential-1'),
}));
jest.mock('./browserSession', () => ({ getBrowserSession: () => null }));
jest.mock('./startSession', () => ({
  createSessionConfirmingWarnings: jest.fn(async () => ({ existing: false })),
}));
jest.mock('./tasksStore', () => ({ refreshTasks: jest.fn(async () => undefined) }));
let mockUUIDCounter = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUUIDCounter}` }));
beforeEach(async () => {
  mockUUIDCounter = 0;
  await AsyncStorage.clear();
  jest.clearAllMocks();
  remote = [{ ...task }];
  jest.mocked(getAuthTokenId).mockReturnValue('credential-1');
});
it('assigns the task before the first turn and includes task context', async () => {
  const id = await dispatchTasks([task]);
  expect(createSessionConfirmingWarnings).toHaveBeenCalledWith(mockClient, {
    sessionId: id,
    projectId: 'p',
  });
  expect(mockClient.updateTask.mock.invocationCallOrder[0]).toBeLessThan(
    mockClient.sendTurn.mock.invocationCallOrder[0]!,
  );
  expect(mockClient.sendTurn).toHaveBeenCalledWith(
    id,
    expect.objectContaining({
      prompt: 'Work on task #task-1: Implement outcome\nContext',
      clientReplyId: expect.any(String),
    }),
  );
});
it('reuses the session and turn keys after a lost turn response', async () => {
  mockClient.sendTurn.mockRejectedValueOnce(new Error('response lost'));
  await expect(dispatchTasks([task])).rejects.toThrow('response lost');
  const first = mockClient.sendTurn.mock.calls[0];
  await dispatchTasks(remote);
  expect(mockClient.sendTurn.mock.calls[1]).toEqual(first);
  expect(mockClient.updateTask).toHaveBeenCalledTimes(1);
});
it('does not dispatch after credential identity changes during creation', async () => {
  jest.mocked(createSessionConfirmingWarnings).mockImplementationOnce(async () => {
    jest.mocked(getAuthTokenId).mockReturnValue('credential-2');
    return { existing: false };
  });
  await expect(dispatchTasks([task])).rejects.toThrow('connection changed');
  expect(mockClient.sendTurn).not.toHaveBeenCalled();
  expect(mockClient.updateTask).not.toHaveBeenCalled();
});
it('refuses General or mixed-project selections', async () => {
  await expect(dispatchTasks([{ ...task, projectId: null }])).rejects.toThrow('one project');
  await expect(
    dispatchTasks([task, { ...task, id: 'task-2', projectId: 'other' }]),
  ).rejects.toThrow('one project');
  expect(createSessionConfirmingWarnings).not.toHaveBeenCalled();
});

it('starts a fresh attempt after a completed task is reopened', async () => {
  await dispatchTasks([task]);
  remote = [{ ...task, revision: 5, status: 'open' }];
  await dispatchTasks(remote);
  expect(mockClient.updateTask).toHaveBeenCalledTimes(2);
  expect(mockClient.sendTurn.mock.calls[1]![1].clientReplyId).not.toBe(
    mockClient.sendTurn.mock.calls[0]![1].clientReplyId,
  );
});
it('allows a fresh attempt after refreshing a stale task snapshot', async () => {
  remote = [{ ...task, revision: 3, title: 'Updated outcome' }];
  await expect(dispatchTasks([task])).rejects.toThrow('Task changed');
  await dispatchTasks(remote);
  expect(mockClient.sendTurn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ prompt: 'Work on task #task-1: Updated outcome\nContext' }),
  );
});

it('rejects excessive attachment counts before creating or assigning a session', async () => {
  const attachments = Array.from({ length: 9 }, (_, i) => ({
    hash: `hash-${i}`,
    filename: 'context.txt',
    mimeType: 'text/plain',
  }));
  await expect(dispatchTasks([{ ...task, attachments }])).rejects.toThrow('eight attachments');
  expect(createSessionConfirmingWarnings).not.toHaveBeenCalled();
  expect(mockClient.updateTask).not.toHaveBeenCalled();
});
it('rejects oversized attachment bytes before creating or assigning a session', async () => {
  mockClient.readTaskAttachment.mockResolvedValueOnce(new ArrayBuffer(25_000_001));
  await expect(
    dispatchTasks([
      { ...task, attachments: [{ hash: 'hash', filename: 'large.txt', mimeType: 'text/plain' }] },
    ]),
  ).rejects.toThrow('size limit');
  expect(createSessionConfirmingWarnings).not.toHaveBeenCalled();
  expect(mockClient.updateTask).not.toHaveBeenCalled();
});

it('coalesces concurrent taps into one dispatch attempt', async () => {
  const [first, second] = await Promise.all([dispatchTasks([task]), dispatchTasks([task])]);
  expect(first).toBe(second);
  expect(mockClient.sendTurn).toHaveBeenCalledTimes(1);
  expect(createSessionConfirmingWarnings).toHaveBeenCalledTimes(1);
});
