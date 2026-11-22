import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventBus, type Backend, type RunTurnOptions } from '@verity/session';
import { createIsolatedTestDb } from '@verity/store/testing';
import { expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { createSessionRepositories } from './session-repositories.js';
import type { ServerDeps } from './server-deps.js';
import { buildControlPlane } from './app.js';
import { SessionStorage } from './session-storage.js';
import { createProvisioner, fakeDocker } from './provisioner.test-helper.js';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

async function harness({
  repository,
  model = 'm',
  configured = true,
  kind = 'github',
  prepareLocal = false,
  sandboxGit,
}: {
  repository: boolean;
  model?: string;
  configured?: boolean;
  kind?: 'github' | 'local';
  prepareLocal?: boolean;
  sandboxGit?: ServerDeps['sandboxGit'];
}) {
  const ctx = await createIsolatedTestDb();
  const dataRoot = await mkdtemp(join(tmpdir(), 'code-workspace-routes-'));
  const cloneRoot = join(dataRoot, 'workspaces');
  const clone = join(cloneRoot, 'o-r');
  const view = join(clone, '.verity-document-sessions', 'view');
  await mkdir(view, { recursive: true });
  if (repository) {
    git(['init', '-q', '-b', 'main', clone]);
    git(['-C', clone, 'config', 'user.email', 'test@example.invalid']);
    git(['-C', clone, 'config', 'user.name', 'Test']);
    await writeFile(join(clone, '.gitignore'), '.verity-sessions/\n.verity-document-sessions/\n');
    git(['-C', clone, 'add', '.']);
    git(['-C', clone, 'commit', '-qm', 'initial']);
  }
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'o',
    repo: 'r',
    kind,
    state: 'active',
    containerName: 'o-r',
  });
  await ctx.store.createSession({ sessionId: 's', projectId: 'p', worktree: view, model });
  const cwd = vi.fn();
  const runs: RunTurnOptions[] = [];
  const closeSession = vi.fn();
  const backend: Backend = {
    closeSession,
    run: async (opts) => {
      cwd(opts.cwd);
      runs.push(opts);
      return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
    },
  };
  const app = buildControlPlane({
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    dataRoot,
    projectCloneRoot: configured ? cloneRoot : undefined,
    sessionStorage: new SessionStorage({
      listProjects: () => ctx.store.listProjects(),
      listSessions: () => ctx.store.listSessions(),
      root: () => clone,
      activity: async () => null,
      withGit: async (_, operation) => operation(async (args) => git([...args])),
      mutate: async (_, __, operation) => operation(),
      pr: async () => null,
    }),
    conductor: { backend, codexBackend: backend },
    ...(prepareLocal
      ? {
          provisioner: createProvisioner({
            store: ctx.store,
            db: ctx.db,
            docker: fakeDocker().client,
            projectTokenMint: async () => undefined,
            defaultImageRef: 'image:test',
            hostCloneRoot: cloneRoot,
            prepareLocalWorkspace: undefined,
          }),
        }
      : {}),
    ...(sandboxGit ? { sandboxGit } : {}),
    logger: false,
  });
  return {
    app,
    ctx,
    cwd,
    runs,
    closeSession,
    clone,
    target: join(clone, '.verity-sessions', 'code-s'),
    close: async () => {
      await app.close();
      await ctx.close();
      await rm(dataRoot, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

it("converts a legacy Documents session before its turn and runs it in the session's code", async () => {
  const h = await harness({ repository: true });
  try {
    const turn = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/turns',
      payload: { prompt: 'Continue' },
    });
    expect(turn.statusCode).toBe(202);
    await vi.waitFor(() => expect(h.cwd).toHaveBeenCalled());
    // The Documents view as cwd is the silent fallback this conversion exists to end.
    expect(h.cwd).toHaveBeenCalledWith(h.target);
    expect(await h.ctx.store.getSession('s')).toMatchObject({ worktree: h.target });
    expect(await h.ctx.store.getSessionMoveNotice('s')).toContain('code session');
    expect(await h.ctx.store.getEvents('s')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          t: 'notice',
          text: expect.stringContaining('Code workspace converted'),
        }),
      ]),
    );
  } finally {
    await h.close();
  }
});

