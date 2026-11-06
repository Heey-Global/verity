import type { VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());

const mockClient = jest.fn<VerityClient | null, []>();
jest.mock('../lib/client', () => ({ createVerityClient: () => mockClient() }));
import { ContextSettings } from '../components/settings/ContextSettings';

it('isolates drafts and pending responses when navigating to another context scope', async () => {
  let finishOldLoad!: (value: { memory: string; revision: string }) => void;
  const oldLoad = new Promise<{ memory: string; revision: string }>((resolve) => {
    finishOldLoad = resolve;
  });
  let finishNewLoad!: (value: { memory: string; revision: string }) => void;
  const newLoad = new Promise<{ memory: string; revision: string }>((resolve) => {
    finishNewLoad = resolve;
  });
  const read = jest
    .fn()
    .mockResolvedValueOnce({ memory: 'Project A fact', revision: 'same' })
    .mockImplementationOnce(() => oldLoad)
    .mockImplementationOnce(() => newLoad);
  const replace = jest.fn().mockRejectedValue(new Error('Reload required'));
  mockClient.mockReturnValue({
    getProjectMemory: read,
    replaceProjectMemory: replace,
  } as unknown as VerityClient);
  const view = render(<ContextSettings kind="memory" projectId="a" />);
  fireEvent.changeText(await screen.findByDisplayValue('Project A fact'), 'Unsaved A fact');
  fireEvent.press(screen.getByText('Save'));
  await screen.findByText('Reload required');
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  view.rerender(<ContextSettings kind="memory" projectId="b" />);
  expect(screen.queryByDisplayValue('Unsaved A fact')).toBeNull();
  await act(async () => {
    finishNewLoad({ memory: 'Project B fact', revision: 'b-revision' });
  });
  await screen.findByDisplayValue('Project B fact');
  await act(async () => {
    finishOldLoad({ memory: 'Late A response', revision: 'a-late' });
  });
  await waitFor(() => expect(screen.queryByDisplayValue('Late A response')).toBeNull());
  expect(screen.queryByDisplayValue('Unsaved A fact')).toBeNull();
  expect(screen.getByDisplayValue('Project B fact')).toBeTruthy();
  fireEvent.changeText(screen.getByDisplayValue('Project B fact'), 'Updated B fact');
  fireEvent.press(screen.getByText('Save'));
  await waitFor(() =>
    expect(replace).toHaveBeenLastCalledWith('b', {
      memory: 'Updated B fact',
      revision: 'b-revision',
    }),
  );
});

it('preserves the other personal field and retains the draft after a revision conflict', async () => {
  const replace = jest
    .fn()
    .mockRejectedValueOnce(new Error('Context changed; reload and try again'))
    .mockResolvedValue({ instructions: 'New rules', memory: 'Updated fact', revision: 5 });
  const read = jest
    .fn()
    .mockResolvedValueOnce({
      instructions: 'Original rules',
      memory: 'Keep this fact',
      revision: 3,
    })
    .mockResolvedValue({ instructions: 'Other rules', memory: 'Updated fact', revision: 4 });
  mockClient.mockReturnValue({
    getUserContext: read,
    replaceUserContext: replace,
  } as unknown as VerityClient);
  render(<ContextSettings kind="instructions" />);
  const editor = await screen.findByDisplayValue('Original rules');
  fireEvent.changeText(editor, 'New rules');
  fireEvent.press(screen.getByText('Save'));
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith({
      instructions: 'New rules',
      memory: 'Keep this fact',
      revision: 3,
    }),
  );
  expect(await screen.findByText('Context changed; reload and try again')).toBeTruthy();
  expect(screen.getByDisplayValue('New rules')).toBeTruthy();
  fireEvent.press(screen.getByText('Retry'));
  await waitFor(() =>
    expect(screen.queryByText('Context changed; reload and try again')).toBeNull(),
  );
  expect(screen.getByDisplayValue('New rules')).toBeTruthy();
  fireEvent.press(screen.getByText('Save'));
  await waitFor(() =>
    expect(replace).toHaveBeenLastCalledWith({
      instructions: 'New rules',
      memory: 'Updated fact',
      revision: 4,
    }),
  );
});

it('clears personal Memory without clearing Instructions', async () => {
  const replace = jest
    .fn()
    .mockResolvedValue({ instructions: 'Keep these rules', memory: '', revision: 2 });
  mockClient.mockReturnValue({
    getUserContext: jest
      .fn()
      .mockResolvedValue({ instructions: 'Keep these rules', memory: 'Old fact', revision: 1 }),
    replaceUserContext: replace,
  } as unknown as VerityClient);
  render(<ContextSettings kind="memory" />);
  await screen.findByDisplayValue('Old fact');
  fireEvent.press(screen.getByText('Clear Memory'));
  // Clearing is irreversible, so it asks first (§ 5.7) and nothing is sent yet.
  expect(replace).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Clear' }));
  });
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith({
      instructions: 'Keep these rules',
      memory: '',
      revision: 1,
    }),
  );
  await waitFor(() => expect(screen.queryByDisplayValue('Old fact')).toBeNull());
});

it('edits authoritative project Memory through its revisioned endpoint', async () => {
  const replace = jest.fn().mockResolvedValue({ memory: 'New project fact', revision: 'new' });
  mockClient.mockReturnValue({
    getProjectMemory: jest.fn().mockResolvedValue({ memory: 'Filesystem fact', revision: 'old' }),
    replaceProjectMemory: replace,
  } as unknown as VerityClient);
  render(<ContextSettings kind="memory" projectId="p" />);
  fireEvent.changeText(await screen.findByDisplayValue('Filesystem fact'), 'New project fact');
  fireEvent.press(screen.getByText('Save'));
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith('p', { memory: 'New project fact', revision: 'old' }),
  );
});

it('keeps Save as the one pinned action and offers Clear only for something to clear', async () => {
  mockClient.mockReturnValue({
    getUserContext: jest.fn().mockResolvedValue({ instructions: '', memory: '', revision: 1 }),
    replaceUserContext: jest.fn(),
  } as unknown as VerityClient);
  render(<ContextSettings kind="instructions" />);
  await act(async () => undefined);
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  // An empty field has nothing to clear; a disabled Clear was the second big button.
  expect(screen.queryByText('Clear Instructions')).toBeNull();
});
