import { act, fireEvent, render } from '@testing-library/react-native';
import { QuickCaptureCard } from './QuickCaptureCard';
import { captureTask } from '../lib/tasksStore';
import { useVoiceInput } from '../hooks/useVoiceInput';

jest.mock('../hooks/useVoiceInput', () => ({ useVoiceInput: jest.fn() }));
jest.mock('../lib/tasksStore', () => ({ captureTask: jest.fn() }));
jest.mock('../lib/attachments', () => ({ pickFiles: jest.fn(), pickImagesFromLibrary: jest.fn() }));
jest.mock('../lib/taskScreenshot', () => ({
  recentTaskScreenshot: jest.fn(async () => null),
  readTaskScreenshot: jest.fn(),
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
it('waits for recognition end and then saves after three seconds', async () => {
  const ui = render(<QuickCaptureCard {...props} />);
  // Recognition updates the value without a user edit.
  act(() => {
    jest.mocked(useVoiceInput).mock.calls.at(-1)![1]('Captured outcome');
  });
  act(() => jest.advanceTimersByTime(4000));
  expect(captureTask).not.toHaveBeenCalled();
  jest
    .mocked(useVoiceInput)
    .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
  ui.rerender(<QuickCaptureCard {...props} />);
  act(() => jest.advanceTimersByTime(2999));
  expect(captureTask).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(1));
  expect(captureTask).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Captured outcome', projectId: 'p', sourceSessionId: 's' }),
  );
  expect(props.onSaved).toHaveBeenCalledWith('saved-id', expect.any(String));
});
it('pauses autosave when editing and saves immediately to a project chip', async () => {
  const ui = render(<QuickCaptureCard {...props} />);
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Edited thought');
  jest
    .mocked(useVoiceInput)
    .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
  ui.rerender(<QuickCaptureCard {...props} />);
  act(() => jest.advanceTimersByTime(6000));
  expect(captureTask).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(ui.getByText('General')));
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
