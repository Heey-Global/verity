import type { LiveTopicSink, ProjectDetail, SessionSummary, VerityClient } from '@verity/mobile';
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
});
