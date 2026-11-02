import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';
import { startPullRequestReadyMonitor } from './pr-ready-push.js';
import type { PullRequestStatus } from './forge-provider.js';
import { createPushRouter, type PushRouteOutcome, type PushRouter } from './push-router.js';
import { createPushSender, type ExpoPushTransport } from './push-sender.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
});
afterAll(async () => {
  await ctx.close();
});

it('bounds rejected deliveries across polls and monitor restarts using durable claims', async () => {
  const session = {
    sessionId: 'bounded',
    worktree: '/wt/bounded',
    model: 'm',
    name: null,
    projectId: null,
    lastSeenEventCount: null,
  };
  await ctx.store.createSession(session);
  let head = 'a';
  let outcome: PushRouteOutcome = 'failed';
  const sendTickets = vi.fn<ExpoPushTransport['sendPushNotificationsAsync']>(async () =>
    outcome === 'delivered'
      ? [{ status: 'ok', id: 'receipt' }]
      : [{ status: 'error', message: 'rejected', details: { error: 'MessageRateExceeded' } }],
  );
  const transport: ExpoPushTransport = {
    chunkPushNotifications: (messages) => [messages],
    sendPushNotificationsAsync: sendTickets,
    chunkPushNotificationReceiptIds: (ids) => [ids],
    getPushNotificationReceiptsAsync: async () => ({}),
  };
  const token = {
    expoToken: 'ExpoPushToken[test]',
    authTokenId: 'device',
    platform: 'ios' as const,
    createdAt: 0,
    updatedAt: 0,
    userId: 'user',
  };
  const sender = createPushSender({
    transport,
    now: () => Date.now(),
    store: {
      listDevicePushTokens: async () => [token],
      deleteDevicePushToken: async () => false,
      enqueuePushReceipt: async () => false,
      listDuePushReceipts: async () => [],
      reschedulePushReceipt: async () => false,
      deletePushReceipt: async () => false,
    },
  });
  const router = createPushRouter({
    sender,
    presence: {
      isViewing: () => false,
      foregroundDevices: () => new Set(),
      deliverAlert: () => new Set(),
    },
    store: {
      getSession: async () => session,
      listActiveAdministratorIds: async () => ['user'],
      listProjectUserIds: async () => ['user'],
      listDevicePushTokensForUsers: async () => [token],
    },
  });
  const notify = vi.fn<PushRouter['notify']>((input) =>
    outcome === 'failed' || outcome === 'delivered'
      ? router.notify(input)
      : Promise.resolve(outcome),
  );
  const makeMonitor = () =>
    startPullRequestReadyMonitor({
      router: { notify },
      listSessions: async () => [session],
      statusFor: async () =>
        ({
          number: 1,
          title: 'ready',
          phase: 'open',
          pipeline: 'success',
          mergeable: true,
          headSha: head,
        }) as PullRequestStatus,
      wasSent: (id, marker) => ctx.store.hasSessionAutomationMarker(id, marker),
      markSent: (id, marker) => ctx.store.markSessionAutomation(id, marker),
      claimAttempt: (id, marker, now) => ctx.store.claimPrReadyDelivery(id, marker, now),
      finishAttempt: (id, marker, claim, result, now) =>
        ctx.store.finishPrReadyDelivery(id, marker, claim, result, now),
      describeSession: async () => ({}),
      pollMs: 86_400_000,
    });
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000_000);
    let monitor = makeMonitor();
    await monitor.runOnce();
    for (let i = 0; i < 20; i++) await monitor.runOnce();
    expect(notify).toHaveBeenCalledTimes(1);
    await monitor.stop();
    monitor = makeMonitor();
    vi.setSystemTime(1_060_000);
    await monitor.runOnce();
    expect(notify).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_359_999);
    await monitor.runOnce();
    expect(notify).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_360_000);
    await monitor.runOnce();
    expect(notify).toHaveBeenCalledTimes(3);
    await monitor.stop();
    monitor = makeMonitor();
    vi.setSystemTime(90_000_000);
    await monitor.runOnce();
    expect(notify).toHaveBeenCalledTimes(3);
    expect(sendTickets).toHaveBeenCalledTimes(3);
    // Neither an empty route nor a sender cooldown spends the new head's budget.
    head = 'b';
    for (const result of ['undelivered', 'deferred', 'deferred', 'undelivered'] as const) {
      outcome = result;
      await monitor.runOnce();
      vi.setSystemTime(Date.now() + 30_000);
    }
    outcome = 'delivered';
    await monitor.runOnce();
    expect(notify).toHaveBeenCalledTimes(8);
    await monitor.runOnce();
    expect(notify).toHaveBeenCalledTimes(8);
    await monitor.stop();
    expect(sendTickets).toHaveBeenCalledTimes(4);
  } finally {
    router.close();
    await sender.close();
    vi.useRealTimers();
  }
});

it('claims atomically, fences expired senders and charges interrupted sends', async () => {
  await ctx.store.createSession({ sessionId: 'claims', worktree: '/wt/claims', model: 'm' });
  const claims = await Promise.all(
    [1, 2].map(() => ctx.store.claimPrReadyDelivery('claims', 'marker', 0)),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await ctx.store.claimPrReadyDelivery('claims', 'marker', 60_000)).toBeUndefined();
  const next = await ctx.store.claimPrReadyDelivery('claims', 'marker', 300_000);
  expect(next).toBeDefined();
  await ctx.store.finishPrReadyDelivery(
    'claims',
    'marker',
    claims.find(Boolean)!,
    'unattempted',
    300_000,
  );
  await ctx.store.finishPrReadyDelivery('claims', 'marker', next!, 'failed', 300_000);
  expect(await ctx.store.claimPrReadyDelivery('claims', 'marker', 600_000)).toBeDefined();
  expect(await ctx.store.claimPrReadyDelivery('claims', 'marker', 900_000)).toBeUndefined();
});
