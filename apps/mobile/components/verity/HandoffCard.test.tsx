jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../../lib/verityConversation', () => ({
  useVerity: jest.fn(),
  sendToVerity: jest.fn(async () => undefined),
  answerVerity: jest.fn(async () => undefined),
  retryOutgoing: jest.fn(),
  discardOutgoing: jest.fn(),
  dismissVerityNotice: jest.fn(),
  decideVerityApproval: jest.fn(async () => undefined),
}));
jest.mock('../../hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    error: undefined,
    toggle: jest.fn(),
    abort: jest.fn(),
    onComposerEdit: jest.fn(),
  }),
}));

import { act, fireEvent, render } from '@testing-library/react-native';
import type { AssistantConversation, AssistantConversationItem } from '@verity/mobile';
import { router } from 'expo-router';

import { decideVerityApproval, useVerity } from '../../lib/verityConversation';
import { VerityPanel } from '../VerityPanel';

type Assignment = Extract<AssistantConversationItem, { kind: 'assignment' }>;

const BRIEFING = 'Look up #2965.\nRelabel it if it is marked breaking.\nDo not merge.';
const input = {
  target: { newSession: { project: 'heey-global/verity' } },
  title: '#2965 must not be a breaking change',
  briefing: BRIEFING,
};
const card = (extra: Partial<Assignment> = {}): Assignment => ({
  kind: 'assignment',
  id: 't-2',
  at: 1,
  title: input.title,
  project: 'heey-global/verity',
  state: 'pending',
  ...extra,
});

function show(conversation: Partial<AssistantConversation>) {
  jest.mocked(useVerity).mockReturnValue({
    access: 'ready',
    outbox: [],
    notice: null,
    conversation: {
      availability: 'ready',
      sessionId: 'assistant',
      revision: 3,
      state: 'idle',
      items: [],
      question: null,
      approvals: [],
      ...conversation,
    },
  });
  return render(<VerityPanel mode="text" projectId={null} onClose={jest.fn()} />);
}

const waiting = () =>
  show({
    state: 'needs_you',
    items: [card({ approvalId: 'gw-1' })],
    approvals: [{ id: 'gw-1', tool: 'verity_session_handoff', input }],
  });

beforeEach(() => jest.clearAllMocks());

it('shows a waiting handoff as the approval itself: where it goes, the task, the answers', () => {
  const screen = waiting();
  expect(screen.getByText('Handoff to another project')).toBeTruthy();
  expect(screen.getByText('Waiting for you')).toBeTruthy();
  expect(screen.getByTestId('handoff-route').props.accessibilityLabel).toBe(
    'From Verity to heey-global/verity, New session',
  );
  expect(screen.getByText(input.title)).toBeTruthy();
  // One card per approval: the handoff's own card, never a second generic one.
  expect(screen.getAllByTestId('handoff-card')).toHaveLength(1);
  expect(screen.queryByTestId('verity-approval')).toBeNull();
  expect(screen.getByText('Hand over to verity')).toBeTruthy();
  expect(screen.getByText("Don't hand over")).toBeTruthy();
});

it('folds the briefing with its size and opens it in full, verbatim', () => {
  const screen = waiting();
  expect(screen.getByText('65 characters · 3 lines · written by Verity')).toBeTruthy();
  expect(screen.queryByTestId('handoff-briefing-text')).toBeNull();
  fireEvent.press(screen.getByText('Briefing'));
  expect(screen.getByTestId('handoff-briefing-text').props.children).toBe(BRIEFING);
});

it('decides on the card without opening the briefing or the session', async () => {
  const screen = waiting();
  await act(async () => {
    fireEvent.press(screen.getByText('Hand over to verity'));
  });
  expect(decideVerityApproval).toHaveBeenCalledWith(
    { id: 'gw-1', tool: 'verity_session_handoff', input },
    true,
  );
  await act(async () => {
    fireEvent.press(screen.getByText("Don't hand over"));
  });
  expect(decideVerityApproval).toHaveBeenLastCalledWith(
    { id: 'gw-1', tool: 'verity_session_handoff', input },
    false,
  );
  expect(router.push).not.toHaveBeenCalled();
});

