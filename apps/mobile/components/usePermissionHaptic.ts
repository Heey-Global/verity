import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';

/**
 * One warning tap when a permission prompt (tool approval, secret request, email
 * send, plan approval — they all arrive as `pendingPermission`) newly blocks the
 * agent. Only a fresh transition taps: whatever is already pending once the
 * backlog drains (`loaded`) is seeded as seen, so opening a waiting session or
 * reconnecting to one does not buzz, and a prompt re-delivered under the same
 * `toolUseId` never taps twice. `loaded` dropping back (a new session model)
 * resets the seed, so the previous session's prompt cannot leak into the next.
 */
export function usePermissionHaptic(loaded: boolean, toolUseId: string | undefined): void {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded) {
      seen.current = null;
      return;
    }
    if (seen.current === null) {
      seen.current = new Set(toolUseId === undefined ? [] : [toolUseId]);
      return;
    }
    if (toolUseId === undefined || seen.current.has(toolUseId)) return;
    seen.current.add(toolUseId);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, [loaded, toolUseId]);
}
