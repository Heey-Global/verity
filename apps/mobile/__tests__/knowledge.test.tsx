import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ProjectKnowledge } from '../components/knowledge/ProjectKnowledge';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { VerityClient } from '@verity/mobile';
import { Library } from '../app/knowledge';
import { ProjectKnowledgeGrants } from '../components/knowledge/ProjectKnowledgeGrants';
import { KnowledgeOriginal } from '../components/knowledge/KnowledgeOriginal';

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

test('a delayed original replacement cannot reopen a document after navigation', async () => {
  let complete!: (document: {
    id: string;
    folderId: string;
    title: string;
    bodyMarkdown: string;
    currentRevisionId: string;
  }) => void;
  const client = {
    ...fake(),
    getKnowledgeSource: jest.fn().mockResolvedValue({
      documentId: 'doc',
      revisionId: 'v1',
      filename: 'source.pdf',
      mediaType: 'application/pdf',
      size: 10,
      sha256: 'hash',
      processingState: 'ready',
      processingNote: '',
      locators: [],
      previews: [],
    }),
    replaceKnowledgeSource: jest.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ),
  };
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'file:///source.pdf',
        name: 'source.pdf',
        size: 10,
        mimeType: 'application/pdf',
        lastModified: 0,
      },
    ],
  });
  jest
    .mocked(File)
    .mockImplementation(
      () => ({ base64: () => Promise.resolve('c291cmNl'), delete: jest.fn() }) as never,
    );
  const onReplaced = jest.fn(() => Promise.resolve());
  const onOriginal = jest.fn();
  const first = {
    id: 'doc',
    folderId: 'child',
    title: 'Standards',
    bodyMarkdown: '# Rules',
    currentRevisionId: 'v1',
  };
  const view = render(
    <KnowledgeOriginal
      client={client as unknown as VerityClient}
      document={first}
      onReplaced={onReplaced}
      onOriginal={onOriginal}
    />,
  );
  fireEvent.press(await screen.findByLabelText('Replace original file'));
  await waitFor(() => expect(client.replaceKnowledgeSource).toHaveBeenCalled());
  view.unmount();
  await act(async () => {
    complete({ ...first, currentRevisionId: 'v2' });
  });
  expect(onReplaced).not.toHaveBeenCalled();
});

