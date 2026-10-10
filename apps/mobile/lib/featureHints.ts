import AsyncStorage from '@react-native-async-storage/async-storage';

export const FEATURE_HINT_KEYS = [
  'preview-and-sharing',
  'review-and-pull-requests',
  'live-meeting',
] as const;
export type FeatureHintKey = (typeof FEATURE_HINT_KEYS)[number];
const storageKey = (key: FeatureHintKey) => `verity.hints.v1.${key}`;

export async function hasSeenFeatureHint(key: FeatureHintKey): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(storageKey(key))) === 'seen';
  } catch {
    return false;
  }
}

export async function markFeatureHintSeen(key: FeatureHintKey): Promise<void> {
  await AsyncStorage.setItem(storageKey(key), 'seen');
}

export async function resetFeatureHints(): Promise<void> {
  await AsyncStorage.multiRemove(FEATURE_HINT_KEYS.map(storageKey));
}

/** Keep an existing question intact; help never submits or replaces a draft. */
export function appendHelpQuestion(draft: string, question: string): string {
  return draft.trim() ? `${draft}\n\n${question}` : question;
}
