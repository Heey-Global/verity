import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderHook } from '@testing-library/react-native';
import ts from 'typescript';

// Exercise the production list element and its dependencies without starting a
// live session. Fresh list props silently defeat FlashList's own memo boundary.
const source = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
const start = source.indexOf('  const transcriptList =');
const expression = source.slice(start, source.indexOf('  finishChatWork();', start));
const compiled = ts.transpileModule(expression, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const noop = () => undefined;
const inputs = {
  switchTiming: undefined,
  sessionId: 'a',
  setLoadedListSessionId: jest.fn(),
  markInitialListLoad: jest.fn(),
  listRef: { current: null },
  data: [],
  rowKey: noop,
  renderItem: noop,
  getItemType: noop,
  embedded: true,
  insets: { left: 0, right: 0 },
  theme: { spacing: { lg: 12 }, colors: { textMuted: '#888' } },
  onListScroll: noop,
  onListContentSizeChange: noop,
  clearSearchHighlightAfterTouch: noop,
  onListScrollBeginDrag: noop,
  onListMomentumScrollBegin: noop,
  onListScrollEndDrag: noop,
  onListMomentumScrollEnd: noop,
  onViewableItemsChanged: noop,
  viewabilityConfig: {},
  loadingOlder: false,
  maintainVisibleContentPosition: {},
};
const build = new Function(
  'React',
  'useMemo',
  'FlashList',
  'View',
  'ActivityIndicator',
  'styles',
  'props',
  `const {${Object.keys(inputs).join(',')}} = props; ${compiled}; return transcriptList;`,
);
function useList(props: typeof inputs) {
  return build(
    React,
    React.useMemo,
    'FlashList',
    'View',
    'ActivityIndicator',
    {},
    props,
  ) as React.ReactElement<Record<string, unknown>>;
}

it('retains list props during composer or auxiliary updates while accepting streaming and scroll changes', () => {
  const hook = renderHook(
    ({ draft, ...props }: typeof inputs & { draft: string }) => {
      void draft;
      return useList(props);
    },
    { initialProps: { ...inputs, draft: '' } },
  );
  const first = hook.result.current;
  hook.rerender({ ...inputs, draft: 'typing' });
  expect(hook.result.current).toBe(first);
  const data = [{}] as typeof inputs.data;
  hook.rerender({ ...inputs, data, draft: 'typing' });
  expect(hook.result.current).not.toBe(first);
  expect(hook.result.current.props.data).toBe(data);
  const scroll = jest.fn();
  hook.rerender({ ...inputs, data, onListScroll: scroll, loadingOlder: true, draft: 'typing' });
  expect(hook.result.current.props.onScroll).toBe(scroll);
  hook.rerender({ ...inputs, sessionId: 'b', draft: '' });
  (hook.result.current.props.onLoad as () => void)();
  expect(inputs.setLoadedListSessionId).toHaveBeenLastCalledWith('b');
});

it('keeps explicit model and automation access independent of deferred admission', () => {
  expect(source).toMatch(/refreshModels\(\);\s*setEnginePickerOpen\(true\)/);
  expect(source).toMatch(/setAutomationSheetOpen\(true\);\s*void loadAutomation\(\)/);
  expect(source).toContain('enabled: optionalWorkReady || staticPreviewOpen');
});
