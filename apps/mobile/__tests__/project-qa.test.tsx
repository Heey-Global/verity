// A coding project's QA role in the app (docs/ci-supervision.md): the pinned
// row on the project page, the QA page with its issues, and the issue detail
// where the user answers when QA stopped.
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
// The QA screens read the project detail, which otherwise keeps a live subscription open.
jest.mock('../lib/liveConnection', () => ({ subscribeLiveRefresh: () => () => undefined }));
// The shared working pulse loops for the app's lifetime; a still value lets Jest exit.
jest.mock('../lib/pulse', () => {
  const { Animated } = require('react-native');
  const value = new Animated.Value(1);
  return { useSyncedPulse: () => value };
});

import type { ProjectQAState, ProjectQASummary, QAIssue, VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import ProjectQAIssueScreen from '../app/project/[id]/qa/[issue]';
import ProjectQAScreen from '../app/project/[id]/qa/index';
import { ProjectQARole } from '../components/project/ProjectQARole';
import { workFilter } from '../components/project/ProjectWork';
import {
  mockCreateVerityClient,
  mockPush,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

const summary = (patch: Partial<ProjectQASummary> = {}): ProjectQASummary => ({
  mode: 'automatic',
  health: 'healthy',
  checkedAt: new Date().toISOString(),
  open: 3,
  repairing: 1,
  needsYou: 1,
  failingPullRequests: 1,
  failingWorkflows: 0,
  stopped: [],
  ...patch,
});
const issue = (patch: Partial<QAIssue> = {}): QAIssue => ({
  id: 'issue-88',
  key: 'pr:88',
  state: 'needs_you',
  reason: 'rounds-exhausted',
  detail: 'sigstore v5 changed its signing API.',
  revision: '9c03e1fabc',
  failing: 'typecheck',
  incidents: 1,
  roundsUsed: 2,
  roundsAllowed: 2,
  repairing: false,
  sessionId: 'repair',
  sessionName: 'Fix Renovate typecheck',
  originSessionId: null,
  detectedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...patch,
});
const state = (issues: QAIssue[]): ProjectQAState => ({
  enabled: true,
  coding: true,
  mode: 'automatic',
  sessionId: 'qa-session',
  brakeAt: null,
  checkedAt: new Date().toISOString(),
  sources: { pullRequests: { readable: true, failing: 1 }, ci: { readable: true, failing: 0 } },
  issues,
  repairSessions: [{ session_id: 'repair', issue_id: 'issue-88' }],
});

describe('QA row', () => {
  it('shows state, the decision marker and the sources read, and opens QA', () => {
    const onOpen = jest.fn();
    render(<ProjectQARole summary={summary()} canManage onOpen={onOpen} onTurnOn={jest.fn()} />);
    expect(screen.getByText('3 open · 1 repair running')).toBeTruthy();
    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(screen.getByLabelText(/^PRs 1,/)).toBeTruthy();
    expect(screen.getByLabelText(/^CI ok,/)).toBeTruthy();
    expect(screen.getByText(/^Checked \d\d:\d\d$/)).toBeTruthy();
    fireEvent.press(screen.getByText('QA'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('claims nothing while paused and offers to turn a switched-off QA on only to managers', () => {
    const { rerender } = render(
      <ProjectQARole
        summary={summary({ mode: 'paused' })}
        canManage
        onOpen={jest.fn()}
        onTurnOn={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('qa-sources')).toBeNull();
    expect(screen.getByText('Paused')).toBeTruthy();
    const onTurnOn = jest.fn();
    rerender(
      <ProjectQARole
        summary={summary({ mode: 'off' })}
        canManage
        onOpen={jest.fn()}
        onTurnOn={onTurnOn}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Turn on' }));
    expect(onTurnOn).toHaveBeenCalled();
    rerender(
      <ProjectQARole
        summary={summary({ mode: 'off' })}
        canManage={false}
        onOpen={jest.fn()}
        onTurnOn={onTurnOn}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
  });

  it('filters the sessions QA worked in', () => {
    const session = { sessionId: 'repair', favorite: false } as never;
    const other = { sessionId: 'other', favorite: false } as never;
    const qa = new Set(['repair']);
    expect(workFilter(session, 'qa', qa)).toBe(true);
    expect(workFilter(other, 'qa', qa)).toBe(false);
    expect(workFilter(other, 'all', qa)).toBe(true);
  });
});

describe('QA page', () => {
  it('lists issues by what they need and opens one', async () => {
    setSearchParams({ id: 'p' });
    mockCreateVerityClient.mockReturnValue({
      getProject: jest.fn().mockRejectedValue(new Error('offline')),
      projectQA: {
        state: jest
          .fn()
          .mockResolvedValue(
            state([
              issue(),
              issue({ id: 'running', key: 'pr:91', state: 'open', repairing: true, roundsUsed: 1 }),
            ]),
          ),
      },
    } as unknown as VerityClient);
    render(<ProjectQAScreen />);
    expect(await screen.findByText('Needs you · 1')).toBeTruthy();
    expect(screen.getByText('In progress · 1')).toBeTruthy();
    expect(screen.getByText('Repair stopped after the allowed rounds.')).toBeTruthy();
    fireEvent.press(screen.getByText('PR #88'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/project/[id]/qa/[issue]',
      params: { id: 'p', issue: 'issue-88' },
    });
    fireEvent.press(screen.getByText('Chat'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/session/[id]',
      params: { id: 'qa-session' },
    });
  });

  it('answers a stopped issue and shows the evidence QA checked', async () => {
    setSearchParams({ id: 'p', issue: 'issue-88' });
    const decide = jest.fn().mockResolvedValue(state([issue({ state: 'open', reason: null })]));
    mockCreateVerityClient.mockReturnValue({
      getProject: jest.fn().mockRejectedValue(new Error('offline')),
      projectQA: { state: jest.fn().mockResolvedValue(state([issue()])), decide },
    } as unknown as VerityClient);
    render(<ProjectQAIssueScreen />);
    expect(await screen.findByText('sigstore v5 changed its signing API.')).toBeTruthy();
    expect(screen.getByText('2 of 2 used')).toBeTruthy();
    expect(screen.getByText('9c03e1f')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Another round' }));
    });
    expect(decide).toHaveBeenCalledWith('p', 'issue-88', 'another_round');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Another round' })).toBeNull());
  });
});
