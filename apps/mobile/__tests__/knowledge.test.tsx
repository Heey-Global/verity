import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { Library } from '../app/knowledge';
import { ProjectKnowledgeGrants } from '../components/knowledge/ProjectKnowledgeGrants';

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useNavigation: () => ({ addListener: () => () => {}, dispatch: jest.fn() }),
  useLocalSearchParams: () => ({}),
  router: { push: jest.fn() },
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), Paths: { cache: 'cache' } }));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn() }));
jest.mock('../lib/client', () => ({ createVerityClient: () => null }));
const folders = [
  { id: 'root', parentId: null, name: 'Company' },
  { id: 'child', parentId: 'root', name: 'Engineering' },
];
function fake() {
  return {
    listKnowledgeFolders: jest.fn().mockResolvedValue(folders),
    listKnowledgeDocuments: jest
      .fn()
      .mockResolvedValue([
        { id: 'doc', folderId: 'child', title: 'Standards', currentRevisionId: 'v1' },
      ]),
    getKnowledgeDocument: jest.fn().mockResolvedValue({
      id: 'doc',
      folderId: 'child',
      title: 'Standards',
      bodyMarkdown: '# Rules',
      currentRevisionId: 'v1',
    }),
    saveKnowledgeDocument: jest.fn().mockResolvedValue({
      id: 'doc',
      folderId: 'child',
      title: 'Standards',
      bodyMarkdown: '# New rules',
      currentRevisionId: 'v2',
    }),
    listKnowledgeGrants: jest.fn().mockResolvedValue([
      { folderId: 'root', mode: 'read_write' },
      { folderId: 'child', mode: 'read' },
    ]),
  };
}
test('edits the selected document with its loaded revision and previews Markdown', async () => {
  const client = fake();
  render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
  fireEvent.press(await screen.findByLabelText('Standards'));
  fireEvent.press(await screen.findByLabelText('Edit'));
  fireEvent.changeText(screen.getByLabelText('Markdown source'), '# New rules');
  fireEvent.press(screen.getByLabelText('Preview'));
  expect(screen.getByText('New rules')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Save'));
  await waitFor(() =>
    expect(client.saveKnowledgeDocument).toHaveBeenCalledWith('doc', {
      title: 'Standards',
      bodyMarkdown: '# New rules',
      expectedRevisionId: 'v1',
    }),
  );
});
test('a read child does not mask inherited write access', async () => {
  const client = fake();
  render(<ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="project" />);
  expect(await screen.findByLabelText('Engineering: inherited Read & Write')).toBeTruthy();
  expect(screen.getByLabelText('Open Engineering in Knowledge')).toBeTruthy();
});

test('a delayed grant save cannot replace the next project’s access selection', async () => {
  let complete!: (grants: { folderId: string; mode: string }[]) => void;
  const client = {
    ...fake(),
    listKnowledgeGrants: jest.fn((projectId: string) =>
      Promise.resolve(projectId === 'first' ? [{ folderId: 'root', mode: 'read' }] : []),
    ),
    saveKnowledgeGrants: jest.fn(
      () =>
        new Promise<{ folderId: string; mode: string }[]>((resolve) => {
          complete = resolve;
        }),
    ),
  };
  const view = render(
    <ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="first" />,
  );
  await chooseWriteAccess('Company');
  await waitFor(() => expect(client.saveKnowledgeGrants).toHaveBeenCalled());
  view.rerender(
    <ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="second" />,
  );
  expect(await screen.findByLabelText('Allow Company')).toBeTruthy();
  await act(async () => {
    complete([{ folderId: 'root', mode: 'read_write' }]);
  });
  expect(screen.getByLabelText('Allow Company')).toBeTruthy();
});

test('reloads committed grants when the cleanup acknowledgement fails', async () => {
  const client = {
    ...fake(),
    listKnowledgeGrants: jest
      .fn()
      .mockResolvedValueOnce([{ folderId: 'root', mode: 'read' }])
      .mockResolvedValue([]),
    saveKnowledgeGrants: jest
      .fn()
      .mockRejectedValue(new Error('Access changes were saved. Cleanup will retry.')),
  };
  render(<ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="project" />);
  await chooseWriteAccess('Company');
  expect(await screen.findByText('Access changes were saved. Cleanup will retry.')).toBeTruthy();
  expect(await screen.findByLabelText('Allow Company')).toBeTruthy();
});

test('following a link from a draft requires discard and opens the target outside edit mode', async () => {
  const client = fake();
  client.listKnowledgeDocuments.mockResolvedValue([
    { id: 'doc', folderId: 'child', title: 'Standards', currentRevisionId: 'v1' },
    { id: 'other', folderId: 'child', title: 'other.md', currentRevisionId: 'v2' },
  ]);
  client.getKnowledgeDocument.mockImplementation((id: string) =>
    Promise.resolve({
      id,
      folderId: 'child',
      title: id === 'other' ? 'other.md' : 'Standards',
      bodyMarkdown: id === 'other' ? '# Target' : '# Rules',
      currentRevisionId: id === 'other' ? 'v2' : 'v1',
    }),
  );
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
    fireEvent.press(await screen.findByLabelText('Standards'));
    fireEvent.press(await screen.findByLabelText('Edit'));
    fireEvent.changeText(screen.getByLabelText('Markdown source'), '[Other](other.md)');
    fireEvent.press(screen.getByLabelText('Preview'));
    fireEvent.press(screen.getByText('Other'));
    expect(alert).toHaveBeenCalledWith('Knowledge', 'Discard unsaved changes?', expect.any(Array));
    expect(client.getKnowledgeDocument).toHaveBeenCalledTimes(1);
    await act(async () => {
      alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Continue')?.onPress?.();
    });
    expect(await screen.findByText('Target')).toBeTruthy();
    expect(screen.getByLabelText('Edit')).toBeTruthy();
    expect(screen.queryByLabelText('Save')).toBeNull();
  } finally {
    alert.mockRestore();
  }
});

