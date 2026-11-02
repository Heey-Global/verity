import { AppState } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router, usePathname } from 'expo-router';
import {
  createVerityClient,
  getActiveMeetingServerId,
  subscribeVerityBaseUrl,
} from '../lib/client';
import { listMeetings } from '../lib/liveMeetingStore';
import { followRemoteMeeting, subscribeFollowedRemoteMeeting } from '../lib/liveMeetingSync';

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
  followRemoteMeeting: jest.fn(),
  syncMeetingSession: jest.fn().mockResolvedValue({ pending: false }),
  clearFollowedRemoteMeeting: jest.fn(),
}));
jest.mock('../lib/client', () => ({
  createVerityClient: jest.fn().mockReturnValue(null),
  subscribeVerityBaseUrl: jest.fn().mockReturnValue(jest.fn()),
  getActiveMeetingServerId: jest.fn().mockReturnValue('server-1'),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
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

const discoveredMeeting: MeetingRecord = {
  id: 'discovered',
  sessionId: 'other-session',
  serverId: 'server-1',
  engine: 'fluid-nemotron',
  startedAt: Date.now(),
  endedAt: null,
  state: 'active',
  captureStatus: 'listening',
  transcript: '',
  error: null,
};

it.each(['fluid-nemotron', 'attendee'] as const)(
  'discovers %s without opening its session',
  async (engine) => {
    jest.mocked(usePathname).mockReturnValue('/');
    jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
    jest.mocked(subscribeMeeting).mockImplementation((listener) => {
      listener(null);
      return jest.fn();
    });
    let notify!: Parameters<typeof subscribeFollowedRemoteMeeting>[0];
    jest.mocked(subscribeFollowedRemoteMeeting).mockImplementation((listener) => {
      notify = listener;
      listener(null);
      return jest.fn();
    });
    jest.mocked(followRemoteMeeting).mockImplementation((sessionId, meetingId) => {
      notify({ serverId: 'server-1', sessionId, meetingId });
    });
    jest.mocked(listMeetings).mockResolvedValue([{ ...discoveredMeeting, engine }]);
    const stopOnlineMeeting = jest.fn().mockResolvedValue(undefined);
    const discovery = jest
      .fn()
      .mockResolvedValue([{ id: 'discovered', sessionId: 'other-session' }]);
    const foreground = jest.spyOn(AppState, 'addEventListener');
    jest.mocked(createVerityClient).mockReturnValue({
      getActiveLiveMeetings: discovery,
      getLiveMeetingCommands: jest.fn().mockResolvedValue({ commands: [], recorderOnline: true }),
      stopOnlineMeeting,
    } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
    render(<ActiveMeetingOverlay />);
    await screen.findByLabelText('Return to live meeting');
    expect(followRemoteMeeting).toHaveBeenCalledWith('other-session', 'discovered');
    fireEvent.press(screen.getByLabelText('Return to live meeting'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/meeting/[sessionId]',
      params: { sessionId: 'other-session' },
    });
    if (engine === 'attendee') {
      expect(screen.getByLabelText('Pause meeting')).toBeDisabled();
      await act(async () => fireEvent.press(screen.getByLabelText('Stop meeting')));
      expect(stopOnlineMeeting).toHaveBeenCalledWith('other-session', 'discovered');
    }
    if (engine !== 'attendee') {
      discovery.mockResolvedValue([]);
      await act(async () => {
        foreground.mock.calls.at(-1)![1]('active');
      });
      expect(screen.queryByLabelText('Return to live meeting')).toBeNull();
    }
    const switchServer = jest.mocked(subscribeVerityBaseUrl).mock.calls.at(-1)![0];
    jest.mocked(getActiveMeetingServerId).mockReturnValue('server-2');
    jest.mocked(createVerityClient).mockReturnValue(null);
    act(() => switchServer());
    expect(screen.queryByLabelText('Return to live meeting')).toBeNull();
  },
);

it('ignores discovery from the previous server after switching', async () => {
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-1');
  jest.mocked(subscribeMeeting).mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  });
  jest.mocked(subscribeFollowedRemoteMeeting).mockImplementation((listener) => {
    listener(null);
    return jest.fn();
  });
  let finish!: (meetings: Array<{ id: string; sessionId: string }>) => void;
  const response = new Promise<Array<{ id: string; sessionId: string }>>((resolve) => {
    finish = resolve;
  });
  jest.mocked(createVerityClient).mockReturnValue({
    getActiveLiveMeetings: jest.fn().mockReturnValue(response),
  } as unknown as NonNullable<ReturnType<typeof createVerityClient>>);
  render(<ActiveMeetingOverlay />);
  jest.mocked(getActiveMeetingServerId).mockReturnValue('server-2');
  jest.mocked(createVerityClient).mockReturnValue(null);
  act(() => jest.mocked(subscribeVerityBaseUrl).mock.calls.at(-1)![0]());
  await act(async () => finish([{ id: 'old', sessionId: 'old-session' }]));
  expect(followRemoteMeeting).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Return to live meeting')).toBeNull();
});
