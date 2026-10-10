import type { Conductor } from '@verity/session';
import { InMemoryEventBus } from '@verity/session';
import { WELCOME_SESSION_MARKER, renderWelcomeGuidePrompt } from '@verity/events';
import {
  EventStore,
  LOCAL_PROJECT_OWNER,
  createSealableSecretCipher,
  type ProjectRecord,
  type SealableSecretCipher,
} from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';
import { localProjectInput } from './project-collection-routes.js';
import {
  STARTER_PROJECT_SLUG,
  WELCOME_SESSION_NAME,
  ensureStarterProject,
  welcomeSessionPrompt,
  type WelcomeResponse,
} from './welcome-session.js';

// Creating a session never reaches the conductor; no turn runs here.
const conductor = {} as unknown as Conductor;
const log = { info: vi.fn(), warn: vi.fn() };

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  log.info.mockClear();
  log.warn.mockClear();
});

function storeWith(cipher: SealableSecretCipher): EventStore {
  return new EventStore(ctx.db, cipher);
}

async function starterProject(store: EventStore): Promise<ProjectRecord | undefined> {
  return store.getProjectByOwnerRepo(LOCAL_PROJECT_OWNER, STARTER_PROJECT_SLUG);
}

describe('ensureStarterProject', () => {
  it('creates the starter project on a fresh install and starts provisioning it', async () => {
    const store = storeWith(createSealableSecretCipher());
    const provision = vi.fn(async () => undefined);
    const project = await ensureStarterProject({ store, provision, log });
    expect(project).toMatchObject({ owner: LOCAL_PROJECT_OWNER, repo: STARTER_PROJECT_SLUG });
    expect(project?.kind).toBe('local');
    expect(provision).toHaveBeenCalledWith(project?.id);
    expect((await starterProject(store))?.id).toBe(project?.id);
  });

  it('runs once: a second boot finds the project and creates nothing', async () => {
    const store = storeWith(createSealableSecretCipher());
    const provision = vi.fn(async () => undefined);
    await ensureStarterProject({ store, provision, log });
    expect(await ensureStarterProject({ store, provision, log })).toBeUndefined();
    expect(provision).toHaveBeenCalledTimes(1);
    expect(await store.listProjects({ includeHidden: true })).toHaveLength(1);
  });

  // An upgraded server always has a master password; it must never grow a
  // project its operator did not ask for.
  it('leaves an installation with a master password alone', async () => {
    const cipher = createSealableSecretCipher();
    const store = storeWith(cipher);
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
    });
    try {
      const init = await app.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: 'correct-horse-battery' },
      });
      expect(init.statusCode).toBe(200);
    } finally {
      await app.close();
    }
    const provision = vi.fn(async () => undefined);
    expect(await ensureStarterProject({ store, provision, log })).toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
  });

  it('leaves an installation that already has a project alone, deleted ones included', async () => {
    const store = storeWith(createSealableSecretCipher());
    await store.upsertProject({
      id: 'p-old',
      owner: 'acme',
      repo: 'app',
      containerName: 'dev-acme-app',
      state: 'absent',
    });
    await store.hideProject('p-old');
    const provision = vi.fn(async () => undefined);
    expect(await ensureStarterProject({ store, provision, log })).toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
  });

  // A boot that died after creating the project but before recording it must not
  // leave a starter project that counts as the operator's own forever.
  it('adopts a starter project whose record a crashed boot never wrote', async () => {
    const store = storeWith(createSealableSecretCipher());
    const orphan = await store.createProject(localProjectInput(STARTER_PROJECT_SLUG));
    const provision = vi.fn(async () => undefined);
    expect((await ensureStarterProject({ store, provision, log }))?.id).toBe(orphan.id);
    expect(await store.getStarterProjectId()).toBe(orphan.id);
    expect(provision).toHaveBeenCalledWith(orphan.id);
  });

  it('logs a failed provisioning instead of throwing', async () => {
    const store = storeWith(createSealableSecretCipher());
    const provision = vi.fn(async () => {
      throw new Error('docker is not ready');
    });
    const project = await ensureStarterProject({ store, provision, log });
    expect(project).toBeDefined();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled());
  });
});

