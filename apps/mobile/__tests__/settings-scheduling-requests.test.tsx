import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { SchedulingRequestView, VerityClient } from '@verity/mobile';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
import SchedulingRequestsScreen from '../app/settings/scheduling-requests';
import { mockCreateVerityClient, resetSettingsHarness } from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

const request = (overrides: Partial<SchedulingRequestView>): SchedulingRequestView => ({
  id: 'r1',
  sessionId: 'deleted-session',
  state: 'open',
  title: 'Intro call',
  durationMinutes: 30,
  addGoogleMeet: false,
  timeZone: 'Europe/Berlin',
  guest: { email: 'anna@example.test', name: 'Anna' },
  colleagues: [],
  closesAt: '2099-11-06T10:00:00.000Z',
  windows: [
    { start: '2099-11-03T13:00:00.000Z', end: '2099-11-03T15:00:00.000Z', state: 'active' },
  ],
  emailSentAt: null,
  booked: null,
  failure: null,
  pendingCleanups: 0,
  link: 'https://x.preview.example.test/?pin=123456',
  createdAt: '2099-10-30T10:00:00.000Z',
  ...overrides,
});

it('lists requests by state and withdraws one whose chat is gone', async () => {
  const revokeSchedulingRequest = jest.fn().mockResolvedValue(undefined);
  mockCreateVerityClient.mockReturnValue({
    schedulingRequests: jest.fn().mockResolvedValue([
      request({}),
      request({
        id: 'r2',
        guest: { email: 'ben@example.test', name: 'Ben' },
        pendingCleanups: 1,
        state: 'expired',
      }),
      request({
        id: 'r3',
        guest: { email: 'eva@example.test', name: 'Eva' },
        state: 'revoked',
        link: null,
      }),
    ]),
    revokeSchedulingRequest,
  } as unknown as VerityClient);
  render(<SchedulingRequestsScreen />);
  await screen.findByText('Needs attention');
  // The group header and Anna's status both read Open.
  expect(screen.getAllByText('Open')).toHaveLength(2);
  expect(screen.getByText('Recent')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: /Anna · Intro call/ }));
  fireEvent.press(await screen.findByRole('button', { name: /Withdraw request/ }));
  await screen.findByText('Withdraw the request for Anna?');
  expect(revokeSchedulingRequest).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Withdraw' }));
  await waitFor(() => expect(revokeSchedulingRequest).toHaveBeenCalledWith('r1'));
});
