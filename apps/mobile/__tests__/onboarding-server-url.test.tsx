// RTL tests for the onboarding server-url step (#320, "step 0"). The screen:
//   - prefills from the current base URL,
//   - on "Test connection" builds a throwaway VerityClient and probes
//     GET /onboarding/status,
//   - success → persists (setVerityBaseUrl) + advances (router.replace) + shows
//     "Connected",
//   - failure → shows an error and does NOT persist or advance.
//
// `@verity/mobile` is partially mocked so the constructed client's
// `fetchOnboardingStatus` is observable (the real `normalizeServerUrl` is kept —
// the screen's scheme defaulting mirrors it). `../lib/client` is mocked so persist
// is observable without touching AsyncStorage. `expo-router` is mocked for
// router.replace.
import type { OnboardingStatus } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn<void, [string]>();
const mockBack = jest.fn<void, []>();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { replace: (href: string) => mockReplace(href), back: () => mockBack() },
  useLocalSearchParams: () => mockParams,
  useSegments: () => [] as string[],
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

// The client's fetchOnboardingStatus, swapped per test. Captured URLs let us assert
// scheme defaulting on the probe.
const mockFetchOnboardingStatus = jest.fn<Promise<OnboardingStatus>, []>();
const constructedBaseUrls: string[] = [];
jest.mock('@verity/mobile', () => {
  const actual = jest.requireActual('@verity/mobile');
  return {
    ...actual,
    VerityClient: class {
      constructor(opts: { baseUrl: string }) {
        constructedBaseUrls.push(opts.baseUrl);
      }
      fetchOnboardingStatus() {
        return mockFetchOnboardingStatus();
      }
    },
  };
});

const mockGetAuthToken = jest.fn<string | null, [string | null]>();
jest.mock('../lib/authToken', () => ({
  getAuthToken: (baseUrl: string | null) => mockGetAuthToken(baseUrl),
}));

const mockGetVerityBaseUrl = jest.fn<string | null, []>();
const mockSetVerityBaseUrl = jest.fn<Promise<void>, [string]>();
jest.mock('../lib/client', () => ({
  getVerityBaseUrl: () => mockGetVerityBaseUrl(),
  setVerityBaseUrl: (url: string) => mockSetVerityBaseUrl(url),
}));

import OnboardingServerUrl from '../app/onboarding/server-url';

function makeStatus(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    sealed: true,
    masterPasswordSet: false,
    githubAppConfigured: false,
    signingKeyConfigured: false,
    hasProject: false,
    dopplerConfigured: false,
    claudeConfigured: false,
    codexConfigured: false,
    complete: false,
    nextStep: 'master-password',
    ...overrides,
  };
}

beforeEach(() => {
  mockReplace.mockReset();
  mockBack.mockReset();
  mockParams = {};
  mockFetchOnboardingStatus.mockReset();
  mockGetAuthToken.mockReset();
  mockGetVerityBaseUrl.mockReset();
  mockSetVerityBaseUrl.mockReset();
  mockSetVerityBaseUrl.mockResolvedValue(undefined);
  mockGetAuthToken.mockReturnValue(null);
  constructedBaseUrls.length = 0;
  mockGetVerityBaseUrl.mockReturnValue(null);
});

