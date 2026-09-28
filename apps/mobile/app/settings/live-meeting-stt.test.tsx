import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import LiveMeetingSTTScreen from './live-meeting-stt';
import { liveMeetingSTT, type STTEvent } from '../../lib/liveMeetingSTT';

jest.mock('../../components/settings/SettingsChrome', () => ({
  SettingsScaffold: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../../lib/liveMeetingSTT', () => ({
  liveMeetingSTT: {
    engines: jest
      .fn()
      .mockResolvedValue([
        { id: 'apple-dictation', name: 'Apple DictationTranscriber', available: true },
      ]),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn(),
  },
}));

it('allows a fresh test after capture fails', async () => {
  const native = liveMeetingSTT!;
  let onEvent!: (event: STTEvent) => void;
  jest.mocked(native.addListener).mockImplementation((_name, listener) => {
    onEvent = listener;
    return { remove: jest.fn() };
  });

  render(<LiveMeetingSTTScreen />);
  await screen.findByText('Apple DictationTranscriber');
  fireEvent.press(screen.getByText('Apple DictationTranscriber'));
  fireEvent.press(screen.getByText('Start test'));
  act(() => onEvent({ kind: 'status', state: 'listening' }));
  await screen.findByText('Stop test');

  act(() => onEvent({ kind: 'status', state: 'failed', message: 'Audio conversion failed.' }));
  expect(screen.getByText('Start test')).toBeOnTheScreen();
  fireEvent.press(screen.getByText('Start test'));
  await waitFor(() => expect(native.start).toHaveBeenCalledTimes(2));
});
