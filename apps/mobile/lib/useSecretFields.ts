// Binding a screen's write-only paste boxes to the shared settings.
//
// Unlike ordinary text fields these have no server-side value to compare
// against: the server reports only whether a credential is configured, never
// what it is. So the rules are different, and all three live here:
//
//  1. A blank box is not a change. It must never reach the server, because a
//     `null` there clears a credential the operator only meant to leave alone.
//  2. The plaintext is dropped from component state the moment the request owns
//     a copy — a slow or failed network call must not park a private key in a
//     mounted component for minutes.
//  3. A failed save puts it back, but only into a box the operator has not
//     started refilling in the meantime.
import { changedSecretSettings, type SecretPasteKey, type VerityClient } from '@verity/mobile';
import { useCallback, useMemo, useRef, useState } from 'react';

import { saveVeritySettings } from './settingsStore';

export type SecretFields<K extends SecretPasteKey> = {
  /** Current box contents, one per declared key. Empty after a successful save. */
  values: Record<K, string>;
  set: (key: K, value: string) => void;
  /** Save the filled boxes. Wire to `onBlur`; a no-op when all are empty. */
  commit: () => void;
  /** Whether any declared box holds something worth saving. */
  dirty: boolean;
};

/**
 * @param keys the credentials this screen renders. Pass a module-level constant.
 */
export function useSecretFields<K extends SecretPasteKey>(
  client: VerityClient,
  keys: readonly K[],
): SecretFields<K> {
  const empty = useMemo(() => {
    const next = {} as Record<K, string>;
    for (const key of keys) next[key] = '';
    return next;
  }, [keys]);

  const [values, setValues] = useState<Record<K, string>>(empty);
  // The committed snapshot is read outside React's render cycle, so `commit`
  // cannot capture a value one keystroke out of date.
  const latest = useRef(values);

  const set = useCallback((key: K, value: string) => {
    const next = { ...latest.current, [key]: value };
    latest.current = next;
    setValues(next);
  }, []);

  const commit = useCallback(() => {
    const submitted = latest.current;
    const patch = changedSecretSettings(submitted);
    if (Object.keys(patch).length === 0) return;
    latest.current = empty;
    setValues(empty);
    void saveVeritySettings(client, patch).then((outcome) => {
      if (outcome === 'saved') return;
      setValues((current) => {
        const restored = { ...current };
        for (const key of Object.keys(submitted) as K[]) {
          if (restored[key] === '') restored[key] = submitted[key];
        }
        latest.current = restored;
        return restored;
      });
    });
  }, [client, empty]);

  const dirty = Object.keys(changedSecretSettings(values)).length > 0;

  return { values, set, commit, dirty };
}