test('failed grant recovery blocks edits until an authoritative reload succeeds', async () => {
  const client = {
    ...fake(),
    listKnowledgeGrants: jest
      .fn()
      .mockResolvedValueOnce([{ folderId: 'root', mode: 'read' }])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([]),
    saveKnowledgeGrants: jest.fn().mockRejectedValue(new Error('Cleanup pending')),
  };
  render(<ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="project" />);
  await chooseWriteAccess('Company');
  await screen.findByText('Could not reload saved access. Reload before editing.');
  fireEvent.press(screen.getByLabelText('Company: Read'));
  expect(client.saveKnowledgeGrants).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText('Reload knowledge access'));
  expect(await screen.findByLabelText('Allow Company')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Allow Company'));
  await waitFor(() => expect(client.saveKnowledgeGrants).toHaveBeenCalledTimes(2));
});

test('moving a document updates its folder and permits moving back', async () => {
  const client = {
    ...fake(),
    previewKnowledgeDocumentMove: jest
      .fn()
      .mockResolvedValue({ affectedProjects: [], policyToken: 'policy' }),
    moveKnowledgeDocument: jest.fn().mockResolvedValue({
      id: 'doc',
      folderId: 'root',
      title: 'Standards',
      bodyMarkdown: '# Rules',
      currentRevisionId: 'v1',
    }),
  };
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
    fireEvent.press(await screen.findByLabelText('Standards'));
    fireEvent.press(await screen.findByLabelText('Move document'));
    fireEvent.press(screen.getByLabelText('Move to Company'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    await act(async () => {
      alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Continue')?.onPress?.();
    });
    expect(client.moveKnowledgeDocument).toHaveBeenCalledWith('doc', 'root', 'policy');
    expect(
      client.listKnowledgeDocuments.mock.calls.filter(([folder]) => folder === 'child'),
    ).toHaveLength(1);
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith('root', undefined);
    fireEvent.press(screen.getByLabelText('Move document'));
    expect(await screen.findByLabelText('Move to Engineering')).toBeTruthy();
    expect(screen.queryByLabelText('Move to Company')).toBeNull();
  } finally {
    alert.mockRestore();
  }
});

test('restoring a historical title refreshes the current folder listing', async () => {
  const restored = {
    id: 'doc',
    folderId: 'child',
    title: 'Old title',
    bodyMarkdown: '# Old',
    currentRevisionId: 'v3',
  };
  const client = {
    ...fake(),
    listKnowledgeRevisions: jest.fn().mockResolvedValue([
      {
        id: 'v0',
        documentId: 'doc',
        title: 'Old title',
        bodyMarkdown: '# Old',
        authorIdentity: 'operator',
        createdAt: '2026-09-19T00:00:00Z',
      },
    ]),
    restoreKnowledgeRevision: jest.fn().mockResolvedValue(restored),
  };
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
    fireEvent.press(await screen.findByLabelText('Standards'));
    fireEvent.press(await screen.findByLabelText('Revision history'));
    fireEvent.press(await screen.findByLabelText(/— You/));
    client.listKnowledgeDocuments.mockResolvedValue([restored]);
    fireEvent.press(screen.getByLabelText('Restore this revision'));
    await act(async () => {
      alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Continue')?.onPress?.();
    });
    fireEvent.press(screen.getByLabelText('Engineering'));
    expect(await screen.findByLabelText('Old title')).toBeTruthy();
    expect(screen.queryByLabelText('Standards')).toBeNull();
  } finally {
    alert.mockRestore();
  }
});

