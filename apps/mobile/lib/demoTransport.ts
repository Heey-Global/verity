import type {
  SessionAutomation,
  SessionDetail,
  StreamEventFrame,
  StreamSocket,
} from '@verity/mobile';
import { randomUUID } from 'expo-crypto';

export const DEMO_BASE_URL = 'https://demo.verity.invalid';
export function isDemoUrl(url: string | null | undefined): boolean {
  return url?.replace(/^ws/, 'http').split('/').slice(0, 3).join('/') === DEMO_BASE_URL;
}
function nextAutomationRun(schedule: SessionAutomation['schedule']): string {
  const now = new Date();
  if (schedule.kind === 'interval') {
    return new Date(now.getTime() + schedule.everyMinutes * 60_000).toISOString();
  }
  const next = new Date(now);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (schedule.kind === 'daily') {
    if (next <= now) next.setDate(next.getDate() + 1);
  } else {
    let days = (schedule.weekday - next.getDay() + 7) % 7;
    if (days === 0 && next <= now) days = 7;
    next.setDate(next.getDate() + days);
  }
  return next.toISOString();
}
const MODEL = 'codex/gpt-5.4';
let generation = 0;
const instanceId = randomUUID();
const PROJECT_ID = 'demo-project';
const DATE = '2026-01-01T12:00:00.000Z';
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
const project = {
  id: PROJECT_ID,
  owner: 'local',
  repo: 'Welcome to Verity',
  kind: 'local',
  containerName: 'demo',
  imageRef: null,
  state: 'active',
  provisionError: null,
  setupStatus: 'complete',
  overviewVisible: true,
  collapsed: false,
  createdAt: DATE,
  updatedAt: DATE,
};
interface DemoSession {
  detail: SessionDetail;
  automation?: SessionAutomation;
  events: StreamEventFrame[];
  timers: Set<ReturnType<typeof setTimeout>>;
  files: Record<string, string>;
}
const projects = new Map<string, typeof project>();
let settings = initialSettings();
function initialSettings() {
  return {
    gitUserName: 'Demo',
    gitUserEmail: 'demo@example.invalid',
    gitSshPrivateKeyPath: null,
    gitSshPublicKeyPath: null,
    gitKnownHostsPath: null,
    gitAllowedSignersPath: null,
    gitSshPrivateKeyConfigured: false,
    gitSshPublicKeyConfigured: false,
    gitKnownHostsConfigured: false,
    gitAllowedSignersConfigured: false,
    githubAppId: null,
    githubAppInstallationId: null,
    githubAppPrivateKeyConfigured: false,
    dopplerServiceTokenConfigured: false,
    uplinkSubscriptionKeyConfigured: false,
    uplinkInstallationId: null,
    transcribeBaseUrl: null,
    transcribeModel: null,
    transcribeBackendMode: null,
    transcribeApiKeyConfigured: false,
    transcribeLocalAvailable: false,
    claudeCodeOauthCredentialsConfigured: true,
    codexAuthJsonConfigured: true,
    claudeSubscriptionPlan: 'Max 20x',
    codexSubscriptionPlan: 'Plus',
    googleDriveClientId: null,
    googleDriveAccountEmail: null,
    googleDriveConnected: false,
    advancedModeEnabled: false,
    createdAt: DATE,
    updatedAt: DATE,
  };
}
const sessions = new Map<string, DemoSession>();
let versionSequence = 0;
let fileVersions = new WeakMap<object, Map<string, { content: string; version: string }>>();

