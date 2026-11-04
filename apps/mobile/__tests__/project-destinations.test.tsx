import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type VerityClient, VerityApiError } from '@verity/mobile';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import { ProjectDestinations } from '../components/settings/ProjectDestinations';

const target = { host: 'example.com', protocol: 'tcp' as const, port: 443 };
const request = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: 7,
  target,
  requestedBy: ['sandbox'],
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  status: 'pending' as const,
};
const grant = {
  id: '22222222-2222-4222-8222-222222222222',
  target: { host: 'dns.example.com', protocol: 'udp' as const, port: 53 },
  approvedBy: 'user',
  approvedAt: Date.now(),
  expiresAt: null,
};
const policy = { revision: 7, requests: { example: request }, grants: [grant] };
function setup() {
  const client = {
    getProjectEgress: jest.fn().mockResolvedValue(policy),
    decideProjectEgress: jest.fn().mockResolvedValue(undefined),
    revokeProjectEgress: jest.fn().mockResolvedValue(undefined),
  };
  const view = render(
    <ProjectDestinations client={client as unknown as VerityClient} projectId="project-a" />,
  );
  return { client, view };
}

it('renders exact targets and sends current revisions for allow, deny and revoke', async () => {
  const { client } = setup();
  await screen.findByText('example.com · TCP 443');
  expect(screen.getByText(/send data to that exact host/)).toBeTruthy();
  expect(screen.getByText('No expiry')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Allow example.com · TCP 443 for one hour'));
  await waitFor(() => expect(client.getProjectEgress).toHaveBeenCalledTimes(2));
  expect(client.decideProjectEgress).toHaveBeenLastCalledWith('project-a', {
    requestId: request.id,
    revision: 7,
    allow: true,
  });
  fireEvent.press(screen.getByLabelText('Deny example.com · TCP 443'));
  await waitFor(() => expect(client.getProjectEgress).toHaveBeenCalledTimes(3));
  expect(client.decideProjectEgress).toHaveBeenLastCalledWith('project-a', {
    requestId: request.id,
    revision: 7,
    allow: false,
  });
  fireEvent.press(screen.getByLabelText('Revoke dns.example.com · UDP 53'));
  await waitFor(() => expect(client.getProjectEgress).toHaveBeenCalledTimes(4));
  expect(client.revokeProjectEgress).toHaveBeenCalledWith('project-a', {
    grantId: grant.id,
    revision: 7,
  });
});

it('reloads stale rules without replaying the decision', async () => {
  const { client } = setup();
  await screen.findByText('example.com · TCP 443');
  client.decideProjectEgress.mockRejectedValueOnce(new VerityApiError(409, 'stale'));
  client.getProjectEgress.mockResolvedValueOnce({ revision: 8, requests: {}, grants: [] });
  fireEvent.press(screen.getByLabelText('Allow example.com · TCP 443 for one hour'));
  await screen.findByText(/Review the refreshed list before deciding again/);
  await screen.findByText('No pending destination requests.');
  expect(client.decideProjectEgress).toHaveBeenCalledTimes(1);
});

it('blocks further actions after management permission is denied', async () => {
  const { client } = setup();
  await screen.findByText('example.com · TCP 443');
  client.decideProjectEgress.mockRejectedValueOnce(new VerityApiError(403, 'forbidden'));
  fireEvent.press(screen.getByLabelText('Deny example.com · TCP 443'));
  await screen.findByText('Managing destination rules requires project management permission.');
  await waitFor(() => expect(client.getProjectEgress).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Revoke dns.example.com · UDP 53')).toBeDisabled();
});

it('hides stale project rules when a reload loses read permission', async () => {
  const { client } = setup();
  await screen.findByText('example.com · TCP 443');
  client.getProjectEgress.mockRejectedValueOnce(new VerityApiError(403, 'forbidden'));
  fireEvent.press(screen.getByText('Refresh destinations'));
  await screen.findByText('You do not have permission to view destination rules.');
  expect(screen.queryByText('example.com · TCP 443')).toBeNull();
});

it('requires explicit reopening when another policy change made a card stale', async () => {
  const client = {
    getProjectEgress: jest.fn().mockResolvedValue({ ...policy, revision: 8 }),
    reopenProjectEgress: jest.fn().mockResolvedValue(undefined),
    decideProjectEgress: jest.fn(),
  };
  render(<ProjectDestinations client={client as unknown as VerityClient} projectId="project-a" />);
  await screen.findByText('Requests needing review');
  expect(screen.queryByLabelText('Allow example.com · TCP 443 for one hour')).toBeNull();
  client.getProjectEgress.mockResolvedValueOnce({
    ...policy,
    revision: 9,
    requests: { example: { ...request, revision: 9 } },
  });
  fireEvent.press(screen.getByLabelText('Request approval again for example.com · TCP 443'));
  await screen.findByLabelText('Allow example.com · TCP 443 for one hour');
  expect(client.reopenProjectEgress).toHaveBeenCalledWith('project-a', { target, revision: 8 });
  expect(client.decideProjectEgress).not.toHaveBeenCalled();
});

it('never renders a late response for a different project', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const client = {
    getProjectEgress: jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ revision: 0, requests: {}, grants: [] }),
  };
  const view = render(
    <ProjectDestinations client={client as unknown as VerityClient} projectId="project-a" />,
  );
  view.rerender(
    <ProjectDestinations client={client as unknown as VerityClient} projectId="project-b" />,
  );
  await screen.findByText('No pending destination requests.');
  finish?.(policy);
  await waitFor(() => expect(screen.queryByText('example.com · TCP 443')).toBeNull());
  expect(client.getProjectEgress.mock.calls.map(([projectId]) => projectId)).toEqual([
    'project-a',
    'project-b',
  ]);
});
