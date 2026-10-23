import { z } from 'zod';

/**
 * The app's own updates, for the "App" box of the update screen.
 *
 * Two kinds of update reach the app, and the person reading the screen should
 * not have to know which is which. A new native release (X.Y.0 → X.(Y+1).0)
 * only arrives through the App Store; a smaller one within the installed line
 * (X.Y.3 → X.Y.4) arrives over the air and applies on the next start. The box
 * therefore never names the mechanism: it shows one version, one state, and at
 * most one action, and the action says what will happen ("Restart now",
 * "Update in App Store").
 */

/** A release the App Store lists for this app. */
export interface AppStoreRelease {
  readonly version: string;
  /** ISO date of the release, when the store reports one. */
  readonly publishedAt: string | null;
  readonly notes: string | null;
  /** The store page, as the store itself reported it. */
  readonly url: string;
}

export interface AppUpdateFacts {
  readonly variant: 'production' | 'staging';
  readonly platform: string;
  /** The version of the JavaScript actually running (see `runningReleaseVersion`). */
  readonly runningVersion: string;
  /** The binary's marketing version and build number. */
  readonly nativeVersion: string | null;
  readonly nativeBuild: string | null;
  /** Whether over-the-air updates are on in this build at all. */
  readonly updatesEnabled: boolean;
  readonly downloaded: boolean;
  readonly checking: boolean;
  readonly checkFailed: boolean;
  /** What the App Store lists; null when it was not asked or did not answer. */
  readonly store: AppStoreRelease | null;
}

export type AppUpdateAction =
  | { readonly kind: 'restart'; readonly label: string }
  | { readonly kind: 'check'; readonly label: string }
  | { readonly kind: 'open-store'; readonly label: string; readonly url: string };

export interface AppUpdateBlock {
  readonly key: 'store' | 'ready' | 'error';
  readonly title: string;
  /** Release date of the version on offer (ISO); null when unknown. */
  readonly publishedAt: string | null;
  readonly detail: string;
  readonly action: AppUpdateAction;
  /** Release notes of the version on offer, as the store lists them. */
  readonly notes: string | null;
}

export interface AppUpdateBox {
  readonly name: string;
  readonly subtitle: string;
  readonly tag: {
    readonly label: string;
    readonly intent: 'ready' | 'needsSetup' | 'optional' | 'transient';
  } | null;
  /** True when the box reports a problem, for its attention border. */
  readonly attention: boolean;
  readonly block: AppUpdateBlock | null;
  /** "Check for updates" under the head, when checking can tell anything new. */
  readonly checkLink: boolean;
  /** "Open TestFlight": only the Staging app, which ships through TestFlight alone. */
  readonly testFlightLink: boolean;
}

/** The App Store's public lookup answer, as far as the box needs it. */
const appStoreLookupSchema = z.object({
  results: z.array(
    z.object({
      version: z.string().regex(/^\d+\.\d+(\.\d+)?$/),
      trackViewUrl: z.string().startsWith('https://apps.apple.com/'),
      releaseNotes: z.string().optional(),
      currentVersionReleaseDate: z.string().optional(),
    }),
  ),
});

/**
 * Read the App Store lookup for this app. Anything the box cannot vouch for —
 * no result, a version it cannot compare, a link to somewhere else — is no
 * answer rather than an offer, so a broken lookup never sends anyone away.
 */
export function parseAppStoreLookup(body: unknown): AppStoreRelease | null {
  const parsed = appStoreLookupSchema.safeParse(body);
  const result = parsed.success ? parsed.data.results[0] : undefined;
  if (result === undefined) return null;
  const notes = result.releaseNotes?.trim();
  return {
    version: result.version,
    publishedAt: result.currentVersionReleaseDate ?? null,
    notes: notes === undefined || notes === '' ? null : notes,
    url: result.trackViewUrl,
  };
}

/** Numeric comparison of dotted versions; a missing part counts as 0. */
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (Number.isNaN(difference)) return 0;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * The store version this app should be updated to, or null. Compared with the
 * binary, not with the running JavaScript: an over-the-air 1.75.4 still runs in
 * a 1.75.0 binary, and only a store release above that binary is news. The
 * Staging app is not in the App Store, only iOS asks it, and a binary that does
 * not report its version is not compared at all.
 */
export function appStoreUpdate(facts: AppUpdateFacts): AppStoreRelease | null {
  if (
    facts.variant !== 'production' ||
    facts.platform !== 'ios' ||
    // Development builds share the production bundle id but are not what the
    // store installed; they say "Off" instead of sending anyone there.
    !facts.updatesEnabled ||
    facts.store === null ||
    facts.nativeVersion === null
  )
    return null;
  return compareVersions(facts.store.version, facts.nativeVersion) > 0 ? facts.store : null;
}

export function describeAppUpdate(facts: AppUpdateFacts): AppUpdateBox {
  const name = facts.variant === 'staging' ? 'Verity Staging' : 'Verity';
  const subtitle = `Version ${facts.runningVersion}`;
  const testFlightLink = facts.variant === 'staging' && facts.platform === 'ios';
  const base = { name, subtitle, attention: false, block: null, checkLink: false, testFlightLink };

  // A new binary carries the newest JavaScript as well, so it wins over a
  // smaller update that may be waiting — which is then not worth mentioning.
  const store = appStoreUpdate(facts);
  if (store !== null) {
    return {
      ...base,
      tag: { label: 'Update', intent: 'needsSetup' },
      block: {
        key: 'store',
        title: `Version ${store.version} is available`,
        publishedAt: store.publishedAt,
        detail: 'Installs through the App Store. Your data and pairing stay as they are.',
        action: { kind: 'open-store', label: 'Update in App Store', url: store.url },
        notes: store.notes,
      },
    };
  }

  if (!facts.updatesEnabled) {
    // A development or preview build: what it is, and nothing to act on.
    const build = facts.nativeBuild === null ? '' : ` · Build ${facts.nativeBuild}`;
    return { ...base, subtitle: `${subtitle}${build}`, tag: { label: 'Off', intent: 'optional' } };
  }

  if (facts.downloaded) {
    return {
      ...base,
      // Not a to-do: it applies on its own the next time the app starts.
      tag: { label: 'Ready', intent: 'optional' },
      block: {
        key: 'ready',
        title: 'Update ready',
        publishedAt: null,
        detail: 'Installs the next time you open Verity. Restart now to use it right away.',
        action: { kind: 'restart', label: 'Restart now' },
        notes: null,
      },
    };
  }

  if (facts.checking) return { ...base, tag: { label: 'Checking', intent: 'transient' } };

  if (facts.checkFailed) {
    return {
      ...base,
      tag: { label: 'Error', intent: 'needsSetup' },
      attention: true,
      block: {
        key: 'error',
        title: "Couldn't check for updates",
        publishedAt: null,
        detail: 'Verity could not reach the update service. The version you have keeps working.',
        action: { kind: 'check', label: 'Try again' },
        notes: null,
      },
    };
  }

  return { ...base, tag: { label: 'Up to date', intent: 'ready' }, checkLink: true };
}
