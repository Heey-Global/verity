import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { BackupDeviceReview } from './device-review.js';
import { recheckRestoreDevices } from './restore-final-review.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import type { RestoreJob } from './restore-job.js';
const fake = vi.hoisted(() => ({ snapshot: vi.fn(), journal: vi.fn(), authenticate: vi.fn() }));
vi.mock('./repository.js', async (original) => ({
  ...(await original<typeof import('./repository.js')>()),
  readSnapshot: fake.snapshot,
}));
vi.mock('./revocations.js', () => ({ readRevocations: fake.journal }));
vi.mock('./restore-auth.js', () => ({ authenticateRestoreAdministrator: fake.authenticate }));
it('rechecks both factors and new journal/outbox revocations before keeping any reviewed device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-final-review-'));
  const snapshot = { authenticated: true };
  const job: RestoreJob = {
    format: 1,
    id: randomUUID(),
    installationId: randomUUID(),
    selection: {
      source: '/copied/backup',
      repository: randomUUID() + '-r1',
      sequence: 1,
      kind: 'manual',
      newIdentity: false,
    },
    verified: {
      image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
      manifestHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      schema: 'schema',
      architecture: 'amd64',
      deploymentId: 'deployment',
      sourceInstallationId: randomUUID(),
    },
    phase: 'promoting',
    startedAt: 1,
    updatedAt: 1,
  };
  const state = join(root, job.id, 'trial');
  await mkdir(state, { recursive: true });
  const review = new BackupDeviceReview(state);
  const devices = ['keep', 'journal-revoked', 'outbox-revoked'];
  const token = await review.create(devices, [], []);
  await review.accept(token, devices, async () => {});
  const query = vi.fn(async (sql: string) => {
    if (sql === 'SELECT current_database() AS name')
      return { rows: [{ name: restoreDatabaseResources(job).database }] };
    if (sql.startsWith('SELECT job_id'))
      return {
        rows: [
          {
            job_id: job.id,
            installation_id: job.installationId,
            manifest_hash: job.verified!.manifestHash,
            phase: 'prepared',
          },
        ],
      };
    if (sql.startsWith('SELECT id FROM auth_tokens'))
      return { rows: devices.map((id) => ({ id })) };
    if (sql.startsWith('SELECT device_id')) return { rows: [{ device_id: 'outbox-revoked' }] };
    return { rows: [] };
  });
  const client = { query } as unknown as PoolClient;
  const options = {
    root,
    job,
    client,
    recoveryKey: 'recovery-key',
    masterPassword: 'master-password',
  };
  fake.snapshot.mockResolvedValue(snapshot);
  fake.authenticate.mockResolvedValue(true);
  fake.journal.mockResolvedValue({ revokedIds: new Set(['journal-revoked']), findings: [] });
  try {
    await expect(recheckRestoreDevices(options)).resolves.toEqual(['keep']);
    expect(fake.authenticate).toHaveBeenCalledWith(client, 'master-password');
    expect(query).toHaveBeenCalledWith('DELETE FROM auth_tokens WHERE NOT (id = ANY($1::text[]))', [
      ['keep'],
    ]);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    query.mockClear();
    fake.authenticate.mockResolvedValueOnce(false);
    await expect(recheckRestoreDevices(options)).rejects.toThrow('Administrator authentication');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
    query.mockClear();
    fake.journal.mockResolvedValueOnce({ revokedIds: new Set(), findings: ['new sequence gap'] });
    await expect(recheckRestoreDevices(options)).rejects.toThrow('history changed');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
    query.mockClear();
    fake.snapshot.mockResolvedValueOnce({ authenticated: 'replacement' });
    await expect(recheckRestoreDevices(options)).rejects.toThrow('Snapshot changed');
    expect(query).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