function fileVersion(files: Record<string, string>, path: string): string {
  let versions = fileVersions.get(files);
  if (!versions) {
    versions = new Map();
    fileVersions.set(files, versions);
  }
  const content = files[path]!;
  let current = versions.get(path);
  if (!current || current.content !== content) {
    current = { content, version: `demo-${generation}-${++versionSequence}` };
    versions.set(path, current);
  }
  return current.version;
}
const sockets = new Set<DemoSocket>();
let nextId = 1;
const initialFiles = {
  'README.md':
    '# Verity demo\n\nThis local sample lets you explore projects, sessions, files and Knowledge without a server. All agent replies are simulated.\n',
  'src/Button.tsx':
    "export const Button = () => <button style={{ color: '#2563eb' }}>Get started</button>;\n",
  'docs/plan.md':
    '# Project plan\n\n- Explore the project\n- Ask the demo agent to change the button color\n- Review the file and the change\n',
};
const initialKnowledgeFiles = {
  'getting-started.md':
    '# Getting started\n\nConnect your own Verity server to run real AI sessions. This demo stays on your device.\n',
};
let knowledgeFiles = { ...initialKnowledgeFiles };
const document = {
  id: 'demo-guide',
  folderId: 'demo-knowledge',
  title: 'Getting started',
  currentRevisionId: 'demo-revision',
  bodyMarkdown: knowledgeFiles['getting-started.md'],
};
function makeSession(id: string, name: string | null, model = MODEL): DemoSession {
  return {
    detail: {
      sessionId: id,
      name,
      model,
      projectId: PROJECT_ID,
      worktree: '/demo/welcome',
      status: 'idle',
      usage: { ...usage, turns: 0 },
      eventCount: 0,
      busy: false,
      queued: [],
      lastSeenEventCount: 0,
    },
    events: [],
    timers: new Set(),
    files: { ...initialFiles },
  };
}
function append(session: DemoSession, event: StreamEventFrame['event']): void {
  const frame: StreamEventFrame = {
    k: 'event',
    seq: session.events.length + 1,
    ts: Date.now(),
    event,
  };
  session.events.push(frame);
  session.detail.eventCount = frame.seq;
  for (const socket of sockets)
    if (socket.sessionId === session.detail.sessionId) socket.deliverLive(frame);
}
function clearTimers(session: DemoSession): void {
  for (const timer of session.timers) clearTimeout(timer);
  session.timers.clear();
}
/** Reset closes old streams and cancels replies so they cannot leak into the new demo. */
export function resetDemoData(): void {
  for (const session of sessions.values()) clearTimers(session);
  for (const socket of [...sockets]) socket.close();
  sessions.clear();
  nextId = 1;
  generation += 1;
  versionSequence = 0;
  fileVersions = new WeakMap();
  settings = initialSettings();
  knowledgeFiles = { ...initialKnowledgeFiles };
  projects.clear();
  projects.set(PROJECT_ID, { ...project });
  const session = makeSession(`demo-session-${instanceId}-${generation}`, 'Explore Verity');
  sessions.set(session.detail.sessionId, session);
  append(session, {
    t: 'session',
    id: session.detail.sessionId,
    model: MODEL,
    worktree: session.detail.worktree,
  });
  append(session, { t: 'prompt', text: 'Show me what I can do in Verity.' });
  append(session, {
    t: 'text',
    delta:
      'Welcome to the local Verity demo! These replies are simulated. Browse the project files and Knowledge, start a session, or ask me to change the button color. Your real servers and data are separate.',
  });
  append(session, {
    t: 'choices',
    question: 'What would you like to explore?',
    options: [
      { label: 'Change the button color', recommended: true },
      { label: 'Explain the project' },
      { label: 'Show an approval request' },
    ],
    multiSelect: false,
  });
  append(session, {
    t: 'tool_call',
    id: 'demo-seed-edit',
    name: 'Edit',
    input: {
      file_path: '/demo/welcome/src/Button.tsx',
      old_string: "'#2563eb'",
      new_string: "'#16a34a'",
    },
  });
  append(session, {
    t: 'tool_result',
    id: 'demo-seed-edit',
    output:
      'Example change: blue button → green button. Ask to apply this change to the sample file.',
    isError: false,
  });
  append(session, { t: 'result', usage, stopReason: 'end_turn' });
}
function schedule(session: DemoSession, delay: number, run: () => void): void {
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    run();
  }, delay);
  session.timers.add(timer);
}
function simulateTurn(session: DemoSession, prompt: string): void {
  session.detail.busy = true;
  session.detail.status = 'running';
  append(session, { t: 'prompt', text: prompt });
  append(session, { t: 'status', state: 'running', message: 'Simulating a demo response' });
  if (/approval|permission|approve|freigabe/i.test(prompt)) {
    const toolId = `demo-permission-${session.events.length}`;
    session.detail.pendingPermissions = [toolId];
    session.detail.status = 'awaiting_input';
    session.detail.permissionAwaitingInput = true;
    append(session, {
      t: 'text',
      delta:
        'This simulated tool request demonstrates how you review an action before allowing it. No command will actually run.',
    });
    append(session, {
      t: 'permission',
      id: toolId,
      tool: 'Bash',
      input: { command: 'npm test' },
      riskClass: 'ask',
    });
    append(session, { t: 'status', state: 'awaiting_input' });
    return;
  }
  if (
    /automation|recurring|regularly|every (day|morning|evening|week|hour|monday|tuesday|wednesday|thursday|friday)|daily|weekly|hourly|regelmäßig|täglich|wöchentlich|jeden (tag|morgen|abend|montag|dienstag|mittwoch|donnerstag|freitag)/i.test(
      prompt,
    )
  ) {
    schedule(session, 350, () => {
      append(session, {
        t: 'text',
        delta:
          'This is how a recurring task looks. Confirm it below and this session runs it on schedule. In the demo nothing actually runs.',
      });
      append(session, {
        t: 'automation_proposal',
        proposal: {
          name: 'Morning summary',
          schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 },
          prompt: 'Summarize what changed in the example project since last week.',
        },
      });
      append(session, { t: 'result', usage, stopReason: 'end_turn' });
      session.detail.busy = false;
      session.detail.status = 'idle';
    });
    return;
  }
  const change = /color|colour|button|farbe/i.test(prompt);
  let changeApplied = false;
  schedule(session, 350, () =>
    append(session, {
      t: 'text',
      delta: change
        ? 'I will demonstrate a button color change using the sample project.\n\n'
        : 'This is a simulated response from the local demo. The example project includes a button component, a plan and a README. You can browse and edit those files, create sessions, rename them and explore Knowledge.\n\n',
    }),
  );
  if (change) {
    schedule(session, 700, () =>
      append(session, {
        t: 'tool_call',
        id: `demo-edit-${session.events.length}`,
        name: 'Edit',
        input: {
          file_path: '/demo/welcome/src/Button.tsx',
          old_string: "'#2563eb'",
          new_string: "'#16a34a'",
        },
      }),
    );
    schedule(session, 1100, () => {
      const current = session.files['src/Button.tsx'];
      if (current?.includes('#2563eb')) {
        session.files['src/Button.tsx'] = current.replace('#2563eb', '#16a34a');
        changeApplied = true;
      }
      const call = [...session.events].reverse().find((frame) => frame.event.t === 'tool_call');
      if (call?.event.t === 'tool_call')
        append(session, {
          t: 'tool_result',
          id: call.event.id,
          output: changeApplied
            ? 'Simulated change applied to src/Button.tsx.\n- color: #2563eb\n+ color: #16a34a'
            : 'The original blue color was not found. The current file was preserved.',
          isError: !changeApplied,
        });
    });
  }
  schedule(session, 1500, () => {
    append(session, {
      t: 'text',
      delta: change
        ? changeApplied
          ? 'The sample button is now green. Open Files → src → Button.tsx to inspect or edit it. This demonstration did not run a real AI model or change a remote repository.'
          : 'The sample file no longer contains the original blue color, so nothing was changed. Reset the demo to try the original example again.'
        : 'Try “Change the button color” for a sample tool call and file change. Connect your own server for real AI work and external integrations.',
    });
    append(session, { t: 'result', usage, stopReason: 'end_turn' });
    session.detail.busy = false;
    session.detail.status = 'idle';
    session.detail.usage.turns += 1;
  });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const unsupported = () =>
  json(
    {
      error: 'This action needs a connected Verity server and is unavailable in the local demo.',
      code: 'DEMO_UNAVAILABLE',
    },
    400,
  );
