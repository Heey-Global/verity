import { composeTranscript, pickRecognitionLocale, recognitionErrorMessage } from '@verity/mobile';
import { getLocales } from 'expo-localization';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isDemoMode } from '../lib/demoMode';

let recognitionOwner: symbol | null = null;
let abandonedRecognition = false;
// Native cancellation finishes asynchronously. Hold ownership through its final
// end event so that event cannot accidentally end a newly mounted recorder.
ExpoSpeechRecognitionModule.addListener('end', () => {
  if (abandonedRecognition) {
    recognitionOwner = null;
    abandonedRecognition = false;
  }
});

export type VoiceState = 'idle' | 'recording';

export interface UseVoiceInput {
  state: VoiceState;
  autoMode: boolean;
  countdown: number | null;
  /** Last failure (permission denied / recognizer error), cleared on next start. */
  error: string | undefined;
  /** Toggle dictation: start listening (idle) or stop it (recording). */
  toggle: () => void;
  startAuto: () => void;
  pauseCountdown: () => void;
  onComposerEdit: (text: string) => void;
  /**
   * Cancel dictation immediately, swallowing any trailing result (#133). Unlike
   * `toggle`/`stop` — which resolve to a FINAL result that would write back into the
   * field — `abort()` emits the swallowed `aborted` and gates out late results, so a
   * caller that just cleared the field (e.g. on Send) won't see it re-filled. No-op
   * when not recording.
   */
  abort: () => void;
  level: number;
  onDevice: boolean | null;
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

/** Reduce a recognizer transcript to its words. iOS 18 prefixes every result
 * after a pause-final with a space and may re-punctuate or re-case the repeat it
 * emits on stop, so a strict string match lets it through. */
function utteranceWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s.,!?;:'"„“”‚‘’«»¿¡…()\-–—。、，！？：；]+/g, ' ')
    .trim();
}

function sameUtterance(a: string, b: string): boolean {
  const wa = utteranceWords(a);
  return wa !== '' && wa === utteranceWords(b);
}

/** True when `partial` is the committed final or a word-aligned start of it —
 * how a replay streams in after stop. */
