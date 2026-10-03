import { VerityApiError, type SessionFileContent } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { FileTextEditor } from './FileTextEditor';

const file: SessionFileContent = {
  path: 'notes/a.md',
  content: 'original',
  size: 8,
  version: 'old',
  editable: true,
};
const mount = (
  save = jest.fn(
    async (path: string, content: string, version: string | null): Promise<SessionFileContent> => ({
      ...file,
      path,
      content,
      version: version ?? 'created',
    }),
  ),
  read = jest.fn(async (): Promise<SessionFileContent> => ({
    ...file,
    version: 'latest',
    content: 'agent changes',
  })),
  initial = file,
) => {
  const saved = jest.fn();
  const cancel = jest.fn();
  render(
    <FileTextEditor file={initial} onSave={save} onRead={read} onSaved={saved} onCancel={cancel} />,
  );
  return { save, read, saved, cancel };
};

it('only saves changed text and passes the version it was based on', async () => {
  const { save, saved } = mount();
  expect(screen.getByLabelText('Save').props.accessibilityState.disabled).toBe(true);
  fireEvent.changeText(screen.getByLabelText('File contents'), 'my edits');
  await act(async () => fireEvent.press(screen.getByLabelText('Save')));
  expect(save).toHaveBeenCalledWith('notes/a.md', 'my edits', 'old');
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ content: 'my edits' }));
});

it('asks before discarding edits, including system-back dismissal', () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { cancel } = mount();
  fireEvent.changeText(screen.getByLabelText('File contents'), 'my edits');
  fireEvent.press(screen.getByLabelText('Cancel'));
  expect(cancel).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith(
    'Unsaved changes',
    expect.any(String),
    expect.arrayContaining([expect.objectContaining({ text: 'Discard' })]),
  );
  const buttons = alert.mock.calls[0]?.[2];
  act(() => buttons?.find((button) => button.text === 'Discard')?.onPress?.());
  expect(cancel).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});

it('preserves the draft on conflict and uses a fresh version for explicit overwrite', async () => {
  const save = jest
    .fn<Promise<SessionFileContent>, [string, string, string | null]>()
    .mockRejectedValueOnce(new VerityApiError(409, 'file changed'))
    .mockResolvedValueOnce({ ...file, content: 'my edits', version: 'saved' });
  const { read, saved } = mount(save);
  fireEvent.changeText(screen.getByLabelText('File contents'), 'my edits');
  await act(async () => fireEvent.press(screen.getByLabelText('Save')));
  expect(screen.getByLabelText('File contents')).toHaveDisplayValue('my edits');
  await act(async () => fireEvent.press(screen.getByLabelText('Overwrite with my edits')));
  expect(read).toHaveBeenCalledWith('notes/a.md');
  expect(save).toHaveBeenLastCalledWith('notes/a.md', 'my edits', 'latest');
  expect(saved).toHaveBeenCalledTimes(1);
});

it('reloads only when explicitly chosen after conflict', async () => {
  const save = jest
    .fn<Promise<SessionFileContent>, [string, string, string | null]>()
    .mockRejectedValue(new VerityApiError(409, 'file changed'));
  mount(save);
  fireEvent.changeText(screen.getByLabelText('File contents'), 'my edits');
  await act(async () => fireEvent.press(screen.getByLabelText('Save')));
  await act(async () => fireEvent.press(screen.getByLabelText('Reload and discard edits')));
  expect(screen.getByLabelText('File contents')).toHaveDisplayValue('agent changes');
  expect(screen.getByLabelText('Save').props.accessibilityState.disabled).toBe(true);
});

it('allows saving an empty new file with create-only semantics', async () => {
  const { save } = mount(undefined, undefined, {
    ...file,
    content: '',
    size: 0,
    version: undefined,
  });
  await act(async () => fireEvent.press(screen.getByLabelText('Save')));
  expect(save).toHaveBeenCalledWith('notes/a.md', '', null);
});

it('saves a conflict copy with create-only semantics and retains the draft', async () => {
  const save = jest
    .fn<Promise<SessionFileContent>, [string, string, string | null]>()
    .mockRejectedValueOnce(new VerityApiError(409, 'file changed'))
    .mockResolvedValueOnce({ ...file, path: 'notes/a-copy.md', content: 'my edits' });
  const { saved } = mount(save);
  fireEvent.changeText(screen.getByLabelText('File contents'), 'my edits');
  await act(async () => fireEvent.press(screen.getByLabelText('Save')));
  fireEvent.press(screen.getByLabelText('Save a copy…'));
  await act(async () => fireEvent.press(screen.getByLabelText('Save copy')));
  expect(save).toHaveBeenLastCalledWith('notes/a-copy.md', 'my edits', null);
  expect(saved).toHaveBeenCalledTimes(1);
});

it('loads a backup as a draft and restores with the current conditional version', async () => {
  const save = jest.fn(async (): Promise<SessionFileContent> => file);
  const history = jest.fn(async () => [
    { id: 'save-abc/snapshot', createdAt: '2026-10-03T10:00:00Z', kind: 'snapshot' },
  ]);
  const version = jest.fn(async () => 'older text');
  render(
    <FileTextEditor
      file={file}
      onSave={save}
      onRead={async () => file}
      onSaved={() => {}}
      onCancel={() => {}}
      onHistory={history}
      onVersion={version}
    />,
  );
  await act(async () => fireEvent.press(screen.getByLabelText('Versions')));
  await act(async () => fireEvent.press(screen.getByText(/Saved version/)));
  expect(screen.getByLabelText('File contents').props.value).toBe('older text');
  expect(save).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByLabelText('Save')));
  expect(save).toHaveBeenCalledWith(file.path, 'older text', file.version);
});
