// Authorization failures must stay visible after GitHub leaves onboarding.
import type { VerityClient, OnboardingStatus } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
const mockGetVerityBaseUrl = jest.fn<string | null, []>();
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
  getVerityBaseUrl: () => mockGetVerityBaseUrl(),
}));

// Spy on the real `Linking.openURL` so the guidance link's effect is observable
// without opening a URL (jsdom/jest has no native Linking backend).
const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
const mockOpenAuthSessionAsync = jest.fn();
const mockDismissAuthSession = jest.fn<void, []>();
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...args: unknown[]) => mockOpenAuthSessionAsync(...args),
  dismissAuthSession: () => mockDismissAuthSession(),
}));

// `expo-clipboard` has no jsdom backend — mock it so the copy button's effect is
// observable without a native module.
const mockSetStringAsync = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true);
const mockGetStringAsync = jest.fn<Promise<string>, []>().mockResolvedValue('');
jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockSetStringAsync(value),
  getStringAsync: () => mockGetStringAsync(),
}));

import { GithubConnectPanel } from '../components/GithubConnectPanel';
function GithubPanel() {
  return <GithubConnectPanel client={mockCreateVerityClient()!} onConnected={jest.fn()} />;
}

function fakeClient(overrides: Partial<VerityClient>): VerityClient {
  return {
    getVeritySettings: jest.fn().mockResolvedValue({}),
    updateVeritySettings: jest.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as VerityClient;
}

function status(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    sealed: false,
    masterPasswordSet: true,
    githubAppConfigured: false,
    signingKeyConfigured: false,
    hasProject: false,
    dopplerConfigured: false,
    claudeConfigured: false,
    codexConfigured: false,
    complete: false,
    nextStep: 'github',
    ...overrides,
  };
}

beforeEach(() => {
  mockCreateVerityClient.mockReset();
  mockGetVerityBaseUrl.mockReturnValue('http://verity.example:8082');
  openURL.mockClear();
  mockOpenAuthSessionAsync.mockReset();
  mockDismissAuthSession.mockClear();
});