/** The local transport never forwards unknown routes or hosts to network fetch. */
export const demoFetch: typeof fetch = async (input, init) => {
  if (init?.signal?.aborted) {
    const error = new Error('Demo request aborted');
    error.name = 'AbortError';
    throw error;
  }
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (!isDemoUrl(url.origin)) return unsupported();
  const method =
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const path = url.pathname;
  const list = () => [...sessions.values()].map((session) => session.detail);
  if (path === '/healthz' && method === 'GET')
    return json({
      status: 'ok',
      version: 'local-demo',
      pushEnabled: false,
      publicPreviewsEnabled: false,
    });
  if (path === '/onboarding/status' && method === 'GET')
    return json({
      sealed: false,
      masterPasswordSet: true,
      githubAppConfigured: false,
      signingKeyConfigured: false,
      hasProject: true,
      dopplerConfigured: false,
      claudeConfigured: true,
      codexConfigured: true,
      complete: true,
      nextStep: null,
    });
  if (path === '/secret/status' && method === 'GET') return json({ status: 'unmanaged' });
  if (path === '/settings' && method === 'GET') return json({ settings });
  if (path === '/settings' && method === 'PATCH') {
    if (Object.keys(body).some((key) => key !== 'advancedModeEnabled')) return unsupported();
    if (typeof body.advancedModeEnabled === 'boolean')
      settings.advancedModeEnabled = body.advancedModeEnabled;
    return json({ settings });
  }
  if (path === '/settings/signing-key' && method === 'GET')
    return json({ configured: false, publicKey: null });
  if (path === '/models' && method === 'GET')
    return json({ models: [MODEL, 'claude-sonnet-4-6'], default: MODEL });
  if (path === '/provider-limits' && method === 'GET') return json([]);
  if (path === '/projects' && method === 'GET') return json([...projects.values()]);
  if (path === '/projects/order' && method === 'PATCH') {
    if (
      !Array.isArray(body.ids) ||
      body.ids.some((id) => typeof id !== 'string' || !projects.has(id))
    )
      return unsupported();
    const ordered = [...new Set([...(body.ids as string[]), ...projects.keys()])].map((id) =>
      projects.get(id)!,
    );
    projects.clear();
    for (const entry of ordered) projects.set(entry.id, entry);
    return json(ordered);
  }
  if (path === '/projects' && method === 'POST') {
    if (body.kind !== 'local') return unsupported();
    const created = {
      ...project,
      id: `demo-project-${generation}-${nextId++}`,
      repo: String(body.name ?? 'Demo project'),
    };
    projects.set(created.id, created);
    return json({ project: created });
  }
  if (path === '/github/repositories' && method === 'GET') return json([]);
  if (path === '/integrations' && method === 'GET') return json({ accounts: [], sources: [] });
  if (path === '/mcp-connections' && method === 'GET') return json({ connections: [] });
  if (path === '/connections/usage' && method === 'GET')
    return json({
      github: 0,
      claude: 0,
      codex: 0,
      opencode: 0,
      google: 0,
      matrix: 0,
      doppler: 0,
      mcp: 0,
    });
  if (path === '/google-drive/connection' && method === 'GET')
    return json({ connected: false, clientId: null, accountEmail: null, scopes: [] });
  if (path === '/google/connection' && method === 'GET')
    return json({ connected: false, accountEmail: null, scopes: [], projects: [] });
  if (path === '/api/remote-control/descriptor' && method === 'GET')
    return json({ version: 1, enabled: false, reason: 'disabled' });
  if (path === '/api/uplink/diagnostics' && method === 'GET')
    return json({ control: 'disabled', sharing: 'unavailable', remoteControl: 'unavailable' });
  if (path === '/knowledge/folders' && method === 'GET')
    return json({
      folders: [
        {
          id: 'demo-knowledge',
          parentId: null,
          name: 'Welcome project',
          role: 'project',
          projectId: PROJECT_ID,
        },
      ],
    });
  if (path === '/knowledge/documents' && method === 'GET') return json({ documents: [document] });
  if (path === '/knowledge/documents/demo-guide' && method === 'GET') return json({ document });
  if (path === '/knowledge/documents/demo-guide/revisions' && method === 'GET')
    return json({
      revisions: [
        {
          id: 'demo-revision',
          documentId: document.id,
          bodyMarkdown: document.bodyMarkdown,
          authorIdentity: 'Demo',
          createdAt: DATE,
        },
      ],
    });
  if (path === '/search/messages' && method === 'GET') return json({ items: [], nextCursor: null });
  const projectMatch = path.match(/^\/projects\/([^/]+)(.*)$/);
  if (projectMatch && projects.has(projectMatch[1]!)) {
    const activeProject = projects.get(projectMatch[1]!)!;
    const rest = projectMatch[2];
    if (rest === '' && method === 'GET')
      return json({
        project: activeProject,
        settings: {
          projectId: activeProject.id,
          dopplerProject: null,
          dopplerConfig: null,
          defaultBranch: 'main',
          defaultModel: MODEL,
          createdAt: DATE,
          updatedAt: DATE,
        },
        sessions: list().filter((session) => session.projectId === activeProject.id),
      });
    if (rest === '/setup-status' && method === 'PATCH') return json(activeProject);
    if (rest === '/repair' && method === 'POST') return json({ project: activeProject });
    if (rest === '/collapsed' && method === 'PATCH') {
      activeProject.collapsed = body.collapsed === true;
      return json(activeProject);
    }
    if (method === 'GET') {
      const payloads: Record<string, unknown> = {
        '/dev-servers': { devServers: [] },
        '/dev-server-suggestions': { suggestions: [] },
        '/public-shares': { shares: [] },
        '/secret-grants': { grants: [] },
        '/mcp-bindings': { bindings: [] },
        '/integrations': { sources: [] },
        '/knowledge-grants': {
          grants: [{ folderId: 'demo-knowledge', mode: 'read_write', fixed: 'project' }],
        },
      };
      if (rest in payloads) return json(payloads[rest]);
      if (rest.startsWith('/google/'))
        return json({
          connected: false,
          enabled: false,
          accountEmail: null,
          scopes: [],
          legacySessionCount: 0,
          clientId: null,
        });
    }
  }
  if (path === '/sessions') {
    if (method === 'GET')
      return json(url.searchParams.has('envelope') ? { sessions: list(), attention: [] } : list());
    if (method === 'POST') {
      const id =
        typeof body.sessionId === 'string'
          ? body.sessionId
          : `demo-created-${instanceId}-${generation}-${nextId++}`;
      if (sessions.has(id)) return json({ sessionId: id, existing: true });
      const session = makeSession(
        id,
        typeof body.name === 'string' ? body.name : null,
        typeof body.model === 'string' ? body.model : MODEL,
      );
      if (typeof body.projectId === 'string' && projects.has(body.projectId))
        session.detail.projectId = body.projectId;
      sessions.set(id, session);
      append(session, {
        t: 'session',
        id,
        model: session.detail.model,
        worktree: session.detail.worktree,
      });
      return json({ sessionId: id });
    }
  }
  const match = path.match(/^\/sessions\/([^/]+)(.*)$/);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    const session = sessions.get(id);
    if (!session) return json({ error: 'Demo session not found.' }, 404);
    const rest = match[2];
    if (rest === '') {
      if (method === 'GET') return json(session.detail);
      if (method === 'DELETE') {
        clearTimers(session);
        sessions.delete(id);
        for (const socket of [...sockets]) if (socket.sessionId === id) socket.close();
        return json({ sessionId: id });
      }
      if (method === 'PATCH') {
        if (typeof body.model === 'string') {
          if (session.detail.busy) append(session, { t: 'interrupted' });
          session.detail.pendingPermissions = [];
          delete session.detail.permissionAwaitingInput;
          clearTimers(session);
          session.detail.busy = false;
          session.detail.status = 'idle';
          session.detail.model = body.model;
          return json({ sessionId: id, model: body.model, deferred: false });
        }
        session.detail.name = typeof body.name === 'string' ? body.name.trim() : null;
        return json({ sessionId: id, name: session.detail.name });
      }
    }
    if (rest === '/stream-ticket' && method === 'POST')
      return json({
        ticket: 'd'.repeat(43),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    if (rest === '/activity' && method === 'GET')
      return json({
        busy: session.detail.busy,
        queued: [],
        pendingPermissions: session.detail.pendingPermissions ?? [],
        name: session.detail.name,
        branch: 'demo/button-color',
      });
    if (rest === '/events' && method === 'GET') {
      const before = Number(url.searchParams.get('beforeSeq') ?? Infinity);
      const events = session.events.filter((event) => event.seq < before);
      const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 200));
      return json({ events: events.slice(-limit), hasMore: events.length > limit });
    }
    if (rest === '/turns' && method === 'POST') {
      if (session.detail.busy)
        return json(
          { error: 'Wait for the demo response or stop it before sending another message.' },
          409,
        );
      simulateTurn(session, typeof body.prompt === 'string' ? body.prompt : 'Show the example');
      return json({ sessionId: id, accepted: true });
    }
    if (rest?.startsWith('/permissions/') && method === 'POST') {
      const toolUseId = decodeURIComponent(rest.slice('/permissions/'.length));
      if (!session.detail.pendingPermissions?.includes(toolUseId))
        return json({ error: 'Demo approval is no longer pending.' }, 404);
      session.detail.pendingPermissions = [];
      delete session.detail.permissionAwaitingInput;
      session.detail.busy = false;
      session.detail.status = 'idle';
      append(session, {
        t: 'text',
        delta:
          body.behavior === 'allow'
            ? 'You allowed the simulated test command. Demo result: the example tests passed.'
            : 'You declined the simulated test command. Nothing was executed.',
      });
      append(session, { t: 'result', usage, stopReason: 'end_turn' });
      return json({ sessionId: id, toolUseId, decided: true });
    }
    if (rest === '/cancel' && method === 'POST') {
      const cancelled = session.detail.busy === true;
      clearTimers(session);
      session.detail.busy = false;
      session.detail.status = 'idle';
      session.detail.pendingPermissions = [];
      delete session.detail.permissionAwaitingInput;
      if (cancelled) append(session, { t: 'interrupted' });
      return json({ sessionId: id, cancelled, droppedQueued: [] });
    }
    if (rest === '/seen' && method === 'PATCH') {
      session.detail.lastSeenEventCount = Math.max(
        session.detail.lastSeenEventCount ?? 0,
        Number(body.eventCount) || 0,
      );
      return json({ sessionId: id, lastSeenEventCount: session.detail.lastSeenEventCount });
    }
    if (rest === '/automation') {
      if (method === 'GET') return json({ automation: session.automation ?? null });
      if (method === 'PUT') {
        const now = new Date().toISOString();
        session.automation = {
          id: `demo-automation-${id}`,
          sessionId: id,
          name: typeof body.name === 'string' ? body.name : 'Automation',
          status: 'enabled',
          schedule: body.schedule as SessionAutomation['schedule'],
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          script: typeof body.script === 'string' ? body.script : null,
          model: null,
          consecutiveErrorCount: 0,
          lastRunAt: null,
          lastOutcome: null,
          lastDetail: null,
          nextRunAt: nextAutomationRun(body.schedule as SessionAutomation['schedule']),
          createdAt: now,
          updatedAt: now,
        };
        session.detail.automation = { status: 'enabled' };
        return json({ automation: session.automation });
      }
      if (!session.automation) return json({ error: 'automation not found' }, 404);
      if (method === 'PATCH') {
        const status = body.status === 'paused' ? 'paused' : 'enabled';
        session.automation = {
          ...session.automation,
          status,
          nextRunAt: status === 'paused' ? null : nextAutomationRun(session.automation.schedule),
        };
        session.detail.automation = { status };
        return json({ automation: session.automation });
      }
      if (method === 'DELETE') {
        delete session.automation;
        delete session.detail.automation;
        return json({ ok: true });
      }
    }
    if (rest === '/branches' && method === 'GET')
      return json({
        current: 'demo/button-color',
        switchable: ['demo/button-color'],
        currentPr: null,
      });
    if (rest === '/dev-servers' && method === 'GET') return json({ devServers: [] });
    if (rest === '/links' && method === 'GET') return json({ links: [] });
    if (rest === '/linked-message-approvals' && method === 'GET') return json({ approvals: [] });
    if (rest.startsWith('/files')) {
      const root = String(body.root ?? url.searchParams.get('root') ?? 'worktree');
      const files =
        root === 'worktree' ? session.files : root === 'knowledge' ? knowledgeFiles : {};
      const filePath = String(body.path ?? url.searchParams.get('path') ?? '');
      if (rest === '/files' && method === 'GET') {
        const prefix = filePath ? `${filePath}/` : '';
        const entries = new Map<string, unknown>();
        for (const [name, content] of Object.entries(files))
          if (name.startsWith(prefix)) {
            const relative = name.slice(prefix.length);
            const first = relative.split('/')[0]!;
            entries.set(first, {
              name: first,
              path: `${prefix}${first}`,
              kind: relative.includes('/') ? 'directory' : 'file',
              size: relative.includes('/') ? null : content.length,
              modifiedAt: DATE,
            });
          }
        return json({ root, path: filePath, entries: [...entries.values()], truncated: false });
      }
      if (rest === '/files/content' && method === 'PUT') {
        if (!(filePath in files) || typeof body.content !== 'string') return unsupported();
        if (
          body.expectedVersion !== null &&
          body.expectedVersion !== fileVersion(files, filePath)
        ) {
          return json(
            { error: 'The file changed since you opened it. Reload before saving.' },
            409,
          );
        }
        files[filePath as keyof typeof files] = body.content;
      }
      if (rest === '/files/content' && (method === 'GET' || method === 'PUT')) {
        const content = files[filePath as keyof typeof files];
        return content === undefined
          ? json({ error: 'Demo file not found.' }, 404)
          : json({
              path: filePath,
              content,
              size: content.length,
              editable: root !== 'shared',
              version: fileVersion(files, filePath),
            });
      }
      if (rest === '/files/download' && method === 'GET') {
        const content = files[filePath as keyof typeof files];
        return content === undefined
          ? json({ error: 'Demo file not found.' }, 404)
          : new Response(content, { headers: { 'content-type': 'text/plain' } });
      }
      if (rest === '/files/history' && method === 'GET')
        return json(
          url.searchParams.has('version')
            ? { content: files[filePath as keyof typeof files] ?? '' }
            : { versions: [] },
        );
    }
  }
  return unsupported();
};
class DemoSocket implements StreamSocket {
  readonly sessionId: string;
  private listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  private closed = false;
  private replayed = false;
  private replayTimer: ReturnType<typeof setTimeout>;
  constructor(url: string) {
    const parsed = new URL(url);
    this.sessionId = decodeURIComponent(parsed.pathname.split('/')[2] ?? '');
    sockets.add(this);
    this.replayTimer = setTimeout(() => {
      const session = sessions.get(this.sessionId);
      if (!session) {
        this.deliver({ k: 'error', message: 'Demo session not found.' });
        return;
      }
      const since = Number(parsed.searchParams.get('sinceSeq') ?? 0);
      for (const frame of session.events) if (frame.seq > since) this.deliver(frame);
      this.replayed = true;
      this.deliver({ k: 'caught_up', seq: session.events.length });
    }, 0);
  }
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  deliver(frame: unknown): void {
    if (!this.closed)
      for (const listener of this.listeners.get('message') ?? [])
        listener({ data: JSON.stringify(frame) });
  }
  deliverLive(frame: StreamEventFrame): void {
    // A turn can start before the scheduled replay. Replay owns these events
    // until caught up; sending them early drops older history in the reducer.
    if (this.replayed) this.deliver(frame);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.replayTimer);
    sockets.delete(this);
    for (const listener of this.listeners.get('close') ?? []) listener({ data: null });
    this.listeners.clear();
  }
}
export function createDemoSocket(url: string, _protocols?: string | string[]): StreamSocket {
  if (!isDemoUrl(url)) throw new Error('The demo socket only accepts the local demo address.');
  return new DemoSocket(url);
}
resetDemoData();
