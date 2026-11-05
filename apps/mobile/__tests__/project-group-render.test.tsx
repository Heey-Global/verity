import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import ts from 'typescript';
import type { VerityClient } from '@verity/mobile';
import { useProjects } from '../hooks/useProjects';
import { useSessionRowCallbacks } from '../hooks/useSessionRowCallbacks';
import { useSessionDragOrder } from '../components/useProjectReorder';

jest.mock('../lib/liveConnection', () => ({
  subscribeLiveRefresh: () => () => undefined,
}));
jest.mock('../lib/sessionSwitchTiming', () => ({ beginClientActivity: () => () => undefined }));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
import { projectGroupSessionId } from '../lib/projectGroups';
import { ProjectSessionsCollapse } from '../components/ProjectSessionsCollapse';

// Execute the production group in isolation from the authenticated screen and
// native drag runtime. Counting its children catches work hidden by display:none.
const source = readFileSync(join(__dirname, '../app/index.tsx'), 'utf8');
const groupSource = source.slice(
  source.indexOf('const ProjectSessionEntry ='),
  source.indexOf('// Delete is destructive', source.indexOf('const ProjectGroup =')),
);
const compiled = ts.transpileModule(groupSource, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const groupRender = jest.fn();
const slotRender = jest.fn();
const rowRender = jest.fn();
const entryRender = jest.fn();
const rowProps = jest.fn();
const bindings = {
  React,
  ...React,
  View,
  Text,
  Pressable,
  Reanimated: { View },
  styles: { sessionDivider: { height: 1 } },
  useUnistyles: () => ({ theme: { colors: {}, spacing: { md: 4 } } }),
  beginRenderWork: () => {
    groupRender();
    return () => undefined;
  },
  useProjectRowDrag: () => ({}),
  useSessionDragOrder,
  useSessionRowCallbacks,
  UNTRACKED_PROJECT_BADGE: {},
  sandboxUpdateIndicator: () => undefined,
  Icon: () => null,
  ProjectStatusDot: () => null,
  ProjectSessionsCollapse,
  SessionDragSlot: ({
    children,
    enabled,
    id,
  }: {
    children: () => React.ReactNode;
    enabled: boolean;
    id: string;
  }) => {
    slotRender(enabled);
    entryRender(id);
    return <View testID={id}>{children()}</View>;
  },
  SessionRow: (values: { selected: boolean }) => {
    const { selected } = values;
    rowProps(values);
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

it('keeps unrelated selections and rename changes out of mounted drag subtrees', () => {
  const group = props.group;
  const renderGroup = (selectedId: string | null, renamingId: string | null) => (
    <ProjectGroup
      {...props}
      selectedId={projectGroupSessionId(group, selectedId)}
      renamingId={projectGroupSessionId(group, renamingId)}
    />
  );
  const view = render(renderGroup('other-a', null));
  view.rerender(renderGroup('other-b', 'other-b'));
  expect(groupRender).toHaveBeenCalledTimes(1);
  expect(slotRender).toHaveBeenCalledTimes(1);
  view.rerender(renderGroup('s', null));
  expect(view.getByText('Selected row')).toBeTruthy();
  expect(groupRender).toHaveBeenCalledTimes(2);
  view.rerender(renderGroup('other-b', 's'));
  expect(view.getByText('Row')).toBeTruthy();
  expect(groupRender).toHaveBeenCalledTimes(3);
  view.rerender(renderGroup(null, null));
  expect(groupRender).toHaveBeenCalledTimes(4);
  expect(source).toContain('selectedId={wide ? projectGroupSessionId(item, selectedId) : null}');
  expect(source).toContain('renamingId={projectGroupSessionId(item, renaming?.sessionId)}');
});

it('keeps the production project toggle stable from the real project hook through parent updates', async () => {
  // Execute the actual callback definition so its transitive hook dependencies
  // cannot silently invalidate every memoized group during selection changes.
  const toggleSource = source.slice(
    source.indexOf('  const toggleProjectGroup ='),
    source.indexOf('  const renderGroup ='),
  );
  const toggleCompiled = ts.transpileModule(toggleSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const useProductionToggle = new Function(
    'useCallback',
    'draggingAnything',
    'enqueueProjectCollapse',
    'refreshProjects',
    `${toggleCompiled}; return toggleProjectGroup;`,
  ) as (...args: unknown[]) => (group: unknown, collapsed: boolean) => void;
  const previousState = AppState.currentState;
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const client = { listProjects: jest.fn().mockResolvedValue([]) } as unknown as VerityClient;
  const collapse = jest.fn();
  function Harness({ selected }: { selected: string }) {
    const projects = useProjects(client);
    const onToggle = useProductionToggle(React.useCallback, false, collapse, projects.refresh);
    return (
      <ProjectGroup
        {...props}
        onToggle={onToggle}
        previewUrls={projects.previewUrls}
        publicPreviews={projects.publicPreviews}
        selectedId={projectGroupSessionId(props.group, selected)}
      />
    );
  }
  const view = render(<Harness selected="other-a" />);
  try {
    await waitFor(() => expect(client.listProjects).toHaveBeenCalledTimes(1));
    groupRender.mockClear();
    slotRender.mockClear();
    view.rerender(<Harness selected="other-b" />);
    expect(groupRender).not.toHaveBeenCalled();
    expect(slotRender).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: previousState });
  }
});

const sessions = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }];
const multiProps = { ...props, group: { ...props.group, sessions } };
const renderedIds = () => entryRender.mock.calls.map(([id]) => id);
const latestRow = (id: string) =>
  rowProps.mock.calls.map(([value]) => value).findLast((value) => value.session.sessionId === id);

