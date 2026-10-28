import type { EventStore } from '@verity/store';
import { expect, it, vi } from 'vitest';
import { createBackupAlertNotifier } from './alert-notifier.js';

it('rechecks administrator authority after resolving devices and sends no private details', async () => {
  const store = {
    listActiveAdministratorIds: async () => ['admin', 'revoked'],
    listDevicePushTokensForUsers: async (ids: string[]) =>
      [
        {
          authTokenId: ids[0]!,
          userId: ids[0]!,
          expoToken: ids[0]!,
          platform: 'ios',
          createdAt: 0,
          updatedAt: 0,
        },
      ] satisfies Awaited<ReturnType<EventStore['listDevicePushTokensForUsers']>>,
    isActiveAdministrator: vi.fn(async (id: string) => id === 'admin'),
  };
  const send = vi.fn(async () => ({
    targets: 1,
    ticketsAccepted: 1,
    ticketErrors: 0,
    receiptsQueued: 1,
    pruned: 0,
    transportErrors: 0,
  }));
  expect(await createBackupAlertNotifier(store, { send })('identity-unreadable')).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toMatchObject([
    { data: { type: 'backup-alert', code: 'identity-unreadable' } },
    [{ expoToken: 'admin' }],
  ]);
  expect(await createBackupAlertNotifier(store, undefined)('identity-unreadable')).toBe(false);
});
