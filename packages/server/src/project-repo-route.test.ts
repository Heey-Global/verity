import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';

import type { ProjectRecord } from '@verity/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ForgeOperationError,
  type ForgePullRequestView,
  type ForgeRepositoryOperations,
} from './forge-provider.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import { markInternalConnections } from './internal-listener.js';
import {
  registerProjectRepoRoute,
  type ProjectRepository,
  type ProjectRepoRouteDeps,
} from './project-repo-route.js';

const binding = { projectId: 'p', containerGeneration: 'g', owner: 'team', repo: 'site' };
const pull: ForgePullRequestView = {
  number: 7,
  title: 'Add search',
  url: 'https://git.example.org/team/site/pulls/7',
  state: 'open',
  draft: false,
  head: 'feat/7-search',
  base: 'main',
  body: '',
};

function project(kind: ProjectRecord['kind']): ProjectRecord {
  return { id: 'p', kind, owner: 'team', repo: 'site' } as ProjectRecord;
}

function operations(overrides: Partial<ForgeRepositoryOperations> = {}): ForgeRepositoryOperations {
  return {
    defaultBranch: vi.fn().mockResolvedValue('main'),
    createPullRequest: vi.fn().mockResolvedValue(pull),
    findPullRequest: vi.fn().mockResolvedValue(null),
    markPullRequestReady: vi.fn().mockResolvedValue(pull),
    viewIssue: vi.fn().mockResolvedValue(null),
    commentOnIssue: vi.fn().mockResolvedValue({ url: 'https://example/c/1' }),
    readFile: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

function setup(options: {
  store?: ProjectRepoRouteDeps['store'];
  getSession?: ProjectRepoRouteDeps['getSession'];
  currentRepositoryBranch?: ProjectRepoRouteDeps['currentRepositoryBranch'];
  kind?: ProjectRecord['kind'];
  ops?: ForgeRepositoryOperations;
  socket?: { projectId: string; containerGeneration: string } | 'external';
  repository?: ProjectRepository | undefined | null;
}) {
  app = Fastify();
  const socket = options.socket ?? { projectId: 'p', containerGeneration: 'g' };
  if (socket !== 'external') {
    const connections = new EventEmitter();
    markInternalConnections(connections as unknown as Server, socket);
    app.addHook('onRequest', async (request) => {
      connections.emit('connection', request.raw.socket);
    });
  }
  const ops = options.ops ?? operations();
  const repositoryFor = vi.fn().mockResolvedValue(
    options.repository === null
      ? undefined
      : (options.repository ?? {
          hostName: 'Forgejo',
          operations: ops,
          listIssues: vi.fn().mockResolvedValue({ connected: true, viewerLogin: null, issues: [] }),
        }),
  );
  registerProjectRepoRoute(app, {
    capabilities: {
      resolve: async (token: string) => (token === 'cap' ? binding : undefined),
    } as unknown as GhTokenCapabilityRegistry,
    getProject: async () => project(options.kind ?? 'forgejo'),
    repositoryFor,
    ...(options.store ? { store: options.store } : {}),
    ...(options.getSession ? { getSession: options.getSession } : {}),
    ...(options.currentRepositoryBranch
      ? { currentRepositoryBranch: options.currentRepositoryBranch }
      : {}),
  });
  const call = (payload: unknown, token = 'cap') =>
    app.inject({
      method: 'POST',
      url: '/internal/project/repo',
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });
  return { ops, call, repositoryFor };
}

describe('POST /internal/project/repo', () => {
  // The repository is the server's choice; a request that could pick another
  // project's socket or capability would reach a foreign repository.
  it.each([
    ['an unknown capability', {}, 'other'],
    ['a foreign project socket', { socket: { projectId: 'q', containerGeneration: 'g' } }, 'cap'],
    [
      'an older container generation',
      { socket: { projectId: 'p', containerGeneration: 'old' } },
      'cap',
    ],
    ['an external connection', { socket: 'external' as const }, 'cap'],
  ] as const)('rejects %s', async (_name, options, token) => {
    const { call, repositoryFor } = setup(options);
    const response = await call({ action: 'issue.list' }, token);
    expect(response.statusCode).toBe(401);
    expect(repositoryFor).not.toHaveBeenCalled();
  });

  it('ignores any repository named in the request', async () => {
    const { call, ops } = setup({});
    await call({
      action: 'pr.create',
      title: 'Add search',
      head: 'feat/7-search',
      owner: 'evil',
      repo: 'other',
    });
    expect(ops.createPullRequest).toHaveBeenCalledWith({
      head: 'feat/7-search',
      base: 'main',
      title: 'Add search',
      body: '',
    });
  });

  it('explains that a local project has no code host', async () => {
    const { call } = setup({ kind: 'local' });
    const response = await call({ action: 'issue.list' });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toContain('no code host');
  });

  it('reports a missing connection', async () => {
    const { call } = setup({ repository: null });
    expect((await call({ action: 'issue.list' })).statusCode).toBe(503);
  });

  it('reuses an existing pull request for an idempotent retry', async () => {
    const { call, ops } = setup({
      ops: operations({ findPullRequest: vi.fn().mockResolvedValue(pull) }),
    });
    const response = await call({ action: 'pr.create', title: 'Again', head: 'feat/7-search' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ pullRequest: { number: number } }>().pullRequest.number).toBe(
      pull.number,
    );
    expect(ops.createPullRequest).not.toHaveBeenCalled();
  });

  it('uses an explicit base and returns the opened pull request', async () => {
    const { call, ops } = setup({});
    const response = await call({
      action: 'pr.create',
      title: 'Add search',
      body: 'Closes #7',
      head: 'feat/7-search',
      base: 'release',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ host: 'Forgejo', pullRequest: pull });
    expect(ops.defaultBranch).not.toHaveBeenCalled();
    expect(ops.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'release' }),
    );
  });

  it.each(['release+next', 'feature@next', 'feat/überprüfung'])(
    'accepts the existing Git branch %s',
    async (head) => {
      // Git is the authority for names a code host can already contain.
      execFileSync('git', ['check-ref-format', '--branch', head]);
      const { call, ops } = setup({});
      expect((await call({ action: 'pr.create', title: 'Existing branch', head })).statusCode).toBe(
        200,
      );
      expect(ops.findPullRequest).toHaveBeenCalledWith({ head });
      expect(ops.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ head }));
    },
  );

  it.each([
    ['-x'],
    ['feat branch'],
    [''],
    ['a..b'],
    ['a.lock'],
    ['a//b'],
    ['a/.b'],
    ['a@{b'],
    ['a.'],
    ['a:b'],
  ])('rejects the branch %j', async (head) => {
    const { call, ops } = setup({});
    const response = await call({ action: 'pr.create', title: 'x', head });
    expect(response.statusCode).toBe(400);
    expect(ops.createPullRequest).not.toHaveBeenCalled();
  });

  it('marks the branch pull request ready and refuses a closed one', async () => {
    const draft = { ...pull, draft: true };
    const { call, ops } = setup({
      ops: operations({ findPullRequest: vi.fn().mockResolvedValue(draft) }),
    });
    expect((await call({ action: 'pr.ready', head: 'feat/7-search' })).statusCode).toBe(200);
    expect(ops.findPullRequest).toHaveBeenCalledWith({ head: 'feat/7-search' });
    expect(ops.markPullRequestReady).toHaveBeenCalledWith(7);

    const closed = setup({
      ops: operations({ findPullRequest: vi.fn().mockResolvedValue({ ...pull, state: 'merged' }) }),
    });
    expect((await closed.call({ action: 'pr.ready', number: 7 })).statusCode).toBe(409);
    expect(closed.ops.markPullRequestReady).not.toHaveBeenCalled();
  });

  it('views pull requests and issues, and comments', async () => {
    const issue = {
      number: 3,
      title: 'Bug',
      url: 'https://git.example.org/team/site/issues/3',
      state: 'open' as const,
      body: 'Broken',
      labels: ['bug'],
    };
    const { call, ops } = setup({
      ops: operations({
        findPullRequest: vi.fn().mockResolvedValue(pull),
        viewIssue: vi.fn().mockResolvedValue(issue),
      }),
    });
    expect((await call({ action: 'pr.view', number: 7 })).json()).toEqual({
      host: 'Forgejo',
      pullRequest: pull,
    });
    expect((await call({ action: 'issue.view', number: 3 })).json()).toEqual({
      host: 'Forgejo',
      issue,
    });
    expect((await call({ action: 'issue.comment', number: 3, body: 'On it' })).statusCode).toBe(
      200,
    );
    expect(ops.commentOnIssue).toHaveBeenCalledWith(3, 'On it');
    expect((await call({ action: 'pr.view' })).statusCode).toBe(400);
  });

  it('forwards forge refusals without request internals', async () => {
    const { call } = setup({
      ops: operations({
        createPullRequest: vi
          .fn()
          .mockRejectedValue(
            new ForgeOperationError('create pull request: Forgejo rejected the request', 422),
          ),
      }),
    });
    const response = await call({ action: 'pr.create', title: 'x', head: 'feat/1-x' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'create pull request: Forgejo rejected the request' });

    const crashed = setup({
      ops: operations({ viewIssue: vi.fn().mockRejectedValue(new Error('token=secret')) }),
    });
    const failed = await crashed.call({ action: 'issue.view', number: 1 });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain('secret');
  });
});

