import type { EventStore } from '@verity/store';
import { createHash } from 'node:crypto';
import type { PushSender } from '../push-sender.js';
import { backupAlertMessages, type BackupAlertNotifier } from './operational-alerts.js';

type Recipients = Pick<
  EventStore,
  'listActiveAdministratorIds' | 'isActiveAdministrator' | 'listDevicePushTokensForUsers'
>;
export function createBackupAlertNotifier(
  store: Recipients,
  sender: Pick<PushSender, 'send'> | undefined,
): BackupAlertNotifier {
  return async (code, delivery) => {
    if (!sender) return false;
    let delivered = false;
    for (const userId of await store.listActiveAdministratorIds()) {
      const tokens = await store.listDevicePushTokensForUsers([userId]);
      // Recheck after resolving devices: a queued alert grants no enduring administrator authority.
      if (!tokens.length || !(await store.isActiveAdministrator(userId))) continue;
      for (const token of tokens) {
        if (!(await store.isActiveAdministrator(userId))) break;
        const recipient = createHash('sha256')
          .update(JSON.stringify([userId, token.authTokenId, token.expoToken]))
          .digest('hex');
        if (delivery?.delivered.has(recipient)) {
          delivered = true;
          continue;
        }
        const result = await sender.send(
          {
            title: 'Backup needs attention',
            body: backupAlertMessages[code],
            categoryId: 'BACKUP_ALERT',
            data: { type: 'backup-alert', code },
            sound: 'default',
          },
          [token],
        );
        if (result.transportErrors || result.ticketErrors)
          throw new Error('Backup alert delivery failed');
        delivered ||= result.ticketsAccepted > 0;
        if (result.ticketsAccepted > 0) await delivery?.confirm(recipient);
      }
    }
    return delivered;
  };
}
