import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ScrollAnchor } from './transcriptAnchor';

const SCROLL_ANCHOR_PREFIX = 'verity.scrollAnchor.v3:';

export const SCROLL_DIRECTION_EPSILON = 6;
export const SCROLL_BOTTOM_BOUNCE_EPSILON = 36;
export const SCROLL_STALE_DELTA_VIEWPORTS = 1.5;
export const SCROLL_STALE_DELTA_MIN = 900;

export function loadScrollAnchor(sessionId: string): Promise<ScrollAnchor | null> {
  return AsyncStorage.getItem(SCROLL_ANCHOR_PREFIX + sessionId)
    .then((raw) => {
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      return {
        rowKey: typeof record.rowKey === 'string' ? record.rowKey : null,
        messageId: typeof record.messageId === 'string' ? record.messageId : null,
        atBottom: record.atBottom !== false,
        offsetY:
          typeof record.offsetY === 'number' && Number.isFinite(record.offsetY)
            ? Math.max(0, record.offsetY)
            : null,
        coordinateSystem:
          typeof record.coordinateSystem === 'string' ? record.coordinateSystem : undefined,
      };
    })
    .catch(() => null);
}

export function saveScrollAnchor(sessionId: string, anchor: ScrollAnchor): void {
  void AsyncStorage.setItem(SCROLL_ANCHOR_PREFIX + sessionId, JSON.stringify(anchor)).catch(
    () => undefined,
  );
}

export function scrollAnchorDebug(
  prefix: 'anchor' | 'target',
  anchor: ScrollAnchor,
): Record<string, boolean | number> {
  return {
    [`${prefix}AtBottom`]: anchor.atBottom,
    [`${prefix}HasRowKey`]: anchor.rowKey !== null,
    [`${prefix}HasMessageId`]: anchor.messageId !== null,
    ...(anchor.offsetY !== null ? { [`${prefix}OffsetY`]: anchor.offsetY } : {}),
  };
}

export function createPersistedStringSet(storageKey: string): {
  store: Set<string>;
  loaded: () => boolean;
  load: () => Promise<void>;
  persist: () => void;
} {
  const store = new Set<string>();
  let isLoaded = false;
  let loading: Promise<void> | null = null;
  const load = (): Promise<void> => {
    if (isLoaded) return Promise.resolve();
    if (loading) return loading;
    loading = AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!raw) return;
        const keys: unknown = JSON.parse(raw);
        if (!Array.isArray(keys)) return;
        for (const key of keys) if (typeof key === 'string') store.add(key);
      })
      .catch(() => undefined)
      .finally(() => {
        isLoaded = true;
        loading = null;
      });
    return loading;
  };
  const persist = (): void => {
    void AsyncStorage.setItem(storageKey, JSON.stringify([...store])).catch(() => undefined);
  };
  return { store, loaded: () => isLoaded, load, persist };
}
