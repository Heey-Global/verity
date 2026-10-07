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
it('never saves on its own; Save stores the text after dictation ends', async () => {
  const ui = render(<QuickCaptureCard {...props} />);
  // Recognition updates the value without a user edit.
  act(() => {
    jest.mocked(useVoiceInput).mock.calls.at(-1)![1]('Captured outcome');
  });
  // While recording there is no Save, only Stop.
  expect(ui.queryByText('Save')).toBeNull();
  expect(ui.getByLabelText('Stop recording')).toBeTruthy();
  jest
    .mocked(useVoiceInput)
    .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
  ui.rerender(<QuickCaptureCard {...props} />);
  // The card waits for the operator, however long it stays open.
  act(() => jest.advanceTimersByTime(60_000));
  expect(captureTask).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(ui.getByText('Save')));
  expect(captureTask).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Captured outcome', projectId: 'p', sourceSessionId: 's' }),
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