test('retries a transient original lookup failure', async () => {
  const client = {
    ...fake(),
    getKnowledgeSource: jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(null),
  };
  const onOriginal = jest.fn();
  render(
    <KnowledgeOriginal
      client={client as unknown as VerityClient}
      document={{
        id: 'doc',
        folderId: 'child',
        title: 'Standards',
        bodyMarkdown: '# Rules',
        currentRevisionId: 'v1',
      }}
      onReplaced={() => Promise.resolve()}
      onOriginal={onOriginal}
    />,
  );
  expect(await screen.findByLabelText('Retry original lookup')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Retry original lookup'));
  await waitFor(() => expect(client.getKnowledgeSource).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(onOriginal).toHaveBeenLastCalledWith(false));
  expect(screen.queryByLabelText('Retry original lookup')).toBeNull();
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

test('more folder actions open as an overlay from the toolbar', async () => {
  const client = fake();
  render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
  fireEvent.press(await screen.findByLabelText('More folder actions'));
  expect(screen.getByLabelText('Rename folder')).toBeTruthy();
  expect(screen.getByLabelText('Import source bundle')).toBeTruthy();
  expect(screen.getByLabelText('Export Markdown bundle')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Close folder actions'));
  expect(screen.queryByLabelText('Rename folder')).toBeNull();
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
  fireEvent.press(screen.getByLabelText('Expand folder: Company'));
  expect(screen.getByLabelText('Folder: Engineering')).toBeTruthy();
  expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith(undefined, undefined);
  fireEvent.press(screen.getByLabelText('Expand folder: Engineering'));
  fireEvent.press(screen.getByLabelText('Folder: Engineering'));
  expect(await screen.findByLabelText('Standards')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Collapse folder: Company'));
  expect(screen.queryByLabelText('Folder: Engineering')).toBeNull();
});

const managedSpace = {
  projectId: 'project',
  rootFolderId: 'root',
  sourcesFolderId: 'sources',
  wikiFolderId: 'wiki',
  generalFolderId: 'general',
};
function managedClient() {
  return {
    ...fake(),
    getProjectKnowledgeSpace: jest.fn().mockResolvedValue(managedSpace),
    getProjectKnowledgeOverview: jest.fn().mockResolvedValue(null),
    listKnowledgeWikiJobs: jest.fn().mockResolvedValue([]),
    listModels: jest.fn().mockResolvedValue({ models: ['provider/model'] }),
    getVeritySettings: jest.fn().mockResolvedValue({ knowledgeModel: null }),
    updateVeritySettings: jest.fn().mockImplementation((patch) => Promise.resolve(patch)),
    createKnowledgeWikiJob: jest.fn().mockResolvedValue({
      id: 'job',
      projectId: 'project',
      sessionId: 'fresh-session',
      kind: 'ingest',
      status: 'pending',
      sourceRevisions: [{ documentId: 'source', revisionId: 'v1' }],
      createdAt: 1,
      error: null,
    }),
    approveProjectKnowledgeOverview: jest.fn().mockResolvedValue({
      documentId: 'overview',
      revisionId: 'v2',
      title: 'Overview',
      bodyMarkdown: 'Approved',
    }),
  };
}

test('managed project folders stay connected and cannot grant Sources write access', async () => {
  const client = {
    ...fake(),
    listKnowledgeFolders: jest.fn().mockResolvedValue([
      { id: 'root', parentId: null, name: 'Project', role: 'project', projectId: 'project' },
      { id: 'sources', parentId: 'root', name: 'Sources', role: 'sources', projectId: 'project' },
      { id: 'wiki', parentId: 'root', name: 'Wiki', role: 'wiki', projectId: 'project' },
      { id: 'general', parentId: null, name: 'General', role: 'general' },
      { id: 'nested', parentId: 'sources', name: 'Meetings' },
      { id: 'general-child', parentId: 'general', name: 'Brand' },
      { id: 'extra', parentId: null, name: 'Extra' },
    ]),
    listKnowledgeGrants: jest.fn().mockResolvedValue([
      { folderId: 'root', mode: 'read', fixed: 'project' },
      { folderId: 'sources', mode: 'read', fixed: 'project' },
      { folderId: 'wiki', mode: 'read_write', fixed: 'project' },
      { folderId: 'general', mode: 'read', fixed: 'general' },
    ]),
    saveKnowledgeGrants: jest.fn().mockResolvedValue([]),
  };
  render(<ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="project" />);
  expect(await screen.findByLabelText('Always connected: Sources')).toBeDisabled();
  expect(screen.getByLabelText('Always connected: General')).toBeDisabled();
  expect(screen.queryByLabelText('Sources: Read')).toBeNull();
  expect(screen.getByLabelText('Meetings: Read only')).toBeTruthy();
  expect(screen.getByLabelText('Brand: Read only')).toBeTruthy();
  expect(screen.queryByLabelText('Meetings: Read')).toBeNull();

  fireEvent.press(screen.getByLabelText('Allow Extra'));
  await waitFor(() =>
    expect(client.saveKnowledgeGrants).toHaveBeenCalledWith('project', [
      { folderId: 'extra', mode: 'read' },
    ]),
  );
});

test('Knowledge model selection is system-wide and source ingestion is automatic', async () => {
  const client = managedClient();
  render(
    <ProjectKnowledge
      client={client as unknown as VerityClient}
      projectId="project"
      document={{ id: 'source', folderId: 'sources', title: 'Meeting', currentRevisionId: 'v1' }}
    />,
  );
  expect(screen.queryByLabelText('Sources')).toBeNull();
  expect(screen.queryByLabelText('Wiki')).toBeNull();
  expect(screen.queryByLabelText('Refresh knowledge')).toBeNull();
  fireEvent.press(await screen.findByLabelText('Knowledge model: automatic'));
  fireEvent.press(await screen.findByLabelText('provider/model'));
  await waitFor(() =>
    expect(client.updateVeritySettings).toHaveBeenCalledWith({ knowledgeModel: 'provider/model' }),
  );
  expect(client.createKnowledgeWikiJob).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Add this Source to the Wiki')).toBeNull();
});

test('running Wiki jobs refresh their status automatically', async () => {
  jest.useFakeTimers();
  const pending = {
    id: 'job',
    projectId: 'project',
    sessionId: 'fresh-session',
    kind: 'check' as const,
    status: 'running' as const,
    sourceRevisions: [],
    createdAt: 1,
    error: null,
  };
  const client = {
    ...managedClient(),
    listKnowledgeWikiJobs: jest
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValue([{ ...pending, status: 'completed' as const }]),
  };
  try {
    render(<ProjectKnowledge client={client as unknown as VerityClient} projectId="project" />);
    await act(async () => Promise.resolve());
    expect(screen.getByLabelText('Wiki review · Running · 0 sources')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Wiki review · Completed · 0 sources')).toBeTruthy();
    expect(client.listKnowledgeWikiJobs).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

test('an additional shared source never offers project Wiki ingestion', async () => {
  const client = managedClient();
  render(
    <ProjectKnowledge
      client={client as unknown as VerityClient}
      projectId="project"
      document={{
        id: 'private',
        folderId: 'another-project',
        title: 'Shared source',
        currentRevisionId: 'v1',
      }}
    />,
  );
  await screen.findByLabelText(/Knowledge model:/);
  expect(screen.queryByLabelText('Add this Source to the Wiki')).toBeNull();
  expect(screen.queryByLabelText('Use as project briefing')).toBeNull();
});

test('overview activation requires approval and uses the loaded revision', async () => {
  const client = managedClient();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    render(
      <ProjectKnowledge
        client={client as unknown as VerityClient}
        projectId="project"
        document={{ id: 'overview', folderId: 'wiki', title: 'Overview', currentRevisionId: 'v2' }}
      />,
    );
    fireEvent.press(await screen.findByLabelText('Use as project briefing'));
    expect(client.approveProjectKnowledgeOverview).not.toHaveBeenCalled();
    await act(async () => {
      alert.mock.calls
        .at(-1)?.[2]
        ?.find((button) => button.text === 'Approve')
        ?.onPress?.();
    });
    expect(client.approveProjectKnowledgeOverview).toHaveBeenCalledWith(
      'project',
      'overview',
      'v2',
    );
  } finally {
    alert.mockRestore();
  }
});

test('uploads original bytes into the selected folder without Markdown conversion', async () => {
  const pick = jest.mocked(DocumentPicker.getDocumentAsync);
  pick.mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'cache/source.pdf',
        lastModified: 0,
        name: 'Style guide.pdf',
        size: 12,
        mimeType: 'application/pdf',
      },
    ],
  });
  const remove = jest.fn();
  jest
    .mocked(File)
    .mockImplementation(
      () => ({ base64: async () => 'cGRmLWJ5dGVz', delete: remove }) as unknown as File,
    );
  const client = {
    ...fake(),
    uploadKnowledgeSource: jest.fn().mockResolvedValue({
      id: 'original',
      folderId: 'child',
      title: 'Style guide.pdf',
      currentRevisionId: 'original-v1',
    }),
  };
  try {
    render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
    await screen.findByLabelText('Folder: Engineering');
    fireEvent.press(screen.getByLabelText('Upload original files'));
    await waitFor(() =>
      expect(client.uploadKnowledgeSource).toHaveBeenCalledWith({
        folderId: 'child',
        filename: 'Style guide.pdf',
        base64: 'cGRmLWJ5dGVz',
      }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalled());
  } finally {
    pick.mockReset();
    jest.mocked(File).mockReset();
  }
});

test('validates every selected original before starting a multi-file upload', async () => {
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'cache/ok.pdf',
        name: 'ok.pdf',
        size: 12,
        mimeType: 'application/pdf',
        lastModified: 0,
      },
      {
        uri: 'cache/large.pdf',
        name: 'large.pdf',
        size: 11 * 1024 * 1024,
        mimeType: 'application/pdf',
        lastModified: 0,
      },
    ],
  });
  jest
    .mocked(File)
    .mockImplementation(
      () => ({ base64: async () => 'cGRm', delete: jest.fn() }) as unknown as File,
    );
  const client = { ...fake(), uploadKnowledgeSource: jest.fn() };
  render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
  await screen.findByLabelText('Folder: Engineering');
  fireEvent.press(screen.getByLabelText('Upload original files'));
  expect((await screen.findByRole('alert')).props.children).toContain(
    'Each original is limited to 10 MiB',
  );
  expect(client.uploadKnowledgeSource).not.toHaveBeenCalled();
});

test('refreshes successful original uploads when a later upload fails', async () => {
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'cache/a.pdf',
        name: 'a.pdf',
        size: 12,
        mimeType: 'application/pdf',
        lastModified: 0,
      },
      {
        uri: 'cache/b.pdf',
        name: 'b.pdf',
        size: 12,
        mimeType: 'application/pdf',
        lastModified: 0,
      },
    ],
  });
  jest
    .mocked(File)
    .mockImplementation(
      () => ({ base64: async () => 'cGRm', delete: jest.fn() }) as unknown as File,
    );
  const client = {
    ...fake(),
    uploadKnowledgeSource: jest
      .fn()
      .mockResolvedValueOnce({ id: 'a' })
      .mockRejectedValueOnce(new Error('second upload failed')),
  };
  render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
  await screen.findByLabelText('Folder: Engineering');
  fireEvent.press(screen.getByLabelText('Upload original files'));
  expect((await screen.findByRole('alert')).props.children).toContain('second upload failed');
  expect(client.listKnowledgeDocuments).toHaveBeenCalledTimes(2);
});

