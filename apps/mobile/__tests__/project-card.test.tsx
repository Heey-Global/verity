// The new design's project list (components/project/ProjectCard.tsx): one card
// per project that says what waits and what runs instead of listing sessions.
//
// What is worth guarding: the waiting count leaves out what the person
// dismissed (or the card disagrees with Home), a project with a page opens it,
// and a group without one shows its sessions in place.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../components/useProjectReorder', () => ({
  // Dragging is the classic list's machinery and has its own suite.
  useProjectRowDrag: jest.fn(() => ({
    slotRef: undefined,
    rowRef: undefined,
    handleCallbackRef: undefined,
    style: {},
  })),
}));

import {
  inboxItems,
  type ProjectRecord,
  type SessionSummary,
  type VerityClient,
} from '@verity/mobile';
import { fireEvent, render, screen, within } from '@testing-library/react-native';

import { ProjectCard, projectCardFacts, projectCardLine } from '../components/project/ProjectCard';
import { projectGroups } from '../lib/projectGroups';
import type { ProjectReorderController } from '../components/useProjectReorder';
import type { SessionProjectGroup } from '../lib/projectGroups';
import { useProjectRowDrag } from '../components/useProjectReorder';

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
    inboxDismissed: [],
    ...over,
  };
}

const ask = (id: string, over: Partial<SessionSummary> = {}) =>
  session(id, {
    status: 'awaiting_input',
    openChoices: { question: `Question in ${id}?`, options: [{ label: 'Yes' }] },
    ...over,
  });

const project = {
  id: 'p1',
  owner: 'acme',
  repo: 'website',
  containerName: 'c',
  kind: 'github',
  imageRef: null,
  state: 'active',
  provisionError: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  inboxDismissed: [],
} as ProjectRecord;

function group(sessions: SessionSummary[], over: Partial<SessionProjectGroup> = {}) {
  return {
    id: 'p1',
    title: 'website',
    subtitle: 'v1.2.0',
    portLinks: [],
    project,
    sessions,
    ...over,
  } as SessionProjectGroup;
}

function renderCard(
  item: SessionProjectGroup,
  onOpen?: () => void,
  expanded = false,
  unread: ReadonlySet<string> = new Set(),
  onMove = jest.fn(),
  { sortable = true, reordering = false } = {},
) {
  const onToggle = jest.fn();
  render(
    <ProjectCard
      group={item}
      client={{} as VerityClient}
      now={Date.now()}
      unread={unread}
      reorder={{ reportCompactHeight: jest.fn() } as unknown as ProjectReorderController}
      renderedOrder={['before', item.id, 'after']}
      onMove={onMove}
      sortable={sortable}
      reordering={reordering}
      expanded={expanded}
      onOpen={onOpen}
      onToggle={onToggle}
      onOpenSession={jest.fn()}
      onSessionChanged={jest.fn()}
    />,
  );
  return { onToggle };
}

describe('project card facts', () => {
  it('counts waiting items without the ones the person dismissed', () => {
    const later = ask('b');
    // The key the inbox derives for that question, as Home would save it.
    const keys = inboxItems({ sessions: [later], projects: [project], now: Date.now() }).map(
      (item) => item.key,
    );
    expect(projectCardFacts(group([ask('a'), later]), Date.now()).waiting).toBe(2);
    const facts = projectCardFacts(
      group([ask('a'), { ...later, inboxDismissed: keys }]),
      Date.now(),
    );
    expect(facts.waiting).toBe(1);
  });

  it('counts sessions that work or wait as running', () => {
    const facts = projectCardFacts(
      group([session('a', { status: 'running' }), ask('b'), session('c')]),
      Date.now(),
    );
    expect(facts.running).toBe(2);
  });

  // A working session's unread mark gives way to its working one in the session
  // rows; counting it here would light the card blue for work still running.
  it('counts only idle unread sessions as new and notes any working one', () => {
    const sessions = [
      session('a', { status: 'running' }),
      session('b'),
      session('c'),
      session('d', { backgroundWorking: true }),
    ];
    const facts = projectCardFacts(group(sessions), Date.now(), new Set(['a', 'b', 'd']));
    expect(facts.fresh).toBe(1);
    expect(facts.working).toBe(true);
    const idle = projectCardFacts(group([session('b')]), Date.now(), new Set(['b']));
    expect(idle.working).toBe(false);
    const item = group([session('b'), session('c')]);
    expect(projectCardLine(item, projectCardFacts(item, Date.now(), new Set(['b'])))).toBe('1 new');
  });

  it('names the project’s own problem as its health', () => {
    const facts = projectCardFacts(
      group([], { health: { label: 'Needs repair', tone: 'danger' } }),
      Date.now(),
    );
    expect(facts.health).toEqual({ label: 'Needs repair', intent: 'needsSetup' });
  });

  // The project page's Security row shows findings; a red tag on every card
  // repeated them. The project's own problems still show.
  it('leaves vulnerabilities to the project page but keeps a broken sandbox', () => {
    const vulnerable = { ...project, vulnerabilitySummary: { count: 3, critical: 1, high: 2 } };
    const [quiet] = projectGroups([vulnerable], [], new Map(), new Map(), null);
    expect(quiet!.status?.label).toBe('3 vulnerable packages');
    expect(projectCardFacts(quiet!, Date.now()).health).toBeUndefined();
    const [broken] = projectGroups(
      [{ ...vulnerable, state: 'failed', provisionError: 'Sandbox container stopped' }],
      [],
      new Map(),
      new Map(),
      null,
    );
    expect(projectCardFacts(broken!, Date.now()).health?.intent).toBe('needsSetup');
  });

  it('falls back to the session count and then the metadata', () => {
    const quiet = group([session('a'), session('b')]);
    expect(projectCardLine(quiet, projectCardFacts(quiet, Date.now()))).toBe('2 sessions');
    const empty = group([]);
    expect(projectCardLine(empty, projectCardFacts(empty, Date.now()))).toBe('v1.2.0');
  });
});

