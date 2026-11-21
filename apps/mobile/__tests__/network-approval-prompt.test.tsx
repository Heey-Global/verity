import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type VerityClient, VerityApiError } from '@verity/mobile';

import { NetworkApprovalPrompt } from '../components/NetworkApprovalPrompt';

const request = {
  id: '11111111-1111-4111-8111-111111111111',
  target: { host: 'example.com', protocol: 'tcp' as const, port: 443 },
  revision: 1,
  requestedBy: ['sandbox'],
  createdAt: 0,
  expiresAt: null,
  status: 'pending' as const,
};
const policy = { revision: 1, requests: { target: request }, grants: [] };
const clientMock = () => ({
  getProjectEgress: jest.fn().mockResolvedValue(policy),
  decideProjectEgress: jest.fn().mockResolvedValue(undefined),
  reopenProjectEgress: jest.fn().mockResolvedValue(undefined),
});
afterEach(() => jest.useRealTimers());

it('shows an old unanswered request directly in the session and submits its exact revision', async () => {
  const client = clientMock();
  render(<NetworkApprovalPrompt client={client as unknown as VerityClient} projectId="p1" />);
  await screen.findByText('example.com · TCP 443');
  expect(screen.getByText(/every session and background/)).toBeTruthy();
  client.getProjectEgress.mockResolvedValue({ ...policy, requests: {} });
  fireEvent.press(screen.getByText('Allow for one hour'));
  await waitFor(() =>
    expect(client.decideProjectEgress).toHaveBeenCalledWith('p1', {
      requestId: request.id,
      revision: 1,
      allow: true,
    }),
  );
  await waitFor(() => expect(screen.queryByText('example.com · TCP 443')).toBeNull());
});

it('discovers new requests while the session remains open and allows denial', async () => {
  jest.useFakeTimers();
  const client = clientMock();
  client.getProjectEgress.mockResolvedValueOnce({ ...policy, requests: {} });
  render(<NetworkApprovalPrompt client={client as unknown as VerityClient} projectId="p1" />);
  await act(async () => {});
  expect(screen.queryByText('example.com · TCP 443')).toBeNull();
  await act(async () => jest.advanceTimersByTime(5000));
  expect(screen.getByText('example.com · TCP 443')).toBeTruthy();
  fireEvent.press(screen.getByText('Deny'));
  await waitFor(() =>
    expect(client.decideProjectEgress).toHaveBeenCalledWith('p1', {
      requestId: request.id,
      revision: 1,
      allow: false,
    }),
  );
});

it('requires an explicit review of changed policy before showing an allow button', async () => {
  const client = clientMock();
  client.getProjectEgress.mockResolvedValue({ ...policy, revision: 2 });
  render(<NetworkApprovalPrompt client={client as unknown as VerityClient} projectId="p1" />);
  await screen.findByText(/Network rules changed/);
  expect(screen.queryByText('Allow for one hour')).toBeNull();
  expect(client.decideProjectEgress).not.toHaveBeenCalled();
  client.getProjectEgress.mockResolvedValue({
    ...policy,
    revision: 3,
    requests: { target: { ...request, revision: 3 } },
  });
  fireEvent.press(screen.getByText('Review current request'));
  await waitFor(() =>
    expect(client.reopenProjectEgress).toHaveBeenCalledWith('p1', {
      target: request.target,
      revision: 2,
    }),
  );
  await screen.findByText('Allow for one hour');
  expect(client.decideProjectEgress).not.toHaveBeenCalled();
});

it('refreshes a conflicting decision and never retries the allow automatically', async () => {
  const client = clientMock();
  client.decideProjectEgress.mockRejectedValueOnce(new VerityApiError(409, 'stale'));
  render(<NetworkApprovalPrompt client={client as unknown as VerityClient} projectId="p1" />);
  await screen.findByText('Allow for one hour');
  fireEvent.press(screen.getByText('Allow for one hour'));
  await screen.findByText(/Network rules changed/);
  expect(client.decideProjectEgress).toHaveBeenCalledTimes(1);
});

it('does not carry a request over to a different project after a delayed fetch', async () => {
  const client = clientMock();
  let finish!: (value: typeof policy) => void;
  client.getProjectEgress.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  client.getProjectEgress.mockResolvedValue({ ...policy, requests: {} });
  const view = render(
    <NetworkApprovalPrompt client={client as unknown as VerityClient} projectId="p1" />,
  );
  view.rerender(
    <NetworkApprovalPrompt client={client as unknown as VerityClient} projectId="p2" />,
  );
  await act(async () => finish(policy));
  expect(screen.queryByText('example.com · TCP 443')).toBeNull();
});

it('keeps the reviewed target selected when another stale request becomes oldest', async () => {
  const client = clientMock();
  const second = {
    ...request,
    id: 'second',
    createdAt: 1,
    target: { ...request.target, host: 'second.example' },
  };
  client.getProjectEgress.mockResolvedValue({
    ...policy,
    revision: 2,
    requests: { target: request, second },
  });
  render(<NetworkApprovalPrompt client={client as unknown as VerityClient} projectId="p1" />);
  await screen.findByText('example.com · TCP 443');
  client.getProjectEgress.mockResolvedValue({
    ...policy,
    revision: 3,
    requests: {
      target: { ...request, id: 'reviewed', createdAt: 2, revision: 3 },
      second,
    },
  });
  fireEvent.press(screen.getByText('Review current request'));
  await screen.findByText('Allow for one hour');
  expect(screen.getByText('example.com · TCP 443')).toBeTruthy();
  fireEvent.press(screen.getByText('Allow for one hour'));
  await waitFor(() =>
    expect(client.decideProjectEgress).toHaveBeenCalledWith('p1', {
      requestId: 'reviewed',
      revision: 3,
      allow: true,
    }),
  );
});

it('requires explicit reopening of an expired request from an older server', async () => {
  const client = clientMock();
  client.getProjectEgress.mockResolvedValue({
    ...policy,
    requests: { target: { ...request, expiresAt: Date.now() - 1 } },
  });
  render(<NetworkApprovalPrompt client={client as unknown as VerityClient} projectId="p1" />);
  await screen.findByText(/This request expired/);
  expect(screen.queryByText('Allow for one hour')).toBeNull();
  expect(screen.queryByText('Deny')).toBeNull();
  client.getProjectEgress.mockResolvedValue({
    ...policy,
    requests: { target: { ...request, id: 'reopened', expiresAt: Date.now() + 60000 } },
  });
  fireEvent.press(screen.getByText('Review current request'));
  await waitFor(() =>
    expect(client.reopenProjectEgress).toHaveBeenCalledWith('p1', {
      target: request.target,
      revision: policy.revision,
    }),
  );
  await screen.findByText('Allow for one hour');
  expect(client.decideProjectEgress).not.toHaveBeenCalled();
});
