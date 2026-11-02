import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupDeviceReview } from './device-review.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('mandatory recovery device review', () => {
  it('blocks all devices until review, cannot keep revoked credentials, deletes before acceptance and consumes its own session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-device-review-'));
    roots.push(root);
    const review = new BackupDeviceReview(root);
    const token = await review.create(['keep', 'discard', 'revoked'], ['revoked'], ['journal gap']);
    expect((await readFile(join(root, 'device-review'), 'utf8')).includes(token)).toBe(false);
    expect(await review.blocksDevices()).toBe(true);
    expect(await review.inspect(token)).toEqual({
      devices: ['keep', 'discard', 'revoked'],
      revokedIds: ['revoked'],
      findings: ['journal gap'],
    });
    const removed: string[][] = [];
    await expect(
      review.accept(token, ['revoked'], async (ids) => {
        removed.push([...ids]);
      }),
    ).rejects.toThrow('journal-revoked');
    expect(removed).toEqual([]);
    await expect(
      review.accept(token, ['keep'], async () => {
        throw new Error('database unavailable');
      }),
    ).rejects.toThrow('database unavailable');
    expect(await review.blocksDevices()).toBe(true);
    await review.accept(token, ['keep'], async (ids) => {
      expect(await review.blocksDevices()).toBe(true);
      removed.push([...ids]);
    });
    expect(removed).toEqual([['keep']]);
    expect(await review.blocksDevices()).toBe(false);
    await expect(review.inspect(token)).rejects.toThrow('Invalid or expired');
    expect((await new BackupDeviceReview(root).load())!.keptIds).toEqual(['keep']);
    await expect(review.create(['discard'], [], [])).rejects.toThrow('already complete');
  });
  it('expires review sessions without enabling any device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-device-review-'));
    roots.push(root);
    let now = 1000;
    const review = new BackupDeviceReview(root, () => now);
    const token = await review.create(['device'], [], []);
    now += 3600000;
    await expect(review.inspect(token)).rejects.toThrow('expired');
    expect(await review.blocksDevices()).toBe(true);
  });
});