describe('POST /onboarding/welcome', () => {
  async function setup(options: { complete?: boolean; starter?: 'active' | 'absent' } = {}) {
    const cipher = createSealableSecretCipher();
    const store = storeWith(cipher);
    if (options.starter !== undefined) {
      await ensureStarterProject({ store, provision: async () => undefined, log });
      if (options.starter === 'active') {
        await store.updateProjectState((await starterProject(store))!.id, 'active');
      }
    }
    const provision = vi.fn(async (projectId: string) => (await store.getProject(projectId))!);
    const bus = new InMemoryEventBus();
    const published = vi.spyOn(bus, 'publish');
    const app = buildServer({
      eventStore: store,
      bus,
      conductor,
      secretCipher: cipher,
      provisioner: { provision },
      projectCloneRoot: '/data/dev',
      projectBackend: (_project, selected) => selected,
      projectWorktrees: () => ({
        add: vi.fn(
          async (branch: string) =>
            `/data/dev/welcome/.verity-sessions/${branch.replace(/\//g, '-')}`,
        ),
        remove: vi.fn(async () => undefined),
      }),
    });
    const init = await app.inject({
      method: 'POST',
      url: '/secret/init',
      payload: { password: 'correct-horse-battery' },
    });
    expect(init.statusCode).toBe(200);
    if (options.complete !== false) {
      await store.updateVeritySettings({ claudeCodeOauthCredentialsJson: '{"token":"t"}' });
    }
    return { app, store, provision, published };
  }

  async function welcome(app: FastifyInstance) {
    const res = await app.inject({ method: 'POST', url: '/onboarding/welcome' });
    return { statusCode: res.statusCode, body: res.json<WelcomeResponse>() };
  }

  it('refuses until onboarding is complete', async () => {
    const { app } = await setup({ complete: false, starter: 'active' });
    try {
      expect((await welcome(app)).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('answers none when there is no starter project', async () => {
    const { app } = await setup();
    try {
      expect(await welcome(app)).toEqual({
        statusCode: 200,
        body: { state: 'none', sessionId: null, projectId: null },
      });
    } finally {
      await app.close();
    }
  });

  it('answers none once the operator deleted the starter project', async () => {
    const { app, store } = await setup({ starter: 'active' });
    try {
      await store.hideProject((await starterProject(store))!.id);
      expect((await welcome(app)).body.state).toBe('none');
    } finally {
      await app.close();
    }
  });

  async function replay(app: FastifyInstance, retry = false) {
    const res = await app.inject({
      method: 'POST',
      url: '/onboarding/welcome',
      payload: { replay: true, retry },
    });
    return { statusCode: res.statusCode, body: res.json<WelcomeResponse>() };
  }

  it('replays an existing welcome session without changing its transcript', async () => {
    const { app, store } = await setup({ starter: 'active' });
    try {
      const original = (await welcome(app)).body;
      const events = await store.getEvents(original.sessionId!);
      expect((await replay(app)).body).toEqual(original);
      expect(await store.getEvents(original.sessionId!)).toEqual(events);
    } finally {
      await app.close();
    }
  });

  it('recreates a deleted welcome session only on explicit replay', async () => {
    const { app, store } = await setup({ starter: 'active' });
    try {
      const original = (await welcome(app)).body;
      await store.deleteSession(original.sessionId!);
      expect((await welcome(app)).body.state).toBe('none');
      const [a, b] = await Promise.all([replay(app), replay(app)]);
      expect(a.body.state).toBe('ready');
      expect(a.body.sessionId).not.toBe(original.sessionId);
      expect(a.body).toEqual(b.body);
      expect(await store.listSessions()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('restores a hidden starter only on explicit replay', async () => {
    const { app, store } = await setup({ starter: 'active' });
    try {
      const projectId = (await store.getStarterProjectId())!;
      await store.hideProject(projectId);
      expect((await welcome(app)).body.state).toBe('none');
      expect((await replay(app)).body).toMatchObject({ state: 'preparing', projectId });
      expect((await store.getProject(projectId))?.hiddenAt).toBeNull();
      await store.updateProjectState(projectId, 'active');
      expect((await replay(app)).body.state).toBe('ready');
    } finally {
      await app.close();
    }
  });

  it('creates one recorded starter on replay without claiming an existing similarly named project', async () => {
    const { app, store } = await setup();
    try {
      const own = await store.createProject(localProjectInput(STARTER_PROJECT_SLUG));
      const [a, b] = await Promise.all([replay(app), replay(app)]);
      expect(a.body.projectId).not.toBe(own.id);
      expect(a.body.projectId).toBe(b.body.projectId);
      expect(await store.listProjects()).toHaveLength(2);
      expect(await store.getStarterProjectId()).toBe(a.body.projectId);
    } finally {
      await app.close();
    }
  });

  it('recreates a permanently deleted starter on explicit replay', async () => {
    const { app, store } = await setup({ starter: 'active' });
    try {
      const oldId = (await store.getStarterProjectId())!;
      await store.deleteProject(oldId);
      expect((await welcome(app)).body.state).toBe('none');
      const result = (await replay(app)).body;
      expect(result.state).toBe('preparing');
      expect(result.projectId).not.toBe(oldId);
      expect(await store.getStarterProjectId()).toBe(result.projectId);
    } finally {
      await app.close();
    }
  });

  it('allows one explicit retry after a replay provisioning failure', async () => {
    const { app, store, provision } = await setup({ starter: 'absent' });
    try {
      const projectId = (await store.getStarterProjectId())!;
      await store.updateProjectState(projectId, 'failed');
      await replay(app);
      await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(1));
      expect((await replay(app)).body.state).toBe('failed');
      await replay(app, true);
      await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(2));
      expect((await replay(app)).body.state).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('does not refresh the retry budget while provisioning is in progress', async () => {
    const { app, store, provision } = await setup({ starter: 'absent' });
    try {
      const projectId = (await store.getStarterProjectId())!;
      await store.updateProjectState(projectId, 'failed');
      await replay(app, true);
      await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(1));
      await store.updateProjectState(projectId, 'cloning');
      expect((await replay(app)).body.state).toBe('preparing');
      await store.updateProjectState(projectId, 'failed');
      expect((await replay(app)).body.state).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('rejects malformed replay flags without creating a project', async () => {
    const { app, store } = await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/onboarding/welcome',
        payload: { replay: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      expect(await store.getStarterProjectId()).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('does not create a replay project before onboarding is complete', async () => {
    const { app, store } = await setup({ complete: false });
    try {
      expect((await replay(app)).statusCode).toBe(409);
      expect(await store.getStarterProjectId()).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('provisions a starter project that is not ready yet and answers preparing', async () => {
    const { app, store, provision } = await setup({ starter: 'absent' });
    try {
      const { body } = await welcome(app);
      expect(body).toMatchObject({ state: 'preparing', sessionId: null });
      await vi.waitFor(() => expect(provision.mock.calls[0]?.[0]).toBe(body.projectId));
      expect(await store.listSessions()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // The app polls every two seconds; a broken sandbox must not be rebuilt on each poll.
  it('retries a failed starter project once, then reports failed', async () => {
    const { app, store, provision } = await setup({ starter: 'absent' });
    try {
      const projectId = (await store.getStarterProjectId())!;
      await store.updateProjectState(projectId, 'failed');
      expect((await welcome(app)).body.state).toBe('preparing');
      await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(1));
      await store.updateProjectState(projectId, 'failed');
      expect((await welcome(app)).body).toEqual({
        state: 'failed',
        sessionId: null,
        projectId,
      });
      expect(provision).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('creates the welcome session once, with the greeting already in it', async () => {
    const { app, store, published } = await setup({ starter: 'active' });
    try {
      const first = await welcome(app);
      expect(first.body.state).toBe('ready');
      const sessionId = first.body.sessionId!;
      expect(await store.getSession(sessionId)).toMatchObject({
        name: WELCOME_SESSION_NAME,
        projectId: first.body.projectId,
      });
      expect(await store.hasSessionAutomationMarker(sessionId, WELCOME_SESSION_MARKER)).toBe(true);

      const events = await store.getEvents(sessionId);
      expect(events.map((event) => event.t)).toEqual(['notice', 'choices', 'status']);
      expect(events[0]).toMatchObject({ role: 'agent' });
      expect((events[0] as { text: string }).text).toContain('(verity://settings/github)');
      expect(events[2]).toEqual({ t: 'status', state: 'completed' });
      // Publishing a closing status after choices reads as "the agent asks you
      // something" and pushes a notification at someone looking at the app.
      expect(published.mock.calls.filter(([id]) => id === sessionId)).toEqual([]);

      const again = await welcome(app);
      expect(again.body).toEqual(first.body);
      expect(await store.listSessions()).toHaveLength(1);
      expect(await store.getEvents(sessionId)).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  // A crash between creating the session and marking it would otherwise make
  // every later request create another "Welcome" session next to the empty one.
  it('adopts an empty, unmarked welcome session instead of adding a second', async () => {
    const { app, store } = await setup({ starter: 'active' });
    try {
      const projectId = (await store.getStarterProjectId())!;
      await store.createSession({
        sessionId: 's-orphan',
        worktree: '/data/dev/welcome/.verity-sessions/orphan',
        model: 'claude-opus-5',
        name: WELCOME_SESSION_NAME,
        projectId,
      });
      const { body } = await welcome(app);
      expect(body).toMatchObject({ state: 'ready', sessionId: 's-orphan' });
      expect(await store.listSessions()).toHaveLength(1);
      expect((await store.getEvents('s-orphan')).map((event) => event.t)).toEqual([
        'notice',
        'choices',
        'status',
      ]);
    } finally {
      await app.close();
    }
  });

  it('writes the greeting into a marked session a crash left empty', async () => {
    const { app, store } = await setup({ starter: 'active' });
    try {
      const projectId = (await store.getStarterProjectId())!;
      await store.createSession({
        sessionId: 's-marked',
        worktree: '/data/dev/welcome/.verity-sessions/marked',
        model: 'claude-opus-5',
        name: WELCOME_SESSION_NAME,
        projectId,
      });
      await store.markSessionAutomation('s-marked', WELCOME_SESSION_MARKER);
      expect((await welcome(app)).body.sessionId).toBe('s-marked');
      expect(await store.getEvents('s-marked')).toHaveLength(3);
      await welcome(app);
      expect(await store.getEvents('s-marked')).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  it('creates a single session when the app asks twice at once', async () => {
    const { app, store } = await setup({ starter: 'active' });
    try {
      const [a, b] = await Promise.all([welcome(app), welcome(app)]);
      expect(a.body.sessionId).toBe(b.body.sessionId);
      expect(await store.listSessions()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // A slug match would hand an operator's own project of that name a seeded
  // welcome session, and hide it from the pristine-install signal.
  it('ignores an operator project that merely shares the starter name', async () => {
    const { app, store } = await setup();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/projects',
        payload: { kind: 'local', name: 'Getting started' },
      });
      expect(created.statusCode).toBe(201);
      const projectId = created.json<{ project: { id: string } }>().project.id;
      await store.updateProjectState(projectId, 'active');
      expect((await welcome(app)).body.state).toBe('none');
      expect(await store.listSessions()).toEqual([]);
      const status = await app.inject({ method: 'GET', url: '/onboarding/status' });
      expect(status.json<{ hasProject: boolean }>().hasProject).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('keeps the starter project out of the pristine-install signal', async () => {
    const { app } = await setup({ starter: 'active' });
    try {
      const res = await app.inject({ method: 'GET', url: '/onboarding/status' });
      expect(res.json<{ hasProject: boolean }>().hasProject).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('welcomeSessionPrompt', () => {
  it('adds the guide prompt to the welcome session only', async () => {
    const store = {
      hasSessionAutomationMarker: vi.fn(
        async (sessionId: string, marker: string) =>
          sessionId === 'welcome' && marker === WELCOME_SESSION_MARKER,
      ),
    };
    expect(await welcomeSessionPrompt(store, 'welcome')).toBe(renderWelcomeGuidePrompt());
    expect(await welcomeSessionPrompt(store, 'other')).toBe('');
  });
});