it('reports an unrecoverable code workspace instead of falling back to Documents', async () => {
  const h = await harness({ repository: false });
  try {
    const turn = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/turns',
      payload: { prompt: 'Continue' },
    });
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toMatchObject({ code: 'code_workspace_unavailable' });
    expect(h.cwd).not.toHaveBeenCalled();
    const listing = await h.app.inject({ method: 'GET', url: '/sessions/s/files' });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({
      entries: [],
      workspaceKind: 'code',
      codeAvailable: false,
      codeWorkspaceUnavailable: true,
    });
    // A sheet opened on Documents learns it too, or its Code tab and Restore stay disabled.
    const documents = await h.app.inject({
      method: 'GET',
      url: '/sessions/s/files?root=documents',
    });
    expect(documents.statusCode).toBe(200);
    expect(documents.json()).toMatchObject({ root: 'documents', codeWorkspaceUnavailable: true });
    const restore = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/code-workspace/restore',
    });
    expect(restore.statusCode).toBe(409);
    expect(restore.json()).toMatchObject({ code: 'code_workspace_unavailable' });
    expect(await h.ctx.store.getEvents('s')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          t: 'notice',
          text: expect.stringContaining('Code workspace unavailable'),
        }),
      ]),
    );
  } finally {
    await h.close();
  }
});

it('starts Codex in the converted workspace without reusing the old Documents thread', async () => {
  const h = await harness({ repository: true, model: 'codex/default' });
  try {
    await h.ctx.store.upsertSessionBackendState({
      sessionId: 's',
      backend: 'codex',
      backendSessionId: 'old-documents-thread',
      contextSeq: 0,
    });
    const turn = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/turns',
      payload: { prompt: 'Continue' },
    });
    expect(turn.statusCode).toBe(202);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    expect(h.runs[0]).toMatchObject({ cwd: h.target, storeSessionId: 's' });
    expect(h.runs[0]?.resumeSessionId).toBeUndefined();
    expect(h.closeSession).toHaveBeenCalledWith('old-documents-thread');
    expect(h.closeSession.mock.invocationCallOrder[0]).toBeLessThan(
      h.cwd.mock.invocationCallOrder[0]!,
    );
  } finally {
    await h.close();
  }
});

it('keeps Documents usable in a deployment without project clones', async () => {
  const h = await harness({ repository: false, configured: false });
  try {
    const response = await h.app.inject({ method: 'GET', url: '/sessions/s/files' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ workspaceKind: 'documents' });
    expect(response.json().codeWorkspaceUnavailable).not.toBe(true);
  } finally {
    await h.close();
  }
});

it('leaves the Documents view of a local project writable without Code', async () => {
  const h = await harness({ repository: false, kind: 'local', configured: false });
  const permission = vi.spyOn(h.ctx.store, 'hasProjectPermission').mockResolvedValue(false);
  try {
    h.app.addHook('onRequest', async (request) => {
      request.localUserId = 'editor';
    });
    const result = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/files/folders',
      payload: { root: 'worktree', name: 'notes' },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(permission).not.toHaveBeenCalledWith('editor', 'p', 'code');
  } finally {
    permission.mockRestore();
    await h.close();
  }
});

it('recognizes an existing legacy code workspace without a configured clone root', async () => {
  const h = await harness({ repository: true, configured: false });
  const permission = vi.spyOn(h.ctx.store, 'hasProjectPermission').mockResolvedValue(false);
  try {
    await mkdir(h.target, { recursive: true });
    h.app.addHook('onRequest', async (request) => {
      request.localUserId = 'editor';
    });
    const result = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/files/folders',
      payload: { root: 'worktree', name: 'new-folder' },
    });
    expect(result.statusCode).toBe(403);
    expect(permission).toHaveBeenCalledWith('editor', 'p', 'code');
  } finally {
    permission.mockRestore();
    await h.close();
  }
});

it('reports an ordinary missing checkout as unavailable and keeps a present one browsable', async () => {
  const h = await harness({ repository: true });
  try {
    await h.ctx.db
      .updateTable('sessions')
      .set({ worktree: h.target })
      .where('session_id', '=', 's')
      .execute();
    const missing = await h.app.inject({ method: 'GET', url: '/sessions/s/files' });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({
      workspaceKind: 'code',
      codeAvailable: false,
      codeWorkspaceUnavailable: true,
    });
    const turn = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/turns',
      payload: { prompt: 'Continue' },
    });
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toMatchObject({ code: 'code_workspace_unavailable' });
    expect(h.cwd).not.toHaveBeenCalled();
    await mkdir(h.target, { recursive: true });
    await writeFile(join(h.target, 'draft.ts'), 'saved');
    const present = await h.app.inject({ method: 'GET', url: '/sessions/s/files' });
    expect(present.statusCode).toBe(200);
    expect(present.json()).toMatchObject({ workspaceKind: 'code', codeAvailable: true });
    expect(present.json().codeWorkspaceUnavailable).not.toBe(true);
    expect(present.json().entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'draft.ts' })]),
    );
  } finally {
    await h.close();
  }
});

