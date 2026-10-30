import type { Backend } from '@verity/session';
import {
  BackendTerminationUnconfirmedError,
  InMemoryEventBus,
  QueueFullError,
  SessionBusyError,
  UnknownSessionError,
  WorktreeMissingError,
} from '@verity/session';
import { createSealableSecretCipher, type ProjectRecord } from '@verity/store';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAuthTokenRegistry } from './auth.js';
import {
  createCachedProjectTokenMint,
  createGitHubAppProjectTokenMint,
} from './github-app-token.js';
import { LocalPreviewManager } from './local-preview-manager.js';
import {
  app,
  bus,
  cancelTurn,
  clearQueue,
  closeSession,
  conductor,
  ctx,
  decidePermission,
  dequeue,
  dispatchTurn,
  isBusy,
  port,
  recover,
  releaseUnconfirmedTermination,
  repeatedVerityInstructions,
  runBackendHandoff,
  startSession,
  stopSession,
  worktreeRoot,
} from './server-fixture.test-helper.js';
import {
  buildServer,
  isAttachmentBase64SizeAllowed,
  isAttachmentBase64TotalSizeAllowed,
  type MeetingTranscriptResult,
} from './server.js';
import { RepositoryHasNoCommitsError } from './worktree.js';

describe('PATCH /sessions/:id (rename + switch engine)', () => {
  it('renames a session and echoes the new name', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: '  Fix login bug  ' },
    });
    expect(res.statusCode).toBe(200);
    // The name is trimmed before it is stored / echoed.
    expect(res.json()).toEqual({ sessionId: 's1', name: 'Fix login bug' });
    expect((await ctx.store.getSession('s1'))?.name).toBe('Fix login bug');
  });

  it('clears a name when passed null', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm', name: 'old' });
    const res = await app.inject({ method: 'PATCH', url: '/sessions/s1', payload: { name: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 's1', name: null });
    expect((await ctx.store.getSession('s1'))?.name).toBeNull();
  });

  it('returns 404 for an unknown session', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/missing',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('missing') });
  });

  it('marks and unmarks a favorite, and lists it in GET /sessions', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const marked = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { favorite: true },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toEqual({ sessionId: 's1', favorite: true });
    const listed = await app.inject({ method: 'GET', url: '/sessions' });
    expect(
      listed.json<{ sessionId: string; favorite?: boolean }[]>().find((s) => s.sessionId === 's1')
        ?.favorite,
    ).toBe(true);

    const unmarked = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { favorite: false },
    });
    expect(unmarked.json()).toEqual({ sessionId: 's1', favorite: false });
    expect((await ctx.store.getSession('s1'))?.favorite).toBeUndefined();
  });

  it('applies a favorite together with a rename', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: 'Pinned', favorite: true },
    });
    expect(res.json()).toEqual({ sessionId: 's1', name: 'Pinned', favorite: true });
    expect(await ctx.store.getSession('s1')).toMatchObject({ name: 'Pinned', favorite: true });
  });

  it('returns 404 when marking an unknown session as favorite', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/missing',
      payload: { favorite: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a non-boolean favorite with 400', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { favorite: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a whitespace-only name with 400', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid request' });
  });

  it('rejects a name over 80 characters with 400', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: 'x'.repeat(81) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid session id with 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/bad%20id',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('switches the engine/model and echoes it', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'claude-thread-1',
      contextSeq: 12,
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'codex/default' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 's1', model: 'codex/default', deferred: false });
    expect(closeSession).toHaveBeenCalledWith('s1');
    expect(closeSession).toHaveBeenCalledWith('claude-thread-1');
    expect(await ctx.store.getSessionBackendStates('s1')).toEqual([]);
    // Persisted, so the next dispatched turn routes to the new backend (buildRunOpts
    // reads session.model when the turn carries no per-turn override).
    expect((await ctx.store.getSession('s1'))?.model).toBe('codex/default');
  });

  it('rolls the model back when clearing the previous backend state fails', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'claude-thread-1',
      contextSeq: 12,
    });
    vi.spyOn(ctx.store, 'deleteSessionBackendStates').mockRejectedValueOnce(
      new Error('injected backend-state delete failure'),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'codex/default' },
    });

    expect(res.statusCode).toBe(500);
    expect((await ctx.store.getSession('s1'))?.model).toBe('claude-opus-4-8');
    expect(await ctx.store.getSessionBackendStates('s1')).toHaveLength(1);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('waits for the atomic handoff before closing an in-flight backend', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'claude-thread-1',
      contextSeq: 12,
    });
    isBusy.mockReturnValue(true);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'codex/default' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 's1', model: 'codex/default', deferred: false });
    expect((await ctx.store.getSession('s1'))?.model).toBe('codex/default');
    expect(await ctx.store.getSessionBackendStates('s1')).toEqual([]);
    expect(runBackendHandoff).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(closeSession).toHaveBeenCalledWith('s1');
    expect(closeSession).toHaveBeenCalledWith('claude-thread-1');
  });

  it('leaves the session on its old backend with 503 when termination is unconfirmed', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'claude',
      backendSessionId: 'claude-thread-1',
      contextSeq: 12,
    });
    runBackendHandoff.mockRejectedValueOnce(new BackendTerminationUnconfirmedError('s1'));

    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'codex/default' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('unterminated backend') });
    // Nothing is half-applied: model and resume handles are untouched, so a retry
    // starts from the same well-defined state instead of a headless Codex session.
    // This is also what proves every mutating step sits INSIDE the barrier callback —
    // a refused barrier never runs it, so anything left outside would show up here.
    expect((await ctx.store.getSession('s1'))?.model).toBe('claude-opus-4-8');
    expect(await ctx.store.getSessionBackendStates('s1')).toHaveLength(1);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('keeps the rename of a refused combined patch, and says so in the 503', async () => {
    // The one place a partial application is deliberate: the rename is independent
    // registry metadata applied before the barrier, so a refused model switch must not
    // silently roll it back — the retry would then have to guess which half took. The
    // body has to name it, or "retry the model switch" reads as "nothing happened".
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
      name: 'before',
    });
    runBackendHandoff.mockRejectedValueOnce(new BackendTerminationUnconfirmedError('s1'));

    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: 'after', favorite: true, model: 'codex/default' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('the rename in this request was applied'),
    });
    const session = await ctx.store.getSession('s1');
    expect(session?.name).toBe('after');
    expect(session?.favorite).toBe(true);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('the favorite change in this request was applied'),
    });
    expect(session?.model).toBe('claude-opus-4-8');
    expect(res.headers['retry-after']).toBe('5');
  });

  it('answers contention with 409, on the same partial-rename contract as the 503', async () => {
    // A fence held by a maintenance action (bind, purge, local merge) has no worker
    // behind it, so it is ordinary contention rather than an unterminated backend. It
    // must not escape as a sanitized 500: the caller needs to know it lost a race, that
    // nothing was switched, and — exactly as on 503 — that the rename did take.
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
      name: 'before',
    });
    runBackendHandoff.mockRejectedValueOnce(new SessionBusyError('s1'));

    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: 'after', favorite: true, model: 'codex/default' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('the rename in this request was applied'),
    });
    expect(res.headers['retry-after']).toBe('5');
    const session = await ctx.store.getSession('s1');
    expect(session?.name).toBe('after');
    expect(session?.favorite).toBe(true);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('the favorite change in this request was applied'),
    });
    expect(session?.model).toBe('claude-opus-4-8');
  });

  it('404s an unknown session without taking the barrier', async () => {
    // Taking the barrier is not free — it fences submissions and cancels the in-flight
    // turn of whatever id it is handed. A typo'd session id must not spend a cancel
    // before arriving at the 404 it was always going to get.
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/missing',
      payload: { model: 'codex/default' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session missing not found' });
    expect(runBackendHandoff).not.toHaveBeenCalled();
  });

  it('does not take the barrier when the patch names the model already in use', async () => {
    // The barrier kills the running turn. A client that re-sends the current model on
    // an unrelated settings save must not destroy work by doing so — and before the
    // handoff existed this was harmless, so it has to stay harmless.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    isBusy.mockReturnValue(true);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'codex/default' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 's1', model: 'codex/default', deferred: false });
    expect(runBackendHandoff).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect((await ctx.store.getSession('s1'))?.model).toBe('codex/default');
  });

  it('keeps the resume handle when the patch names the model already in use', async () => {
    // The route used to write the model and drop every backend state unconditionally,
    // so a redundant same-model PATCH silently cost the session its resume handle and
    // the next turn started a fresh context. Skipping the handoff has to keep it.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'codex-resume-1',
      contextSeq: 7,
    });
    isBusy.mockReturnValue(true);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'codex/default' },
    });
    expect(res.statusCode).toBe(200);
    expect(await ctx.store.getSessionBackendStates('s1')).toMatchObject([
      { backendSessionId: 'codex-resume-1' },
    ]);
  });

  it('renames without a handoff when the model in the same patch is unchanged', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'codex/default',
      name: 'before',
    });
    isBusy.mockReturnValue(true);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: 'after', model: 'codex/default' },
    });
    expect(res.statusCode).toBe(200);
    expect(runBackendHandoff).not.toHaveBeenCalled();
    expect((await ctx.store.getSession('s1'))?.name).toBe('after');
  });

  it('routes a switch away from Codex through the ownership barrier (handover race)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    isBusy.mockReturnValue(true);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'claude-opus-4-8' },
    });
    expect(res.statusCode).toBe(200);
    // The live codex turn must be gone before the new engine starts, or its (container)
    // process keeps editing the worktree next to it — the duplicate-process race. The
    // route buys that by going through the barrier, which cancels and waits for the
    // fence (conductor.test.ts covers what the barrier itself does).
    expect(runBackendHandoff).toHaveBeenCalledWith('s1', expect.any(Function));
  });

  it('routes a switch into Codex through the ownership barrier too', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
    });
    isBusy.mockReturnValue(true);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'codex/default' },
    });
    expect(res.statusCode).toBe(200);
    expect(runBackendHandoff).toHaveBeenCalledWith('s1', expect.any(Function));
  });

  it('takes the barrier even for an idle session, so a race cannot slip in', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'codex/default' });
    isBusy.mockReturnValue(false);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { model: 'claude-opus-4-8' },
    });
    expect(res.statusCode).toBe(200);
    // "Idle" read outside the fence is only a guess: a turn can be dispatched between
    // the check and the swap. The barrier is unconditional for exactly that reason.
    expect(runBackendHandoff).toHaveBeenCalledWith('s1', expect.any(Function));
  });

  it('still allows a pure rename while a turn is in flight', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(true);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: 'Rename mid-turn' },
    });
    expect(res.statusCode).toBe(200);
    expect((await ctx.store.getSession('s1'))?.name).toBe('Rename mid-turn');
  });

  it('applies a combined rename+model patch after the live backend handoff', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'claude-opus-4-8',
      name: 'before',
    });
    isBusy.mockReturnValue(true);
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s1',
      payload: { name: 'after', model: 'codex/default' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: 's1',
      name: 'after',
      model: 'codex/default',
      deferred: false,
    });
    const session = await ctx.store.getSession('s1');
    expect(session?.model).toBe('codex/default');
    expect(session?.name).toBe('after');
  });

  it('returns 404 when switching the model of an unknown session', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/missing',
      payload: { model: 'codex/default' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('missing') });
  });

  it('rejects a non-Claude/Codex model on a project session with 400 (model unchanged)', async () => {
    await ctx.store.upsertProject({
      id: 'p-switch',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-proj',
      worktree: '/wt/s-proj',
      model: 'claude-opus-4-8',
      projectId: 'p-switch',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s-proj',
      payload: { model: 'deepinfra/zai-org/GLM-5' },
    });
    expect(res.statusCode).toBe(400);
    // The spawn model is left untouched on rejection.
    expect((await ctx.store.getSession('s-proj'))?.model).toBe('claude-opus-4-8');
  });

  it('allows switching a project session between Claude and Codex', async () => {
    await ctx.store.upsertProject({
      id: 'p-switch2',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-proj2',
      worktree: '/wt/s-proj2',
      model: 'claude-opus-4-8',
      projectId: 'p-switch2',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/sessions/s-proj2',
      payload: { model: 'codex/default' },
    });
    expect(res.statusCode).toBe(200);
    expect((await ctx.store.getSession('s-proj2'))?.model).toBe('codex/default');
  });
});

