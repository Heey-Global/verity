import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router, usePathname } from 'expo-router';
import { createVerityClient } from '../lib/client';
import { listMeetings } from '../lib/liveMeetingStore';
import { subscribeFollowedRemoteMeeting } from '../lib/liveMeetingSync';
import { requestMeetingPrompt } from '../lib/meetingPrompts';

import { ActiveMeetingOverlay } from './ActiveMeetingOverlay';
import {
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  subscribeMeeting,
  subscribeVoiceMeetingRequest,
} from '../lib/liveMeetingSession';
import type { MeetingRecord } from '../lib/liveMeetingStore';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  usePathname: jest.fn().mockReturnValue('/session/session-1'),
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
jest.mock('../lib/liveMeetingSession', () => ({
  subscribeMeeting: jest.fn(),
  subscribeVoiceMeetingRequest: jest.fn().mockReturnValue(jest.fn()),
  pauseMeeting: jest.fn().mockResolvedValue(undefined),
  resumeMeeting: jest.fn().mockResolvedValue(undefined),
  endMeeting: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/liveMeetingStore', () => ({ listMeetings: jest.fn().mockResolvedValue([]) }));
jest.mock('../lib/liveMeetingSync', () => ({
  subscribeFollowedRemoteMeeting: jest.fn().mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  }),
  syncMeetingSession: jest.fn().mockResolvedValue({ pending: false }),
  clearFollowedRemoteMeeting: jest.fn(),
  followRemoteMeeting: jest.fn(),
}));
jest.mock('../lib/client', () => ({
  createVerityClient: jest.fn().mockReturnValue(null),
  getActiveMeetingServerId: jest.fn().mockReturnValue('server-1'),
  subscribeVerityBaseUrl: jest.fn().mockReturnValue(jest.fn()),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(usePathname).mockReturnValue('/session/session-1');
  jest.mocked(subscribeVoiceMeetingRequest).mockReturnValue(jest.fn());
});

it('pauses, resumes, and opens the full meeting after stopping', async () => {
  const meeting: MeetingRecord = {
    id: 'meeting-1',
    sessionId: 'session-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: '',
    error: null,
  };
  let notify!: (meeting: MeetingRecord | null) => void;
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    notify = listener;
    listener(meeting);
    return jest.fn();
  });
  render(<ActiveMeetingOverlay />);

  await act(async () => fireEvent.press(screen.getByLabelText('Pause meeting')));
  expect(pauseMeeting).toHaveBeenCalledTimes(1);
  act(() => notify({ ...meeting, captureStatus: 'paused' }));
  await act(async () => fireEvent.press(screen.getByLabelText('Resume meeting')));
  expect(resumeMeeting).toHaveBeenCalledTimes(1);
  await act(async () => fireEvent.press(screen.getByLabelText('Stop meeting')));
  expect(endMeeting).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/meeting/[sessionId]',
    params: { sessionId: 'session-1' },
  });
});

it('keeps the spoken request in the meeting instead of opening the session', () => {
  jest.mocked(usePathname).mockReturnValue('/');
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    listener({
      id: 'meeting-1',
      sessionId: 'session-1',
      engine: 'fluid-nemotron',
      startedAt: Date.now(),
      endedAt: null,
      state: 'active',
      captureStatus: 'listening',
      transcript: '',
      error: null,
    });
    return jest.fn();
  });
  let notify!: (event: { meetingId: string; sessionId: string; status: 'sent' }) => void;
  jest.mocked(subscribeVoiceMeetingRequest).mockImplementation((listener) => {
    notify = listener;
    return jest.fn();
  });
  render(<ActiveMeetingOverlay />);
  act(() => notify({ meetingId: 'meeting-1', sessionId: 'session-1', status: 'sent' }));
  act(() => notify({ meetingId: 'meeting-1', sessionId: 'session-1', status: 'sent' }));
  expect(router.push).not.toHaveBeenCalled();
  expect(screen.getByText('Answer will appear in the meeting')).toBeOnTheScreen();
});

