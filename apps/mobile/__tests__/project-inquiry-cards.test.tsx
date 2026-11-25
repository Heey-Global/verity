import { AppState } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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

it('allows the concrete request once at its target project', async () => {
  const decideProjectInquiry = jest.fn().mockResolvedValue(undefined);
  const client = {
    listProjectInquiries: jest.fn().mockResolvedValue([inquiry]),
    decideProjectInquiry,
  } as unknown as VerityClient;
  const view = render(<ProjectInquiryCards client={client} />);
  await waitFor(() => expect(view.getByText('Allow once')).toBeTruthy());
  expect(view.getByText(inquiry.title)).toBeTruthy();
  expect(view.getByText(inquiry.body)).toBeTruthy();
  // A change is never allowed for good: each one needs its own decision.
  expect(view.queryByText('Always allow')).toBeNull();
  fireEvent.press(view.getByText('Allow once'));
  // Addressed to the target project: a pending request has no target session yet.
  await waitFor(() => expect(decideProjectInquiry).toHaveBeenCalledWith('cluster', 'i', 'approve'));
  await waitFor(() => expect(client.listProjectInquiries).toHaveBeenCalledTimes(2));
});

it('offers the decision in the asking session and says who asks whom', async () => {
  const decideProjectInquiry = jest.fn().mockResolvedValue(undefined);
  const question = {
    ...inquiry,
    kind: 'question',
    sourceProjectName: 'Verity',
    targetProjectName: 'Deep-OCR',
    sourceSessionName: 'Backup check',
  };
  const client = {
    listProjectInquiries: jest.fn().mockResolvedValue([question]),
    decideProjectInquiry,
  } as unknown as VerityClient;
  const asking = render(<ProjectInquiryCards client={client} sessionId="source" />);
  fireEvent.press(await asking.findByRole('button', { name: 'Project requests' }));
  expect(asking.getByText('Verity → Deep-OCR')).toBeTruthy();
  expect(asking.getByText('From this session · read-only')).toBeTruthy();
  fireEvent.press(asking.getByText('Always allow'));
  await waitFor(() =>
    expect(decideProjectInquiry).toHaveBeenCalledWith('cluster', 'i', 'approve_always'),
  );
  asking.unmount();
  const home = render(<ProjectInquiryCards client={client} />);
  await waitFor(() =>
    expect(home.getByText('From session „Backup check“ · read-only')).toBeTruthy(),
  );
  // No target session exists before the request is allowed.
  expect(home.queryByText('Open target session')).toBeNull();
});

it.each(['source', 'target'])(
  'keeps long requests behind one row in the %s session and closes their details',
  async (sessionId) => {
    const body = 'Review the staging service.\n'.repeat(100);
    const answer = 'The staging service is ready.\n'.repeat(100);
    const client = {
      listProjectInquiries: jest.fn().mockResolvedValue([
        { ...inquiry, body, status: 'queued' },
        { ...inquiry, id: 'answered', title: 'Inspect staging', answer, status: 'answered' },
      ]),
    } as unknown as VerityClient;
    const view = render(<ProjectInquiryCards client={client} sessionId={sessionId} />);

    const row = await view.findByRole('button', { name: 'Project requests', expanded: false });
    expect(view.getByText('2 requests')).toBeTruthy();
    expect(view.queryByText(body.trim())).toBeNull();
    expect(view.queryByText(answer.trim())).toBeNull();

    fireEvent.press(row);
    // Unclamped, a long request pushes its decision buttons below the sheet's fold.
    expect(view.getByText(body.trim()).props.numberOfLines).toBe(6);
    expect(view.getByText(answer.trim()).props.numberOfLines).toBe(6);
    fireEvent.press(view.getAllByRole('button', { name: 'Show full request' })[0]!);
    expect(view.getByText(body.trim()).props.numberOfLines).toBeUndefined();
    expect(view.getByText(answer.trim()).props.numberOfLines).toBe(6);
    fireEvent.press(view.getByRole('button', { name: 'Show less' }));
    expect(view.getByText(body.trim()).props.numberOfLines).toBe(6);

    fireEvent.press(view.getByTestId('sheet-scrim'));
    expect(view.queryByText(body.trim())).toBeNull();
    expect(view.queryByText(answer.trim())).toBeNull();
    expect(view.getByRole('button', { name: 'Project requests', expanded: false })).toBeTruthy();
  },
);

// The row is the only place left that announces a pending decision; a refresh
// failing after it loaded must not replace that with a load error.
it('keeps announcing pending approvals when a later refresh fails', async () => {
  const client = {
    listProjectInquiries: jest
      .fn()
      .mockResolvedValueOnce([inquiry])
      .mockRejectedValue(new Error('Network request failed')),
    decideProjectInquiry: jest.fn().mockResolvedValue(undefined),
  } as unknown as VerityClient;
  const view = render(<ProjectInquiryCards client={client} sessionId="source" />);
  fireEvent.press(await view.findByRole('button', { name: 'Project requests' }));
  // A short request is never clamped: without the toggle it could not be unfolded.
  expect(view.getByText(inquiry.body).props.numberOfLines).toBeUndefined();
  expect(view.queryByRole('button', { name: 'Show full request' })).toBeNull();
  fireEvent.press(view.getByText('Allow once'));
  await waitFor(() => expect(view.getByText('Network request failed')).toBeTruthy());
  expect(view.getByText('1 awaiting approval')).toBeTruthy();
  expect(view.queryByText('Could not load project requests')).toBeNull();
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
  try {
    const client = {
      listProjectInquiries: jest
        .fn()
        .mockRejectedValue(new VerityApiError(503, SERVER_MAINTENANCE_MESSAGE)),
    } as unknown as VerityClient;
    const view = render(<ProjectInquiryCards client={client} sessionId="target" />);
    fireEvent.press(await view.findByRole('button', { name: 'Project requests' }));
    expect(view.getByText('Project requests load once the server is back.')).toBeTruthy();
    expect(view.queryByText(SERVER_MAINTENANCE_MESSAGE)).toBeNull();
  } finally {
    act(() => serverConnection.reset());
  }
});
