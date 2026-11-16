import { useSyncExternalStore } from 'react';

/**
 * Whether Home shows its own way to Verity right now — her header and the
 * "Tell Verity" field of the new design, on a phone. The floating V steps back
 * then, rather than sitting on top of Home's cards as a second way in.
 */
let shown = false;
const listeners = new Set<() => void>();

export function setHomeShowsVerity(next: boolean): void {
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}

export function useHomeShowsVerity(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
  );
}
