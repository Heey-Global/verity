import { renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import {
  SessionListModel,
  type LiveConnection,
  type ProjectRecord,
  type SessionListState,
  type VerityClient,
} from '@verity/mobile';
import { useProjectDetail } from '../lib/useProjectDetail';
import { useBranches } from './useBranches';
import { useProjects } from './useProjects';
import { useSessionList } from './useSessionList';

type Coverage = (path: string, connection: LiveConnection) => boolean;
const mockRefreshes: { filter: (path: string) => boolean; covered?: Coverage }[] = [];
const mockRecheck = jest.fn();
jest.mock('../lib/client', () => ({ getVerityBaseUrl: () => 'https://core.example' }));
jest.mock('../lib/liveConnection', () => ({
  useLiveHints: () => undefined,
  subscribeLiveRefresh: (
    _client: unknown,
    _refresh: unknown,
    filter: (path: string) => boolean,
    _resources: unknown,
    options: { covered?: Coverage; coverageChanged?: (recheck: () => void) => () => void } = {},
  ) => {
    const unregister = options.coverageChanged?.(mockRecheck);
    const entry = { filter, ...(options.covered ? { covered: options.covered } : {}) };
    mockRefreshes.push(entry);
    return () => {
      unregister?.();
      mockRefreshes.splice(mockRefreshes.indexOf(entry), 1);
    };
  },
  liveConnectionFor: () => ({
    connectionState: 'connected',
    resourceWatching: true,
    subscribeTopic: () => () => undefined,
    followsTopic: () => false,
  }),
}));
jest.mock('../lib/sessionSwitchTiming', () => ({ beginClientActivity: () => () => undefined }));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) =>
    require('react').useEffect(() => callback(), [callback]),
}));

/** A connection whose topics support and follow exactly what a test names. */
function connection(followed: string[], topicsSupported = true): LiveConnection {
  const set = new Set(followed);
  return { topicsSupported, followsTopic: (topic: string) => set.has(topic) } as LiveConnection;
}

/** The coverage the view registered for reads of `path`. */
function coverageOf(path: string): Coverage {
  const entry = mockRefreshes.find(({ filter }) => filter(path));
  expect(entry?.covered).toBeDefined();
  return entry!.covered!;
}

const project = (id: string): ProjectRecord =>
  ({
    id,
    name: id,
    owner: 'o',
    repo: id,
    containerName: id,
    kind: 'github',
    imageRef: null,
    state: 'active',
    provisionError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) satisfies ProjectRecord;

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockRefreshes.length = 0;
  mockRecheck.mockClear();
});
afterEach(() => jest.restoreAllMocks());

// Each view stops its resource watch, and with it the server's sampling of
// the route, only while its topics deliver everything the route shows (ADR
// 0033). Claiming coverage too early leaves a view without updates; never
// claiming it keeps the polling this exists to end.
describe('live coverage of the overview views', () => {
  it('the branch list is covered by its session topic', async () => {
    const client = {
      getBranches: jest.fn().mockResolvedValue({ current: 'main', switchable: [] }),
    };
    const { unmount } = renderHook(() => useBranches(client as unknown as VerityClient, 's1'));
    await waitFor(() => expect(mockRefreshes.length).toBeGreaterThan(0));
    const covered = coverageOf('/sessions/s1/branches');
    expect(covered('/sessions/s1/branches', connection(['session:s1']))).toBe(true);
    expect(covered('/sessions/s1/branches', connection(['session:s2']))).toBe(false);
    unmount();
  });

  it('the project page is covered by its project topic', () => {
    const client = { getProject: jest.fn(() => new Promise(() => undefined)) };
    const { unmount } = renderHook(() => useProjectDetail(client as unknown as VerityClient, 'p1'));
    const covered = coverageOf('/projects/p1');
    expect(covered('/projects/p1', connection(['project:p1']))).toBe(true);
    expect(covered('/projects/p1', connection([]))).toBe(false);
    unmount();
  });

  it('the project list is covered only while it and every listed project are followed', async () => {
    const client = { listProjects: jest.fn().mockResolvedValue([project('p1'), project('p2')]) };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    const covered = coverageOf('/projects');
    const all = ['collection:projects', 'project:p1', 'project:p2'];
    expect(covered('/projects', connection(all))).toBe(true);
    // A project past the topic limit: the list keeps watching for it.
    expect(covered('/projects', connection(all.slice(0, 2)))).toBe(false);
    expect(covered('/projects', connection(all.slice(1)))).toBe(false);
    // Listed projects change coverage before their topics are subscribed.
    expect(mockRecheck).toHaveBeenCalled();
    unmount();
  });

  it('the session list is covered only while every listed session has a followed project', () => {
    jest.spyOn(SessionListModel.prototype, 'start').mockImplementation(() => {});
    jest.spyOn(SessionListModel.prototype, 'stop').mockImplementation(() => {});
    let sessions: { sessionId: string; projectId: string | null }[] = [
      { sessionId: 's1', projectId: 'p1' },
    ];
    jest
      .spyOn(SessionListModel.prototype, 'state', 'get')
      .mockImplementation(() => ({ sessions }) as unknown as SessionListState);
    const client = {} as VerityClient;
    const { unmount } = renderHook(() => useSessionList(client));
    const covered = coverageOf('/sessions');
    expect(covered('/sessions', connection(['project:p1']))).toBe(true);
    expect(covered('/sessions', connection([]))).toBe(false);
    // An older server: no topics, the list keeps watching.
    expect(covered('/sessions', connection(['project:p1'], false))).toBe(false);
    // Provider limits are no overview event.
    expect(covered('/provider-limits', connection(['project:p1']))).toBe(false);
    // A session without a project announces its pull request only on its
    // own topic, which the list does not follow.
    sessions = [...sessions, { sessionId: 's2', projectId: null }];
    expect(covered('/sessions', connection(['project:p1']))).toBe(false);
    // Nothing listed: sessions that appear arrive as hints.
    sessions = [];
    expect(covered('/sessions', connection([]))).toBe(true);
    // A listed session without a project changes no topic: the list asks.
    expect(mockRecheck).toHaveBeenCalled();
    unmount();
  });
});
