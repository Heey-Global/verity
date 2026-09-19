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
  expect(
    await screen.findByText('Engineering — effective: Read & Write (inherited Read & Write)'),
  ).toBeTruthy();
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
  fireEvent.press(await screen.findByLabelText('Company: Read'));
  await waitFor(() => expect(client.saveKnowledgeGrants).toHaveBeenCalled());
  view.rerender(
    <ProjectKnowledgeGrants client={client as unknown as VerityClient} projectId="second" />,
  );
  expect(await screen.findByText('Company — effective: None')).toBeTruthy();
  await act(async () => {
    complete([{ folderId: 'root', mode: 'read_write' }]);
  });
  expect(screen.getByText('Company — effective: None')).toBeTruthy();
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
  fireEvent.press(await screen.findByLabelText('Company: Read'));
  expect(await screen.findByText('Access changes were saved. Cleanup will retry.')).toBeTruthy();
  expect(await screen.findByText('Company — effective: None')).toBeTruthy();
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
  fireEvent.press(await screen.findByLabelText('Company: Read'));
  await screen.findByText('Could not reload saved access. Reload before editing.');
  fireEvent.press(screen.getByLabelText('Company: Read'));
  expect(client.saveKnowledgeGrants).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText('Reload knowledge access'));
  expect(await screen.findByText('Company — effective: None')).toBeTruthy();
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
    fireEvent.press(screen.getByLabelText('Move document'));
    expect(await screen.findByLabelText('Move to Engineering')).toBeTruthy();
    expect(screen.queryByLabelText('Move to Company')).toBeNull();
  } finally {
    alert.mockRestore();
  }
});