describe('project card', () => {
  // A held press on the card is the only way in: no separate sort mode, so the
  // drag target must stay registered while the card is at rest.
  it('registers the card as a drag target and still opens on a tap', () => {
    const onOpen = jest.fn();
    renderCard(group([]), onOpen);
    expect(jest.mocked(useProjectRowDrag)).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.queryByTestId('project-card-handle-p1')).toBeNull();
    fireEvent.press(screen.getByLabelText(/^website,/));
    expect(onOpen).toHaveBeenCalled();
  });

  it('leaves a card that cannot move out of the drag', () => {
    renderCard(group([]), jest.fn(), false, new Set(), jest.fn(), { sortable: false });
    expect(jest.mocked(useProjectRowDrag)).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.getByLabelText(/^website,/).props.accessibilityActions).toEqual([]);
  });

  it('swaps the chevron for a handle and ignores taps while a card moves', () => {
    const onOpen = jest.fn();
    renderCard(group([]), onOpen, false, new Set(), jest.fn(), { reordering: true });
    expect(screen.getByTestId('project-card-handle-p1')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Move website'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('neither toggles an in-place group nor moves it while a card moves', () => {
    const onMove = jest.fn();
    const { onToggle } = renderCard(group([]), undefined, false, new Set(), onMove, {
      reordering: true,
    });
    const card = screen.getByLabelText('Move website');
    fireEvent.press(card);
    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'moveUp' } });
    expect(onToggle).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });

  it('moves one slot at a time through accessibility actions', () => {
    const onMove = jest.fn();
    renderCard(group([]), jest.fn(), false, new Set(), onMove);
    const card = screen.getByLabelText(/^website,/);
    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'moveUp' } });
    expect(onMove).toHaveBeenLastCalledWith(['p1', 'before', 'after']);
    fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'moveDown' } });
    expect(onMove).toHaveBeenLastCalledWith(['before', 'after', 'p1']);
  });

  it('opens the project page instead of listing sessions', () => {
    const onOpen = jest.fn();
    renderCard(group([ask('a'), session('b', { status: 'running' })]), onOpen);
    expect(screen.getByTestId('project-card-line-p1')).toHaveTextContent(
      '1 waiting for you · 2 running',
    );
    expect(screen.queryByTestId('project-work')).toBeNull();
    fireEvent.press(screen.getByLabelText(/^website,/));
    expect(onOpen).toHaveBeenCalled();
  });

  // The marks are the card's only cue at a glance; one in the wrong tone says
  // "new" for running work or hides the work entirely.
  it('marks working before new, and leaves new to the waiting count', () => {
    renderCard(
      group([session('a', { status: 'running' }), session('b')]),
      jest.fn(),
      false,
      new Set(['b']),
    );
    expect(screen.getByLabelText('Agent is working')).toBeTruthy();
    expect(screen.queryByLabelText('Unread messages')).toBeNull();
    screen.unmount();

    renderCard(group([session('b')]), jest.fn(), false, new Set(['b']));
    expect(screen.getByLabelText('Unread messages')).toBeTruthy();
    expect(screen.queryByTestId('project-card-waiting-p1')).toBeNull();
    screen.unmount();

    renderCard(group([ask('a'), session('b')]), jest.fn(), false, new Set(['b']));
    expect(screen.queryByTestId('project-card-mark-p1')).toBeNull();
    expect(screen.getByLabelText('1 waiting for you')).toBeTruthy();
    screen.unmount();

    renderCard(group([session('c')]), jest.fn());
    expect(screen.queryByTestId('project-card-mark-p1')).toBeNull();
    expect(screen.queryByTestId('project-card-waiting-p1')).toBeNull();
  });

  it('shows the project’s own work as working, not as a spinner', () => {
    renderCard(group([], { health: { label: 'Updating security', tone: 'working' } }), jest.fn());
    expect(screen.getByLabelText('Updating security')).toBeTruthy();
    expect(screen.queryByLabelText('Updating security, in progress')).toBeNull();
  });

  it('shows the sessions of a group without a page in place', () => {
    const other = group([session('loose', { projectId: null })], {
      id: 'default',
      title: 'Other sessions',
      project: undefined,
    });
    const { onToggle } = renderCard(other, undefined, true);
    expect(screen.getByTestId('project-work')).toBeTruthy();
    expect(screen.getByLabelText(/^loose/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText(/^Other sessions,/));
    expect(onToggle).toHaveBeenCalled();
  });

  it('keeps a waiting session in Now without the page’s feed', () => {
    // The card passes no inbox feed; without its own items a session waiting
    // for an answer would drop out of Now while the head counts it.
    const other = group([ask('loose')], {
      id: 'default',
      title: 'Other sessions',
      project: undefined,
    });
    renderCard(other, undefined, true);
    fireEvent.press(screen.getByRole('tab', { name: 'Now · 1' }));
    const needs = screen.getByTestId('work-needs-you');
    expect(within(needs).getByLabelText(/^loose, .*Question$/)).toBeTruthy();
    // Answers need the feed that sends them, which only the page holds.
    expect(within(needs).queryByRole('button', { name: 'Yes' })).toBeNull();
  });
});
