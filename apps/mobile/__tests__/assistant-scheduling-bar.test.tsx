import { fireEvent, render, screen } from '@testing-library/react-native';
import type { SchedulingRequestView, VerityClient } from '@verity/mobile';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import {
  AssistantSchedulingBar,
  AssistantSchedulingOverview,
  openSchedulingDetail,
  openSchedulingItems,
} from '../components/AssistantSchedulingBar';

const NOW = Date.parse('2099-11-01T10:00:00Z');
const DAY = 86_400_000;

const request = (overrides: Partial<SchedulingRequestView> = {}): SchedulingRequestView => ({
  id: 'r1',
  sessionId: 's1',
  projectId: 'p1',
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
  emailSentAt: new Date(NOW - 2 * DAY).toISOString(),
  booked: null,
  failure: null,
  pendingCleanups: 0,
  link: null,
  createdAt: new Date(NOW - 2 * DAY).toISOString(),
  ...overrides,
});

it('lists only open requests, the one waiting longest first', () => {
  const items = [
    { request: request({ id: 'new', emailSentAt: new Date(NOW).toISOString() }), project: null },
    { request: request({ id: 'old' }), project: null },
    { request: request({ id: 'booked', state: 'booked' }), project: null },
    { request: request({ id: 'gone', state: 'revoked' }), project: null },
  ];
  expect(openSchedulingItems(items).map(({ request }) => request.id)).toEqual(['old', 'new']);
});

it('says how long a request waits and when no time is left to pick', () => {
  expect(openSchedulingDetail(request(), NOW)).toMatch(/^Waiting 2 days · closes /u);
  expect(
    openSchedulingDetail(
      request({
        emailSentAt: new Date(NOW).toISOString(),
        windows: [{ start: '', end: '', state: 'cancelled' }],
      }),
      NOW,
    ),
  ).toMatch(/^Sent today · no times left · closes /u);
});

it('stays hidden while nothing is open', () => {
  render(
    <AssistantSchedulingBar
      items={[{ request: request({ state: 'booked' }), project: null }]}
      now={NOW}
    />,
  );
  expect(screen.queryByText(/open scheduling request/u)).toBeNull();
});

it('shows one line and the open requests with their project on demand', async () => {
  render(
    <AssistantSchedulingBar
      items={[
        { request: request(), project: 'Shop' },
        {
          request: request({ id: 'r2', guest: { email: 'ben@example.test', name: null } }),
          project: null,
        },
      ]}
      now={NOW}
    />,
  );
  expect(screen.getByText('2 open scheduling requests')).toBeTruthy();
  expect(screen.getByText('Anna, ben@example.test')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('2 open scheduling requests: Anna, ben@example.test'));
  expect(await screen.findByText('Anna · Intro call')).toBeTruthy();
  expect(screen.getByText(/^Shop · Waiting 2 days/u)).toBeTruthy();
});

it('appears only in the assistant session', async () => {
  // Every session screen mounts the overview; showing it anywhere else would put other
  // projects' guests into an unrelated chat.
  const client = {
    assistantSchedulingRequests: jest
      .fn()
      .mockResolvedValue({ assistantSessionId: 'assistant', requests: [request()] }),
    listProjects: jest.fn().mockResolvedValue([{ id: 'p1', repo: 'Shop' }]),
  } as unknown as VerityClient;
  const { unmount } = render(<AssistantSchedulingOverview client={client} sessionId="other" />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(/open scheduling request/u)).toBeNull();
  unmount();
  render(<AssistantSchedulingOverview client={client} sessionId="assistant" />);
  expect(await screen.findByText('1 open scheduling request')).toBeTruthy();
});

it('leads to all requests instead of a deleted chat, and stays put for its own', async () => {
  const { mockPush } = jest.requireActual<typeof import('./support/settingsHarness')>(
    './support/settingsHarness',
  );
  render(
    <AssistantSchedulingBar
      sessionId="assistant"
      items={[
        { request: request({ id: 'gone' }), project: null, sessionAvailable: false },
        {
          request: request({
            id: 'own',
            sessionId: 'assistant',
            guest: { email: 'b@x.test', name: 'Ben' },
          }),
          project: null,
          sessionAvailable: true,
        },
      ]}
      now={NOW}
    />,
  );
  fireEvent.press(screen.getByLabelText(/open scheduling requests/u));
  fireEvent.press(await screen.findByText('Anna · Intro call'));
  expect(mockPush).toHaveBeenLastCalledWith('/settings/scheduling-requests');
  mockPush.mockClear();
  fireEvent.press(screen.getByLabelText(/open scheduling requests/u));
  fireEvent.press(await screen.findByText('Ben · Intro call'));
  expect(mockPush).not.toHaveBeenCalled();
});
