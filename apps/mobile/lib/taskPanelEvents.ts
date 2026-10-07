const listeners = new Set<() => void>();
export function openTasksPanel(): void {
  for (const listener of listeners) listener();
}
export function subscribeTasksPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
