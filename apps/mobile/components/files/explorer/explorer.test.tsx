import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { ExplorerRow } from './ExplorerRow';
import { FolderPicker, type PickerEntry } from './FolderPicker';
import { addFileActions, FILE_ACTION, fileActions } from './fileActions';

jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: React.forwardRef(
      (props: { children: React.ReactNode; renderRightActions: () => React.ReactNode }) =>
        React.createElement(View, {}, props.children, props.renderRightActions()),
    ),
  };
});

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
});
afterEach(() => jest.restoreAllMocks());

const noop = () => undefined;

describe('the explorer menu', () => {
  it('lists actions in one order wherever they come from, Delete last', () => {
    // Handlers given in reverse: a menu that followed its caller's order would
    // put Delete first in one place and last in another.
    const actions = fileActions({ delete: noop, move: noop, rename: noop, open: noop });
    expect(actions.map((action) => action.label)).toEqual(['Open', 'Rename…', 'Move…', 'Delete…']);
    expect(actions.at(-1)?.destructive).toBe(true);
  });

  it('names each action once, so Code, Drive and the libraries read alike', () => {
    const labels = Object.values(FILE_ACTION).map((action) => action.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('offers New Markdown file only where it is handed one, as Sources is not', () => {
    expect(addFileActions({ folder: noop, upload: noop }).map((action) => action.label)).toEqual([
      'New folder…',
      'Upload files…',
    ]);
  });
});

describe('an explorer row', () => {
  it('ends in "⋯" for its menu and offers More and Delete on the swipe', async () => {
    const menu = jest.fn();
    const remove = jest.fn();
    render(
      <ExplorerRow
        name="notes.md"
        icon="file-text"
        onPress={noop}
        onMenu={menu}
        onDelete={remove}
      />,
    );
    await act(async () => {});
    fireEvent.press(screen.getByLabelText('Actions for notes.md'));
    fireEvent.press(screen.getByRole('button', { name: 'More' }));
    expect(menu).toHaveBeenCalledTimes(2);
    fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('gives "⋯" up for the check circle while selecting', async () => {
    render(
      <ExplorerRow
        name="notes.md"
        icon="file-text"
        selecting
        picked
        onPress={noop}
        onMenu={noop}
      />,
    );
    await act(async () => {});
    expect(screen.queryByLabelText('Actions for notes.md')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'notes.md' })).toBeChecked();
  });
});

describe('the folder picker', () => {
  const tree: Record<string, PickerEntry[]> = {
    insights: [
      { id: 'insights/uplink', name: 'uplink', folder: true },
      { id: 'insights/moved', name: 'moved', folder: true },
      { id: 'insights/page.md', name: 'page.md', folder: false },
    ],
    'insights/uplink': [],
  };
  const list = (folder: string) => Promise.resolve(tree[folder] ?? []);

  it('moves only somewhere else, never into what it moves or a file', async () => {
    const pick = jest.fn().mockResolvedValue(undefined);
    render(
      <FolderPicker
        title="Move 1 item"
        root={{ id: 'insights', label: 'Wiki', icon: 'book-open' }}
        start={[]}
        current="insights"
        list={list}
        excluded={(id) => id === 'insights/moved'}
        onPick={pick}
        onCancel={noop}
      />,
    );
    expect(await screen.findByLabelText('uplink')).toBeTruthy();
    expect(screen.getByLabelText('Move to Wiki')).toBeDisabled();
    expect(screen.getByLabelText('moved')).toBeDisabled();
    expect(screen.getByLabelText('page.md')).toBeDisabled();
    fireEvent.press(screen.getByLabelText('uplink'));
    fireEvent.press(await screen.findByLabelText('Move to uplink'));
    await waitFor(() => expect(pick).toHaveBeenCalledWith('insights/uplink'));
  });

  it('creates a folder in place and opens it as the destination', async () => {
    const create = jest
      .fn()
      .mockResolvedValue({ id: 'insights/new', name: 'new', folder: true } satisfies PickerEntry);
    render(
      <FolderPicker
        title="Move 1 item"
        root={{ id: 'insights', label: 'Wiki', icon: 'book-open' }}
        start={[]}
        current="insights"
        list={list}
        createFolder={create}
        onPick={jest.fn()}
        onCancel={noop}
      />,
    );
    await screen.findByLabelText('uplink');
    fireEvent.press(screen.getByRole('button', { name: 'New folder…' }));
    fireEvent.changeText(screen.getByLabelText('File name'), 'new');
    fireEvent.press(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('insights', 'new'));
    // It waits for the new folder's listing before it lets Move go.
    await waitFor(() => expect(screen.getByLabelText('Move to new')).toBeEnabled());
  });
});
