import AsyncStorage from '@react-native-async-storage/async-storage';

export interface VoiceTerm {
  term: string;
  aliases: string[];
}
export interface VoiceVocabulary {
  enabled: boolean;
  terms: VoiceTerm[];
}
export const MAX_VOICE_TERMS = 100;
const STORAGE_KEY = 'verity.voiceVocabulary.v1';
export const DEFAULT_VOICE_TERMS = [
  'Verity',
  'Uplink',
  'GitHub',
  'Git',
  'Pull Request',
  'Merge',
  'Commit',
  'Branch',
  'Issue',
  'Review',
  'Rebase',
  'Cherry-Pick',
  'Fork',
  'Repository',
  'TypeScript',
  'JavaScript',
  'Node.js',
  'npm',
  'React',
  'React Native',
  'Expo',
  'Swift',
  'TestFlight',
  'App Store',
  'EAS Build',
  'CI',
  'Vitest',
  'Jest',
  'ESLint',
  'Prettier',
  'API',
  'WebSocket',
  'Docker',
  'iOS',
  'Android',
];
const DEFAULT_VARIANTS: Readonly<Record<string, string[]>> = {
  GitHub: ['git hub'],
  TypeScript: ['type script'],
  JavaScript: ['java script'],
  TestFlight: ['test flight'],
  WebSocket: ['web socket'],
};
export function defaultVoiceVocabulary(): VoiceVocabulary {
  return {
    enabled: true,
    terms: DEFAULT_VOICE_TERMS.map((term) => ({
      term,
      aliases: [...(DEFAULT_VARIANTS[term] ?? [])],
    })),
  };
}
export function validateVoiceVocabulary(value: VoiceVocabulary): VoiceVocabulary {
  if (value.terms.length > MAX_VOICE_TERMS) throw new Error('Use at most 100 terms.');
  const terms = value.terms.map(({ term, aliases }) => {
    const clean = term.trim();
    if (!clean || clean.length > 80 || clean.split(/\s+/u).length > 2) {
      throw new Error('Each term must contain one or two words, up to 80 characters.');
    }
    if (aliases.length > 20 || aliases.some((alias) => !alias.trim() || alias.length > 80)) {
      throw new Error('Use at most 20 short, nonempty variants per term.');
    }
    return { term: clean, aliases: [...new Set(aliases.map((alias) => alias.trim()))] };
  });
  return { enabled: value.enabled, terms };
}
export async function loadVoiceVocabulary(): Promise<VoiceVocabulary> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultVoiceVocabulary();
  try {
    const value = JSON.parse(raw) as VoiceVocabulary;
    if (typeof value.enabled !== 'boolean' || !Array.isArray(value.terms))
      return defaultVoiceVocabulary();
    return validateVoiceVocabulary(value);
  } catch {
    return defaultVoiceVocabulary();
  }
}
export async function saveVoiceVocabulary(value: VoiceVocabulary): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(validateVoiceVocabulary(value)));
}

const word = /[\p{L}\p{N}_]/u;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** Only call for finalized speech spans, never for the user's entire editable input. */
export function correctVoiceText(text: string, vocabulary: VoiceVocabulary): string {
  if (!vocabulary.enabled) return text;
  const replacements = new Map<string, string | null>();
  for (const { term, aliases } of vocabulary.terms) {
    for (const variant of [term, ...aliases]) {
      const key = variant.toLocaleLowerCase();
      const previous = replacements.get(key);
      replacements.set(key, previous === undefined || previous === term ? term : null);
    }
  }
  const keys = [...replacements.keys()].filter((key) => replacements.get(key) !== null);
  if (!keys.length) return text;
  const pattern = new RegExp(
    keys
      .sort((a, b) => b.length - a.length)
      .map(escapePattern)
      .join('|'),
    'giu',
  );
  // Code and address tokens must not be silently rewritten by vocabulary rules.
  const protectedRanges = [
    ...text.matchAll(
      /```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)|(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s]+|[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.(?:com|org|net|io|dev|app|edu|gov|de)(?:[/:?#][^\s]*)?|[\w.+-]+@[\w.-]+\.[\p{L}]+/giu,
    ),
  ].map((match) => [match.index, match.index + match[0].length]);
  return text.replace(pattern, (match: string, offset: number) => {
    const end = offset + match.length;
    if (
      (offset > 0 && word.test(text[offset - 1]!)) ||
      (end < text.length && word.test(text[end]!))
    )
      return match;
    if (protectedRanges.some(([start, stop]) => offset < stop! && end > start!)) return match;
    return replacements.get(match.toLocaleLowerCase()) ?? match;
  });
}