describe('DELETE /sessions/:id', () => {
  it('deletes a session and its log, echoing the id', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });

    const res = await app.inject({ method: 'DELETE', url: '/sessions/s1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 's1' });
    // Gone from the store, so gone from the list the overview renders.
    expect(await ctx.store.getSession('s1')).toBeUndefined();
    const list = await app.inject({ method: 'GET', url: '/sessions' });
    expect(list.json()).toEqual([]);
  });

  it('queues overlapping deletions in the same project behind the preview fence', async () => {
    await ctx.store.createProject({
      id: 'delete-project',
      kind: 'local',
      owner: '__local__',
      repo: 'delete',
      cloneDir: 'delete',
      containerName: 'delete',
      state: 'active',
    });
    for (const sessionId of ['delete-a', 'delete-b']) {
      await ctx.store.createSession({
        sessionId,
        worktree: `/wt/${sessionId}`,
        model: 'm',
        projectId: 'delete-project',
      });
    }
    const localPreviewManager = new LocalPreviewManager({ store: ctx.store } as never);
    let releasePurge!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePurge = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const purge = vi.fn(async (id: string) => {
      if (id === 'delete-a') {
        markStarted();
        await blocked;
      }
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      localPreviewManager,
      purgeSessionArtifacts: purge,
    });
    try {
      const first = a.inject({ method: 'DELETE', url: '/sessions/delete-a' }).then((res) => res);
      await started;
      const second = a.inject({ method: 'DELETE', url: '/sessions/delete-b' }).then((res) => res);
      // The first request retains the real project fence while the second arrives.
      await new Promise((resolve) => setTimeout(resolve, 50));
      releasePurge();
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      expect(await ctx.store.getSession('delete-a')).toBeUndefined();
      expect(await ctx.store.getSession('delete-b')).toBeUndefined();
    } finally {
      releasePurge();
      await a.close();
      await localPreviewManager.close();
    }
  });

  it('returns 404 for an unknown session', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/sessions/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('missing') });
  });

  it('refuses to delete a busy session with 409 (leaves it intact, never reaps)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(true);
    const res = await app.inject({ method: 'DELETE', url: '/sessions/s1' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('busy') });
    expect(await ctx.store.getSession('s1')).toBeDefined();
    // A refused delete must not touch the running turn.
    expect(cancelTurn).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('force-deletes a busy session: reaps the in-flight turn BEFORE tearing it down', async () => {
    const removed: string[] = [];
    const provisioner = {
      add: vi.fn(async (branch: string) => `/wt/${branch.replace(/\//g, '-')}`),
      remove: vi.fn(async (worktreePath: string) => {
        removed.push(worktreePath);
      }),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: provisioner });
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/agent-s1', model: 'm' });
    isBusy.mockReturnValue(true);
    runBackendHandoff.mockImplementationOnce(async (sessionId, fn) => {
      cancelTurn(sessionId);
      return fn();
    });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s1?force=true' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sessionId: 's1' });
      expect(runBackendHandoff).toHaveBeenCalledWith('s1', expect.any(Function));
      // The agent is reaped, not merely detached — and reaping happens BEFORE the
      // worktree is removed, so the process is never orphaned against a deleted cwd.
      expect(cancelTurn).toHaveBeenCalledWith('s1');
      expect(closeSession).toHaveBeenCalledWith('s1');
      expect(cancelTurn.mock.invocationCallOrder[0]).toBeLessThan(
        closeSession.mock.invocationCallOrder[0]!,
      );
      expect(cancelTurn.mock.invocationCallOrder[0]).toBeLessThan(
        provisioner.remove.mock.invocationCallOrder[0]!,
      );
      expect(removed).toEqual(['/wt/agent-s1']);
      expect(await ctx.store.getSession('s1')).toBeUndefined();
    } finally {
      await a.close();
    }
  });

  it('force-deleting an IDLE session does not signal any turn', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(false);
    const res = await app.inject({ method: 'DELETE', url: '/sessions/s1?force=true' });
    expect(res.statusCode).toBe(200);
    expect(cancelTurn).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith('s1');
  });

  it('refuses force-delete while a meeting job owns the session worktree', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-delete-test-'));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const meetingApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      meetingTranscriber: {
        transcribe: (input) =>
          new Promise<MeetingTranscriptResult>((_resolve, reject) => {
            markStarted();
            input.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      },
    });
    try {
      await ctx.store.createSession({ sessionId: 'meeting-delete', worktree, model: 'm' });
      const upload = await meetingApp.inject({
        method: 'POST',
        url: '/sessions/meeting-delete/meetings/transcripts/stream',
        headers: {
          'content-type': 'application/octet-stream',
          'x-verity-meeting-file-name': 'planning.m4a',
          'x-verity-meeting-media-type': 'audio%2Fmp4',
        },
        payload: Buffer.from('long audio'),
      });
      expect(upload.statusCode).toBe(202);
      await started;

      const removed = await meetingApp.inject({
        method: 'DELETE',
        url: '/sessions/meeting-delete?force=true',
      });
      expect(removed.statusCode).toBe(409);
      expect(removed.json()).toMatchObject({ error: expect.stringContaining('meeting job') });
      expect(await ctx.store.getSession('meeting-delete')).toBeDefined();
      expect(cancelTurn).not.toHaveBeenCalled();
      expect(closeSession).not.toHaveBeenCalled();

      await meetingApp.inject({ method: 'POST', url: '/sessions/meeting-delete/cancel' });
      await vi.waitFor(async () => {
        expect((await meetingApp.inject('/sessions/meeting-delete/activity')).json().busy).toBe(
          false,
        );
      });
    } finally {
      await meetingApp.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('keeps a busy session and its worktree when reaping fails', async () => {
    const provisioner = {
      add: vi.fn(async (branch: string) => `/wt/${branch.replace(/\//g, '-')}`),
      remove: vi.fn(async () => undefined),
    };
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: provisioner });
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/agent-s1', model: 'm' });
    isBusy.mockReturnValue(true);
    cancelTurn.mockImplementationOnce(() => {
      throw new Error('failed to signal agent');
    });
    runBackendHandoff.mockImplementationOnce(async (sessionId, fn) => {
      cancelTurn(sessionId);
      return fn();
    });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s1?force=true' });
      expect(res.statusCode).toBe(500);
      expect(await ctx.store.getSession('s1')).toBeDefined();
      expect(closeSession).not.toHaveBeenCalled();
      expect(provisioner.remove).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('rejects an invalid session id with 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/sessions/bad%20id' });
    expect(res.statusCode).toBe(400);
  });

  it('purges the backend transcripts BEFORE the store row that names them', async () => {
    // The backend session ids live in `session_backend_state`, which the FK cascade
    // takes with the session row. Purging afterwards would have nothing left to
    // resolve the file names from, so the ordering is the whole correctness argument.
    const seenBindings: string[][] = [];
    const purge = vi.fn(async (sessionId: string) => {
      seenBindings.push(
        (await ctx.store.getSessionBackendStates(sessionId)).map((row) => row.backendSessionId),
      );
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      purgeSessionArtifacts: purge,
    });
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.upsertSessionBackendState({
      sessionId: 's1',
      backend: 'codex',
      backendSessionId: 'thread-1',
      contextSeq: 0,
    });
    isBusy.mockReturnValue(false);
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s1' });
      expect(res.statusCode).toBe(200);
      expect(purge).toHaveBeenCalledWith('s1');
      // Ran while the binding was still readable — i.e. before the cascade.
      expect(seenBindings).toEqual([['thread-1']]);
      expect(await ctx.store.getSession('s1')).toBeUndefined();
    } finally {
      await a.close();
    }
  });

  it('still deletes the session when purging its transcripts fails', async () => {
    // A file that cannot be removed is a leak to log, not a reason to strand the
    // session in the UI — the operator asked for it to be gone.
    const purge = vi.fn(async () => {
      throw new Error('EACCES');
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      purgeSessionArtifacts: purge,
    });
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(false);
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s1' });
      expect(res.statusCode).toBe(200);
      expect(purge).toHaveBeenCalledWith('s1');
      expect(await ctx.store.getSession('s1')).toBeUndefined();
    } finally {
      await a.close();
    }
  });

  it('gives up on a purge that never settles instead of holding the request open', async () => {
    // A wedged data volume makes `unlink` hang rather than fail, so the purge neither
    // resolves nor rejects. Waiting for it would hold DELETE open and stall the
    // project-delete loop behind it; the files it left are what the startup sweep
    // collects on the next boot.
    let purgeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      purgeStarted = resolve;
    });
    const purge = vi.fn(() => {
      purgeStarted();
      return new Promise<void>(() => undefined);
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      purgeSessionArtifacts: purge,
    });
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(false);
    vi.useFakeTimers();
    try {
      const pending = a.inject({ method: 'DELETE', url: '/sessions/s1' });
      await started;
      // Only the purge's own timer is pending here; advancing past it is the claim.
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(purge).toHaveBeenCalledWith('s1');
      expect(await ctx.store.getSession('s1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await a.close();
    }
  });
});