test('unsupported source extraction keeps the original available and states the limitation', async () => {
  const client = {
    ...fake(),
    getKnowledgeSource: jest.fn().mockResolvedValue({
      revisionId: 'v1',
      filename: 'Scanned.pdf',
      mediaType: 'application/pdf',
      size: 1024,
      sha256: 'digest',
      processingState: 'unsupported',
      processingNote: 'Scanned pages require OCR; no text was extracted.',
      locators: [],
      previews: [],
    }),
  };
  render(<Library client={client as unknown as VerityClient} initialFolder="child" />);
  fireEvent.press(await screen.findByLabelText('Standards'));
  expect(await screen.findByText('Scanned pages require OCR; no text was extracted.')).toBeTruthy();
  expect(screen.getByLabelText('Open original file')).toBeEnabled();
  expect(client.getKnowledgeSource).toHaveBeenCalledWith('doc', 'v1');
});

test('stale Wiki pages rely on automatic maintenance without a manual review action', async () => {
  const client = managedClient();
  render(
    <ProjectKnowledge
      client={client as unknown as VerityClient}
      projectId="project"
      document={{
        id: 'page',
        folderId: 'wiki',
        title: 'Overview',
        currentRevisionId: 'v1',
        stale: true,
      }}
    />,
  );
  await screen.findByLabelText(/Knowledge model:/);
  expect(screen.queryByLabelText('Review outdated Wiki page')).toBeNull();
  expect(client.createKnowledgeWikiJob).not.toHaveBeenCalled();
});
