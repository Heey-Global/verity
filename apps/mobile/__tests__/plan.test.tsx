// Smoke tests for the Plan tab (ADR 0007): the board renders its Inbox (drafts) and
// Backlog (issues) sections, the composer captures a draft, reorder maps to a
// reorderTask call, and a null board (task management not configured → the client
// maps a 503 to null) shows the configure hint. Mirrors settings.test.tsx: the
// `../lib/client` module is mocked so `createVerityClient()` returns an in-memory
// fake, and `expo-router` is a null-rendering navigation stub.
import { type VerityClient, type ProjectRecord, type TaskBoard } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
  getVerityBaseUrl: () => 'http://verity.test:8082',
}));

// The voice hook wraps native speech-recognition modules that aren't available under
// jest; stub it to an idle no-op so the composer renders without them.
jest.mock('../hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', error: undefined, toggle: jest.fn(), abort: jest.fn() }),
}));

import { router } from 'expo-router';
import PlanScreen from '../app/plan';

function makeBoard(): TaskBoard {
  return {
    projectId: 'PVT_1',
    number: 7,
    title: 'Roadmap',
    items: [
      {
        id: 'd1',
        type: 'DRAFT_ISSUE',
        number: null,
        title: 'An idea',
        body: '',
        url: '',
        state: null,
        contentId: 'DI_1',
        fields: [],
      },
      {
        id: 'i1',
        type: 'ISSUE',
        number: 42,
        title: 'Fix login',
        body: 'b',
        url: 'u',
        state: 'OPEN',
        contentId: 'I_1',
        fields: [{ field: 'Priority', value: 'P1' }],
      },
      {
        id: 'i2',
        type: 'ISSUE',
        number: 43,
        title: 'Add logout',
        body: '',
        url: '',
        state: 'OPEN',
        contentId: 'I_2',
        fields: [],
      },
      {
        id: 'i3',
        type: 'ISSUE',
        number: 44,
        title: 'Rotate keys',
        body: '',
        url: '',
        state: 'OPEN',
        contentId: 'I_3',
        fields: [],
      },
    ],
    fields: [
      {
        id: 'F_prio',
        name: 'Priority',
        options: [
          { id: 'O1', name: 'P1' },
          { id: 'O2', name: 'P2' },
        ],
      },
    ],
  };
}

/** A fake client with only the task methods the Plan screen touches. */
function fakeClient(over: Partial<VerityClient> = {}): VerityClient {
  return {
    getTasks: jest.fn<Promise<TaskBoard | null>, []>().mockResolvedValue(makeBoard()),
    createTaskDraft: jest.fn().mockResolvedValue(makeBoard().items[0]),
    reorderTask: jest.fn<Promise<void>, [string, string | null]>().mockResolvedValue(undefined),
    refineTask: jest.fn().mockResolvedValue({
      title: 'Add dark mode',
      problem: 'Users want a dark theme.',
      acceptanceCriteria: ['Toggle in settings'],
      affectedAreas: [],
      openQuestions: [],
    }),
    createTaskIssue: jest
      .fn()
      .mockResolvedValue({ issueId: 'I_new', itemId: 'PVTI_new', number: 100, url: 'u' }),
    convertTaskDraft: jest.fn().mockResolvedValue({ itemId: 'PVTI_new', number: 100, url: 'u' }),
    // Repo picker source (best-effort). Default: none → the picker is hidden and issues
    // file into the server's origin repo.
    listProjects: jest.fn<Promise<unknown[]>, []>().mockResolvedValue([]),
    createSession: jest.fn().mockResolvedValue({ sessionId: 's-tasks' }),
    sendTurn: jest.fn().mockResolvedValue({ sessionId: 's-tasks', accepted: true }),
    removeTaskItem: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    setTaskField: jest.fn<Promise<void>, [string, string, string]>().mockResolvedValue(undefined),
    ...over,
  } as unknown as VerityClient;
}

