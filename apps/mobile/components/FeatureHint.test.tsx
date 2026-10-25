import AsyncStorage from '@react-native-async-storage/async-storage';
import { APP_HELP_TOPICS } from '@verity/events';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { useFeatureHint } from './FeatureHint';
import { appendHelpQuestion, FEATURE_HINT_KEYS, resetFeatureHints } from '../lib/featureHints';

const run = jest.fn();
function Harness({ scope = 's1' }: { scope?: string }) {
  const [draft, setDraft] = useState('My existing draft');
  const hint = useFeatureHint(
    (question) => setDraft((current) => appendHelpQuestion(current, question)),
    scope,
  );
  return (
    <>
      <Text>{draft}</Text>
      <Pressable
        onPress={() =>
          void hint.confirm('preview-and-sharing').then((yes) => {
            if (yes) run();
          })
        }
      >
        <Text>Share</Text>
      </Pressable>
      {hint.sheet}
    </>
  );
}

beforeEach(async () => {
  await AsyncStorage.clear();
  run.mockClear();
});

it('executes the pending action only on Continue and remembers the hint', async () => {
  render(<Harness />);
  fireEvent.press(screen.getByText('Share'));
  await screen.findByText('Continue');
  expect(run).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Continue'));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(await AsyncStorage.getItem('verity.hints.v1.preview-and-sharing')).toBe('seen');
  fireEvent.press(screen.getByText('Share'));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
});

it('cancels on dismissal and Ask in chat preserves a draft without executing', async () => {
  const view = render(<Harness />);
  fireEvent.press(screen.getByText('Share'));
  await screen.findByText('Not now');
  fireEvent.press(screen.getByText('Not now'));
  await act(async () => {});
  expect(run).not.toHaveBeenCalled();
  view.unmount();
  await resetFeatureHints();
  render(<Harness />);
  fireEvent.press(screen.getByText('Share'));
  await screen.findByText('Ask in chat');
  fireEvent.press(screen.getByText('Ask in chat'));
  const question = APP_HELP_TOPICS.find((topic) => topic.id === 'preview-and-sharing')!.hint!
    .question;
  expect(screen.getByText(`My existing draft\n\n${question}`)).toBeTruthy();
  expect(run).not.toHaveBeenCalled();
});

it('resets only feature hints and leaves other device preferences alone', async () => {
  for (const key of FEATURE_HINT_KEYS) await AsyncStorage.setItem(`verity.hints.v1.${key}`, 'seen');
  await AsyncStorage.setItem('verity.other.preference', 'keep');
  await resetFeatureHints();
  for (const key of FEATURE_HINT_KEYS)
    expect(await AsyncStorage.getItem(`verity.hints.v1.${key}`)).toBeNull();
  expect(await AsyncStorage.getItem('verity.other.preference')).toBe('keep');
});

it('cancels a pending action when the screen unmounts', async () => {
  const view = render(<Harness />);
  fireEvent.press(screen.getByText('Share'));
  await screen.findByText('Continue');
  view.unmount();
  await act(async () => {});
  expect(run).not.toHaveBeenCalled();
});

it('has catalog help and documentation for every persisted feature hint', () => {
  for (const key of FEATURE_HINT_KEYS) {
    const topic = APP_HELP_TOPICS.find((topic) => topic.id === key);
    expect(topic?.hint?.text).toBeTruthy();
    expect(topic?.hint?.question).toBeTruthy();
    expect(topic?.docsPath).toBeTruthy();
  }
});

it('cancels the old session’s pending action when the session changes', async () => {
  const view = render(<Harness scope="one" />);
  fireEvent.press(screen.getByText('Share'));
  await screen.findByText('Continue');
  view.rerender(<Harness scope="two" />);
  await act(async () => {});
  expect(screen.queryByText('Continue')).toBeNull();
  expect(run).not.toHaveBeenCalled();
});
