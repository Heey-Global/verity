const mockLive = new Set<() => void>();
jest.mock('../lib/liveConnection', () => ({
  subscribeLiveRefresh: (_client: unknown, refresh: () => void) => {
    mockLive.add(refresh);
    return () => mockLive.delete(refresh);
  },
}));
beforeEach(() => mockLive.clear());
import { type AgentLogin, type VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { AgentLoginPanel } from './AgentLoginPanel';
import { lightTheme } from '../theme/tokens';

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

describe('AgentLoginPanel live updates', () => {
  it('uses the shared primary palette for agent login actions', () => {
    const client = {} as VerityClient;
    render(<AgentLoginPanel client={client} configured={{ claude: false, codex: false }} />);

    expect(screen.getByLabelText('Connect Claude')).toHaveStyle({
      backgroundColor: lightTheme.colors.primary,
    });
    expect(screen.getByLabelText('Connect Codex')).toHaveStyle({
      backgroundColor: lightTheme.colors.primary,
    });
  });

  it('shows configured provider actions directly in compact settings', () => {
    render(
      <AgentLoginPanel
        client={{} as VerityClient}
        configured={{ claude: true, codex: true }}
        compact
        allowDisconnect
      />,
    );
    expect(screen.getByLabelText('Logout Claude')).toBeOnTheScreen();
    expect(screen.getByLabelText('Logout Codex')).toBeOnTheScreen();
  });

  it.each(['claude', 'codex'] as const)('shows only the selected %s provider', (provider) => {
    render(
      <AgentLoginPanel
        client={{} as VerityClient}
        configured={{ claude: true, codex: true }}
        selectedProvider={provider}
        compact
        allowDisconnect
      />,
    );
    const title = provider === 'claude' ? 'Claude' : 'Codex';
    const otherTitle = provider === 'claude' ? 'Codex' : 'Claude';
    expect(screen.getByLabelText('Logout ' + title)).toBeOnTheScreen();
    expect(screen.queryByText(otherTitle)).toBeNull();
    expect(screen.queryByLabelText('Logout ' + otherTitle)).toBeNull();
  });

  it('does not overlap refreshes for the same login session', async () => {
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
    await act(async () => {
      for (const refresh of mockLive) {
        refresh();
        refresh();
      }
    });
    expect(getAgentLogin).toHaveBeenCalledTimes(1);

    await act(async () => resolvePoll(waitingLogin));
    await act(async () => {
      for (const refresh of mockLive) refresh();
    });
    expect(getAgentLogin).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
