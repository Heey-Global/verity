import { useSyncExternalStore } from 'react';

/**
 * The previews the session list last saw: session id → the URL its preview
 * marker opens (null while a public share has no origin yet), and which of them
 * are shared online. `useProjects` on Home polls them; a project's Work list,
 * which is its own screen on a phone, reads the same result here instead of
 * starting a second poll.
 */
export interface SessionPreviews {
  urls: ReadonlyMap<string, string | null>;
  online: ReadonlySet<string>;
}

let current: SessionPreviews = { urls: new Map(), online: new Set() };
const listeners = new Set<() => void>();

export function publishSessionPreviews(next: SessionPreviews): void {
  if (next.urls === current.urls && next.online === current.online) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionPreviews(): SessionPreviews {
  return useSyncExternalStore(subscribe, () => current);
}
