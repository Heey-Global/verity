import { type AgentLoop, type VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AgentLoopCockpit } from '../components/AgentLoopCockpit';

const loop: AgentLoop = {
  id: 'loop-1',
  projectId: 'project-1',
  name: 'Dependency audit',
  status: 'enabled',
  schedule: { kind: 'interval', everyMinutes: 30 },
  script: 'exit 0',
  reactionPrompt: null,
  reactionModel: null,
  sessionId: 'session-1',
  testedScriptFingerprint: 'sha256:tested',
  consecutiveErrorCount: 2,
  lastRunAt: '2026-07-13T18:00:00.000Z',
  lastOutcome: 'error',
  nextRunAt: '2026-07-13T18:30:00.000Z',
  createdAt: '2026-07-13T17:00:00.000Z',
  updatedAt: '2026-07-13T18:00:00.000Z',
};

const previousRun = {
  id: 'run-1',
  loopId: loop.id,
  startedAt: '2026-07-13T18:00:00.000Z',
  finishedAt: '2026-07-13T18:00:01.000Z',
  outcome: 'error' as const,
  exitCode: 1,
  detail: 'Script exited with code 1',
  sessionId: loop.sessionId,
  isTest: false,
};

function client(overrides: Partial<VerityClient> = {}): VerityClient {
  return {
    getAgentLoop: jest.fn().mockResolvedValue(loop),
    listAgentLoopRuns: jest.fn().mockResolvedValue([previousRun]),
    runAgentLoop: jest.fn().mockResolvedValue({
      result: { outcome: 'ok', exitCode: 0, detail: null, sessionId: loop.sessionId },
      run: { ...previousRun, id: 'run-2', outcome: 'ok', exitCode: 0, detail: null },
      loop: { ...loop, lastOutcome: 'ok', consecutiveErrorCount: 0 },
    }),
    updateAgentLoop: jest.fn().mockResolvedValue({ ...loop, status: 'paused' }),
    ...overrides,
  } as VerityClient;
}

describe('AgentLoopCockpit', () => {
  it('shows loop health, controls, and persisted run history', async () => {
    render(
      <AgentLoopCockpit
        client={client()}
        loop={loop}
        visible
        onClose={jest.fn()}
        onEdit={jest.fn()}
        onLoopChanged={jest.fn()}
        sessionBusy={false}
      />,
    );

    expect(screen.getByText('Dependency audit')).toBeOnTheScreen();
    expect(screen.getByText('Every 30 minutes')).toBeOnTheScreen();
    expect(screen.getByText(/2\/5 consecutive failures/)).toBeOnTheScreen();
    expect(await screen.findByText('Script exited with code 1')).toBeOnTheScreen();
    expect(screen.getByLabelText('Run now')).toBeEnabled();
    expect(screen.getByLabelText('Pause')).toBeEnabled();
  });

  it('runs now through the client and publishes the refreshed loop', async () => {
    const fake = client();
    const onLoopChanged = jest.fn();
    render(
      <AgentLoopCockpit
        client={fake}
        loop={loop}
        visible
        onClose={jest.fn()}
        onEdit={jest.fn()}
        onLoopChanged={onLoopChanged}
        sessionBusy={false}
      />,
    );

    await screen.findByText('Script exited with code 1');
    fireEvent.press(screen.getByLabelText('Run now'));

    await waitFor(() => expect(fake.runAgentLoop).toHaveBeenCalledWith(loop.id));
    expect(onLoopChanged).toHaveBeenCalledWith(
      expect.objectContaining({ lastOutcome: 'ok', consecutiveErrorCount: 0 }),
    );
    expect(await screen.findByText('No action')).toBeOnTheScreen();
  });

  it('refreshes loop state and disables editing while its session is busy', async () => {
    const refreshed = { ...loop, status: 'paused' as const, nextRunAt: null };
    const fake = client({ getAgentLoop: jest.fn().mockResolvedValue(refreshed) });
    const onLoopChanged = jest.fn();
    render(
      <AgentLoopCockpit
        client={fake}
        loop={loop}
        visible
        onClose={jest.fn()}
        onEdit={jest.fn()}
        onLoopChanged={onLoopChanged}
        sessionBusy
      />,
    );

    await waitFor(() => expect(onLoopChanged).toHaveBeenCalledWith(refreshed));
    expect(screen.getByLabelText('Edit')).toBeDisabled();
  });
});
