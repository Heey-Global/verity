import {
  LiveConnection,
  VerityClient,
  decodeLiveServerFrame,
  SessionStream,
  SessionModel,
} from '@verity/mobile';
import { DEMO_BASE_URL, demoFetch, createDemoSocket, resetDemoData } from './demoTransport';

function requiredVersion(file: { version?: string }): string {
  if (file.version === undefined) throw new Error('Demo file responses must include a version.');
  return file.version;
}

const client = () =>
  new VerityClient({
    baseUrl: DEMO_BASE_URL,
    fetch: demoFetch,
    uploadFetch: demoFetch,
    allowBackgroundUpload: false,
  });

const LIVE_URL = `${DEMO_BASE_URL.replace('https', 'wss')}/live`;

/** A raw demo live socket that records every frame and can subscribe. */
function openDemoLive(): {
  socket: ReturnType<typeof createDemoSocket>;
  frames: Record<string, unknown>[];
  subscribe: (id: string, sinceSeq?: number) => void;
} {
  const socket = createDemoSocket(LIVE_URL);
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener('message', ({ data }) => {
    const decoded = decodeLiveServerFrame(String(data));
    if (!decoded.ok) throw new Error(`invalid demo frame: ${decoded.error}`);
    frames.push(decoded.frame as Record<string, unknown>);
  });
  return {
    socket,
    frames,
    subscribe: (id, sinceSeq) =>
      socket.send(
        JSON.stringify({
          k: 'sub',
          ch: 'session',
          id,
          ...(sinceSeq === undefined ? {} : { sinceSeq }),
        }),
      ),
  };
}

function demoLive(api: VerityClient): LiveConnection {
  return new LiveConnection({
    baseUrl: DEMO_BASE_URL,
    connect: createDemoSocket,
    getTicket: async () => (await api.createLiveTicket()).ticket,
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  resetDemoData();
});
afterEach(() => {
  resetDemoData();
  jest.useRealTimers();
});

it('serves the core surfaces through the real validating client', async () => {
  const api = client();
  const [projects, overview, models, status, health, settings] = await Promise.all([
    api.listProjects(),
    api.listSessionOverview(),
    api.listModels(),
    api.fetchOnboardingStatus(),
    api.getHealth(),
    api.getVeritySettings(),
  ]);
  expect(projects).toHaveLength(1);
  expect(overview.sessions).toHaveLength(1);
  expect(models.models.length).toBeGreaterThan(0);
  expect(status.complete).toBe(true);
  expect(health.pushEnabled).toBe(false);
  expect(settings?.advancedModeEnabled).toBe(false);
  expect((await api.updateVeritySettings({ advancedModeEnabled: true })).advancedModeEnabled).toBe(
    true,
  );
  const id = overview.sessions[0]!.sessionId;
  expect((await api.getSession(id)).eventCount).toBeGreaterThan(0);
  expect((await api.getHistory(id)).events.length).toBeGreaterThan(0);
  expect((await api.getActivity(id)).busy).toBe(false);
  expect((await api.getProject(projects[0]!.id)).sessions).toHaveLength(1);
  expect((await api.getBranches(id)).current).toBeTruthy();
  expect((await api.listSessionFiles(id)).entries.some((entry) => entry.kind === 'directory')).toBe(
    true,
  );
  expect((await api.listSessionFiles(id, '', 'knowledge')).root).toBe('knowledge');
  expect((await api.getSessionFileContent(id, 'README.md')).content).toContain('demo');
  expect(await api.listKnowledgeFolders()).toHaveLength(1);
  const docs = await api.listKnowledgeDocuments('demo-knowledge');
  expect((await api.getKnowledgeDocument(docs[0]!.id)).bodyMarkdown).toContain('server');
  expect(await api.listIntegrations()).toEqual({ accounts: [], sources: [] });
  expect(await api.getProjectGoogleConnection(projects[0]!.id, 'gmail')).toMatchObject({
    connected: false,
  });
  expect(await api.listSessionDevServers(id)).toEqual([]);
});

it('streams schema-valid replies and changes a local file without calling network fetch', async () => {
  const network = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('Unexpected network');
  });
  try {
    const api = client();
    const { sessionId } = (await api.createSession({ sessionId: 'new-demo', name: 'My demo' })) as {
      sessionId: string;
    };
    const live = openDemoLive();
    jest.advanceTimersByTime(0);
    live.subscribe(sessionId);
    jest.advanceTimersByTime(0);
    expect((await api.sendTurn(sessionId, { prompt: 'Change the button color' })).accepted).toBe(
      true,
    );
    expect((await api.getActivity(sessionId)).busy).toBe(true);
    jest.advanceTimersByTime(2000);
    expect(
      live.frames.some(
        (frame) =>
          frame.k === 'event' &&
          frame.id === sessionId &&
          (frame.event as { t: string }).t === 'tool_call',
      ),
    ).toBe(true);
    expect((await api.getSessionFileContent(sessionId, 'src/Button.tsx')).content).toContain(
      '#16a34a',
    );
    expect((await api.getActivity(sessionId)).busy).toBe(false);
    expect(network).not.toHaveBeenCalled();
    live.socket.close();
  } finally {
    network.mockRestore();
  }
});
it('cancel and reset prevent delayed mutations and retire old sockets', async () => {
  const api = client();
  const id = (await api.listSessions())[0]!.sessionId;
  const live = openDemoLive();
  jest.advanceTimersByTime(0);
  live.subscribe(id);
  jest.advanceTimersByTime(0);
  await api.sendTurn(id, { prompt: 'Change the button color' });
  expect((await api.cancelTurn(id)).cancelled).toBe(true);
  const count = live.frames.length;
  jest.advanceTimersByTime(5000);
  expect(live.frames).toHaveLength(count);
  expect((await api.getSessionFileContent(id, 'src/Button.tsx')).content).toContain('#2563eb');
  await api.sendTurn(id, { prompt: 'Change the button color' });
  resetDemoData();
  const resetCount = live.frames.length;
  const resetId = (await api.listSessions())[0]!.sessionId;
  expect(resetId).not.toBe(id);
  jest.advanceTimersByTime(5000);
  expect(live.frames).toHaveLength(resetCount);
  expect((await api.getActivity(resetId)).busy).toBe(false);
  expect((await api.getSessionFileContent(resetId, 'src/Button.tsx')).content).toContain('#2563eb');
});
it('supports stream lifecycle and resumes without duplicating old events', async () => {
  const api = client();
  const id = (await api.listSessions())[0]!.sessionId;
  const seq = (await api.getSession(id)).eventCount;
  const connection = demoLive(api);
  const stream = new SessionStream({ sessionId: id, transport: connection });
  connection.start();
  stream.start();
  await jest.advanceTimersByTimeAsync(0);
  stream.stop();
  connection.stop();
  expect(jest.getTimerCount()).toBe(0);
  const live = openDemoLive();
  jest.advanceTimersByTime(0);
  live.subscribe(id, seq);
  jest.advanceTimersByTime(0);
  expect(live.frames).toEqual([
    { k: 'ready', v: 1, maxSessions: 8 },
    { k: 'caught_up', id, seq },
  ]);
  live.socket.close();
});
it('replays history before a turn submitted while the stream is opening', async () => {
  const api = client();
  const id = (await api.listSessions())[0]!.sessionId;
  const live = openDemoLive();
  jest.advanceTimersByTime(0);
  live.subscribe(id);
  await api.sendTurn(id, { prompt: 'Explain the project' });
  expect(live.frames.filter(({ k }) => k !== 'ready')).toEqual([]);
  jest.advanceTimersByTime(0);
  const expected = (await api.getHistory(id)).events.map(({ seq }) => seq);
  expect(live.frames.filter(({ k }) => k === 'event').map(({ seq }) => seq)).toEqual(expected);
  expect(live.frames.at(-1)).toEqual({ k: 'caught_up', id, seq: expected.at(-1) });
  live.socket.close();
});
it('rejects unsupported operations and foreign addresses locally', async () => {
  await expect(
    client().connectGoogleDrive({ code: 'demo', codeVerifier: 'demo', redirectUri: 'demo://' }),
  ).rejects.toThrow('local demo');
  expect((await demoFetch('https://other.invalid/projects')).status).toBe(400);
});