it.each([
  ['Pause meeting', 'pause'],
  ['Stop meeting', 'stop'],
] as const)('sends remote %s from the minimized window', async (button, action) => {
  const meeting: MeetingRecord = {
    id: 'remote-1',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'fluid-nemotron',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: '',
    error: null,
  };
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  });
  jest.mocked(subscribeFollowedRemoteMeeting).mockImplementation((listener) => {
    listener({ serverId: 'server-1', sessionId: 'session-1', meetingId: meeting.id });
    return jest.fn();
  });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  const requestLiveMeetingCommand = jest.fn().mockResolvedValue('command-1');
  jest.mocked(createVerityClient).mockReturnValue({
    getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
    requestLiveMeetingCommand,
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<ActiveMeetingOverlay />);
  const control = await screen.findByLabelText(button);
  await act(async () => {
    fireEvent.press(control);
  });
  expect(requestLiveMeetingCommand).toHaveBeenCalledWith('session-1', meeting.id, action);
  expect(pauseMeeting).not.toHaveBeenCalled();
  expect(endMeeting).not.toHaveBeenCalled();
});

const noLocalMeeting = () => {
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  });
  jest.mocked(subscribeFollowedRemoteMeeting).mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  });
};
const activeMeetings = (overrides: Record<string, unknown>) => ({
  running: [],
  unassigned: [],
  retentionDays: 7,
  ...overrides,
});

it('follows a meeting the server reports running without opening its session first', async () => {
  noLocalMeeting();
  jest.mocked(createVerityClient).mockReturnValue({
    getActiveLiveMeetings: jest.fn().mockResolvedValue(
      activeMeetings({
        running: [
          {
            sessionId: 'session-9',
            id: 'online-1',
            title: 'Weekly sync',
            engine: 'attendee',
            startedAt: Date.now(),
            state: 'active',
            captureStatus: 'listening',
            sessionName: 'Weekly sync',
            projectId: 'website',
          },
        ],
      }),
    ),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  const { followRemoteMeeting } = jest.requireMock('../lib/liveMeetingSync');
  render(<ActiveMeetingOverlay />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(followRemoteMeeting).toHaveBeenCalledWith('session-9', 'online-1');
});

it('stops a followed online meeting on the server instead of commanding a recorder', async () => {
  const meeting: MeetingRecord = {
    id: 'online-1',
    sessionId: 'session-1',
    serverId: 'server-1',
    engine: 'attendee',
    title: 'Weekly sync',
    startedAt: Date.now(),
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    transcript: '',
    error: null,
  };
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  });
  jest.mocked(subscribeFollowedRemoteMeeting).mockImplementation((listener) => {
    listener({ serverId: 'server-1', sessionId: 'session-1', meetingId: meeting.id });
    return jest.fn();
  });
  jest.mocked(listMeetings).mockResolvedValue([meeting]);
  const stopOnlineMeeting = jest.fn().mockResolvedValue(undefined);
  const requestLiveMeetingCommand = jest.fn();
  jest.mocked(createVerityClient).mockReturnValue({
    getActiveLiveMeetings: jest.fn().mockResolvedValue(activeMeetings({})),
    getLiveMeetingCommands: jest.fn(),
    requestLiveMeetingCommand,
    stopOnlineMeeting,
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<ActiveMeetingOverlay />);
  expect(await screen.findByText('Weekly sync')).toBeOnTheScreen();
  // An online meeting has no pause; the card opens it instead.
  expect(screen.queryByLabelText('Pause meeting')).toBeNull();
  await act(async () => fireEvent.press(screen.getByLabelText('Open live meeting')));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/meeting/[sessionId]',
    params: { sessionId: 'session-1' },
  });
  await act(async () => fireEvent.press(screen.getByLabelText('Stop meeting')));
  expect(stopOnlineMeeting).toHaveBeenCalledWith('session-1', 'online-1');
  expect(requestLiveMeetingCommand).not.toHaveBeenCalled();
});

