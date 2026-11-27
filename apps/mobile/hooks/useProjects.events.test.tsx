import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { LiveTopicSink, ProjectRecord, SessionSummary, VerityClient } from '@verity/mobile';
import { useOverviewStore } from '../lib/overviewTopics';
import { useProjectDetail } from '../lib/useProjectDetail';
import { useProjects } from './useProjects';

let mockFocused = true;
const mockSinks = new Map<string, LiveTopicSink>();
jest.mock('../lib/client', () => ({ getVerityBaseUrl: () => 'https://core.example' }));
jest.mock('../lib/liveConnection', () => ({
  subscribeLiveRefresh: () => () => undefined,
  liveConnectionFor: () => ({
    connectionState: 'connected',
    resourceWatching: true,
    subscribeTopic: (topic: string, sink: LiveTopicSink) => {
      mockSinks.set(topic, sink);
      return () => mockSinks.delete(topic);
    },
  }),
}));
jest.mock('../lib/sessionSwitchTiming', () => ({ beginClientActivity: () => () => undefined }));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    require('react').useEffect(
      () => (mockFocused ? callback() : undefined),
      [callback, mockFocused],
    ),
}));

const starting = {
  id: 'p1',
  name: 'P1',
  owner: 'o',
  repo: 'r',
  containerName: 'c',
  kind: 'github',
  imageRef: null,
  state: 'container_starting',
  provisionError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies ProjectRecord;

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockFocused = true;
  mockSinks.clear();
});

afterEach(() => jest.restoreAllMocks());

describe('useProjects project events', () => {
  it('shows a started sandbox at once and reads the fields the event does not carry', async () => {
    let release: (projects: ProjectRecord[]) => void = () => undefined;
    const client = {
      listProjects: jest
        .fn()
        .mockResolvedValueOnce([starting])
        .mockImplementation(() => new Promise<ProjectRecord[]>((resolve) => (release = resolve))),
    };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    const reads = client.listProjects.mock.calls.length;
    act(() =>
      mockSinks.get('project:p1')!.event({
        t: 'sandbox.lifecycle',
        projectId: 'p1',
        rev: 1,
        state: 'active',
      }),
    );
    // Shown before any read answers.
    expect(result.current.projects[0]!.state).toBe('active');
    expect(client.listProjects.mock.calls.length).toBe(reads + 1);
    await act(async () => release([{ ...starting, state: 'active', provisionWarning: 'w' }]));
    expect(result.current.projects[0]!.provisionWarning).toBe('w');
    unmount();
  });

  it('keeps a change for a hidden list and reads when the list is shown again', async () => {
    const client = { listProjects: jest.fn().mockResolvedValue([starting]) };
    const { result, rerender, unmount } = renderHook(() =>
      useProjects(client as unknown as VerityClient),
    );
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    mockFocused = false;
    rerender({});
    const reads = client.listProjects.mock.calls.length;
    act(() =>
      mockSinks.get('project:p1')!.event({
        t: 'project.changed',
        projectId: 'p1',
        rev: 1,
        patch: { name: 'Renamed' },
      }),
    );
    act(() =>
      mockSinks.get('project:p1')!.event({
        t: 'sandbox.update',
        projectId: 'p1',
        rev: 2,
        available: true,
      }),
    );
    expect(result.current.projects[0]!.name).toBe('Renamed');
    // Hidden: nothing is read until the list is shown.
    expect(client.listProjects.mock.calls.length).toBe(reads);
    mockFocused = true;
    rerender({});
    await waitFor(() => expect(client.listProjects.mock.calls.length).toBeGreaterThan(reads));
    unmount();
  });

  // Home and the project page share one store (ADR 0033): an action taken on
  // the project page shows on Home without a read, and Home keeps the fold
  // state its own read gave, which the action's answer does not speak for.
  it("shows the project page's action at once and keeps the fold state", async () => {
    const folded = { ...starting, state: 'active', collapsed: true } satisfies ProjectRecord;
    const client = {
      listProjects: jest.fn().mockResolvedValue([folded]),
      getProject: jest.fn().mockResolvedValue({ project: folded, settings: null, sessions: [] }),
      setProjectSetupStatus: jest.fn(),
    } as unknown as VerityClient;
    const home = renderHook(() => useProjects(client));
    await waitFor(() => expect(home.result.current.projects).toHaveLength(1));
    const page = renderHook(() => useProjectDetail(client, 'p1'));
    await waitFor(() => expect(page.result.current.detail).toBeDefined());
    const reads = (client.listProjects as jest.Mock).mock.calls.length;
    act(() =>
      page.result.current.onProjectUpdated({ ...starting, state: 'absent', collapsed: false }),
    );
    expect(home.result.current.projects[0]).toMatchObject({ state: 'absent', collapsed: true });
    expect((client.listProjects as jest.Mock).mock.calls.length).toBe(reads);
    page.unmount();
    home.unmount();
  });

  it('lists a project an action on its page made visible', async () => {
    const paused = { ...starting, id: 'p9', state: 'absent' } satisfies ProjectRecord;
    const client = {
      listProjects: jest.fn().mockResolvedValue([starting]),
      getProject: jest.fn().mockResolvedValue({ project: paused, settings: null, sessions: [] }),
      setProjectSetupStatus: jest.fn(),
    } as unknown as VerityClient;
    const home = renderHook(() => useProjects(client));
    await waitFor(() => expect(home.result.current.projects).toHaveLength(1));
    const page = renderHook(() => useProjectDetail(client, 'p9'));
    await waitFor(() => expect(page.result.current.detail).toBeDefined());
    // Not on the overview while absent.
    expect(home.result.current.projects.map((project) => project.id)).toEqual(['p1']);
    act(() => page.result.current.onProjectUpdated({ ...paused, state: 'container_starting' }));
    expect(home.result.current.projects.map((project) => project.id)).toEqual(['p1', 'p9']);
    page.unmount();
    home.unmount();
  });

  it('keeps the order of its read and the same list when nothing changed', async () => {
    const second = { ...starting, id: 'p2', name: 'P2' } satisfies ProjectRecord;
    const client = { listProjects: jest.fn().mockResolvedValue([second, starting]) };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    const before = result.current.projects;
    expect(before.map((project) => project.id)).toEqual(['p2', 'p1']);
    // A session read changes the store but no project: no new list, so the
    // project cards do not render again for every session change.
    const store = renderHook(() => useOverviewStore('https://core.example'));
    act(() => {
      store.result.current.applySessions(
        store.result.current.beginRead(),
        [{ sessionId: 's', projectId: 'p1' } as SessionSummary],
        { covers: (session) => session.projectId === 'p1' },
      );
    });
    expect(store.result.current.session('s')).toBeDefined();
    expect(result.current.projects).toBe(before);
    store.unmount();
    unmount();
  });

  // Past the replay bound the store refuses the read; Home must still list
  // what the server sent, and read once more.
  it('lists its own read when the store could not take it', async () => {
    let release: (projects: ProjectRecord[]) => void = () => undefined;
    const client = {
      listProjects: jest
        .fn()
        .mockResolvedValueOnce([starting])
        .mockImplementationOnce(
          () => new Promise<ProjectRecord[]>((resolve) => (release = resolve)),
        )
        .mockImplementation(() => new Promise<ProjectRecord[]>(() => undefined)),
    };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await waitFor(() => expect(mockSinks.has('project:p1')).toBe(true));
    act(() =>
      mockSinks.get('project:p1')!.event({
        t: 'project.changed',
        projectId: 'p1',
        rev: 1,
        patch: { name: 'Read again' },
      }),
    );
    const sink = mockSinks.get('project:p1')!;
    act(() => {
      for (let i = 0; i < 257; i += 1)
        sink.event({ t: 'choices.answered', sessionId: `other-${i}`, rev: i + 2 });
    });
    const reads = client.listProjects.mock.calls.length;
    await act(async () => release([{ ...starting, name: 'From the read' }]));
    expect(result.current.projects[0]!.name).toBe('From the read');
    await waitFor(() => expect(client.listProjects.mock.calls.length).toBe(reads + 1));
    unmount();
  });
});