function replaysUtterance(partial: string, final: string): boolean {
  const wp = utteranceWords(partial);
  const wf = utteranceWords(final);
  return wp !== '' && (wf === wp || wf.startsWith(`${wp} `));
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
export function useVoiceInput(
  value: string,
  onChangeText: (next: string) => void,
  onAutoSend?: (text: string) => Promise<boolean>,
  options?: { silenceMs?: number },
): UseVoiceInput {
  const owner = useRef(Symbol('voice-input'));
  const nativeStarted = useRef(false);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [level, setLevel] = useState(0);
  const [onDevice, setOnDevice] = useState<boolean | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clearSilence = () => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    silenceTimer.current = null;
  };
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [autoMode, setAutoMode] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const autoModeRef = useRef(false);
  const disposedRef = useRef(false);
  const pausedRef = useRef(false);
  const sendingRef = useRef(false);
  const editedDuringSendRef = useRef(false);
  const finalReadyRef = useRef(false);
  const interimActiveRef = useRef(false);
  const ignoreCurrentUtteranceRef = useRef(false);
  const lastFinalTranscriptRef = useRef('');
  // Set when the operator taps stop. If no utterance was open at that moment,
  // anything the recognizer replays of the last final (interim or final) is a
  // repeat of committed text, not new speech.
  const stoppingRef = useRef(false);
  const utteranceOpenAtStopRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSendRef = useRef(onAutoSend);
  autoSendRef.current = onAutoSend;
  const cancelCountdown = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setCountdown(null);
  }, []);

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

  const startCountdown = useCallback(() => {
    if (
      disposedRef.current ||
      !autoModeRef.current ||
      pausedRef.current ||
      sendingRef.current ||
      !baseRef.current.trim()
    )
      return;
    cancelCountdown();
    let remaining = 3;
    setCountdown(remaining);
    timerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setCountdown(remaining);
        return;
      }
      cancelCountdown();
      if (disposedRef.current || !autoModeRef.current || sendingRef.current) return;
      const send = autoSendRef.current;
      if (!send) return;
      sendingRef.current = true;
      editedDuringSendRef.current = false;
      finalReadyRef.current = false;
      const submitted = baseRef.current.trim();
      baseRef.current = '';
      onChangeRef.current('');
      void send(submitted)
        .then((accepted) => {
          if (disposedRef.current) return;
          if (!accepted && !editedDuringSendRef.current) {
            baseRef.current = composeTranscript(submitted, baseRef.current);
            onChangeRef.current(baseRef.current);
          }
        })
        .catch(() => {
          if (disposedRef.current) return;
          if (!editedDuringSendRef.current) {
            baseRef.current = composeTranscript(submitted, baseRef.current);
            onChangeRef.current(baseRef.current);
          }
        })
        .finally(() => {
          sendingRef.current = false;
          if (!disposedRef.current && finalReadyRef.current) startCountdown();
        });
    }, 1800);
  }, [cancelCountdown]);

  useSpeechRecognitionEvent('speechstart', () => {
    if (recognitionOwner === owner.current) clearSilence();
  });
  useSpeechRecognitionEvent('speechend', () => {
    if (
      recognitionOwner !== owner.current ||
      !listeningRef.current ||
      !optionsRef.current?.silenceMs ||
      stoppingRef.current
    )
      return;
    clearSilence();
    silenceTimer.current = setTimeout(() => {
      if (recognitionOwner !== owner.current || !listeningRef.current) return;
      stoppingRef.current = true;
      utteranceOpenAtStopRef.current = interimActiveRef.current;
      ExpoSpeechRecognitionModule.stop();
    }, optionsRef.current.silenceMs);
  });
  useSpeechRecognitionEvent('volumechange', (event) => {
    if (recognitionOwner !== owner.current || !listeningRef.current) return;
    setLevel(Math.max(0, Math.min(1, (event.value + 2) / 12)));
    if (event.value > 0) clearSilence();
    else if (
      (baseRef.current.trim() || interimActiveRef.current) &&
      !silenceTimer.current &&
      optionsRef.current?.silenceMs
    ) {
      silenceTimer.current = setTimeout(() => {
        silenceTimer.current = null;
        if (recognitionOwner !== owner.current || !listeningRef.current) return;
        stoppingRef.current = true;
        utteranceOpenAtStopRef.current = interimActiveRef.current;
        ExpoSpeechRecognitionModule.stop();
      }, optionsRef.current.silenceMs);
    }
  });
  useSpeechRecognitionEvent('result', (event) => {
    if (recognitionOwner !== owner.current) return;
    if (!listeningRef.current) return; // ignore stray/late results after stop
    const transcript = event.results[0]?.transcript ?? '';
    if (ignoreCurrentUtteranceRef.current) {
      if (event.isFinal) {
        ignoreCurrentUtteranceRef.current = false;
        interimActiveRef.current = false;
        lastFinalTranscriptRef.current = transcript;
      }
      return;
    }
    // Native stop can repeat an already committed final result before `end`,
    // sometimes as an interim first. A new interim result before stop
    // distinguishes an intentional repeated utterance.
    const repeatsLastFinal = sameUtterance(transcript, lastFinalTranscriptRef.current);
    if (
      stoppingRef.current &&
      !utteranceOpenAtStopRef.current &&
      (event.isFinal
        ? repeatsLastFinal
        : replaysUtterance(transcript, lastFinalTranscriptRef.current))
    ) {
      // A replay interim the prefix check missed (e.g. a mid-word partial) may
      // be on screen; its final is the replay, so restore the committed text.
      if (event.isFinal && interimActiveRef.current) {
        interimActiveRef.current = false;
        onChangeRef.current(baseRef.current);
      }
      return;
    }
    if (event.isFinal && !interimActiveRef.current && repeatsLastFinal) return;
    if (transcript.trim()) {
      cancelCountdown();
      if (!event.isFinal || !repeatsLastFinal) {
        pausedRef.current = false;
      }
    }
    if (!event.isFinal) {
      finalReadyRef.current = false;
      interimActiveRef.current = true;
    }
    const next = composeTranscript(baseRef.current, transcript);
    onChangeRef.current(next);
    // A finalized segment becomes the new base so the next segment appends after
    // it (continuous mode emits one final result per utterance/pause).
    if (event.isFinal) {
      interimActiveRef.current = false;
      lastFinalTranscriptRef.current = transcript;
      baseRef.current = next;
      // The utterance open at stop is now committed; further replays of it are repeats.
      if (stoppingRef.current) utteranceOpenAtStopRef.current = false;
      finalReadyRef.current = true;
      startCountdown();
    }
  });

  useSpeechRecognitionEvent('end', () => {
    if (recognitionOwner !== owner.current) return;
    recognitionOwner = null;
    nativeStarted.current = false;
    clearSilence();
    listeningRef.current = false;
    autoModeRef.current = false;
    setAutoMode(false);
    cancelCountdown();
    setState('idle');
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (recognitionOwner !== owner.current) return;
    clearSilence();
    listeningRef.current = false;
    autoModeRef.current = false;
    setAutoMode(false);
    cancelCountdown();
    // `aborted` fires when recognition is cancelled (e.g. abort()) rather than
    // finished — not a user-facing failure, so swallow it.
    if (event.error === 'aborted') return;
    setError(recognitionErrorMessage(event.error));
    setState('idle');
  });

  const start = useCallback(() => {
    if (isDemoMode()) {
      setError(
        'Voice input is unavailable in the local demo. Type a message to try the simulated agent.',
      );
      return;
    }
    // Claim the session synchronously so a second tap during the async permission
    // request can't kick off a parallel start() (which would emit `busy`). Cleared
    // on a denied/failed start, and on end/error once a real session finishes.
    if (listeningRef.current) return;
    if (recognitionOwner !== null) {
      setError('Another voice recording is active');
      autoModeRef.current = false;
      setAutoMode(false);
      return;
    }
    recognitionOwner = owner.current;
    listeningRef.current = true;
    setError(undefined);
    void (async () => {
      try {
        const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (disposedRef.current || !listeningRef.current) return;
        if (!permission.granted) {
          recognitionOwner = null;
          listeningRef.current = false;
          autoModeRef.current = false;
          setAutoMode(false);
          setError('Microphone / speech-recognition permission denied');
          return;
        }
        baseRef.current = value.trim();
        finalReadyRef.current = false;
        interimActiveRef.current = false;
        ignoreCurrentUtteranceRef.current = false;
        lastFinalTranscriptRef.current = '';
        stoppingRef.current = false;
        utteranceOpenAtStopRef.current = false;
        // Resolve a locale that has an on-device model INSTALLED, matched to the
        // operator's preferred languages — so recognition stays on-device (private,
        // offline) AND we never request an invalid locale (the `en-DE` failure). If
        // the device has no on-device models at all, fall back to the network
        // recognizer for the first preferred tag.
        const { lang, onDevice } = await resolveRecognitionLocale();
        if (disposedRef.current || !listeningRef.current) return;
        setOnDevice(onDevice);
        nativeStarted.current = true;
        ExpoSpeechRecognitionModule.start({
          volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
          lang,
          // Stream partial results so the field fills in live as we speak.
          interimResults: true,
          // Keep listening through pauses until the operator taps stop.
          continuous: true,
          requiresOnDeviceRecognition: onDevice,
        });
        setState('recording');
      } catch {
        if (recognitionOwner === owner.current) recognitionOwner = null;
        listeningRef.current = false;
        autoModeRef.current = false;
        setAutoMode(false);
        setError('Could not start dictation');
        setState('idle');
      }
    })();
  }, [value]);

  const toggle = useCallback(() => {
    if (state === 'recording') {
      autoModeRef.current = false;
      setAutoMode(false);
      cancelCountdown();
      stoppingRef.current = true;
      utteranceOpenAtStopRef.current = interimActiveRef.current;
      // Resolves to a final `result` then `end` → state flips to idle there.
      ExpoSpeechRecognitionModule.stop();
    } else {
      start();
    }
  }, [state, start, cancelCountdown]);

  const startAuto = useCallback(() => {
    if (autoModeRef.current) {
      toggle();
      return;
    }
    autoModeRef.current = true;
    pausedRef.current = false;
    setAutoMode(true);
    if (!listeningRef.current) start();
  }, [start, toggle]);

  const pauseCountdown = useCallback(() => {
    pausedRef.current = true;
    cancelCountdown();
  }, [cancelCountdown]);

  const onComposerEdit = useCallback(
    (text: string) => {
      if (!listeningRef.current && !sendingRef.current) return;
      if (sendingRef.current) editedDuringSendRef.current = true;
      if (interimActiveRef.current) ignoreCurrentUtteranceRef.current = true;
      baseRef.current = text;
      finalReadyRef.current = false;
      if (autoModeRef.current) pauseCountdown();
    },
    [pauseCountdown],
  );

  // End dictation NOW without a trailing final result (#133). Drops the listening
  // gate first so any late `result` is ignored, then cancels the recognizer and
  // flips to idle immediately (don't wait on the native `aborted`/`end` event). A
  // no-op when no session is active, so callers can fire it unconditionally.
  const abort = useCallback(() => {
    autoModeRef.current = false;
    pausedRef.current = false;
    setAutoMode(false);
    cancelCountdown();
    if (!listeningRef.current) return;
    listeningRef.current = false;
    clearSilence();
    if (!nativeStarted.current && recognitionOwner === owner.current) recognitionOwner = null;
    if (nativeStarted.current) ExpoSpeechRecognitionModule.abort();
    setState('idle');
  }, [cancelCountdown]);

  // Tear down a live session if the screen unmounts mid-recording (e.g. the new-
  // agent screen navigates away on start). The event listeners auto-detach, but
  // the native recognizer would otherwise keep holding the mic until it faults.
  // `abort()` (not `stop()`) — no final result to wait for; it emits the swallowed
  // `aborted` rather than a user-facing error.
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      autoModeRef.current = false;
      clearSilence();
      if (recognitionOwner === owner.current) {
        if (nativeStarted.current) {
          abandonedRecognition = true;
          ExpoSpeechRecognitionModule.abort();
        } else recognitionOwner = null;
      }
      listeningRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return {
    state,
    level,
    onDevice,
    error,
    autoMode,
    countdown,
    toggle,
    startAuto,
    pauseCountdown,
    onComposerEdit,
    abort,
  };
}
