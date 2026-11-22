// The project's state on its page (components/project/ProjectPage.tsx) next to
// its card in the list (components/project/ProjectCard.tsx).
//
// What is worth guarding: opening a project must not change its colour, which
// it did while the page drew a fixed blue tile, so a project starting up or
// broken looked fine once opened; and a project on its way up says so beside
// its name with a spinner, while a broken one leaves the reason to Needs you.
jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../lib/taskPreferences', () => ({ useTaskPreferences: () => ({ enabled: true }) }));
jest.mock('../lib/tasksStore', () => ({
  taskAccountScope: () => null,
  useTasks: () => ({ tasks: [], pending: [], conflicts: [] }),
}));
jest.mock('../lib/sessionLayout', () => ({
  sessionLayout: () => ({ wide: false, sidebarWidth: 320 }),
}));
jest.mock('../components/useProjectReorder', () => ({
  PROJECT_PICKUP_DELAY_MS: 260,
  useProjectRowDrag: jest.fn(() => ({
    slotRef: undefined,
    rowRef: undefined,
    handleCallbackRef: undefined,
    style: {},
  })),
}));

import {
  projectCardState,
  type ProjectLifecycleState,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';
import { act, render, screen, within } from '@testing-library/react-native';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { ProjectCard } from '../components/project/ProjectCard';
import { ProjectPage } from '../components/project/ProjectPage';
import { PROJECT_STATE_WORD } from '../components/project/ProjectStateTile';
import type { ProjectReorderController } from '../components/useProjectReorder';
import type { SessionProjectGroup } from '../lib/projectGroups';
import { makeClient, makeDetail } from './support/projectHarness';
import { mockCreateVerityClient, resetSettingsHarness } from './support/settingsHarness';

type Lifecycle = Pick<ProjectRecord, 'lifecycleState' | 'provisionError'>;

// One of each kind the card tells apart: running, on its way, resting, broken.
const CASES: readonly [string, Lifecycle][] = [
  ['running', { lifecycleState: 'active' satisfies ProjectLifecycleState, provisionError: null }],
  ['starting', { lifecycleState: 'container_starting', provisionError: null }],
  ['waking', { lifecycleState: 'waking', provisionError: null }],
  ['asleep', { lifecycleState: 'sleeping', provisionError: null }],
  [
    'broken',
    {
      lifecycleState: 'failed',
      provisionError: 'Sandbox container stopped — Repair to restart it.',
    },
  ],
];

function projectWith(lifecycle: Lifecycle): ProjectRecord {
  return { ...makeDetail().project, state: 'active', ...lifecycle };
}

/** The tile's ground and its initial's colour, as drawn. */
function tileColours(testID: string) {
  const tile = screen.getByTestId(testID);
  const initial = within(tile).getByText(/^[A-Z?]$/);
  return {
    ground: StyleSheet.flatten(tile.props.style).backgroundColor as unknown,
    initial: StyleSheet.flatten(initial.props.style).color as unknown,
  };
}

function cardColours(project: ProjectRecord) {
  const group = {
    id: project.id,
    title: 'verity',
    subtitle: '',
    portLinks: [],
    project,
    sessions: [],
  } as unknown as SessionProjectGroup;
  const view = render(
    <ProjectCard
      group={group}
      client={{} as VerityClient}
      now={Date.now()}
      unread={new Set()}
      reorder={{ reportCompactHeight: jest.fn() } as unknown as ProjectReorderController}
      renderedOrder={[group.id]}
      sortable={false}
      reordering={false}
      expanded={false}
      onOpen={jest.fn()}
      onToggle={jest.fn()}
      onOpenSession={jest.fn()}
      onSessionChanged={jest.fn()}
    />,
  );
  const colours = tileColours(`project-card-tile-${group.id}`);
  view.unmount();
  return colours;
}

async function renderPage(project: ProjectRecord) {
  const detail = { ...makeDetail(), project, sessions: [] };
  const client = makeClient({ detail }) as unknown as Record<string, unknown>;
  Object.assign(client, {
    listProjectKnowledgeFiles: jest
      .fn()
      .mockResolvedValue({ root: 'project', path: '', entries: [], truncated: false }),
    getProjectWiki: jest.fn().mockResolvedValue(null),
    setProjectInboxDismissed: jest.fn(async () => [] as string[]),
  });
  const verity = client as unknown as VerityClient;
  // The knowledge browser opens its own client, as its settings route does.
  mockCreateVerityClient.mockReturnValue(verity);
  render(<ProjectPage client={verity} projectId="p/1" onOpenSession={jest.fn()} />);
  await screen.findByTestId('project-line');
  await act(async () => undefined);
}

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('the project page tile', () => {
  it.each(CASES)('has the colour of the card while %s', async (_name, lifecycle) => {
    const project = projectWith(lifecycle);
    const card = cardColours(project);
    await renderPage(project);
    expect(tileColours('project-state-tile')).toEqual(card);
    // The colour is not the only carrier of the state.
    expect(screen.getByTestId('project-state-tile').props.accessibilityLabel).toBe(
      PROJECT_STATE_WORD[projectCardState(project).state],
    );
  });

  // Without this the colour comparison above passes with every tile the same.
  it('tells the states apart', () => {
    const grounds = new Set(
      CASES.map(([, lifecycle]) => cardColours(projectWith(lifecycle)).ground),
    );
    expect(grounds.size).toBe(
      new Set(CASES.map(([, l]) => projectCardState(projectWith(l)).state)).size,
    );
  });
});

describe('the state beside the project name', () => {
  it.each(CASES)('while %s', async (_name, lifecycle) => {
    const project = projectWith(lifecycle);
    const note = projectCardState(project).note;
    await renderPage(project);
    const shown = screen.queryByTestId('project-state-note');
    // A note that asks for something belongs to Needs you, which says what to
    // do; repeating it beside the name only says it twice.
    if (note === undefined || note.tone === 'attention') {
      expect(shown).toBeNull();
      return;
    }
    expect(shown).not.toBeNull();
    expect(within(shown!).getByText(note.label)).toBeTruthy();
    // A spinner on a sleeping project would say it is about to change.
    expect(within(shown!).UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(
      note.transient ? 1 : 0,
    );
  });
});
