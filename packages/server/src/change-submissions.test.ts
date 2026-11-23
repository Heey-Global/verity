import type { AgentEvent } from '@verity/events';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  changeSubmissionStatus,
  registerChangeSubmissionRoutes,
  submissionAddressedTo,
  type ChangeSubmissionView,
  type PullRequestPhase,
} from './change-submissions.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.db
    .insertInto('users')
    .values([
      { id: 'mara', role: 'member', status: 'active', display_name: 'Mara' },
      { id: 'alex', role: 'member', status: 'active', display_name: 'Alex' },
      { id: 'sam', role: 'member', status: 'active' },
    ])
    .execute();
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'acme',
    repo: 'site',
    containerName: 'acme-site',
    state: 'active',
  });
  // Mara and Sam edit; Alex also holds Code.
  await ctx.db
    .insertInto('project_memberships')
    .values(
      (['mara', 'alex', 'sam'] as const).map((userId) => ({
        project_id: 'p1',
        user_id: userId,
        can_read: true,
        can_execute: true,
        can_code: userId === 'alex',
        can_manage: false,
      })),
    )
    .execute();
  await ctx.store.createSession({
    sessionId: 's1',
    worktree: '/wt/s1',
    model: 'm',
    projectId: 'p1',
  });
});

describe('change submission status', () => {
  it('follows the pull request first, then whoever with Code wrote', () => {
    expect(changeSubmissionStatus({ state: 'submitted' })).toBe('waiting');
    expect(changeSubmissionStatus({ state: 'submitted', checker: 'alex' })).toBe('checking');
    expect(changeSubmissionStatus({ state: 'submitted', checker: 'alex', prPhase: 'open' })).toBe(
      'adding',
    );
    expect(changeSubmissionStatus({ state: 'submitted', prPhase: 'merged' })).toBe('added');
    expect(changeSubmissionStatus({ state: 'added' })).toBe('added');
    expect(changeSubmissionStatus({ state: 'withdrawn', prPhase: 'open' })).toBeUndefined();
  });

  // Everyone with Code sees new changes; once one of them writes, the others are
  // spared a review someone already took on.
  it('waits on every member with Code until one writes, then only on them', () => {
    const view = (checker?: string): ChangeSubmissionView => ({
      status: checker === undefined ? 'waiting' : 'checking',
      submittedBy: { id: 'mara' },
      ...(checker === undefined ? {} : { checker: { id: checker } }),
      submittedAt: 0,
    });
    expect(submissionAddressedTo('alex', view(), true)).toBe(true);
    expect(submissionAddressedTo('kim', view(), true)).toBe(true);
    expect(submissionAddressedTo('sam', view(), false)).toBe(false);
    expect(submissionAddressedTo('mara', view(), true)).toBe(false);
    expect(submissionAddressedTo('alex', view('alex'), true)).toBe(true);
    expect(submissionAddressedTo('kim', view('alex'), true)).toBe(false);
    expect(submissionAddressedTo('alex', { ...view('alex'), status: 'added' }, true)).toBe(false);
  });
});

