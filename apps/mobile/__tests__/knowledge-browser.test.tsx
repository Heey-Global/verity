// The knowledge browser (components/knowledge): Shared and project libraries.
//
// What is worth guarding: every folder and file is its own screen on a phone, so
// the header's back arrow and the swipe go up one level (there is no in-page
// "Back to folder" any more); a Markdown file reads as rendered text; a failed
// save keeps the draft and saves on top of the newer version; in the wide layout
// a folder opens in its column and a file in the right column.
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import type { VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EmbeddedKnowledge, KnowledgeScreen } from '../components/knowledge/KnowledgeBrowser';
import { KnowledgeFileView } from '../components/knowledge/KnowledgeFileView';
import { KnowledgePaneContext } from '../components/knowledge/KnowledgePane';
import { SHARED } from '../components/knowledge/knowledgeScope';
import { mockCreateVerityClient, mockPush, resetSettingsHarness } from './support/settingsHarness';

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
    ...extra,
  };
  mockCreateVerityClient.mockReturnValue(value as unknown as VerityClient);
  return value as typeof value & Record<string, jest.Mock>;
}

beforeEach(() => resetSettingsHarness());

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
  render(
    <KnowledgeFileView
      client={api as unknown as VerityClient}
      scope={SHARED}
      file={file.path}
      chrome="pane"
      onClose={onClose}
    />,
  );
  fireEvent.press(await screen.findByText('Edit'));
  fireEvent.changeText(screen.getByLabelText('Content'), 'Unsaved');
  fireEvent.press(screen.getByLabelText('Close file'));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Discard' })));
  expect(onClose).toHaveBeenCalled();
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
  for (const [label, folder] of [
    ['Decisions', 'insights/decisions'],
    ['Wiki', 'insights'],
    ['Raw Sources', 'sources'],
  ] as const) {
    fireEvent.press(screen.getByText(label));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/project/[id]/knowledge',
      params: { id: 'p', folder },
    });
  }
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
  expect(await screen.findByText('Decisions')).toBeTruthy();
});

it('keeps Shared out of the session root tabs and links Settings to the central screen', () => {
  const session = readFileSync(join(__dirname, '../app/session/[id].tsx'), 'utf8');
  const roots = session.slice(
    session.indexOf('<View style={styles.filesRootBar}>'),
    session.indexOf('<FileBreadcrumb'),
  );
  expect(roots).toContain("['documents', 'Wiki']");
  expect(roots).not.toContain("['shared'");
  const settings = readFileSync(join(__dirname, '../app/settings/index.tsx'), 'utf8');
  expect(settings).toContain("router.push('/settings/shared-knowledge')");
});