describe('DELETE /sessions/:id (worktree cleanup)', () => {
  function fake() {
    const removed: string[] = [];
    const provisioner = {
      add: vi.fn(async (branch: string) => `/wt/${branch.replace(/\//g, '-')}`),
      remove: vi.fn(async (worktreePath: string) => {
        removed.push(worktreePath);
      }),
    };
    return { removed, provisioner };
  }

  it('removes the session worktree via the provisioner', async () => {
    const f = fake();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/agent-s1', model: 'm' });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s1' });
      expect(res.statusCode).toBe(200);
      expect(f.removed).toEqual(['/wt/agent-s1']);
    } finally {
      await a.close();
    }
  });

  it('removes project-bound session worktrees via the project provisioner', async () => {
    const defaultWorktrees = fake();
    const projectWorktrees = fake();
    await ctx.store.upsertProject({
      id: 'p-delete',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-project-delete',
      worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-delete',
      model: 'm',
      projectId: 'p-delete',
    });
    const projectWorktreeFactory = vi.fn(() => projectWorktrees.provisioner);
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      worktrees: defaultWorktrees.provisioner,
      projectCloneRoot: '/data/dev',
      projectWorktrees: projectWorktreeFactory,
    });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s-project-delete' });
      expect(res.statusCode).toBe(200);
      expect(defaultWorktrees.removed).toEqual([]);
      expect(projectWorktrees.removed).toEqual([
        '/data/dev/heey-global-verity/.verity-sessions/agent-delete',
      ]);
      expect(projectWorktreeFactory).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p-delete' }),
        '/data/dev/heey-global-verity',
      );
    } finally {
      await a.close();
    }
  });

  it('does not restart a retired configured Dev Server while deleting its session', async () => {
    const projectWorktrees = fake();
    await ctx.store.upsertProject({
      id: 'p-preview-delete',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-preview-delete',
      worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-preview',
      model: 'm',
      projectId: 'p-preview-delete',
    });
    const devServer = await ctx.store.createDevServer({
      projectId: 'p-preview-delete',
      command: 'npm run dev',
      autoStart: false,
    });
    await ctx.store.updateDevServer(devServer.id, { previewSessionId: 's-preview-delete' });
    const syncProjectCheckout = vi.fn(async () => undefined);
    const startDevServer = vi.fn(async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      running: true,
      pid: '2',
    }));
    const projectRuntime = {
      startDevServer,
      devServerStatus: vi.fn(async (project, settings) => ({
        projectId: project.id,
        url: settings.devServerUrl,
        running: true,
        pid: '1',
      })),
      stopDevServer: vi.fn(async (project, settings) => ({
        projectId: project.id,
        url: settings.devServerUrl,
        running: false,
        pid: null,
      })),
      devServerLogs: vi.fn(async (project) => ({ projectId: project.id, logs: '' })),
      devServerHealth: vi.fn(async (project, settings) => ({
        projectId: project.id,
        url: settings.devServerUrl,
        reachable: false,
        status: null,
        checkedAt: '2026-07-20T00:00:00.000Z',
        error: null,
      })),
    };
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      worktrees: projectWorktrees.provisioner,
      projectCloneRoot: '/data/dev',
      projectWorktrees: () => projectWorktrees.provisioner,
      projectRuntime,
      provisioner: {
        provision: async () => (await ctx.store.getProject('p-preview-delete'))!,
        syncProjectCheckout,
      },
    });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s-preview-delete' });
      expect(res.statusCode).toBe(200);
      expect(syncProjectCheckout).not.toHaveBeenCalled();
      expect(startDevServer).not.toHaveBeenCalled();
      expect(projectWorktrees.removed).toEqual([
        '/data/dev/heey-global-verity/.verity-sessions/agent-preview',
      ]);
    } finally {
      await a.close();
    }
  });

  it('still deletes cleanly when worktree removal fails (best-effort)', async () => {
    const f = fake();
    f.provisioner.remove.mockRejectedValueOnce(new Error('worktree already gone'));
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/agent-s1', model: 'm' });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s1' });
      expect(res.statusCode).toBe(200);
      expect(await ctx.store.getSession('s1')).toBeUndefined();
    } finally {
      await a.close();
    }
  });

  it('never removes the repo-root checkout (delete-time safety guard #105)', async () => {
    const f = fake();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      worktrees: f.provisioner,
      workspaceDir: '/work',
    });
    // A stale session row whose worktree is the repo root must never `git worktree
    // remove` the operator's main tree on delete (sessions no longer run here).
    await ctx.store.createSession({ sessionId: 's1', worktree: '/work', model: 'm' });
    try {
      const res = await a.inject({ method: 'DELETE', url: '/sessions/s1' });
      expect(res.statusCode).toBe(200);
      expect(await ctx.store.getSession('s1')).toBeUndefined();
      expect(f.removed).toEqual([]); // the /work checkout is left untouched
    } finally {
      await a.close();
    }
  });
});

describe('POST /sessions project provisioning', () => {
  function fakeProvisioner() {
    return {
      provision: vi.fn(async (projectId: string): Promise<ProjectRecord> => {
        const updated = await ctx.store.updateProjectState(projectId, 'active');
        return updated ?? ((await ctx.store.getProject(projectId)) as ProjectRecord);
      }),
    };
  }

  it('defers queued-turn recovery while the secret store is sealed and runs it after unlock', async () => {
    const cipher = createSealableSecretCipher();
    const sealed = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
    });
    try {
      await sealed.ready();
      expect(recover).not.toHaveBeenCalled();

      const init = await sealed.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: 'correct horse battery staple', deviceLabel: 'test device' },
      });

      expect(init.statusCode).toBe(200);
      await vi.waitFor(() => {
        expect(recover).toHaveBeenCalledTimes(1);
      });
    } finally {
      await sealed.close();
    }
  });

  it('keeps queued turns deferred when post-unlock broker activation fails', async () => {
    const cipher = createSealableSecretCipher();
    const sealed = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
      onSecretUnlocked: () => Promise.reject(new Error('cutover failed')),
    });
    try {
      await sealed.ready();
      expect(recover).not.toHaveBeenCalled();

      const init = await sealed.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password: 'correct horse battery staple', deviceLabel: 'test device' },
      });

      expect(init.statusCode).toBe(503);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      await sealed.close();
    }
  });

  it('runs queued-turn recovery immediately for deployments without managed secrets', async () => {
    const plain = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
    });
    try {
      await plain.ready();
      await vi.waitFor(() => {
        expect(recover).toHaveBeenCalledTimes(1);
      });
    } finally {
      await plain.close();
    }
  });

  it('does not re-run queued-turn recovery after a failed attempt (P0d)', async () => {
    const cipher = createSealableSecretCipher();
    recover.mockRejectedValueOnce(new Error('recovery boom')); // first attempt fails
    const sealed = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: cipher,
    });
    try {
      await sealed.ready();
      const password = 'correct horse battery staple';
      const init = await sealed.inject({
        method: 'POST',
        url: '/secret/init',
        payload: { password, deviceLabel: 'test device' },
      });
      expect(init.statusCode).toBe(200);
      // Unlock #1 (via init) ran recovery once — and it FAILED.
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));

      // A later unlock trigger must NOT re-run recovery: the run-once latch holds
      // despite the failure, so orphan tail-prompts can't be double-dispatched.
      const unlock = await sealed.inject({
        method: 'POST',
        url: '/secret/unlock',
        payload: { password, deviceLabel: 'test device' },
      });
      expect(unlock.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(recover).toHaveBeenCalledTimes(1);
    } finally {
      await sealed.close();
    }
  });

  it('503s without queuing project provisioning when the secret store is sealed', async () => {
    await ctx.store.upsertProject({
      id: 'p-session-sealed',
      owner: 'heey-global',
      repo: 'k8s',
      containerName: 'verity-heey-global--k8s',
      state: 'failed',
    });
    const provisioner = fakeProvisioner();
    const sealed = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner,
      projectCloneRoot: '/srv/verity/workspaces',
      projectBackend: () =>
        ({ start: vi.fn(), send: vi.fn(), cancel: vi.fn(), run: vi.fn() }) as unknown as Backend,
      secretCipher: createSealableSecretCipher(),
    });
    try {
      const res = await sealed.inject({
        method: 'POST',
        url: '/sessions',
        payload: {
          name: 'k8s test',
          model: 'codex/gpt-5.1-codex-max',
          project: 'heey-global/k8s',
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'secret store is sealed', status: 'sealed' });
      expect(provisioner.provision).not.toHaveBeenCalled();
      expect(await ctx.store.getProject('p-session-sealed')).toMatchObject({ state: 'failed' });
    } finally {
      await sealed.close();
    }
  });
});

