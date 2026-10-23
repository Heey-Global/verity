/**
 * What the update screen needs to know about the app itself: the version that
 * runs, what expo-updates has downloaded, and what the App Store lists.
 *
 * The App Store is asked through Apple's public lookup, which needs no
 * credentials. Only the production iOS app is listed there — the Staging app
 * ships through TestFlight alone, and TestFlight has no public lookup — so
 * every other build skips the request. An answer is kept for the rest of the
 * app session; a failed request is not, so the next visit asks again.
 */
import {
  appStoreUpdate,
  parseAppStoreLookup,
  type AppStoreRelease,
  type AppUpdateFacts,
} from '@verity/mobile';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { getLocales } from 'expo-localization';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { downloadAppUpdate } from './automaticUpdates';
import { runningReleaseVersion } from './buildInfo';

const LOOKUP_TIMEOUT_MS = 10_000;

const APP_VARIANT: AppUpdateFacts['variant'] =
  Constants.expoConfig?.extra?.appVariant === 'staging' ? 'staging' : 'production';

let lookup: Promise<AppStoreRelease | null> | undefined;
const listeners = new Set<(release: AppStoreRelease | null) => void>();

/** The App Store listing of this app, or null when it was not or could not be asked. */
function lookUpAppStoreRelease(): Promise<AppStoreRelease | null> {
  const bundleId = Application.applicationId;
  // A build without over-the-air updates is a development build, which the
  // store did not install and the box shows as "Off".
  if (APP_VARIANT !== 'production' || Platform.OS !== 'ios' || !Updates.isEnabled || !bundleId)
    return Promise.resolve(null);
  if (lookup !== undefined) return lookup;
  const pending: Promise<AppStoreRelease | null> = requestAppStoreRelease(bundleId).then(
    (release) => {
      // Only this request's own entry: an explicit check may have replaced it.
      if (lookup !== pending) return release;
      if (release === null) lookup = undefined;
      // Every reader hears the newest answer — the Settings row stays mounted
      // behind the update screen and would otherwise keep the one it read first.
      for (const listener of listeners) listener(release);
      return release;
    },
  );
  lookup = pending;
  return pending;
}

async function requestAppStoreRelease(bundleId: string): Promise<AppStoreRelease | null> {
  // The listing is per storefront; without a country Apple answers for the US.
  const country = getLocales()[0]?.regionCode?.toLowerCase();
  const query = new URLSearchParams({ bundleId, ...(country ? { country } : {}) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(`https://itunes.apple.com/lookup?${query.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseAppStoreLookup(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Forget the cached listing. For tests only. */
export function resetAppStoreLookupForTests(): void {
  lookup = undefined;
}

function useAppStoreRelease(enabled: boolean, revision = 0): AppStoreRelease | null {
  const [release, setRelease] = useState<AppStoreRelease | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    listeners.add(setRelease);
    void lookUpAppStoreRelease().then((next) => {
      if (active) setRelease(next);
    });
    return () => {
      active = false;
      listeners.delete(setRelease);
    };
  }, [enabled, revision]);
  return release;
}

function staticFacts(): Omit<AppUpdateFacts, 'downloaded' | 'checking' | 'checkFailed' | 'store'> {
  return {
    variant: APP_VARIANT,
    platform: Platform.OS,
    runningVersion: runningReleaseVersion(Application.nativeApplicationVersion),
    nativeVersion: Application.nativeApplicationVersion,
    nativeBuild: Application.nativeBuildVersion,
    updatesEnabled: Updates.isEnabled,
  };
}

/**
 * The App Store version the Settings row should announce, or null. Only a new
 * store release counts: a downloaded smaller update applies on its own.
 */
export function useAppStoreUpdateVersion(enabled: boolean): string | null {
  const store = useAppStoreRelease(enabled);
  if (store === null) return null;
  return (
    appStoreUpdate({
      ...staticFacts(),
      downloaded: false,
      checking: false,
      checkFailed: false,
      store,
    })?.version ?? null
  );
}

/** Everything the App box shows, and the one check it can start. */
export function useAppUpdateFacts(): { facts: AppUpdateFacts; check: () => void } {
  const updates = Updates.useUpdates();
  // Bumped by an explicit check, so it asks the App Store again as well.
  const [revision, setRevision] = useState(0);
  const store = useAppStoreRelease(true, revision);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const check = useCallback(() => {
    setChecking(true);
    setCheckFailed(false);
    lookup = undefined;
    setRevision((current) => current + 1);
    // Downloads only. A restart is the person's call, so nothing they are
    // doing is interrupted; the downloaded update shows up as ready.
    void downloadAppUpdate()
      .then((result) => setCheckFailed(typeof result === 'object' && result.status === 'failed'))
      .catch(() => setCheckFailed(true))
      .finally(() => setChecking(false));
  }, []);
  return {
    facts: {
      ...staticFacts(),
      downloaded: updates.isUpdatePending,
      checking: checking || updates.isChecking || updates.isDownloading,
      checkFailed,
      store,
    },
    check,
  };
}
