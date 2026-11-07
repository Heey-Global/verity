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

describe('project Instructions', () => {
  const repository = (extra: Record<string, unknown>) => ({
    kind: 'github',
    owner: 'acme',
    isDefault: false,
    path: 'AGENTS.md',
    branch: 'main',
    ...extra,
  });

  it('edits in place, offers Save only after a change and shows repository rules read-only', async () => {
    const replace = jest
      .fn()
      .mockRejectedValueOnce(new Error('Project Instructions changed; reload before saving'))
      .mockResolvedValue({ instructions: 'Reply in German.', revision: 'r3' });
    mockClient.mockReturnValue({
      getProjectInstructions: jest
        .fn()
        .mockResolvedValueOnce({ instructions: 'Write clearly.', revision: 'r1' })
        .mockResolvedValue({ instructions: 'Changed elsewhere.', revision: 'r2' }),
      getProjectRepositoryInstructions: jest.fn().mockResolvedValue([
        repository({
          id: 'default:p',
          name: 'acme/mobile',
          repo: 'mobile',
          isDefault: true,
          status: 'present',
          instructions: 'Run the mobile tests.',
          revision: 'b1',
          truncated: false,
        }),
        repository({ id: 'docs', name: 'acme/docs', repo: 'docs', status: 'missing' }),
        repository({
          id: 'api',
          name: 'acme/api',
          repo: 'api',
          kind: 'forgejo',
          status: 'unavailable',
          branch: null,
        }),
      ]),
      replaceProjectInstructions: replace,
    } as unknown as VerityClient);
    render(<ContextSettings kind="instructions" projectId="p" />);
    const editor = await screen.findByDisplayValue('Write clearly.');
    expect(screen.queryByText('Save')).toBeNull();
    expect(await screen.findByText('Run the mobile tests.')).toBeTruthy();
    expect(screen.getByText('acme/mobile')).toBeTruthy();
    // No AGENTS.md is not worth a card; a host that could not be asked is named,
    // so "no rules" and "could not check" never look the same.
    expect(screen.queryByText('acme/docs')).toBeNull();
    expect(screen.getByText('Could not load AGENTS.md from acme/api.')).toBeTruthy();
    expect(screen.queryByDisplayValue('Run the mobile tests.')).toBeNull();
    fireEvent.changeText(editor, 'Reply in German.');
    fireEvent.press(screen.getByText('Save'));
    await screen.findByText('Project Instructions changed; reload before saving');
    expect(screen.getByDisplayValue('Reply in German.')).toBeTruthy();
    // Retry fetches the current revision and keeps the draft; saving again is the
    // person's explicit choice to replace what changed elsewhere.
    fireEvent.press(screen.getByText('Retry'));
    await waitFor(() =>
      expect(screen.queryByText('Project Instructions changed; reload before saving')).toBeNull(),
    );
    expect(screen.getByDisplayValue('Reply in German.')).toBeTruthy();
    fireEvent.press(screen.getByText('Save'));
    await waitFor(() =>
      expect(replace).toHaveBeenLastCalledWith('p', {
        instructions: 'Reply in German.',
        revision: 'r2',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Save')).toBeNull());
  });

  it('keeps the project Instructions editable when repository rules cannot be loaded', async () => {
    const listRepositories = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([]);
    mockClient.mockReturnValue({
      getProjectInstructions: jest
        .fn()
        .mockResolvedValue({ instructions: 'Rules.', revision: 'r' }),
      getProjectRepositoryInstructions: listRepositories,
    } as unknown as VerityClient);
    render(<ContextSettings kind="instructions" projectId="p" />);
    expect(await screen.findByDisplayValue('Rules.')).toBeTruthy();
    expect(await screen.findByText('Repository instructions could not be loaded.')).toBeTruthy();
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() =>
      expect(screen.queryByText('Repository instructions could not be loaded.')).toBeNull(),
    );
    expect(listRepositories).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('From repositories')).toBeNull();
  });

  it('keeps the revision of a save when an older reload answers after it', async () => {
    let finishReload!: (value: { instructions: string; revision: string }) => void;
    const replace = jest
      .fn()
      .mockRejectedValueOnce(new Error('Could not reach the server'))
      .mockResolvedValueOnce({ instructions: 'Saved rules.', revision: 'r3' })
      .mockResolvedValue({ instructions: 'Saved rules, again.', revision: 'r4' });
    mockClient.mockReturnValue({
      getProjectInstructions: jest
        .fn()
        .mockResolvedValueOnce({ instructions: 'Rules.', revision: 'r1' })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishReload = resolve;
            }),
        ),
      getProjectRepositoryInstructions: jest.fn().mockResolvedValue([]),
      replaceProjectInstructions: replace,
    } as unknown as VerityClient);
    render(<ContextSettings kind="instructions" projectId="p" />);
    fireEvent.changeText(await screen.findByDisplayValue('Rules.'), 'Saved rules.');
    fireEvent.press(screen.getByText('Save'));
    await screen.findByText('Could not reach the server');
    fireEvent.press(screen.getByText('Retry'));
    fireEvent.press(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByText('Save')).toBeNull());
    // The reload began before the save finished; its older revision must not
    // replace the one the save returned.
    await act(async () => {
      finishReload({ instructions: 'Rules.', revision: 'r2' });
    });
    expect(screen.getByDisplayValue('Saved rules.')).toBeTruthy();
    fireEvent.changeText(screen.getByDisplayValue('Saved rules.'), 'Saved rules, again.');
    fireEvent.press(screen.getByText('Save'));
    await waitFor(() =>
      expect(replace).toHaveBeenLastCalledWith('p', {
        instructions: 'Saved rules, again.',
        revision: 'r3',
      }),
    );
  });
});
