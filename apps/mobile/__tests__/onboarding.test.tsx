// Smoke tests for the onboarding wizard SHELL (#320, PR 1). Two concerns:
//   1. A step screen renders its "Step N of M" progress + placeholder note and the
//      accessible Back/Next controls navigate (via router.replace) to the right
//      route. The step ordering itself is unit-tested in packages/mobile (vitest);
//      here we only assert the screen wires it into the RN tree + controls.
//   2. The first-run gate computes the correct redirect target for an incomplete
//      status, skips the redirect when already in the wizard, and FAILS OPEN (no
//      redirect, resolves) when the status fetch throws.
//
// `expo-router` is mocked so router.replace + useSegments are observable and no
// real navigator is needed. `../lib/client` is mocked so the gate's client is an
// in-memory fake we control per test.
import { VerityApiError } from '@verity/mobile';
import type { VerityClient, OnboardingStatus } from '@verity/mobile';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockReplace = jest.fn<void, [string]>();
const mockPush = jest.fn<void, [string]>();
const mockBack = jest.fn<void, []>();
const mockCanGoBack = jest.fn<boolean, []>(() => false);
let mockSegments: string[] = [];
let mockPathname = '/';
let mockSearchParams: Record<string, string | string[]> = {};

jest.mock('expo-router', () => ({
  router: {
    replace: (href: string) => mockReplace(href),
    push: (href: string) => mockPush(href),
    back: () => mockBack(),
    canGoBack: () => mockCanGoBack(),
  },
  useSegments: () => mockSegments,
  usePathname: () => mockPathname,
  useGlobalSearchParams: () => mockSearchParams,
  // Screens use <OnboardingStepScaffold> which imports only `router`; the layout's
  // <Stack> isn't rendered in these unit tests.
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
const mockGetVerityBaseUrl = jest.fn<string | null, []>();
const mockHasConfiguredVerityBaseUrl = jest.fn<boolean, []>();
const mockGetAuthToken = jest.fn<string | null, []>();
jest.mock('../lib/authToken', () => ({
  getAuthToken: () => mockGetAuthToken(),
}));
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
  getVerityBaseUrl: () => mockGetVerityBaseUrl(),
  hasConfiguredVerityBaseUrl: () => mockHasConfiguredVerityBaseUrl(),
}));

import OnboardingWelcome from '../app/onboarding/welcome';
import OnboardingGithub from '../app/onboarding/github';
import { useOnboardingGate } from '../hooks/useOnboardingGate';
import { Text } from 'react-native';

function GateProbe() {
  const state = useOnboardingGate();
  return (
    <Text>
      gate:{state.status}
      {state.status === 'done' && state.redirectTo ? `:${state.redirectTo}` : ''}
    </Text>
  );
}

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

function makeClient(fetchOnboardingStatus: jest.Mock): VerityClient {
  return { fetchOnboardingStatus } as unknown as VerityClient;
}

beforeEach(() => {
  mockReplace.mockReset();
  mockPush.mockReset();
  mockBack.mockReset();
  mockCanGoBack.mockReset();
  mockCanGoBack.mockReturnValue(false);
  mockSegments = [];
  mockPathname = '/';
  mockSearchParams = {};
  mockCreateVerityClient.mockReset();
  mockGetVerityBaseUrl.mockReset();
  mockHasConfiguredVerityBaseUrl.mockReset();
  mockGetAuthToken.mockReset();
  // Default: a base URL IS configured, so the gate proceeds to the status-driven
  // flow. The server-url precondition tests override this to null.
  mockGetVerityBaseUrl.mockReturnValue('http://verity.test:8082');
  mockHasConfiguredVerityBaseUrl.mockReturnValue(true);
  mockGetAuthToken.mockReturnValue('device-token');
});

describe('onboarding wizard shell — step screen', () => {
  it('renders the welcome step with its progress indicator and product orientation', () => {
    render(<OnboardingWelcome />);
    // Welcome is preflight before any server/secret setup, not a numbered wizard step.
    expect(screen.queryByLabelText(/Step \d+ of \d+/)).toBeNull();
    expect(screen.getByText('Secure development. Your choice of AI.')).toBeOnTheScreen();
    expect(screen.getByText(/Claude Code, Codex, and open-source models/)).toBeOnTheScreen();
    expect(screen.getByText(/isolated project sandboxes/)).toBeOnTheScreen();
    expect(screen.getByText(/Switch AI providers/)).toBeOnTheScreen();
    expect(screen.getByText('Get started')).toBeOnTheScreen();
  });

  it('advances via the accessible Next control (router.push to the next step)', () => {
    render(<OnboardingWelcome />);
    fireEvent.press(screen.getByLabelText('Continue'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/server-url');
  });

  it('offers deterministic Back navigation on a non-first step', () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient(
        jest.fn().mockResolvedValue(makeStatus({ masterPasswordSet: true, sealed: false })),
      ),
    );
    render(<OnboardingGithub />);
    // GitHub is step 4 of 9 and can go back to the master-password step.
    expect(screen.getByLabelText('Step 2 of 6')).toBeOnTheScreen();
    mockCanGoBack.mockReturnValue(true);
    fireEvent.press(screen.getByLabelText('Back'));
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/master-password');
  });
});

