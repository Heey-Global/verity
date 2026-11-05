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
