import { describe, expect, it } from 'vitest';
import { BackupLifecycleCoordinator } from './lifecycle.js';

describe('backup lifecycle leases', () => {
  it('lets a leased capture re-freeze while deletion is waiting', async () => {
    const coordinator = new BackupLifecycleCoordinator();
    const capture = await coordinator.beginCapture(async () => ({
      projectIds: ['project'],
      value: 1,
    }));
    const events: string[] = [];
    const deletion = coordinator.mutate(['project'], async () => {
      events.push('delete');
    });
    await coordinator.refreeze(async () => {
      events.push('refreeze');
    });
    expect(events).toEqual(['refreeze']);
    capture.release();
    await deletion;
    expect(events).toEqual(['refreeze', 'delete']);
  });
  it('holds deletion from snapshot opening through copying, including projects not copied yet', async () => {
    const coordinator = new BackupLifecycleCoordinator();
    const events: string[] = [];
    const capture = await coordinator.beginCapture(async () => ({
      projectIds: ['first', 'later'],
      value: 1,
    }));
    const deletion = coordinator.mutate(['later'], async () => {
      events.push('delete');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([]);
    capture.release();
    await deletion;
    expect(events).toEqual(['delete']);
    capture.release();
  });
  it('serializes snapshot opening against mutations and releases the barrier after errors', async () => {
    const coordinator = new BackupLifecycleCoordinator();
    let resume!: () => void;
    const pending = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const events: string[] = [];
    const mutation = coordinator.mutate(['project'], async () => {
      events.push('mutation');
      await pending;
    });
    const capture = coordinator.beginCapture(async () => {
      events.push('snapshot');
      return { projectIds: ['project'], value: 2 };
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['mutation']);
    resume();
    await mutation;
    const lease = await capture;
    lease.release();
    expect(events).toEqual(['mutation', 'snapshot']);
    await expect(
      coordinator.beginCapture(async () => {
        throw new Error('freeze failed');
      }),
    ).rejects.toThrow('freeze failed');
    await coordinator.mutate(['project'], async () => undefined);
  });
});
