// Whether the GitHub App lacks a permission the operator has to grant in
// GitHub. The answer is shown on three screens (Settings, Connections and
// GitHub), so it lives here once: a grant confirmed on one screen clears the
// indicator on the others instead of leaving them a stale "Action needed".
import { type GithubAppValidateResult, type VerityClient } from '@verity/mobile';
import { useEffect, useSyncExternalStore } from 'react';

import { getVerityBaseUrl } from './client';

export type GithubPermissionState = {
  result?: GithubAppValidateResult;
  checking: boolean;
  failed: boolean;
};

// The check calls GitHub twice; revisiting a screen within this window reuses
// the answer rather than spending the App's rate limit on navigation.
const FRESH_MS = 60_000;
const IDLE: GithubPermissionState = { checking: false, failed: false };

const states = new Map<string | null, GithubPermissionState>();
const checkedAt = new Map<string | null, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(server: string | null, state: GithubPermissionState) {
  states.set(server, state);
  for (const listener of listeners) listener();
}

/** Re-reads the permissions from GitHub; `force` skips the freshness window. */
export function checkGithubPermission(client: VerityClient, force = false): Promise<void> {
  const server = getVerityBaseUrl();
  const current = states.get(server) ?? IDLE;
  if (current.checking) return Promise.resolve();
  if (!force && Date.now() - (checkedAt.get(server) ?? -Infinity) < FRESH_MS) {
    return Promise.resolve();
  }
  update(server, { ...current, checking: true });
  // Through a promise so a synchronous throw lands in the failure branch too,
  // rather than leaving the server stuck in `checking`.
  return Promise.resolve()
    .then(() => client.validateGithubApp())
    .then(
      (result) => {
        checkedAt.set(server, Date.now());
        update(server, { result, checking: false, failed: false });
      },
      () => {
        // A failed check proves nothing either way. A gap GitHub confirmed
        // earlier stays shown — dropping it would read as a granted permission —
        // and without one, nothing is claimed.
        update(server, {
          ...(current.result ? { result: current.result } : {}),
          checking: false,
          failed: true,
        });
      },
    );
}

/**
 * The permission state for the current server, checked on mount while
 * `enabled` (GitHub is connected). Without a connection there is nothing to
 * grant and nothing is fetched.
 */
export function useGithubPermission(client: VerityClient, enabled: boolean): GithubPermissionState {
  const server = getVerityBaseUrl();
  useEffect(() => {
    if (enabled) void checkGithubPermission(client);
  }, [client, enabled]);
  return useSyncExternalStore(subscribe, () => states.get(server) ?? IDLE);
}

/** True only when GitHub confirmed the missing grant — never for a failed check. */
export function githubActionNeeded(state: GithubPermissionState): boolean {
  const permission = state.result?.commitStatusPermission?.state;
  return permission === 'app_update_required' || permission === 'approval_required';
}

/** Test seam: module state otherwise leaks between test files' renders. */
export function resetGithubPermissionForTests() {
  states.clear();
  checkedAt.clear();
}
