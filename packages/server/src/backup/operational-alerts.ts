import { join } from 'node:path';
import { z } from 'zod';
import { readBounded, writeDurable } from './repository.js';

export const backupAlertMessages = {
  'stale-backup': 'No recent backup. Check the destination and run a backup.',
  'consecutive-failures':
    'Backups failed repeatedly. Check the destination and available disk space.',
  'destination-unavailable':
    'Backup destination or marker is unavailable. Restore the configured mount and marker.',
  'destination-unwritable':
    'Backup destination is not writable. Check its permissions and mount options.',
  'insufficient-space':
    'The next backup may not fit. Free disk space or explicitly delete old snapshots.',
  'identity-unreadable':
    'Backup identity files are unavailable or inconsistent. Repair the installation identity.',
  'probe-overdue': 'Backup recovery has not been verified recently. Run a restore probe.',
  'maintenance-failed':
    'Backup maintenance needs attention. Repair repository references before pruning.',
} as const;
export type BackupAlert = keyof typeof backupAlertMessages;
interface BackupAlertDelivery {
  delivered: ReadonlySet<string>;
  confirm(recipient: string): Promise<void>;
}
export type BackupAlertNotifier = (
  code: BackupAlert,
  delivery?: BackupAlertDelivery,
) => Promise<boolean>;
const code = z.enum(Object.keys(backupAlertMessages) as [BackupAlert, ...BackupAlert[]]);
const schema = z
  .object({
    format: z.literal(1),
    requiredBytes: z.string().regex(/^(0|[1-9][0-9]{0,39})$/),
    active: z.array(code).max(16),
    notified: z.array(code).max(16),
    deliveries: z
      .array(z.object({ code, recipient: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .max(4096)
      .default([]),
    maintenanceFailed: z.boolean(),
  })
  .strict();

/** Only fixed public codes are durable or sent; exception messages and file contents never escape. */
export class BackupOperationalAlerts {
  private state: z.infer<typeof schema> = {
    format: 1,
    requiredBytes: '0',
    active: [],
    notified: [],
    deliveries: [],
    maintenanceFailed: false,
  };
  private tail: Promise<unknown> = Promise.resolve();
  private notify: BackupAlertNotifier | undefined;
  private constructor(private readonly path: string) {}
  static async open(root: string): Promise<BackupOperationalAlerts> {
    const alerts = new BackupOperationalAlerts(join(root, 'operational-alerts'));
    try {
      alerts.state = schema.parse(JSON.parse((await readBounded(alerts.path, 1048576)).toString()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return alerts;
  }
  setNotifier(notify: BackupAlertNotifier): void {
    this.notify = notify;
  }
  status(): BackupAlert[] {
    return [...this.state.active];
  }
  requiredBytes(): bigint {
    return BigInt(this.state.requiredBytes);
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const work = this.tail.then(action);
    this.tail = work.catch(() => undefined);
    return work;
  }
  async estimate(bytes: bigint): Promise<void> {
    await this.serialized(async () => {
      this.state.requiredBytes = schema.shape.requiredBytes.parse(String(bytes));
      await this.save();
    });
  }
  async maintenanceFailed(failed: boolean): Promise<void> {
    await this.serialized(async () => {
      this.state.maintenanceFailed = failed;
      await this.save();
    });
  }
  async refresh(codes: readonly string[]): Promise<void> {
    await this.serialized(async () => {
      const active = new Set<BackupAlert>(codes.map((value) => code.parse(value)));
      if (this.state.maintenanceFailed) active.add('maintenance-failed');
      this.state.active = [...active].sort();
      this.state.notified = this.state.notified.filter((value) => active.has(value));
      this.state.deliveries = this.state.deliveries.filter((value) => active.has(value.code));
      await this.save();
      for (const value of this.state.active) {
        if (this.state.notified.includes(value) || !this.notify) continue;
        const delivered = new Set(
          this.state.deliveries
            .filter((entry) => entry.code === value)
            .map((entry) => entry.recipient),
        );
        if (
          await this.notify(value, {
            delivered,
            confirm: async (recipient) => {
              if (delivered.has(recipient)) return;
              const entries = schema.shape.deliveries.parse([
                ...this.state.deliveries,
                { code: value, recipient },
              ]);
              this.state.deliveries = entries;
              await this.save();
              delivered.add(recipient);
            },
          })
        ) {
          this.state.notified.push(value);
          await this.save();
        }
      }
    });
  }
  private async save(): Promise<void> {
    await writeDurable(this.path, Buffer.from(JSON.stringify(this.state)), false);
  }
}