it('records a successful Restore on the session event stream', async () => {
  const h = await harness({ repository: true });
  try {
    const response = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/code-workspace/restore',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ restored: true, worktree: h.target });
    expect(await h.ctx.store.getEvents('s')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ t: 'notice', text: 'Code workspace restored.' }),
      ]),
    );
  } finally {
    await h.close();
  }
});

it('uses project-authenticated Git for remote recovery rather than the host credential scope', async () => {
  const remote = vi.fn(async (args: readonly string[]) => {
    if (args.includes('remote')) return 'origin\n';
    if (args.includes('ls-remote'))
      return `${git(['-C', args[1]!, 'rev-parse', 'HEAD']).trim()}\trefs/heads/code-s\n`;
    if (args.includes('fetch')) {
      git(['-C', args[1]!, 'update-ref', 'refs/remotes/origin/code-s', 'HEAD']);
      return '';
    }
    throw new Error('unexpected remote operation');
  });
  const sandboxGit = vi.fn(() => remote);
  const h = await harness({ repository: true, sandboxGit });
  try {
    const response = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/code-workspace/restore',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ source: 'origin' });
    expect(remote).toHaveBeenCalledWith(
      expect.arrayContaining([
        'fetch',
        '--no-tags',
        'origin',
        'refs/heads/code-s:refs/remotes/origin/code-s',
      ]),
    );
    expect(sandboxGit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p' }),
      expect.any(String),
    );
    expect(remote).toHaveBeenCalledWith(
      expect.arrayContaining(['ls-remote', '--heads', 'origin', 'refs/heads/code-s']),
    );
  } finally {
    await h.close();
  }
});

it('keeps a partial journal restore unavailable until recovery finishes', async () => {
  const h = await harness({ repository: true });
  try {
    expect(
      (await h.app.inject({ method: 'POST', url: '/sessions/s/code-workspace/restore' }))
        .statusCode,
    ).toBe(200);
    const journalDir = join(h.clone, '.git', 'verity-storage');
    await mkdir(journalDir, { recursive: true });
    const journal = join(
      journalDir,
      `retired-${createHash('sha256').update(h.target).digest('hex')}.json`,
    );
    const entry = {
      version: 1,
      sessionId: 's',
      path: h.target,
      sha: '0'.repeat(40),
      branch: 'code-s',
      sidecar: null,
    };
    await writeFile(journal, JSON.stringify(entry));
    expect(
      (await h.app.inject({ method: 'POST', url: '/sessions/s/code-workspace/restore' }))
        .statusCode,
    ).toBe(409);
    // A directory left by failed recovery must not hide Restore on the next poll.
    for (const root of ['worktree', 'documents']) {
      const listing = await h.app.inject({ method: 'GET', url: `/sessions/s/files?root=${root}` });
      expect(listing.json()).toMatchObject({
        codeAvailable: false,
        codeWorkspaceUnavailable: true,
      });
    }
    entry.sha = git(['-C', h.target, 'rev-parse', 'HEAD']).trim();
    await writeFile(journal, JSON.stringify(entry));
    expect(
      (await h.app.inject({ method: 'POST', url: '/sessions/s/code-workspace/restore' }))
        .statusCode,
    ).toBe(200);
    const listing = await h.app.inject({ method: 'GET', url: '/sessions/s/files' });
    expect(listing.json()).toMatchObject({ codeAvailable: true });
    expect(listing.json()).not.toHaveProperty('codeWorkspaceUnavailable');
  } finally {
    await h.close();
  }
});

