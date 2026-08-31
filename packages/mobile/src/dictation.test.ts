import { describe, expect, it } from 'vitest';
import { composeTranscript, pickRecognitionLocale, recognitionErrorMessage } from './dictation.js';

// A realistic iOS installedLocales subset (the device reports ~63 on-device models).
const INSTALLED = ['de-AT', 'de-CH', 'de-DE', 'en-AU', 'en-GB', 'en-US', 'fr-FR'];

describe('pickRecognitionLocale', () => {
  it('returns an exact installed match for the preferred tag', () => {
    expect(pickRecognitionLocale(INSTALLED, ['de-DE', 'en-GB'])).toBe('de-DE');
  });

  it('falls back to the region when the exact language+region is not installed', () => {
    // The real bug: device locale `en-DE` (English UI, German region). en-DE is not
    // a model; the German speaker's region resolves to the installed `de-DE`.
    expect(pickRecognitionLocale(INSTALLED, ['en-DE'])).toBe('de-DE');
  });

  it('falls back to the same language when neither exact nor region match', () => {
    // `en-XX` with an uninstalled region → any installed English model.
    expect(pickRecognitionLocale(INSTALLED, ['en-NZ'])).toBe('en-AU');
  });

  it('normalizes underscore locale separators (en_US → en-US)', () => {
    expect(pickRecognitionLocale(INSTALLED, ['en_US'])).toBe('en-US');
  });

  it('walks the preferred list in order, taking the first that matches', () => {
    expect(pickRecognitionLocale(INSTALLED, ['ja-JP', 'fr-FR'])).toBe('fr-FR');
  });

  it('falls back to en-US, then the first installed, when nothing matches', () => {
    expect(pickRecognitionLocale(INSTALLED, ['ja-JP'])).toBe('en-US');
    expect(pickRecognitionLocale(['de-DE', 'fr-FR'], ['ja-JP'])).toBe('de-DE');
  });

  it('returns undefined when no on-device model is installed', () => {
    expect(pickRecognitionLocale([], ['de-DE'])).toBeUndefined();
  });
});

describe('composeTranscript', () => {
  it('returns the transcript alone when the base is empty', () => {
    expect(composeTranscript('', 'fix the login bug')).toBe('fix the login bug');
  });

  it('appends the transcript onto existing typed text with a single space', () => {
    expect(composeTranscript('Fix the', 'login bug')).toBe('Fix the login bug');
  });

  it('keeps the base unchanged when the interim transcript is empty', () => {
    expect(composeTranscript('already typed', '')).toBe('already typed');
  });

  it('trims surrounding whitespace on both sides before joining', () => {
    expect(composeTranscript('  base  ', '  spoken  ')).toBe('base spoken');
  });

  it('returns an empty string when both base and transcript are empty', () => {
    expect(composeTranscript('', '')).toBe('');
  });
});

describe('recognitionErrorMessage', () => {
  it('maps permission codes to a not-permitted message', () => {
    expect(recognitionErrorMessage('not-allowed')).toBe(
      'Speech recognition not permitted on this device',
    );
    expect(recognitionErrorMessage('service-not-allowed')).toBe(
      'Speech recognition not permitted on this device',
    );
  });

  it('maps language-not-supported to the on-device-model hint', () => {
    expect(recognitionErrorMessage('language-not-supported')).toBe(
      'This language has no on-device dictation model installed',
    );
  });

  it('maps no-speech, network, audio-capture and busy to distinct messages', () => {
    expect(recognitionErrorMessage('no-speech')).toBe('No speech detected — try again');
    expect(recognitionErrorMessage('network')).toBe(
      'Speech recognition needs a network for this language',
    );
    expect(recognitionErrorMessage('audio-capture')).toBe(
      'Microphone unavailable — close other audio apps and retry',
    );
    expect(recognitionErrorMessage('busy')).toBe('Speech recognizer is busy — try again');
  });

  it('falls back to a generic message for unknown codes (no raw code leak)', () => {
    expect(recognitionErrorMessage('something-new')).toBe('Dictation failed');
    expect(recognitionErrorMessage('')).toBe('Dictation failed');
  });
});
