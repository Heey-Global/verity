jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../lib/verityConversation', () => ({
  useVerity: jest.fn(),
  sendToVerity: jest.fn(async () => undefined),
  answerVerity: jest.fn(async () => undefined),
  retryOutgoing: jest.fn(),
  discardOutgoing: jest.fn(),
  dismissVerityNotice: jest.fn(),
}));
const mockVoice = {
  state: 'idle',
  error: undefined as string | undefined,
  toggle: jest.fn(),
  abort: jest.fn(),
  onComposerEdit: jest.fn(),
};
jest.mock('../hooks/useVoiceInput', () => ({ useVoiceInput: () => mockVoice }));

import { fireEvent, render } from '@testing-library/react-native';
import type { AssistantConversationItem } from '@verity/mobile';
import { router } from 'expo-router';

import { answerVerity, sendToVerity, useVerity, type VerityState } from '../lib/verityConversation';
import { VerityPanel } from './VerityPanel';

const ready: VerityState = {
  access: 'ready',
  outbox: [],
  notice: null,
  conversation: {
    availability: 'ready',
    sessionId: 'assistant',
    revision: 3,
    state: 'idle',
    items: [
      { kind: 'message', id: 'm-1', at: 1, text: 'Remember the Hansen offer' },
      {
        kind: 'task',
        id: 't-2',
        at: 2,
        title: 'Update Hansen offer',
        projectId: 'site',
        state: 'saved',
      },
    ],
    question: null,
    approvals: [],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockVoice.state = 'idle';
  mockVoice.error = undefined;
  jest.mocked(useVerity).mockReturnValue(ready);
});

it('starts listening when opened from a tap and sends with the project as context', () => {
  const screen = render(<VerityPanel mode="voice" projectId="site" onClose={jest.fn()} />);
  expect(mockVoice.toggle).toHaveBeenCalledTimes(1);
  // A task is an outcome Verity reports, and saying so is part of the outcome.
  expect(screen.getByText('Saved as a task · no work started')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Message to Verity'), 'Is Hansen done?');
  fireEvent.press(screen.getByLabelText('Send to Verity'));
  expect(sendToVerity).toHaveBeenCalledWith({
    text: 'Is Hansen done?',
    input: 'text',
    projectId: 'site',
  });
});

it('opens for typing without the microphone when held', () => {
  render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  expect(mockVoice.toggle).not.toHaveBeenCalled();
});

it('answers her question with the question’s id, so a stale tap is caught', () => {
  jest.mocked(useVerity).mockReturnValue({
    ...ready,
    conversation: {
      ...ready.conversation!,
      state: 'needs_you',
      question: {
        id: 'q-4',
        question: 'Which client?',
        options: [{ label: 'Hansen' }, { label: 'Müller' }],
        multiSelect: false,
      },
    },
  });
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  fireEvent.press(screen.getByText('Müller'));
  expect(answerVerity).toHaveBeenCalledWith('q-4', ['Müller']);
});

it('sends approvals to the conversation instead of deciding them here', () => {
  const onClose = jest.fn();
  jest.mocked(useVerity).mockReturnValue({
    ...ready,
    conversation: {
      ...ready.conversation!,
      state: 'needs_you',
      approvals: [{ id: 'perm-1', tool: 'verity_gmail' }],
    },
  });
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={onClose} />);
  fireEvent.press(screen.getByText('Review'));
  expect(onClose).toHaveBeenCalled();
  expect(router.push).toHaveBeenCalledWith('/session/assistant');
});

it('says why Verity cannot listen and keeps unsent words with retry and discard', () => {
  jest.mocked(useVerity).mockReturnValue({
    access: 'ready',
    notice: null,
    conversation: { ...ready.conversation!, availability: 'disabled', sessionId: null, items: [] },
    outbox: [
      {
        kind: 'message',
        requestId: 'r-1',
        scope: 'a',
        createdAt: 1,
        text: 'Call Jonas',
        input: 'voice',
        held: true,
        error: 'Verity is switched off in settings.',
      },
    ],
  });
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  expect(screen.getByText(/Verity is switched off\. What you say stays here/)).toBeTruthy();
  expect(screen.getByText('Call Jonas')).toBeTruthy();
  expect(screen.getByText('Retry')).toBeTruthy();
  expect(screen.getByText('Discard')).toBeTruthy();
});

it('tells a member who is not an administrator that Verity is not theirs to use', () => {
  jest.mocked(useVerity).mockReturnValue({ ...ready, access: 'denied', conversation: null });
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  expect(screen.getByText(/available to administrators/)).toBeTruthy();
});

