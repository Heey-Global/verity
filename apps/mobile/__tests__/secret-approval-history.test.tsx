import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';

import { SecretApprovalHistory } from '../components/SecretApprovalHistory';

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
