import { describe, expect, it } from 'vitest';
import {
  BackupScheduler,
  backupScheduleAlerts,
  DEFAULT_BACKUP_INTERVAL_MS,
  type BackupScheduleState,
} from './scheduler.js';
function fixture() {
  let now = 10 * DEFAULT_BACKUP_INTERVAL_MS;
  let state: BackupScheduleState = {
    intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
    paused: false,
    lastSuccess: null,
    lastAttempt: null,
    failures: 0,
  };
  const events: string[] = [];
  let capture: (signal: AbortSignal) => Promise<void> = async () => {
    events.push('capture');
  };
  const dependencies = {
    now: () => now,
    load: async () => ({ ...state }),
    update: async (change: (value: BackupScheduleState) => BackupScheduleState) => {
      state = change({ ...state });
      return { ...state };
    },
    capture: (signal: AbortSignal) => capture(signal),
    maintain: async () => {
      events.push('maintain');
    },
    syncRevocations: async () => {
      events.push('revocations');
    },
  };
  return {
    dependencies,
    events,
    state: () => state,
    change: (value: Partial<BackupScheduleState>) => {
      state = { ...state, ...value };
    },
    advance: (ms: number) => {
      now += ms;
    },
    setCapture: (value: typeof capture) => {
      capture = value;
    },
  };
}
describe('durable backup schedule', () => {
  it('does one catch-up run, reserves before capture and avoids overlap', async () => {
    const f = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.setCapture(async (signal) => {
      expect(signal.aborted).toBe(false);
      expect(f.state().failures).toBe(1);
      f.events.push('capture');
      await pending;
    });
    const scheduler = new BackupScheduler(f.dependencies);
    const first = scheduler.tick();
    expect(scheduler.tick()).toBe(first);
    finish();
    await first;
    expect(f.events).toEqual(['revocations', 'capture', 'maintain']);
    await scheduler.tick();
    expect(f.events).toEqual(['revocations', 'capture', 'maintain', 'revocations']);
    expect(f.state().failures).toBe(0);
  });
  it('backs off after restart, never prunes failed captures and keeps revocations running while paused', async () => {
    const f = fixture();
    f.setCapture(async () => {
      f.events.push('failed');
      throw new Error('disk full');
    });
    await new BackupScheduler(f.dependencies).tick();
    expect(f.state().failures).toBe(1);
    await new BackupScheduler(f.dependencies).tick();
    expect(f.events.filter((event) => event === 'failed')).toHaveLength(1);
    f.advance(15 * 60 * 1000);
    await new BackupScheduler(f.dependencies).tick();
    expect(f.state().failures).toBe(2);
    expect(f.events).not.toContain('maintain');
    expect(backupScheduleAlerts(f.state(), f.dependencies.now())).toContain('consecutive-failures');
    f.change({ paused: true });
    f.advance(DEFAULT_BACKUP_INTERVAL_MS);
    await new BackupScheduler(f.dependencies).tick();
    expect(f.events.at(-1)).toBe('revocations');
    expect(f.state().failures).toBe(2);
    expect(backupScheduleAlerts(f.state(), f.dependencies.now())).toEqual([]);
  });
  it('preserves settings selected during a capture and skips maintenance after pause', async () => {
    const f = fixture();
    f.setCapture(async () => {
      f.change({ paused: true, intervalMs: 3600000 });
    });
    await new BackupScheduler(f.dependencies).tick();
    expect(f.state().paused).toBe(true);
    expect(f.state().intervalMs).toBe(3600000);
    expect(f.events).not.toContain('maintain');
  });
  it('honors a pause committed between reading the schedule and reserving the run', async () => {
    const f = fixture();
    const update = f.dependencies.update;
    f.dependencies.update = (change) => {
      f.change({ paused: true });
      return update(change);
    };
    await new BackupScheduler(f.dependencies).tick();
    expect(f.events).toEqual(['revocations']);
    expect(f.state().lastAttempt).toBeNull();
  });
});
