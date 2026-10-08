import { Image } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { QuickCaptureCard } from './QuickCaptureCard';
import { captureTask } from '../lib/tasksStore';
import {
  screenshotAccess,
  recentTaskScreenshot,
  previewTaskScreenshot,
  enableTaskScreenshotSuggestions,
} from '../lib/taskScreenshot';
import { useVoiceInput } from '../hooks/useVoiceInput';

jest.mock('../hooks/useVoiceInput', () => ({ useVoiceInput: jest.fn() }));
jest.mock('../lib/tasksStore', () => ({ captureTask: jest.fn() }));
jest.mock('../lib/attachments', () => ({ pickFiles: jest.fn(), pickImagesFromLibrary: jest.fn() }));
jest.mock('../lib/taskScreenshot', () => ({
  recentTaskScreenshot: jest.fn(async () => null),
  readTaskScreenshot: jest.fn(),
  screenshotAccess: jest.fn(async () => 'granted'),
  previewTaskScreenshot: jest.fn(async () => 'data:image/jpeg;base64,preview'),
  enableTaskScreenshotSuggestions: jest.fn(async () => undefined),
}));
jest.mock('../lib/taskPreferences', () => ({
  useTaskPreferences: () => ({ loaded: true, screenshots: true, screenshotPromptDismissed: false }),
  saveTaskPreferences: jest.fn(async () => undefined),
}));
const toggle = jest.fn();
const voice = {
  state: 'recording',
  toggle,
  abort: jest.fn(),
  onComposerEdit: jest.fn(),
  level: 0.4,
  onDevice: true,
  error: undefined,
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.mocked(screenshotAccess).mockResolvedValue('granted');
  jest.mocked(recentTaskScreenshot).mockResolvedValue(null);
  jest.mocked(useVoiceInput).mockReturnValue(voice as unknown as ReturnType<typeof useVoiceInput>);
  jest
    .mocked(captureTask)
    .mockResolvedValue({ id: 'saved-id' } as Awaited<ReturnType<typeof captureTask>>);
});
afterEach(() => jest.useRealTimers());
const props = {
  context: { projectId: 'p', sessionId: 's' },
  projects: [],
  onClose: jest.fn(),
  onSaved: jest.fn(),
};
it('never saves on its own; Save stores the text after dictation ends', async () => {
  const ui = render(<QuickCaptureCard {...props} />);
  // Recognition updates the value without a user edit.
  act(() => {
    jest.mocked(useVoiceInput).mock.calls.at(-1)![1]('Captured outcome');
  });
  expect(ui.getByText('Save')).toBeTruthy();
  expect(ui.queryByLabelText('Stop recording')).toBeNull();
  expect(jest.mocked(useVoiceInput).mock.calls.at(-1)).toHaveLength(2);
  act(() => jest.advanceTimersByTime(60_000));
  expect(captureTask).not.toHaveBeenCalled();
  fireEvent.press(ui.getByText('Save'));
  expect(toggle).toHaveBeenCalledTimes(2);
  expect(captureTask).not.toHaveBeenCalled();
  act(() => {
    jest.mocked(useVoiceInput).mock.calls.at(-1)![1]('Final captured outcome');
  });
  jest
    .mocked(useVoiceInput)
    .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
  await act(async () => ui.rerender(<QuickCaptureCard {...props} />));
  expect(captureTask).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Final captured outcome',
      projectId: 'p',
      sourceSessionId: 's',
    }),
  );
  expect(props.onSaved).toHaveBeenCalledWith('saved-id', expect.any(String));
});
it('a project chip selects the target without saving', async () => {
  const ui = render(<QuickCaptureCard {...props} />);
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Edited thought');
  // Chips are there while recording too, so the layout never jumps.
  fireEvent.press(ui.getByText('General'));
  expect(captureTask).not.toHaveBeenCalled();
  jest
    .mocked(useVoiceInput)
    .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
  ui.rerender(<QuickCaptureCard {...props} />);
  await act(async () => fireEvent.press(ui.getByText('Save')));
  expect(captureTask).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Edited thought', projectId: null }),
  );
});
it('discards without saving', () => {
  const ui = render(<QuickCaptureCard {...props} />);
  fireEvent.press(ui.getByLabelText('Discard capture'));
  expect(voice.abort).toHaveBeenCalled();
  expect(captureTask).not.toHaveBeenCalled();
});

it('explains photo access and asks only when Allow is tapped', async () => {
  jest.mocked(screenshotAccess).mockResolvedValue('undetermined');
  const ui = render(<QuickCaptureCard {...props} />);
  await act(async () => {});
  expect(
    ui.getByText('Verity needs photo access to offer the screenshot you just took.'),
  ).toBeTruthy();
  expect(enableTaskScreenshotSuggestions).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(ui.getByText('Allow')));
  expect(enableTaskScreenshotSuggestions).toHaveBeenCalledTimes(1);
});
it('renders a converted screenshot preview instead of a library URI', async () => {
  const screenshot = { uri: 'ph://screenshot', filename: 'Screenshot.png' };
  jest.mocked(recentTaskScreenshot).mockResolvedValue(screenshot);
  const ui = render(<QuickCaptureCard {...props} />);
  await act(async () => {});
  expect(previewTaskScreenshot).toHaveBeenCalledWith(screenshot);
  expect(ui.getByText('Screenshot from just now')).toBeTruthy();
  expect(ui.UNSAFE_getAllByType(Image)[0].props.source.uri).toBe('data:image/jpeg;base64,preview');
});

it('saves typed text when speech recognition is unavailable', async () => {
  jest.mocked(useVoiceInput).mockReturnValue({
    ...voice,
    state: 'idle',
    error: 'Permission denied',
  } as unknown as ReturnType<typeof useVoiceInput>);
  const ui = render(<QuickCaptureCard {...props} />);
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Typed task');
  await act(async () => fireEvent.press(ui.getByText('Save')));
  expect(captureTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Typed task' }));
});
it('does not save an unfinished transcript after a recognition error', async () => {
  const ui = render(<QuickCaptureCard {...props} />);
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Partial task');
  const saveButton = ui.getByText('Save');
  act(() => {
    fireEvent.press(saveButton);
    fireEvent.press(saveButton);
  });
  expect(toggle).toHaveBeenCalledTimes(2);
  jest.mocked(useVoiceInput).mockReturnValue({
    ...voice,
    state: 'idle',
    error: 'Recognition failed',
  } as unknown as ReturnType<typeof useVoiceInput>);
  await act(async () => ui.rerender(<QuickCaptureCard {...props} />));
  expect(captureTask).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(ui.getByText('Save')));
  expect(captureTask).toHaveBeenCalledTimes(1);
});
