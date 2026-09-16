import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn<void, [string]>();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { replace: (href: string) => mockReplace(href) },
  useLocalSearchParams: () => mockParams,
}));

const mockIsBiometricUnlockEnabled = jest.fn<Promise<boolean>, [string | null]>();
const mockCanUseBiometricUnlock = jest.fn<Promise<boolean>, []>();
const mockEnableBiometricUnlock = jest.fn<Promise<boolean>, [string | null]>();
const mockDisableBiometricUnlock = jest.fn<Promise<void>, [string | null]>();
jest.mock('../lib/authToken', () => ({
  isBiometricUnlockEnabled: (baseUrl: string | null) => mockIsBiometricUnlockEnabled(baseUrl),
  canUseBiometricUnlock: () => mockCanUseBiometricUnlock(),
  enableBiometricUnlock: (baseUrl: string | null) => mockEnableBiometricUnlock(baseUrl),
  disableBiometricUnlock: (baseUrl: string | null) => mockDisableBiometricUnlock(baseUrl),
}));

jest.mock('../lib/client', () => ({
  getVerityBaseUrl: () => 'https://verity.example.test:8082',
}));

import SecureDevice from '../app/secure-device';

beforeEach(() => {
  mockReplace.mockReset();
  mockIsBiometricUnlockEnabled.mockReset().mockResolvedValue(false);
  mockCanUseBiometricUnlock.mockReset().mockResolvedValue(true);
  mockEnableBiometricUnlock.mockReset().mockResolvedValue(true);
  mockDisableBiometricUnlock.mockReset().mockResolvedValue(undefined);
  mockParams = { returnTo: '/' };
});

describe('secure this device after pairing', () => {
  it('stores the biometric opt-in for the paired server before forwarding', async () => {
    // The opt-in is what makes the enrolled bearer readable at the next cold
    // start. Forwarding without persisting it leaves the device with a token
    // nothing will unlock, and the unlock screen falls back to a master-password
    // form the server rejects for want of a proven device.
    render(<SecureDevice />);

    fireEvent.press(await screen.findByLabelText('Use Face ID'));

    await waitFor(() =>
      expect(mockEnableBiometricUnlock).toHaveBeenCalledWith('https://verity.example.test:8082'),
    );
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('records a declined offer rather than leaving the preference undecided', async () => {
    render(<SecureDevice />);

    fireEvent.press(await screen.findByLabelText('Not now'));

    await waitFor(() =>
      expect(mockDisableBiometricUnlock).toHaveBeenCalledWith('https://verity.example.test:8082'),
    );
    expect(mockEnableBiometricUnlock).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it.each([
    ['biometric unlock is already enabled', { enabled: true, canUse: true }],
    ['the device has no enrolled biometrics', { enabled: false, canUse: false }],
  ])('forwards silently when there is nothing to ask: %s', async (_label, { enabled, canUse }) => {
    // Pairing has already succeeded by the time this screen mounts. A prompt with
    // no answer worth collecting would strand the operator on an interstitial
    // after a flow they consider finished.
    mockIsBiometricUnlockEnabled.mockResolvedValue(enabled);
    mockCanUseBiometricUnlock.mockResolvedValue(canUse);
    render(<SecureDevice />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(screen.queryByLabelText('Use Face ID')).toBeNull();
  });

  it('forwards to the app root rather than an off-app returnTo', async () => {
    // `returnTo` arrives from a URL. Handing it to the router unchecked would let
    // a crafted link bounce the freshly paired device straight back out of the app.
    mockParams = { returnTo: '//evil.example' };
    mockIsBiometricUnlockEnabled.mockResolvedValue(true);
    render(<SecureDevice />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });
});