describe('GitHub settings authorization panel', () => {
  const PUBLIC_KEY = 'ssh-ed25519 AAAAExamplePublicKeyBody holger@example.test';

  it('shows progress immediately and prevents duplicate authorization starts', async () => {
    let resolvePreparation!: (value: { state: string; manifest: { name: string } }) => void;
    const prepareGithubManifest = jest.fn(
      () =>
        new Promise<{ state: string; manifest: { name: string } }>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    // The authorization sheet stays open — the panel keeps waiting on it.
    mockOpenAuthSessionAsync.mockReturnValue(new Promise(() => {}));
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest,
      }),
    );
    render(<GithubPanel />);

    const connect = screen.getByLabelText('Connect to GitHub');
    fireEvent.press(connect);
    fireEvent.press(connect);

    expect(screen.getByText('Opening GitHub…')).toBeOnTheScreen();
    expect(prepareGithubManifest).toHaveBeenCalledTimes(1);

    resolvePreparation({ state: 'state-1', manifest: { name: 'Verity-a1b2c3d4' } });
    expect(await screen.findByText('Waiting for GitHub…')).toBeOnTheScreen();
    expect(mockOpenAuthSessionAsync).toHaveBeenCalledTimes(1);
    expect(openURL).not.toHaveBeenCalled();
  });

  it('stops a stuck authorization preparation and offers a retry', async () => {
    jest.useFakeTimers();
    const prepareGithubManifest = jest.fn(
      (...args: Parameters<VerityClient['prepareGithubManifest']>) =>
        new Promise<never>((_resolve, reject) => {
          args[4]?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest,
      }),
    );
    render(<GithubPanel />);

    fireEvent.press(screen.getByLabelText('Connect to GitHub'));
    await act(() => jest.advanceTimersByTimeAsync(15000));

    expect(
      screen.getByText('Could not start GitHub authorization. Check the connection and try again.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Connect to GitHub')).toBeOnTheScreen();
    jest.useRealTimers();
  });

  // The reported "I tap Connect to GitHub and nothing happens". `openAuthSessionAsync`
  // reports "the user closed the sheet" and "the sheet never opened" with the same
  // `cancel`/`dismiss` value, and a session held from an earlier attempt as `locked`.
  // Reading all three as a cancellation returns the panel to idle rendering NOTHING —
  // the screen is byte-identical to before the tap, on every tap. Each startup
  // failure has to say why; the iOS module attaches the ASWebAuthenticationSession
  // error text untyped to the result, and it is the only place the OS names the
  // actual presentation failure, so it must reach the screen.
  it.each([
    [
      'locked',
      { type: 'locked' },
      'A stale GitHub authorization window was detected. Try again, and restart Verity if it stays locked.',
    ],
    [
      'an auth session that never presented',
      { type: 'cancel' },
      'GitHub authorization could not open on this device. Try again, and restart Verity if it keeps happening.',
    ],
    [
      'an auth session that failed with a native reason',
      {
        type: 'cancel',
        error:
          'Application with identifier build.verity.app is not associated with domain verity.build.',
      },
      'GitHub authorization could not open on this device: Application with identifier build.verity.app is not associated with domain verity.build.',
    ],
  ])('reports %s instead of silently returning to the button', async (_name, result, message) => {
    mockOpenAuthSessionAsync.mockResolvedValue(result);
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest: jest
          .fn()
          .mockResolvedValue({ state: 'state-1', manifest: { name: 'Verity-a1b2c3d4' } }),
      }),
    );
    render(<GithubPanel />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Connect to GitHub'));
    });

    expect(openURL).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('Connect to GitHub')).toBeOnTheScreen();
    expect(mockDismissAuthSession).toHaveBeenCalledTimes(_name === 'locked' ? 1 : 0);
  });

  it('still offers recovery when clearing a locked native session throws', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'locked' });
    mockDismissAuthSession.mockImplementationOnce(() => {
      throw new Error('native cleanup failed');
    });
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest: jest
          .fn()
          .mockResolvedValue({ state: 'state-1', manifest: { name: 'Verity-a1b2c3d4' } }),
      }),
    );
    render(<GithubPanel />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Connect to GitHub'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'A stale GitHub authorization window was detected. Try again, and restart Verity if it stays locked.',
    );
  });

  it('reports a thrown auth-session start instead of silently returning', async () => {
    mockOpenAuthSessionAsync.mockRejectedValue(new Error('Web browser is already open'));
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest: jest
          .fn()
          .mockResolvedValue({ state: 'state-1', manifest: { name: 'Verity-a1b2c3d4' } }),
      }),
    );
    render(<GithubPanel />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Connect to GitHub'));
    });

    expect(openURL).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'GitHub authorization could not open in the app.',
    );
    expect(screen.getByLabelText('Connect to GitHub')).toBeOnTheScreen();
  });

  it('single-lines and caps the native failure reason', async () => {
    // An NSError description is unbounded and may span paragraphs; the alert is
    // a one-line layout. Without the cap this regression ships green on the
    // short single-line fixtures above.
    mockOpenAuthSessionAsync.mockResolvedValue({
      type: 'cancel',
      error: `sheet\n\n  failed ${'x'.repeat(300)}`,
    });
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest: jest
          .fn()
          .mockResolvedValue({ state: 'state-1', manifest: { name: 'Verity-a1b2c3d4' } }),
      }),
    );
    render(<GithubPanel />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Connect to GitHub'));
    });

    const message = screen.getByRole('alert').props.children as string;
    expect(message).toMatch(
      /^GitHub authorization could not open on this device: sheet failed x+$/,
    );
    expect(message.length).toBeLessThanOrEqual(
      'GitHub authorization could not open on this device: '.length + 200,
    );
  });

  it('shows one Connect to GitHub path without existing-App credentials', () => {
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest: jest.fn().mockResolvedValue({ startToken: 'ott-test' }),
      }),
    );

    render(<GithubPanel />);

    expect(screen.getByLabelText('Connect to GitHub')).toBeOnTheScreen();
    expect(screen.queryByText('Use existing App')).toBeNull();
    expect(screen.queryByLabelText('App ID')).toBeNull();
    expect(screen.queryByLabelText('App private key')).toBeNull();
  });

  it('opens the public fragment-only bridge instead of the paired server', async () => {
    mockOpenAuthSessionAsync
      .mockResolvedValueOnce({
        type: 'success',
        url: 'https://verity.build/github/app/callback?phase=created&code=github-code&state=state-1',
      })
      .mockResolvedValueOnce({
        type: 'success',
        url: 'https://verity.build/github/app/callback?phase=installed&installation_id=installation-1&state=state-2',
      });
    const prepareGithubManifest = jest.fn().mockResolvedValue({
      startToken: 'legacy-token',
      state: 'state-1',
      manifest: { name: 'Verity-a1b2c3d4' },
    });
    const fetchOnboardingStatus = jest
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ githubAppConfigured: true }));
    const completeGithubManifest = jest
      .fn()
      .mockResolvedValue('https://github.com/apps/verity-test/installations/new?state=state-2');
    const completeGithubManifestInstallation = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus,
        prepareGithubManifest,
        completeGithubManifest,
        completeGithubManifestInstallation,
        getVeritySettings: jest.fn().mockResolvedValue({
          gitUserName: 'Holger',
          gitUserEmail: 'holger@example.test',
        }),
        getSigningKey: jest.fn().mockResolvedValue({ configured: true, publicKey: PUBLIC_KEY }),
      }),
    );
    render(<GithubPanel />);

    fireEvent.press(screen.getByLabelText('Connect to GitHub'));
    await waitFor(() => expect(mockOpenAuthSessionAsync).toHaveBeenCalledTimes(2));
    const opened = mockOpenAuthSessionAsync.mock.calls[0]?.[0] ?? '';
    expect(opened).toMatch(/^https:\/\/verity\.build\/github\/app\/#/);
    expect(opened).not.toContain('verity.example:8082');
    expect(JSON.parse(decodeURIComponent(new URL(opened).hash.slice(1)))).toEqual({
      state: 'state-1',
      manifest: { name: 'Verity-a1b2c3d4' },
    });
    expect(prepareGithubManifest).toHaveBeenCalledWith(
      'http://verity.example:8082',
      undefined,
      '/github-connect',
      true,
      expect.anything(),
    );
    expect(mockOpenAuthSessionAsync).toHaveBeenNthCalledWith(
      1,
      opened,
      'https://verity.build/github/app/callback',
      { preferUniversalLinks: true },
    );
    expect(completeGithubManifest).toHaveBeenCalledWith('github-code', 'state-1');
    expect(mockOpenAuthSessionAsync).toHaveBeenNthCalledWith(
      2,
      'https://github.com/apps/verity-test/installations/new?state=state-2',
      'https://verity.build/github/app/callback',
      { preferUniversalLinks: true },
    );
    expect(completeGithubManifestInstallation).toHaveBeenCalledWith('installation-1', 'state-2');
  });

  it('leaves the waiting state when the GitHub auth session is cancelled', async () => {
    // The auth session itself advances the clock, so elapsed time survives any
    // other Date.now caller in the render path — an ordering-coupled
    // `mockReturnValueOnce` would hand the "session open" reading to whichever
    // caller happens to come first. A genuine cancel also arrives with iOS's
    // `canceledLogin` error text, which must not flip it into the failure path.
    let clock = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    mockOpenAuthSessionAsync.mockImplementation(() => {
      clock += 60_000;
      return Promise.resolve({
        type: 'cancel',
        error: 'The operation couldn’t be completed. (…WebAuthenticationSession error 1.)',
      });
    });
    const completeGithubManifest = jest.fn();
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest: jest.fn().mockResolvedValue({
          state: 'state-1',
          manifest: { name: 'Verity-a1b2c3d4' },
        }),
        completeGithubManifest,
      }),
    );
    render(<GithubPanel />);

    fireEvent.press(screen.getByLabelText('Connect to GitHub'));

    await waitFor(() => expect(mockOpenAuthSessionAsync).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Connect to GitHub')).toBeOnTheScreen();
    // Silently back to the button — what separates a genuine cancel from the
    // reported-failure paths above, which all render an alert.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(completeGithubManifest).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('rejects a server response that only offers the legacy browser flow', async () => {
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest: jest.fn().mockResolvedValue({ startToken: 'legacy-token' }),
      }),
    );
    render(<GithubPanel />);

    fireEvent.press(screen.getByLabelText('Connect to GitHub'));

    expect(
      await screen.findByText(
        'Could not start GitHub authorization. Check the connection and try again.',
      ),
    ).toBeOnTheScreen();
    expect(mockOpenAuthSessionAsync).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
  });

  it('opens organization setup through the public bridge too', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    const prepareGithubManifest = jest.fn().mockResolvedValue({
      state: 'state-organization',
      manifest: { name: 'Verity-a1b2c3d4' },
    });
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest,
      }),
    );
    render(<GithubPanel />);

    fireEvent.press(screen.getByLabelText('Connect a GitHub organization'));
    fireEvent.changeText(screen.getByLabelText('GitHub organization'), 'Heey-Global');
    fireEvent.press(screen.getByLabelText('Connect to GitHub'));

    await waitFor(() => expect(mockOpenAuthSessionAsync).toHaveBeenCalledTimes(1));
    const opened = mockOpenAuthSessionAsync.mock.calls[0]?.[0] ?? '';
    expect(opened).toMatch(/^https:\/\/verity\.build\/github\/app\/#/);
    expect(opened).not.toContain('verity.example:8082');
    expect(JSON.parse(decodeURIComponent(new URL(opened).hash.slice(1)))).toEqual({
      state: 'state-organization',
      manifest: { name: 'Verity-a1b2c3d4' },
      owner: 'Heey-Global',
    });
    expect(prepareGithubManifest).toHaveBeenCalledWith(
      'http://verity.example:8082',
      'Heey-Global',
      '/github-connect',
      true,
      expect.anything(),
    );
  });
});
