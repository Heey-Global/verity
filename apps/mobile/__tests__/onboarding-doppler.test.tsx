// Behaviour tests for the real onboarding Doppler STEP screen (#320, OPTIONAL step):
// save → validate → advance gate, validation failure blocks + shows the error, the
// explicit Skip advances WITHOUT a token, the guidance block + dashboard link render,
// and editing after a successful validation invalidates the gate. These assert
// user-visible behaviour — what the operator sees and what the screen does with the
// client — not the component's internals, so a valid re-implementation would pass.
//
// `expo-router` is mocked so `router.replace` (the scaffold's Back/Next + the Skip
// control) is observable; `../lib/client` is mocked so each test injects an
// in-memory fake VerityClient. `@verity/mobile` resolves to its built dist so the
// step-progress helpers run for real.
import { VerityApiError, type VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

const mockReplace = jest.fn<void, [string]>();
const mockPush = jest.fn<void, [string]>();
jest.mock('expo-router', () => ({
  router: { replace: (href: string) => mockReplace(href), push: (href: string) => mockPush(href) },
  useSegments: () => [] as string[],
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
  getVerityBaseUrl: () => 'http://verity.example:8082',
}));

// Spy on the real `Linking.openURL` so the guidance link's effect is observable
// without opening a URL (jsdom/jest has no native Linking backend).
const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);

import OnboardingDoppler from '../app/onboarding/doppler';

function fakeClient(overrides: Partial<VerityClient>): VerityClient {
  return overrides as unknown as VerityClient;
}

// A NEUTRAL, non-secret fixture — deliberately NOT a `dp.*`-shaped literal, so no
// secret-shaped string lands in source.
const TOKEN_FIXTURE = 'doppler-token-fixture-value';

const baseClient = (overrides: Partial<VerityClient>): VerityClient =>
  fakeClient({
    updateVeritySettings: jest.fn().mockResolvedValue({}),
    validateDoppler: jest.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  });

beforeEach(() => {
  mockReplace.mockReset();
  mockPush.mockReset();
  mockCreateVerityClient.mockReset();
  openURL.mockClear();
});