describe('a meeting without a project', () => {
  const unassignedMeeting = {
    id: 'unassigned-1',
    title: 'Design review',
    startedAt: Date.now() - 4 * 60_000,
    endedAt: null,
    state: 'active',
    captureStatus: 'listening',
    people: 3,
  };
  const client = (extra: Record<string, unknown>) => {
    const value = {
      getActiveLiveMeetings: jest
        .fn()
        .mockResolvedValue(activeMeetings({ unassigned: [unassignedMeeting] })),
      listProjects: jest.fn().mockResolvedValue([
        { id: 'p-web', owner: 'acme', repo: 'website', kind: 'github' },
        { id: 'p-verity', owner: 'acme', repo: 'verity', kind: 'github' },
        { id: 'p-control', owner: 'local', repo: 'control', kind: 'control_plane' },
      ]),
      listSessions: jest.fn().mockResolvedValue([
        { sessionId: 's1', projectId: 'p-web', name: 'Contact form' },
        { sessionId: 's2', projectId: 'p-verity', name: 'Fix login' },
      ]),
      ...extra,
    };
    jest
      .mocked(createVerityClient)
      .mockReturnValue(value as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    return value;
  };

  it('assigns it to the tapped project and opens the meeting there', async () => {
    noLocalMeeting();
    const assignLiveMeeting = jest
      .fn()
      .mockResolvedValue({ sessionId: 'new-session', meetingId: 'unassigned-1' });
    client({ assignLiveMeeting });
    render(<ActiveMeetingOverlay />);
    expect(await screen.findByText('Not in a project yet')).toBeOnTheScreen();
    await act(async () => fireEvent.press(screen.getByLabelText('Assign meeting to a project')));
    // Most recently used first; the control project is never a destination.
    const rows = await screen.findAllByText(/^(website|verity|control)$/);
    expect(rows.map((row) => row.props.children)).toEqual(['verity', 'website']);
    await act(async () => fireEvent.press(screen.getByText('website')));
    expect(assignLiveMeeting).toHaveBeenCalledWith('unassigned-1', { projectId: 'p-web' });
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/meeting/[sessionId]',
      params: { sessionId: 'new-session' },
    });
  });

  it('discards it only after confirmation', async () => {
    noLocalMeeting();
    const discardLiveMeeting = jest.fn().mockResolvedValue(undefined);
    client({ discardLiveMeeting });
    render(<ActiveMeetingOverlay />);
    const discard = await screen.findByLabelText('Discard meeting');
    await act(async () => fireEvent.press(discard));
    expect(discardLiveMeeting).not.toHaveBeenCalled();
    expect(screen.getByText('Discard this meeting?')).toBeOnTheScreen();
    const confirmButtons = screen.getAllByText('Discard');
    await act(async () => fireEvent.press(confirmButtons[confirmButtons.length - 1]!));
    expect(discardLiveMeeting).toHaveBeenCalledWith('unassigned-1');
  });
});

