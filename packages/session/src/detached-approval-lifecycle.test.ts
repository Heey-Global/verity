import { expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import { DetachedApprovalLifecycle } from './detached-approval-lifecycle.js';

it('persists detached reusable consent for the person answering the card', async () => {
  const persistScoped = vi.fn(async () => {});
  const decide = vi.fn(async () => true);
  const lifecycle = new DetachedApprovalLifecycle(() => ({
    store: {} as EventStore,
    bus: undefined,
    emitEvent: async () => {},
    persistScoped,
    reportError: () => {},
    runWhenIdle: async () => {},
    dispatch: async () => ({ accepted: true }),
  }));
  const request = { requestId: 'r', toolUseId: 'r', toolName: 'verity_http_request', input: {} };
  lifecycle.configure({ list: async () => [request], decide });
  await lifecycle.refresh('s', async () => {});
  await lifecycle.answer({
    sessionId: 's',
    toolUseId: 'r',
    decision: { behavior: 'allow' },
    options: { scope: 'project', actorId: 'old-actor', decidedByUser: 'answering-person' },
  });
  expect(decide).toHaveBeenCalledWith(
    's',
    'r',
    { behavior: 'allow' },
    'answering-person',
    'project',
  );
  expect(persistScoped).toHaveBeenCalledWith('s', request, 'project', 'answering-person');
});
