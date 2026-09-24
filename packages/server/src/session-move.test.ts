import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, it, expect, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { createTestDb, type TestDb } from '@verity/store/testing';
import { Conductor, InMemoryEventBus } from '@verity/session';
import { buildServer } from './server.js';
import { projectClonePath, type Provisioner } from './provisioner.js';
import type { PreviewShareManager } from './preview-share-manager.js';
import type { ProjectRuntime } from './project-runtime.js';
import { moveGit } from './session-move-files.js';
let ctx: TestDb;
let root: string;
beforeAll(async () => {
  ctx = await createTestDb();
  root = await mkdtemp(join(tmpdir(), 'verity-project-move-'));
});
afterAll(async () => {
  await ctx.close();
  await rm(root, { recursive: true, force: true });
});
it('moves real Git work and history, retries once, and cold-starts a Claude-origin session', async () => {
  const projects: ProjectRecord[] = [];
  for (const id of ['move-source', 'move-target']) {
    const project = await ctx.store.upsertProject({
      id,
      owner: 'local',
      repo: id,
      kind: 'local',
      containerName: id,
      state: 'active',
    });
    projects.push(project);
    const clone = projectClonePath(root, project);
    await mkdir(clone, { recursive: true });
    await moveGit(clone, 'init', '-b', 'main');
    await moveGit(clone, 'config', 'user.name', 'Test');
    await moveGit(clone, 'config', 'user.email', 'test@example.test');
    await moveGit(clone, 'commit', '--allow-empty', '-m', 'initial');
  }
  const source = projectClonePath(root, projects[0]!);
  const sourceWorktree = join(source, '.verity-sessions', 'original');
  await moveGit(source, 'worktree', 'add', '-b', 'original', sourceWorktree);
  await writeFile(join(sourceWorktree, 'new.txt'), 'uncommitted');
  await ctx.store.createSession({
    sessionId: 'moved',
    projectId: projects[0]!.id,
    worktree: sourceWorktree,
    model: 'claude-opus-4-8',
  });
  let prompt: string | undefined = '';
  let cwd: string | undefined = '';
  let resume: string | undefined = 'unset';
  const conductor = new Conductor({
    store: ctx.store,
    worktreeExists: async () => true,
    backend: {
      run: async (opts) => {
        prompt = opts.prompt;
        cwd = opts.cwd;
        resume = opts.resumeSessionId;
        return { sessionId: 'new-thread', exitCode: 0, stderr: '', aborted: false };
      },
    },
  });
  const preview = await ctx.store.createDevServer({
    projectId: projects[0]!.id,
    command: 'npm start',
  });
  await ctx.store.updateDevServer(preview.id, { previewSessionId: 'moved' });
  const runtimeResult = { projectId: projects[0]!.id, running: true, url: null, pid: '1' };
  const start = vi
    .fn()
    .mockRejectedValueOnce(new Error('restart interrupted'))
    .mockResolvedValue(runtimeResult);
  const stop = vi.fn().mockResolvedValue({ ...runtimeResult, running: false });
  const app = buildServer({
    eventStore: ctx.store,
    conductor,
    bus: new InMemoryEventBus(),
    projectCloneRoot: root,
    projectRuntime: {
      startDevServer: start,
      stopDevServer: stop,
      devServerStatus: async () => runtimeResult,
    } as unknown as ProjectRuntime,
    previewShareManager: {
      beginSessionMove: async () => () => undefined,
      isAvailable: () => false,
    } as unknown as PreviewShareManager,
    provisioner: {
      syncProjectCheckout: async () => undefined,
      withProjectExclusiveMutation: async <T>(_id: string, fn: () => Promise<T>) => await fn(),
    } as unknown as Provisioner,
  });
  await app.ready();
  await ctx.store.appendEvent('moved', {
    t: 'session',
    id: 'moved',
    model: 'claude-opus-4-8',
    worktree: sourceWorktree,
  });
  await ctx.store.appendEvent('moved', { t: 'prompt', text: 'Remember the blue lighthouse.' });
  try {
    const admission = await conductor.tryMoveSession('moved', async () => {
      await expect(conductor.dispatchTurn('moved', 'must not queue')).rejects.toThrow();
    });
    expect(admission.ran).toBe(true);
    expect(await ctx.store.listQueuedTurns()).toEqual([]);
    const payload = { project: projects[1]!.id, operationId: randomUUID() };
    const response = await app.inject({ method: 'POST', url: '/sessions/moved/project', payload });
    expect(response.statusCode, response.body).toBe(500);
    expect(await ctx.store.listMovePreviewRestarts()).toHaveLength(1);
    expect((await ctx.store.getDevServer(preview.id))?.previewSessionId).toBeNull();
    const recovered = await app.inject({ method: 'POST', url: '/sessions/moved/project', payload });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(await ctx.store.listMovePreviewRestarts()).toHaveLength(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ devServerCheckoutRoot: null }),
    );
    const moved = recovered.json<{ worktree: string; retainedWorktree: string }>();
    expect(await readFile(join(moved.worktree, 'new.txt'), 'utf8')).toBe('uncommitted');
    expect(await readFile(join(moved.retainedWorktree, 'new.txt'), 'utf8')).toBe('uncommitted');
    const retry = await app.inject({ method: 'POST', url: '/sessions/moved/project', payload });
    expect(retry.json()).toEqual(recovered.json());
    await conductor.sendTurn('moved', 'Continue.');
    expect(resume).toBeUndefined();
    expect(cwd).toBe(moved.worktree);
    expect(prompt).toContain('blue lighthouse');
    expect(prompt).toContain('This session moved to project');
    expect(prompt).not.toContain('sole agent on this session, branch, and worktree');
    const blocked = await conductor.tryRunExclusive('moved', () =>
      app.inject({
        method: 'POST',
        url: '/sessions/moved/project',
        payload: { project: projects[0]!.id, operationId: randomUUID() },
      }),
    );
    expect(blocked.ran && blocked.value.statusCode).toBe(409);
    await moveGit(moved.worktree, 'add', 'new.txt');
    await moveGit(moved.worktree, 'commit', '-m', 'session work');
    const commitGate = await app.inject({
      method: 'POST',
      url: '/sessions/moved/project',
      payload: { project: projects[0]!.id, operationId: randomUUID() },
    });
    expect(commitGate.statusCode).toBe(409);
    expect(commitGate.json()).toMatchObject({ code: 'source_commits' });
  } finally {
    await app.close();
  }
});

