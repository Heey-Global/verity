import type { EventStore } from '@verity/store';
import { expect, it, vi } from 'vitest';
import { createBackupAlertNotifier } from './alert-notifier.js';
import { BackupOperationalAlerts } from './operational-alerts.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('rechecks administrator authority after resolving devices and sends no private details', async () => {
  const store = {
    listActiveAdministratorIds: async () => ['admin', 'revoked'],
    listDevicePushTokensForUsers: async (ids: string[]) =>
      [
        {
          authTokenId: ids[0]!,
          userId: ids[0]!,
          expoToken: ids[0]!,
          platform: 'ios' as const,
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

it('persists per-device delivery across partial failure and restart, then resets a resolved episode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-partial-alert-'));
  const targets: string[] = [];
  let fail = true;
  const store = {
    listActiveAdministratorIds: async () => ['admin'],
    isActiveAdministrator: async () => true,
    listDevicePushTokensForUsers: async () =>
      ['first-private-token', 'second-private-token'].map((expoToken) => ({
        authTokenId: expoToken,
        userId: 'admin',
        expoToken,
        platform: 'ios' as const,
        createdAt: 0,
        updatedAt: 0,
      })),
  };
  const notify = createBackupAlertNotifier(store, {
    send: async (_message, tokens = []) => {
      targets.push(tokens[0]!.expoToken);
      if (tokens[0]!.expoToken === 'second-private-token' && fail) throw new Error('offline');
      return {
        targets: 1,
        ticketsAccepted: 1,
        ticketErrors: 0,
        receiptsQueued: 1,
        pruned: 0,
        transportErrors: 0,
      };
    },
  });
  try {
    let alerts = await BackupOperationalAlerts.open(root);
    alerts.setNotifier(notify);
    await expect(alerts.refresh(['insufficient-space'])).rejects.toThrow('offline');
    expect(await readFile(join(root, 'operational-alerts'), 'utf8')).not.toContain('private-token');
    alerts = await BackupOperationalAlerts.open(root);
    alerts.setNotifier(notify);
    fail = false;
    await alerts.refresh(['insufficient-space']);
    await alerts.refresh(['insufficient-space']);
    expect(targets).toEqual([
      'first-private-token',
      'second-private-token',
      'second-private-token',
    ]);
    await alerts.refresh([]);
    await alerts.refresh(['insufficient-space']);
    expect(targets.slice(3)).toEqual(['first-private-token', 'second-private-token']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