describe('PlanScreen', () => {
  it('renders the Inbox drafts and Backlog issues with their field chips', async () => {
    mockCreateVerityClient.mockReturnValue(fakeClient());
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('An idea')).toBeTruthy());
    expect(screen.getAllByText('Inbox')).toHaveLength(2); // section header + inbox pill
    expect(screen.getByText('Backlog')).toBeTruthy();
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.getByText('Fix login')).toBeTruthy();
    expect(screen.getByText('P1')).toBeTruthy(); // custom-field chip
  });

  it('captures a draft through the composer', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('An idea')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('New task note'), 'Buy milk');
    fireEvent.press(screen.getByLabelText('Add to inbox'));
    await waitFor(() => expect(client.createTaskDraft).toHaveBeenCalledWith({ title: 'Buy milk' }));
  });

  it('files an inbox task into a selected repository from task detail', async () => {
    const client = fakeClient({
      listProjects: jest.fn().mockResolvedValue([
        { owner: 'acme', repo: 'widgets', state: 'active' },
        { owner: 'acme', repo: 'gadgets', state: 'active' },
      ] as unknown as ProjectRecord[]),
    });
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('An idea')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Open task An idea'));
    fireEvent.press(await screen.findByLabelText('File in acme/widgets'));
    fireEvent.press(screen.getByLabelText('File inbox task in repository'));
    await waitFor(() =>
      expect(client.convertTaskDraft).toHaveBeenCalledWith('d1', { repo: 'acme/widgets' }),
    );
  });

  it('refines a note into a blueprint and files it as an issue (Voice → Refiner)', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('An idea')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('New task note'), 'add a dark mode');
    fireEvent.press(screen.getByLabelText('Review before filing'));

    // The review sheet opens seeded with the refined blueprint.
    await waitFor(() => expect(screen.getByText('Review issue')).toBeTruthy());
    expect(client.refineTask).toHaveBeenCalledWith('add a dark mode');

    // Filing composes the body from the (unedited) blueprint fields.
    fireEvent.press(screen.getByLabelText('Create reviewed issue'));
    await waitFor(() =>
      expect(client.createTaskIssue).toHaveBeenCalledWith({
        title: 'Add dark mode',
        body: 'Users want a dark theme.\n\n## Acceptance criteria\n- Toggle in settings',
      }),
    );
  });

  it('creates an issue directly into the repo selected in the composer', async () => {
    const client = fakeClient({
      listProjects: jest.fn().mockResolvedValue([
        { owner: 'acme', repo: 'widgets', state: 'active' },
        { owner: 'acme', repo: 'gadgets', state: 'active' },
      ] as unknown as ProjectRecord[]),
    });
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('An idea')).toBeTruthy());

    await waitFor(() =>
      expect(screen.getByLabelText('Select repository acme/widgets')).toBeTruthy(),
    );
    fireEvent.press(screen.getByLabelText('Select repository acme/widgets'));
    fireEvent.changeText(screen.getByLabelText('New task note'), 'ship the thing');
    fireEvent.press(screen.getByLabelText('Create issue from note'));

    await waitFor(() =>
      expect(client.createTaskIssue).toHaveBeenCalledWith({
        title: 'ship the thing',
        body: '',
        repo: 'acme/widgets',
      }),
    );
  });

  it('files into a repo chosen with the repo picker', async () => {
    const client = fakeClient({
      // The screen only reads owner/repo; cast the minimal rows to the full record type
      // (the override is checked against Partial<VerityClient>, unlike the cast body).
      listProjects: jest.fn().mockResolvedValue([
        { owner: 'acme', repo: 'widgets', state: 'active' },
        { owner: 'acme', repo: 'gadgets', state: 'active' },
      ] as unknown as ProjectRecord[]),
    });
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('An idea')).toBeTruthy());

    fireEvent.changeText(screen.getByLabelText('New task note'), 'add a dark mode');
    fireEvent.press(screen.getByLabelText('Review before filing'));
    await waitFor(() => expect(screen.getByText('Review issue')).toBeTruthy());

    // The picker appears once projects load; pick a target repo, then file.
    await waitFor(() => expect(screen.getByLabelText('File into acme/widgets')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('File into acme/widgets'));
    fireEvent.press(screen.getByLabelText('Create reviewed issue'));
    await waitFor(() =>
      expect(client.createTaskIssue).toHaveBeenCalledWith({
        title: 'Add dark mode',
        body: 'Users want a dark theme.\n\n## Acceptance criteria\n- Toggle in settings',
        repo: 'acme/widgets',
      }),
    );
  });

  it('reorders a backlog item to the top when moved up from the second slot', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('Add logout')).toBeTruthy());

    // "Add logout" is backlog index 1; moving it up lands it at the top → afterId null.
    fireEvent.press(screen.getByLabelText('Move Add logout up'));
    await waitFor(() => expect(client.reorderTask).toHaveBeenCalledWith('i2', null));
  });

  it('reorders a mid-list item up to sit after the item two slots above', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('Rotate keys')).toBeTruthy());

    // "Rotate keys" is backlog index 2; up → after backlog[0] ('i1').
    fireEvent.press(screen.getByLabelText('Move Rotate keys up'));
    await waitFor(() => expect(client.reorderTask).toHaveBeenCalledWith('i3', 'i1'));
  });

  it('reorders an item down to sit after its next neighbour', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('Fix login')).toBeTruthy());

    // "Fix login" is backlog index 0; down → after backlog[1] ('i2').
    fireEvent.press(screen.getByLabelText('Move Fix login down'));
    await waitFor(() => expect(client.reorderTask).toHaveBeenCalledWith('i1', 'i2'));
  });

  it('sets a single-select field on a backlog task via the field sheet', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('Fix login')).toBeTruthy());

    // "Fix login" (i1) has a settable Priority field in the task actions sheet.
    fireEvent.press(screen.getByLabelText('Open task Fix login'));
    await waitFor(() => expect(screen.getByLabelText('Set Priority to P2')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Set Priority to P2'));
    await waitFor(() => expect(client.setTaskField).toHaveBeenCalledWith('i1', 'Priority', 'P2'));
  });

  it('removes a task from the board via the field sheet', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('Fix login')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Open task Fix login'));
    fireEvent.press(await screen.findByLabelText('Remove Fix login from board'));
    expect(client.removeTaskItem).not.toHaveBeenCalled();
    fireEvent.press(await screen.findByLabelText('Confirm remove Fix login from board'));
    await waitFor(() => expect(client.removeTaskItem).toHaveBeenCalledWith('i1'));
  });

  it('can remove a task even when no settable fields exist', async () => {
    const board = { ...makeBoard(), fields: [] };
    const client = fakeClient({
      getTasks: jest.fn<Promise<TaskBoard | null>, []>().mockResolvedValue(board),
    });
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('Fix login')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Open task Fix login'));
    fireEvent.press(await screen.findByLabelText('Remove Fix login from board'));
    fireEvent.press(await screen.findByLabelText('Confirm remove Fix login from board'));
    await waitFor(() => expect(client.removeTaskItem).toHaveBeenCalledWith('i1'));
  });

  it('launches the task assistant session from the header', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    fireEvent.press(screen.getByLabelText('Open the task assistant'));
    await waitFor(() => expect(client.createSession).toHaveBeenCalled());
    const arg = (client.createSession as jest.Mock).mock.calls[0][0];
    expect(arg.name).toBe('Tasks');
    expect(arg.prompt).toContain('verity-tasks'); // seeded to drive the CLI
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/session/[id]',
        params: { id: 's-tasks' },
      }),
    );
  });

  it('sets a single-select field on a task via the field sheet', async () => {
    const client = fakeClient();
    mockCreateVerityClient.mockReturnValue(client);
    render(<PlanScreen />);
    await waitFor(() => expect(screen.getByText('Fix login')).toBeTruthy());

    // Open the task actions sheet for the "Fix login" backlog issue, then pick Priority P2.
    fireEvent.press(screen.getByLabelText('Open task Fix login'));
    fireEvent.press(await screen.findByLabelText('Set Priority to P2'));
    await waitFor(() => expect(client.setTaskField).toHaveBeenCalledWith('i1', 'Priority', 'P2'));
  });

  it('closes the overlay via the header X (router.back)', () => {
    mockCreateVerityClient.mockReturnValue(fakeClient());
    render(<PlanScreen />);
    fireEvent.press(screen.getByLabelText('Close plan'));
    expect(router.back).toHaveBeenCalled();
  });

  it('shows the configure hint when task management is not configured (null board)', async () => {
    mockCreateVerityClient.mockReturnValue(
      fakeClient({ getTasks: jest.fn<Promise<TaskBoard | null>, []>().mockResolvedValue(null) }),
    );
    render(<PlanScreen />);
    await waitFor(() =>
      expect(screen.getByText("Task management isn't configured on the server.")).toBeTruthy(),
    );
  });
});