describe('useProjects project collection', () => {
  // A project created or removed on another device used to show only at the
  // next full list read; now only that project is read, or none at all.
  it('lists a project another device added and drops one it removed, reading only that project', async () => {
    const active = { ...starting, state: 'active' as const };
    const added = { ...active, id: 'p2', name: 'P2' };
    const client = {
      listProjects: jest.fn().mockResolvedValue([active]),
      getProject: jest.fn().mockResolvedValue({ project: added, settings: null, sessions: [] }),
    };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    await waitFor(() => expect(mockSinks.has('collection:projects')).toBe(true));
    const reads = client.listProjects.mock.calls.length;
    const collection = mockSinks.get('collection:projects')!;

    // Already listed: nothing to read.
    act(() => collection.event({ t: 'project.listed', projectId: 'p1', rev: 1 }));
    expect(client.getProject).not.toHaveBeenCalled();

    await act(async () => collection.event({ t: 'project.listed', projectId: 'p2', rev: 2 }));
    await waitFor(() =>
      expect(result.current.projects.map((project) => project.id).sort()).toEqual(['p1', 'p2']),
    );
    expect(client.getProject).toHaveBeenCalledWith('p2');

    act(() => collection.event({ t: 'project.unlisted', projectId: 'p1', rev: 3 }));
    await waitFor(() =>
      expect(result.current.projects.map((project) => project.id)).toEqual(['p2']),
    );
    expect(client.listProjects.mock.calls.length).toBe(reads);
    unmount();
  });

  // A listing still reading must not bring back a project unlisted meanwhile.
  it('keeps a project off the list that was unlisted while its read was out', async () => {
    const active = { ...starting, state: 'active' as const };
    let answer!: (detail: object) => void;
    const client = {
      listProjects: jest.fn().mockResolvedValue([active]),
      getProject: jest.fn(() => new Promise((resolve) => (answer = resolve))),
    };
    const { result, unmount } = renderHook(() => useProjects(client as unknown as VerityClient));
    await waitFor(() => expect(mockSinks.has('collection:projects')).toBe(true));
    const collection = mockSinks.get('collection:projects')!;
    act(() => collection.event({ t: 'project.listed', projectId: 'p2', rev: 1 }));
    await waitFor(() => expect(client.getProject).toHaveBeenCalled());
    act(() => collection.event({ t: 'project.unlisted', projectId: 'p2', rev: 2 }));
    await act(async () =>
      answer({ project: { ...active, id: 'p2' }, settings: null, sessions: [] }),
    );
    expect(result.current.projects.map((project) => project.id)).toEqual(['p1']);
    unmount();
  });
});
