import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { createVerityClient } from '../lib/client';
import { listMeetings } from '../lib/liveMeetingStore';
import { subscribeFollowedRemoteMeeting } from '../lib/liveMeetingSync';

import { ActiveMeetingOverlay } from './ActiveMeetingOverlay';
import {
  endMeeting,
  pauseMeeting,
  resumeMeeting,
  subscribeMeeting,
} from '../lib/liveMeetingSession';
import type { MeetingRecord } from '../lib/liveMeetingStore';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  usePathname: () => '/session/session-1',
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
}));
jest.mock('../lib/client', () => ({
  createVerityClient: jest.fn().mockReturnValue(null),
  getActiveMeetingServerId: jest.fn().mockReturnValue('server-1'),
}));

beforeEach(() => {
  jest.clearAllMocks();
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