it('feeds the real session model, including local echoes, tool cards and approval decisions', async () => {
  const api = client();
  const id = (await api.listSessions())[0]!.sessionId;
  const connection = demoLive(api);
  connection.start();
  const model = new SessionModel({ client: api, sessionId: id, transport: connection });
  model.start();
  // Ticket, `ready`, then the replay: each waits on one more of the demo's timers.
  for (let i = 0; i < 5; i += 1) await jest.advanceTimersByTimeAsync(1);
  expect(model.state.connectionState).toBe('connected');
  expect(model.state.streamError).toBeUndefined();
  expect(model.state.session.messages.length).toBeGreaterThan(0);
  expect(await model.sendTurn('Change the button color')).toBe(true);
  await jest.advanceTimersByTimeAsync(2000);
  expect(model.state.streamError).toBeUndefined();
  expect(model.state.session.messages.some((message) => message.kind === 'tool-call')).toBe(true);
  expect(model.state.pendingMessages).toHaveLength(0);
  expect(await model.sendTurn('Show an approval request')).toBe(true);
  const activity = await api.getActivity(id);
  expect(activity.pendingPermissions).toHaveLength(1);
  await model.decidePermission(activity.pendingPermissions![0]!, { behavior: 'allow' });
  expect((await api.getActivity(id)).busy).toBe(false);
  model.stop();
  connection.stop();
  expect(jest.getTimerCount()).toBe(0);
});

it('creates independent local projects and sessions and edits and downloads sample files', async () => {
  const api = client();
  const project = await api.createProject({ kind: 'local', name: 'My sample' });
  expect((await api.getProject(project.id)).project.repo).toBe('My sample');
  const result = (await api.createSession({
    projectId: project.id,
    sessionId: 'created-local',
  })) as { sessionId: string };
  expect((await api.getSession(result.sessionId)).projectId).toBe(project.id);
  await api.saveSessionFileContent(result.sessionId, 'worktree', 'README.md', 'Local edits', null);
  expect(await (await api.downloadSessionFile(result.sessionId, 'README.md')).text()).toBe(
    'Local edits',
  );
  await api.deleteSession(result.sessionId);
  await expect(api.getSession(result.sessionId)).rejects.toThrow('not found');
});

