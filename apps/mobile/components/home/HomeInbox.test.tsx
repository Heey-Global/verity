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
  return { randomUUID: () => `reply-${String((n += 1))}` };
});
jest.mock('../../lib/voiceShortcut', () => ({ dispatchTaskVoiceShortcut: jest.fn() }));
const mockCapture = { enabled: true, scope: 'account' as string | null };
jest.mock('../../lib/taskPreferences', () => ({
  useTaskPreferences: () => ({ enabled: mockCapture.enabled }),
}));
jest.mock('../../lib/tasksStore', () => ({ taskAccountScope: () => mockCapture.scope }));

import type { ProjectRecord, SessionSummary, UpcomingMeeting, VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { router } from 'expo-router';

import { dispatchTaskVoiceShortcut } from '../../lib/voiceShortcut';
import { HomeInbox, RESUME_PROMPT, replyFor } from './HomeInbox';

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
  extra: { selectedSessionId?: string } = {},
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
  expect(await screen.findByText('Which validation library?')).toBeTruthy();
  expect(screen.getByTestId('home-summary').props.children).toBe('1 question');
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Zod' }));
  });
  // Sent through the same idempotent route a notification reply uses.
  expect(client.sendTurn).toHaveBeenCalledWith('form', { prompt: 'Zod', clientReplyId: 'reply-1' });
  expect(screen.queryByText('Which validation library?')).toBeNull();
  expect(onCountChange).toHaveBeenLastCalledWith(0);
});

it('keeps an item when the answer could not be delivered', async () => {
  const client = fakeClient();
  client.sendTurn.mockRejectedValueOnce(new Error('network down'));
  await renderInbox([question], client);
  await screen.findByText('Which validation library?');
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Valibot' }));
  });
  expect(screen.getByText('Which validation library?')).toBeTruthy();
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
  const allow = await screen.findByRole('button', { name: 'Allow' });
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
  expect(await screen.findAllByText('Which validation library?')).toHaveLength(1);
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
  fireEvent.press(await screen.findByRole('button', { name: 'Repair' }));
  expect(onRepairProject).toHaveBeenCalledWith('broken');
  fireEvent.press(screen.getByRole('button', { name: 'Open' }));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/project/[id]', params: { id: 'broken' } });
});

it('sends "Tell Verity" to quick capture with the assistant preselected', async () => {
  await renderInbox([]);
  fireEvent.press(await screen.findByRole('button', { name: 'Tell Verity' }));
  expect(dispatchTaskVoiceShortcut).toHaveBeenCalledWith({ target: 'assistant' });
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

it('shows a permission’s whole input next to Allow, not just its summary', async () => {
  const command = Array.from({ length: 8 }, (_, i) => `step ${String(i)}`).join(' && ');
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
  await screen.findByRole('button', { name: 'Allow' });
  const request = screen.getByTestId('inbox-request');
  // Allow must never stand next to text the operator cannot read in full.
  expect(request.props.numberOfLines).toBeUndefined();
  expect(request.props.children).toContain('step 7');
  expect(request.props.children).toContain('hidden-detail');
});

describe('dismissing', () => {
  const dismissible = { ...question, inboxDismissed: [] as string[] };

  it('hides an item at once, saves it for the operator and keeps it out of the count', async () => {
    const { client, onCountChange } = await renderInbox([dismissible]);
    await screen.findByText('Which validation library?');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(client.setSessionInboxDismissed).toHaveBeenCalledWith(
      'form',
      expect.stringMatching(/^question:form/),
      true,
    );
    expect(screen.queryByText('Which validation library?')).toBeNull();
    expect(screen.getByTestId('home-summary').props.children).toBe('Nothing needs you right now.');
    expect(onCountChange).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole('button', { name: '1 hidden' })).toBeTruthy();
  });

  it('brings the card back with a message when saving fails', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const client = fakeClient();
    client.setSessionInboxDismissed.mockRejectedValueOnce(new Error('offline'));
    await renderInbox([dismissible], client);
    await screen.findByText('Which validation library?');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(screen.getByText('Which validation library?')).toBeTruthy();
    expect(alert).toHaveBeenCalledWith('Not hidden', expect.any(String));
    expect(screen.queryByRole('button', { name: '1 hidden' })).toBeNull();
  });

  it('shows what was dismissed elsewhere, muted, and restores it', async () => {
    const key = 'question:form:';
    // The key is derived from the question; read the live one off a first render.
    const first = await renderInbox([dismissible]);
    await screen.findByText('Which validation library?');
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
    expect(screen.queryByText('Which validation library?')).toBeNull();
    expect(onCountChange).toHaveBeenLastCalledWith(0);
    fireEvent.press(screen.getByRole('button', { name: '1 hidden' }));
    expect(screen.getByTestId('inbox-hidden-question')).toBeTruthy();
    // A dismissed item offers only Restore, never its answers.
    expect(screen.queryByRole('button', { name: 'Zod' })).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Restore' }));
    });
    expect(client.setSessionInboxDismissed).toHaveBeenCalledWith('form', savedKey, false);
    expect(screen.getByTestId('inbox-item-question')).toBeTruthy();
    expect(onCountChange).toHaveBeenLastCalledWith(1);
  });

  it('offers no X when the server cannot keep a dismissal', async () => {
    await renderInbox([question]);
    await screen.findByText('Which validation library?');
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
