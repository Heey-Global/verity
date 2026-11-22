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

it('keeps a saved decision and reports a failed automatic continuation', async () => {
  const emitEvent = vi.fn(async () => {});
  const reportError = vi.fn();
  const resumeError = new Error('Could not reserve dispatch');
  const request = {
    requestId: 'r',
    toolUseId: 'r',
    toolName: 'verity_http_request',
    input: {},
    secretSource: { project: 'example', config: 'stg' },
  };
  const lifecycle = new DetachedApprovalLifecycle(() => ({
    store: {} as EventStore,
    bus: undefined,
    emitEvent,
    persistScoped: async () => {},
    reportError,
    runWhenIdle: async () => {},
    dispatch: async () => ({ accepted: true }),
  }));
  lifecycle.configure({
    list: async () => [request],
    decide: async () => true,
    resumeApproved: async () => {
      throw resumeError;
    },
  });
  await lifecycle.refresh('s', async () => {});
  expect(
    await lifecycle.answer({
      sessionId: 's',
      toolUseId: 'r',
      decision: { behavior: 'allow' },
    }),
  ).toBe(true);
  expect(emitEvent).toHaveBeenNthCalledWith(1, 's', {
    t: 'secret_approval_decision',
    id: 'r',
    tool: request.toolName,
    input: request.input,
    secretSource: request.secretSource,
    decision: 'once',
  });
  expect(emitEvent).toHaveBeenNthCalledWith(
    2,
    's',
    expect.objectContaining({
      t: 'notice',
      text: expect.stringContaining('could not resume'),
    }),
  );
  expect(reportError).toHaveBeenCalledWith('s', resumeError);
});
