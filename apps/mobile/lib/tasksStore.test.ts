import { act, renderHook, waitFor } from '@testing-library/react-native';
import { captureTask, startTasksStore, useTasks } from './tasksStore';
import Storage from 'expo-sqlite/kv-store';
import { subscribeLiveRefresh } from './liveConnection';
jest.mock('./liveConnection', () => ({ subscribeLiveRefresh: jest.fn(() => jest.fn()) }));

let mockCredential: string | null = 'first';
let mockUrl = 'https://first.test';
const mockListeners = new Set<() => void>();
const mockClient = {
  listTasks: jest.fn(async () => []),
  saveTask: jest.fn(async () => {
    throw new Error('offline');
  }),
  updateTask: jest.fn(),
  deleteTask: jest.fn(),
};
jest.mock('expo-sqlite/kv-store', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('./client', () => ({
  createVerityClient: () => mockClient,
  getVerityBaseUrl: () => mockUrl,
  subscribeVerityBaseUrl: (listener: () => void) => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
}));
jest.mock('./authToken', () => ({
  getAuthToken: () => (mockCredential ? 'bearer' : null),
  getAuthTokenId: () => mockCredential,
  subscribeAuthToken: (listener: () => void) => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
}));
jest.mock('./browserSession', () => ({
  getBrowserSession: () => null,
  subscribeBrowserSession: () => () => undefined,
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }));
it('hides the previous credential cache immediately and keeps its outbox isolated', async () => {
  await Storage.clear();
  const stop = startTasksStore();
  const { result } = renderHook(() => useTasks());
  await act(async () => {
    await captureTask({
      title: 'Private capture',
      detail: 'Full original description',
      generateTitle: true,
      projectId: 'p',
    });
  });
  expect(result.current.tasks[0]?.title).toBe('Private capture');
  expect(result.current.tasks[0]).toMatchObject({
    detail: 'Full original description',
    titleGenerationStatus: 'pending',
  });
  expect(subscribeLiveRefresh).toHaveBeenCalledWith(
    mockClient,
    expect.any(Function),
    expect.any(Function),
    [{ path: '/tasks' }],
  );
  const calls = mockClient.saveTask.mock.calls.length;
  act(() => {
    mockCredential = 'second';
    for (const listener of mockListeners) listener();
  });
  expect(result.current.tasks).toHaveLength(0);
  await waitFor(() => expect(result.current.pending).toHaveLength(0));
  expect(mockClient.saveTask).toHaveBeenCalledTimes(calls);
  act(() => {
    mockCredential = null;
    for (const listener of mockListeners) listener();
  });
  await expect(captureTask({ title: 'Locked', projectId: 'p' })).rejects.toThrow('Sign in');
  stop();
});
it('does not restore another server cache with the same credential identifier', async () => {
  mockCredential = 'first';
  mockUrl = 'https://first.test';
  await Storage.clear();
  const stop = startTasksStore();
  await act(async () => {
    await captureTask({ title: 'Private capture', projectId: 'p' });
  });
  const { result } = renderHook(() => useTasks());
  await waitFor(() => expect(result.current.tasks[0]?.title).toBe('Private capture'));
  act(() => {
    mockUrl = 'https://other.test';
    for (const listener of mockListeners) listener();
  });
  expect(result.current.tasks).toHaveLength(0);
  await waitFor(() => expect(result.current.pending).toHaveLength(0));
  stop();
});

it('rejects a projectless capture before it enters the offline outbox', async () => {
  mockCredential = 'first';
  const stop = startTasksStore();
  await expect(captureTask({ title: 'Projectless', projectId: null })).rejects.toThrow(
    'Choose a project',
  );
  stop();
});
