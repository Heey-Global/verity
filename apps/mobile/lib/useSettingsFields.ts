// Binding a screen's text inputs to the shared settings, with auto-save on blur.
//
// Two rules this exists to keep, both of which are easy to break by hand:
//
//  1. A screen saves ONLY the keys it declares, and only those that changed.
//     `changedTextSettings` enforces it; this hook makes it the only path.
//  2. A value the operator is currently editing is never overwritten by a
//     server response — including the response to someone else's save arriving
//     on another screen. A key re-seeds from the server only while the local
//     value still matches what the server last said.
//
// Only what the operator typed is state; everything else is read through from
// the loaded settings during render. Holding a full copy of the draft in state
// and syncing it from an effect leaves one committed render where the settings
// have arrived and the copy has not — and a blur landing in that window commits
// a patch that clears both fields, because an empty draft against a populated
// record is exactly what "the operator cleared this" looks like.
import { changedTextSettings, type VerityClient, type VerityTextSettingKey } from '@verity/mobile';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { saveVeritySettings, useVeritySettings } from './settingsStore';

export type SettingsFields<K extends VerityTextSettingKey> = {
  /** Current draft values, one per declared key. */
  values: Record<K, string>;
  /** Record a keystroke. Does not save. */
  set: (key: K, value: string) => void;
  /** Save what changed. Wire to `onBlur`; a no-op when nothing changed. */
  commit: () => void;
  /** Whether any declared key differs from the stored settings. */
  dirty: boolean;
};

/**
 * @param keys the settings this screen owns. Pass a module-level constant — the
 *   array's identity drives the sync effect.
 */
export function useSettingsFields<K extends VerityTextSettingKey>(
  client: VerityClient,
  keys: readonly K[],
): SettingsFields<K> {
  const { settings } = useVeritySettings();

  const stored = useMemo(() => {
    const next = {} as Record<K, string>;
    for (const key of keys) next[key] = settings?.[key] ?? '';
    return next;
  }, [keys, settings]);

  // Keys the operator has typed into. An absent key reads from the server, so a
  // value that arrives — or changes on another screen — is shown at once, and a
  // key that is present is never overwritten while it is being edited.
  const [edits, setEdits] = useState<Partial<Record<K, string>>>({});

  const values = useMemo(() => {
    const next = {} as Record<K, string>;
    for (const key of keys) next[key] = edits[key] ?? stored[key];
    return next;
  }, [edits, keys, stored]);

  // Once the server reports back what was typed, the key stops being an edit and
  // follows the server again. This only drops entries that already agree with
  // `stored`, so it can never change what is on screen.
  useEffect(() => {
    setEdits((current) => {
      const stale = (Object.keys(current) as K[]).filter((key) => current[key] === stored[key]);
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const key of stale) delete next[key];
      return next;
    });
  }, [stored]);

  const set = useCallback((key: K, value: string) => {
    setEdits((current) => ({ ...current, [key]: value }));
  }, []);

  const patch = useMemo(() => changedTextSettings(values, settings), [settings, values]);

  const commit = useCallback(() => {
    if (Object.keys(patch).length === 0) return;
    void saveVeritySettings(client, patch);
  }, [client, patch]);

  return { values, set, commit, dirty: Object.keys(patch).length > 0 };
}
