// The last onboarding stop: open the welcome session, wait for the starter
// project while its sandbox is still being set up, and fall back to the home
// screen for everything else. Falling back is the important half: an older
// server without the endpoint must land the operator where they landed before.
import type { VerityClient, WelcomeSession } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

let mockReplay: string | undefined;
const mockReplace = jest.fn<void, [unknown]>();
jest.mock('expo-router', () => ({
  router: { replace: (href: unknown) => mockReplace(href) },
  useLocalSearchParams: () => ({ replay: mockReplay }),
}));

const mockOpenWelcomeSession = jest.fn<Promise<WelcomeSession>, []>();
let mockClient: VerityClient | null = null;
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockClient,
}));

import OnboardingStarter from '../app/onboarding/starter';

const ready: WelcomeSession = { state: 'ready', sessionId: 's-welcome', projectId: 'p1' };
const preparing: WelcomeSession = { state: 'preparing', sessionId: null, projectId: 'p1' };

beforeEach(() => {
  jest.useFakeTimers();
  mockReplay = undefined;
  mockReplace.mockClear();
  mockOpenWelcomeSession.mockReset();
  mockClient = { openWelcomeSession: mockOpenWelcomeSession } as unknown as VerityClient;
});
afterEach(() => {
  jest.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

it('opens the welcome session as soon as it is ready', async () => {
  mockOpenWelcomeSession.mockResolvedValueOnce(ready);
  render(<OnboardingStarter />);
  await flush();
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/session/[id]',
    params: { id: 's-welcome' },
  });
});

it('waits while the starter project is preparing, then opens the session', async () => {
  mockOpenWelcomeSession.mockResolvedValueOnce(preparing).mockResolvedValueOnce(ready);
  render(<OnboardingStarter />);
  await flush();
  expect(screen.getByText('Preparing your starter project…')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();

  await act(async () => {
    jest.advanceTimersByTime(2_000);
  });
  await flush();
  expect(mockOpenWelcomeSession).toHaveBeenCalledTimes(2);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/session/[id]',
    params: { id: 's-welcome' },
  });
});

it('lets the operator skip to the home screen while preparing', async () => {
  mockOpenWelcomeSession.mockResolvedValue(preparing);
  render(<OnboardingStarter />);
  await flush();
  fireEvent.press(screen.getByLabelText('Skip'));
  expect(mockReplace).toHaveBeenCalledWith('/');
});

it.each<[string, () => void]>([
  [
    'there is no starter project',
    () =>
      mockOpenWelcomeSession.mockResolvedValueOnce({
        state: 'none',
        sessionId: null,
        projectId: null,
      }),
  ],
  [
    'the session could not be created',
    () =>
      mockOpenWelcomeSession.mockResolvedValueOnce({
        state: 'failed',
        sessionId: null,
        projectId: 'p1',
      }),
  ],
  [
    'the server does not know the endpoint',
    () => mockOpenWelcomeSession.mockRejectedValueOnce(new Error('404')),
  ],
])('goes to the home screen when %s', async (_case, arrange) => {
  arrange();
  render(<OnboardingStarter />);
  await flush();
  expect(mockReplace).toHaveBeenCalledWith('/');
});

it('stops polling once the screen is gone', async () => {
  mockOpenWelcomeSession.mockResolvedValue(preparing);
  const view = render(<OnboardingStarter />);
  await flush();
  view.unmount();
  await act(async () => {
    jest.advanceTimersByTime(10_000);
  });
  expect(mockOpenWelcomeSession).toHaveBeenCalledTimes(1);
  expect(mockReplace).not.toHaveBeenCalled();
});

it('offers a retry on explicit replay failure without leaving the screen', async () => {
  mockReplay = '1';
  mockOpenWelcomeSession
    .mockResolvedValueOnce({ state: 'failed', sessionId: null, projectId: 'p1' })
    .mockResolvedValueOnce(ready);
  render(<OnboardingStarter />);
  await flush();
  expect(mockOpenWelcomeSession).toHaveBeenCalledWith({ replay: true, retry: true });
  expect(mockReplace).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Try again'));
  await flush();
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/session/[id]',
    params: { id: 's-welcome' },
  });
});

it('polls replay without refreshing its retry budget', async () => {
  mockReplay = '1';
  mockOpenWelcomeSession.mockResolvedValueOnce(preparing).mockResolvedValueOnce(ready);
  render(<OnboardingStarter />);
  await flush();
  await act(async () => {
    jest.advanceTimersByTime(2_000);
  });
  expect(mockOpenWelcomeSession).toHaveBeenNthCalledWith(2, { replay: true, retry: false });
});
