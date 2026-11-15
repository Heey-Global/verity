import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { finalizeMeetingOnServer } from '../../lib/liveMeetingSync';
import type { MeetingRecord } from '../../lib/liveMeetingStore';
import { MeetingRecoveryCard } from './MeetingRecoveryCard';

jest.mock('../../lib/client', () => ({
  getActiveMeetingServerId: jest.fn().mockReturnValue('server-1'),
}));
jest.mock('../../lib/liveMeetingSync', () => ({
  finalizeMeetingOnServer: jest.fn().mockResolvedValue(undefined),
  retryMeetingSync: jest.fn().mockResolvedValue(undefined),
}));

const meeting: MeetingRecord = {
  id: 'meeting-1',
  sessionId: 'session-1',
  serverId: 'server-1',
  engine: 'fluid-nemotron',
  startedAt: Date.now() - 3600_000,
  endedAt: null,
  state: 'active',
  captureStatus: 'listening',
  transcript: 'Words',
  error: null,
};
const props = {
  meeting,
  live: true,
  recordingHere: false,
  recorderOnline: false,
  pendingCommand: null,
  syncFailure: null,
  onRecovered: jest.fn().mockResolvedValue(undefined),
  onError: jest.fn(),
};
const endLabel = 'End without recording device';

beforeEach(() => jest.clearAllMocks());

// The meeting screen showed "Recording device unreachable" with only a Stop that the
// absent recorder had to confirm, so a meeting whose recorder was gone ran forever.
it('ends a meeting with an unreachable recorder on the server only after confirmation', async () => {
  render(<MeetingRecoveryCard {...props} />);
  await act(async () => fireEvent.press(screen.getByText(endLabel)));
  expect(finalizeMeetingOnServer).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByText('End meeting')));
  expect(finalizeMeetingOnServer).toHaveBeenCalledWith('session-1', 'meeting-1');
  expect(props.onRecovered).toHaveBeenCalled();
});

it('also offers it while a stop waits for a recorder that still reports', () => {
  render(<MeetingRecoveryCard {...props} recorderOnline pendingCommand="stop" />);
  expect(screen.getByText(endLabel)).toBeOnTheScreen();
});

it('reports a failed server end instead of claiming the meeting ended', async () => {
  jest.mocked(finalizeMeetingOnServer).mockRejectedValueOnce(new Error('Server unavailable.'));
  render(<MeetingRecoveryCard {...props} />);
  await act(async () => fireEvent.press(screen.getByText(endLabel)));
  await act(async () => fireEvent.press(screen.getByText('End meeting')));
  expect(props.onError).toHaveBeenLastCalledWith('Server unavailable.');
  expect(props.onRecovered).not.toHaveBeenCalled();
});

it.each([
  ['the recorder reports', { recorderOnline: true }],
  ['this device records it', { recordingHere: true }],
  ['it is an online meeting', { meeting: { ...meeting, engine: 'attendee' as const } }],
  ['it belongs to another server', { meeting: { ...meeting, serverId: 'server-2' } }],
  ['it has ended', { meeting: { ...meeting, state: 'ended' as const } }],
])('does not offer a server end when %s', (_case, override) => {
  render(<MeetingRecoveryCard {...props} {...override} />);
  expect(screen.queryByText(endLabel)).toBeNull();
});
