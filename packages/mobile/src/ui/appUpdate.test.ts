import { describe, expect, it } from 'vitest';
import {
  appStoreUpdate,
  describeAppUpdate,
  parseAppStoreLookup,
  type AppStoreRelease,
  type AppUpdateFacts,
} from './appUpdate.js';

const facts = (over: Partial<AppUpdateFacts> = {}): AppUpdateFacts => ({
  variant: 'production',
  platform: 'ios',
  runningVersion: '1.75.4',
  nativeVersion: '1.75.0',
  nativeBuild: '312',
  updatesEnabled: true,
  downloaded: false,
  checking: false,
  checkFailed: false,
  store: null,
  ...over,
});

const store = (version: string): AppStoreRelease => ({
  version,
  publishedAt: '2026-10-22T07:00:00Z',
  notes: 'Faster voice input start',
  url: 'https://apps.apple.com/app/verity/id6807746931',
});

describe('app update box', () => {
  it('says up to date and offers a check when nothing is pending', () => {
    expect(describeAppUpdate(facts())).toEqual({
      name: 'Verity',
      subtitle: 'Version 1.75.4',
      tag: { label: 'Up to date', intent: 'ready' },
      attention: false,
      block: null,
      checkLink: true,
      testFlightLink: false,
    });
  });

  it('offers a restart for a downloaded update without calling it a to-do', () => {
    const box = describeAppUpdate(facts({ downloaded: true }));
    expect(box.tag).toEqual({ label: 'Ready', intent: 'optional' });
    expect(box.block).toMatchObject({ key: 'ready', action: { kind: 'restart' } });
    expect(box.checkLink).toBe(false);
  });

  it('sends a newer App Store version to the store, ahead of a waiting smaller update', () => {
    const box = describeAppUpdate(facts({ downloaded: true, store: store('1.76.0') }));
    expect(box.tag).toEqual({ label: 'Update', intent: 'needsSetup' });
    expect(box.block).toEqual({
      key: 'store',
      title: 'Version 1.76.0 is available',
      publishedAt: '2026-10-22T07:00:00Z',
      detail: 'Installs through the App Store. Your data and pairing stay as they are.',
      action: { kind: 'open-store', label: 'Update in App Store', url: store('1.76.0').url },
      notes: 'Faster voice input start',
    });
  });

  // The running 1.75.4 arrived over the air into a 1.75.0 binary. Only a store
  // release on a newer native line than that binary is something to install.
  it('compares the store with the binary, not with the running JavaScript', () => {
    expect(appStoreUpdate(facts({ store: store('1.75.0') }))).toBeNull();
    expect(appStoreUpdate(facts({ store: store('1.76.0') }))?.version).toBe('1.76.0');
    // Same native line: it arrives over the air, and offering the store would
    // name a version below the 1.75.4 already running.
    expect(appStoreUpdate(facts({ store: store('1.75.2') }))).toBeNull();
    expect(appStoreUpdate(facts({ nativeVersion: '1.77.0', store: store('1.76.0') }))).toBeNull();
  });

  it('keeps a development build off the App Store', () => {
    expect(describeAppUpdate(facts({ updatesEnabled: false, store: store('1.76.0') })).tag).toEqual(
      { label: 'Off', intent: 'optional' },
    );
    expect(appStoreUpdate(facts({ nativeVersion: null, store: store('1.76.0') }))).toBeNull();
  });

  it('never asks the App Store about the Staging app or another platform', () => {
    expect(appStoreUpdate(facts({ variant: 'staging', store: store('1.76.0') }))).toBeNull();
    expect(appStoreUpdate(facts({ platform: 'android', store: store('1.76.0') }))).toBeNull();
  });

  it('links the Staging app to TestFlight instead', () => {
    const box = describeAppUpdate(facts({ variant: 'staging', store: store('1.76.0') }));
    expect(box).toMatchObject({
      name: 'Verity Staging',
      testFlightLink: true,
      checkLink: true,
      block: null,
    });
    expect(
      describeAppUpdate(facts({ variant: 'staging', platform: 'android' })).testFlightLink,
    ).toBe(false);
  });

  it('reports a failed check in the box with a way to try again', () => {
    const box = describeAppUpdate(facts({ checkFailed: true }));
    expect(box).toMatchObject({
      tag: { label: 'Error', intent: 'needsSetup' },
      attention: true,
      block: { key: 'error', action: { kind: 'check', label: 'Try again' } },
    });
  });

  it('shows a check in motion instead of claiming the app is up to date', () => {
    expect(describeAppUpdate(facts({ checking: true }))).toMatchObject({
      tag: { label: 'Checking', intent: 'transient' },
      checkLink: false,
    });
  });

  it('shows version and build of a build with updates turned off, and nothing to do', () => {
    expect(describeAppUpdate(facts({ updatesEnabled: false, runningVersion: '1.75.0' }))).toEqual({
      name: 'Verity',
      subtitle: 'Version 1.75.0 · Build 312',
      tag: { label: 'Off', intent: 'optional' },
      attention: false,
      block: null,
      checkLink: false,
      testFlightLink: false,
    });
  });
});

describe('App Store lookup', () => {
  const answer = (result: Record<string, unknown>) => ({ resultCount: 1, results: [result] });

  it('reads the version, date, notes and store page', () => {
    expect(
      parseAppStoreLookup(
        answer({
          version: '1.76.0',
          trackViewUrl: 'https://apps.apple.com/us/app/verity/id6807746931',
          releaseNotes: '  Faster voice input start\n',
          currentVersionReleaseDate: '2026-10-22T07:00:00Z',
        }),
      ),
    ).toEqual({
      version: '1.76.0',
      publishedAt: '2026-10-22T07:00:00Z',
      notes: 'Faster voice input start',
      url: 'https://apps.apple.com/us/app/verity/id6807746931',
    });
  });

  // A lookup that answers for the wrong thing must not become a button that
  // sends someone there.
  it('treats an answer it cannot vouch for as no answer', () => {
    expect(parseAppStoreLookup({ resultCount: 0, results: [] })).toBeNull();
    expect(parseAppStoreLookup(null)).toBeNull();
    expect(
      parseAppStoreLookup(answer({ version: '1.76.0', trackViewUrl: 'https://example.com/x' })),
    ).toBeNull();
    expect(
      parseAppStoreLookup(
        answer({ version: 'latest', trackViewUrl: 'https://apps.apple.com/app/id1' }),
      ),
    ).toBeNull();
  });
});
