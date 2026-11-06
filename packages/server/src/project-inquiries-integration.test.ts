import { Conductor } from '@verity/session';
import { createTestDb } from '@verity/store/testing';
import { expect, it, vi } from 'vitest';
import { createProjectInquiries } from './project-inquiries.js';

it('admits requests and answers through real durable conductor receipts exactly once', async () => {
  const ctx = await createTestDb();
  const run = vi.fn(async (opts: { storeSessionId?: string }) => ({
    sessionId: opts.storeSessionId,
    exitCode: 0,
    stderr: '',
    aborted: false,
  }));
  const conductor = new Conductor({
    store: ctx.store,
    backend: { run },
    worktreeExists: async () => true,
  });
  try {
    for (const id of ['source', 'target'])
      await ctx.store.createProject({
        id,
        owner: 'team',
        repo: id,
        containerName: id,
        state: 'active',
      });
    await ctx.store.createSession({
      sessionId: 'source',
      projectId: 'source',
      worktree: '/wt/source',
      model: 'm',
    });
    await ctx.store.projectInquiries.setGrant('source', 'target', true);
    const service = createProjectInquiries({
      store: ctx.store,
      authorized: async () => true,
      busy: (id) => conductor.isBusy(id),
      createSession: async (projectId, sessionId) => {
        await ctx.store.createSession({ sessionId, projectId, worktree: '/wt/target', model: 'm' });
      },
      dispatch: async (inquiry, validate) =>
        (
          await conductor.dispatchTurnWhenIdle(
            inquiry.targetSessionId,
            inquiry.body,
            {},
            { durableDispatchId: `project-inquiry:${inquiry.id}`, validateSession: validate },
          )
        ).accepted,
      reply: async (inquiry, validate) =>
        (
          await conductor.dispatchTurnWhenIdle(
            inquiry.sourceSessionId,
            inquiry.answer!,
            {},
            {
              durableDispatchId: `project-inquiry-answer:${inquiry.id}`,
              validateSession: validate,
            },
          )
        ).accepted,
    });
    const input = {
      requestId: 'one',
      targetProjectId: 'target',
      title: 'Inspect',
      body: 'Question',
      kind: 'question',
    };
    const inquiry = await service.request('source', null, input);
    expect(inquiry.status).toBe('queued');
    await vi.waitFor(() => expect(conductor.isBusy(inquiry.targetSessionId)).toBe(false));
    expect(run).toHaveBeenCalledTimes(1);
    expect((await ctx.store.repairs.dispatchReceipt(`project-inquiry:${inquiry.id}`))?.state).toBe(
      'admitted',
    );
    await service.request('source', null, input);
    await service.answer(inquiry.targetSessionId, inquiry.id, 'Answer');
    await vi.waitFor(() => expect(conductor.isBusy('source')).toBe(false));
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      (await ctx.store.repairs.dispatchReceipt(`project-inquiry-answer:${inquiry.id}`))?.state,
    ).toBe('admitted');
    await service.recover();
    expect(run).toHaveBeenCalledTimes(2);
    expect(await ctx.store.projectInquiries.unansweredDeliveries()).toEqual([]);
  } finally {
    await ctx.close();
  }
});
