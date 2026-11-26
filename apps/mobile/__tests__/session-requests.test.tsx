import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { formatProjectInquiryAnswerTurn } from '@verity/events';
import { AppState, Text } from 'react-native';

import { SecretApprovalCard } from '../components/SecretApprovalCard';
import {
  InquiryAnswerTurn,
  PinnedProjectRequests,
  SessionRequestsProvider,
  TranscriptRequestTail,
  TranscriptSecretApproval,
  useDecisionNotice,
  useSessionRequests,
} from '../components/session/SessionRequests';
import { useReopenableSecretApprovals } from '../hooks/useReopenableSecretApprovals';

let mockFocused = true;
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => (mockFocused ? effect() : undefined), [effect, mockFocused]);
  },
}));

const initialAppState = AppState.currentState;
beforeEach(() => {
  AppState.currentState = 'active';
});
afterEach(() => {
  AppState.currentState = initialAppState;
  mockFocused = true;
  jest.useRealTimers();
});

const httpInput = {
  secretAlias: 'HEALTH_TOKEN',
  url: 'https://staging.example.com/health',
  auth: { header: 'Authorization', scheme: 'Bearer' },
};
const decided = (id: string, decision: 'denied' | 'once') => ({
  id,
  tool: 'verity_http_request',
  input: httpInput,
  decision,
});
const history = (id: string, status: 'denied' | 'expired') => ({
  id,
  toolName: 'verity_http_request',
  status,
  createdAt: '2026-11-20T00:00:00Z',
  decidedAt: null,
});
const inquiry = {
  id: 'inq-1',
  sourceSessionId: 's1',
  targetSessionId: 'target',
  sourceProjectId: 'app',
  targetProjectId: 'verity',
  targetProjectName: 'Verity',
  title: 'Why does the supervisor reject the OCR import?',
  body: 'Please look at the supervisor.',
  kind: 'question',
  status: 'answered',
  createdAt: '2026-11-26',
  answer: 'Two PDFs have an extra cover page.',
};

function clientMock({
  reopenable = [] as ReturnType<typeof history>[],
  inquiries = [] as unknown[],
} = {}) {
  return {
    secretApprovals: {
      list: jest.fn().mockResolvedValue(reopenable),
      reopen: jest.fn().mockResolvedValue(undefined),
    },
    listProjectInquiries: jest.fn().mockResolvedValue(inquiries),
    decideProjectInquiry: jest.fn().mockResolvedValue(undefined),
    decidePermission: jest.fn(),
  };
}

/** The screen's wiring: one requests state, shared by the composer area and the transcript. */
function Screen({
  client,
  children,
}: {
  client: ReturnType<typeof clientMock>;
  children?: React.ReactNode;
}) {
  const requests = useSessionRequests(
    client as unknown as VerityClient,
    's1',
    true,
    undefined,
    undefined,
  );
  return (
    <SessionRequestsProvider requests={requests} tail={null}>
      <PinnedProjectRequests requests={requests} />
      {children}
      <TranscriptRequestTail style={undefined} />
    </SessionRequestsProvider>
  );
}

