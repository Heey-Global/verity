import { randomUUID } from 'node:crypto';
import { confirmRecoveryKey, generateBackupKeys, type BackupHostKeys } from './crypto.js';
const SETUP_LIFETIME_MS = 10 * 60 * 1000;

/** One in-memory setup candidate. Only its public recipient and host signing keys survive confirmation. */
export class BackupSetup {
  private pending: { id: string; expiresAt: number; host: BackupHostKeys } | undefined;
  private busy = false;
  constructor(
    private readonly configured: () => Promise<boolean>,
    private readonly now: () => number = Date.now,
  ) {}
  async begin(): Promise<{ id: string; recoveryKey: string; expiresAt: number }> {
    if (this.busy) throw new Error('Backup setup is already in progress');
    this.busy = true;
    try {
      if (await this.configured()) throw new Error('Backups are already configured');
      const { host, recoveryKey } = await generateBackupKeys();
      const candidate = { id: randomUUID(), host, expiresAt: this.now() + SETUP_LIFETIME_MS };
      this.pending = candidate;
      return { id: candidate.id, recoveryKey, expiresAt: candidate.expiresAt };
    } finally {
      this.busy = false;
    }
  }
  cancel(): void {
    if (this.busy) throw new Error('Backup setup is already in progress');
    this.pending = undefined;
  }
  async confirm(
    id: string,
    recoveryKey: string,
    commit: (host: BackupHostKeys) => Promise<void>,
  ): Promise<void> {
    if (this.busy) throw new Error('Backup setup is already in progress');
    this.busy = true;
    try {
      const candidate = this.pending;
      if (!candidate || candidate.id !== id || this.now() >= candidate.expiresAt) {
        this.pending = undefined;
        throw new Error('Backup setup expired; start again');
      }
      if (await this.configured()) throw new Error('Backups are already configured');
      await confirmRecoveryKey(recoveryKey, candidate.host);
      await commit(candidate.host);
      this.pending = undefined;
    } finally {
      this.busy = false;
    }
  }
}
