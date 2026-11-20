import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '@verity/store';
import { createTestDb, truncateAll } from '@verity/store/testing';
import { Conductor } from './conductor.js';

let ctx: Awaited<ReturnType<typeof createTestDb>>;
let store: EventStore;
beforeAll(async () => {
  ctx = await createTestDb();
  store = new EventStore(ctx.db);
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await store.createSession({ sessionId: 's', worktree: '/wt/s', model: 'm' });
  await store.appendEvent('s', { t: 'session', id: 's', model: 'm', worktree: '/wt/s' });
});
afterAll(async () => ctx.close());
const request = {
  requestId: 'receipt',
  toolUseId: 'receipt',
  toolName: 'verity_http_request',
  input: { url: 'https://api.example.com' },
};

it('durably admits one continuation across conductor recreation and repeated refreshes', async () => {
  const run = vi.fn(async () => ({ sessionId: 's', exitCode: 0, stderr: '', aborted: false }));
  const create = () => new Conductor({ store, backend: { run }, worktreeExists: async () => true });
  const first = create();
  await first.resumeDetachedPermission('s', request, 'user', async () => true);
  await vi.waitFor(() => expect(first.isBusy('s')).toBe(false));
  expect(run).toHaveBeenCalledTimes(1);
  const restarted = create();
  await Promise.all(
    [1, 2, 3].map(() => restarted.resumeDetachedPermission('s', request, 'user', async () => true)),
  );
  await vi.waitFor(() => expect(restarted.isBusy('s')).toBe(false));
  expect(run).toHaveBeenCalledTimes(1);
  const prompts = (await store.getEvents('s')).filter((row) => row.t === 'prompt');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ initiatedBy: { userId: 'user' } });
});

it('revalidates deferred admission and preserves a reserved continuation for a later retry', async () => {
  const run = vi.fn(async () => ({ sessionId: 's', exitCode: 0, stderr: '', aborted: false }));
  const first = new Conductor({ store, backend: { run }, worktreeExists: async () => true });
  await first.resumeDetachedPermission('s', request, undefined, async () => false);
  expect(run).not.toHaveBeenCalled();
  const restarted = new Conductor({ store, backend: { run }, worktreeExists: async () => true });
  await restarted.resumeDetachedPermission('s', request, undefined, async () => true);
  await vi.waitFor(() => expect(restarted.isBusy('s')).toBe(false));
  expect(run).toHaveBeenCalledTimes(1);
});

it('keeps pending hydration readable when optional continuation recovery fails', async () => {
  const first = new Conductor({
    store,
    backend: { run: async () => ({ sessionId: 's', exitCode: 0, stderr: '', aborted: false }) },
    worktreeExists: async () => true,
  });
  first.configureDetachedPermissions({
    list: async () => [request],
    decide: async () => false,
    resumeApproved: async () => {
      throw new Error('backend unavailable');
    },
  });
  await expect(first.refreshDetachedPermissions('s')).resolves.toBeUndefined();
  await expect(first.refreshDetachedPermissions('s')).resolves.toBeUndefined();
  expect(first.pendingPermissions('s')).toEqual(['receipt']);
  const notices = (await store.getEvents('s')).filter((row) => row.t === 'notice');
  expect(notices).toHaveLength(1);
});
