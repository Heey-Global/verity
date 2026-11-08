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
import { dayLabel, VerityPanel } from './VerityPanel';

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
  expect(screen.getByText('Task · no work started')).toBeTruthy();
  expect(screen.getByLabelText('Saved, ready')).toBeTruthy();
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
    at: Date.now(),
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
      params: {
        sessionId: 'assistant',
        prepare: '1',
        request: expect.any(String),
        source: 'online',
        eventKey: 'ev-1',
      },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not pull the user into a meeting a turn they left was still readying', () => {
    jest
      .mocked(useVerity)
      .mockReturnValue(withItems({ ...prepared, at: Date.now() - 10 * 60_000, state: 'pending' }));
    const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
    jest
      .mocked(useVerity)
      .mockReturnValue(withItems({ ...prepared, at: Date.now() - 10 * 60_000, state: 'ready' }));
    screen.rerender(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('does not open a meeting readied long ago that a refresh brings in', () => {
    const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
    jest
      .mocked(useVerity)
      .mockReturnValue(withItems({ ...prepared, at: Date.now() - 10 * 60_000, state: 'ready' }));
    screen.rerender(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
    expect(router.push).not.toHaveBeenCalled();
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
      params: {
        sessionId: 'assistant',
        prepare: '1',
        request: expect.any(String),
        source: 'presence',
      },
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
      params: {
        sessionId: 'assistant',
        prepare: '1',
        request: expect.any(String),
        source: 'online',
        eventKey: 'ev-1',
      },
    });
  });
});

it('renders her replies as the session chat does, not as raw Markdown', () => {
  jest.mocked(useVerity).mockReturnValue({
    ...ready,
    conversation: {
      ...ready.conversation!,
      items: [
        {
          kind: 'reply',
          id: 'r-1',
          at: 1,
          text: 'Two meetings:\n\n- **Wed, 11.11.:** Deep OCR\n- **Fri, 13.11.:** Swimshorts',
        },
      ],
    },
  });
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  const reply = screen.getByTestId('verity-reply');
  // A plain Text showed the markers; the reply must read as a list with bold dates.
  expect(reply).not.toHaveTextContent(/\*\*/);
  expect(reply).not.toHaveTextContent(/^- /m);
  expect(screen.getAllByText('•')).toHaveLength(2);
  expect(screen.getByText('Wed, 11.11.:')).toBeTruthy();
});

it('shows the whole conversation, with a heading where a new day starts', () => {
  const now = new Date(2026, 10, 8, 12).getTime();
  const yesterday = new Date(2026, 10, 7, 9).getTime();
  const items: AssistantConversationItem[] = Array.from({ length: 12 }, (_, index) => ({
    kind: 'message',
    id: `m-${String(index)}`,
    at: index < 6 ? yesterday + index : now + index,
    text: `Message ${String(index)}`,
  }));
  jest.spyOn(Date, 'now').mockReturnValue(now + 100);
  jest.mocked(useVerity).mockReturnValue({
    ...ready,
    conversation: { ...ready.conversation!, items },
  });
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  // The panel used to cut the conversation to its last eight entries.
  expect(screen.getByText('Message 0')).toBeTruthy();
  expect(screen.getByText('Message 11')).toBeTruthy();
  expect(screen.getAllByText('Yesterday')).toHaveLength(1);
  expect(screen.getAllByText('Today')).toHaveLength(1);
  jest.mocked(Date.now).mockRestore();
});

it('labels a day once, by name for today and yesterday', () => {
  const now = new Date(2026, 10, 8, 12).getTime();
  const morning = new Date(2026, 10, 8, 8).getTime();
  const yesterday = new Date(2026, 10, 7, 23).getTime();
  const older = new Date(2026, 10, 2, 10).getTime();
  expect(dayLabel(morning, undefined, now)).toBe('Today');
  expect(dayLabel(now, morning, now)).toBeNull();
  expect(dayLabel(morning, yesterday, now)).toBe('Today');
  expect(dayLabel(yesterday, older, now)).toBe('Yesterday');
  expect(dayLabel(older, undefined, now)).not.toMatch(/Today|Yesterday/);
});

it('marks a waiting question as a normal next step, not as a problem', () => {
  jest.mocked(useVerity).mockReturnValue({
    ...ready,
    conversation: { ...ready.conversation!, state: 'needs_you' },
  });
  const screen = render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
  expect(screen.getByLabelText('Needs you, waiting for you')).toBeTruthy();
});
