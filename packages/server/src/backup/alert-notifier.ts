import type { EventStore } from '@verity/store';
import type { PushSender } from '../push-sender.js';
import { backupAlertMessages, type BackupAlert } from './operational-alerts.js';

type Recipients = Pick<
  EventStore,
  'listActiveAdministratorIds' | 'isActiveAdministrator' | 'listDevicePushTokensForUsers'
>;
export function createBackupAlertNotifier(
  store: Recipients,
  sender: Pick<PushSender, 'send'> | undefined,
): (code: BackupAlert) => Promise<boolean> {
  return async (code) => {
    if (!sender) return false;
    let delivered = false;
    for (const userId of await store.listActiveAdministratorIds()) {
      const tokens = await store.listDevicePushTokensForUsers([userId]);
      // Recheck after resolving devices: a queued alert grants no enduring administrator authority.
      if (!tokens.length || !(await store.isActiveAdministrator(userId))) continue;
      const result = await sender.send(
        {
          title: 'Backup needs attention',
          body: backupAlertMessages[code],
          categoryId: 'BACKUP_ALERT',
          data: { type: 'backup-alert', code },
          sound: 'default',
        },
        tokens,
      );
      if (result.transportErrors || result.ticketErrors)
        throw new Error('Backup alert delivery failed');
      delivered ||= result.ticketsAccepted > 0;
    }
    return delivered;
  };
}