it('stops dictation on send and sends once the final words are in', () => {
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  mockVoice.state = 'recording';
  fireEvent.changeText(screen.getByLabelText('Message to Verity'), 'Call Hansen');
  fireEvent.press(screen.getByLabelText('Send to Verity'));
  expect(mockVoice.toggle).toHaveBeenCalledTimes(1);
  expect(mockVoice.abort).not.toHaveBeenCalled();
  expect(sendToVerity).not.toHaveBeenCalled();
  // The recognizer delivered its final result and stopped.
  fireEvent.changeText(screen.getByLabelText('Message to Verity'), 'Call Hansen tomorrow');
  mockVoice.state = 'idle';
  screen.rerender(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  expect(sendToVerity).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Call Hansen tomorrow' }),
  );
});

it('keeps the words instead of sending when dictation failed', () => {
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  mockVoice.state = 'recording';
  fireEvent.changeText(screen.getByLabelText('Message to Verity'), 'Call Han');
  fireEvent.press(screen.getByLabelText('Send to Verity'));
  mockVoice.state = 'idle';
  mockVoice.error = 'Speech recognition stopped.';
  screen.rerender(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  expect(sendToVerity).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue('Call Han')).toBeTruthy();
});

// The panel looked unlike Verity anywhere else: a bare title, "Listening" twice,
// unmarked answers and a composer of its own (docs/design-system.md § 5.8).
it('wears Verity’s identity, says listening once and marks her answers', () => {
  mockVoice.state = 'recording';
  jest.mocked(useVerity).mockReturnValue({
    ...ready,
    conversation: {
      ...ready.conversation!,
      items: [
        ...ready.conversation!.items,
        { kind: 'reply', id: 'r-3', at: 3, text: 'Saved it for the Hansen project.' },
      ],
    },
  });
  const onClose = jest.fn();
  const screen = render(<VerityPanel mode="voice" projectId="site" onClose={onClose} />);
  expect(screen.getAllByTestId('verity-mark').length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText('Listening')).toBeNull();
  expect(screen.getByLabelText('Message to Verity').props.placeholder).toBe('Listening…');
  expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeTruthy();
  expect(screen.getByTestId('verity-reply')).toHaveTextContent('Saved it for the Hansen project.');
  fireEvent.press(screen.getByLabelText('Open full conversation'));
  expect(onClose).toHaveBeenCalled();
  expect(router.push).toHaveBeenCalledWith('/session/assistant');
});

describe('meetings Verity prepares', () => {
  const prepared = {
    kind: 'meeting' as const,
    id: 't-5',
    at: 5,
    action: 'prepare' as const,
    mode: 'online' as const,
    eventKey: 'ev-1',
    title: 'Hansen call',
  };
  const withItems = (...items: AssistantConversationItem[]): VerityState => ({
    ...ready,
    conversation: {
      ...ready.conversation!,
      revision: 9,
      items: [...ready.conversation!.items, ...items],
    },
  });

  it('opens the filled-in start screen once, when it is readied while the panel is open', () => {
    const onClose = jest.fn();
    jest.mocked(useVerity).mockReturnValue(withItems({ ...prepared, state: 'pending' }));
    const screen = render(<VerityPanel mode="text" projectId={null} onClose={onClose} />);
    expect(router.push).not.toHaveBeenCalled();
    jest.mocked(useVerity).mockReturnValue(withItems({ ...prepared, state: 'ready' }));
    screen.rerender(<VerityPanel mode="text" projectId={null} onClose={onClose} />);
    screen.rerender(<VerityPanel mode="text" projectId={null} onClose={onClose} />);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/meeting/[sessionId]',
      params: { sessionId: 'assistant', prepare: '1', source: 'online', eventKey: 'ev-1' },
    });
    expect(onClose).toHaveBeenCalled();
  });

  // Reopening the panel later must not throw the user into an old meeting.
  it('leaves meetings that were there before the panel opened to a tap', () => {
    jest
      .mocked(useVerity)
      .mockReturnValue(
        withItems({ ...prepared, mode: 'in_person', eventKey: null, state: 'ready' }),
      );
    const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
    screen.rerender(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByText('Ready to start · in person')).toBeTruthy();
    fireEvent.press(screen.getByText('Open start screen'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/meeting/[sessionId]',
      params: { sessionId: 'assistant', prepare: '1', source: 'presence' },
    });
  });

  it('opens the running meeting Verity joined, and the start screen when she could not', () => {
    jest
      .mocked(useVerity)
      .mockReturnValue(
        withItems(
          { ...prepared, id: 't-6', action: 'join', state: 'ready' },
          { ...prepared, id: 't-7', action: 'join', state: 'failed' },
        ),
      );
    const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
    fireEvent.press(screen.getByText('Open meeting'));
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/meeting/[sessionId]',
      params: { sessionId: 'assistant' },
    });
    expect(screen.getByText('Verity could not join')).toBeTruthy();
    fireEvent.press(screen.getByText('Open start screen'));
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/meeting/[sessionId]',
      params: { sessionId: 'assistant', prepare: '1', source: 'online', eventKey: 'ev-1' },
    });
  });
});
