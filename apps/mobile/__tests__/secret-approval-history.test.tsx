import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';

import { SecretApprovalHistory } from '../components/SecretApprovalHistory';

let mockFocused = true;
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => (mockFocused ? effect() : undefined), [effect, mockFocused]);
  },
}));

afterEach(() => {
  mockFocused = true;
  jest.useRealTimers();
});

const entry = {
  id: 'a1',
  toolName: 'verity_http_request',
  status: 'denied',
  createdAt: '2026-11-20T00:00:00Z',
  decidedAt: null,
  summary: 'GET api.example.com',
};
const clientMock = () => ({
  secretApprovals: {
    list: jest.fn().mockResolvedValue([entry]),
    reopen: jest.fn().mockResolvedValue(undefined),
  },
});

it('reopens a denied request only on an explicit user action, without approving or running it', async () => {
  const client = clientMock();
  render(<SecretApprovalHistory client={client as unknown as VerityClient} sessionId="s1" />);
  await screen.findByText('Previous secret requests');
  expect(client.secretApprovals.reopen).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Previous secret requests'));
  expect(screen.getByText(/does not run the action/)).toBeTruthy();
  client.secretApprovals.list.mockResolvedValue([]);
  fireEvent.press(screen.getByLabelText('Review secret request a1 again'));
  await waitFor(() => expect(client.secretApprovals.reopen).toHaveBeenCalledWith('s1', 'a1'));
  await waitFor(() => expect(screen.queryByText('Previous secret requests')).toBeNull());
});

it('does not carry denied requests into a different session after a late response', async () => {
  const client = clientMock();
  let finish!: (value: (typeof entry)[]) => void;
  client.secretApprovals.list.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  client.secretApprovals.list.mockResolvedValue([]);
  const view = render(
    <SecretApprovalHistory client={client as unknown as VerityClient} sessionId="s1" />,
  );
  view.rerender(
    <SecretApprovalHistory client={client as unknown as VerityClient} sessionId="s2" />,
  );
  await act(async () => finish([entry]));
  expect(screen.queryByText('Previous secret requests')).toBeNull();
});

// Session screens stay mounted under the ones pushed over them. A poll that
// ignores focus keeps running for every session ever opened, which flooded the
// connection with thousands of these reads and queued everything else behind them.
it('stops polling while its session screen is not focused', async () => {
  jest.useFakeTimers();
  // Each poll is scheduled only after the previous read settles.
  const elapse = async (ms: number) => {
    for (let left = ms; left > 0; left -= 10_000)
      await act(async () => jest.advanceTimersByTime(Math.min(left, 10_000)));
  };
  const client = clientMock();
  client.secretApprovals.list.mockResolvedValue([]);
  const view = render(
    <SecretApprovalHistory client={client as unknown as VerityClient} sessionId="s1" />,
  );
  await elapse(30_000);
  const whileFocused = client.secretApprovals.list.mock.calls.length;
  expect(whileFocused).toBeGreaterThanOrEqual(3);

  mockFocused = false;
  view.rerender(
    <SecretApprovalHistory client={client as unknown as VerityClient} sessionId="s1" />,
  );
  await elapse(120_000);
  expect(client.secretApprovals.list).toHaveBeenCalledTimes(whileFocused);

  mockFocused = true;
  view.rerender(
    <SecretApprovalHistory client={client as unknown as VerityClient} sessionId="s1" />,
  );
  await act(async () => jest.advanceTimersByTime(0));
  expect(client.secretApprovals.list).toHaveBeenCalledTimes(whileFocused + 1);
});
