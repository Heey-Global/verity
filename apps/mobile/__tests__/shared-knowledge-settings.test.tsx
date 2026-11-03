import type { VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
const mockClient = jest.fn<VerityClient | null, []>();
jest.mock('../lib/client', () => ({ createVerityClient: () => mockClient() }));
import { SharedKnowledgeSettings } from '../components/settings/SharedKnowledgeSettings';

it('opens the central library without choosing a project or session and preserves failed edits', async () => {
  const file = {
    path: 'insights/reference.md',
    content: 'Before',
    editable: true,
    version: 'a'.repeat(64),
    size: 6,
  };
  const list = jest.fn().mockResolvedValue({
    root: 'shared',
    path: '',
    entries: [{ path: file.path, name: 'Reference', kind: 'file' }],
    truncated: false,
  });
  const read = jest
    .fn()
    .mockResolvedValueOnce(file)
    .mockResolvedValue({ ...file, content: 'Remote edit', version: 'b'.repeat(64) });
  const write = jest
    .fn()
    .mockRejectedValueOnce(new Error('File changed; reload'))
    .mockResolvedValue({ ...file, content: 'After', version: 'b'.repeat(64) });
  mockClient.mockReturnValue({
    listSharedKnowledgeFiles: list,
    getSharedKnowledgeFile: read,
    writeSharedKnowledgeFile: write,
  } as unknown as VerityClient);
  render(<SharedKnowledgeSettings />);
  fireEvent.press(await screen.findByText('Reference'));
  await screen.findByDisplayValue('Before');
  await waitFor(() => expect(screen.getByLabelText('Content').props.editable).toBe(true));
  fireEvent.changeText(screen.getByLabelText('Content'), 'After');
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('File changed; reload');
  expect(screen.getByDisplayValue('After')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(await screen.findByDisplayValue('After')).toBeTruthy();
  await waitFor(() => expect(screen.getByLabelText('Content').props.editable).toBe(true));
  fireEvent.press(screen.getByText('Save'));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(write).toHaveBeenLastCalledWith(file.path, 'After', 'b'.repeat(64));
  await waitFor(() => expect(screen.queryByText('File changed; reload')).toBeNull());
  fireEvent.press(screen.getByText('Back to folder'));
  await waitFor(() => expect(list).toHaveBeenLastCalledWith('insights'));
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
