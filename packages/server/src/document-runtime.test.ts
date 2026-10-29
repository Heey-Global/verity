import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventBus, type Backend } from '@verity/session';
import { createIsolatedTestDb } from '@verity/store/testing';
import { expect, it, vi } from 'vitest';
import { buildControlPlane } from './app.js';
import { documentWorkspace } from './document-workspace.js';

it('publishes turn edits through the runtime and exposes retained working copies read-only', async () => {
  const ctx = await createIsolatedTestDb();
  const dataRoot = await mkdtemp(join(tmpdir(), 'document-runtime-'));
  const cloneRoot = join(dataRoot, 'workspaces');
  const clone = join(cloneRoot, 'local-project');
  const view = join(clone, '.verity-document-sessions', 'session');
  const backend: Backend = {
    run: async (opts) => {
      await opts.onSession?.('backend-docs');
      await writeFile(join(opts.cwd, 'result.md'), 'Published result');
      return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
    },
  };
  await ctx.store.upsertProject({
    id: 'p',
    owner: '__local__',
    repo: 'project',
    kind: 'local',
    state: 'active',
    cloneDir: 'local-project',
    containerName: 'local-project',
  });
  await mkdir(view, { recursive: true });
  await documentWorkspace(dataRoot, 'p', view).prepare();
  await ctx.store.createSession({ sessionId: 'docs', projectId: 'p', worktree: view, model: 'm' });
  const settled = vi.fn();
  const app = buildControlPlane({
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    dataRoot,
    projectCloneRoot: cloneRoot,
    conductor: {
      backend,
      settleWorkspace: async () => {
        settled();
      },
    },
    logger: false,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/docs/turns',
      payload: { prompt: 'Write result' },
    });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(await readFile(join(dataRoot, 'knowledge', 'p', 'insights', 'result.md'), 'utf8')).toBe(
      'Published result',
    );
    const listing = await app.inject({ method: 'GET', url: '/sessions/docs/files?root=documents' });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({
      workspaceKind: 'documents',
      documentStatus: { pending: false },
    });
    await writeFile(join(view, 'late.md'), 'Unpublished late edit');
    const pending = await app.inject({ method: 'GET', url: '/sessions/docs/files?root=documents' });
    expect(pending.json()).toMatchObject({ documentStatus: { pending: true } });
    const drafts = await app.inject({ method: 'GET', url: '/sessions/docs/files?root=drafts' });
    expect(drafts.statusCode).toBe(200);
    const refused = await app.inject({
      method: 'DELETE',
      url: '/sessions/docs/files?root=drafts&path=session/result.md',
    });
    expect(refused.statusCode).toBe(403);
    expect(await readFile(join(view, 'result.md'), 'utf8')).toBe('Published result');
    await ctx.store.createSession({
      sessionId: 'remaining',
      projectId: 'p',
      worktree: join(clone, '.verity-document-sessions', 'remaining'),
      model: 'm',
    });
    await vi.waitFor(async () => {
      const deleted = await app.inject({ method: 'DELETE', url: '/sessions/docs' });
      expect(deleted.statusCode).toBe(200);
    });
    expect(await ctx.store.getSession('docs')).toBeUndefined();
    const retained = await app.inject({
      method: 'GET',
      url: '/sessions/remaining/files/content?root=drafts&path=session/result.md',
    });
    expect(retained.statusCode).toBe(200);
    expect(retained.json()).toMatchObject({ content: 'Published result', editable: false });
  } finally {
    await app.close();
    await ctx.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

it('migrates real session rows idempotently and preserves earlier pending notes', async () => {
  const ctx = await createIsolatedTestDb();
  const dataRoot = await mkdtemp(join(tmpdir(), 'document-migration-store-'));
  const workspace = join(dataRoot, 'legacy');
  const { migrateLocalDocuments } = await import('./document-migration.js');
  try {
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeFile(join(workspace, 'legacy.md'), 'Legacy document');
    await ctx.store.upsertProject({
      id: 'p',
      owner: '__local__',
      repo: 'project',
      kind: 'local',
      state: 'active',
      containerName: 'local-project',
    });
    await ctx.store.createSession({
      sessionId: 'legacy',
      projectId: 'p',
      worktree: workspace,
      model: 'm',
    });
    await ctx.store.appendPendingNote('legacy', 'Earlier note');
    const input = { dataRoot, projectId: 'p', workspace, store: ctx.store };
    await migrateLocalDocuments(input);
    const migrated = await ctx.store.getSession('legacy');
    expect(migrated?.worktree).toContain('.verity-document-sessions/migrated-legacy');
    await migrateLocalDocuments(input);
    expect((await ctx.store.getSession('legacy'))?.worktree).toBe(migrated?.worktree);
    expect(await ctx.store.consumePendingNotes('legacy')).toHaveLength(2);
  } finally {
    await ctx.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

it('gives a Code session a separate automatically published Documents working copy', async () => {
  const ctx = await createIsolatedTestDb();
  const dataRoot = await mkdtemp(join(tmpdir(), 'code-document-runtime-'));
  const worktree = join(dataRoot, 'workspaces', 'repo', '.verity-sessions', 'code');
  const view = join(dataRoot, 'workspaces', 'repo', '.verity-document-sessions', 'code-code');
  await mkdir(worktree, { recursive: true });
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'acme',
    repo: 'repo',
    kind: 'github',
    state: 'active',
    containerName: 'code-project',
  });
  await ctx.store.createSession({ sessionId: 'code', projectId: 'p', worktree, model: 'm' });
  const settled = vi.fn();
  const backend: Backend = {
    run: async (opts) => {
      expect(opts.cwd).toBe(worktree);
      expect(opts.appendSystemPrompt).toContain('../../.verity-document-sessions/code-code');
      await writeFile(join(view, 'report.md'), 'Code report');
      return { sessionId: opts.storeSessionId, exitCode: 0, stderr: '', aborted: false };
    },
  };
  const app = buildControlPlane({
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    dataRoot,
    conductor: {
      backend,
      settleWorkspace: async () => {
        settled();
      },
    },
    logger: false,
  });
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sessions/code/turns',
          payload: { prompt: 'Write report' },
        })
      ).statusCode,
    ).toBe(202);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(await readFile(join(dataRoot, 'knowledge', 'p', 'insights', 'report.md'), 'utf8')).toBe(
      'Code report',
    );
    await expect(readFile(join(worktree, 'report.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await app.close();
    await ctx.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