it('starts the server when a pending preview restart still fails', async () => {
  for (const id of ['recovery-source', 'recovery-target']) {
    await ctx.store.upsertProject({
      id,
      owner: 'local',
      repo: id,
      kind: 'local',
      containerName: id,
      state: 'active',
    });
  }
  await ctx.store.createSession({
    sessionId: 'recovery',
    projectId: 'recovery-source',
    worktree: '/recovery/source',
    model: 'claude-opus-4-8',
  });
  const preview = await ctx.store.createDevServer({
    projectId: 'recovery-source',
    command: 'npm start',
  });
  await ctx.store.prepareSessionMove({
    sessionId: 'recovery',
    operationId: 'recover',
    sourceProjectId: 'recovery-source',
    sourceWorktree: '/recovery/source',
    targetProjectId: 'recovery-target',
    targetWorktree: '/recovery/target',
    branch: 'recovery',
    onCommits: 'block',
  });
  await ctx.store.commitSessionMove('recovery', 'recover', 'Moved', '{}');
  await ctx.store.setMovePreviewRestart('recovery', 'recover', [preview.id]);
  const app = buildServer({
    eventStore: ctx.store,
    bus: new InMemoryEventBus(),
    conductor: new Conductor({ store: ctx.store }),
    projectRuntime: {
      startDevServer: async () => {
        throw new Error('runtime unavailable');
      },
    } as unknown as ProjectRuntime,
  });
  try {
    await app.ready();
    expect(
      (await ctx.store.getSessionMove('recovery', 'recover'))?.preview_restart_json,
    ).not.toBeNull();
  } finally {
    await app.close();
  }
});
