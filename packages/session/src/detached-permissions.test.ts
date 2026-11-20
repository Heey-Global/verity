import { expect, it, vi } from 'vitest';
import { DetachedPermissions, type DetachedPermissionProvider } from './detached-permissions.js';

it('restores an unanswered card after restart and keeps its descriptor across turns', async () => {
  const request = {
    requestId: 'receipt',
    toolUseId: 'receipt',
    toolName: 'verity_http_request',
    input: { url: 'https://api.example.com' },
  };
  let pending = true;
  const decide = vi.fn(async () => {
    pending = false;
    return true;
  });
  const provider: DetachedPermissionProvider = {
    list: async () => (pending ? [request] : []),
    decide,
  };
  const publish = vi.fn(async () => {});
  const first = new DetachedPermissions();
  first.configure(provider);
  await first.refresh('session', publish);
  expect(first.ids('session')).toEqual(['receipt']);
  // No caller promise or running turn needs to survive a server restart.
  const restarted = new DetachedPermissions();
  restarted.configure(provider);
  await restarted.refresh('session', publish);
  await restarted.refresh('session', publish);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(restarted.descriptors('session')).toEqual([
    {
      toolUseId: 'receipt',
      tool: 'verity_http_request',
      riskClass: 'ask',
      grantChannel: 'acp',
      detached: true,
      input: request.input,
    },
  ]);
  expect(
    await restarted.decide('session', 'receipt', { behavior: 'allow' }, 'user', 'once'),
  ).toEqual(request);
  expect(decide).toHaveBeenCalledWith('session', 'receipt', { behavior: 'allow' }, 'user', 'once');
  expect(restarted.ids('session')).toEqual([]);
  expect(
    await restarted.decide('session', 'receipt', { behavior: 'allow' }, 'user', 'once'),
  ).toBeUndefined();
});

it('does not dismiss a durable card when a decision fails', async () => {
  const pending = new DetachedPermissions();
  pending.configure({
    list: async () => [
      { requestId: 'r', toolUseId: 'r', toolName: 'verity_secret_run', input: {} },
    ],
    decide: async () => false,
  });
  await pending.refresh('s', async () => {});
  expect(
    await pending.decide('s', 'r', { behavior: 'deny', message: 'no' }, 'user', 'once'),
  ).toBeUndefined();
  expect(pending.ids('s')).toEqual(['r']);
});

it.each(['allow', 'deny'] as const)(
  'resumes only an approved detached workflow (%s)',
  async (behavior) => {
    const { decideDetachedPermission, detachedContinuation } =
      await import('./detached-permissions.js');
    const permissions = new DetachedPermissions();
    const request = {
      requestId: 'r',
      toolUseId: 'r',
      toolName: 'verity_http_request',
      input: { url: 'https://api.example.com' },
    };
    permissions.configure({ list: async () => [request], decide: async () => true });
    await permissions.refresh('s', async () => {});
    const resume = vi.fn(async () => {});
    expect(
      await decideDetachedPermission({
        permissions,
        sessionId: 's',
        toolUseId: 'r',
        decision: behavior === 'allow' ? { behavior } : { behavior, message: 'No' },
        options: { actorId: 'user' },
        persistScoped: async () => {},
        notice: async () => {},
        resume,
      }),
    ).toBe(true);
    expect(resume).toHaveBeenCalledTimes(behavior === 'allow' ? 1 : 0);
    if (behavior === 'allow') expect(resume).toHaveBeenCalledWith(request, 'user');
    const first = detachedContinuation(request, 'user');
    expect(first.dispatch).toMatchObject({
      durableDispatchId: 'secret-approval:r',
      initiatedBy: { userId: 'user' },
    });
    expect(detachedContinuation(request, 'user').dispatch).toEqual(first.dispatch);
    expect(first.prompt).toContain('untrusted reference material');
  },
);

it('closes exact consent before saving reusable scope and never resumes a failed scope save', async () => {
  const { decideDetachedPermission } = await import('./detached-permissions.js');
  const permissions = new DetachedPermissions();
  const order: string[] = [];
  permissions.configure({
    list: async () => [
      { requestId: 'r', toolUseId: 'r', toolName: 'verity_secret_run', input: {} },
    ],
    decide: async () => true,
    completeScoped: async () => {
      order.push('close-once');
    },
  });
  await permissions.refresh('s', async () => {});
  const resume = vi.fn(async () => {});
  const notice = vi.fn(async () => {});
  const onScopeSaved = vi.fn();
  await decideDetachedPermission({
    permissions,
    sessionId: 's',
    toolUseId: 'r',
    decision: { behavior: 'allow' },
    options: { actorId: 'user', scope: 'project', onScopeSaved },
    persistScoped: async () => {
      order.push('save-scope');
      throw new Error('database unavailable');
    },
    notice,
    resume,
  });
  expect(order).toEqual(['close-once', 'save-scope']);
  expect(onScopeSaved).toHaveBeenCalledWith(false);
  expect(notice).toHaveBeenCalledWith(expect.stringContaining('Nothing ran'));
  expect(resume).not.toHaveBeenCalled();
});

it('reports an active saved grant if continuation bookkeeping fails without denying consent', async () => {
  const { decideDetachedPermission } = await import('./detached-permissions.js');
  const permissions = new DetachedPermissions();
  const failScoped = vi.fn(async () => {});
  permissions.configure({
    list: async () => [
      { requestId: 'r', toolUseId: 'r', toolName: 'verity_secret_run', input: {} },
    ],
    decide: async () => true,
    completeScoped: async () => {},
    markScopedSaved: async () => {
      throw new Error('database unavailable');
    },
    failScoped,
  });
  await permissions.refresh('s', async () => {});
  const persistScoped = vi.fn(async () => {});
  const notice = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const onScopeSaved = vi.fn();
  await decideDetachedPermission({
    permissions,
    sessionId: 's',
    toolUseId: 'r',
    decision: { behavior: 'allow' },
    options: { actorId: 'user', scope: 'project', onScopeSaved },
    persistScoped,
    notice,
    resume,
  });
  expect(persistScoped).toHaveBeenCalledOnce();
  expect(onScopeSaved).toHaveBeenCalledWith(true);
  expect(failScoped).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(notice).toHaveBeenCalledWith(expect.stringContaining('saved and remains active'));
});
