import type { ServerMonitoringSettings } from '@verity/store';
import { expect, it } from 'vitest';
import { MonitoringControl, type MonitoringSettingsStore } from './monitoring-control.js';

// Two quick taps in the app send two PATCHes. If a slower write's snapshot
// landed in memory last, memory would disagree with the database until restart.
it('ends with the settings the store wrote last when changes overlap', async () => {
  let row: ServerMonitoringSettings = {
    measurementEnabled: true,
    detailUntil: null,
    detailStartedBy: null,
  };
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let writes = 0;
  const store: MonitoringSettingsStore = {
    get: async () => row,
    setMeasurementEnabled: async (enabled) => {
      writes += 1;
      row = { ...row, measurementEnabled: enabled };
      const snapshot = row;
      // The row is read, but the answer arrives late.
      if (writes === 1) await firstHeld;
      return snapshot;
    },
    setDetailMode: async (until, startedBy) => {
      row = { ...row, detailUntil: until, detailStartedBy: startedBy };
      return row;
    },
  };
  const control = new MonitoringControl(store, () => 0);
  // Re-confirming measurement while detail mode starts: the confirmation's
  // snapshot predates the deadline and would arrive after it.
  const confirm = control.setMeasurementEnabled(true);
  const detail = control.startDetailMode(15, 'app');
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFirst();
  await Promise.all([confirm, detail]);
  expect(row).toMatchObject({ measurementEnabled: true, detailStartedBy: 'app' });
  expect(control.state().detailMode).toMatchObject({ active: true, startedBy: 'app' });
});
