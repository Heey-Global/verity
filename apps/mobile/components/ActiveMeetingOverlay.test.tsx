import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

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
