import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ProjectRecord, SessionSummary, VerityClient } from '@verity/mobile';
import {
  contextOverviewClient,
  readContextProjects,
  refreshTaskContext,
  startTaskContext,
  useTaskContext,
} from './sharedTaskContext';

let mockScope: string | null = null;
const mockListeners = new Set<() => void>();
const mockLoad = jest.fn();
const mockSave = jest.fn();
let mockClient: VerityClient | null;
jest.mock('./tasksStore', () => ({
  taskAccountScope: () => mockScope,
  loadTaskContextData: () => mockLoad(),
  saveTaskContextData: (...args: unknown[]) => mockSave(...args),
}));
jest.mock('./client', () => ({
  createVerityClient: () => mockClient,
  getVerityBaseUrl: () => 'https://current.test',
  subscribeVerityBaseUrl: (fn: () => void) => {
    mockListeners.add(fn);
    return () => mockListeners.delete(fn);
  },
}));
jest.mock('./authToken', () => ({
  subscribeAuthToken: (fn: () => void) => {
    mockListeners.add(fn);
    return () => mockListeners.delete(fn);
  },
}));
jest.mock('./browserSession', () => ({ subscribeBrowserSession: () => () => undefined }));

const projects = [{ id: 'p', name: 'Project' }] as unknown as ProjectRecord[];
const sessions = [{ sessionId: 's', name: 'Session', projectId: 'p' }] as SessionSummary[];
const overview = { sessions, attention: [], sessionReordering: false };
let sequence = 0;
beforeEach(() => {
  mockScope = `server/account-${++sequence}`;
  mockLoad.mockReset().mockResolvedValue(null);
  mockSave.mockReset().mockResolvedValue(undefined);
  mockClient = {
    listProjects: jest.fn().mockResolvedValue(projects),
    listSessionOverview: jest.fn().mockResolvedValue(overview),
  } as unknown as VerityClient;
});

it('shares pending overview reads with capture and skips unchanged persistence and publication', async () => {
  const stop = startTaskContext();
  const { result, unmount } = renderHook(useTaskContext);
  const client = mockClient!;
  const modelClient = contextOverviewClient(client);
  await act(async () => {
    await Promise.all([
      readContextProjects(client),
      modelClient.listSessionOverview(),
      refreshTaskContext(),
    ]);
  });
  expect(client.listProjects).toHaveBeenCalledTimes(1);
  expect(client.listSessionOverview).toHaveBeenCalledTimes(1);
  expect(result.current).toEqual({ projects, sessions, projectsReady: true });
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  const previous = result.current;
  (client.listProjects as jest.Mock).mockResolvedValue(structuredClone(projects));
  (client.listSessionOverview as jest.Mock).mockResolvedValue(structuredClone(overview));
  await act(async () => {
    await refreshTaskContext();
  });
  expect(result.current).toBe(previous);
  expect(mockSave).toHaveBeenCalledTimes(1);
  // An explicit refresh still reads fresh data even immediately after a prior read.
  expect(client.listProjects).toHaveBeenCalledTimes(2);
  (client.listSessionOverview as jest.Mock).mockResolvedValue({
    ...overview,
    sessions: [{ ...sessions[0], name: 'Renamed' }],
  });
  await act(async () => {
    await refreshTaskContext();
  });
  expect(result.current.sessions[0]?.name).toBe('Renamed');
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
  unmount();
  stop();
});

it('restores offline context without network polling and refreshes on explicit demand', async () => {
  mockLoad.mockResolvedValue({ projects, sessions });
  const stop = startTaskContext();
  const { result, unmount } = renderHook(useTaskContext);
  await waitFor(() => expect(result.current).toEqual({ projects, sessions, projectsReady: true }));
  expect(mockClient!.listProjects).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
  (mockClient!.listProjects as jest.Mock).mockRejectedValue(new Error('offline'));
  await act(async () => {
    await expect(refreshTaskContext()).rejects.toThrow('offline');
  });
  expect(result.current).toEqual({ projects, sessions, projectsReady: true });
  unmount();
  stop();
});