describe('onboarding server-url step', () => {
  it('renders as the preflight connection screen with an accessible input + test button', () => {
    render(<OnboardingServerUrl />);
    expect(screen.getByText('Verity connection')).toBeOnTheScreen();
    expect(screen.getByText('Connect your server')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/Step \d+ of \d+/)).toBeNull();
    expect(screen.getByLabelText('Server address')).toBeOnTheScreen();
    expect(screen.getByLabelText('Test connection')).toBeOnTheScreen();
  });

  it('prefills the input with the current base URL when one is set', () => {
    mockGetVerityBaseUrl.mockReturnValue('http://verity.example.ts.net:8082');
    render(<OnboardingServerUrl />);
    expect(screen.getByDisplayValue('http://verity.example.ts.net:8082')).toBeOnTheScreen();
  });

  it('on a successful test: probes status, persists the URL, shows Connected, and advances', async () => {
    mockFetchOnboardingStatus.mockResolvedValue(makeStatus());
    render(<OnboardingServerUrl />);

    fireEvent.changeText(screen.getByLabelText('Server address'), 'verity.example.ts.net:8082');
    fireEvent.press(screen.getByLabelText('Test connection'));

    // The bare input is normalized (scheme defaulted to http://) before both the
    // probe and the persist, so they receive the same canonical URL.
    await waitFor(() =>
      expect(mockSetVerityBaseUrl).toHaveBeenCalledWith('http://verity.example.ts.net:8082'),
    );
    expect(constructedBaseUrls).toContain('http://verity.example.ts.net:8082');
    expect(await screen.findByText('Connected')).toBeOnTheScreen();
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/master-password');
  });

  it('on an existing partial setup without a bearer: unlocks and returns to the resume step', async () => {
    mockFetchOnboardingStatus.mockResolvedValue(
      makeStatus({ masterPasswordSet: true, nextStep: 'github' }),
    );
    render(<OnboardingServerUrl />);

    fireEvent.changeText(screen.getByLabelText('Server address'), 'verity.example.ts.net:8082');
    fireEvent.press(screen.getByLabelText('Test connection'));

    await waitFor(() =>
      expect(mockSetVerityBaseUrl).toHaveBeenCalledWith('http://verity.example.ts.net:8082'),
    );
    expect(await screen.findByText('Connected')).toBeOnTheScreen();
    expect(mockGetAuthToken).toHaveBeenCalledWith('http://verity.example.ts.net:8082');
    expect(mockReplace).toHaveBeenCalledWith('/unlock-device?returnTo=%2Fonboarding%2Fgithub');
  });

  it('on an existing partial setup with a bearer: resumes the setup step directly', async () => {
    mockGetAuthToken.mockReturnValue('device-token');
    mockFetchOnboardingStatus.mockResolvedValue(
      makeStatus({ masterPasswordSet: true, nextStep: 'github' }),
    );
    render(<OnboardingServerUrl />);

    fireEvent.changeText(screen.getByLabelText('Server address'), 'verity.example.ts.net:8082');
    fireEvent.press(screen.getByLabelText('Test connection'));

    await waitFor(() =>
      expect(mockSetVerityBaseUrl).toHaveBeenCalledWith('http://verity.example.ts.net:8082'),
    );
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/github');
  });

  it('preserves an explicit https scheme on the probe', async () => {
    mockFetchOnboardingStatus.mockResolvedValue(makeStatus());
    render(<OnboardingServerUrl />);

    fireEvent.changeText(screen.getByLabelText('Server address'), 'https://verity.example.ts.net');
    fireEvent.press(screen.getByLabelText('Test connection'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/master-password'));
    expect(constructedBaseUrls).toContain('https://verity.example.ts.net');
  });

  it('reconfigure mode (from Settings): a successful test returns home, not into the wizard', async () => {
    mockParams = { reconfigure: '1' };
    mockGetVerityBaseUrl.mockReturnValue('http://old.example.ts.net:8082');
    mockFetchOnboardingStatus.mockResolvedValue(makeStatus());
    render(<OnboardingServerUrl />);

    // Prefilled with the existing (stale) address so a fix starts from it.
    expect(screen.getByLabelText('Server address').props.value).toBe(
      'http://old.example.ts.net:8082',
    );
    fireEvent.changeText(screen.getByLabelText('Server address'), 'http://new.example.ts.net:8082');
    fireEvent.press(screen.getByLabelText('Test connection'));

    await waitFor(() =>
      expect(mockSetVerityBaseUrl).toHaveBeenCalledWith('http://new.example.ts.net:8082'),
    );
    // Recovery path returns home, NOT into the onboarding wizard.
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockReplace).not.toHaveBeenCalledWith('/onboarding/master-password');
  });

  it('reconfigure mode offers a Cancel that goes back without changing the address', () => {
    mockParams = { reconfigure: '1' };
    mockGetVerityBaseUrl.mockReturnValue('http://old.example.ts.net:8082');
    render(<OnboardingServerUrl />);

    fireEvent.press(screen.getByLabelText('Cancel'));
    expect(mockBack).toHaveBeenCalled();
    expect(mockSetVerityBaseUrl).not.toHaveBeenCalled();
  });

  it('first-run (no reconfigure param): no Cancel control', () => {
    mockFetchOnboardingStatus.mockResolvedValue(makeStatus());
    render(<OnboardingServerUrl />);
    expect(screen.queryByLabelText('Cancel')).toBeNull();
  });

  it('on an unreachable address (TypeError): shows a reach error, does not persist or advance', async () => {
    mockFetchOnboardingStatus.mockRejectedValue(new TypeError('Network request failed'));
    render(<OnboardingServerUrl />);

    fireEvent.changeText(screen.getByLabelText('Server address'), 'nope.invalid');
    fireEvent.press(screen.getByLabelText('Test connection'));

    expect(await screen.findByText(/Could not reach that address/)).toBeOnTheScreen();
    expect(mockSetVerityBaseUrl).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('when the address is not a Verity server: shows a distinct error, does not advance', async () => {
    // A non-2xx / schema-parse failure surfaces as a non-TypeError rejection.
    mockFetchOnboardingStatus.mockRejectedValue(new Error('not verity'));
    render(<OnboardingServerUrl />);

    fireEvent.changeText(screen.getByLabelText('Server address'), 'http://example.com');
    fireEvent.press(screen.getByLabelText('Test connection'));

    expect(await screen.findByText(/does not look like a Verity API server/)).toBeOnTheScreen();
    expect(mockSetVerityBaseUrl).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not test with an empty address (button disabled)', () => {
    render(<OnboardingServerUrl />);
    fireEvent.press(screen.getByLabelText('Test connection'));
    expect(constructedBaseUrls).toHaveLength(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
