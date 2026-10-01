/**
 * Release notes for the Server update the operator is about to install.
 *
 * Read straight from GitHub's public releases rather than through the Server:
 * every installed Server rejects a release channel with members it does not
 * know, so the notes cannot travel in the signed document, and asking the
 * Server would leave them missing until it had already been updated past this
 * change. The notes are display-only — what gets installed is still the digest
 * the Server reported — so an unsigned source can only make them absent or
 * wrong, and either just hides the section.
 */

import {
  SERVER_RELEASES_URL,
  serverReleaseNotes,
  type ServerReleaseNotes,
  type VerityClient,
} from '@verity/mobile';
import { useEffect, useState } from 'react';

const FETCH_TIMEOUT_MS = 10_000;

// Per target and running version: the screen refreshes its status on every
// focus, and the releases of a published version do not change. The cache does
// not hold failures, so the next visit asks again.
const cache = new Map<string, ServerReleaseNotes | null>();

/** Test hook: forget every answer. */
export function resetServerReleaseNotesCache(): void {
  cache.clear();
}

async function loadReleaseNotes(
  client: VerityClient,
  target: string,
): Promise<ServerReleaseNotes | null> {
  // An older Server's health check carries no version; the notes then cover
  // the target release alone rather than a guessed range.
  const running = await client
    .getHealth()
    .then((health) => health.version)
    .catch(() => undefined);
  const key = `${running ?? ''}→${target}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(SERVER_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const notes = serverReleaseNotes(await response.json(), running, target);
    cache.set(key, notes);
    return notes;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `undefined` while loading, `null` when there is nothing to show — no
 * target, no network, a rate limit, or no notes for that range.
 */
export function useServerReleaseNotes(
  client: VerityClient,
  target: string | null,
): ServerReleaseNotes | null | undefined {
  const [state, setState] = useState<{
    target: string;
    notes: ServerReleaseNotes | null;
  } | null>(null);

  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    void loadReleaseNotes(client, target)
      .catch(() => null)
      .then((notes) => {
        if (!cancelled) setState({ target, notes });
      });
    return () => {
      cancelled = true;
    };
  }, [client, target]);

  if (target === null) return null;
  // An answer for a previous target is not one for this one.
  return state?.target === target ? state.notes : undefined;
}
