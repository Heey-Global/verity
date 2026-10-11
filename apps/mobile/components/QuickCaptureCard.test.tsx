import { taskContext } from '@verity/mobile';
import { Image } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { QuickCaptureCard } from './QuickCaptureCard';
import { KeyCommands } from './KeyCommands';
import { captureTask } from '../lib/tasksStore';
import { dispatchTaskVoiceShortcut } from '../lib/voiceShortcut';
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
  useTaskPreferences: () => ({
    loaded: true,
    screenshots: true,
    screenshotPromptDismissed: false,
    projectId: 'remembered',
  }),
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
      detail: 'Final captured outcome',
      generateTitle: true,
      projectId: 'p',
      sourceSessionId: 's',
    }),
  );
  expect(props.onSaved).toHaveBeenCalledWith('saved-id', expect.any(String));
});
it('a project chip selects the target without saving', async () => {
  const captureProps = {
    ...props,
    projects: [
      {
        id: 'other',
        owner: 'local',
        repo: 'other',
        kind: 'local' as const,
        containerName: 'other',
        imageRef: null,
        state: 'active' as const,
        provisionError: null,
        createdAt: '',
        updatedAt: '',
      },
    ],
  };
  const ui = render(<QuickCaptureCard {...captureProps} />);
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Edited thought');
  // Chips are there while recording too, so the layout never jumps.
  fireEvent.press(ui.getByText('other'));
  expect(captureTask).not.toHaveBeenCalled();
  jest
    .mocked(useVoiceInput)
    .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
  ui.rerender(<QuickCaptureCard {...captureProps} />);
  await act(async () => fireEvent.press(ui.getByText('Save')));
  expect(captureTask).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Edited thought', projectId: 'other' }),
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

it('starts dictation once when task capture opens and preserves it on rerender', () => {
  const ui = render(<QuickCaptureCard {...props} />);
  expect(toggle).toHaveBeenCalledTimes(1);
  ui.rerender(<QuickCaptureCard {...props} />);
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(captureTask).not.toHaveBeenCalled();
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

it('requires a project outside a session and never offers General', async () => {
  jest
    .mocked(useVoiceInput)
    .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
  const ui = render(<QuickCaptureCard {...props} context={{ projectId: null, sessionId: null }} />);
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Unassigned capture');
  expect(ui.queryByText('General')).toBeNull();
  await act(async () => fireEvent.press(ui.getByText('Save')));
  expect(captureTask).not.toHaveBeenCalled();
});

it('restores the remembered project when capturing outside a session', async () => {
  jest
    .mocked(useVoiceInput)
    .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
  const ui = render(
    <QuickCaptureCard
      {...props}
      context={{ projectId: null, sessionId: null }}
      projects={[
        {
          id: 'remembered',
          owner: 'local',
          repo: 'Remembered',
          kind: 'local',
          containerName: 'remembered',
          imageRef: null,
          state: 'active',
          provisionError: null,
          createdAt: '',
          updatedAt: '',
        },
      ]}
    />,
  );
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Restored project capture');
  await act(async () => fireEvent.press(ui.getByText('Save')));
  expect(captureTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'remembered' }));
});

it('cancels task dictation through the shortcut inside the native modal', () => {
  const ui = render(<QuickCaptureCard {...props} />);
  expect(toggle).toHaveBeenCalledTimes(1);
  act(() => {
    ui.UNSAFE_getByType(KeyCommands).props.onVoice('task');
  });
  expect(voice.abort).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(captureTask).not.toHaveBeenCalled();
});

it('does not cancel an explicit save already waiting for the final transcript', () => {
  const ui = render(<QuickCaptureCard {...props} />);
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Task to save');
  fireEvent.press(ui.getByText('Save'));
  act(() => {
    ui.UNSAFE_getByType(KeyCommands).props.onVoice('task');
  });
  expect(voice.abort).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it('cancels dictation when UIKit routes the shortcut through the root responder', () => {
  render(<QuickCaptureCard {...props} />);
  act(() => dispatchTaskVoiceShortcut());
  expect(voice.abort).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(captureTask).not.toHaveBeenCalled();
});

it('ignores root shortcuts while an explicit save waits for the transcript', () => {
  const ui = render(<QuickCaptureCard {...props} />);
  fireEvent.changeText(ui.getByLabelText('Task text'), 'Task to save');
  fireEvent.press(ui.getByText('Save'));
  act(() => dispatchTaskVoiceShortcut());
  expect(voice.abort).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it.each([
  [false, false],
  [false, true],
  [true, true],
])(
  'adopts delayed session context while preserving explicit selection (chosen=%s, cached=%s)',
  async (chooseProject, cachedProjects) => {
    jest
      .mocked(useVoiceInput)
      .mockReturnValue({ ...voice, state: 'idle' } as unknown as ReturnType<typeof useVoiceInput>);
    const projects = [
      {
        id: 'remembered',
        owner: 'local',
        repo: 'Remembered',
        kind: 'local' as const,
        containerName: 'remembered',
        imageRef: null,
        state: 'active' as const,
        provisionError: null,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const ui = render(
      <QuickCaptureCard
        {...props}
        projects={cachedProjects ? projects : []}
        context={taskContext('/session/s', { id: 's' }, [])}
      />,
    );
    fireEvent.changeText(ui.getByLabelText('Task text'), 'Cold session capture');
    if (chooseProject) fireEvent.press(ui.getByText('Remembered'));
    else {
      await act(async () => fireEvent.press(ui.getByText('Save')));
      expect(captureTask).not.toHaveBeenCalled();
    }
    ui.rerender(
      <QuickCaptureCard
        {...props}
        projects={projects}
        context={taskContext('/session/s', { id: 's' }, [{ sessionId: 's', projectId: 'p' }])}
      />,
    );
    await act(async () => fireEvent.press(ui.getByText('Save')));
    expect(captureTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: chooseProject ? 'remembered' : 'p',
        sourceSessionId: 's',
      }),
    );
  },
);
