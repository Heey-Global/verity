type SettledPermissionListener = (sessionId: string, toolUseId: string) => void;

const listeners = new Set<SettledPermissionListener>();

export function publishSettledPermission(sessionId: string, toolUseId: string): void {
  for (const listener of listeners) listener(sessionId, toolUseId);
}

export function subscribeSettledPermissions(listener: SettledPermissionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
