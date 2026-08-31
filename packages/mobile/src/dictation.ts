/**
 * Live-dictation text composition (pure → unit-testable). The RN voice hook
 * (`useVoiceInput`) snapshots the input field's text at the moment dictation
 * starts ("base") and, as on-device speech recognition streams interim/final
 * transcripts in, joins the running transcript onto that base so the recognized
 * words appear live in the field. Kept pure and separate from the native-module
 * glue so the join rules (spacing, empties) are tested without a device.
 */
export function composeTranscript(base: string, transcript: string): string {
  const b = base.trim();
  const t = transcript.trim();
  if (!b) return t;
  if (!t) return b;
  return `${b} ${t}`;
}

/**
 * Choose a speech-recognition locale that actually has an on-device model
 * installed, from the operator's ordered preferred languages.
 *
 * Why this exists: the hook must NOT pass the raw device locale to the recognizer.
 * Hermes' `Intl` returns the UI-language + region combo (e.g. `en-DE` for an
 * English UI in Germany) — not a valid recognition locale — so on-device fails with
 * `language-not-supported` even though the matching model (e.g. `de-DE`) is right
 * there installed. We instead match each preferred tag against the device's
 * `installedLocales` in priority order:
 *   1. exact tag        (`de-DE` → `de-DE`)
 *   2. same region      (`en-DE` → `de-DE`: a German speaker with an English UI)
 *   3. same language    (`de-XX` → another installed `de-*`)
 * then fall back to `en-US` / the first installed locale. The result is always an
 * installed locale, so the caller can keep `requiresOnDeviceRecognition: true`.
 * Returns `undefined` only when nothing is installed (caller falls back to network).
 */
export function pickRecognitionLocale(
  installed: readonly string[],
  preferred: readonly string[],
): string | undefined {
  const inst = installed.map((l) => l.replace(/_/g, '-'));
  if (inst.length === 0) return undefined;
  const lc = (s: string | undefined): string => (s ?? '').toLowerCase();
  const find = (pred: (l: string) => boolean): string | undefined => inst.find(pred);
  for (const raw of preferred) {
    const tag = raw.replace(/_/g, '-');
    const [lang, region] = tag.split('-');
    const exact = find((l) => lc(l) === lc(tag));
    if (exact) return exact;
    const byRegion = region ? find((l) => lc(l.split('-')[1]) === lc(region)) : undefined;
    if (byRegion) return byRegion;
    const byLang = lang ? find((l) => lc(l.split('-')[0]) === lc(lang)) : undefined;
    if (byLang) return byLang;
  }
  return find((l) => lc(l) === 'en-us') ?? inst[0];
}

/**
 * Map a speech-recognition error code (the Web-Speech-style `error` field
 * `expo-speech-recognition` emits) to a short operator-facing message. Pure +
 * tested here; the hook just surfaces the returned string. Unknown/other codes
 * fall back to a generic message rather than leaking a raw code to the UI.
 */
export function recognitionErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Speech recognition not permitted on this device';
    case 'no-speech':
      return 'No speech detected — try again';
    case 'language-not-supported':
      return 'This language has no on-device dictation model installed';
    case 'network':
      return 'Speech recognition needs a network for this language';
    case 'audio-capture':
      return 'Microphone unavailable — close other audio apps and retry';
    case 'busy':
      return 'Speech recognizer is busy — try again';
    default:
      return 'Dictation failed';
  }
}