it('rejects an already-aborted request without mutating demo state', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    demoFetch(`${DEMO_BASE_URL}/sessions`, {
      method: 'POST',
      signal: controller.signal,
      body: '{}',
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(await client().listSessions()).toHaveLength(1);
});

it('rejects stale saves after a simulated edit even when the file length stays the same', async () => {
  const api = client();
  const id = (await api.listSessions())[0]!.sessionId;
  const path = 'src/Button.tsx';
  const opened = await api.getSessionFileContent(id, path);
  await api.sendTurn(id, { prompt: 'Change the button color' });
  jest.advanceTimersByTime(2000);
  const changed = await api.getSessionFileContent(id, path);
  expect(changed.content.length).toBe(opened.content.length);
  expect(changed.version).not.toBe(opened.version);
  await expect(
    api.saveSessionFileContent(id, 'worktree', path, opened.content, requiredVersion(opened)),
  ).rejects.toMatchObject({ status: 409 });
  expect((await api.getSessionFileContent(id, path)).content).toBe(changed.content);
  const saved = await api.saveSessionFileContent(
    id,
    'worktree',
    path,
    opened.content,
    requiredVersion(changed),
  );
  expect(saved.content).toBe(opened.content);
  expect(saved.version).not.toBe(changed.version);
});

it('gives newly created sessions fresh identities after reset', async () => {
  const api = client();
  const first = await api.createSession({});
  resetDemoData();
  const second = await api.createSession({});
  expect(
    'sessionId' in first && 'sessionId' in second && first.sessionId !== second.sessionId,
  ).toBe(true);
});

it('retains acknowledged project collapse state on subsequent reads', async () => {
  const api = client();
  const id = (await api.listProjects())[0]!.id;
  await api.setProjectCollapsed(id, true);
  expect((await api.listProjects()).find((project) => project.id === id)?.collapsed).toBe(true);
  await api.setProjectCollapsed(id, false);
  expect((await api.getProject(id)).project.collapsed).toBe(false);
});

it('retains acknowledged project ordering on subsequent reads', async () => {
  const api = client();
  const initial = (await api.listProjects())[0]!;
  const added = await api.createProject({ kind: 'local', name: 'Second sample' });
  const ids = [added.id, initial.id];
  await api.reorderProjects(ids);
  expect((await api.listProjects()).map(({ id }) => id)).toEqual(ids);
});

it('preserves saved edits when applying the simulated color change', async () => {
  const api = client();
  const id = (await api.listSessions())[0]!.sessionId;
  const file = await api.getSessionFileContent(id, 'src/Button.tsx');
  const edited = `${file.content}\n// Keep this local edit.\n`;
  await api.saveSessionFileContent(id, 'worktree', 'src/Button.tsx', edited, requiredVersion(file));
  await api.sendTurn(id, { prompt: 'Change the button color' });
  jest.advanceTimersByTime(2000);
  expect((await api.getSessionFileContent(id, 'src/Button.tsx')).content).toBe(
    edited.replace('#2563eb', '#16a34a'),
  );
  const changed = await api.getSessionFileContent(id, 'src/Button.tsx');
  await api.sendTurn(id, { prompt: 'Change the button color' });
  jest.advanceTimersByTime(2000);
  expect((await api.getSessionFileContent(id, 'src/Button.tsx')).content).toBe(changed.content);
  const result = (await api.getHistory(id)).events.findLast(
    ({ event }) => event.t === 'tool_result',
  );
  expect(result?.event).toMatchObject({ t: 'tool_result', isError: true });
});

it('walks through proposing, confirming, pausing, and deleting an automation', async () => {
  const api = client();
  const id = (await api.listSessionOverview()).sessions[0]!.sessionId;
  await api.sendTurn(id, { prompt: 'Every Monday morning, summarize what changed' });
  jest.advanceTimersByTime(1000);
  const proposal = (await api.getHistory(id)).events
    .map((frame) => frame.event)
    .find((event) => event.t === 'automation_proposal');
  if (proposal?.t !== 'automation_proposal') throw new Error('expected a demo proposal');

  expect(await api.getSessionAutomation(id)).toBeNull();
  const saved = await api.saveSessionAutomation(id, proposal.proposal);
  expect(saved).toMatchObject({ name: 'Morning summary', status: 'enabled' });
  expect((await api.listSessionOverview()).sessions[0]?.automation).toEqual({
    status: 'enabled',
  });
  expect((await api.setSessionAutomationStatus(id, 'paused')).nextRunAt).toBeNull();
  await api.deleteSessionAutomation(id);
  expect(await api.getSessionAutomation(id)).toBeNull();
  expect((await api.listSessionOverview()).sessions[0]?.automation).toBeUndefined();
});
