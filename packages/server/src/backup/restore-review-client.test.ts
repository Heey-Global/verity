import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { BackupDeviceReview } from './device-review.js';
import { createRestoreTrial } from './restore-trial.js';
import { reviewRestoreDevices } from './restore-review-client.js';

it('keeps the recovery session inside the Unix-socket client and accepts only explicitly reviewed devices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-client-'));
  const jobId = randomUUID();
  const trial = join(root, jobId, 'trial');
  await mkdir(trial, { recursive: true, mode: 0o700 });
  const review = new BackupDeviceReview(trial);
  const removeOtherTokens = vi.fn(async () => {});
  let now = Date.now();
  const app = createRestoreTrial(
    {
      review,
      authenticate: async (password) => password === 'master',
      inventory: async () => ({
        devices: ['keep', 'revoked'],
        revokedIds: ['revoked'],
        findings: [],
      }),
      removeOtherTokens,
    },
    () => {
      now += 5001;
      return now;
    },
  );
  await app.listen({ path: join(trial, 'trial.sock') });
  const options = { root, jobId, masterPassword: 'master' };
  try {
    await expect(reviewRestoreDevices({ ...options, masterPassword: 'wrong' })).rejects.toThrow(
      'request rejected',
    );
    const inventory = await reviewRestoreDevices(options);
    expect(inventory).toEqual({
      devices: ['keep', 'revoked'],
      revokedIds: ['revoked'],
      findings: [],
    });
    expect(inventory).not.toHaveProperty('token');
    await expect(reviewRestoreDevices({ ...options, keepIds: ['revoked'] })).rejects.toThrow(
      'request rejected',
    );
    expect(removeOtherTokens).not.toHaveBeenCalled();
    await expect(reviewRestoreDevices({ ...options, keepIds: ['keep'] })).resolves.toEqual({
      reviewed: true,
    });
    expect(removeOtherTokens).toHaveBeenCalledWith(['keep']);
    await expect(reviewRestoreDevices(options)).rejects.toThrow('request rejected');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
