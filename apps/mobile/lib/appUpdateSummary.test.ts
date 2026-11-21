import { appUpdateSummary } from './appUpdateSummary';
import type { AppUpdateFacts } from '@verity/mobile';
const facts: AppUpdateFacts = {
  variant: 'staging',
  platform: 'ios',
  runningVersion: '1.94.5',
  nativeVersion: '1.94.0',
  nativeBuild: '18',
  updatesEnabled: true,
  downloaded: true,
  checking: false,
  checkFailed: false,
  store: null,
};
it('announces a ready OTA in Staging without an App Store listing', () => {
  expect(appUpdateSummary(facts, null)).toEqual({
    subtitle: 'App update ready · Restart now',
    status: { intent: 'needsSetup', label: 'Update' },
  });
});
it('does not hide either the server update or ready app update', () => {
  const summary = appUpdateSummary(facts, '4.99.1');
  expect(summary.subtitle).toContain('Server version 4.99.1 available');
  expect(summary.subtitle).toContain('App update ready');
});
it('keeps the store binary priority shared with the app box', () => {
  const summary = appUpdateSummary(
    {
      ...facts,
      variant: 'production',
      store: {
        version: '1.95.0',
        publishedAt: null,
        notes: null,
        url: 'https://apps.apple.com/app/verity',
      },
    },
    '4.99.1',
  );
  expect(summary.subtitle).toContain('Server version 4.99.1 available');
  expect(summary.subtitle).toContain('App version 1.95.0 available');
  expect(summary.subtitle).not.toContain('Restart');
});
it('retains the quiet row when nothing is ready or OTA is disabled', () => {
  expect(appUpdateSummary({ ...facts, downloaded: false }, null).status).toBeUndefined();
  expect(appUpdateSummary({ ...facts, updatesEnabled: false }, null).status).toBeUndefined();
});
