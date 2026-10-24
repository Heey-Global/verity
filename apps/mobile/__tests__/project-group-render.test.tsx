import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import ts from 'typescript';
import { ProjectSessionsCollapse } from '../components/ProjectSessionsCollapse';

// Execute the production group in isolation from the authenticated screen and
// native drag runtime. Counting its children catches work hidden by display:none.
const source = readFileSync(join(__dirname, '../app/index.tsx'), 'utf8');
const groupSource = source.slice(
  source.indexOf('const ProjectGroup ='),
  source.indexOf('// Delete is destructive', source.indexOf('const ProjectGroup =')),
);
const compiled = ts.transpileModule(groupSource, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const groupRender = jest.fn();
const slotRender = jest.fn();
const rowRender = jest.fn();
const bindings = {
  React,
  ...React,
  View,
  Text,
  Pressable,
  Reanimated: { View },
  styles: {},
  useUnistyles: () => ({ theme: { colors: {}, spacing: { md: 4 } } }),
  beginRenderWork: () => {
    groupRender();
    return () => undefined;
  },
  useProjectRowDrag: () => ({}),
  useSessionDragOrder: (sessions: unknown[]) => React.useMemo(() => [], [sessions]),
  useSessionRowCallbacks: ({ sessions }: { sessions: { sessionId: string }[] }) =>
    React.useMemo(() => new Map(sessions.map((s) => [s.sessionId, {}])), [sessions]),
  UNTRACKED_PROJECT_BADGE: {},
  sandboxUpdateIndicator: () => undefined,
  Icon: () => null,
  ProjectStatusDot: () => null,
  ProjectSessionsCollapse,
  SessionDragSlot: ({
    children,
    enabled,
  }: {
    children: () => React.ReactNode;
    enabled: boolean;
  }) => {
    slotRender(enabled);
    return <View>{children()}</View>;
  },
  SessionRow: ({ selected }: { selected: boolean }) => {
    rowRender(selected);
    return <Text>{selected ? 'Selected row' : 'Row'}</Text>;
  },
};
const ProjectGroup = new Function(...Object.keys(bindings), `${compiled}; return ProjectGroup;`)(
  ...Object.values(bindings),
) as React.ComponentType<Record<string, unknown>>;
const props = {
  group: { id: 'g', title: 'Group', sessions: [{ sessionId: 's' }], portLinks: [] },
  collapsed: false,
  onToggle: jest.fn(),
  reorder: {},
  unread: new Set(),
  previewUrls: new Map(),
  publicPreviews: new Set(),
};
beforeEach(() => jest.clearAllMocks());

it('skips unchanged groups and retains the session subtree while folding', () => {
  const view = render(<ProjectGroup {...props} />);
  expect(slotRender).toHaveBeenCalledTimes(1);
  view.rerender(<ProjectGroup {...props} />);
  expect(groupRender).toHaveBeenCalledTimes(1);
  view.rerender(<ProjectGroup {...props} collapsed />);
  expect(view.queryByText('Row')).toBeNull();
  expect(slotRender).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('Expand Group'));
  expect(props.onToggle).toHaveBeenCalledWith(props.group, true);
  view.rerender(<ProjectGroup {...props} />);
  expect(view.getByText('Row')).toBeTruthy();
  expect(slotRender).toHaveBeenCalledTimes(1);
});

it('updates selection and drag eligibility even while rows are retained', () => {
  const view = render(<ProjectGroup {...props} sessionReordering />);
  expect(slotRender).toHaveBeenLastCalledWith(true);
  view.rerender(<ProjectGroup {...props} sessionReordering collapsed />);
  expect(slotRender).toHaveBeenLastCalledWith(false);
  view.rerender(<ProjectGroup {...props} selectedId="s" />);
  expect(view.getByText('Selected row')).toBeTruthy();
  expect(rowRender).toHaveBeenLastCalledWith(true);
});

it('passes stable action callbacks through the overview memo boundary', () => {
  expect(source).toContain('onToggle={toggleProjectGroup}');
  expect(source).toContain('onRepairProject={repairProjectRow}');
});
