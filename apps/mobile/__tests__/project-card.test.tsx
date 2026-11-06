// The new design's project list (components/project/ProjectCard.tsx): one card
// per project that says what waits and what runs instead of listing sessions.
//
// What is worth guarding: the waiting count leaves out what the person
// dismissed (or the card disagrees with Home), a project with a page opens it,
// and a group without one shows its sessions in place.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../components/useProjectReorder', () => ({
  // Dragging is the classic list's machinery and has its own suite.
  useProjectRowDrag: () => ({
    slotRef: undefined,
    rowRef: undefined,
    handleCallbackRef: undefined,
    style: {},
  }),
}));

import {
  inboxItems,
  type ProjectRecord,
  type SessionSummary,
  type VerityClient,
} from '@verity/mobile';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ProjectCard, projectCardFacts, projectCardLine } from '../components/project/ProjectCard';
import { projectGroups } from '../lib/projectGroups';
import type { ProjectReorderController } from '../components/useProjectReorder';
import type { SessionProjectGroup } from '../lib/projectGroups';

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

function renderCard(item: SessionProjectGroup, onOpen?: () => void, expanded = false) {
  const onToggle = jest.fn();
  render(
    <ProjectCard
      group={item}
      client={{} as VerityClient}
      now={Date.now()}
      reorder={{ reportCompactHeight: jest.fn() } as unknown as ProjectReorderController}
      renderedOrder={[item.id]}
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
});
