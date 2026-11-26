import {
  publishProjectStatusMutation,
  type LiveTopicSink,
  type ProjectDetail,
  type ProjectRecord,
  type SessionSummary,
  type VerityClient,
} from '@verity/mobile';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useProjectDetail } from './useProjectDetail';

const mockSinks = new Map<string, LiveTopicSink>();
jest.mock('./liveConnection', () => ({
  subscribeLiveRefresh: () => () => undefined,
  liveConnectionFor: () => ({
    subscribeTopic: (topic: string, sink: LiveTopicSink) => {
      mockSinks.set(topic, sink);
      return () => mockSinks.delete(topic);
    },
  }),
}));
jest.mock('./client', () => ({ getVerityBaseUrl: () => 'https://core.example' }));
// The page is not on screen: no focus reload may hide the race under test.
jest.mock('expo-router', () => ({ useFocusEffect: () => undefined }));

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

const waiting: SessionSummary = {
  sessionId: 's1',
  projectId: 'p1',
  worktree: '/wt/s1',
  model: 'm',
  name: null,
  status: 'awaiting_input',
  usage,
  pendingPermissions: ['tool-1'],
  pendingPermissionRequests: [
    { toolUseId: 'tool-1', tool: 'Bash', riskClass: 'ask', detached: true },
  ],
};

function detailWith(sessions: SessionSummary[]): ProjectDetail {
  return {
    project: { id: 'p1', name: 'P1' },
    settings: null,
    sessions,
  } as unknown as ProjectDetail;
}

beforeEach(() => mockSinks.clear());

describe('useProjectDetail overview events', () => {
  it('keeps an answered card gone when the read in flight still lists it', async () => {
    // The read started before another device answered; it must not bring the
    // card back, even though this page is not focused and reads no more.
    let release: (detail: ProjectDetail) => void = () => undefined;
    const client = {
      getProject: jest.fn(() => new Promise<ProjectDetail>((resolve) => (release = resolve))),
      setProjectSetupStatus: jest.fn(),
    } as unknown as VerityClient;
    const { result } = renderHook(() => useProjectDetail(client, 'p1'));
    const sink = mockSinks.get('project:p1')!;
    act(() =>
      sink.event({
        t: 'permission.decided',
        sessionId: 's1',
        toolUseId: 'tool-1',
        rev: 2,
        outcome: 'allowed',
      }),
    );
    await act(async () => release(detailWith([waiting])));
    await waitFor(() => expect(result.current.detail).toBeDefined());
    expect(result.current.detail?.sessions[0]?.pendingPermissionRequests).toEqual([]);
  });

  it('shows a sandbox change of this project and ignores other projects', async () => {
    const client = {
      getProject: jest.fn().mockResolvedValue({
        ...detailWith([]),
        project: { id: 'p1', name: 'P1', state: 'container_starting' },
      }),
      setProjectSetupStatus: jest.fn(),
    } as unknown as VerityClient;
    const { result } = renderHook(() => useProjectDetail(client, 'p1'));
    await waitFor(() => expect(result.current.detail).toBeDefined());
    const sink = mockSinks.get('project:p1')!;
    act(() => sink.event({ t: 'sandbox.lifecycle', projectId: 'p2', rev: 1, state: 'failed' }));
    expect(result.current.detail?.project.state).toBe('container_starting');
    act(() =>
      sink.event({
        t: 'sandbox.lifecycle',
        projectId: 'p1',
        rev: 2,
        state: 'active',
        lifecycleState: 'sleeping',
      }),
    );
    expect(result.current.detail?.project).toMatchObject({
      state: 'active',
      lifecycleState: 'sleeping',
    });
  });

  // Settings routes stack on the project screen and each mounts the hook; a
  // rename on one must show on the others without a read of their own.
  it('shows a change made on one screen on every screen of the project', async () => {
    const client = {
      getProject: jest.fn().mockResolvedValue({
        ...detailWith([]),
        project: { id: 'p3', name: 'Before' },
      }),
      setProjectSetupStatus: jest.fn(),
    } as unknown as VerityClient;
    const page = renderHook(() => useProjectDetail(client, 'p3'));
    const settings = renderHook(() => useProjectDetail(client, 'p3'));
    await waitFor(() => expect(settings.result.current.detail).toBeDefined());
    await waitFor(() => expect(page.result.current.detail).toBeDefined());
    act(() => settings.result.current.onProfileSaved({ name: 'After' }));
    expect(page.result.current.detail?.project.name).toBe('After');
  });

  it('keeps a project another screen saved while this read was on its way', async () => {
    let release: (detail: ProjectDetail) => void = () => undefined;
    const client = {
      getProject: jest.fn(() => new Promise<ProjectDetail>((resolve) => (release = resolve))),
      setProjectSetupStatus: jest.fn(),
    } as unknown as VerityClient;
    const { result } = renderHook(() => useProjectDetail(client, 'p4'));
    act(() =>
      publishProjectStatusMutation({ id: 'p4', name: 'P4', state: 'active' } as ProjectRecord),
    );
    await act(async () =>
      release({
        ...detailWith([]),
        project: { id: 'p4', name: 'P4', state: 'cloning' },
      } as ProjectDetail),
    );
    await waitFor(() => expect(result.current.detail).toBeDefined());
    expect(result.current.detail?.project.state).toBe('active');
  });

  it('shows a pull request status from an event without reading', async () => {
    const getProject = jest.fn().mockResolvedValue({
      ...detailWith([{ ...waiting, sessionId: 's5', projectId: 'p5' }]),
      project: { id: 'p5', name: 'P5' },
    });
    const client = { getProject, setProjectSetupStatus: jest.fn() } as unknown as VerityClient;
    const { result } = renderHook(() => useProjectDetail(client, 'p5'));
    await waitFor(() => expect(result.current.detail?.sessions).toHaveLength(1));
    act(() =>
      mockSinks.get('project:p5')!.event({
        t: 'pr.status',
        sessionId: 's5',
        rev: 1,
        pr: {
          number: 7,
          title: 'Add live status',
          url: 'https://example.test/pr/7',
          phase: 'merged',
          pipeline: 'success',
          mergeable: null,
          checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
        },
      }),
    );
    expect(result.current.detail?.sessions[0]?.pr).toMatchObject({ phase: 'merged' });
    expect(getProject).toHaveBeenCalledTimes(1);
  });

  // Past the replay bound the store refuses the read; the page must still
  // list what the server sent rather than show an empty project.
  it("shows the read's sessions when the store could not take it", async () => {
    let release: (detail: ProjectDetail) => void = () => undefined;
    const client = {
      getProject: jest.fn(() => new Promise<ProjectDetail>((resolve) => (release = resolve))),
      setProjectSetupStatus: jest.fn(),
    } as unknown as VerityClient;
    const { result } = renderHook(() => useProjectDetail(client, 'p6'));
    const sink = mockSinks.get('project:p6')!;
    act(() => {
      for (let i = 0; i < 257; i += 1)
        sink.event({ t: 'choices.answered', sessionId: `other-${i}`, rev: 1 });
    });
    await act(async () =>
      release({
        ...detailWith([{ ...waiting, sessionId: 's6', projectId: 'p6' }]),
        project: { id: 'p6', name: 'P6' },
      } as ProjectDetail),
    );
    await waitFor(() => expect(result.current.detail).toBeDefined());
    expect(result.current.detail?.sessions.map((s) => s.sessionId)).toEqual(['s6']);
  });
});
