/**
 * Which update banner the operator has put away: one version per server.
 *
 * Dismissing is "not this version", never "no more updates" — a newer release
 * has a different version and brings the banner back on its own, and the
 * Settings row keeps its tag either way. Kept on the device so a restart does
 * not undo it, and per server address so putting away one server's update says
 * nothing about another's.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'verity.serverUpdateBanner.v1.dismissed';

/** Server address → dismissed version. */
type Dismissed = Readonly<Record<string, string>>;

let cache: Dismissed | undefined;
let loading: Promise<Dismissed> | undefined;
const listeners = new Set<(dismissed: Dismissed) => void>();

function load(): Promise<Dismissed> {
  if (cache !== undefined) return Promise.resolve(cache);
  loading ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => parse(raw))
    // Unreadable storage forgets the dismissal: showing the banner once too
    // often is the harmless way to be wrong.
    .catch(() => ({}))
    .then((dismissed) => {
      cache = dismissed;
      return dismissed;
    });
  return loading;
}

function parse(raw: string | null): Dismissed {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function dismissVersion(baseUrl: string, version: string): void {
  const next = { ...(cache ?? {}), [baseUrl]: version };
  cache = next;
  for (const listener of listeners) listener(next);
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
}

/**
 * Whether the banner for `version` on `baseUrl` has been put away, and the way
 * to put it away. Until storage has answered the banner counts as dismissed, so
 * it does not flash up and vanish on every launch.
 */
export function useServerUpdateBannerDismissal(
  baseUrl: string | null,
  version: string | null,
): { dismissed: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState<Dismissed | undefined>(cache);
  useEffect(() => {
    let active = true;
    listeners.add(setDismissed);
    void load().then((loaded) => {
      if (active) setDismissed(loaded);
    });
    return () => {
      active = false;
      listeners.delete(setDismissed);
    };
  }, []);
  const dismiss = useCallback(() => {
    if (baseUrl !== null && version !== null) dismissVersion(baseUrl, version);
  }, [baseUrl, version]);
  return {
    dismissed:
      dismissed === undefined ||
      (baseUrl !== null && version !== null && dismissed[baseUrl] === version),
    dismiss,
  };
}

/**
 * The banner the overview shows for a waiting update, or null. A problem —
 * an earlier update that failed or is stuck — always shows and cannot be put
 * away; an ordinary release shows until its version is dismissed.
 */
export function serverUpdateBannerFor(
  notice: { readonly version: string; readonly problem: boolean } | null,
  dismissed: boolean,
): { version: string; problem: boolean; dismissible: boolean } | null {
  if (notice === null) return null;
  if (notice.problem) return { version: notice.version, problem: true, dismissible: false };
  return dismissed ? null : { version: notice.version, problem: false, dismissible: true };
}

/** Forget the in-memory copy. For tests only. */
export function resetServerUpdateBannerDismissalForTests(): void {
  cache = undefined;
  loading = undefined;
}
