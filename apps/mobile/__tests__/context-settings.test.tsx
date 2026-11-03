import type { VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());

const mockClient = jest.fn<VerityClient | null, []>();
jest.mock('../lib/client', () => ({ createVerityClient: () => mockClient() }));
import { ContextSettings } from '../components/settings/ContextSettings';

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