describe('POST /sessions/:id/turns', () => {
  it('accepts a turn (202) and dispatches it to the conductor', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'keep going' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sessionId: 's1', accepted: true, queued: false });
    expect(dispatchTurn).toHaveBeenCalledWith('s1', 'keep going', expect.any(Object));
  });

  it('forwards optional turn options to the conductor', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go', permissionMode: 'plan', model: 'claude-opus-4-8', timeoutMs: 5000 },
    });
    expect(dispatchTurn).toHaveBeenCalledWith('s1', 'go', {
      permissionMode: 'plan',
      model: 'claude-opus-4-8',
      timeoutMs: 5000,
      allowedTools: undefined,
      disallowedTools: undefined,
    });
  });

  it('threads a clientReplyId to the conductor as the idempotency key (ADR 0008)', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'yes, do it', clientReplyId: 'reply-abc' },
    });
    expect(res.statusCode).toBe(202);
    expect(dispatchTurn).toHaveBeenCalledWith('s1', 'yes, do it', expect.any(Object), {
      clientReplyId: 'reply-abc',
    });
  });

  // Steered into a running reply, a second meeting question shares that reply and its
  // card shows the answer to the first question.
  it('queues a turn behind the active one only when the client asks for it', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: true });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'meeting question', queueBehindActiveTurn: true },
    });
    expect(res.statusCode).toBe(202);
    expect(dispatchTurn).toHaveBeenCalledWith('s1', 'meeting question', expect.any(Object), {
      queueBehindActiveTurn: true,
    });
  });

  it('stamps the authenticated caller as the initiator, never a body-supplied one', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const { token } = await registry.mint('phone');
    const gated = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      secretCipher: createSealableSecretCipher(),
      authRegistry: registry,
    });
    try {
      dispatchTurn.mockResolvedValueOnce({ queued: false });
      const res = await gated.inject({
        method: 'POST',
        url: '/sessions/s1/turns',
        headers: { authorization: `Bearer ${token}` },
        payload: { prompt: 'go', initiatedBy: { userId: 'someone-else' } },
      });
      expect(res.statusCode).toBe(202);
      const caller = registry.resolveUserId(token);
      expect(caller).toBeDefined();
      expect(dispatchTurn).toHaveBeenCalledWith('s1', 'go', expect.any(Object), {
        initiatedBy: { userId: caller },
      });
    } finally {
      await gated.close();
    }
  });

  it('rejects unknown provider model overrides for project-bound sessions', async () => {
    await ctx.store.upsertProject({
      id: 'p-turn-model',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-project-turn',
      worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-turn',
      model: 'claude-opus-4-8',
      projectId: 'p-turn-model',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-project-turn/turns',
      payload: { prompt: 'go', model: 'deepinfra/moonshotai/Kimi-K2.6' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error:
        'project sessions currently support Claude, Codex, and configured OpenCode models only',
    });
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('allows configured OpenCode model overrides for project-bound sessions', async () => {
    await ctx.store.updateVeritySettings({
      opencodeBaseUrl: 'https://provider.example/v1',
      opencodeApiKey: 'provider-key',
      opencodeModels: 'model-a',
    });
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    await ctx.store.upsertProject({
      id: 'p-turn-opencode',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-project-opencode-turn',
      worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-opencode-turn',
      model: 'claude-opus-4-8',
      projectId: 'p-turn-opencode',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-project-opencode-turn/turns',
      payload: { prompt: 'go', model: 'verity/model-a' },
    });

    expect(res.statusCode).toBe(202);
    expect(dispatchTurn).toHaveBeenCalledWith(
      's-project-opencode-turn',
      'go',
      expect.objectContaining({ model: 'verity/model-a' }),
    );
  });

  it('rejects a stored OpenCode model after its central configuration is removed', async () => {
    await ctx.store.upsertProject({
      id: 'p-turn-stale-opencode',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-project-stale-opencode-turn',
      worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-stale-opencode-turn',
      model: 'verity/model-a',
      projectId: 'p-turn-stale-opencode',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-project-stale-opencode-turn/turns',
      payload: { prompt: 'go' },
    });

    expect(res.statusCode).toBe(400);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('rejects a turn (409) when the project sandbox is not active (SBX-4)', async () => {
    await ctx.store.upsertProject({
      id: 'p-inactive',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'failed',
    });
    await ctx.store.createSession({
      sessionId: 's-inactive',
      worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-x',
      model: 'claude-opus-4-8',
      projectId: 'p-inactive',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-inactive/turns',
      payload: { prompt: 'go' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not active/);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it.each(['sleeping', 'waking'] as const)(
    'accepts a turn while the project sandbox is %s so preparation can wake it',
    async (state) => {
      dispatchTurn.mockResolvedValueOnce({ queued: false });
      await ctx.store.upsertProject({
        id: `p-${state}`,
        owner: 'heey-global',
        repo: 'verity',
        containerName: `dev-heey-global-verity-${state}`,
        state,
      });
      await ctx.store.createSession({
        sessionId: `s-${state}`,
        worktree: `/data/dev/heey-global-verity/.verity-sessions/agent-${state}`,
        model: 'claude-opus-4-8',
        projectId: `p-${state}`,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/sessions/s-${state}/turns`,
        payload: { prompt: 'wake up and continue' },
      });

      expect(res.statusCode).toBe(202);
      expect(dispatchTurn).toHaveBeenCalledWith(
        `s-${state}`,
        'wake up and continue',
        expect.any(Object),
      );
    },
  );

  it('does not require an active sandbox for Verity Control turns', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    await ctx.store.upsertProject({
      id: 'verity-control',
      kind: 'control_plane',
      owner: 'verity',
      repo: 'control',
      containerName: 'verity-control',
      state: 'failed',
    });
    await ctx.store.createSession({
      sessionId: 's-control-turn',
      worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-control',
      model: 'claude-opus-4-8',
      projectId: 'verity-control',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-control-turn/turns',
      payload: { prompt: 'go' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sessionId: 's-control-turn', accepted: true, queued: false });
    expect(dispatchTurn).toHaveBeenCalledWith('s-control-turn', 'go', expect.any(Object));
  });

  it('allows Codex model overrides for project-bound sessions', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    await ctx.store.upsertProject({
      id: 'p-turn-codex',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-project-codex-turn',
      worktree: '/data/dev/heey-global-verity/.verity-sessions/agent-codex-turn',
      model: 'claude-opus-4-8',
      projectId: 'p-turn-codex',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s-project-codex-turn/turns',
      payload: { prompt: 'go', model: 'codex/default' },
    });

    expect(res.statusCode).toBe(202);
    expect(dispatchTurn).toHaveBeenCalledWith(
      's-project-codex-turn',
      'go',
      expect.objectContaining({ model: 'codex/default' }),
    );
  });

  it('forwards per-turn allow/deny tool lists to the conductor', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: {
        prompt: 'go',
        allowedTools: ['Read', 'Bash(git *)'],
        disallowedTools: ['WebFetch'],
      },
    });
    expect(dispatchTurn).toHaveBeenCalledWith(
      's1',
      'go',
      expect.objectContaining({
        allowedTools: ['Read', 'Bash(git *)'],
        disallowedTools: ['WebFetch'],
      }),
    );
  });

  it('rejects a non-array tool list with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go', allowedTools: 'Read' },
    });
    expect(res.statusCode).toBe(400);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('forwards image attachments to the conductor', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    const attachments = [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }];
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'look', attachments },
    });
    expect(res.statusCode).toBe(202);
    expect(dispatchTurn).toHaveBeenCalledWith(
      's1',
      'look',
      expect.objectContaining({ attachments }),
    );
  });

  it('accepts an attachments-only turn with an empty prompt (202)', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: {
        prompt: '',
        attachments: [{ kind: 'image', mediaType: 'image/jpeg', data: 'eA==' }],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(dispatchTurn).toHaveBeenCalledWith(
      's1',
      '',
      expect.objectContaining({
        attachments: [{ kind: 'image', mediaType: 'image/jpeg', data: 'eA==' }],
      }),
    );
  });

  it('rejects an empty turn with neither prompt nor attachments (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('rejects an attachment with an unsupported media type (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: {
        prompt: 'x',
        attachments: [{ kind: 'image', mediaType: 'image/tiff', data: 'eA==' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('names the empty attachments that made a turn unsendable (400)', async () => {
    // The whole send is discarded over these — prompt and valid attachments
    // included — so a 400 that identifies them only by array index leaves the
    // operator re-picking every file to find the ones with no bytes.
    const attachments = [
      { kind: 'file', mediaType: 'application/pdf', fileName: 'quarterly.pdf', data: '' },
      { kind: 'image', mediaType: 'image/png', data: 'aGk=' },
      { kind: 'file', mediaType: 'application/pdf', fileName: 'notes.pdf', data: '' },
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'review these', attachments },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{
      error: string;
      code: string;
      attachments: { index: number }[];
    }>();
    expect(body.code).toBe('invalidAttachments');
    const emptyIndices = attachments.flatMap((a, index) => (a.data.length === 0 ? [index] : []));
    expect(body.attachments.map((a) => a.index)).toEqual(emptyIndices);
    for (const index of emptyIndices) {
      expect(body.error).toContain(attachments[index]!.fileName);
    }
    // The attachment that was fine is not blamed, and no payload is echoed back.
    expect(body.error).not.toContain('aGk=');
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('keeps a non-attachment rejection generic (400)', async () => {
    // The error boundary deliberately never reflects schema detail; only the
    // attachment path is exempt, and only for names the client itself sent.
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'x', model: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid request' });
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('does not misreport malformed attachment data as oversized', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: {
        prompt: 'x',
        attachments: [
          { kind: 'file', mediaType: 'application/pdf', fileName: 'broken.pdf', data: 42 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('"broken.pdf" has invalid data');
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('bounds an echoed attachment name instead of reflecting the body verbatim', async () => {
    // A rejected body never passed the schema, so its `fileName` is arbitrary
    // client input: a newline would forge a second line in the app's banner and
    // in the warn log, and the schema's length cap never ran on it.
    const fileName = `a\nb${'x'.repeat(400)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: {
        prompt: 'x',
        attachments: [{ kind: 'file', mediaType: 'application/pdf', fileName, data: '' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; attachments: { fileName: string }[] }>();
    const [rejected] = body.attachments;
    expect(rejected!.fileName).not.toContain('\n');
    expect(rejected!.fileName.length).toBeLessThanOrEqual(255);
    expect(body.error).not.toContain('\n');
  });

  it('accepts a turn body larger than Fastify’s 1 MiB default (real-screenshot size)', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    // ~2 MiB of base64 — over the 1 MiB default body limit, under the per-image cap.
    const data = 'a'.repeat(2 * 1024 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'big', attachments: [{ kind: 'image', mediaType: 'image/png', data }] },
    });
    expect(res.statusCode).toBe(202);
    expect(dispatchTurn).toHaveBeenCalled();
  });

  it('applies separate image and decoded-file size limits without allocating payloads', () => {
    expect(isAttachmentBase64SizeAllowed('image', 10_000_000)).toBe(true);
    expect(isAttachmentBase64SizeAllowed('image', 10_000_001)).toBe(false);
    // Adjacent decoded byte counts can share a base64 length and differ only in padding.
    expect(isAttachmentBase64SizeAllowed('file', 33_333_336, 2)).toBe(true);
    expect(isAttachmentBase64SizeAllowed('file', 33_333_336, 1)).toBe(false);
  });

  it('caps the decoded attachment total without allocating payloads', () => {
    const maximumFile = { base64Length: 33_333_336, paddingCharacters: 2 };
    expect(isAttachmentBase64TotalSizeAllowed([maximumFile, maximumFile])).toBe(true);
    expect(
      isAttachmentBase64TotalSizeAllowed([
        maximumFile,
        maximumFile,
        { base64Length: 4, paddingCharacters: 2 },
      ]),
    ).toBe(false);
  });

  it('rejects more than the attachment count limit (400)', async () => {
    const attachments = Array.from({ length: 9 }, () => ({
      kind: 'image',
      mediaType: 'image/png',
      data: 'aGk=',
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'x', attachments },
    });
    expect(res.statusCode).toBe(400);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('maps an unknown session to 404', async () => {
    dispatchTurn.mockRejectedValueOnce(new UnknownSessionError('s1'));
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('queues a turn sent while one is in flight (202, queued: true)', async () => {
    // The conductor now enqueues a busy session's turn instead of throwing; the
    // route surfaces that as a 202 with `queued: true` (#90).
    dispatchTurn.mockResolvedValueOnce({ queued: true });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sessionId: 's1', accepted: true, queued: true });
  });

  it('strips repeated Verity instruction prefixes before dispatching a turn', async () => {
    dispatchTurn.mockResolvedValueOnce({ queued: false });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: {
        prompt: `${repeatedVerityInstructions}

go`,
      },
    });

    expect(res.statusCode).toBe(202);
    expect(dispatchTurn).toHaveBeenCalledWith('s1', 'go', expect.any(Object));
  });

  it('maps a full queue to 429', async () => {
    dispatchTurn.mockRejectedValueOnce(new QueueFullError('s1', 10));
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('queued') });
  });

  // A turn submitted while the ownership barrier holds the session (stop settling, or
  // a backend handoff in progress) must be REFUSED, not queued: the barrier exists so
  // no second process reaches the worktree. 409 tells the client to retry shortly.
  it('maps a turn submitted during a backend handoff to 409', async () => {
    dispatchTurn.mockRejectedValueOnce(new SessionBusyError('s1'));
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('completing a stop or backend handoff'),
    });
  });

  it('maps a session whose worktree is gone to 410 Gone', async () => {
    dispatchTurn.mockRejectedValueOnce(new WorktreeMissingError('s1', '/wt/s1'));
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('workspace no longer exists'),
    });
  });

  it('rejects an empty/whitespace-only prompt with 400 before dispatching', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid request' });
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('rejects a permission-bypassing mode with 400 before dispatching', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go', permissionMode: 'bypassPermissions' },
    });
    expect(res.statusCode).toBe(400);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('rejects an invalid session id with 400 before dispatching', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/bad%20id/turns',
      payload: { prompt: 'go' },
    });
    expect(res.statusCode).toBe(400);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('maps an unexpected conductor error to a sanitized 500', async () => {
    dispatchTurn.mockRejectedValueOnce(new Error('boom INTERNAL'));
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/turns',
      payload: { prompt: 'go' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal error' });
    expect(res.body).not.toContain('INTERNAL');
  });
});

describe('POST /sessions/:id/recover-worktree', () => {
  it('repairs only the selected Verity-owned session boundary', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'verity-route-worktree-recovery-'));
    const sessionsRoot = join(projectRoot, '.verity-sessions');
    const worktree = join(sessionsRoot, 'agent-repair');
    const nested = join(worktree, 'nested');
    mkdirSync(nested, { recursive: true });
    await ctx.store.upsertProject({
      id: 'p-worktree-repair',
      owner: 'heey-global',
      repo: 'repair',
      containerName: 'verity-heey-global--repair',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-worktree-repair',
      worktree,
      model: 'claude-opus-4-8',
      projectId: 'p-worktree-repair',
    });
    chmodSync(nested, 0o600);
    chmodSync(worktree, 0o600);
    chmodSync(sessionsRoot, 0o600);
    chmodSync(projectRoot, 0o600);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/sessions/s-worktree-repair/recover-worktree',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        sessionId: 's-worktree-repair',
        repaired: ['project-root', 'sessions-root', 'worktree'],
      });
      expect(lstatSync(nested).mode & 0o777).toBe(0o600);
    } finally {
      chmodSync(projectRoot, 0o700);
      chmodSync(sessionsRoot, 0o700);
      chmodSync(worktree, 0o700);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('POST /sessions/:id/cancel (#79)', () => {
  it('stops a running turn (200, cancelled: true) with an empty backlog', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    cancelTurn.mockReturnValueOnce(true);
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: 's1',
      cancelled: true,
      forceReleased: false,
      droppedQueued: [],
    });
    expect(cancelTurn).toHaveBeenCalledWith('s1');
  });

  it('returns cancelled: false (200, no-op) when the session is idle', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    cancelTurn.mockReturnValueOnce(false);
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: 's1',
      cancelled: false,
      forceReleased: false,
      droppedQueued: [],
    });
  });

  it('drops the pending backlog BEFORE cancelling the turn and returns the dropped prompts (#79)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // Record call order: the queue must be cleared before the turn is signalled, or
    // the cancelled turn's settle drains a queued message into a fresh turn.
    const order: string[] = [];
    clearQueue.mockImplementationOnce(async () => {
      order.push('clearQueue');
      return [
        { id: 'q1', prompt: 'first queued' },
        { id: 'q2', prompt: 'second queued' },
      ];
    });
    cancelTurn.mockImplementationOnce(() => {
      order.push('cancelTurn');
      return true;
    });
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: 's1',
      cancelled: true,
      forceReleased: false,
      droppedQueued: [
        { id: 'q1', prompt: 'first queued' },
        { id: 'q2', prompt: 'second queued' },
      ],
    });
    expect(stopSession).toHaveBeenCalledWith('s1');
    expect(order).toEqual(['clearQueue', 'cancelTurn']);
  });

  it('404s an unknown session without touching the conductor', async () => {
    const res = await app.inject({ method: 'POST', url: '/sessions/missing/cancel' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session missing not found' });
    expect(cancelTurn).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('leaves the unconfirmed-termination fence alone unless force is asked for', async () => {
    // The default has to stay the safe one: an ordinary Stop must never hand the
    // worktree on while the previous agent process is unaccounted for.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forceReleased: false });
    expect(releaseUnconfirmedTermination).not.toHaveBeenCalled();
  });

  it('releases the fence on force, AFTER the ordinary stop has had its chance', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const order: string[] = [];
    stopSession.mockImplementationOnce(async () => {
      order.push('stopSession');
      return { cancelled: false, droppedQueued: [] };
    });
    releaseUnconfirmedTermination.mockImplementationOnce(async () => {
      order.push('release');
      return true;
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/cancel',
      payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forceReleased: true });
    expect(releaseUnconfirmedTermination).toHaveBeenCalledWith('s1');
    // The graceful path first: an override should only ever face a fence that
    // survived a real stop attempt.
    expect(order).toEqual(['stopSession', 'release']);
  });

  it('reports forceReleased: false when force finds nothing fenced', async () => {
    // The button is reachable from a banner that may already be stale, so a force on
    // a healthy session must be an honest no-op rather than a lie about a release.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/cancel',
      payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forceReleased: false });
  });

  it('404s a force on an unknown session before releasing anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/missing/cancel',
      payload: { force: true },
    });
    expect(res.statusCode).toBe(404);
    expect(releaseUnconfirmedTermination).not.toHaveBeenCalled();
  });
});

