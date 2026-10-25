const listeners = new Set<() => void>();

export function subscribeVoiceShortcut(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchVoiceShortcut(): void {
  for (const listener of listeners) listener();
}

const taskListeners = new Set<() => void>();

export function subscribeTaskVoiceShortcut(listener: () => void): () => void {
  taskListeners.add(listener);
  return () => taskListeners.delete(listener);
}

export function dispatchTaskVoiceShortcut(): void {
  for (const listener of taskListeners) listener();
}
