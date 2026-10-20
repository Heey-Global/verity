import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import ts from 'typescript';

// Exercise the screen's actual action wiring without opening unrelated live resources.
const source = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
const start = source.indexOf('      {historyError ?');
const end = source.indexOf('      {streamError ?', start);
const compiled = ts.transpileModule(`const element = <>${source.slice(start, end)}</>;`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const build = new Function(
  'React',
  'Banner',
  'Button',
  'props',
  `
  const { historyError, loadingHistory, loadingOlder, loaded, loadOlder, retryHistory } = props;
  ${compiled}
  return element;
`,
);
const props = () => ({
  historyError: undefined as string | undefined,
  loadingHistory: false,
  loadingOlder: false,
  loaded: false,
  loadOlder: jest.fn(),
  retryHistory: jest.fn(),
  hasOlder: false,
  olderLoadNeedsContinuation: false,
});
function renderActions(input: ReturnType<typeof props>) {
  return render(
    build(
      React,
      ({ text }: { text: string }) => <Text>{text}</Text>,
      ({ label, onPress, loading }: { label: string; onPress: () => void; loading: boolean }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={loading}
          onPress={onPress}
        >
          <Text>{label}</Text>
        </Pressable>
      ),
      input,
    ),
  );
}
it.each([false, true])(
  'retries the missing history without discarding loaded pages (%s)',
  (loaded) => {
    const input = { ...props(), loaded, historyError: 'History loading timed out. Retry.' };
    const view = renderActions(input);
    expect(view.getByText(input.historyError)).toBeTruthy();
    fireEvent.press(view.getByRole('button', { name: 'Retry history' }));
    expect(loaded ? input.loadOlder : input.retryHistory).toHaveBeenCalledTimes(1);
    expect(loaded ? input.retryHistory : input.loadOlder).not.toHaveBeenCalled();
  },
);
// Older pages load as the user scrolls up. A manual button for it crowded the
// transcript and, while shown, also switched scroll paging off.
it('offers no manual control for loading earlier history', () => {
  // `source` is the whole session screen, not the extracted actions snippet.
  expect(source).toContain('function SessionScreen');
  expect(source).not.toContain('Load earlier history');
  expect(source).not.toMatch(/olderLoadNeedsContinuation/u);
  // With no visible message there is nothing to scroll, so paging must continue
  // by itself; otherwise the history behind an empty tail is unreachable.
  expect(source).toMatch(
    /if \(showsNoMessages && hasOlder && !loadingOlder && !olderLoadStalled\) void loadOlder\(\);/u,
  );
});