describe('POST /sessions/:id/permissions/:toolUseId (#27)', () => {
  it('allows a tool: 200 decided:true, routes the decision to the conductor', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    decidePermission.mockReturnValueOnce(true);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/toolu_a',
      payload: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 's1', toolUseId: 'toolu_a', decided: true });
    expect(decidePermission).toHaveBeenCalledWith('s1', 'toolu_a', {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });
  });

  it('denies a tool, defaulting the message when none is given', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    decidePermission.mockReturnValueOnce(true);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/toolu_b',
      payload: { behavior: 'deny' },
    });
    expect(res.statusCode).toBe(200);
    expect(decidePermission).toHaveBeenCalledWith('s1', 'toolu_b', {
      behavior: 'deny',
      message: 'Denied by the operator.',
    });
  });

  it('404s when no prompt is pending under that id (already answered / turn ended)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    decidePermission.mockReturnValueOnce(false);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/stale',
      payload: { behavior: 'allow' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('stale') });
  });

  it('404s an unknown session without touching the conductor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/missing/permissions/toolu_a',
      payload: { behavior: 'allow' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session missing not found' });
    expect(decidePermission).not.toHaveBeenCalled();
  });

  it('400s an invalid decision body (unknown behavior)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/toolu_a',
      payload: { behavior: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
    expect(decidePermission).not.toHaveBeenCalled();
  });
});

describe('POST /sessions/:id/queue/:itemId/cancel (retract, #80)', () => {
  it('retracts a queued turn (200) and returns its prompt', async () => {
    dequeue.mockResolvedValueOnce({ prompt: 'fix this typo' });
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/queue/q1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 's1', itemId: 'q1', prompt: 'fix this typo' });
    expect(dequeue).toHaveBeenCalledWith('s1', 'q1');
  });

  it('404s a queued item that is already gone (drained / retracted)', async () => {
    dequeue.mockResolvedValueOnce(undefined);
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/queue/stale/cancel' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('stale') });
  });
});

