import { expect, it, vi } from 'vitest';
import { createSecretApprovalsClient } from './secretApprovals.js';

it('aborts a stalled history request and allows the next read', async () => {
  vi.useFakeTimers();
  try {
    const request = vi
      .fn()
      .mockReturnValueOnce(new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(new Response('{"requests":[]}'));
    const client = createSecretApprovalsClient(request);
    const failed = expect(client.list('s1')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(request).toHaveBeenNthCalledWith(
      1,
      '/sessions/s1/secret-approvals',
      expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
    );
    await expect(client.list('s1')).resolves.toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['first', undefined])('does not share a pending read from scope %s', async (initial) => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let scope = initial;
  const request = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(new Response('{"requests":[]}'));
  const client = createSecretApprovalsClient(request, () => scope);
  const previous = client.list('s1');
  const rejected = expect(previous).rejects.toThrow('identity changed');
  scope = 'second';
  await expect(client.list('s1')).resolves.toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
  finish(new Response('{"requests":[]}'));
  await rejected;
});

it('waits for a read predating reopen to settle before sending one fresh GET', async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const request = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(new Response())
    .mockResolvedValueOnce(new Response('{"requests":[]}'));
  const client = createSecretApprovalsClient(request);
  const before = client.list('s1');
  await client.reopen('s1', 'a1');
  const after = client.list('s1');
  const joined = client.list('s1');
  expect(request).toHaveBeenCalledTimes(2);
  finish(
    new Response(
      '{"requests":[{"id":"a1","toolName":"verity_secret_run","status":"denied","createdAt":"2026-11-20","decidedAt":null}]}',
    ),
  );
  expect(await Promise.all([before, after, joined])).toEqual([[], [], []]);
  expect(request).toHaveBeenCalledTimes(3);
});

it('shares only concurrent reads for the same session and retries after failure', async () => {
  let rejectRead!: (error: Error) => void;
  const pending = new Promise<Response>((_resolve, reject) => {
    rejectRead = reject;
  });
  const request = vi
    .fn()
    .mockResolvedValue(new Response('{"requests":[]}'))
    .mockReturnValueOnce(pending);
  const client = createSecretApprovalsClient(request);
  const first = client.list('s1');
  expect(client.list('s1')).toBe(first);
  await expect(client.list('s2')).resolves.toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
  rejectRead(new Error('offline'));
  await expect(first).rejects.toThrow('offline');
  request.mockResolvedValueOnce(new Response('{"requests":[]}'));
  await expect(client.list('s1')).resolves.toEqual([]);
  expect(request).toHaveBeenCalledTimes(3);
});

it('uses session-scoped authenticated paths and strips private history fields', async () => {
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          requests: [
            {
              id: 'a1',
              toolName: 'verity_http_request',
              status: 'denied',
              createdAt: '2026-11-20T00:00:00Z',
              decidedAt: null,
              canonicalInput: 'private',
              requestMac: 'private',
            },
          ],
        }),
      ),
  );
  const client = createSecretApprovalsClient(request);
  const history = await client.list('session/a');
  expect(request).toHaveBeenCalledWith(
    '/sessions/session%2Fa/secret-approvals',
    expect.objectContaining({ method: 'GET' }),
  );
  expect(history).toEqual([
    {
      id: 'a1',
      toolName: 'verity_http_request',
      status: 'denied',
      createdAt: '2026-11-20T00:00:00Z',
      decidedAt: null,
    },
  ]);
  await client.reopen('session/a', 'id/b');
  expect(request).toHaveBeenLastCalledWith('/sessions/session%2Fa/secret-approvals/id%2Fb/reopen', {
    method: 'POST',
  });
});
