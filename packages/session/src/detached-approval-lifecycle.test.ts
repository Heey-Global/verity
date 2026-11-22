import { expect, it, vi } from 'vitest';
import { DetachedApprovalLifecycle } from './detached-approval-lifecycle.js';

it('persists detached reusable consent for the person answering the card', async () => {
  const persistScoped = vi.fn(async () => {});
  const decide = vi.fn(async () => true);
  const lifecycle = new DetachedApprovalLifecycle(() => ({
    store: { appendEvent: async () => ({ seq: 1, ts: 1 }), reserveBackgroundDispatch: vi.fn() },
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
  const appendEvent = vi.fn(async () => ({ seq: 1, ts: 1 }));
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
    store: { appendEvent, reserveBackgroundDispatch: vi.fn() },
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
  expect(appendEvent).toHaveBeenCalledWith('s', {
    t: 'notice',
    role: 'agent',
    text: 'Secret request allowed once.',
    secretApproval: {
      id: 'r',
      tool: request.toolName,
      input: request.input,
      secretSource: request.secretSource,
      decision: 'once',
    },
  });
  expect(emitEvent).toHaveBeenNthCalledWith(
    1,
    's',
    expect.objectContaining({
      t: 'notice',
      text: expect.stringContaining('could not resume'),
    }),
  );
  expect(reportError).toHaveBeenCalledWith('s', resumeError);
});

it('retries a failed decision card write when the session is refreshed', async () => {
  const appendEvent = vi.fn(async () => ({ seq: 1, ts: 1 }));
  appendEvent.mockRejectedValueOnce(new Error('temporary write failure'));
  const emitEvent = vi.fn(async () => {});
  let pending = true;
  const request = { requestId: 'r', toolUseId: 'r', toolName: 'verity_http_request', input: {} };
  const lifecycle = new DetachedApprovalLifecycle(() => ({
    store: { appendEvent, reserveBackgroundDispatch: vi.fn() },
    bus: undefined,
    emitEvent,
    persistScoped: async () => {},
    reportError: () => {},
    runWhenIdle: async () => {},
    dispatch: async () => ({ accepted: true }),
  }));
  lifecycle.configure({
    list: async () => (pending ? [request] : []),
    decide: async () => {
      pending = false;
      return true;
    },
  });
  await lifecycle.refresh('s', async () => {});
  expect(
    await lifecycle.answer({ sessionId: 's', toolUseId: 'r', decision: { behavior: 'allow' } }),
  ).toBe(true);
  expect(emitEvent).toHaveBeenCalledWith(
    's',
    expect.objectContaining({
      text: expect.stringContaining('chat card could not be saved yet'),
    }),
  );
  await lifecycle.refreshForSession('s');
  await lifecycle.refreshForSession('s');
  expect(appendEvent).toHaveBeenCalledTimes(2);
  expect(appendEvent.mock.calls[1]).toEqual(appendEvent.mock.calls[0]);
});