describe('change submission routes', () => {
  const setup = () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      const user = request.headers['x-user'];
      if (typeof user === 'string') request.localUserId = user;
    });
    const published: AgentEvent[] = [];
    let pr: { phase: PullRequestPhase; url: string; headSha: string } | undefined;
    let hasChanges: boolean | undefined;
    registerChangeSubmissionRoutes(app, {
      store: ctx.store,
      publish: async (sessionId, event) => {
        published.push(event);
        await ctx.store.appendEvent(sessionId, event);
      },
      revision: async () => 'abc123',
      pullRequest: async () => pr,
      hasChanges: async () => hasChanges,
    });
    const call = async (method: 'GET' | 'POST' | 'DELETE', user?: string) => {
      const response = await app.inject({
        method,
        url: '/sessions/s1/change-submission',
        ...(user === undefined ? {} : { headers: { 'x-user': user } }),
      });
      return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
    };
    return {
      app,
      call,
      published,
      setPullRequest: (phase: PullRequestPhase, url = 'https://forge/pr/2', headSha = 'h1') =>
        (pr = { phase, url, headSha }),
      setChanges: (next: boolean | undefined) => (hasChanges = next),
    };
  };

  it('submits, reports who checks and adds, and records it in the history', async () => {
    const { app, call, published, setPullRequest } = setup();
    try {
      expect((await call('GET', 'mara')).body).toEqual({
        submission: null,
        viewerCanCode: false,
        viewerCanSubmit: true,
        shared: true,
      });
      // Without accounts the app can stop asking: nobody will ever submit.
      expect((await call('GET')).body).toEqual({
        submission: null,
        viewerCanCode: true,
        viewerCanSubmit: false,
        shared: false,
      });
      expect((await call('POST', 'mara')).status).toBe(201);
      expect(published).toEqual([
        {
          t: 'notice',
          text: 'Mara submitted changes',
          changeSubmission: { action: 'submitted', userId: 'mara' },
        },
      ]);
      expect(await ctx.store.changeSubmissions.get('s1')).toMatchObject({ revision: 'abc123' });
      expect((await call('GET', 'alex')).body).toMatchObject({
        submission: { status: 'waiting', submittedBy: { id: 'mara', name: 'Mara' } },
        viewerCanCode: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 5));
      // Mara writing again, or Sam without Code, is not a check.
      for (const userId of ['mara', 'sam', 'alex']) {
        await ctx.store.appendEvent('s1', { t: 'prompt', text: 'hi', initiatedBy: { userId } });
      }
      expect((await call('GET', 'mara')).body).toMatchObject({
        submission: { status: 'checking', checker: { id: 'alex', name: 'Alex' } },
      });
      setPullRequest('open');
      expect((await call('GET', 'mara')).body).toMatchObject({ submission: { status: 'adding' } });
      setPullRequest('merged');
      expect((await call('GET', 'mara')).body).toMatchObject({ submission: { status: 'added' } });
    } finally {
      await app.close();
    }
  });

  it('refuses what would mislead: Code holders, empty sessions, a second submission', async () => {
    const { app, call, published, setChanges } = setup();
    try {
      // Someone with Code adds changes directly.
      expect((await call('POST', 'alex')).status).toBe(409);
      // A reader may look but not hand changes on.
      await ctx.db
        .updateTable('project_memberships')
        .set({ can_execute: false })
        .where('user_id', '=', 'sam')
        .execute();
      expect((await call('POST', 'sam')).status).toBe(403);
      setChanges(false);
      expect((await call('POST', 'mara')).status).toBe(409);
      setChanges(true);
      expect((await call('POST', 'mara')).status).toBe(201);
      // Submitting again would ask every reviewer anew for the same changes.
      expect((await call('POST', 'mara')).status).toBe(200);
      expect(published).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('does not take a pull request from before the submission for these changes', async () => {
    const { app, call, setPullRequest } = setup();
    try {
      setPullRequest('merged', 'https://forge/pr/1');
      await call('POST', 'mara');
      expect((await call('GET', 'mara')).body).toMatchObject({ submission: { status: 'waiting' } });
      setPullRequest('open', 'https://forge/pr/2');
      expect((await call('GET', 'mara')).body).toMatchObject({ submission: { status: 'adding' } });
    } finally {
      await app.close();
    }
  });

  it('counts a pull request open at submission once someone pushes to it', async () => {
    const { app, call, setPullRequest } = setup();
    try {
      setPullRequest('open', 'https://forge/pr/3', 'before');
      await call('POST', 'mara');
      expect((await call('GET', 'mara')).body).toMatchObject({ submission: { status: 'waiting' } });
      setPullRequest('open', 'https://forge/pr/3', 'after');
      expect((await call('GET', 'mara')).body).toMatchObject({ submission: { status: 'adding' } });
    } finally {
      await app.close();
    }
  });

  it('counts a pull request that already carries the submitted commit', async () => {
    const { app, call, setPullRequest } = setup();
    try {
      // The agent pushed the submitted commit before the submission; merging it
      // without another push still adds these changes.
      setPullRequest('open', 'https://forge/pr/4', 'abc123');
      await call('POST', 'mara');
      setPullRequest('merged', 'https://forge/pr/4', 'abc123');
      expect((await call('GET', 'mara')).body).toMatchObject({ submission: { status: 'added' } });
    } finally {
      await app.close();
    }
  });

  // Merged changes are done: the member must be able to submit follow-up work,
  // and nobody can take back what already landed.
  it('settles a submission whose pull request merged', async () => {
    const { app, call, published, setPullRequest } = setup();
    try {
      await call('POST', 'mara');
      setPullRequest('merged');
      expect((await call('DELETE', 'mara')).status).toBe(409);
      // Reading leaves the row alone; the member's next submission settles it.
      expect((await ctx.store.changeSubmissions.get('s1'))?.state).toBe('submitted');
      setPullRequest('merged');
      expect((await call('POST', 'mara')).status).toBe(201);
      expect(published.filter((event) => event.t === 'notice')).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('refuses to submit while the pull request cannot be read', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.localUserId = 'mara';
    });
    registerChangeSubmissionRoutes(app, {
      store: ctx.store,
      publish: vi.fn(),
      pullRequest: async () => {
        throw new Error('forge down');
      },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/sessions/s1/change-submission' });
      expect(response.statusCode).toBe(503);
      expect(await ctx.store.changeSubmissions.get('s1')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('lets the submitter or a member with Code withdraw, and nobody else', async () => {
    const { app, call, published } = setup();
    try {
      // Without accounts there is no one to hand changes to.
      expect((await call('POST')).status).toBe(409);
      await call('POST', 'mara');
      expect((await call('DELETE', 'sam')).status).toBe(403);
      expect((await call('DELETE', 'mara')).status).toBe(200);
      expect(published.at(-1)).toMatchObject({
        text: 'Mara withdrew the submitted changes',
        changeSubmission: { action: 'withdrawn', userId: 'mara' },
      });
      expect((await call('GET', 'mara')).body).toMatchObject({ submission: null });
      expect((await call('DELETE', 'mara')).status).toBe(409);
      await call('POST', 'mara');
      expect((await call('DELETE', 'alex')).status).toBe(200);
      expect(published.at(-1)).toMatchObject({ text: 'Alex turned down the submitted changes' });
    } finally {
      await app.close();
    }
  });
});

it('answers 404 for a session that does not exist', async () => {
  const app = Fastify();
  registerChangeSubmissionRoutes(app, { store: ctx.store, publish: vi.fn() });
  try {
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/sessions/none/change-submission' });
      expect(response.statusCode).toBe(404);
    }
  } finally {
    await app.close();
  }
});
