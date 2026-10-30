import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { SchedulingRequestView, VerityClient } from '@verity/mobile';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
import {
  SchedulingRequestsCard,
  visibleSchedulingRequests,
} from '../components/SchedulingRequestsCard';

const request = (overrides: Partial<SchedulingRequestView> = {}): SchedulingRequestView => ({
  id: 'r1',
  sessionId: 's1',
  state: 'open',
  title: 'Intro call',
  durationMinutes: 30,
  addGoogleMeet: true,
  timeZone: 'Europe/Berlin',
  guest: { email: 'anna@example.test', name: 'Anna' },
  colleagues: [],
  closesAt: '2099-11-06T10:00:00.000Z',
  windows: [
    { start: '2099-11-03T13:00:00.000Z', end: '2099-11-03T15:00:00.000Z', state: 'active' },
  ],
  emailSentAt: '2099-10-30T10:00:00.000Z',
  booked: null,
  failure: null,
  pendingCleanups: 0,
  link: 'https://x.preview.example.test/?pin=123456',
  createdAt: '2099-10-30T10:00:00.000Z',
  ...overrides,
});

it('withdraws an open request only after confirmation', async () => {
  const revokeSchedulingRequest = jest.fn().mockResolvedValue(undefined);
  const client = {
    sessionSchedulingRequests: jest.fn().mockResolvedValue([request()]),
    revokeSchedulingRequest,
  } as unknown as VerityClient;
  render(<SchedulingRequestsCard client={client} sessionId="s1" />);
  await screen.findByText('Anna · Intro call');
  fireEvent.press(screen.getByRole('button', { name: 'Withdraw' }));
  expect(revokeSchedulingRequest).not.toHaveBeenCalled();
  await screen.findByText('Withdraw the request for Anna?');
  const buttons = screen.getAllByRole('button', { name: 'Withdraw' });
  fireEvent.press(buttons[buttons.length - 1]!);
  await waitFor(() => expect(revokeSchedulingRequest).toHaveBeenCalledWith('r1'));
});

it('keeps running requests, problems and upcoming bookings in view, and drops closed ones', () => {
  const now = Date.parse('2099-11-01T00:00:00Z');
  expect(
    visibleSchedulingRequests(
      [
        request({ id: 'open' }),
        request({ id: 'expired', state: 'expired' }),
        request({ id: 'stuck', state: 'expired', pendingCleanups: 1 }),
        request({
          id: 'booked',
          state: 'booked',
          booked: { start: '2099-11-03T13:00:00.000Z', end: '2099-11-03T13:30:00.000Z' },
        }),
        request({
          id: 'past',
          state: 'booked',
          booked: { start: '2099-10-03T13:00:00.000Z', end: '2099-10-03T13:30:00.000Z' },
        }),
      ],
      now,
    ).map((r) => r.id),
  ).toEqual(['open', 'stuck', 'booked']);
});