it('records a pull request against its validated session after a branch change', async () => {
  const remember = vi.fn();
  const { call } = setup({
    store: {
      getProjectRepository: vi.fn().mockResolvedValue({
        ...project('forgejo'),
        projectId: 'p',
        id: 'extra',
        removedAt: null,
        isDefault: false,
      }),
      listProjectRepositories: vi.fn(),
      recordRepositoryPullRequest: remember,
      upsertSessionRepositoryWorkspace: vi.fn(),
    },
    getSession: vi.fn().mockResolvedValue({ projectId: 'p' }),
    currentRepositoryBranch: vi.fn().mockResolvedValue(pull.head),
  });
  const response = await call({
    action: 'pr.create',
    repositoryId: 'extra',
    sessionId: 'session',
    title: pull.title,
    head: pull.head,
  });
  expect(response.statusCode).toBe(200);
  expect(remember).toHaveBeenCalledWith('p', 'extra', pull.head, pull, 'session');
});
it('rejects a foreign session before contacting the remote repository', async () => {
  const { call, repositoryFor } = setup({
    getSession: vi.fn().mockResolvedValue({ projectId: 'foreign' }),
  });
  expect((await call({ action: 'pr.view', sessionId: 'foreign', number: 7 })).statusCode).toBe(404);
  expect(repositoryFor).not.toHaveBeenCalled();
});