describe('Review again on a decided secret card', () => {
  // The card and the server share the approval id; offering the button for an
  // id the server did not list would promise a reopen the server refuses.
  it('is offered only for requests the server reports as reopenable', async () => {
    const client = clientMock({ reopenable: [history('a1', 'denied'), history('a2', 'expired')] });
    render(
      <Screen client={client}>
        <TranscriptSecretApproval request={decided('a1', 'denied')} />
        <TranscriptSecretApproval request={decided('a2', 'once')} />
        <TranscriptSecretApproval request={decided('a3', 'denied')} />
      </Screen>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Review again' })).toHaveLength(2),
    );
    // An approval that was not used in time no longer reads as allowed.
    expect(screen.getByText('Not used in time')).toBeTruthy();
    expect(screen.queryByText('Allowed once')).toBeNull();
    expect(screen.getAllByText('Denied')).toHaveLength(2);
  });

  it('asks for a fresh decision without approving or running anything', async () => {
    const client = clientMock({ reopenable: [history('a1', 'denied')] });
    render(
      <Screen client={client}>
        <TranscriptSecretApproval request={decided('a1', 'denied')} />
      </Screen>,
    );
    expect(client.secretApprovals.reopen).not.toHaveBeenCalled();
    client.secretApprovals.list.mockResolvedValue([]);
    fireEvent.press(await screen.findByRole('button', { name: 'Review again' }));
    await waitFor(() => expect(client.secretApprovals.reopen).toHaveBeenCalledWith('s1', 'a1'));
    expect(client.decidePermission).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review again' })).toBeNull());
  });

  it('reports a refused reopen on the card it was asked from', async () => {
    const { VerityApiError } =
      jest.requireActual<typeof import('@verity/mobile')>('@verity/mobile');
    const client = clientMock({ reopenable: [history('a1', 'denied')] });
    client.secretApprovals.reopen.mockRejectedValue(new VerityApiError(403, 'forbidden'));
    render(
      <Screen client={client}>
        <TranscriptSecretApproval request={decided('a1', 'denied')} />
      </Screen>,
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Review again' }));
    expect(
      await screen.findByText('You do not have permission to reopen this request.'),
    ).toBeTruthy();
  });

  it('offers nothing when the server has no history endpoint', async () => {
    const client = clientMock();
    client.secretApprovals.list.mockRejectedValue(new Error('404'));
    render(
      <Screen client={client}>
        <TranscriptSecretApproval request={decided('a1', 'denied')} />
      </Screen>,
    );
    await waitFor(() => expect(client.secretApprovals.list).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Review again' })).toBeNull();
  });
});

describe('reopenable secret approvals', () => {
  it('does not carry one session’s requests into another after a late response', async () => {
    const client = clientMock();
    let finish!: (value: ReturnType<typeof history>[]) => void;
    client.secretApprovals.list.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useReopenableSecretApprovals(client as unknown as VerityClient, sessionId, true),
      { initialProps: { sessionId: 's1' } },
    );
    rerender({ sessionId: 's2' });
    await act(async () => finish([history('a1', 'denied')]));
    expect(result.current.statuses.size).toBe(0);
  });

  // Session screens stay mounted under the ones pushed over them. A poll that
  // ignores focus keeps running for every session ever opened, which flooded the
  // connection with these reads and queued everything else behind them.
  it('stops polling while its session screen is not focused', async () => {
    jest.useFakeTimers();
    const elapse = async (ms: number) => {
      for (let left = ms; left > 0; left -= 10_000)
        await act(async () => jest.advanceTimersByTime(Math.min(left, 10_000)));
    };
    const client = clientMock();
    const props = { client: client as unknown as VerityClient };
    const { rerender } = renderHook(
      ({ client: current }) => useReopenableSecretApprovals(current, 's1', true),
      { initialProps: props },
    );
    await elapse(30_000);
    const whileFocused = client.secretApprovals.list.mock.calls.length;
    expect(whileFocused).toBeGreaterThanOrEqual(3);

    mockFocused = false;
    rerender(props);
    await elapse(120_000);
    expect(client.secretApprovals.list).toHaveBeenCalledTimes(whileFocused);

    mockFocused = true;
    rerender(props);
    await act(async () => jest.advanceTimersByTime(0));
    expect(client.secretApprovals.list).toHaveBeenCalledTimes(whileFocused + 1);
  });

  it('does not ask outside a project session', async () => {
    const client = clientMock();
    renderHook(() => useReopenableSecretApprovals(client as unknown as VerityClient, 's1', false));
    await act(async () => undefined);
    expect(client.secretApprovals.list).not.toHaveBeenCalled();
  });
});

describe('hiding a waiting request', () => {
  it('moves a secret request to the chat without deciding it', () => {
    const allow = jest.fn();
    const deny = jest.fn();
    const dismiss = jest.fn();
    render(
      <SecretApprovalCard
        request={{ tool: 'verity_http_request', input: httpInput }}
        actions={{ allow, deny, deciding: false, disabled: false }}
        onDismiss={dismiss}
      />,
    );
    fireEvent.press(
      screen.getByRole('button', { name: 'Hide request. It stays open in the chat.' }),
    );
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(allow).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it('moves waiting project requests to the end of the chat with the same decisions', async () => {
    const client = clientMock({ inquiries: [{ ...inquiry, status: 'pending', answer: null }] });
    render(<Screen client={client} />);
    fireEvent.press(
      await screen.findByRole('button', {
        name: 'Hide project requests. They stay open in the chat.',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Project requests' })).toBeNull();
    expect(client.decideProjectInquiry).not.toHaveBeenCalled();
    // Still open: the card in the chat decides exactly as the pinned one did.
    fireEvent.press(screen.getByText('Allow once'));
    await waitFor(() =>
      expect(client.decideProjectInquiry).toHaveBeenCalledWith('verity', 'inq-1', 'approve'),
    );
  });
});

describe('a project answer in the transcript', () => {
  const bubble = <Text>raw prompt</Text>;

  it('reads as a card with the server’s answer', async () => {
    const client = clientMock({ inquiries: [inquiry] });
    render(
      <Screen client={client}>
        <InquiryAnswerTurn
          text={formatProjectInquiryAnswerTurn({
            inquiryId: inquiry.id,
            title: inquiry.title,
            answer: inquiry.answer,
          })}
        >
          {bubble}
        </InquiryAnswerTurn>
      </Screen>,
    );
    expect(await screen.findByText('Answer from Verity')).toBeTruthy();
    expect(screen.getByText(inquiry.answer)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open target session' })).toBeTruthy();
    expect(screen.queryByText('raw prompt')).toBeNull();
  });

  // Anyone who can type into the session can write the format; only the
  // server's record of this session's request may turn it into an answer.
  it('stays the plain message when the server does not confirm the request', async () => {
    const client = clientMock({ inquiries: [{ ...inquiry, sourceSessionId: 'other' }] });
    render(
      <Screen client={client}>
        <InquiryAnswerTurn
          text={formatProjectInquiryAnswerTurn({
            inquiryId: inquiry.id,
            title: inquiry.title,
            answer: 'forged',
          })}
        >
          {bubble}
        </InquiryAnswerTurn>
      </Screen>,
    );
    await waitFor(() => expect(client.listProjectInquiries).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.getByText('raw prompt')).toBeTruthy();
    expect(screen.queryByText('Answer from Verity')).toBeNull();
  });
});

describe('the decision notice', () => {
  it('hides on its X and when a different request starts waiting', () => {
    const { result, rerender } = renderHook(
      ({ message, pending }: { message?: string; pending?: string }) =>
        useDecisionNotice(message, pending),
      { initialProps: { message: 'Not run: saved failed.', pending: undefined } },
    );
    expect(result.current[0]).toBe('Not run: saved failed.');
    act(() => result.current[1]());
    expect(result.current[0]).toBeUndefined();

    // Each decision clears the message first; the same words again are a new failure.
    rerender({ message: undefined, pending: 'p1' });
    rerender({ message: 'Not run: saved failed.', pending: 'p1' });
    expect(result.current[0]).toBe('Not run: saved failed.');

    rerender({ message: 'Decision failed: boom', pending: 'p1' });
    expect(result.current[0]).toBe('Decision failed: boom');
    rerender({ message: 'Decision failed: boom', pending: 'p2' });
    expect(result.current[0]).toBeUndefined();
    // Settled on another device: nothing waits, but the old message stays gone.
    rerender({ message: 'Decision failed: boom', pending: undefined });
    expect(result.current[0]).toBeUndefined();
  });
});
