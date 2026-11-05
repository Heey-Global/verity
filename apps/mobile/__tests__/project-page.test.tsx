// The project page of the new design (components/project/ProjectPage.tsx) and the
// `/project/[id]` route that chooses between it and the project settings.
//
// What is worth guarding: the switch decides which world a project link opens,
// and a device with the preview on must not land on the old one while its
// choice loads; the page's "For you" block shows exactly this project's items
// and answers them through the same save as Home; Work filters by what a
// session is doing; Knowledge moves off the settings index only with the switch.
jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('expo-router', () => ({
  ...require('./support/settingsHarness').expoRouterMock(),
  Redirect: ({ href }: { href: unknown }) => {
    require('./support/settingsHarness').mockReplace(href);
    return null;
  },
}));
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('expo-crypto', () => ({ randomUUID: () => 'reply-1' }));
jest.mock('../lib/voiceShortcut', () => ({ dispatchTaskVoiceShortcut: jest.fn() }));
jest.mock('../lib/taskPreferences', () => ({ useTaskPreferences: () => ({ enabled: false }) }));
jest.mock('../lib/tasksStore', () => ({ taskAccountScope: () => null }));
const mockDesign = { value: true as boolean | undefined };
const mockWide = { value: false };
jest.mock('../lib/sessionLayout', () => ({
  sessionLayout: () => ({ wide: mockWide.value, sidebarWidth: 320 }),
}));
jest.mock('../lib/homePreferences', () => ({
  useNewDesign: () => mockDesign.value === true,
  useNewDesignChoice: () => mockDesign.value,
}));

import type { SessionSummary, VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

import ProjectEntry from '../app/project/[id]/index';
import ProjectSettingsIndexScreen from '../app/project/[id]/settings/index';
import { ProjectPage, projectInboxItems, projectLine } from '../components/project/ProjectPage';
import { workFilter } from '../components/project/ProjectWork';
import { makeClient, makeDetail } from './support/projectHarness';
import {
  mockCreateVerityClient,
  mockDismissTo,
  mockPush,
  mockReplace,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

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
    projectId: 'p/1',
    status: 'completed',
    usage: ZERO_USAGE,
    lastActivityAt: Date.now() - 60_000,
    inboxDismissed: [],
    ...over,
  };
}

const question = session('form', {
  status: 'awaiting_input',
  openChoices: { question: 'Which validation library?', options: [{ label: 'Zod' }] },
});
const running = session('login', { status: 'running' });
const favorite = session('blog', { status: 'idle', favorite: true });
const merged = session('landing', {
  pullRequest: {
    number: 2040,
    title: 'Landing',
    url: 'https://example.test/pr/2040',
    phase: 'open',
    pipeline: 'failure',
    checks: { completed: 1, total: 1, successful: 0 },
  } as SessionSummary['pullRequest'],
});

function clientWith(sessions: SessionSummary[], extra: Record<string, unknown> = {}) {
  const detail = makeDetail({ dopplerConfig: 'dev' });
  const client = makeClient({ detail: { ...detail, sessions } }) as unknown as Record<
    string,
    unknown
  >;
  Object.assign(client, {
    listHttpMcpConnections: jest.fn().mockResolvedValue([]),
    listProjectMcpBindings: jest.fn().mockResolvedValue([]),
    listProjectDriveFolders: jest.fn().mockResolvedValue([]),
    listConnections: jest.fn().mockResolvedValue({ connections: [] }),
    listProjectKnowledgeFiles: jest
      .fn()
      .mockResolvedValue({ root: 'project', path: '', entries: [], truncated: false }),
    setSessionInboxDismissed: jest.fn(async (_id: string, key: string, dismissed: boolean) =>
      dismissed ? [key] : [],
    ),
    setProjectInboxDismissed: jest.fn(async () => [] as string[]),
    deleteSession: jest.fn().mockResolvedValue({ sessionId: 'deleted' }),
    ...extra,
  });
  return client as unknown as VerityClient & Record<string, jest.Mock>;
}

