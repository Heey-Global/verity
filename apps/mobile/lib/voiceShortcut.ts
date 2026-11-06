const listeners = new Set<() => void>();

export function subscribeVoiceShortcut(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchVoiceShortcut(): void {
  for (const listener of listeners) listener();
}

/** How the V opens: listening at once (the default), or with the keyboard. */
export interface VerityRequest {
  mode?: 'voice' | 'text';
}

const verityListeners = new Set<(request: VerityRequest) => void>();

/** Opens Verity's panel; the hardware shortcut, Home and Watch handoffs use it. */
export function subscribeVerityShortcut(listener: (request: VerityRequest) => void): () => void {
  verityListeners.add(listener);
  return () => verityListeners.delete(listener);
}

export function dispatchVerityShortcut(request: VerityRequest = {}): void {
  for (const listener of verityListeners) listener(request);
}