describe('onboarding first-run gate', () => {
  it('redirects to welcome when the device has no base URL (never fetches status)', async () => {
    mockGetVerityBaseUrl.mockReturnValue(null);
    mockHasConfiguredVerityBaseUrl.mockReturnValue(false);
    const fetchOnboardingStatus = jest.fn().mockResolvedValue(makeStatus());
    mockCreateVerityClient.mockReturnValue(makeClient(fetchOnboardingStatus));
    render(<GateProbe />);

    expect(await screen.findByText('gate:done:/onboarding/welcome')).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
    // Precondition short-circuits before any server call.
    expect(fetchOnboardingStatus).not.toHaveBeenCalled();
  });

  it('does not redirect to server-url when already inside the wizard even with no base URL', async () => {
    mockGetVerityBaseUrl.mockReturnValue(null);
    mockSegments = ['onboarding', 'server-url'];
    render(<GateProbe />);

    await screen.findByText('gate:done');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects a reset pristine server back to welcome even when a base URL is saved', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient(jest.fn().mockResolvedValue(makeStatus())));
    render(<GateProbe />);

    expect(await screen.findByText('gate:done:/onboarding/welcome')).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects to the resume step when setup is incomplete', async () => {
    // Master password already set → resume at github.
    const status = makeStatus({ masterPasswordSet: true, sealed: false, nextStep: 'github' });
    mockCreateVerityClient.mockReturnValue(makeClient(jest.fn().mockResolvedValue(status)));
    render(<GateProbe />);

    expect(await screen.findByText('gate:done:/onboarding/github')).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects existing partial setup to device unlock before later setup steps when no bearer is loaded', async () => {
    mockGetAuthToken.mockReturnValue(null);
    const status = makeStatus({ masterPasswordSet: true, sealed: false, nextStep: 'github' });
    mockCreateVerityClient.mockReturnValue(makeClient(jest.fn().mockResolvedValue(status)));
    render(<GateProbe />);

    expect(
      await screen.findByText('gate:done:/unlock-device?returnTo=%2Fonboarding%2Fgithub'),
    ).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalledWith('/onboarding/github');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not redirect when already inside the onboarding wizard', async () => {
    mockSegments = ['onboarding', 'github'];
    mockCreateVerityClient.mockReturnValue(makeClient(jest.fn().mockResolvedValue(makeStatus())));
    render(<GateProbe />);

    await screen.findByText('gate:done');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects complete setup to device unlock when no bearer token is loaded', async () => {
    mockGetAuthToken.mockReturnValue(null);
    mockCreateVerityClient.mockReturnValue(
      makeClient(
        jest.fn().mockResolvedValue(
          makeStatus({
            sealed: true,
            masterPasswordSet: true,
            githubAppConfigured: true,
            signingKeyConfigured: true,
            hasProject: true,
            complete: true,
            nextStep: null,
          }),
        ),
      ),
    );
    render(<GateProbe />);

    expect(
      await screen.findByText('gate:done:/unlock-device?returnTo=%2F&serverSecret=1'),
    ).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('preserves the requested deep link through device unlock', async () => {
    mockPathname = '/session/deep-link';
    mockSegments = ['session', 'deep-link'];
    mockSearchParams = { targetMessageId: 'message-42', targetSearchQuery: 'hello world' };
    mockGetAuthToken.mockReturnValue(null);
    mockCreateVerityClient.mockReturnValue(
      makeClient(
        jest
          .fn()
          .mockResolvedValue(
            makeStatus({ sealed: false, masterPasswordSet: true, complete: true, nextStep: null }),
          ),
      ),
    );
    render(<GateProbe />);

    expect(
      await screen.findByText(
        'gate:done:/unlock-device?returnTo=%2Fsession%2Fdeep-link%3FtargetMessageId%3Dmessage-42%26targetSearchQuery%3Dhello%2Bworld',
      ),
    ).toBeOnTheScreen();
  });

  it('does not self-redirect when already on the device unlock route', async () => {
    mockSegments = ['unlock-device'];
    mockGetAuthToken.mockReturnValue(null);
    mockCreateVerityClient.mockReturnValue(
      makeClient(
        jest.fn().mockResolvedValue(
          makeStatus({
            sealed: true,
            masterPasswordSet: true,
            githubAppConfigured: true,
            signingKeyConfigured: true,
            hasProject: true,
            complete: true,
            nextStep: null,
          }),
        ),
      ),
    );
    render(<GateProbe />);

    expect(await screen.findByText('gate:done')).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects complete sealed setup to server unlock even when a bearer token is loaded', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient(
        jest.fn().mockResolvedValue(
          makeStatus({
            sealed: true,
            masterPasswordSet: true,
            complete: true,
            nextStep: null,
          }),
        ),
      ),
    );
    render(<GateProbe />);

    expect(
      await screen.findByText('gate:done:/unlock-device?returnTo=%2F&serverSecret=1'),
    ).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not redirect when setup is already complete, unlocked, and a bearer token is loaded', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient(
        jest.fn().mockResolvedValue(
          makeStatus({
            sealed: false,
            masterPasswordSet: true,
            complete: true,
            nextStep: null,
          }),
        ),
      ),
    );
    render(<GateProbe />);

    await screen.findByText('gate:done');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('fails open when the status fetch throws (no redirect, resolves to done)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockCreateVerityClient.mockReturnValue(
      makeClient(jest.fn().mockRejectedValue(new VerityApiError(500, 'boom'))),
    );
    render(<GateProbe />);

    // The gate must resolve (not hang) and must NOT trap the operator in the wizard.
    expect(await screen.findByText('gate:done')).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('lets through with no server configured (client is null)', async () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<GateProbe />);

    expect(await screen.findByText('gate:done')).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
