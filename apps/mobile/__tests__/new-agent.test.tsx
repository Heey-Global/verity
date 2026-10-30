import { type VerityClient, type ProjectRecord } from '@verity/mobile';
import { render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
const mockReplace = jest.fn();
const mockSetParams = jest.fn();
const mockSessionChat = jest.fn((_props: unknown) => null);
let mockWidth = 1024;
let mockFocused = true;
let mockParams: {
  project?: string;
  projectId?: string;
  prompt?: string;
  model?: string;
  sid?: string;
} = {};

jest.mock('expo-router', () => ({
  useIsFocused: () => mockFocused,
  Stack: { Screen: () => null },
  router: {
    replace: (href: unknown) => mockReplace(href),
    setParams: (params: unknown) => mockSetParams(params),
  },
  useLocalSearchParams: () => mockParams,
}));

jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
  getVerityBaseUrl: () => 'http://verity.test:8082',
}));

jest.mock('../hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', error: undefined, toggle: jest.fn(), abort: jest.fn() }),
}));

jest.mock('../app/session/[id]', () => ({
  SessionChat: (props: unknown) => mockSessionChat(props),
}));

// Mock the internal module that react-native re-exports as `useWindowDimensions`,
// rather than spreading `jest.requireActual('react-native')` — the latter pulls in
// Expo's winter runtime during import and crashes jest-expo's preset setup. Mocking
// just this leaf keeps the rest of the RN preset mocks intact.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockWidth, height: 768, scale: 1, fontScale: 1 }),
}));

import NewAgentScreen from '../app/new';
import { pendingSession } from '../lib/pendingSessions';