describe('POST /sessions', () => {
  it('provisions a worktree, creates a visible session, and answers 201 without starting an LLM', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: { prompt: 'build the thing', model: 'claude-opus-4-8' },
    });

    expect(res.statusCode).toBe(201);
    const { sessionId }: { sessionId: string } = res.json();
    expect(sessionId.length).toBeGreaterThan(0);
    expect(startSession).not.toHaveBeenCalled();
    const session = await ctx.store.getSession(sessionId);
    expect(session).toMatchObject({
      sessionId,
      model: 'claude-opus-4-8',
    });
    expect(session?.worktree.startsWith(worktreeRoot)).toBe(true);
    expect(existsSync(session?.worktree ?? '')).toBe(true);
  });

  it('creates the session under a client-minted id, so the app can open it first', async () => {
    const sessionId = '3f1c2b7e-9d4a-4c8e-8b1f-2a6d5e4c7b90';

    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { sessionId } });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ sessionId });
    expect(await ctx.store.getSession(sessionId)).toMatchObject({ sessionId });
  });

  it('rejects a client id that is not a UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: { sessionId: '../../etc/passwd' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('answers a repeated create with the existing session instead of a second worktree', async () => {
    const sessionId = '5a2e4d1b-7c39-4f6a-9e08-3b1c5d7a2f44';
    const first = await app.inject({ method: 'POST', url: '/sessions', payload: { sessionId } });
    expect(first.statusCode).toBe(201);
    const worktree = (await ctx.store.getSession(sessionId))?.worktree;

    // The app re-issues the same create — a reconnect, a re-mounted screen, or a
    // client timeout on the slow spawn.
    const second = await app.inject({ method: 'POST', url: '/sessions', payload: { sessionId } });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ sessionId, existing: true });
    // Same session, same worktree: nothing was provisioned twice.
    expect((await ctx.store.getSession(sessionId))?.worktree).toBe(worktree);
    expect((await ctx.store.listSessions()).filter((s) => s.sessionId === sessionId)).toHaveLength(
      1,
    );
  });

  it('collapses two concurrent creates of one id into a single session', async () => {
    const sessionId = 'b7d6c4a2-1e58-4f3b-8a90-6c2d4e1f5b73';

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/sessions', payload: { sessionId } }),
      app.inject({ method: 'POST', url: '/sessions', payload: { sessionId } }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    expect(first.json()).toMatchObject({ sessionId });
    expect(second.json()).toMatchObject({ sessionId });
    expect(await ctx.store.getSession(sessionId)).toMatchObject({ sessionId });
  });

  it('provisions once even when both creates get past the existence check', async () => {
    const sessionId = 'c9e3a1f7-4b62-4d08-9a35-7f1e2c6b4d80';
    const real = ctx.store.getSession.bind(ctx.store);
    // Two real sockets, not `inject`: injected requests are dispatched one after
    // the other, so the collapse above never actually overlapped and would pass
    // against a route that provisions twice.
    //
    // The barrier then pins the overlap to the exact window that matters instead
    // of leaving it to how fast the store answers: the first lookup is held until
    // the second one arrives, so both are released with the id still looking free.
    // Unless the claim is taken in the same tick as the lookup, both go on to
    // provision — and the loser's cleanup, keyed on the id they share, deletes the
    // winner's session on the way out. The timeout is the release for the fixed
    // route, where the second lookup only happens after the first run finished.
    let release!: () => void;
    let arrived = 0;
    const bothInside = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 50);
    });
    const getSession = vi.spyOn(ctx.store, 'getSession').mockImplementation(async (id: string) => {
      if (id === sessionId && ++arrived <= 2) {
        if (arrived === 2) release();
        await bothInside;
      }
      return real(id);
    });
    const worktreesBefore = readdirSync(worktreeRoot).length;
    const create = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${String(port)}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

    try {
      const [first, second] = await Promise.all([create(), create()]);
      const answers = [await first.json(), await second.json()];

      expect([first.status, second.status].sort()).toEqual([200, 201]);
      // The 201 is the run that minted it; the 200 says "already there, do not
      // repeat the first turn" (see the restore path in the app's `/new`).
      expect(answers).toContainEqual({ sessionId });
      expect(answers).toContainEqual({ sessionId, existing: true });
      // Survived its own retry: the session is still there, on one worktree.
      expect(await real(sessionId)).toMatchObject({ sessionId });
      expect(readdirSync(worktreeRoot).length).toBe(worktreesBefore + 1);
    } finally {
      getSession.mockRestore();
    }
  });

  it('creates an empty session body without starting an LLM', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(startSession).not.toHaveBeenCalled();
    const { sessionId }: { sessionId: string } = res.json();
    expect(await ctx.store.getSession(sessionId)).toMatchObject({ sessionId });
  });

  it('uses the prioritized concrete Codex model when Codex is the only configured login', async () => {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: null,
      codexAuthJson: '{"tokens":{"access_token":"codex"}}',
    });
    const codexOnly = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      listModels: () =>
        Promise.resolve(['codex/default', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra']),
    });
    try {
      const res = await codexOnly.inject({ method: 'POST', url: '/sessions', payload: {} });

      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect((await ctx.store.getSession(sessionId))?.model).toBe('codex/gpt-5.6-sol');
    } finally {
      await codexOnly.close();
    }
  });

  it('keeps the CLI default as an internal spawn fallback when initial Codex discovery fails', async () => {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: null,
      codexAuthJson: '{"tokens":{"access_token":"codex"}}',
    });
    const codexOnly = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      listModels: () => Promise.reject(new Error('catalog unavailable')),
    });
    try {
      const models = await codexOnly.inject({ method: 'GET', url: '/models' });
      expect(models.json()).toEqual({ models: [] });

      const res = await codexOnly.inject({ method: 'POST', url: '/sessions', payload: {} });
      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect((await ctx.store.getSession(sessionId))?.model).toBe('codex/default');
    } finally {
      await codexOnly.close();
    }
  });

  it('reuses the latest session model when it is still available', async () => {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: '{"claudeAiOauth":{"accessToken":"claude"}}',
      codexAuthJson: '{"tokens":{"access_token":"codex"}}',
    });
    await ctx.store.createSession({
      sessionId: 'previous-codex-session',
      worktree: '/wt/previous-codex-session',
      model: 'codex/gpt-5.6-terra',
    });
    await ctx.store.setSessionModel('previous-codex-session', 'codex/gpt-5.6-sol');
    const bothProviders = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      listModels: () => Promise.resolve(['codex/gpt-5.6-sol', 'codex/gpt-5.6-terra']),
    });
    try {
      const res = await bothProviders.inject({ method: 'POST', url: '/sessions', payload: {} });
      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect((await ctx.store.getSession(sessionId))?.model).toBe('codex/gpt-5.6-terra');
    } finally {
      await bothProviders.close();
    }
  });

  it('persists the create name as the session display name (trimmed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: { name: '  Add settings  ' },
    });
    expect(res.statusCode).toBe(201);
    const { sessionId }: { sessionId: string } = res.json();
    expect((await ctx.store.getSession(sessionId))?.name).toBe('Add settings');
  });

  it('allocates a distinct worktree per call', async () => {
    const first = await app.inject({ method: 'POST', url: '/sessions', payload: { prompt: 'a' } });
    const second = await app.inject({ method: 'POST', url: '/sessions', payload: { prompt: 'b' } });
    const firstBody: { sessionId: string } = first.json();
    const secondBody: { sessionId: string } = second.json();
    const w1 = (await ctx.store.getSession(firstBody.sessionId))?.worktree;
    const w2 = (await ctx.store.getSession(secondBody.sessionId))?.worktree;
    expect(w1).not.toBe(w2);
  });

  it('accepts a whitespace-only create prompt without starting an LLM', async () => {
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { prompt: '   ' } });
    expect(res.statusCode).toBe(201);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('returns a sanitized 500 when the worktree root cannot be created', async () => {
    const aFile = join(worktreeRoot, 'a-file');
    writeFileSync(aFile, 'x'); // mkdir under a FILE → ENOTDIR
    const badApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: join(aFile, 'under-a-file'),
    });
    try {
      const res = await badApp.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal error' });
      expect(startSession).not.toHaveBeenCalled(); // mkdir failed before session create
    } finally {
      await badApp.close();
    }
  });
});

describe('POST /sessions (injected worktree provisioner)', () => {
  function fake() {
    const added: string[] = [];
    const removed: string[] = [];
    const provisioner = {
      add: vi.fn(async (branch: string) => {
        added.push(branch);
        return `/wt/${branch.replace(/\//g, '-')}`;
      }),
      remove: vi.fn(async (worktreePath: string) => {
        removed.push(worktreePath);
      }),
    };
    return { added, removed, provisioner };
  }

  it('provisions via the provisioner, seeds the branch from `name`, and starts in that path', async () => {
    const f = fake();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'do it', name: 'Add Settings!' },
      });
      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect(f.added[0]).toMatch(/^agent\/add-settings-[0-9a-f]{8}$/); // slugified name + short id
      expect((await ctx.store.getSession(sessionId))?.worktree).toBe(
        `/wt/${f.added[0]!.replace(/\//g, '-')}`,
      );
      expect(startSession).not.toHaveBeenCalled();
      expect(f.removed).toEqual([]); // kept on success
    } finally {
      await a.close();
    }
  });

  it('generates a name-less branch when no name is given', async () => {
    const f = fake();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      await a.inject({ method: 'POST', url: '/sessions', payload: { prompt: 'go' } });
      expect(f.added[0]).toMatch(/^agent\/[0-9a-f]{8}$/);
    } finally {
      await a.close();
    }
  });

  it('accepts raw empty JSON bodies sent by mobile/web clients', async () => {
    const f = fake();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });

      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect(await ctx.store.getSession(sessionId)).toMatchObject({ sessionId });
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('surfaces an empty base repository without starting a session', async () => {
    const f = fake();
    f.provisioner.add.mockRejectedValueOnce(new RepositoryHasNoCommitsError());
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      const res = await a.inject({ method: 'POST', url: '/sessions', payload: { prompt: 'go' } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error:
          'repository has no commits yet; initialize its default branch before starting a session',
      });
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('names a spawn-from-issue branch feat/<issue>-<slug> so the header shows Issue #N (#137)', async () => {
    const f = fake();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'work on it', name: 'Add Settings!', issue: 137 },
      });
      expect(res.statusCode).toBe(201);
      // feat/<issue>-<slug>-<shortid> — the leading `feat/137-` is what the client's
      // parseBranchIssue reads to show `Issue #137`.
      expect(f.added[0]).toMatch(/^feat\/137-add-settings-[0-9a-f]{8}$/);
    } finally {
      await a.close();
    }
  });

  it('names a spawn-from-issue branch feat/<issue>-<shortid> when no name is given (#137)', async () => {
    const f = fake();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', issue: 42 },
      });
      expect(f.added[0]).toMatch(/^feat\/42-[0-9a-f]{8}$/);
    } finally {
      await a.close();
    }
  });

  it('rejects a non-positive / non-integer issue with 400', async () => {
    const f = fake();
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      for (const issue of [0, -1, 1.5]) {
        const res = await a.inject({
          method: 'POST',
          url: '/sessions',
          payload: { prompt: 'go', issue },
        });
        expect(res.statusCode).toBe(400);
      }
      expect(f.added).toEqual([]); // no worktree provisioned for a rejected spawn
    } finally {
      await a.close();
    }
  });

  it('maps a provisioner.add failure to a sanitized 500 without starting', async () => {
    const f = fake();
    f.provisioner.add.mockRejectedValueOnce(new Error('fatal: worktree add failed'));
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      const res = await a.inject({ method: 'POST', url: '/sessions', payload: { prompt: 'go' } });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal error' });
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('removes a provisioned worktree when the session row cannot be created', async () => {
    const f = fake();
    await ctx.store.createSession({ sessionId: 'existing', worktree: '/wt/collision', model: 'm' });
    f.provisioner.add.mockImplementationOnce(async (branch: string) => {
      f.added.push(branch);
      return '/wt/collision';
    });
    const a = buildServer({ eventStore: ctx.store, bus, conductor, worktrees: f.provisioner });
    try {
      const res = await a.inject({ method: 'POST', url: '/sessions', payload: { prompt: 'go' } });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal error' });
      expect(f.removed).toEqual(['/wt/collision']);
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it("ignores a legacy target:'workspace' — every spawn is isolated, never /work (#105)", async () => {
    const f = fake();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      worktrees: f.provisioner,
      workspaceDir: '/work', // configured (delete guard), but no spawn may resolve to it
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        // `target` is no longer in the schema — a legacy client sending it is
        // stripped by zod, and the spawn still provisions its own worktree.
        payload: { prompt: 'edit the app', target: 'workspace' },
      });
      expect(res.statusCode).toBe(201);
      expect(f.added).toHaveLength(1); // a fresh isolated worktree WAS provisioned
      const { sessionId }: { sessionId: string } = res.json();
      const worktree = (await ctx.store.getSession(sessionId))?.worktree;
      expect(worktree).not.toBe('/work'); // never the shared repo root
      expect(worktree).toBe(`/wt/${f.added[0]!.replace(/\//g, '-')}`);
    } finally {
      await a.close();
    }
  });
});