it('offers Restore for a local code project with a missing legacy checkout', async () => {
  const h = await harness({ repository: true, kind: 'local' });
  try {
    const listing = await h.app.inject({ method: 'GET', url: '/sessions/s/files' });
    expect(listing.json()).toMatchObject({
      workspaceKind: 'code',
      codeAvailable: false,
      codeWorkspaceUnavailable: true,
    });
    const restore = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/code-workspace/restore',
    });
    expect(restore.statusCode).toBe(200);
    const restored = await h.app.inject({ method: 'GET', url: '/sessions/s/files' });
    expect(restored.json()).toMatchObject({ workspaceKind: 'code', codeAvailable: true });
  } finally {
    await h.close();
  }
});

it('keeps a local Documents-only project in Documents without offering Restore', async () => {
  const h = await harness({ repository: false, kind: 'local', configured: false });
  try {
    const listing = await h.app.inject({ method: 'GET', url: '/sessions/s/files' });
    expect(listing.json()).toMatchObject({ workspaceKind: 'documents', codeAvailable: false });
    expect(listing.json()).not.toHaveProperty('codeWorkspaceUnavailable');
  } finally {
    await h.close();
  }
});

it.each(['restore', 'turn'])(
  'recovers a surviving local branch through real preparation on %s',
  async (action) => {
    const h = await harness({ repository: true, kind: 'local', prepareLocal: true });
    try {
      git(['-C', h.clone, 'branch', 'code-s']);
      const response = await h.app.inject(
        action === 'restore'
          ? { method: 'POST', url: '/sessions/s/code-workspace/restore' }
          : { method: 'POST', url: '/sessions/s/turns', payload: { prompt: 'Continue' } },
      );
      expect(response.statusCode).toBe(action === 'restore' ? 200 : 202);
      if (action === 'turn') await vi.waitFor(() => expect(h.cwd).toHaveBeenCalledWith(h.target));
      expect(git(['-C', h.target, 'branch', '--show-current']).trim()).toBe('code-s');
      expect((await h.ctx.store.getSession('s'))?.worktree).toBe(h.target);
    } finally {
      await h.close();
    }
  },
);

it.each(['branch', 'journal'])(
  'recovers local code saved only in a %s with an infrastructure-only clone',
  async (source) => {
    const h = await harness({ repository: true, kind: 'local' });
    try {
      git(['-C', h.clone, 'branch', 'code-s']);
      const sha = git(['-C', h.clone, 'rev-parse', 'code-s']).trim();
      git(['-C', h.clone, 'rm', '.gitignore']);
      await writeFile(join(h.clone, 'AGENTS.md'), 'Instructions');
      git(['-C', h.clone, 'add', 'AGENTS.md']);
      git(['-C', h.clone, 'commit', '-qm', 'infrastructure only']);
      if (source === 'journal') {
        git(['-C', h.clone, 'branch', '-m', 'code-s', 'saved']);
        await mkdir(join(h.clone, '.verity-sessions'), { recursive: true });
        const directory = join(h.clone, '.git', 'verity-storage');
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `retired-${createHash('sha256').update(h.target).digest('hex')}.json`),
          JSON.stringify({
            version: 1,
            sessionId: 's',
            path: h.target,
            sha,
            branch: null,
            sidecar: null,
          }),
        );
      }
      for (const root of ['worktree', 'documents']) {
        const listing = await h.app.inject({
          method: 'GET',
          url: `/sessions/s/files?root=${root}`,
        });
        expect(listing.json()).toMatchObject({
          workspaceKind: 'code',
          codeAvailable: false,
          codeWorkspaceUnavailable: true,
        });
      }
      const repository = { id: 'default', projectId: 'p', isDefault: true };
      const repositories = createSessionRepositories({
        cloneRoot: join(h.clone, '..'),
        store: {
          getSession: () => h.ctx.store.getSession('s'),
          getProject: () => h.ctx.store.getProject('p'),
          getProjectRepository: async () => repository,
          listProjectRepositories: async () => [repository],
          listSessionRepositoryWorkspaces: async () => [],
        } as unknown as EventStore,
      });
      expect((await repositories.list('s')).repositories[0]?.workspace).toBeNull();
      await expect(repositories.open('s', 'default')).rejects.toMatchObject({
        reason: 'code workspace unavailable',
      });
      const restore = await h.app.inject({
        method: 'POST',
        url: '/sessions/s/code-workspace/restore',
      });
      expect(restore.statusCode).toBe(200);
      expect(git(['-C', h.target, 'rev-parse', 'HEAD']).trim()).toBe(sha);
      expect((await h.ctx.store.getSession('s'))?.worktree).toBe(h.target);
    } finally {
      await h.close();
    }
  },
);
