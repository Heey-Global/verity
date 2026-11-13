import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
import type { VerityClient } from '@verity/mobile';

import { AiAccountsView } from '../app/settings/ai-accounts';
import { ConnectProviderView } from '../app/settings/ai-accounts/connect';
import { OpenCodeAccountView } from '../app/settings/ai-accounts/opencode';
import { mockPush, resetSettingsHarness } from './support/settingsHarness';

afterEach(() => {
  resetSettingsHarness();
  jest.useRealTimers();
  jest.clearAllMocks();
});

const login = (patch: Record<string, unknown> = {}) => ({
  sessionId: 'login-1',
  provider: 'codex',
  status: 'ready',
  verificationUri: 'https://auth.openai.com/codex/device',
  userCode: 'K7QF-2MXR',
  needsCode: false,
  configured: false,
  message: null,
  ...patch,
});

// The screen lists only the signed-in person's own accounts and connects the
// missing ones; it never shows or asks for anyone else's.
it('lists the person’s own accounts and connects the missing ones', async () => {
  const client = {
    listProviderConnections: jest.fn().mockResolvedValue({
      connections: [{ provider: 'claude', baseUrl: null, models: [], updatedAt: '2026-11-13' }],
      usesInstanceLogins: false,
    }),
  } as unknown as VerityClient;
  render(<AiAccountsView client={client} />);
  expect(await screen.findByLabelText('Claude, Connected')).toBeOnTheScreen();
  expect(screen.getByText('Not connected')).toBeOnTheScreen();
  fireEvent.press(screen.getByLabelText(/^Connect(,|$)/));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/settings/ai-accounts/connect',
    params: { provider: 'codex' },
  });
  fireEvent.press(screen.getByLabelText(/^Set up(,|$)/));
  expect(mockPush).toHaveBeenCalledWith('/settings/ai-accounts/opencode');
});

it('shows the device code and finishes once the sign-in completes', async () => {
  jest.useFakeTimers();
  const done = jest.fn();
  const client = {
    startProviderConnectionLogin: jest.fn().mockResolvedValue(login()),
    getProviderConnectionLogin: jest
      .fn()
      .mockResolvedValue(login({ status: 'complete', configured: true })),
  } as unknown as VerityClient;
  render(<ConnectProviderView client={client} provider="codex" onDone={done} />);
  expect(await screen.findByText('K7QF-2MXR')).toBeOnTheScreen();
  expect(client.startProviderConnectionLogin).toHaveBeenCalledWith('codex');
  await act(async () => {
    jest.advanceTimersByTime(2_100);
  });
  await waitFor(() => expect(done).toHaveBeenCalled());
});

it('saves OpenCode only through the person’s own connection', async () => {
  const done = jest.fn();
  const client = {
    setOpenCodeConnection: jest.fn().mockResolvedValue({
      provider: 'opencode',
      baseUrl: 'https://llm.example/v1',
      models: ['m1'],
    }),
  } as unknown as VerityClient;
  render(<OpenCodeAccountView client={client} onDone={done} />);
  fireEvent.changeText(screen.getByLabelText(/^Provider address/), 'https://llm.example/v1 ');
  fireEvent.changeText(screen.getByLabelText(/^API key/), 'sk-own');
  fireEvent.press(screen.getByLabelText(/^Connect(,|$)/));
  await waitFor(() => expect(done).toHaveBeenCalled());
  expect(client.setOpenCodeConnection).toHaveBeenCalledWith({
    baseUrl: 'https://llm.example/v1',
    apiKey: 'sk-own',
  });
});