describe('POST /sessions with project field (#174)', () => {
  const mockProject: ProjectRecord = {
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'dev-heey-global-verity',
    imageRef: null,
    state: 'active',
    provisionError: null,
    provisionWarning: null,
    hiddenAt: null,
    latestReleaseTag: null,
    latestReleaseName: null,
    latestReleaseUrl: null,
    latestReleasePublishedAt: null,
    createdAt: new Date('2026-06-26T00:00:00.000Z'),
    updatedAt: new Date('2026-06-26T00:00:00.000Z'),
    stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
  };

  function fakeProvisioner() {
    return {
      provision: vi.fn(async (projectId: string): Promise<ProjectRecord> => ({
        ...mockProject,
        id: projectId,
      })),
    };
  }

  const fakeProjectBackend = (_project: unknown, selected: Backend) => selected;
  const fakeProjectWorktrees = () => ({
    add: vi.fn(
      async (branch: string) =>
        `/data/dev/heey-global-verity/.verity-sessions/${branch.replace(/\//g, '-')}`,
    ),
    remove: vi.fn(async () => undefined),
  });
  type ProjectSettingsPatchForTest = {
    dopplerTokenRef?: string | null;
    defaultBranch?: string | null;
    defaultModel?: string | null;
    allowedAgents?: ('claude' | 'codex' | 'opencode')[] | null;
  };
  const updateProjectSettings = (projectId: string, patch: ProjectSettingsPatchForTest) =>
    (
      ctx.store as unknown as {
        updateProjectSettings: (
          projectId: string,
          patch: ProjectSettingsPatchForTest,
        ) => Promise<unknown>;
      }
    ).updateProjectSettings(projectId, patch);

  it('503s when no provisioner is configured and project is specified', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: { prompt: 'go', project: 'heey-global/verity' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'multi-repo provisioning is not configured' });
  });

  it('404s Verity Control project spawns until advanced mode is enabled', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: { project: 'verity/control', name: 'Server admin' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project verity/control is not in the fleet registry' });
    expect(startSession).not.toHaveBeenCalled();
  });

  it('creates Verity Control sessions without multi-repo provisioning', async () => {
    await ctx.store.updateVeritySettings({ advancedModeEnabled: true });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: { project: 'verity/control', name: 'Server admin', model: 'codex/default' },
    });

    expect(res.statusCode).toBe(201);
    const { sessionId }: { sessionId: string } = res.json();
    const session = await ctx.store.getSession(sessionId);
    expect(session).toMatchObject({
      sessionId,
      name: 'Server admin',
      projectId: 'verity-control',
      model: 'codex/default',
    });
    expect(session?.worktree.startsWith(worktreeRoot)).toBe(true);
    expect(startSession).not.toHaveBeenCalled();
    expect(await ctx.store.getEvents(sessionId)).toEqual([]);
    expect(await ctx.store.consumePendingNotes(sessionId)).toEqual([]);
  });

  it('enforces allowed agents before allocating a Verity Control worktree', async () => {
    await ctx.store.updateVeritySettings({ advancedModeEnabled: true });
    await app.inject({ method: 'GET', url: '/projects' });
    await ctx.store.updateProjectSettings('verity-control', { allowedAgents: ['claude'] });
    const before = readdirSync(worktreeRoot);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: { project: 'verity/control', model: 'codex/default' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Codex is not allowed in this project.' });
    expect(readdirSync(worktreeRoot)).toEqual(before);
  });

  it('503s when project clone root is missing and project is specified', async () => {
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'multi-repo provisioning is not configured' });
    } finally {
      await a.close();
    }
  });

  it('rejects an invalid project format with 400', async () => {
    const p = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: p,
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: '../etc/passwd' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid request' });
      expect(p.provision).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('404s when the project is not in the fleet registry', async () => {
    const p = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: p,
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'project heey-global/verity is not in the fleet registry',
      });
      expect(p.provision).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('404s when a project id is not in the fleet registry', async () => {
    const p = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: p,
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { projectId: 'missing-project' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'project missing-project is not in the fleet registry',
      });
      expect(p.provision).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  // A soft-deleted project keeps its row so the installation sync can't
  // resurrect it — but spawning against it would re-provision the very project
  // the operator deleted (`state='absent'` goes straight to the provisioner)
  // and leave the new session bound to a project nothing lists.
  it('404s a spawn for a soft-deleted project instead of re-provisioning it', async () => {
    await ctx.store.upsertProject({
      id: 'p-spawn-hidden',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    await ctx.store.hideProject('p-spawn-hidden');
    const p = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: p,
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { projectId: 'p-spawn-hidden' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'project p-spawn-hidden is not in the fleet registry',
      });
      expect(p.provision).not.toHaveBeenCalled();
      expect(await ctx.store.listSessions()).toHaveLength(0);
    } finally {
      await a.close();
    }
  });

  // The check above reads the project a worktree-creation before the insert, so
  // a delete that lands in between slips past it. `createSession` is where the
  // two are ordered against each other — it refuses a hidden project — and the
  // spawn has to answer with the same 404 rather than a 500, having cleaned up
  // the worktree the project delete has no session row to find.
  it('404s a spawn whose project is deleted while it provisions', async () => {
    await ctx.store.upsertProject({
      id: 'p-spawn-raced',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const worktree = '/data/dev/heey-global-verity/.verity-sessions/agent-raced';
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockImplementationOnce(async () => {
      await ctx.store.hideProject('p-spawn-raced');
      return worktree;
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      projectCloneRoot: '/data/dev/',
      projectBackend: fakeProjectBackend,
      projectWorktrees: () => projectWorktrees,
      worktrees: { add: vi.fn(async () => '/wt/raced'), remove: vi.fn(async () => {}) },
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', projectId: 'p-spawn-raced' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'project p-spawn-raced is not in the fleet registry',
      });
      expect(await ctx.store.listSessions()).toHaveLength(0);
      expect(projectWorktrees.remove).toHaveBeenCalledWith(worktree);
    } finally {
      await a.close();
    }
  });

  it('rejects OpenCode-routed models for project sessions before provisioning', async () => {
    const p = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: p,
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: {
          prompt: 'go',
          project: 'heey-global/verity',
          model: 'deepinfra/moonshotai/Kimi-K2.6',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error:
          'project sessions currently support Claude, Codex, and configured OpenCode models only',
      });
      expect(p.provision).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('returns 202 awaitingProvisioning when the project is not active', async () => {
    // Upsert a project in 'absent' state
    await ctx.store.upsertProject({
      id: 'p-absent',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'absent',
    });
    const p = fakeProvisioner();
    p.provision.mockResolvedValue({
      id: 'p-absent',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: null,
      state: 'absent',
      provisionError: null,
      provisionWarning: null,
      hiddenAt: null,
      latestReleaseTag: null,
      latestReleaseName: null,
      latestReleaseUrl: null,
      latestReleasePublishedAt: null,
      createdAt: new Date('2026-06-26T00:00:00.000Z'),
      updatedAt: new Date('2026-06-26T00:00:00.000Z'),
      stateChangedAt: new Date('2026-06-26T00:00:00.000Z'),
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: p,
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.awaitingProvisioning).toBe(true);
      expect(body.project).toMatchObject({
        id: 'p-absent',
        owner: 'heey-global',
        repo: 'verity',
        state: 'absent',
      });
      // Serialized like every other project payload. The raw row was handed out
      // here instead, which put internal columns on the wire and produced a body
      // no client schema accepts, so the app reported a schema dump where
      // "provisioning, try again shortly" belongs.
      expect(body.project).not.toHaveProperty('hiddenAt');
      expect(body.project).not.toHaveProperty('sleepCompatibilityFingerprint');
      expect(body.project).toHaveProperty('sandboxUpdate');
      expect(body.project).toHaveProperty('toolkitDrift', null);
      // The provisioner was fired asynchronously (fire-and-forget)
      expect(p.provision).toHaveBeenCalledWith('p-absent', {
        confirmWarnings: false,
        initiator: { kind: 'user', userId: null },
      });
      // No session was started (we returned early)
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('creates normally and binds session to project when state is active', async () => {
    await ctx.store.upsertProject({
      id: 'p-active',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockResolvedValueOnce(
      '/data/dev/heey-global-verity/.verity-sessions/agent-abc',
    );
    const refreshProjectToken = vi.fn(async () => undefined);
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      projectCloneRoot: '/data/dev/',
      projectBackend: fakeProjectBackend,
      refreshProjectToken,
      projectWorktrees: () => projectWorktrees,
      worktrees: { add: vi.fn(async () => '/wt/s-proj'), remove: vi.fn(async () => {}) },
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect(projectWorktrees.add).toHaveBeenCalled();
      expect(refreshProjectToken).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-active' }));
      expect(refreshProjectToken.mock.invocationCallOrder[0]).toBeLessThan(
        projectWorktrees.add.mock.invocationCallOrder[0]!,
      );
      const session = await ctx.store.getSession(sessionId);
      expect(session?.projectId).toBe('p-active');
      expect(session?.worktree).toBe('/data/dev/heey-global-verity/.verity-sessions/agent-abc');
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('creates a persisted Forgejo session alongside GitHub without contacting GitHub', async () => {
    await ctx.store.forgeConnections.upsert({
      id: 'forgejo-session',
      provider: 'forgejo',
      baseUrl: 'https://forge.example:3000',
      label: 'Forgejo',
      personalToken: 'forgejo-fixture',
      githubAppId: null,
      githubAppInstallationId: null,
      githubAppPrivateKey: null,
    });
    await ctx.store.upsertProject({
      id: 'p-active',
      kind: 'forgejo',
      forgeConnectionId: 'forgejo-session',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'parallel-github',
      owner: 'heey-global',
      repo: 'github-repo',
      containerName: 'dev-github-repo',
      state: 'active',
      kind: 'github',
    });
    const githubFetch = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) }));
    const cachedMint = createCachedProjectTokenMint(
      createGitHubAppProjectTokenMint({
        appId: '123',
        defaultInstallationId: '456',
        privateKeyPath: '/unused/github.pem',
        fetch: githubFetch,
      }),
    );
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockResolvedValueOnce(
      '/data/dev/heey-global-verity/.verity-sessions/agent-abc',
    );
    const refreshProjectToken = vi.fn(async (project: Parameters<typeof cachedMint>[0]) => {
      await cachedMint.strict(project);
    });
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      projectCloneRoot: '/data/dev/',
      projectBackend: fakeProjectBackend,
      refreshProjectToken,
      projectWorktrees: () => projectWorktrees,
      worktrees: { add: vi.fn(async () => '/wt/s-proj'), remove: vi.fn(async () => {}) },
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', projectId: 'p-active' },
      });
      expect(res.statusCode).toBe(201);
      expect(githubFetch).not.toHaveBeenCalled();
      const { sessionId }: { sessionId: string } = res.json();
      expect(projectWorktrees.add).toHaveBeenCalled();
      expect(refreshProjectToken).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-active' }));
      expect(refreshProjectToken.mock.invocationCallOrder[0]).toBeLessThan(
        projectWorktrees.add.mock.invocationCallOrder[0]!,
      );
      const session = await ctx.store.getSession(sessionId);
      expect(session?.projectId).toBe('p-active');
      expect(session?.worktree).toBe('/data/dev/heey-global-verity/.verity-sessions/agent-abc');
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  // A Sandbox in a sleep lifecycle state is provisioned, not missing: its clone and
  // worktrees are on the host, and `publicProject` even reports it to clients as
  // `active`. Routing the spawn to the provisioner claimed the row for `cloning` —
  // which drops the compatibility fingerprint the wake needs — and rebuilt the very
  // container the sleep was retaining, while the app got a 202 for a project it was
  // told is up. All three states are covered because all three reach this branch and
  // all three own a container the provisioner would destroy.
  it.each(['sleeping', 'sleeping_starting', 'waking'] as const)(
    'spawns into a %s project without provisioning it',
    async (state) => {
      const projectId = `p-${state}`;
      await ctx.store.upsertProject({
        id: projectId,
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        state: 'active',
      });
      await ctx.store.updateProjectSleepState(projectId, state, {
        sleepCompatibilityFingerprint: 'fingerprint-1',
        sleepingSince: state === 'sleeping' ? new Date('2026-06-26T00:00:00.000Z') : null,
        wakeStartedAt: state === 'waking' ? new Date('2026-06-26T00:01:00.000Z') : null,
      });
      const p = fakeProvisioner();
      const projectWorktrees = fakeProjectWorktrees();
      const a = buildServer({
        eventStore: ctx.store,
        bus,
        conductor,
        provisioner: p,
        projectCloneRoot: '/data/dev/',
        projectBackend: fakeProjectBackend,
        projectWorktrees: () => projectWorktrees,
        worktrees: { add: vi.fn(async () => '/wt/s-asleep'), remove: vi.fn(async () => {}) },
      });
      try {
        const res = await a.inject({
          method: 'POST',
          url: '/sessions',
          payload: { prompt: 'go', projectId },
        });
        expect(res.statusCode).toBe(201);
        const { sessionId }: { sessionId: string } = res.json();
        const session = await ctx.store.getSession(sessionId);
        expect(session?.projectId).toBe(projectId);
        // The worktree comes from the project's clone on the host, which the sleep
        // never touched — a spawn needs no running container. Assert the call and a
        // concrete path under that clone: comparing against an absent mock result is
        // `undefined === undefined`, which would hold for a session that got no
        // worktree at all.
        expect(projectWorktrees.add).toHaveBeenCalledTimes(1);
        expect(session?.worktree).toMatch(/^\/data\/dev\/heey-global-verity\/\.verity-sessions\/./);
        expect(session?.worktree).toBe(await projectWorktrees.add.mock.results[0]?.value);
        expect(p.provision).not.toHaveBeenCalled();
        // The spawn leaves the Sandbox where it found it — the first turn is what
        // wakes it, and the fingerprint that wake depends on is still there.
        const after = await ctx.store.getProject(projectId);
        expect(after?.state).toBe(state);
        expect(after?.sleepCompatibilityFingerprint).toBe('fingerprint-1');
      } finally {
        await a.close();
      }
    },
  );

  it('creates a session for a local project addressed by project id', async () => {
    await ctx.store.createProject({
      id: 'p-local-active',
      kind: 'local',
      owner: '__local__',
      repo: 'my-project',
      cloneDir: '__local__-my-project',
      containerName: 'verity-__local__--my-project',
      state: 'active',
    });
    const dataRoot = mkdtempSync(join(worktreeRoot, 'local-documents-'));
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockResolvedValueOnce(
      '/data/dev/__local__-my-project/.verity-sessions/agent-local',
    );
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      dataRoot,
      projectCloneRoot: join(dataRoot, 'workspaces'),
      projectBackend: fakeProjectBackend,
      projectWorktrees: () => projectWorktrees,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { projectId: 'p-local-active' },
      });

      expect(res.statusCode).toBe(201);
      expect(projectWorktrees.add).not.toHaveBeenCalled();
      const { sessionId }: { sessionId: string } = res.json();
      expect(await ctx.store.getSession(sessionId)).toMatchObject({
        sessionId,
        projectId: 'p-local-active',
        worktree: expect.stringContaining('/__local__-my-project/.verity-document-sessions/'),
      });
    } finally {
      await a.close();
    }
  });

  it('uses the project default model when no model is supplied', async () => {
    await ctx.store.upsertProject({
      id: 'p-default-model',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await updateProjectSettings('p-default-model', { defaultModel: 'codex/default' });
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockResolvedValueOnce(
      '/data/dev/heey-global-verity/.verity-sessions/agent-default-model',
    );
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
      projectWorktrees: () => projectWorktrees,
      worktrees: { add: vi.fn(async () => '/wt/s-default-model'), remove: vi.fn(async () => {}) },
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'heey-global/verity' },
      });

      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect((await ctx.store.getSession(sessionId))?.model).toBe('codex/default');
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('lets an explicit project spawn model override the project default model', async () => {
    await ctx.store.upsertProject({
      id: 'p-default-model-override',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await updateProjectSettings('p-default-model-override', { defaultModel: 'codex/default' });
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockResolvedValueOnce(
      '/data/dev/heey-global-verity/.verity-sessions/agent-default-model-override',
    );
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
      projectWorktrees: () => projectWorktrees,
      worktrees: {
        add: vi.fn(async () => '/wt/s-default-model-override'),
        remove: vi.fn(async () => {}),
      },
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: {
          prompt: 'go',
          project: 'heey-global/verity',
          model: 'claude-sonnet-4-6',
        },
      });

      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect((await ctx.store.getSession(sessionId))?.model).toBe('claude-sonnet-4-6');
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  describe('allowed agents', () => {
    const codexModels = ['codex/default', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra'];
    async function restrictedProjectServer(
      projectId: string,
      agents: ('claude' | 'codex' | 'opencode')[],
      listModels: () => Promise<string[]> = () => Promise.resolve(codexModels),
    ) {
      await ctx.store.updateVeritySettings({
        claudeCodeOauthCredentialsJson: '{"claudeAiOauth":{"accessToken":"claude-token"}}',
        codexAuthJson: '{"tokens":{"access_token":"codex"}}',
      });
      await ctx.store.upsertProject({
        id: projectId,
        owner: 'heey-global',
        repo: 'verity',
        containerName: 'dev-heey-global-verity',
        state: 'active',
      });
      await updateProjectSettings(projectId, { allowedAgents: agents });
      const projectWorktrees = fakeProjectWorktrees();
      const server = buildServer({
        eventStore: ctx.store,
        bus,
        conductor,
        provisioner: fakeProvisioner(),
        projectCloneRoot: '/data/dev',
        projectBackend: fakeProjectBackend,
        projectWorktrees: () => projectWorktrees,
        listModels,
        worktrees: { add: vi.fn(async () => '/wt/unused'), remove: vi.fn(async () => {}) },
      });
      return { server, projectWorktrees };
    }

    it.each(['empty', 'unavailable', 'claude-connected'])(
      'keeps the allowed Codex fallback when its catalog is %s',
      async (catalog) => {
        const { server } = await restrictedProjectServer(
          'p-agents-codex-fallback',
          ['codex'],
          async () => {
            if (catalog === 'unavailable') throw new Error('Catalog unavailable');
            return [];
          },
        );
        if (catalog !== 'claude-connected') {
          await ctx.store.updateVeritySettings({ claudeCodeOauthCredentialsJson: null });
        }
        try {
          const res = await server.inject({
            method: 'POST',
            url: '/sessions',
            payload: { project: 'heey-global/verity' },
          });
          expect(res.statusCode).toBe(201);
          expect(
            (await ctx.store.getSession(res.json<{ sessionId: string }>().sessionId))?.model,
          ).toBe('codex/default');
        } finally {
          await server.close();
        }
      },
    );

    it('rejects an explicit model whose agent the project excludes, before any worktree exists', async () => {
      const { server, projectWorktrees } = await restrictedProjectServer('p-agents-explicit', [
        'codex',
      ]);
      try {
        const res = await server.inject({
          method: 'POST',
          url: '/sessions',
          payload: { prompt: 'go', project: 'heey-global/verity', model: 'claude-sonnet-5-5' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'Claude is not allowed in this project.' });
        expect(projectWorktrees.add).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    });

    it('skips a remembered model on an excluded agent and starts on the first allowed model', async () => {
      const { server } = await restrictedProjectServer('p-agents-remembered', ['codex']);
      // The project's last session ran on Claude, which a spawn would otherwise reuse.
      await ctx.store.createSession({
        sessionId: 's-agents-remembered-prior',
        worktree: '/wt/prior',
        model: 'claude-opus-5-5',
        projectId: 'p-agents-remembered',
      });
      try {
        const res = await server.inject({
          method: 'POST',
          url: '/sessions',
          payload: { prompt: 'go', project: 'heey-global/verity' },
        });
        expect(res.statusCode).toBe(201);
        const { sessionId }: { sessionId: string } = res.json();
        expect((await ctx.store.getSession(sessionId))?.model).toBe('codex/gpt-5.6-sol');
      } finally {
        await server.close();
      }
    });

    it('fails instead of falling back when no allowed agent is connected', async () => {
      const { server, projectWorktrees } = await restrictedProjectServer('p-agents-none', [
        'opencode',
      ]);
      try {
        const res = await server.inject({
          method: 'POST',
          url: '/sessions',
          payload: { prompt: 'go', project: 'heey-global/verity' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json<{ error: string }>().error).toContain('No allowed agent is connected');
        expect(projectWorktrees.add).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    });
  });

  it('passes the project default branch into project worktree creation', async () => {
    await ctx.store.upsertProject({
      id: 'p-default-branch',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    await updateProjectSettings('p-default-branch', { defaultBranch: 'release/2026.06' });
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockResolvedValueOnce(
      '/data/dev/heey-global-verity/.verity-sessions/agent-default-branch',
    );
    const projectWorktreeFactory = vi.fn(() => projectWorktrees);
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
      projectWorktrees: projectWorktreeFactory,
      worktrees: { add: vi.fn(async () => '/wt/s-default-branch'), remove: vi.fn(async () => {}) },
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'heey-global/verity' },
      });

      expect(res.statusCode).toBe(201);
      expect(projectWorktreeFactory).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p-default-branch' }),
        '/data/dev/heey-global-verity',
        { baseBranch: 'release/2026.06', refreshBase: true },
      );
    } finally {
      await a.close();
    }
  });

  it('allows Codex models for active project spawns', async () => {
    await ctx.store.upsertProject({
      id: 'p-codex-spawn',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockResolvedValueOnce(
      '/data/dev/heey-global-verity/.verity-sessions/agent-codex-spawn',
    );
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
      projectWorktrees: () => projectWorktrees,
      worktrees: { add: vi.fn(async () => '/wt/s-codex-spawn'), remove: vi.fn(async () => {}) },
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'heey-global/verity', model: 'codex/default' },
      });

      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      const session = await ctx.store.getSession(sessionId);
      expect(session?.projectId).toBe('p-codex-spawn');
      expect(session?.model).toBe('codex/default');
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });

  it('rejects a project value that is an empty string with 400', async () => {
    const p = fakeProvisioner();
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: p,
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: '' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await a.close();
    }
  });

  it('normalises a URL-style project input (https://github.com/heey-global/verity)', async () => {
    await ctx.store.upsertProject({
      id: 'p-url',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const projectWorktrees = fakeProjectWorktrees();
    projectWorktrees.add.mockResolvedValueOnce(
      '/data/dev/heey-global-verity/.verity-sessions/agent-url',
    );
    const a = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: fakeProvisioner(),
      projectCloneRoot: '/data/dev',
      projectBackend: fakeProjectBackend,
      projectWorktrees: () => projectWorktrees,
      worktrees: { add: vi.fn(async () => '/wt/s-url'), remove: vi.fn(async () => {}) },
    });
    try {
      const res = await a.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'https://github.com/heey-global/verity' },
      });
      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      const session = await ctx.store.getSession(sessionId);
      expect(session?.projectId).toBe('p-url');
    } finally {
      await a.close();
    }
  });
});
