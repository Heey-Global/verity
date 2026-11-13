import { AppState } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { SessionRepositories } from '../components/project/SessionRepositories';
import { ProjectInquiryCards } from '../components/project/ProjectInquiryCards';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(effect, [effect]);
  },
}));

jest.mock('../lib/useScanResource', () => ({
  useScanResource: (load: () => Promise<unknown>) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const [data, setData] = React.useState<unknown>();
    React.useEffect(() => {
      void load().then(setData);
    }, [load]);
    return { data, error: undefined, setError: jest.fn(), reload: jest.fn() };
  },
}));

const initialAppState = AppState.currentState;
beforeEach(() => {
  AppState.currentState = 'active';
});
afterEach(() => {
  AppState.currentState = initialAppState;
  jest.restoreAllMocks();
});

const inquiry = {
  id: 'i',
  sourceSessionId: 'source',
  targetSessionId: 'target',
  sourceProjectId: 'app',
  targetProjectId: 'cluster',
  title: 'Create service',
  body: 'Create a staging service',
  kind: 'change',
  status: 'pending',
  createdAt: '2026-11-06',
  answer: null,
};

it('approves the concrete request at the target session', async () => {
  const decideProjectInquiry = jest.fn().mockResolvedValue(undefined);
  const client = {
    listProjectInquiries: jest.fn().mockResolvedValue([inquiry]),
    decideProjectInquiry,
  } as unknown as VerityClient;
  const view = render(<ProjectInquiryCards client={client} sessionId="target" />);
  await waitFor(() => expect(view.getByText('Approve change')).toBeTruthy());
  fireEvent.press(view.getByText('Approve change'));
  await waitFor(() => expect(decideProjectInquiry).toHaveBeenCalledWith('target', 'i', 'approve'));
  await waitFor(() => expect(client.listProjectInquiries).toHaveBeenCalledTimes(2));
});

it('shows source-side status without offering target approval', async () => {
  const client = {
    listProjectInquiries: jest.fn().mockResolvedValue([inquiry]),
  } as unknown as VerityClient;
  const view = render(<ProjectInquiryCards client={client} sessionId="source" />);
  await waitFor(() => expect(view.getByText('Create service')).toBeTruthy());
  expect(view.queryByText('Approve change')).toBeNull();
});

it('shows persisted PR dependencies beside the repository workspace', async () => {
  const client = {
    listSessionRepositories: jest.fn().mockResolvedValue([
      {
        id: 'module',
        name: 'Consumer',
        owner: 'team',
        repo: 'consumer',
        isDefault: false,
        removedAt: null,
        workspace: {
          worktree: '/consumer',
          branch: 'feat/service',
          pullRequest: {
            number: 4,
            state: 'open',
            url: 'https://github.com/team/consumer/pull/4',
            dependsOn: ['https://github.com/team/api/pull/1'],
          },
        },
      },
    ]),
  } as unknown as VerityClient;
  const view = render(<SessionRepositories client={client} sessionId="source" />);
  await waitFor(() =>
    expect(view.getByText('Depends on: https://github.com/team/api/pull/1')).toBeTruthy(),
  );
  expect(view.getByText('/consumer')).toBeTruthy();
});

it('requests pending approvals within the displayed project before the server limit', async () => {
  const listProjectInquiries = jest.fn().mockResolvedValue([]);
  const client = { listProjectInquiries } as unknown as VerityClient;
  render(<ProjectInquiryCards client={client} projectId="target-project" />);
  await waitFor(() =>
    expect(listProjectInquiries).toHaveBeenCalledWith(undefined, 'target-project'),
  );
});

// A failed query must stay visible, or a pending approval looks absent. During
// an outage the header's bar owns the error, but the card still says the
// requests are missing — just without the raw 503 and a second retry.
it('still says requests are missing while the server is away', async () => {
  const { SERVER_MAINTENANCE_MESSAGE, VerityApiError } =
    jest.requireActual<typeof import('@verity/mobile')>('@verity/mobile');
  const { serverConnection } =
    jest.requireActual<typeof import('../lib/serverConnection')>('../lib/serverConnection');
  serverConnection.reportFailure('maintenance', SERVER_MAINTENANCE_MESSAGE);
  const client = {
    listProjectInquiries: jest
      .fn()
      .mockRejectedValue(new VerityApiError(503, SERVER_MAINTENANCE_MESSAGE)),
  } as unknown as VerityClient;
  const view = render(<ProjectInquiryCards client={client} sessionId="target" />);
  await waitFor(() =>
    expect(view.getByText('Project requests load once the server is back.')).toBeTruthy(),
  );
  expect(view.queryByText(SERVER_MAINTENANCE_MESSAGE)).toBeNull();
  serverConnection.reset();
});
