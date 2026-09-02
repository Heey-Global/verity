import type { OnboardingStatus } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn<void, [string]>();
const mockBack = jest.fn<void, []>();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { replace: (href: string) => mockReplace(href), back: () => mockBack() },
  useLocalSearchParams: () => mockParams,
  useSegments: () => [] as string[],
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

const mockCopy = jest.fn<Promise<void>, [string]>();
const mockPaste = jest.fn<Promise<string>, []>();
jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockCopy(value),
  getStringAsync: () => mockPaste(),
}));

let scan: ((event: { data: string }) => void) | undefined;
const mockRequestPermission = jest.fn();
jest.mock('expo-camera', () => {
  const { View } = jest.requireActual('react-native');
  return {
    CameraView: (props: { onBarcodeScanned: (event: { data: string }) => void }) => {
      scan = props.onBarcodeScanned;
      return <View testID="camera" />;
    },
    useCameraPermissions: () => [{ granted: true }, mockRequestPermission],
  };
});

const mockGetAuthToken = jest.fn<string | null, [string | null]>();
jest.mock('../lib/authToken', () => ({
  getAuthToken: (baseUrl: string | null) => mockGetAuthToken(baseUrl),
}));
const mockGetVerityBaseUrl = jest.fn<string | null, []>();
jest.mock('../lib/client', () => ({ getVerityBaseUrl: () => mockGetVerityBaseUrl() }));

const mockEstablishPairing = jest.fn();
const mockVerifyEndpoint = jest.fn();
jest.mock('../lib/pairingSession', () => ({
  establishPairing: (...args: unknown[]) => mockEstablishPairing(...args),
  verifyAndSaveDirectEndpoint: (...args: unknown[]) => mockVerifyEndpoint(...args),
}));
jest.mock('../lib/pairing', () => ({
  parsePairingUri: () => ({
    serverId: 'server-1',
    kind: 'installer',
    suggestedUrl: 'https://verity.example.test:8082',
    identityKey: 'identity',
    tlsPin: 'pin',
    pairingCode: 'pairing-code',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }),
}));

import OnboardingServerUrl from '../app/onboarding/server-url';

function status(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
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
  mockCopy.mockReset().mockResolvedValue(undefined);
  mockPaste.mockReset().mockResolvedValue('');
  mockRequestPermission.mockReset();
  mockEstablishPairing.mockReset();
  mockVerifyEndpoint.mockReset();
  mockGetAuthToken.mockReset().mockReturnValue(null);
  mockGetVerityBaseUrl.mockReset().mockReturnValue(null);
  mockParams = {};
  scan = undefined;
});

describe('onboarding connection entry', () => {
  it('welcomes first-run users with installer guidance and no manual address field', () => {
    render(<OnboardingServerUrl />);
    expect(screen.getByText('Secure pairing')).toBeOnTheScreen();
    expect(screen.getByText('Install Verity on your server')).toBeOnTheScreen();
    expect(screen.getByText('Pair this device')).toBeOnTheScreen();
    expect(screen.getAllByText(/^Step [12]$/)).toHaveLength(2);
    expect(screen.getByText(/curl -fsSL https:\/\/verity\.build\/install\.sh/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Scan QR code')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Server address')).toBeNull();
    expect(screen.queryByLabelText('Test connection')).toBeNull();
  });

  it('copies the canonical installer command', async () => {
    render(<OnboardingServerUrl />);
    fireEvent.press(screen.getByLabelText('Copy install command'));
    await waitFor(() =>
      expect(mockCopy).toHaveBeenCalledWith('curl -fsSL https://verity.build/install.sh | bash'),
    );
    expect(await screen.findByText('Copied')).toBeOnTheScreen();
  });

  it('opens the scanner and pairs immediately after a valid scan', async () => {
    mockEstablishPairing.mockResolvedValue(status());
    render(<OnboardingServerUrl />);
    fireEvent.press(screen.getByLabelText('Scan QR code'));
    expect(await screen.findByTestId('camera')).toBeOnTheScreen();
    act(() => {
      scan?.({ data: 'verity-pair://payload' });
      scan?.({ data: 'verity-pair://payload' });
    });
    await waitFor(() =>
      expect(mockEstablishPairing).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'server-1' }),
        'https://verity.example.test:8082',
      ),
    );
    expect(mockEstablishPairing).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/master-password');
  });

  it('keeps manual address recovery for an already-paired server', async () => {
    mockParams = { reconfigure: '1' };
    mockGetVerityBaseUrl.mockReturnValue('https://old.example.test:8082');
    mockVerifyEndpoint.mockResolvedValue(status({ complete: true }));
    render(<OnboardingServerUrl />);
    fireEvent.changeText(screen.getByLabelText('Server address'), 'https://new.example.test:8082');
    fireEvent.press(screen.getByLabelText('Test connection'));
    await waitFor(() =>
      expect(mockVerifyEndpoint).toHaveBeenCalledWith('https://new.example.test:8082'),
    );
    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
