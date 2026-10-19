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
  const { historyError, loadingHistory, loadingOlder, loaded, loadOlder, retryHistory,
    hasOlder, olderLoadNeedsContinuation } = props;
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
it('offers explicit continuation after a bounded metadata-only scan', () => {
  const input = { ...props(), loaded: true, hasOlder: true, olderLoadNeedsContinuation: true };
  const view = renderActions(input);
  expect(input.loadOlder).not.toHaveBeenCalled();
  fireEvent.press(view.getByRole('button', { name: 'Load earlier history' }));
  expect(input.loadOlder).toHaveBeenCalledTimes(1);
});