it('renders only the old and new selection wrappers and skips equivalent collections', () => {
  const view = render(<ProjectGroup {...multiProps} selectedId="a" />);
  entryRender.mockClear();
  view.rerender(<ProjectGroup {...multiProps} selectedId="b" />);
  expect(renderedIds()).toEqual(['session:a', 'session:b']);
  entryRender.mockClear();
  view.rerender(
    <ProjectGroup
      {...multiProps}
      selectedId="b"
      unread={new Set()}
      previewUrls={new Map()}
      publicPreviews={new Set()}
      group={{ ...multiProps.group, sessions: [...sessions] }}
    />,
  );
  expect(renderedIds()).toEqual([]);
});

it('publishes own rename, unread, preview, data and action changes', () => {
  const view = render(<ProjectGroup {...multiProps} />);
  entryRender.mockClear();
  view.rerender(
    <ProjectGroup
      {...multiProps}
      renamingId="b"
      unread={new Set(['b'])}
      previewUrls={new Map([['b', 'https://preview.example']])}
      publicPreviews={new Set(['b'])}
    />,
  );
  expect(renderedIds()).toEqual(['session:b']);
  expect(latestRow('b')).toMatchObject({
    renaming: true,
    unread: true,
    previewActive: true,
    previewPublic: true,
    previewUrl: 'https://preview.example',
  });
  const updated = { ...sessions[1], title: 'Updated' };
  const onOpen = jest.fn();
  view.rerender(
    <ProjectGroup
      {...multiProps}
      group={{ ...multiProps.group, sessions: [sessions[0], updated, sessions[2]] }}
      onOpenSession={onOpen}
    />,
  );
  expect(latestRow('b').session).toBe(updated);
  latestRow('b').onOpen();
  expect(onOpen).toHaveBeenCalledWith(updated);
});

it('updates drag order, boundary actions and dividers after reordering', () => {
  const view = render(<ProjectGroup {...multiProps} sessionReordering />);
  expect(latestRow('a').onMoveUp).toBeUndefined();
  const hasDivider = (id: string) =>
    view
      .getByTestId(`session:${id}`)
      .findAllByType(View)
      .some((node) => node.props.style === bindings.styles.sessionDivider);
  expect(hasDivider('a')).toBe(false);
  expect(hasDivider('c')).toBe(true);
  view.rerender(
    <ProjectGroup
      {...multiProps}
      sessionReordering
      group={{ ...multiProps.group, sessions: [sessions[2], sessions[0], sessions[1]] }}
    />,
  );
  expect(latestRow('c').onMoveUp).toBeUndefined();
  expect(hasDivider('c')).toBe(false);
  expect(hasDivider('a')).toBe(true);
  expect(latestRow('a').onMoveUp).toEqual(expect.any(Function));
  expect(
    view
      .UNSAFE_getAllByType(View)
      .filter((node) => node.props.style === bindings.styles.sessionDivider),
  ).toHaveLength(2);
});

it.each([
  ['rename', { renamingId: 'b' }, { renaming: true }],
  ['unread', { unread: new Set(['b']) }, { unread: true }],
  [
    'preview URL',
    { previewUrls: new Map([['b', 'https://preview.example']]) },
    { previewActive: true, previewUrl: 'https://preview.example' },
  ],
  ['public preview', { publicPreviews: new Set(['b']) }, { previewPublic: true }],
] as const)(
  'publishes an isolated %s change only to its own wrapper',
  (_label, changed, expected) => {
    const view = render(<ProjectGroup {...multiProps} />);
    entryRender.mockClear();
    view.rerender(<ProjectGroup {...multiProps} {...changed} />);
    expect(renderedIds()).toEqual(['session:b']);
    expect(latestRow('b')).toMatchObject(expected);
  },
);
