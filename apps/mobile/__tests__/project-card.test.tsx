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
  PROJECT_IMAGE_REBUILDING_WARNING,
  inboxItems,
  type ProjectRecord,
  type SessionSummary,
  type VerityClient,
} from '@verity/mobile';
import { fireEvent, render, screen, within } from '@testing-library/react-native';

import { AGENT_MARK } from '../components/AgentMark';
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
  sorting = false,
  onMove = jest.fn(),
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
      sorting={sorting}
      onMove={onMove}
      sortable
      reordering={false}
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
    expect(facts.mark).toBe('working');
    const idle = projectCardFacts(group([session('b')]), Date.now(), new Set(['b']));
    expect(idle.mark).toBe('unread');
    const item = group([session('b'), session('c')]);
    expect(projectCardLine(item, projectCardFacts(item, Date.now(), new Set(['b'])))).toBe('1 new');
  });

  // A broken sandbox is the state's to say. Counted as waiting as well, it put
  // "1 waiting for you" and a "?" beside "Needs repair" for the same problem.
  it('says a failed project needs repair once, with the short reason', () => {
    const failed = {
      ...project,
      state: 'failed',
      provisionError: 'Sandbox container stopped — Repair to restart it.',
    } as ProjectRecord;
    expect(inboxItems({ sessions: [], projects: [failed], now: Date.now() })).not.toEqual([]);
    const item = group([], { project: failed });
    const facts = projectCardFacts(item, Date.now());
    expect(facts.state.state).toBe('error');
    expect(facts.waiting).toBe(0);
    expect(facts.mark).toBeUndefined();
    expect(projectCardLine(item, facts)).toBe('Needs repair · Sandbox container stopped');
  });

  // The project page's Security row shows findings; a red note on every card
  // repeated them. The project's own problems still show.
  it('leaves vulnerabilities to the project page but keeps a broken sandbox', () => {
    const vulnerable = { ...project, vulnerabilitySummary: { count: 3, critical: 1, high: 2 } };
    const [quiet] = projectGroups([vulnerable], [], new Map(), new Map(), null);
    expect(quiet!.status?.label).toBe('3 vulnerable packages');
    expect(projectCardFacts(quiet!, Date.now()).state).toEqual({ state: 'running' });
    const [broken] = projectGroups(
      [{ ...vulnerable, state: 'failed', provisionError: 'Sandbox container stopped' }],
      [],
      new Map(),
      new Map(),
      null,
    );
    expect(projectCardFacts(broken!, Date.now()).state.state).toBe('error');
  });

  it('falls back to the session count and then the metadata', () => {
    const quiet = group([session('a'), session('b')]);
    expect(projectCardLine(quiet, projectCardFacts(quiet, Date.now()))).toBe('2 sessions');
    const empty = group([]);
    expect(projectCardLine(empty, projectCardFacts(empty, Date.now()))).toBe('v1.2.0');
  });
});

describe('project card', () => {
  it('offers a handle only in sort mode and moves through its accessibility actions', () => {
    const onOpen = jest.fn();
    const onMove = jest.fn();
    renderCard(group([]), onOpen, false, new Set(), true, onMove);
    const handle = screen.getByRole('adjustable', { name: 'Move website' });
    expect(jest.mocked(useProjectRowDrag)).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(onMove).toHaveBeenLastCalledWith(['p1', 'before', 'after']);
    fireEvent(handle, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(onMove).toHaveBeenLastCalledWith(['before', 'after', 'p1']);
    fireEvent.press(screen.getByLabelText(/^website,/));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not register a project drag target outside sort mode', () => {
    renderCard(group([]), jest.fn());
    expect(screen.queryByRole('adjustable')).toBeNull();
    expect(jest.mocked(useProjectRowDrag)).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('does not toggle an in-place group while sorting', () => {
    const { onToggle } = renderCard(group([]), undefined, false, new Set(), true);
    fireEvent.press(screen.getByLabelText(/^website,/));
    expect(onToggle).not.toHaveBeenCalled();
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

  // The corner is the card's only cue at a glance and must say what the most
  // urgent session row says: one in the wrong tone says "new" for running work,
  // or hides that someone is waiting.
  it('marks waiting before working before new, as the session rows do', () => {
    renderCard(
      group([session('a', { status: 'running' }), session('b')]),
      jest.fn(),
      false,
      new Set(['b']),
    );
    expect(screen.getByTestId('project-card-mark-p1')).toHaveProp(
      'accessibilityLabel',
      AGENT_MARK.working.label,
    );
    screen.unmount();

    renderCard(group([session('b')]), jest.fn(), false, new Set(['b']));
    expect(screen.getByTestId('project-card-mark-p1')).toHaveProp(
      'accessibilityLabel',
      AGENT_MARK.unread.label,
    );
    screen.unmount();

    renderCard(
      group([ask('a'), session('b', { status: 'running' })]),
      jest.fn(),
      false,
      new Set(['b']),
    );
    expect(screen.getByTestId('project-card-mark-p1')).toHaveProp(
      'accessibilityLabel',
      AGENT_MARK.question.label,
    );
    // Said in words in the line, not as a count badge beside the chevron.
    expect(screen.queryByLabelText('1 waiting for you')).toBeNull();
    expect(screen.getByTestId('project-card-line-p1')).toHaveTextContent(/^1 waiting for you/);
    screen.unmount();

    renderCard(group([session('c')]), jest.fn());
    expect(screen.queryByTestId('project-card-mark-p1')).toBeNull();
  });

  // Right after a Server deploy every project updates at once; a card that
  // changes for it lights up the whole list for something nobody has to do.
  it('keeps a running card unchanged while Verity works on its sandbox', () => {
    const busy = {
      ...project,
      provisionWarning: PROJECT_IMAGE_REBUILDING_WARNING,
      sandboxUpdate: { state: 'available', selfRepair: 'converging', turnBlocked: false },
    } as ProjectRecord;
    renderCard(group([session('a')], { project: busy }), jest.fn());
    expect(screen.getByLabelText(/^website, Running, /)).toBeTruthy();
    expect(screen.getByTestId('project-card-line-p1')).toHaveTextContent('1 session');
    expect(screen.queryByLabelText(/in progress$/)).toBeNull();
  });

  it('names the state in the spoken label and the line, without a tag', () => {
    const failed = {
      ...project,
      state: 'failed',
      provisionError: 'Sandbox container stopped',
    } as ProjectRecord;
    renderCard(group([], { project: failed }), jest.fn());
    expect(screen.getByLabelText(/^website, Error, /)).toBeTruthy();
    expect(screen.getByTestId('project-card-line-p1')).toHaveTextContent(
      'Needs repair · Sandbox container stopped',
    );
    expect(screen.queryByLabelText(/, needs setup$/)).toBeNull();
    screen.unmount();

    const sleeping = { ...project, lifecycleState: 'sleeping' } as ProjectRecord;
    renderCard(group([session('a')], { project: sleeping }), jest.fn());
    expect(screen.getByLabelText(/^website, Not running, /)).toBeTruthy();
    expect(screen.getByTestId('project-card-line-p1')).toHaveTextContent('1 session · asleep');
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