describe('a tapped calendar meeting notification', () => {
  const upcoming = {
    eventKey: 'k1',
    title: 'Weekly sync',
    startsAt: Date.now() + 5 * 60_000,
    endsAt: Date.now() + 35 * 60_000,
    calendar: 'Work',
    provider: 'meet',
    decision: null,
    meetingId: null,
  };

  it('asks whether to join and joins without a project', async () => {
    noLocalMeeting();
    const joinCalendarMeeting = jest.fn().mockResolvedValue({ meetingId: 'm1' });
    const getActiveLiveMeetings = jest.fn().mockResolvedValue(activeMeetings({}));
    jest.mocked(createVerityClient).mockReturnValue({
      getActiveLiveMeetings,
      getUpcomingMeetings: jest.fn().mockResolvedValue([upcoming]),
      joinCalendarMeeting,
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    render(<ActiveMeetingOverlay />);
    act(() => requestMeetingPrompt({ kind: 'upcoming', eventKey: 'k1' }));
    expect(await screen.findByText('Weekly sync')).toBeOnTheScreen();
    const join = await screen.findByLabelText('Join meeting with Verity');
    await act(async () => fireEvent.press(join));
    expect(joinCalendarMeeting).toHaveBeenCalledWith('k1');
    // The card looks again, so the new unassigned meeting appears with Assign.
    expect(getActiveLiveMeetings.mock.calls.length).toBeGreaterThan(1);
  });

  it('opens a started meeting for assignment when it has no project yet', async () => {
    noLocalMeeting();
    jest.mocked(createVerityClient).mockReturnValue({
      getActiveLiveMeetings: jest.fn().mockResolvedValue(
        activeMeetings({
          unassigned: [
            {
              id: 'm1',
              title: 'Weekly sync',
              startedAt: Date.now(),
              endedAt: null,
              state: 'active',
              captureStatus: 'listening',
              people: 3,
            },
          ],
        }),
      ),
      listProjects: jest.fn().mockResolvedValue([]),
      listSessions: jest.fn().mockResolvedValue([]),
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    render(<ActiveMeetingOverlay />);
    await act(async () => requestMeetingPrompt({ kind: 'started', meetingId: 'm1' }));
    expect(await screen.findByText('Assign meeting')).toBeOnTheScreen();
  });

  it('opens a started meeting where it runs once it has a session', async () => {
    noLocalMeeting();
    jest.mocked(createVerityClient).mockReturnValue({
      getActiveLiveMeetings: jest.fn().mockResolvedValue(
        activeMeetings({
          running: [
            {
              sessionId: 'session-4',
              id: 'm1',
              title: 'Weekly sync',
              engine: 'attendee',
              startedAt: Date.now(),
              state: 'active',
              captureStatus: 'listening',
              sessionName: 'Weekly sync',
              projectId: 'website',
            },
          ],
        }),
      ),
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    render(<ActiveMeetingOverlay />);
    await act(async () => requestMeetingPrompt({ kind: 'started', meetingId: 'm1' }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith({
        pathname: '/meeting/[sessionId]',
        params: { sessionId: 'session-4' },
      }),
    );
  });
});

describe('discovering meetings on the server', () => {
  const running = {
    sessionId: 'session-9',
    id: 'online-1',
    title: 'Weekly sync',
    engine: 'attendee',
    startedAt: Date.now(),
    state: 'active',
    captureStatus: 'listening',
    sessionName: 'Weekly sync',
    projectId: 'website',
  };

  // The local copy may not have arrived yet; clearing the follow would make discovery
  // follow the same meeting again at once, over and over.
  it('keeps following a meeting this device has not synced yet', async () => {
    jest.mocked(subscribeMeeting).mockImplementation((listener) => {
      listener(null);
      return jest.fn();
    });
    let notifyFollowed!: (value: unknown) => void;
    jest.mocked(subscribeFollowedRemoteMeeting).mockImplementation((listener) => {
      notifyFollowed = listener as (value: unknown) => void;
      listener(null);
      return jest.fn();
    });
    const sync = jest.requireMock('../lib/liveMeetingSync');
    sync.followRemoteMeeting.mockImplementation((sessionId: string, meetingId: string) =>
      notifyFollowed({ serverId: 'server-1', sessionId, meetingId }),
    );
    jest.mocked(listMeetings).mockResolvedValue([]);
    jest.mocked(createVerityClient).mockReturnValue({
      getActiveLiveMeetings: jest.fn().mockResolvedValue(activeMeetings({ running: [running] })),
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    render(<ActiveMeetingOverlay />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(sync.followRemoteMeeting).toHaveBeenCalledTimes(1);
    expect(sync.clearFollowedRemoteMeeting).not.toHaveBeenCalled();
  });

  it('lets go of an unsynced meeting the server no longer runs', async () => {
    jest.mocked(subscribeMeeting).mockImplementation((listener) => {
      listener(null);
      return jest.fn();
    });
    jest.mocked(subscribeFollowedRemoteMeeting).mockImplementation((listener) => {
      listener({ serverId: 'server-1', sessionId: 'session-9', meetingId: 'online-1' });
      return jest.fn();
    });
    const sync = jest.requireMock('../lib/liveMeetingSync');
    jest.mocked(listMeetings).mockResolvedValue([]);
    jest.mocked(createVerityClient).mockReturnValue({
      getActiveLiveMeetings: jest.fn().mockResolvedValue(activeMeetings({})),
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    render(<ActiveMeetingOverlay />);
    // Otherwise a follow that never syncs keeps the card from following any later meeting.
    await waitFor(() => expect(sync.clearFollowedRemoteMeeting).toHaveBeenCalled());
  });

  it('asks the new server after switching servers', async () => {
    jest.mocked(subscribeMeeting).mockImplementation((listener) => {
      listener(null);
      return jest.fn();
    });
    let switchServer!: () => void;
    const { subscribeVerityBaseUrl } = jest.requireMock('../lib/client');
    subscribeVerityBaseUrl.mockImplementation((listener: () => void) => {
      switchServer = listener;
      return jest.fn();
    });
    const first = jest.fn().mockResolvedValue(activeMeetings({}));
    const second = jest.fn().mockResolvedValue(activeMeetings({}));
    jest
      .mocked(createVerityClient)
      .mockReturnValueOnce({ getActiveLiveMeetings: first } as never)
      .mockReturnValue({ getActiveLiveMeetings: second } as never);
    render(<ActiveMeetingOverlay />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(first).toHaveBeenCalled();
    act(() => switchServer());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(second).toHaveBeenCalled();
  });
});
