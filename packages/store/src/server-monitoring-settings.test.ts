import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { ServerMonitoringSettingsStore } from './server-monitoring-settings.js';
import { createTestDb, truncateAll, type TestDb } from './testing.js';

let ctx: TestDb;
let store: ServerMonitoringSettingsStore;
beforeAll(async () => {
  ctx = await createTestDb();
  store = new ServerMonitoringSettingsStore(ctx.db);
});
beforeEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

it('measures by default, so a fresh installation has evidence when something goes wrong', async () => {
  expect(await store.get()).toEqual({
    measurementEnabled: true,
    detailUntil: null,
    detailStartedBy: null,
  });
});

it('keeps measurement switched off across reads', async () => {
  await store.setMeasurementEnabled(false);
  expect((await store.get()).measurementEnabled).toBe(false);
  await store.setMeasurementEnabled(true);
  expect((await store.get()).measurementEnabled).toBe(true);
});

it('stores the detail mode deadline and who started it, and clears both on stop', async () => {
  const until = new Date('2026-11-25T15:42:00Z');
  await store.setDetailMode(until, 'control');
  expect(await store.get()).toMatchObject({ detailUntil: until, detailStartedBy: 'control' });
  // Starting detail mode does not touch the measurement switch.
  expect((await store.get()).measurementEnabled).toBe(true);
  await store.setDetailMode(null, 'app');
  expect(await store.get()).toMatchObject({ detailUntil: null, detailStartedBy: null });
});
