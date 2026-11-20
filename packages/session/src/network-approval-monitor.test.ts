import { afterEach, expect, it, vi } from 'vitest';
import type { EgressPolicy } from '@verity/store';

import { monitorNetworkApprovals } from './network-approval-monitor.js';

const policy = (): EgressPolicy => ({
  revision: 0,
  grants: [],
  requests: {
    target: {
      id: 'r1',
      target: { host: 'example.com', protocol: 'tcp', port: 443 },
      revision: 0,
      requestedBy: ['sandbox'],
      createdAt: 0,
      expiresAt: null,
      status: 'pending',
    },
  },
});
afterEach(() => vi.useRealTimers());

it('reports pending approval rather than DNS failure, then delivers the decision once', async () => {
  vi.useFakeTimers();
  const state = policy();
  const notify = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
  const stop = monitorNetworkApprovals({ read: async () => state, notify });
  await vi.advanceTimersByTimeAsync(0);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[0]).toContain('example.com TCP 443: pending');
  expect(notify.mock.calls[0]?.[0]).toContain('not describe pending approval as a final failure');
  await vi.advanceTimersByTimeAsync(3000);
  expect(notify).toHaveBeenCalledTimes(1);
  state.requests.target!.status = 'allowed';
  await vi.advanceTimersByTimeAsync(3000);
  expect(notify.mock.calls[1]?.[0]).toContain('example.com TCP 443: allowed');
  stop();
  await vi.advanceTimersByTimeAsync(30000);
  expect(notify).toHaveBeenCalledTimes(2);
});

it('retries failed delivery and reports denial and policy changes without granting access', async () => {
  vi.useFakeTimers();
  const state = policy();
  const notify = vi
    .fn<(text: string) => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  const stop = monitorNetworkApprovals({ read: async () => state, notify });
  await vi.advanceTimersByTimeAsync(3000);
  expect(notify).toHaveBeenCalledTimes(2);
  state.revision++;
  await vi.advanceTimersByTimeAsync(3000);
  expect(notify.mock.calls[2]?.[0]).toContain('needs review after policy change');
  state.requests.target!.status = 'denied';
  await vi.advanceTimersByTimeAsync(3000);
  expect(notify.mock.calls[3]?.[0]).toContain('denied');
  expect(state.grants).toEqual([]);
  stop();
});

it('does not notify a settled turn when a pending read finishes late', async () => {
  vi.useFakeTimers();
  let resolve!: (policy: EgressPolicy) => void;
  const read = vi.fn(
    () =>
      new Promise<EgressPolicy>((done) => {
        resolve = done;
      }),
  );
  const notify = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
  const stop = monitorNetworkApprovals({ read, notify });
  stop();
  resolve(policy());
  await vi.advanceTimersByTimeAsync(30000);
  expect(notify).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

it('checks immediately after a tool finishes and unsubscribes when the turn ends', async () => {
  vi.useFakeTimers();
  let state: EgressPolicy = { revision: 0, grants: [], requests: {} };
  let check!: () => void;
  const unsubscribe = vi.fn();
  const notify = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
  const stop = monitorNetworkApprovals({
    read: async () => state,
    notify,
    subscribe: (listener) => {
      check = listener;
      return unsubscribe;
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  state = policy();
  check();
  await vi.advanceTimersByTimeAsync(0);
  expect(notify).toHaveBeenCalledTimes(1);
  stop();
  check();
  await vi.advanceTimersByTimeAsync(30000);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledTimes(1);
});

it('delivers overflow pending requests and decisions in subsequent batches', async () => {
  vi.useFakeTimers();
  const state = policy();
  const template = state.requests.target!;
  state.requests = Object.fromEntries(
    Array.from({ length: 45 }, (_, index) => [
      `r${index}`,
      {
        ...template,
        id: `r${index}`,
        target: { ...template.target, host: `host${index}.example` },
      },
    ]),
  );
  const notify = vi.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
  const stop = monitorNetworkApprovals({ read: async () => state, notify });
  await vi.advanceTimersByTimeAsync(6000);
  expect(notify).toHaveBeenCalledTimes(3);
  for (const request of Object.values(state.requests)) {
    expect(notify.mock.calls.map(([text]) => text).join('\n')).toContain(
      `${request.target.host} TCP 443: pending`,
    );
    request.status = 'allowed';
  }
  await vi.advanceTimersByTimeAsync(9000);
  expect(notify).toHaveBeenCalledTimes(6);
  for (const request of Object.values(state.requests))
    expect(notify.mock.calls.map(([text]) => text).join('\n')).toContain(
      `${request.target.host} TCP 443: allowed`,
    );
  stop();
});
