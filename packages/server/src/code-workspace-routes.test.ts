import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventBus, type Backend } from '@verity/session';
import { createIsolatedTestDb } from '@verity/store/testing';
import { expect, it, vi } from 'vitest';
import { buildControlPlane } from './app.js';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

async function harness({ repository }: { repository: boolean }) {
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
    kind: 'github',
    state: 'active',
    containerName: 'o-r',
  });
  await ctx.store.createSession({ sessionId: 's', projectId: 'p', worktree: view, model: 'm' });
  const cwd = vi.fn();
  const backend: Backend = {
    run: async (opts) => {
      cwd(opts.cwd);
      return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
    },
  };
  const app = buildControlPlane({
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    dataRoot,
    projectCloneRoot: cloneRoot,
    conductor: { backend },
    logger: false,
  });
  return {
    app,
    ctx,
    cwd,
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
    const restore = await h.app.inject({
      method: 'POST',
      url: '/sessions/s/code-workspace/restore',
    });
    expect(restore.statusCode).toBe(409);
    expect(restore.json()).toMatchObject({ code: 'code_workspace_unavailable' });
  } finally {
    await h.close();
  }
});
