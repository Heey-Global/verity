// The attach menu's recent-image strip: the newest library images, screenshots
// first, kept current while the menu is open so a screenshot taken meanwhile
// shows up at the front. Attaching stays a deliberate tap; nothing here attaches.
import * as MediaLibrary from 'expo-media-library/legacy';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';

const RECENT_IMAGE_LIMIT = 10;

interface RecentImage {
  id: string;
  uri: string;
}

export type RecentImages =
  /** No photo library on this platform (web): the menu keeps its "Take photo" row. */
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  /** Access refused; the strip offers a tile that opens the system settings. */
  | { kind: 'denied' }
  /** The library could not be read although access was granted: the camera tile only. */
  | { kind: 'failed' }
  /** `limited`: iOS shares only the photos the user picked, so the strip offers "Manage". */
  | { kind: 'ready'; images: RecentImage[]; limited: boolean };

/**
 * Screenshots first, then the other newest images, without duplicates. Both
 * inputs are newest first; a screenshot also appears in the general query.
 */
function mergeRecentImages(
  screenshots: readonly RecentImage[],
  recent: readonly RecentImage[],
  limit = RECENT_IMAGE_LIMIT,
): RecentImage[] {
  const seen = new Set<string>();
  const merged: RecentImage[] = [];
  for (const image of [...screenshots, ...recent]) {
    if (seen.has(image.id)) continue;
    seen.add(image.id);
    merged.push(image);
    if (merged.length === limit) break;
  }
  return merged;
}

const query = async (screenshots: boolean): Promise<RecentImage[]> => {
  const page = await MediaLibrary.getAssetsAsync({
    first: RECENT_IMAGE_LIMIT,
    mediaType: MediaLibrary.MediaType.photo,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    ...(screenshots ? { mediaSubtypes: ['screenshot' as const] } : {}),
  });
  return page.assets.map((asset) => ({ id: asset.id, uri: asset.uri }));
};

async function loadRecentImages(ask: boolean): Promise<RecentImages> {
  let permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  // The first open of the menu is when the strip is wanted, so that is when iOS asks.
  if (permission.status === 'undetermined' && permission.canAskAgain && ask)
    permission = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
  if (permission.status !== 'granted') return { kind: 'denied' };
  // Only iOS knows screenshots as a subtype (and only there is the filter an
  // option); elsewhere the strip is simply the newest images.
  const [screenshots, recent] = await Promise.all([
    Platform.OS === 'ios' ? query(true) : Promise.resolve([]),
    query(false),
  ]);
  return {
    kind: 'ready',
    images: mergeRecentImages(screenshots, recent),
    limited: permission.accessPrivileges === 'limited',
  };
}

/** Recent images while `active` (the menu is open), reloaded on library changes. */
export function useRecentImages(active: boolean): {
  state: RecentImages;
  openSettings: () => void;
  manageLimited: () => void;
} {
  const [state, setState] = useState<RecentImages>(
    Platform.OS === 'web' ? { kind: 'unavailable' } : { kind: 'loading' },
  );
  // A slower earlier load must not overwrite the result of a later one.
  const generation = useRef(0);
  const reload = useCallback((ask: boolean) => {
    const current = ++generation.current;
    loadRecentImages(ask)
      .then((next) => {
        if (current === generation.current) setState(next);
      })
      // An unreadable library leaves the camera tile, not an alert, and not a
      // Settings tile that could not fix it.
      .catch(() => {
        if (current === generation.current) setState({ kind: 'failed' });
      });
  }, []);
  useEffect(() => {
    if (!active || Platform.OS === 'web') return;
    reload(true);
    const subscription = MediaLibrary.addListener(() => reload(false));
    const foreground = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        setState({ kind: 'loading' });
        reload(false);
      }
    });
    return () => {
      generation.current += 1;
      subscription.remove();
      foreground.remove();
      setState({ kind: 'loading' });
    };
  }, [active, reload]);
  const openSettings = useCallback(() => void Linking.openSettings(), []);
  const manageLimited = useCallback(() => {
    const current = generation.current;
    void MediaLibrary.presentPermissionsPickerAsync(['photo'])
      .then(() => {
        if (current === generation.current) reload(false);
      })
      .catch(() => undefined);
  }, [reload]);
  return { state, openSettings, manageLimited };
}