async function renderPage(
  sessions: SessionSummary[],
  props: Partial<Parameters<typeof ProjectPage>[0]> = {},
) {
  const client = clientWith(sessions);
  // The knowledge browser opens its own client, as its settings route does.
  mockCreateVerityClient.mockReturnValue(client);
  const onOpenSession = jest.fn();
  render(<ProjectPage client={client} projectId="p/1" onOpenSession={onOpenSession} {...props} />);
  await screen.findByTestId('project-line');
  await act(async () => undefined);
  return { client, onOpenSession };
}

beforeEach(() => {
  mockDesign.value = true;
  mockWide.value = false;
  setSearchParams({ id: 'p/1' });
});

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('the /project/[id] route', () => {
  it('keeps opening the project settings with the switch off', () => {
    mockDesign.value = false;
    mockCreateVerityClient.mockReturnValue(clientWith([]));
    render(<ProjectEntry />);
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings',
      params: { id: 'p/1' },
    });
    expect(screen.queryByTestId('project-page')).toBeNull();
  });

  it('waits for the stored choice instead of guessing the old world', () => {
    mockDesign.value = undefined;
    mockCreateVerityClient.mockReturnValue(clientWith([]));
    render(<ProjectEntry />);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('project-page')).toBeNull();
  });

  it('opens the project page on a phone with the switch on', async () => {
    mockCreateVerityClient.mockReturnValue(clientWith([running]));
    render(<ProjectEntry />);
    expect(await screen.findByTestId('project-page')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('Project settings'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings',
      params: { id: 'p/1' },
    });
  });

  it('hands a wide screen to the split layout’s left column', () => {
    mockWide.value = true;
    mockCreateVerityClient.mockReturnValue(clientWith([]));
    render(<ProjectEntry />);
    expect(mockDismissTo).toHaveBeenCalledWith({ pathname: '/', params: { project: 'p/1' } });
  });
});

