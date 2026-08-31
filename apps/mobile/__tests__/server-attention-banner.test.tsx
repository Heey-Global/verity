import { fireEvent, render, screen } from '@testing-library/react-native';

const mockNavigate = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    navigate: (href: string) => mockNavigate(href),
    push: (href: string) => mockPush(href),
  },
}));

import { ServerAttentionBanner } from '../components/ServerAttentionBanner';

describe('ServerAttentionBanner', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockPush.mockClear();
  });

  // The whole point of the action: a refused Codex sign-in is fixed on one screen,
  // and the banner is where you are when you learn about it.
  it('opens the Codex login flow when the server names that remedy', () => {
    render(
      <ServerAttentionBanner
        notice={{
          code: 'usage_probe_unhealthy',
          message: 'Codex sign-in was refused — sign in to Codex again',
          count: 1,
          action: 'codex-login',
        }}
      />,
    );

    expect(screen.getByRole('alert')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Sign in to Codex'));

    // Exactly the deep link the settings screen auto-starts a Codex login from.
    expect(mockNavigate).toHaveBeenCalledWith('/settings?agentLogin=codex');
    // And not stacked: the banner outlives the tap, so a second one has to return
    // to that screen rather than pile another copy on the history.
    expect(mockPush).not.toHaveBeenCalled();
  });

  // A notice that stands for several keeps both halves: the "+N more" tail and the
  // action. Whether they also FIT is a layout question this renderer cannot answer
  // — it performs no layout — so `numberOfLines` and `flexShrink` stay unasserted
  // here; what is pinned is that neither half displaces the other.
  it('keeps the action alongside a notice that stands for several', () => {
    render(
      <ServerAttentionBanner
        notice={{
          code: 'usage_probe_unhealthy',
          message: 'Codex sign-in was refused — sign in to Codex again',
          count: 3,
          action: 'codex-login',
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/\(\+2 more\)$/);
    fireEvent.press(screen.getByLabelText('Sign in to Codex'));
    expect(mockNavigate).toHaveBeenCalledWith('/settings?agentLogin=codex');
  });

  // Most attention signals have no one-tap remedy. Offering a button for them
  // would send you to a screen that cannot help.
  it('shows no action for a notice that names none', () => {
    render(
      <ServerAttentionBanner
        notice={{
          code: 'secret_sealed',
          message: 'Server is sealed — sessions cannot sign commits',
          count: 1,
        }}
      />,
    );

    expect(screen.getByText('Server is sealed — sessions cannot sign commits')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
