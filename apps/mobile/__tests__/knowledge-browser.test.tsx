// The knowledge browser (components/knowledge): Shared and project libraries.
//
// What is worth guarding: every folder and file is its own screen on a phone, so
// the header's back arrow and the swipe go up one level (there is no in-page
// "Back to folder" any more); a Markdown file reads as rendered text; a failed
// save keeps the draft and saves on top of the newer version; in the wide layout
// a folder opens in its column and a file in the right column.
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

jest.mock('../components/files/FileRowActions', () => ({
  FileRowActions: ({
    children,
    label,
    onDelete,
    onRename,
  }: {
    children: React.ReactNode;
    label: string;
    onDelete?: () => void;
    onRename?: () => void;
  }) => {
    const { View, Pressable, Text } = require('react-native');
    return (
      <View>
        {children}
        {onRename ? (
          <Pressable accessibilityLabel={`Rename ${label}`} onPress={onRename}>
            <Text>Rename entry</Text>
          </Pressable>
        ) : null}
        {onDelete ? (
          <Pressable accessibilityLabel={`Delete ${label}`} onPress={onDelete}>
            <Text>Delete entry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  },
}));

import type { VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EmbeddedKnowledge, KnowledgeScreen } from '../components/knowledge/KnowledgeBrowser';
import { KnowledgeFileView } from '../components/knowledge/KnowledgeFileView';
import { followMove, KnowledgePaneContext } from '../components/knowledge/KnowledgePane';
import { folderTitle, SHARED } from '../components/knowledge/knowledgeScope';
import { invalidateWikiCatalog } from '../components/knowledge/useWikiCatalog';
import {
  attemptBack,
  mockCreateVerityClient,
  mockPush,
  mockRemoved,
  resetSettingsHarness,
} from './support/settingsHarness';

const PROJECT = { kind: 'project', projectId: 'p' } as const;
const file = {
  path: 'insights/reference.md',
  content: '# Reference\n\nShared **rules** for agents.',
  editable: true,
  version: 'a'.repeat(64),
  size: 40,
};

function client(extra: Record<string, unknown> = {}) {
  const list = jest.fn().mockResolvedValue({
    root: 'shared',
    path: 'insights',
    entries: [
      { path: 'insights/uplink', name: 'uplink', kind: 'directory' },
      { path: file.path, name: 'reference.md', kind: 'file' },
    ],
    truncated: false,
  });
  const read = jest.fn().mockResolvedValue(file);
  const value = {
    listSharedKnowledgeFiles: list,
    listProjectKnowledgeFiles: list,
    getSharedKnowledgeFile: read,
    getProjectKnowledgeFile: read,
    writeSharedKnowledgeFile: jest.fn(),
    writeProjectKnowledgeFile: jest.fn(),
    // A server from before the Wiki catalog: the Wiki is a folder, as here.
    getProjectWiki: jest.fn().mockResolvedValue(null),
    ...extra,
  };
  mockCreateVerityClient.mockReturnValue(value as unknown as VerityClient);
  return value as typeof value & Record<string, jest.Mock>;
}

beforeEach(() => {
  resetSettingsHarness();
  invalidateWikiCatalog('p');
});

it('opens each folder and file of a phone as its own screen', async () => {
  const api = client();
  render(<KnowledgeScreen scope={SHARED} folder="insights" />);
  fireEvent.press(await screen.findByText('uplink'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/settings/shared-knowledge',
    params: { folder: 'insights/uplink' },
  });
  fireEvent.press(screen.getByText('reference.md'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/settings/shared-knowledge',
    params: { file: 'insights/reference.md' },
  });
  expect(api.listSharedKnowledgeFiles).toHaveBeenCalledWith('insights');
  // Going up is the header's job now.
  expect(screen.queryByText('Back to folder')).toBeNull();
});

it('reads a Markdown file as rendered text, not in a text box', async () => {
  client();
  render(<KnowledgeScreen scope={SHARED} file={file.path} />);
  const heading = await screen.findByRole('header');
  expect(heading).toHaveTextContent('Reference');
  expect(screen.queryByText(/^# Reference/)).toBeNull();
  expect(screen.queryByLabelText('Content')).toBeNull();
  expect(screen.getByLabelText('Download original')).toBeTruthy();
});

it.each([
  ['Shared', SHARED, [file.path, 'After', 'b'.repeat(64)]],
  ['project', PROJECT, ['p', file.path, 'After', 'b'.repeat(64)]],
] as const)(
  'keeps a %s draft through a failed save and saves it on the newer version',
  async (_label, scope, lastWrite) => {
    const write = jest
      .fn()
      .mockRejectedValueOnce(new Error('File changed; reload'))
      .mockResolvedValue({ ...file, content: 'After', version: 'c'.repeat(64) });
    const read = jest
      .fn()
      .mockResolvedValueOnce(file)
      .mockResolvedValue({ ...file, content: 'Remote edit', version: 'b'.repeat(64) });
    client({
      getSharedKnowledgeFile: read,
      getProjectKnowledgeFile: read,
      writeSharedKnowledgeFile: write,
      writeProjectKnowledgeFile: write,
    });
    render(<KnowledgeScreen scope={scope} file={file.path} />);
    fireEvent.press(await screen.findByText('Edit'));
    fireEvent.changeText(screen.getByLabelText('Content'), 'After');
    await act(async () => fireEvent.press(screen.getByText('Save')));
    expect(await screen.findByText('File changed; reload')).toBeTruthy();
    expect(screen.getByDisplayValue('After')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Retry')));
    // The newer version arrived; the draft did not give way to it.
    expect(screen.getByDisplayValue('After')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Save')));
    expect(write).toHaveBeenLastCalledWith(...lastWrite);
    await waitFor(() => expect(screen.queryByLabelText('Content')).toBeNull());
  },
);

it('asks before closing a file beside the session with unsaved edits', async () => {
  const api = client();
  const onClose = jest.fn();
  const onDirtyChange = jest.fn();
  const view = render(
    <KnowledgeFileView
      client={api as unknown as VerityClient}
      scope={SHARED}
      file={file.path}
      chrome="pane"
      onClose={onClose}
      onDirtyChange={onDirtyChange}
    />,
  );
  fireEvent.press(await screen.findByText('Edit'));
  fireEvent.changeText(screen.getByLabelText('Content'), 'Unsaved');
  // The wide layout asks before another file or session replaces this one.
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.press(screen.getByLabelText('Close file'));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Discard' })));
  expect(onClose).toHaveBeenCalled();
  view.unmount();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it('asks before back or the swipe discards an edit on a phone', async () => {
  client();
  render(<KnowledgeScreen scope={SHARED} file={file.path} />);
  expect(attemptBack()).toBe(false);
  expect(mockRemoved).toHaveBeenCalledTimes(1);
  fireEvent.press(await screen.findByText('Edit'));
  fireEvent.changeText(screen.getByLabelText('Content'), 'Unsaved');
  act(() => {
    expect(attemptBack()).toBe(true);
  });
  expect(mockRemoved).toHaveBeenCalledTimes(1);
  // Discard sends the held back again; it must leave, not ask once more.
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Discard' })));
  expect(mockRemoved).toHaveBeenCalledTimes(2);
});

it('never lands a late save of one project’s file in another project’s view', async () => {
  let finish!: (value: unknown) => void;
  const write = jest.fn(() => new Promise((resolve) => (finish = resolve)));
  const read = jest.fn(async (projectId: string) => ({ ...file, content: `From ${projectId}` }));
  const api = client({ getProjectKnowledgeFile: read, writeProjectKnowledgeFile: write });
  const view = (projectId: string) => (
    <KnowledgeFileView
      client={api as unknown as VerityClient}
      scope={{ kind: 'project', projectId }}
      file={file.path}
      chrome="pane"
    />
  );
  const { rerender } = render(view('a'));
  fireEvent.press(await screen.findByText('Edit'));
  fireEvent.changeText(screen.getByLabelText('Content'), 'Edited in a');
  act(() => fireEvent.press(screen.getByText('Save')));
  // Same path, other project: the view stays mounted while a's save is in flight.
  rerender(view('b'));
  await act(async () => undefined);
  await act(async () => finish({ ...file, content: 'Saved in a', version: 'z'.repeat(64) }));
  expect(screen.queryByText('Saved in a')).toBeNull();
  expect(await screen.findByText('From b')).toBeTruthy();
});

it('starts a project at its areas, without reading the Shared library', async () => {
  const api = client();
  render(<KnowledgeScreen scope={PROJECT} />);
  await act(async () => undefined);
  expect(screen.queryByText('Decisions')).toBeNull();
  for (const [label, folder] of [
    ['Wiki', 'insights'],
    ['Sources', 'sources'],
  ] as const) {
    fireEvent.press(screen.getByText(label));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/project/[id]/knowledge',
      params: { id: 'p', folder },
    });
  }
  // Without this line Sources reads as one more folder, not as the originals.
  expect(screen.getByText('Documents, meeting transcripts and attachments')).toBeTruthy();
  expect(api.listSharedKnowledgeFiles).not.toHaveBeenCalled();
  expect(api.listProjectKnowledgeFiles).not.toHaveBeenCalled();
});

it('in the wide layout opens folders in the column and files beside it', async () => {
  const api = client();
  const openFile = jest.fn();
  render(
    <KnowledgePaneContext.Provider value={{ openFile }}>
      <EmbeddedKnowledge client={api as unknown as VerityClient} scope={PROJECT} />
    </KnowledgePaneContext.Provider>,
  );
  fireEvent.press(screen.getByText('Wiki'));
  fireEvent.press(await screen.findByText('reference.md'));
  expect(openFile).toHaveBeenCalledWith(PROJECT, file.path);
  expect(mockPush).not.toHaveBeenCalled();
  // One level up from the Wiki is the project's areas, named on the way back.
  fireEvent.press(screen.getByText('Project knowledge'));
  expect(await screen.findByText('Sources')).toBeTruthy();
});

it('keeps the project sections out of a Shared Wiki', async () => {
  client({
    listSharedKnowledgeFiles: jest.fn().mockResolvedValue({
      root: 'shared',
      path: 'insights',
      entries: [{ path: 'insights/decisions', name: 'decisions', kind: 'directory' }],
      truncated: false,
    }),
  });
  render(<KnowledgeScreen scope={SHARED} folder="insights" />);
  // Shared has no confirmed project decisions; a folder there is just a folder.
  expect(await screen.findByText('decisions')).toBeTruthy();
  expect(screen.queryByText('Confirmed choices, with reason and origin')).toBeNull();
  expect(folderTitle(SHARED, 'insights/decisions')).toBe('decisions');
  expect(folderTitle(PROJECT, 'insights/decisions')).toBe('Decisions');
});

it('lists Decisions first inside a project Wiki and goes back up to the Wiki', async () => {
  const api = client({
    listProjectKnowledgeFiles: jest.fn().mockResolvedValue({
      root: 'knowledge',
      path: 'insights',
      entries: [
        { path: 'insights/architecture', name: 'architecture', kind: 'directory' },
        { path: 'insights/decisions', name: 'decisions', kind: 'directory' },
        { path: file.path, name: 'reference.md', kind: 'file' },
      ],
      truncated: false,
    }),
  });
  render(
    <KnowledgePaneContext.Provider value={{ openFile: jest.fn() }}>
      <EmbeddedKnowledge client={api as unknown as VerityClient} scope={PROJECT} start="insights" />
    </KnowledgePaneContext.Provider>,
  );
  const decisions = await screen.findByText('Decisions');
  // The server orders folders by name; Decisions is the Wiki's section, so it leads.
  const titles = screen
    .getAllByText(/^(Decisions|architecture)$/)
    .map((node) => node.props.children);
  expect(titles).toEqual(['Decisions', 'architecture']);
  // Opened at the Wiki, the column offers no way up to the areas it replaced.
  expect(screen.queryByText('Project knowledge')).toBeNull();
  fireEvent.press(decisions);
  await waitFor(() =>
    expect(api.listProjectKnowledgeFiles).toHaveBeenLastCalledWith('p', 'insights/decisions'),
  );
  fireEvent.press(await screen.findByText('Wiki'));
  await waitFor(() =>
    expect(api.listProjectKnowledgeFiles).toHaveBeenLastCalledWith('p', 'insights'),
  );
});

it('keeps only Code and Drive in session root tabs and Shared in Settings', () => {
  const session = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
  const roots = session.slice(
    session.indexOf('<View style={styles.filesRootBar}>'),
    session.indexOf('<FileBreadcrumb'),
  );
  expect([...roots.matchAll(/accessibilityLabel="([^"]+)"/g)].map((match) => match[1])).toEqual([
    'Code',
    'Google Drive',
  ]);
  const settings = readFileSync(join(__dirname, '../app/settings/index.tsx'), 'utf8');
  expect(settings).toContain("router.push('/settings/shared-knowledge')");
});

it('confirms Wiki folder deletion including its contents and reloads the list', async () => {
  const remove = jest.fn().mockResolvedValue(undefined);
  const api = client({ deleteProjectKnowledgeFile: remove });
  render(<KnowledgeScreen scope={PROJECT} folder="insights/:files" />);
  fireEvent.press(await screen.findByLabelText('Delete uplink'));
  expect(screen.getByText(/and everything inside it from the project Wiki/)).toBeTruthy();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('p', 'insights/uplink'));
  await waitFor(() => expect(api.listProjectKnowledgeFiles).toHaveBeenCalledTimes(2));
});

it('keeps structured decisions outside ordinary file deletion', async () => {
  client({
    listProjectKnowledgeFiles: jest.fn().mockResolvedValue({
      path: 'insights',
      entries: [
        { path: 'insights/decisions', name: 'decisions', kind: 'directory' },
        { path: 'sources/original.txt', name: 'original.txt', kind: 'file' },
      ],
      truncated: false,
    }),
  });
  render(<KnowledgeScreen scope={PROJECT} folder="insights/:files" />);
  await screen.findByText('Decisions');
  expect(screen.queryByLabelText('Delete decisions')).toBeNull();
  expect(screen.getByLabelText('Delete original.txt')).toBeTruthy();
});

it('keeps the Wiki entry visible and shows deletion errors for retry', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const remove = jest.fn().mockRejectedValue(new Error('Project management access required'));
  client({ deleteProjectKnowledgeFile: remove });
  render(<KnowledgeScreen scope={PROJECT} folder="insights/:files" />);
  fireEvent.press(await screen.findByLabelText('Delete reference.md'));
  fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith('Could not delete', 'Project management access required'),
  );
  alert.mockRestore();
  expect(screen.getByText('reference.md')).toBeTruthy();
});

it('confirms Sources folder deletion and refreshes its files', async () => {
  const remove = jest.fn().mockResolvedValue(undefined);
  const list = jest.fn().mockResolvedValue({
    path: 'sources/documents',
    entries: [
      { path: 'sources/documents/import', name: 'import', kind: 'directory' },
      { path: 'sources/documents/original.pdf', name: 'original.pdf', kind: 'file' },
    ],
    truncated: false,
  });
  client({ deleteProjectKnowledgeFile: remove, listProjectKnowledgeFiles: list });
  render(<KnowledgeScreen scope={PROJECT} folder="sources/documents" />);
  fireEvent.press(await screen.findByLabelText('Delete import'));
  expect(screen.getByText(/and everything inside it from the project Sources/)).toBeTruthy();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('p', 'sources/documents/import'));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});

it('renames a source, reloads the folder and keeps the open file on its new path', async () => {
  const list = jest.fn().mockResolvedValue({
    path: 'sources/documents',
    entries: [
      { path: 'sources/documents/import', name: 'import', kind: 'directory' },
      { path: 'sources/documents/call.md', name: 'call.md', kind: 'file' },
    ],
    truncated: false,
  });
  const rename = jest.fn().mockResolvedValue('sources/documents/kickoff.md');
  const api = client({ listProjectKnowledgeFiles: list, renameProjectKnowledgeFile: rename });
  const moved = jest.fn();
  render(
    <KnowledgePaneContext.Provider value={{ openFile: jest.fn(), moved }}>
      <EmbeddedKnowledge
        client={api as unknown as VerityClient}
        scope={PROJECT}
        start="sources/documents"
      />
    </KnowledgePaneContext.Provider>,
  );
  expect(await screen.findByLabelText('Rename import')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Rename call.md'));
  expect(
    screen.getByText('Wiki pages that cite this source keep pointing to the old name.'),
  ).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('File name'), 'kickoff.md');
  fireEvent.press(screen.getByRole('button', { name: 'Rename' }));
  await waitFor(() =>
    expect(rename).toHaveBeenCalledWith('p', 'sources/documents/call.md', 'kickoff.md'),
  );
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(moved).toHaveBeenCalledWith(
    PROJECT,
    'sources/documents/call.md',
    'sources/documents/kickoff.md',
  );
  expect(screen.queryByLabelText('File name')).toBeNull();
});

it('moves the open file with a renamed file or folder, and nothing else', () => {
  const open = { scope: PROJECT, file: 'sources/interviews/2026/anna.md' };
  expect(followMove(open, PROJECT, 'sources/interviews', 'sources/customers')).toEqual({
    scope: PROJECT,
    file: 'sources/customers/2026/anna.md',
  });
  expect(followMove(open, PROJECT, open.file, 'sources/interviews/2026/ben.md')?.file).toBe(
    'sources/interviews/2026/ben.md',
  );
  // A sibling sharing the name's start is another folder.
  expect(followMove(open, PROJECT, 'sources/inter', 'sources/x')).toBe(open);
  expect(
    followMove(open, { kind: 'project', projectId: 'other' }, 'sources/interviews', 'sources/x'),
  ).toBe(open);
  expect(followMove(null, PROJECT, 'sources/interviews', 'sources/x')).toBeNull();
});

it('keeps the rename dialog open with the server refusal', async () => {
  client({
    listProjectKnowledgeFiles: jest.fn().mockResolvedValue({
      path: 'sources',
      entries: [{ path: 'sources/interviews', name: 'interviews', kind: 'directory' }],
      truncated: false,
    }),
    renameProjectKnowledgeFile: jest.fn().mockRejectedValue(new Error('"taken" already exists')),
  });
  render(<KnowledgeScreen scope={PROJECT} folder="sources" />);
  fireEvent.press(await screen.findByLabelText('Rename interviews'));
  expect(screen.getByText('Rename folder')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('File name'), 'taken');
  fireEvent.press(screen.getByRole('button', { name: 'Rename' }));
  expect(await screen.findByText('"taken" already exists')).toBeTruthy();
  expect(screen.getByLabelText('File name')).toBeTruthy();
});

it('offers rename only for ordinary Sources entries', async () => {
  client({
    listProjectKnowledgeFiles: jest.fn().mockResolvedValue({
      path: 'sources',
      entries: [
        { path: 'sources/documents', name: 'documents', kind: 'directory' },
        { path: 'sources/meetings', name: 'meetings', kind: 'directory' },
        { path: 'sources/interviews', name: 'interviews', kind: 'directory' },
      ],
      truncated: false,
    }),
  });
  render(<KnowledgeScreen scope={PROJECT} folder="sources" />);
  expect(await screen.findByLabelText('Rename interviews')).toBeTruthy();
  // Verity's own entry folders: an import would recreate them empty.
  expect(screen.queryByLabelText('Rename documents')).toBeNull();
  expect(screen.queryByLabelText('Rename meetings')).toBeNull();
  expect(screen.getByLabelText('Delete meetings')).toBeTruthy();
});

it('does not offer rename in the Wiki, whose pages other pages link to', async () => {
  client();
  render(<KnowledgeScreen scope={PROJECT} folder="insights/:files" />);
  expect(await screen.findByLabelText('Delete reference.md')).toBeTruthy();
  expect(screen.queryByLabelText('Rename reference.md')).toBeNull();
});

it('uses one breadcrumb for nested Sources and can return to Sources or the project', async () => {
  const listing: Record<string, { path: string; name: string; kind: string }[]> = {
    sources: [{ path: 'sources/matrix', name: 'matrix', kind: 'directory' }],
    'sources/matrix': [{ path: 'sources/matrix/room', name: 'room', kind: 'directory' }],
    'sources/matrix/room': [
      { path: 'sources/matrix/room/message.md', name: 'message.md', kind: 'file' },
    ],
  };
  const list = jest.fn(async (_project: string, path: string) => ({
    path,
    entries: listing[path] ?? [],
    truncated: false,
  }));
  const api = client({ listProjectKnowledgeFiles: list });
  const exit = jest.fn();
  render(
    <KnowledgePaneContext.Provider value={{ openFile: jest.fn() }}>
      <EmbeddedKnowledge
        client={api as unknown as VerityClient}
        scope={PROJECT}
        start="sources"
        exit={{ label: 'Verity', onPress: exit }}
      />
    </KnowledgePaneContext.Provider>,
  );
  fireEvent.press(await screen.findByText('matrix'));
  fireEvent.press(await screen.findByText('room'));
  await screen.findByText('message.md');
  for (const label of ['Verity', 'Sources', 'matrix', 'room']) {
    expect(screen.getAllByText(label)).toHaveLength(1);
  }
  expect(screen.queryByRole('button', { name: 'room' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Sources' }));
  await waitFor(() => expect(list).toHaveBeenLastCalledWith('p', 'sources'));
  expect(await screen.findByText('matrix')).toBeTruthy();
  expect(screen.queryByText('room')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Verity' }));
  expect(exit).toHaveBeenCalledTimes(1);
});