it('clears context on account/server changes and discards old read and storage completions', async () => {
  let resolveProjects!: (value: ProjectRecord[]) => void;
  let resolveCache!: (value: { projects: ProjectRecord[]; sessions: SessionSummary[] }) => void;
  mockLoad.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveCache = resolve;
    }),
  );
  (mockClient!.listProjects as jest.Mock).mockReturnValue(
    new Promise((resolve) => {
      resolveProjects = resolve;
    }),
  );
  const stop = startTaskContext();
  const { result, unmount } = renderHook(useTaskContext);
  let read!: Promise<void>;
  act(() => {
    read = refreshTaskContext();
  });
  act(() => {
    mockScope = 'other-server/other-account';
    for (const fn of mockListeners) fn();
  });
  await act(async () => {
    resolveProjects(projects);
    resolveCache({ projects, sessions });
    await read;
  });
  expect(result.current).toEqual({ projects: [], sessions: [], projectsReady: false });
  expect(mockSave).not.toHaveBeenCalled();
  unmount();
  stop();
});

it('never replaces successful network data with a late offline cache', async () => {
  let resolveCache!: (value: { projects: ProjectRecord[]; sessions: SessionSummary[] }) => void;
  mockLoad.mockReturnValue(
    new Promise((resolve) => {
      resolveCache = resolve;
    }),
  );
  const stop = startTaskContext();
  const { result, unmount } = renderHook(useTaskContext);
  await act(async () => {
    await refreshTaskContext();
  });
  await act(async () => {
    resolveCache({ projects: [], sessions: [] });
  });
  expect(result.current).toEqual({ projects, sessions, projectsReady: true });
  unmount();
  stop();
});

it('lets an overview refresh supersede reads that began before a mutation', async () => {
  const stop = startTaskContext();
  const { result, unmount } = renderHook(useTaskContext);
  const client = mockClient!;
  let resolveOldProjects!: (value: ProjectRecord[]) => void;
  let resolveOldSessions!: (value: typeof overview) => void;
  (client.listProjects as jest.Mock).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOldProjects = resolve;
    }),
  );
  (client.listSessionOverview as jest.Mock).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOldSessions = resolve;
    }),
  );
  let oldRead!: Promise<void>;
  act(() => {
    oldRead = refreshTaskContext();
  });
  await act(async () => {
    await Promise.all([
      readContextProjects(client, true),
      contextOverviewClient(client).listSessionOverview(),
    ]);
  });
  expect(client.listProjects).toHaveBeenCalledTimes(2);
  expect(client.listSessionOverview).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolveOldProjects([]);
    resolveOldSessions({ ...overview, sessions: [] });
    await oldRead;
  });
  expect(result.current).toEqual({ projects, sessions, projectsReady: true });
  unmount();
  stop();
});

it('does not publish reads from an old server client after the account has switched', async () => {
  const stop = startTaskContext();
  const { result, unmount } = renderHook(useTaskContext);
  const oldClient = {
    liveBaseUrl: () => 'https://old.test',
    listProjects: jest.fn().mockResolvedValue(projects),
    listSessionOverview: jest.fn().mockResolvedValue(overview),
  } as unknown as VerityClient;
  await act(async () => {
    await readContextProjects(oldClient, true);
    await contextOverviewClient(oldClient).listSessionOverview();
  });
  expect(result.current).toEqual({ projects: [], sessions: [], projectsReady: false });
  expect(mockSave).not.toHaveBeenCalled();
  unmount();
  stop();
});

// An unloaded empty list must not erase the Watch picker retained for offline use.
it('distinguishes pending projects from a successfully loaded empty list', async () => {
  const stop = startTaskContext();
  const { result, unmount } = renderHook(useTaskContext);
  expect(result.current.projectsReady).toBe(false);
  (mockClient!.listProjects as jest.Mock).mockResolvedValue([]);
  await act(async () => {
    await readContextProjects(mockClient!);
  });
  expect(result.current.projects).toEqual([]);
  expect(result.current.projectsReady).toBe(true);
  unmount();
  stop();
});
