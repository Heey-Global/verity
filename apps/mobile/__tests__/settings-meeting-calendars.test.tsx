import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CalendarWatch, VerityClient } from '@verity/mobile';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
import MeetingCalendarsScreen from '../app/settings/meeting-calendars';
import { mockCreateVerityClient, resetSettingsHarness } from './support/settingsHarness';

afterEach(() => resetSettingsHarness());

const watch = (watched: boolean, autoJoin = false): CalendarWatch => ({
  retentionDays: 7,
  accounts: [
    {
      id: 'work',
      email: 'you@company.com',
      displayName: 'Work',
      access: 'ok',
      calendars: [{ id: 'you@company.com', summary: 'Work', primary: true, watched, autoJoin }],
    },
    {
      id: 'home',
      email: 'me@home.example',
      displayName: null,
      access: 'missing_scope',
      calendars: [],
    },
  ],
});

function client(initial: CalendarWatch) {
  const methods = {
    getCalendarWatch: jest.fn().mockResolvedValue(initial),
    setCalendarWatch: jest.fn().mockResolvedValue(undefined),
    updateVeritySettings: jest.fn().mockResolvedValue({}),
  };
  mockCreateVerityClient.mockReturnValue(methods as unknown as VerityClient);
  return methods;
}

it('offers automatic joining only for a watched calendar', async () => {
  const methods = client(watch(false));
  render(<MeetingCalendarsScreen />);
  await screen.findByText('Work · you@company.com');
  expect(screen.getByText('No Calendar access')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: /Join automatically/ })).toBeNull();
  methods.getCalendarWatch.mockResolvedValue(watch(true));
  fireEvent(screen.getByRole('switch', { name: /Watch for meetings/ }), 'valueChange', true);
  await waitFor(() =>
    expect(methods.setCalendarWatch).toHaveBeenCalledWith({
      accountId: 'work',
      calendarId: 'you@company.com',
      watched: true,
      autoJoin: false,
    }),
  );
  await screen.findByRole('switch', { name: /Join automatically/ });
});

// Turning watching off must not leave automatic joining armed for the next time it is on.
it('clears automatic joining when watching stops', async () => {
  const methods = client(watch(true, true));
  render(<MeetingCalendarsScreen />);
  const toggle = await screen.findByRole('switch', { name: /Watch for meetings/ });
  fireEvent(toggle, 'valueChange', false);
  await waitFor(() =>
    expect(methods.setCalendarWatch).toHaveBeenCalledWith({
      accountId: 'work',
      calendarId: 'you@company.com',
      watched: false,
      autoJoin: false,
    }),
  );
});

it('changes how long unassigned meetings are kept', async () => {
  const methods = client(watch(false));
  render(<MeetingCalendarsScreen />);
  fireEvent.press(await screen.findByRole('button', { name: /Keep for, 7 days/ }));
  fireEvent.press(screen.getByRole('radio', { name: '30 days' }));
  await waitFor(() =>
    expect(methods.updateVeritySettings).toHaveBeenCalledWith({
      unassignedMeetingRetentionDays: 30,
    }),
  );
});

// Reloading after a failed save snaps the switch back; without the reason it looks ignored.
it('keeps the reason a change could not be saved', async () => {
  const methods = client(watch(false));
  methods.setCalendarWatch.mockRejectedValueOnce(new Error('Calendar access was revoked.'));
  render(<MeetingCalendarsScreen />);
  await screen.findByText('Work · you@company.com');
  fireEvent(screen.getByRole('switch', { name: /Watch for meetings/ }), 'valueChange', true);
  await waitFor(() => expect(methods.getCalendarWatch).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/Calendar access was revoked\./)).toBeTruthy();
});
