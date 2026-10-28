import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { BackupOperationalAlerts } from './operational-alerts.js';

it('persists sanitized alert episodes, retries delivery and clears resolved conditions across restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-alerts-'));
  try {
    let alerts = await BackupOperationalAlerts.open(root);
    const notify = vi.fn(async () => true);
    alerts.setNotifier(notify);
    await alerts.estimate(1000n);
    await alerts.refresh(['insufficient-space']);
    await alerts.refresh(['insufficient-space']);
    expect(notify).toHaveBeenCalledTimes(1);
    alerts = await BackupOperationalAlerts.open(root);
    alerts.setNotifier(notify);
    expect(alerts.requiredBytes()).toBe(1000n);
    expect(alerts.status()).toEqual(['insufficient-space']);
    await alerts.refresh(['insufficient-space']);
    expect(notify).toHaveBeenCalledTimes(1);
    await alerts.refresh([]);
    expect(alerts.status()).toEqual([]);
    notify.mockResolvedValueOnce(false);
    await alerts.refresh(['insufficient-space']);
    await alerts.refresh(['insufficient-space']);
    expect(notify).toHaveBeenCalledTimes(3);
    await expect(alerts.refresh(['private-key-in-error'])).rejects.toThrow();
    expect(await readFile(join(root, 'operational-alerts'), 'utf8')).not.toContain('private-key');
    await alerts.maintenanceFailed(true);
    await alerts.refresh([]);
    expect(alerts.status()).toEqual(['maintenance-failed']);
    await alerts.maintenanceFailed(false);
    await alerts.refresh([]);
    expect(alerts.status()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
