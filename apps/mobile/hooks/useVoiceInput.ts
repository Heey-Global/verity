import { composeTranscript, pickRecognitionLocale, recognitionErrorMessage } from '@verity/mobile';
import { getLocales } from 'expo-localization';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceState = 'idle' | 'recording';

export interface UseVoiceInput {
  state: VoiceState;
  /** Last failure (permission denied / recognizer error), cleared on next start. */
  error: string | undefined;
  /** Toggle dictation: start listening (idle) or stop it (recording). */
  toggle: () => void;
  /**
   * Cancel dictation immediately, swallowing any trailing result (#133). Unlike
   * `toggle`/`stop` — which resolve to a FINAL result that would write back into the
   * field — `abort()` emits the swallowed `aborted` and gates out late results, so a
   * caller that just cleared the field (e.g. on Send) won't see it re-filled. No-op
   * when not recording.
   */
  abort: () => void;
}

/** The device's preferred language tags, most-preferred first, used only as INPUT
 * to {@link pickRecognitionLocale} (never passed raw to the recognizer). Sources,
 * in order:
 *   1. `expo-localization`'s `getLocales()` — the REAL ordered iOS/Android preferred
 *      languages (e.g. `de-DE` for a German UI). This is the reliable source.
 *   2. `Intl.DateTimeFormat().resolvedOptions().locale` — last-resort fallback. On
 *      Hermes this returns a mangled UI-language + region combo (e.g. `en-DE`); the
 *      matcher's region step still maps that to the installed `de-DE`, so it's a safe
 *      backstop if `getLocales()` ever yields nothing. */
function preferredLanguageTags(): string[] {
  const tags: string[] = [];
  try {
    for (const l of getLocales()) {
      if (typeof l.languageTag === 'string' && l.languageTag) tags.push(l.languageTag);
    }
  } catch {
    // expo-localization unavailable — fall through to Intl.
  }
  try {
    const intl = Intl.DateTimeFormat().resolvedOptions().locale;
    if (intl) tags.push(intl);
  } catch {
    // Intl unavailable — keep whatever getLocales provided.
  }
  return tags;
}

/** Resolve the recognition locale + whether it can run on-device, by matching the
 * operator's preferred languages against the device's installed on-device models.
 * Prefers an installed locale (on-device); falls back to the network recognizer for
 * the first preferred tag when no model is installed or the query fails. */
async function resolveRecognitionLocale(): Promise<{ lang: string; onDevice: boolean }> {
  const preferred = preferredLanguageTags();
  try {
    const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    const picked = pickRecognitionLocale(installedLocales, preferred);
    if (picked) return { lang: picked, onDevice: true };
  } catch {
    // getSupportedLocales can throw on some devices — fall through to the network.
  }
  return { lang: preferred[0] ?? 'en-US', onDevice: false };
}

/**
 * Live voice dictation via the OS speech recognizer (`expo-speech-recognition`:
 * iOS `SFSpeechRecognizer`, Android `SpeechRecognizer`). Unlike the previous
 * record→upload→Whisper flow, recognition streams: interim transcripts arrive as
 * the operator speaks and are written straight into the input field, so the text
 * builds up live instead of appearing all at once after a server round-trip.
 *
 * This is the RN platform glue (native module + permission + event wiring) that
 * can't be unit-tested headless; the pure join logic lives in `composeTranscript`
 * (tested in @verity/mobile). The hook drives `value`/`onChangeText` directly: it
 * snapshots `value` at start and appends the running transcript onto that base,
 * committing each finalized segment so a continuous dictation accumulates.
 */
export function useVoiceInput(value: string, onChangeText: (next: string) => void): UseVoiceInput {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | undefined>(undefined);

  // Text in the field when dictation began + each finalized segment appended to
  // it. The live (interim) transcript is composed onto this without mutating it,
  // so partial results replace cleanly rather than stacking.
  const baseRef = useRef('');
  // True only while a recognition session is active. The `result` listener is
  // always subscribed, so this gates out any stray/late result delivered after
  // stop()/end (which would otherwise still mutate the field).
  const listeningRef = useRef(false);
  // Hold the latest setter in a ref so the (subscribed-once) event handlers
  // always call the current `onChangeText` without re-binding listeners.
  const onChangeRef = useRef(onChangeText);
  onChangeRef.current = onChangeText;

  useSpeechRecognitionEvent('result', (event) => {
    if (!listeningRef.current) return; // ignore stray/late results after stop
    const transcript = event.results[0]?.transcript ?? '';
    const next = composeTranscript(baseRef.current, transcript);
    onChangeRef.current(next);
    // A finalized segment becomes the new base so the next segment appends after
    // it (continuous mode emits one final result per utterance/pause).
    if (event.isFinal) baseRef.current = next;
  });

  useSpeechRecognitionEvent('end', () => {
    listeningRef.current = false;
    setState('idle');
  });

  useSpeechRecognitionEvent('error', (event) => {
    listeningRef.current = false;
    // `aborted` fires when recognition is cancelled (e.g. abort()) rather than
    // finished — not a user-facing failure, so swallow it.
    if (event.error === 'aborted') return;
    setError(recognitionErrorMessage(event.error));
    setState('idle');
  });

  const start = useCallback(() => {
    // Claim the session synchronously so a second tap during the async permission
    // request can't kick off a parallel start() (which would emit `busy`). Cleared
    // on a denied/failed start, and on end/error once a real session finishes.
    if (listeningRef.current) return;
    listeningRef.current = true;
    setError(undefined);
    void (async () => {
      try {
        const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!permission.granted) {
          listeningRef.current = false;
          setError('Microphone / speech-recognition permission denied');
          return;
        }
        baseRef.current = value.trim();
        // Resolve a locale that has an on-device model INSTALLED, matched to the
        // operator's preferred languages — so recognition stays on-device (private,
        // offline) AND we never request an invalid locale (the `en-DE` failure). If
        // the device has no on-device models at all, fall back to the network
        // recognizer for the first preferred tag.
        const { lang, onDevice } = await resolveRecognitionLocale();
        ExpoSpeechRecognitionModule.start({
          lang,
          // Stream partial results so the field fills in live as we speak.
          interimResults: true,
          // Keep listening through pauses until the operator taps stop.
          continuous: true,
          requiresOnDeviceRecognition: onDevice,
        });
        setState('recording');
      } catch {
        listeningRef.current = false;
        setError('Could not start dictation');
        setState('idle');
      }
    })();
  }, [value]);

  const toggle = useCallback(() => {
    if (state === 'recording') {
      // Resolves to a final `result` then `end` → state flips to idle there.
      ExpoSpeechRecognitionModule.stop();
    } else {
      start();
    }
  }, [state, start]);

  // End dictation NOW without a trailing final result (#133). Drops the listening
  // gate first so any late `result` is ignored, then cancels the recognizer and
  // flips to idle immediately (don't wait on the native `aborted`/`end` event). A
  // no-op when no session is active, so callers can fire it unconditionally.
  const abort = useCallback(() => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    ExpoSpeechRecognitionModule.abort();
    setState('idle');
  }, []);

  // Tear down a live session if the screen unmounts mid-recording (e.g. the new-
  // agent screen navigates away on start). The event listeners auto-detach, but
  // the native recognizer would otherwise keep holding the mic until it faults.
  // `abort()` (not `stop()`) — no final result to wait for; it emits the swallowed
  // `aborted` rather than a user-facing error.
  useEffect(() => {
    return () => {
      if (listeningRef.current) {
        listeningRef.current = false;
        ExpoSpeechRecognitionModule.abort();
      }
    };
  }, []);

  return { state, error, toggle, abort };
}
