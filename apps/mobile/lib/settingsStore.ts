// One shared copy of the Verity settings behind every Settings screen.
//
// The surface is a stack of sibling routes (index, GitHub, services, MCP,
// maintenance), and expo-router mounts and unmounts each of them independently.
// If every screen kept its own fetch, its own save state and its own idea of
// what is configured, the index's setup checklist would go stale the moment the
// operator fixed something one screen deeper — and "Saving…" would vanish when
// the screen that started the save was popped.
//
// So the data lives here instead: a module-level store the screens read through
// `useVeritySettings()`. Writes go through `saveVeritySettings`, which serialises
// requests (a PATCH is a read-modify-write server-side; two in flight at once
// can interleave) and merges each response back in, so every mounted screen sees
// the change at once.
//
// Screens never build a patch by hand — see `changedTextSettings`.
import {
  VerityApiError,
  requiresContainerApply,
  type SecretStatus,
  type VeritySettings,
  type VeritySettingsPatch,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';

export type VeritySettingsState = {
  /** The server's last word, or `null` before the first successful fetch. */
  settings: VeritySettings | null;
  /** `undefined` until the first secret-store status resolves. */
  secretStatus: SecretStatus | undefined;
  /** The FIRST load is in flight — there is nothing to render yet. A refresh
   *  over existing data deliberately does not set this. */
  loading: boolean;
  /** The last load failed. The setup checklist must not claim a count while
   *  this is set: "0 to do" computed from a failed fetch is a lie. */
  failed: boolean;
  /** Saves in flight. A count, not a flag: two screens can be mid-save. */
  saving: number;
  /** `updatedAt` of the most recent successful save, for "Last saved …". */
  savedAt: string | undefined;
  /** A saved change has not reached already-running project containers yet. */
  applyPending: boolean;
  /** Last load/save failure, shown as a banner. Cleared by the next attempt. */
  error: string | undefined;
};

const INITIAL: VeritySettingsState = {
  settings: null,
  secretStatus: undefined,
  loading: false,
  failed: false,
  saving: 0,
  savedAt: undefined,
  applyPending: false,
  error: undefined,
};

let state: VeritySettingsState = INITIAL;
const listeners = new Set<() => void>();
// Only the newest load may write; an earlier, slower response is stale.
let loadGeneration = 0;
let secretStatusGeneration = 0;
let storeGeneration = 0;
let settingsFailed = false;
let secretStatusFailed = false;
// Kept outside the public snapshot so write-only credentials never render or
// leak through React state. It survives route unmounts until Retry succeeds.
let failedPatches: { patch: VeritySettingsPatch; error: string }[] = [];
// Saves run one at a time, in the order the screens asked for them.
let saveChain: Promise<unknown> = Promise.resolve();

function publish(next: Partial<VeritySettingsState>): void {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): VeritySettingsState {
  return state;
}

/** Subscribe a screen to the shared settings state. */
export function useVeritySettings(): VeritySettingsState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Read the state outside React (tests, imperative callbacks). */
export function veritySettingsSnapshot(): VeritySettingsState {
  return state;
}

function describeFailure(caught: unknown, fallback: string): string {
  return caught instanceof VerityApiError ? caught.message : fallback;
}

function discardSupersededFailedKeys(replacement: VeritySettingsPatch): void {
  const replaced = new Set(Object.keys(replacement));
  failedPatches = failedPatches.flatMap((failed) => {
    const remaining = Object.fromEntries(
      Object.entries(failed.patch).filter(([key]) => !replaced.has(key)),
    ) as VeritySettingsPatch;
    return Object.keys(remaining).length === 0 ? [] : [{ ...failed, patch: remaining }];
  });
}

/**
 * Fetch settings into the store.
 *
 * Re-entrant by design: every screen calls it on mount, and the newest call wins.
 * With data already on hand it refreshes in place — no spinner, no flicker back
 * to an empty screen while the operator is looking at a form.
 */
export function loadVeritySettings(client: VerityClient): Promise<void> {
  const generation = ++loadGeneration;
  settingsFailed = false;
  publish({ loading: state.settings === null, failed: secretStatusFailed });
  return client.getVeritySettings().then(
    (next) => {
      if (generation !== loadGeneration) return;
      settingsFailed = false;
      publish({
        settings: next,
        loading: false,
        failed: secretStatusFailed,
        error: failedPatches[0]?.error,
      });
    },
    (caught: unknown) => {
      if (generation !== loadGeneration) return;
      settingsFailed = true;
      publish({
        loading: false,
        failed: true,
        error: describeFailure(caught, 'Could not load settings'),
      });
    },
  );
}

/**
 * Refresh the secret-store status.
 *
 * A failure here marks the state as incomplete rather than raising a banner: the
 * status is auxiliary to the form, but the setup checklist counts it, and a
 * checklist computed from a status nobody could fetch would under-report.
 */
export function refreshSecretStatus(client: VerityClient): Promise<void> {
  const generation = ++secretStatusGeneration;
  return client.getSecretStatus().then(
    (status) => {
      if (generation !== secretStatusGeneration) return;
      secretStatusFailed = false;
      publish({ secretStatus: status, failed: settingsFailed });
    },
    () => {
      if (generation !== secretStatusGeneration) return;
      secretStatusFailed = true;
      publish({ failed: true });
    },
  );
}

/**
 * Keep the shared state fresh while a settings screen is mounted, and hand back
 * the retry the error banner needs.
 *
 * Every screen calls this, not just the index: the operator can arrive on any of
 * them from a deep link, and a screen that trusted whatever the store happened
 * to hold would show another server's data after the app was repointed.
 */
export function useLoadVeritySettings(client: VerityClient): () => void {
  const reload = useCallback(() => {
    void loadVeritySettings(client);
    void refreshSecretStatus(client);
  }, [client]);
  useFocusEffect(reload);
  return reload;
}

export type SaveOutcome = 'saved' | 'failed';

/**
 * Persist a patch and merge the response into the shared state.
 *
 * Callers pass ONLY the keys they changed (`changedTextSettings` and
 * `secretPatchFromDraft` produce exactly that) — an empty patch is a no-op
 * rather than a request. The returned outcome lets a screen restore a secret
 * paste box it cleared optimistically.
 */
export function saveVeritySettings(
  client: VerityClient,
  patch: VeritySettingsPatch,
): Promise<SaveOutcome> {
  if (Object.keys(patch).length === 0) return Promise.resolve('saved');
  const generation = storeGeneration;
  publish({ saving: state.saving + 1, error: failedPatches[0]?.error });
  const run = saveChain
    .then(() => {
      // A reset means this save belonged to the previously selected server.
      // Queued work must be dropped before it can send credentials or settings
      // through the old client; checking only the response is already too late.
      if (generation !== storeGeneration) return undefined;
      return client.updateVeritySettings(patch);
    })
    .then(
      (next): SaveOutcome => {
        if (next === undefined) return 'failed';
        if (generation !== storeGeneration) return 'saved';
        // Any GET that began before this PATCH settled may carry the old
        // settings. The PATCH response is authoritative and must win even if
        // that older request arrives later.
        loadGeneration += 1;
        discardSupersededFailedKeys(patch);
        publish({
          settings: next,
          savedAt: next.updatedAt,
          applyPending: state.applyPending || requiresContainerApply(patch),
          error: failedPatches[0]?.error,
        });
        return 'saved';
      },
      (caught: unknown): SaveOutcome => {
        if (generation !== storeGeneration) return 'failed';
        const error =
          caught instanceof VerityApiError && caught.status === 503
            ? 'Unlock the secret store first.'
            : describeFailure(caught, 'Could not save settings');
        discardSupersededFailedKeys(patch);
        failedPatches.push({ patch, error });
        publish({
          // A 503 means the secret store is sealed, so a secret write cannot
          // land until it is unlocked. Say that instead of "could not save",
          // which sends the operator looking for a network problem.
          error: failedPatches[0]?.error,
        });
        return 'failed';
      },
    )
    .then((outcome) => {
      if (generation === storeGeneration) publish({ saving: state.saving - 1 });
      return outcome;
    });
  saveChain = run;
  return run;
}

/** Retry the last failed PATCH, including after the screen that created it was
 * unmounted. Returns false when the banner came from a load rather than a save. */
export async function retryFailedVeritySettings(client: VerityClient): Promise<boolean> {
  const failed = failedPatches[0];
  if (failed === undefined) return false;
  await saveVeritySettings(client, failed.patch);
  return true;
}

/**
 * Apply a local correction to the cached settings.
 *
 * For state the app learns about outside `PATCH /settings` — an agent login
 * completing, say, which the login panel reports directly. Skipped entirely
 * before the first load, so it can never conjure a settings record.
 */
export function patchVeritySettingsLocally(
  change: (settings: VeritySettings) => VeritySettings,
  requiresApply = false,
): void {
  if (state.settings === null) return;
  loadGeneration += 1;
  publish({
    settings: change(state.settings),
    applyPending: state.applyPending || requiresApply,
  });
}

/** Note that running containers now match the saved settings. */
export function clearApplyPending(): void {
  publish({ applyPending: false });
}

/** Show a settings-wide error (e.g. a sealed store discovered by a sub-panel). */
export function setVeritySettingsError(message: string | undefined): void {
  publish({ error: message });
}

/** Drop everything — one cached server's settings must never be shown as
 *  another's. Used by tests, and by anything that repoints the app. */
export function resetVeritySettingsStore(): void {
  loadGeneration += 1;
  secretStatusGeneration += 1;
  storeGeneration += 1;
  settingsFailed = false;
  secretStatusFailed = false;
  failedPatches = [];
  saveChain = Promise.resolve();
  publish(INITIAL);
}