it('sends a handoff it cannot show to the session instead of offering to approve it blind', () => {
  const screen = show({
    state: 'needs_you',
    items: [card({ approvalId: 'gw-1' })],
    approvals: [{ id: 'gw-1', tool: 'verity_session_handoff' }],
  });
  expect(screen.queryByText('Hand over to verity')).toBeNull();
  fireEvent.press(screen.getByText('Review in session'));
  expect(router.push).toHaveBeenCalledWith('/session/assistant');
});

it('keeps the card after the decision: handed over, then the result, or not handed over', () => {
  const screen = show({
    items: [
      card({ id: 'a', state: 'sent', sessionId: 's-1' }),
      card({
        id: 'b',
        state: 'sent',
        sessionId: 's-2',
        result: { delivered: true, summary: 'Retitled to feat:.', at: 2 },
      }),
      card({ id: 'c', state: 'failed', declined: true }),
      card({ id: 'd', state: 'failed' }),
    ],
  });
  expect(screen.getAllByText('Handoff to another project')).toHaveLength(4);
  expect(screen.getAllByTestId('handoff-route')).toHaveLength(4);
  expect(screen.getByText('Handed over')).toBeTruthy();
  expect(screen.getByText('The session is working')).toBeTruthy();
  expect(screen.getByText('Done')).toBeTruthy();
  expect(screen.getByText('Not handed over')).toBeTruthy();
  expect(screen.getByText("You didn't hand it over · nothing was sent")).toBeTruthy();
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(screen.queryByText('Hand over to verity')).toBeNull();
  fireEvent.press(screen.getAllByText('Open session')[0]!);
  expect(router.push).toHaveBeenCalledWith('/session/s-1');
});

it('decides another approval inline when its summary carries the whole request', async () => {
  const screen = show({
    state: 'needs_you',
    approvals: [{ id: 'p-1', tool: 'WebFetch', input: { url: 'https://api.exa.ai' } }],
  });
  expect(screen.getByText('https://api.exa.ai')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByText('Allow'));
  });
  expect(decideVerityApproval).toHaveBeenCalledWith(
    { id: 'p-1', tool: 'WebFetch', input: { url: 'https://api.exa.ai' } },
    true,
  );
});

// The approval is linked to its card by title, so the card's own project may belong to
// another handoff; a request naming only a session must not borrow it.
it('names only the destination the request itself names', () => {
  const bare = { target: { sessionId: 's-9' }, title: input.title, briefing: BRIEFING };
  const screen = show({
    state: 'needs_you',
    items: [card({ approvalId: 'gw-1', project: 'acme/elsewhere' })],
    approvals: [{ id: 'gw-1', tool: 'verity_session_handoff', input: bare }],
  });
  expect(screen.getByTestId('handoff-route').props.accessibilityLabel).toBe(
    'From Verity to Session s-9',
  );
  expect(screen.queryByText(/elsewhere/)).toBeNull();
  expect(screen.getByText('Hand over')).toBeTruthy();
});

it('offers neither answers nor a way to the session when there is no session', () => {
  const screen = show({
    sessionId: null,
    state: 'needs_you',
    approvals: [
      { id: 'p-1', tool: 'verity_gmail' },
      { id: 'p-2', tool: 'WebFetch', input: { url: 'https://api.exa.ai' } },
    ],
  });
  expect(screen.queryByText('Review in session')).toBeNull();
  expect(screen.queryByText('Allow')).toBeNull();
});

it('sends one decision for a double tap', async () => {
  let finish: () => void = () => undefined;
  jest
    .mocked(decideVerityApproval)
    .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
  const screen = waiting();
  const button = screen.getByText('Hand over to verity');
  fireEvent.press(button);
  fireEvent.press(button);
  await act(async () => finish());
  expect(decideVerityApproval).toHaveBeenCalledTimes(1);
});