describe('project page', () => {
  it('names where the code lives and how many pull requests are open', async () => {
    await renderPage([merged, running]);
    expect(screen.getByTestId('project-line')).toHaveTextContent(
      'GitHub · heey-global/verity · 1 open PR',
    );
  });

  it('says so when nothing in the project needs the operator', async () => {
    await renderPage([running]);
    expect(screen.getByTestId('project-for-you-empty')).toBeTruthy();
  });

  it('dismisses and restores a project item through the person’s saved state', async () => {
    const onInboxSaved = jest.fn();
    const { client } = await renderPage([question, running], { onInboxSaved });
    const card = screen.getByTestId('inbox-item-question');
    fireEvent.press(within(card).getByLabelText('Dismiss'));
    await act(async () => undefined);
    expect(client.setSessionInboxDismissed).toHaveBeenCalledWith(
      'form',
      expect.stringMatching(/^question:form/),
      true,
    );
    // The wide layout refreshes Home beside the page from this.
    expect(onInboxSaved).toHaveBeenCalled();
    expect(screen.queryByTestId('inbox-item-question')).toBeNull();
    fireEvent.press(screen.getByText('1 hidden'));
    fireEvent.press(within(screen.getByTestId('inbox-hidden-question')).getByText('Restore'));
    await act(async () => undefined);
    expect(client.setSessionInboxDismissed).toHaveBeenLastCalledWith(
      'form',
      expect.stringMatching(/^question:form/),
      false,
    );
  });

  it('lists the services the project uses, each leading to its setting', async () => {
    await renderPage([]);
    fireEvent.press(screen.getByLabelText(/^Doppler/));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings/services',
      params: { id: 'p/1', section: 'doppler' },
    });
    expect(screen.getByLabelText(/^Sandbox/)).toBeTruthy();
    // Not in use here, so not listed; adding one is a project setting.
    expect(screen.queryByLabelText(/^MCP/)).toBeNull();
  });

  it('filters Work by what a session is doing and opens a session', async () => {
    const { onOpenSession } = await renderPage([question, running, favorite, merged]);
    fireEvent.press(screen.getByRole('tab', { name: 'Work' }));
    expect(screen.getByTestId('project-work')).toBeTruthy();
    fireEvent.press(screen.getByRole('tab', { name: 'Running' }));
    expect(screen.getByLabelText(/^form/)).toBeTruthy();
    expect(screen.getByLabelText(/^login/)).toBeTruthy();
    expect(screen.queryByLabelText(/blog/)).toBeNull();
    fireEvent.press(screen.getByRole('tab', { name: 'Favorites' }));
    expect(screen.getByLabelText(/★ blog/)).toBeTruthy();
    expect(screen.queryByLabelText(/^login/)).toBeNull();
    fireEvent.press(screen.getByLabelText(/★ blog/));
    expect(onOpenSession).toHaveBeenCalledWith('blog');
  });

  it('deletes a session after confirmation and tells the host which one', async () => {
    const alert = jest.spyOn(Alert, 'alert');
    const onSessionChanged = jest.fn();
    const { client } = await renderPage([running], { onSessionChanged });
    fireEvent.press(screen.getByRole('tab', { name: 'Work' }));
    fireEvent(screen.getByLabelText(/^login/), 'longPress');
    const menu = alert.mock.calls.at(-1)![2]!;
    act(() => menu.find((button) => button.text === 'Delete')!.onPress!());
    const confirm = alert.mock.calls.at(-1)![2]!;
    await act(async () => confirm.find((button) => button.text === 'Delete')!.onPress!());
    expect(client.deleteSession).toHaveBeenCalledWith('login', {});
    // The wide layout clears its session pane and refreshes its list from this.
    expect(onSessionChanged).toHaveBeenCalledWith('login', true);
  });

  it('shows the project knowledge in its own tab', async () => {
    const { client } = await renderPage([]);
    fireEvent.press(screen.getByRole('tab', { name: 'Knowledge' }));
    expect(await screen.findByTestId('project-knowledge')).toBeTruthy();
    expect(client.listProjectKnowledgeFiles).toHaveBeenCalledWith('p/1', '');
  });

  it('reloads when the wide layout polled newer sessions beside it', async () => {
    const client = clientWith([running]);
    mockCreateVerityClient.mockReturnValue(client);
    const page = (reloadOn: unknown) => (
      <ProjectPage client={client} projectId="p/1" onOpenSession={jest.fn()} reloadOn={reloadOn} />
    );
    const view = render(page(1));
    await screen.findByTestId('project-line');
    const reads = client.getProject.mock.calls.length;
    view.rerender(page(1));
    expect(client.getProject).toHaveBeenCalledTimes(reads);
    view.rerender(page(2));
    await act(async () => undefined);
    // Without this the page beside Home keeps showing items Home already answered.
    expect(client.getProject).toHaveBeenCalledTimes(reads + 1);
  });

  it('goes back to the project list from the wide layout’s column', async () => {
    const onBack = jest.fn();
    await renderPage([], { inline: true, onBack });
    fireEvent.press(screen.getByText('Projects'));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('project settings index with the new design', () => {
  it('leaves project knowledge to the project page', async () => {
    mockCreateVerityClient.mockReturnValue(clientWith([]));
    render(<ProjectSettingsIndexScreen />);
    await screen.findByLabelText(/^Sandbox/);
    expect(screen.queryByLabelText(/^Project knowledge/)).toBeNull();
  });
});

describe('project helpers', () => {
  it('keeps only this project’s items and drops "Open" on its own page', () => {
    const detail = makeDetail();
    const other = session('elsewhere', { ...question, sessionId: 'elsewhere', projectId: 'p/2' });
    const failing = { ...detail.project, state: 'failed' as const };
    const items = projectInboxItems(failing, [question, other], Date.now());
    expect(items.map((item) => item.sessionId ?? item.projectId)).not.toContain('elsewhere');
    expect(items.some((item) => item.sessionId === 'form')).toBe(true);
    for (const item of items)
      expect(item.actions.some((action) => action.kind === 'open_project')).toBe(false);
  });

  it('describes a local project without a code host', () => {
    const detail = makeDetail({ kind: 'local' });
    expect(projectLine(detail.project, [])).toBe('Local project');
  });

  it('counts a merged pull request as done and a waiting session as running', () => {
    const done = session('x', {
      pullRequest: { ...merged.pullRequest!, phase: 'merged' },
      status: 'idle',
    });
    expect(workFilter(done, 'done')).toBe(true);
    expect(workFilter(question, 'running')).toBe(true);
    expect(workFilter(favorite, 'running')).toBe(false);
  });
});
