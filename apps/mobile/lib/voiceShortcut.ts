const listeners = new Set<() => void>();

export function subscribeVoiceShortcut(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchVoiceShortcut(): void {
  for (const listener of listeners) listener();
}

/** `assistant` preselects the Verity assistant as the target when it is available;
 * otherwise capture opens with its usual project choice. */
export interface TaskCaptureRequest {
  target?: 'assistant';
}

const taskListeners = new Set<(request: TaskCaptureRequest) => void>();

export function subscribeTaskVoiceShortcut(
  listener: (request: TaskCaptureRequest) => void,
): () => void {
  taskListeners.add(listener);
  return () => taskListeners.delete(listener);
}

export function dispatchTaskVoiceShortcut(request: TaskCaptureRequest = {}): void {
  for (const listener of taskListeners) listener(request);
}