function project(): ProjectRecord {
  return {
    id: 'p/1',
    kind: 'github',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'dev-heey-global-verity',
    imageRef: null,
    state: 'active',
    provisionError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeClient(overrides: Partial<VerityClient> = {}): VerityClient {
  return {
    listModels: jest.fn().mockResolvedValue({
      models: ['codex/default', 'claude-sonnet-4-6'],
      default: 'codex/default',
    }),
    listProjects: jest.fn().mockResolvedValue([project()]),
    getProject: jest.fn().mockResolvedValue({ project: project(), settings: null, sessions: [] }),
    createSession: jest.fn().mockResolvedValue({ sessionId: 's/1' }),
    sendTurn: jest.fn().mockResolvedValue({ sessionId: 's/1', accepted: true }),
    ...overrides,
  } as unknown as VerityClient;
}

/** The id the screen minted, read off the chat it mounted (phone) or the redirect
 * it issued (tablet) — the app chooses it now, so nothing else knows it up front. */
function launchedSessionId(): string {
  const chatProps = mockSessionChat.mock.calls[0]?.[0] as { sessionId: string } | undefined;
  if (chatProps !== undefined) return chatProps.sessionId;
  const href = mockReplace.mock.calls[0]?.[0] as { params: { id: string } } | undefined;
  if (href === undefined) throw new Error('the screen neither opened a chat nor redirected');
  return href.params.id;
}

beforeEach(() => {
  // Wide-window cases represent an iPad; width alone no longer identifies a tablet.
  jest
    .spyOn(Platform as typeof Platform & { isPad: boolean }, 'isPad', 'get')
    .mockReturnValue(true);
  mockCreateVerityClient.mockReset();
  mockReplace.mockReset();
  mockSetParams.mockReset();
  mockSessionChat.mockReset();
  mockSessionChat.mockImplementation(() => null);
  mockWidth = 1024;
  mockFocused = true;
  mockParams = {};
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('NewAgentScreen', () => {
  it.each([undefined, 's/restored-iphone'])(
    'keeps the same iPhone launch mounted across rotation (restored sid: %s)',
    async (sid) => {
      jest
        .spyOn(Platform as typeof Platform & { isPad: boolean }, 'isPad', 'get')
        .mockReturnValue(false);
      mockWidth = 393;
      mockParams = { sid };
      const createSession = jest.fn(() => new Promise<never>(() => undefined));
      mockCreateVerityClient.mockReturnValue(makeClient({ createSession }));
      const view = render(<NewAgentScreen />);
      const id = launchedSessionId();
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      const gate = pendingSession(id);

      for (const width of [852, 393, 852, 393]) {
        mockWidth = width;
        view.rerender(<NewAgentScreen />);
        expect(mockSessionChat).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId: id }),
        );
        expect(mockReplace).not.toHaveBeenCalled();
        expect(pendingSession(id)).toBe(gate);
      }
      expect(createSession).toHaveBeenCalledTimes(1);
    },
  );

  it.each([767, 768])(
    'uses the shared split boundary for a new session at %i points',
    async (width) => {
      mockWidth = width;
      mockCreateVerityClient.mockReturnValue(makeClient());
      render(<NewAgentScreen />);
      if (width === 768) {
        await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
        expect(mockSessionChat).not.toHaveBeenCalled();
      } else {
        expect(mockSessionChat).toHaveBeenCalled();
        expect(mockReplace).not.toHaveBeenCalled();
      }
    },
  );

  it('transfers a pending narrow launch into the split without repeating creation or its prompt', async () => {
    mockWidth = 767;
    mockParams = { prompt: 'First turn' };
    let finishCreate!: (value: { sessionId: string }) => void;
    const createSession = jest.fn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const sendTurn = jest.fn().mockResolvedValue({ accepted: true });
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession, sendTurn }));
    const view = render(<NewAgentScreen />);
    const id = launchedSessionId();
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const gate = pendingSession(id);
    mockWidth = 768;
    view.rerender(<NewAgentScreen />);
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/session/[id]', params: { id } });
    expect(pendingSession(id)).toBe(gate);
    mockWidth = 767;
    view.rerender(<NewAgentScreen />);
    mockWidth = 1024;
    view.rerender(<NewAgentScreen />);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    finishCreate({ sessionId: id });
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    await expect(gate).resolves.toBeUndefined();
  });

  it('does not navigate a background launch on resize', () => {
    mockWidth = 767;
    mockCreateVerityClient.mockReturnValue(makeClient());
    const view = render(<NewAgentScreen />);
    mockFocused = false;
    mockWidth = 768;
    view.rerender(<NewAgentScreen />);
    expect(mockReplace).not.toHaveBeenCalled();
    mockFocused = true;
    view.rerender(<NewAgentScreen />);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('keeps a wide launch destination stable when resized during creation', async () => {
    const createSession = jest.fn(() => new Promise<never>(() => undefined));
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession }));
    const view = render(<NewAgentScreen />);
    mockWidth = 767;
    view.rerender(<NewAgentScreen />);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockSessionChat).not.toHaveBeenCalled();
  });

  it('keeps the opened chat pending during provisioning and retries the same session id', async () => {
    const createSession = jest
      .fn()
      .mockResolvedValueOnce({
        awaitingProvisioning: true,
        project: { ...project(), state: 'cloning' },
      })
      .mockResolvedValue({ sessionId: 's/1' });
    const getProject = jest
      .fn()
      .mockResolvedValueOnce({ project: { ...project(), state: 'cloning' } })
      .mockResolvedValue({ project: project() });
    const client = makeClient({ createSession, getProject });
    mockWidth = 390;
    mockParams = { projectId: 'p/1' };
    mockCreateVerityClient.mockReturnValue(client);

    render(<NewAgentScreen />);
    const id = launchedSessionId();
    const pending = pendingSession(id);
    expect(mockSessionChat).toHaveBeenCalled();
    await waitFor(() => expect(getProject).toHaveBeenCalledWith('p/1'));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(pendingSession(id)).toBe(pending);
    await expect(pending).resolves.toBeUndefined();
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[0]).toEqual(createSession.mock.calls[1]);
    expect(client.sendTurn).not.toHaveBeenCalled();
  });

  it('reports provisioning failure in the opened chat without retrying session creation', async () => {
    const createSession = jest
      .fn()
      .mockResolvedValue({ awaitingProvisioning: true, project: project() });
    mockWidth = 390;
    mockParams = { projectId: 'p/1' };
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        createSession,
        getProject: jest.fn().mockResolvedValue({
          project: { ...project(), state: 'failed', provisionError: 'Build failed' },
        }),
      }),
    );

    render(<NewAgentScreen />);
    await expect(pendingSession(launchedSessionId())).rejects.toThrow('Build failed');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('preserves a configured OpenCode model for session creation and the prepared turn', async () => {
    const client = makeClient();
    mockParams = {
      projectId: 'p/1',
      model: 'verity/gpt-4.1',
      prompt: 'Check the project.',
    };
    mockCreateVerityClient.mockReturnValue(client);

    render(<NewAgentScreen />);

    await waitFor(() =>
      expect(client.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: mockParams.projectId, model: mockParams.model }),
      ),
    );
    await waitFor(() =>
      expect(client.sendTurn).toHaveBeenCalledWith(launchedSessionId(), {
        prompt: mockParams.prompt,
        model: mockParams.model,
      }),
    );
  });

  it('creates the session it already opened, and auto-starts the prepared prompt', async () => {
    const createSession = jest.fn().mockResolvedValue({ sessionId: 's/1' });
    const sendTurn = jest.fn().mockResolvedValue({ sessionId: 's/1', accepted: true });
    mockParams = {
      project: 'heey-global/verity',
      prompt: 'Create a Verity monitor for heey-global/verity.',
      model: 'codex/default',
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession, sendTurn }));

    render(<NewAgentScreen />);

    // The redirect does not wait for the create: the id is the app's own.
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    const sessionId = launchedSessionId();
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith({
        sessionId,
        prompt: 'Create a Verity monitor for heey-global/verity.',
        project: 'heey-global/verity',
        model: 'codex/default',
      }),
    );
    await waitFor(() =>
      expect(sendTurn).toHaveBeenCalledWith(sessionId, {
        prompt: 'Create a Verity monitor for heey-global/verity.',
        model: 'codex/default',
      }),
    );
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/session/[id]',
      params: { id: sessionId },
    });
  });

  it('takes the project straight from the route instead of listing projects', async () => {
    const listProjects = jest.fn().mockResolvedValue([project()]);
    const createSession = jest.fn().mockResolvedValue({ sessionId: 's/1' });
    mockParams = { project: 'heey-global/verity' };
    mockCreateVerityClient.mockReturnValue(makeClient({ listProjects, createSession }));

    render(<NewAgentScreen />);

    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ project: 'heey-global/verity' }),
      ),
    );
    // The whole point: no GET /projects between the tap and the session.
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('passes a project id straight through without listing projects', async () => {
    const listProjects = jest.fn().mockResolvedValue([project()]);
    const createSession = jest.fn().mockResolvedValue({ sessionId: 's/1' });
    mockParams = { projectId: 'p/1' };
    mockCreateVerityClient.mockReturnValue(makeClient({ listProjects, createSession }));

    render(<NewAgentScreen />);

    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p/1' })),
    );
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('passes a stale-project rejection from the server into the opened session', async () => {
    const createSession = jest
      .fn()
      .mockRejectedValue(new Error('project missing-project is not in the fleet registry'));
    mockWidth = 390;
    mockParams = { projectId: 'missing-project' };
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession }));

    render(<NewAgentScreen />);

    // The chat is up regardless; the failure reaches it through the pending-create
    // gate, which replaces the optimistic empty state with the actual reason.
    await waitFor(() => expect(mockSessionChat).toHaveBeenCalled());
    await expect(pendingSession(launchedSessionId())).rejects.toThrow(
      'project missing-project is not in the fleet registry',
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'missing-project' }),
    );
  });

  it('creates an empty session without starting an LLM when there is no prepared prompt', async () => {
    const createSession = jest.fn().mockResolvedValue({ sessionId: 's/1' });
    const sendTurn = jest.fn().mockResolvedValue({ sessionId: 's/1', accepted: true });
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession, sendTurn }));

    render(<NewAgentScreen />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith({ sessionId: launchedSessionId() }),
    );
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it('opens the phone chat before the session exists, canonicalizing the URL in place', async () => {
    mockWidth = 390;
    // Never settles: the create is still provisioning the worktree.
    const createSession: VerityClient['createSession'] = jest.fn(
      () => new Promise<never>(() => undefined),
    );
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession }));

    render(<NewAgentScreen />);

    await waitFor(() => expect(mockSessionChat).toHaveBeenCalled());
    const sessionId = launchedSessionId();
    expect(mockSessionChat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, baseUrl: 'http://verity.test:8082' }),
    );
    // The chat waits on the registered create rather than talking to a session the
    // server has never heard of.
    expect(pendingSession(sessionId)).toBeInstanceOf(Promise);
    // The URL carries `sid` from the start, so a restore reopens THIS session — but
    // the route is never replaced, so SessionChat is not remounted.
    await waitFor(() => expect(mockSetParams).toHaveBeenCalledWith({ sid: sessionId }));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('gates the chat from the frame it is built in, not from the effect after it', async () => {
    mockWidth = 390;
    // What `useSession` does: it reads the registry while it renders, so a gate
    // registered in an effect — which runs after every child has rendered — arrives
    // too late and the model comes up ungated, streaming at an id the server has
    // not minted. Reading it from inside the chat is the only way to catch that;
    // asserting after the render passes either way.
    const gateWhenChatRendered: Array<Promise<void> | undefined> = [];
    mockSessionChat.mockImplementation((props) => {
      gateWhenChatRendered.push(pendingSession((props as { sessionId: string }).sessionId));
      return null;
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient({ createSession: jest.fn(() => new Promise<never>(() => undefined)) }),
    );

    render(<NewAgentScreen />);

    await waitFor(() => expect(mockSessionChat).toHaveBeenCalled());
    expect(gateWhenChatRendered[0]).toBeInstanceOf(Promise);
  });

  it('re-issues the create for a restored sid, in case the original never landed', async () => {
    mockWidth = 390;
    mockParams = { sid: 's/restored', project: 'heey-global/verity' };
    const createSession = jest.fn().mockResolvedValue({ sessionId: 's/restored' });
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession }));

    render(<NewAgentScreen />);

    await waitFor(() =>
      expect(mockSessionChat).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's/restored' }),
      ),
    );
    // `sid` says this route launched the session, not that the server ever minted
    // it — the process can die inside the create. The call is idempotent on the id,
    // so it either finishes that create or hands back the session already there.
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith({
        sessionId: 's/restored',
        project: 'heey-global/verity',
      }),
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not repeat the prepared prompt when the restore finds the session already there', async () => {
    mockWidth = 390;
    mockParams = { sid: 's/restored', project: 'heey-global/verity', prompt: 'do the thing' };
    // The idempotent answer: this call did not mint the session, so the run that
    // did has already sent its first turn.
    const createSession = jest.fn().mockResolvedValue({ sessionId: 's/restored', existing: true });
    const sendTurn = jest.fn().mockResolvedValue({ sessionId: 's/restored', accepted: true });
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession, sendTurn }));

    render(<NewAgentScreen />);

    // The gate is dropped from the registry once it opens, so this is "the launch
    // finished" — and it opens only after the prompt decision has been made.
    await waitFor(() => expect(pendingSession('s/restored')).toBeUndefined());
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it('redirects a restored session into the split on wide instead of rendering it in place', async () => {
    mockWidth = 1024;
    mockParams = { sid: 's/restored' };
    const createSession = jest.fn().mockResolvedValue({ sessionId: 's/restored' });
    mockCreateVerityClient.mockReturnValue(makeClient({ createSession }));

    render(<NewAgentScreen />);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/session/[id]',
        params: { id: 's/restored' },
      }),
    );
    expect(mockSessionChat).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's/restored' }),
      ),
    );
  });
});
