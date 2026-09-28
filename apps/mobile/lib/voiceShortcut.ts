const listeners = new Set<() => void>();

export function subscribeVoiceShortcut(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchVoiceShortcut(): void {
  for (const listener of listeners) listener();
}
