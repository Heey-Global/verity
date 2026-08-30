import { type AgentLogin, type VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { AgentLoginPanel } from './AgentLoginPanel';

const waitingLogin = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  provider: 'claude',
  status: 'waiting',
  verificationUri: 'https://claude.test/login',
  userCode: null,
  needsCode: false,
  configured: false,
  message: null,
} as AgentLogin;

describe('AgentLoginPanel polling', () => {
  it('does not overlap polls for the same login session', async () => {
    jest.useFakeTimers();
    let resolvePoll!: (login: AgentLogin) => void;
    const getAgentLogin = jest.fn(
      () =>
        new Promise<AgentLogin>((resolve) => {
          resolvePoll = resolve;
        }),
    );
    const client = {
      startAgentLogin: jest.fn().mockResolvedValue(waitingLogin),
      getAgentLogin,
    } as unknown as VerityClient;
    render(<AgentLoginPanel client={client} configured={{ claude: false, codex: false }} />);

    fireEvent.press(screen.getByLabelText('Connect Claude'));
    await act(async () => undefined);
    await act(async () => jest.advanceTimersByTime(7_500));
    expect(getAgentLogin).toHaveBeenCalledTimes(1);

    await act(async () => resolvePoll(waitingLogin));
    await act(async () => jest.advanceTimersByTime(2_500));
    expect(getAgentLogin).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
