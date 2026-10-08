import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  correctVoiceText,
  defaultVoiceVocabulary,
  loadVoiceVocabulary,
  saveVoiceVocabulary,
  validateVoiceVocabulary,
  type VoiceVocabulary,
} from './voiceVocabulary';

const vocabulary: VoiceVocabulary = {
  enabled: true,
  terms: [
    { term: 'GitHub', aliases: ['git hub'] },
    { term: 'React', aliases: [] },
    { term: 'React Native', aliases: [] },
    { term: 'Example', aliases: ['sample'] },
  ],
};
beforeEach(async () => {
  await AsyncStorage.clear();
});

test('corrects complete phrases without changing words, punctuation or suffixes', () => {
  expect(correctVoiceText('react native, git hub! reactive; prereact; Reacts.', vocabulary)).toBe(
    'React Native, GitHub! reactive; prereact; Reacts.',
  );
});
test('does not cascade explicit replacement rules', () => {
  expect(
    correctVoiceText('sample', {
      enabled: true,
      terms: [
        { term: 'Example', aliases: ['sample'] },
        { term: 'Other', aliases: ['Example'] },
      ],
    }),
  ).toBe('Example');
});
test('ambiguous aliases are ignored regardless of order', () => {
  const terms = [
    { term: 'First', aliases: ['sample'] },
    { term: 'Second', aliases: ['sample'] },
  ];
  expect(correctVoiceText('sample', { enabled: true, terms })).toBe('sample');
  expect(correctVoiceText('sample', { enabled: true, terms: [...terms].reverse() })).toBe('sample');
});
test('protects addresses and marked code, including unfinished code blocks', () => {
  const text =
    'https://test.example/git hub www.test.example/react sample@example.org `git hub` ```react native';
  expect(correctVoiceText(text, vocabulary)).toBe(
    'https://test.example/git hub www.test.example/react sample@example.org `git hub` ```react native',
  );
});
test('disabled correction preserves the entire segment', () => {
  expect(correctVoiceText('git hub', { ...vocabulary, enabled: false })).toBe('git hub');
});
test('stores editable vocabulary and disabled state only in local storage', async () => {
  const value = { ...vocabulary, enabled: false };
  await saveVoiceVocabulary(value);
  expect(await loadVoiceVocabulary()).toEqual(value);
});
test('defaults are public terms and storage corruption recovers safely', async () => {
  expect(await loadVoiceVocabulary()).toEqual(defaultVoiceVocabulary());
  await AsyncStorage.setItem('verity.voiceVocabulary.v1', '{');
  expect(await loadVoiceVocabulary()).toEqual(defaultVoiceVocabulary());
});
test('enforces size and brief terms before persistence', async () => {
  const tooMany = {
    enabled: true,
    terms: Array.from({ length: 101 }, () => ({ term: 'Example', aliases: [] })),
  };
  await expect(saveVoiceVocabulary(tooMany)).rejects.toThrow('100');
  expect(await AsyncStorage.getItem('verity.voiceVocabulary.v1')).toBeNull();
  expect(() =>
    validateVoiceVocabulary({ enabled: true, terms: [{ term: 'three word phrase', aliases: [] }] }),
  ).toThrow('one or two');
});

test('protects bare domains and non-HTTP URLs while normalizing public product spellings', () => {
  const text = 'github.com/docs ftp://github.com git@github.com git hub test flight';
  expect(correctVoiceText(text, defaultVoiceVocabulary())).toBe(
    'github.com/docs ftp://github.com git@github.com GitHub TestFlight',
  );
});

test('protects domain suffixes outside common public defaults from custom replacements', () => {
  const rules = { enabled: true, terms: [{ term: 'Replacement', aliases: ['github', 'example'] }] };
  const text = 'github.co example.technology example.xyz/path example.рф';
  expect(correctVoiceText(text, rules)).toBe(text);
});
