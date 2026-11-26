import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { LiveTopicSink, ProjectRecord, VerityClient } from '@verity/mobile';
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
});