test('folder access tree collapses children without changing grants', async () => {
  const client = { ...fake(), saveKnowledgeGrants: jest.fn() };
  render(<ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="project" />);
  await screen.findByLabelText('Open Engineering in Knowledge');
  fireEvent.press(screen.getByLabelText('Collapse Company'));
  expect(screen.queryByLabelText('Open Engineering in Knowledge')).toBeNull();
  fireEvent.press(screen.getByLabelText('Expand Company'));
  expect(screen.getByLabelText('Open Engineering in Knowledge')).toBeTruthy();
  expect(client.saveKnowledgeGrants).not.toHaveBeenCalled();
});

test('inherited access remains checked until its parent grant is removed', async () => {
  const client = {
    ...fake(),
    listKnowledgeGrants: jest.fn().mockResolvedValue([{ folderId: 'root', mode: 'read' }]),
    saveKnowledgeGrants: jest.fn(),
  };
  render(<ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="project" />);
  const inherited = await screen.findByLabelText('Allow Engineering');
  expect(inherited.props.accessibilityState).toMatchObject({ checked: true, disabled: true });
  fireEvent.press(inherited);
  expect(client.saveKnowledgeGrants).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Engineering: Read')).toBeTruthy();
});

test('new folder toolbar opens a compact form and creates inside the selected folder', async () => {
  const client = { ...fake(), createKnowledgeFolder: jest.fn().mockResolvedValue({ id: 'new' }) };
  render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
  await screen.findByLabelText('Standards');
  expect(screen.queryByLabelText('Folder name')).toBeNull();
  fireEvent.press(screen.getByLabelText('New folder'));
  fireEvent.changeText(screen.getByLabelText('Folder name'), 'Notes');
  fireEvent.press(screen.getByLabelText('Create folder'));
  await waitFor(() =>
    expect(client.createKnowledgeFolder).toHaveBeenCalledWith({
      name: 'Notes',
      parentId: 'child',
    }),
  );
  await waitFor(() => expect(screen.queryByLabelText('Folder name')).toBeNull());
});

async function chooseWriteAccess(name: string) {
  const alert = jest.spyOn(Alert, 'alert');
  try {
    fireEvent.press(await screen.findByLabelText(`${name}: Read`));
    await act(async () => {
      alert.mock.calls
        .at(-1)?.[2]
        ?.find((button) => button.text === 'Read & Write')
        ?.onPress?.();
    });
  } finally {
    alert.mockRestore();
  }
}

test('a child can add write access while inheriting read access', async () => {
  const client = {
    ...fake(),
    listKnowledgeGrants: jest.fn().mockResolvedValue([{ folderId: 'root', mode: 'read' }]),
    saveKnowledgeGrants: jest.fn().mockImplementation(async (_projectId, grants) => grants),
  };
  render(<ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="project" />);
  await chooseWriteAccess('Engineering');
  expect(client.saveKnowledgeGrants).toHaveBeenCalledWith('project', [
    { folderId: 'root', mode: 'read' },
    { folderId: 'child', mode: 'read_write' },
  ]);
});

test('library folders expand and collapse without changing the library', async () => {
  const client = fake();
  render(<Library client={client as unknown as VerityClient} initialFolder={null} />);
  await screen.findByLabelText('Folder: Company');
  expect(screen.queryByLabelText('Folder: Engineering')).toBeNull();
  fireEvent.press(screen.getByLabelText('Folder: Company'));
  expect(screen.getByLabelText('Folder: Engineering')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Folder: Engineering'));
  expect(await screen.findByLabelText('Standards')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Folder: Company'));
  fireEvent.press(screen.getByLabelText('Folder: Company'));
  expect(screen.queryByLabelText('Folder: Engineering')).toBeNull();
});
