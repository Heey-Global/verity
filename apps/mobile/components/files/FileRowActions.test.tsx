import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Pressable, Text } from 'react-native';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { bindFileRowShortcuts, FileRowActions } from './FileRowActions';

jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: React.forwardRef(
      (
        props: { children: React.ReactNode; renderRightActions: () => React.ReactNode },
        _ref: unknown,
      ) => React.createElement(View, {}, props.children, props.renderRightActions()),
    ),
  };
});

const row = (
  <Pressable accessibilityLabel="Open notes">
    <Text>notes</Text>
  </Pressable>
);

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
});
afterEach(() => jest.restoreAllMocks());

it('requires choosing Delete after revealing actions, even after a full swipe', async () => {
  const remove = jest.fn();
  const view = render(
    <FileRowActions label="notes" onDelete={remove}>
      {row}
    </FileRowActions>,
  );
  await act(async () => {});
  const swipe = view.UNSAFE_getByType(Swipeable);
  expect(swipe.props.onSwipeableOpen).toBeUndefined();
  expect(swipe.props.onSwipeableWillOpen).toBeUndefined();
  expect(swipe.props.overshootRight).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
  expect(remove).toHaveBeenCalledTimes(1);
});

it('keeps navigation separate and exposes actions to screen readers without swiping', async () => {
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
  const menu = jest.fn();
  render(
    <FileRowActions label="notes" onMenu={menu}>
      {row}
    </FileRowActions>,
  );
  await act(async () => {});
  expect(screen.getByLabelText('Open notes')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Actions for notes' }));
  expect(menu).toHaveBeenCalledTimes(1);
});

it('does not expose mutation actions while disabled or without a delete handler', async () => {
  const remove = jest.fn();
  render(
    <FileRowActions label="notes" onDelete={remove} disabled>
      {row}
    </FileRowActions>,
  );
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Actions for notes' })).toBeNull();
});

it('opens the web menu by right-click or keyboard and keeps Delete out of text fields', () => {
  const menu = jest.fn();
  const remove = jest.fn();
  const node = new EventTarget();
  const cleanup = bindFileRowShortcuts(node, menu, remove);
  const dispatch = (type: string, props = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(
      event,
      Object.fromEntries(Object.entries(props).map(([key, value]) => [key, { value }])),
    );
    node.dispatchEvent(event);
  };
  dispatch('contextmenu');
  dispatch('keydown', { key: 'F10', shiftKey: true });
  dispatch('keydown', { key: 'ContextMenu' });
  expect(menu).toHaveBeenCalledTimes(3);
  dispatch('keydown', { key: 'Delete', target: { tagName: 'INPUT' } });
  expect(remove).not.toHaveBeenCalled();
  dispatch('keydown', { key: 'Delete' });
  expect(remove).toHaveBeenCalledTimes(1);
  cleanup();
  dispatch('contextmenu');
  dispatch('keydown', { key: 'Delete' });
  expect(menu).toHaveBeenCalledTimes(3);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('offers Move and Delete to screen readers without requiring a swipe', async () => {
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
  const move = jest.fn();
  const remove = jest.fn();
  render(
    <FileRowActions label="notes" onMove={move} onDelete={remove}>
      {row}
    </FileRowActions>,
  );
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Actions for notes' }));
  expect(screen.getAllByRole('menuitem').map((item) => item.props.accessibilityLabel)).toEqual([
    'Move',
    'Delete',
  ]);
  fireEvent.press(screen.getByRole('menuitem', { name: 'Move' }));
  expect(move).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
});

it('reveals non-mutating actions without offering deletion for read-only rows', async () => {
  const menu = jest.fn();
  render(
    <FileRowActions label="draft.md" onMenu={menu}>
      {row}
    </FileRowActions>,
  );
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Actions' }));
  expect(menu).toHaveBeenCalledTimes(1);
});
