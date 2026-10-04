import { useSyncExternalStore } from 'react';
import { getVerityBaseUrl } from './client';

const pending = new Set<string | null>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isServerUpdateChannelWritePending(server = getVerityBaseUrl()): boolean {
  return pending.has(server);
}

export function setServerUpdateChannelWritePending(value: boolean, server = getVerityBaseUrl()) {
  if (value) pending.add(server);
  else pending.delete(server);
  for (const listener of listeners) listener();
}

// Separate settings routes must agree before offering an install target.
export function useServerUpdateChannelWritePending() {
  const server = getVerityBaseUrl();
  return useSyncExternalStore(subscribe, () => isServerUpdateChannelWritePending(server));
}