describe('onboarding doppler step (optional)', () => {
  it('renders the guidance block and opens the Doppler dashboard link', () => {
    mockCreateVerityClient.mockReturnValue(baseClient({}));
    render(<OnboardingDoppler />);

    expect(screen.getByText('Connect Doppler (optional)')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Open the Doppler dashboard'));
    expect(openURL).toHaveBeenCalledWith('https://dashboard.doppler.com');
  });

  it('exposes accessible field + button labels', () => {
    mockCreateVerityClient.mockReturnValue(baseClient({}));
    render(<OnboardingDoppler />);

    expect(screen.getByLabelText('Doppler Service Account token')).toBeOnTheScreen();
    expect(screen.getByLabelText('Save and validate Doppler token')).toBeOnTheScreen();
    expect(screen.getByLabelText('Skip — set up later')).toBeOnTheScreen();
  });

  it('Skip advances to AI backend logins WITHOUT a token or any save/validate call', () => {
    const updateVeritySettings = jest.fn().mockResolvedValue({});
    const validateDoppler = jest.fn().mockResolvedValue({ ok: true });
    mockCreateVerityClient.mockReturnValue(baseClient({ updateVeritySettings, validateDoppler }));
    render(<OnboardingDoppler />);

    fireEvent.press(screen.getByLabelText('Skip — set up later'));

    expect(mockPush).toHaveBeenCalledWith('/onboarding/ai-backends');
    expect(updateVeritySettings).not.toHaveBeenCalled();
    expect(validateDoppler).not.toHaveBeenCalled();
  });

  it('gates Continue behind a successful save + validate and shows the project count', async () => {
    const updateVeritySettings = jest.fn().mockResolvedValue({});
    const validateDoppler = jest.fn().mockResolvedValue({ ok: true, projectCount: 4 });
    mockCreateVerityClient.mockReturnValue(baseClient({ updateVeritySettings, validateDoppler }));
    render(<OnboardingDoppler />);

    // No Continue before validation.
    expect(screen.queryByLabelText('Continue')).toBeNull();

    fireEvent.changeText(screen.getByLabelText('Doppler Service Account token'), TOKEN_FIXTURE);
    fireEvent.press(screen.getByLabelText('Save and validate Doppler token'));

    await waitFor(() => expect(validateDoppler).toHaveBeenCalled());
    // Save wrote the pasted token.
    expect(updateVeritySettings).toHaveBeenCalledWith(
      expect.objectContaining({ dopplerServiceToken: TOKEN_FIXTURE }),
    );
    // Success confirmation + Continue now present.
    expect(await screen.findByText(/Connected \(4 projects\)/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Continue')).toBeOnTheScreen();
  });

  it('blocks advance and shows the error when validation fails', async () => {
    const validateDoppler = jest
      .fn()
      .mockResolvedValue({ ok: false, error: 'Doppler rejected the token' });
    mockCreateVerityClient.mockReturnValue(baseClient({ validateDoppler }));
    render(<OnboardingDoppler />);

    fireEvent.changeText(screen.getByLabelText('Doppler Service Account token'), TOKEN_FIXTURE);
    fireEvent.press(screen.getByLabelText('Save and validate Doppler token'));

    expect(await screen.findByText('Doppler rejected the token')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Continue')).toBeNull();
  });

  it('maps a locked result to unlock guidance', async () => {
    const validateDoppler = jest.fn().mockResolvedValue({ ok: false, error: 'locked' });
    mockCreateVerityClient.mockReturnValue(baseClient({ validateDoppler }));
    render(<OnboardingDoppler />);

    fireEvent.changeText(screen.getByLabelText('Doppler Service Account token'), TOKEN_FIXTURE);
    fireEvent.press(screen.getByLabelText('Save and validate Doppler token'));

    expect(await screen.findByText(/The secret store is locked/)).toBeOnTheScreen();
    expect(screen.queryByLabelText('Continue')).toBeNull();
  });

  it('refuses to save an empty token client-side', async () => {
    const updateVeritySettings = jest.fn().mockResolvedValue({});
    mockCreateVerityClient.mockReturnValue(baseClient({ updateVeritySettings }));
    render(<OnboardingDoppler />);

    // Press without entering a token → refused client-side with a message.
    fireEvent.press(screen.getByLabelText('Save and validate Doppler token'));

    expect(
      await screen.findByText('Paste a Doppler Service Account token first.'),
    ).toBeOnTheScreen();
    expect(updateVeritySettings).not.toHaveBeenCalled();
  });

  it('editing the token after a successful validation invalidates the gate', async () => {
    const updateVeritySettings = jest.fn().mockResolvedValue({});
    const validateDoppler = jest.fn().mockResolvedValue({ ok: true, projectCount: 1 });
    mockCreateVerityClient.mockReturnValue(baseClient({ updateVeritySettings, validateDoppler }));
    render(<OnboardingDoppler />);

    fireEvent.changeText(screen.getByLabelText('Doppler Service Account token'), TOKEN_FIXTURE);
    fireEvent.press(screen.getByLabelText('Save and validate Doppler token'));
    await waitFor(() => expect(screen.getByLabelText('Continue')).toBeOnTheScreen());

    // Editing the token invalidates → Continue disappears until re-validated.
    fireEvent.changeText(screen.getByLabelText('Doppler Service Account token'), 'another-value');
    expect(screen.queryByLabelText('Continue')).toBeNull();
  });

  it('surfaces a network failure as a save/validate error', async () => {
    const updateVeritySettings = jest
      .fn()
      .mockRejectedValue(new VerityApiError(503, 'Verity is locked'));
    mockCreateVerityClient.mockReturnValue(baseClient({ updateVeritySettings }));
    render(<OnboardingDoppler />);

    fireEvent.changeText(screen.getByLabelText('Doppler Service Account token'), TOKEN_FIXTURE);
    fireEvent.press(screen.getByLabelText('Save and validate Doppler token'));

    expect(await screen.findByText('Verity is locked')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Continue')).toBeNull();
  });

  it('falls back to a Skip / Next control when no server is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<OnboardingDoppler />);

    // The no-client branch still lets the operator advance (optional step).
    expect(screen.getByLabelText('Skip / Next')).toBeOnTheScreen();
  });
});