it('publishes and stores explicit PR dependency references', async () => {
  const dependsOn = ['https://github.com/team/api/pull/1'];
  const remember = vi.fn();
  const { call, ops } = setup({
    store: {
      getProjectRepository: vi.fn(),
      listProjectRepositories: vi.fn(),
      upsertSessionRepositoryWorkspace: vi.fn(),
      recordRepositoryPullRequest: remember,
    },
  });
  expect(
    (
      await call({
        action: 'pr.create',
        title: 'Consumer',
        head: pull.head,
        body: 'Change',
        dependsOn,
      })
    ).statusCode,
  ).toBe(200);
  expect(ops.createPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({ body: `Change\n\nDepends on: ${dependsOn[0]}` }),
  );
  expect(remember).toHaveBeenCalledWith(
    'p',
    'default:p',
    pull.head,
    { ...pull, dependsOn },
    undefined,
  );
  vi.mocked(ops.findPullRequest).mockResolvedValue(pull);
  remember.mockClear();
  expect(
    (
      await call({
        action: 'pr.create',
        title: 'Retry',
        head: pull.head,
        dependsOn: ['https://github.com/team/api/pull/2'],
      })
    ).statusCode,
  ).toBe(200);
  // A retry cannot rewrite local dependencies without publishing the same remote body.
  expect(remember).toHaveBeenCalledWith('p', 'default:p', pull.head, pull, undefined);
  expect(ops.createPullRequest).toHaveBeenCalledTimes(1);
  expect(
    (
      await call({
        action: 'pr.create',
        title: 'Bad',
        head: pull.head,
        dependsOn: ['javascript:alert(1)'],
      })
    ).statusCode,
  ).toBe(400);
});

it('does not associate a viewed PR from another branch with the active workspace', async () => {
  const remember = vi.fn();
  const { call } = setup({
    ops: operations({ findPullRequest: vi.fn().mockResolvedValue(pull) }),
    getSession: vi.fn().mockResolvedValue({ projectId: 'p' }),
    currentRepositoryBranch: vi.fn().mockResolvedValue('other-branch'),
    store: {
      getProjectRepository: vi.fn(),
      listProjectRepositories: vi.fn(),
      recordRepositoryPullRequest: remember,
      upsertSessionRepositoryWorkspace: vi.fn(),
    },
  });
  expect((await call({ action: 'pr.view', number: 7, sessionId: 'session' })).statusCode).toBe(200);
  expect(remember).not.toHaveBeenCalled();
});

it('shares default-repository PR creation while recording each calling session', async () => {
  let release!: (pr: ForgePullRequestView) => void;
  const gate = new Promise<ForgePullRequestView>((resolve) => {
    release = resolve;
  });
  const create = vi.fn(async () => gate);
  const remember = vi.fn();
  const getSession = vi.fn().mockResolvedValue({ projectId: 'p', worktree: '/wt' });
  const { call, repositoryFor } = setup({
    ops: operations({ createPullRequest: create }),
    getSession,
    currentRepositoryBranch: async () => pull.head,
    store: {
      getProjectRepository: vi.fn().mockResolvedValue({
        ...project('forgejo'),
        projectId: 'p',
        id: 'default:p',
        isDefault: true,
        removedAt: null,
      }),
      listProjectRepositories: vi.fn(),
      upsertSessionRepositoryWorkspace: vi.fn(),
      recordRepositoryPullRequest: remember,
    },
  });
  const first = call({
    action: 'pr.create',
    title: 'First',
    head: pull.head,
    sessionId: 'one',
    dependsOn: ['https://github.com/team/api/pull/1'],
  });
  const second = call({
    action: 'pr.create',
    title: 'Second',
    head: pull.head,
    sessionId: 'two',
    repositoryId: 'default:p',
  });
  const completed = Promise.all([first, second]);
  await vi.waitFor(() => expect(repositoryFor).toHaveBeenCalledTimes(2));
  release(pull);
  expect((await completed).map((response) => response.statusCode)).toEqual([200, 200]);
  expect(create).toHaveBeenCalledTimes(1);
  for (const session of ['one', 'two'])
    expect(remember).toHaveBeenCalledWith(
      'p',
      'default:p',
      pull.head,
      { ...pull, dependsOn: ['https://github.com/team/api/pull/1'] },
      session,
    );
});
