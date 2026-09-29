import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PublicPreviewShare, VerityClient } from '@verity/mobile';
import { StaticPreviewSheet } from '../components/project/StaticPreviewSheet';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));

it('creates and shows a static share for the folder selected in the session worktree', async () => {
  const share = {
    id: 'share-one',
    projectId: 'project-one',
    sessionId: 'session-one',
    targetKind: 'static-folder' as const,
    staticPath: 'site/dist',
    state: 'active' as const,
    publicOrigin: 'https://preview.example',
    expiresAt: '2030-01-01T01:00:00Z',
  };
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) =>
      path === 'site' ? ['dist'] : ['site'],
    ),
    listPublicPreviewShares: jest.fn(async () => []),
    createSessionStaticPreviewShare: jest.fn(async () => share),
    stopPublicPreviewShare: jest.fn(async () => undefined),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );

  fireEvent.press(await screen.findByLabelText('Open folder site'));
  fireEvent.press(await screen.findByLabelText('Open folder site/dist'));
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create link' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByText('Create link'));

  await waitFor(() =>
    expect(client.createSessionStaticPreviewShare).toHaveBeenCalledWith('session-one', {
      staticPath: 'site/dist',
      pin: '123456',
      ttlSeconds: 3600,
    }),
  );
  expect(await screen.findByText('https://preview.example')).toBeTruthy();
  expect(screen.getByText(/Available until/)).toBeTruthy();
  expect(screen.queryByLabelText('Preview PIN')).toBeNull();
  expect(
    screen.getByRole('link', { name: 'Open preview link https://preview.example' }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy preview link' })).toBeTruthy();
  expect(screen.getByText('Stop sharing')).toBeTruthy();
});

it('shows regular files next to folders so the selected publish root can be checked', async () => {
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async (_sessionId: string, path: string) =>
      path === 'site'
        ? { directories: [], files: ['index.html', 'zoom-v2.html'] }
        : { directories: ['site'], files: [] },
    ),
    listPublicPreviewShares: jest.fn(async () => []),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );
  fireEvent.press(await screen.findByLabelText('Open folder site'));
  expect(await screen.findByLabelText('File index.html')).toBeTruthy();
  expect(screen.getByLabelText('File zoom-v2.html')).toBeTruthy();
  expect(screen.getByText('Worktree / site')).toBeTruthy();
});

it('opens directly on the active link when the sheet is reopened', async () => {
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
    listPublicPreviewShares: jest.fn(async () => [
      {
        id: 'share-existing',
        sessionId: 'session-one',
        targetKind: 'static-folder',
        staticPath: 'docs/presentations/site',
        state: 'active',
        publicOrigin: 'https://existing.example',
        expiresAt: '2030-01-01T01:00:00Z',
      },
    ]),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );
  expect(await screen.findByText('https://existing.example')).toBeTruthy();
  expect(screen.getByLabelText('Active preview link')).toBeTruthy();
  expect(screen.queryByLabelText('Preview PIN')).toBeNull();
  expect(screen.queryByText('Create another link')).toBeNull();
});

it('keeps the selected folder and PIN after Core is unreachable during link creation', async () => {
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async () => ['demo']),
    listPublicPreviewShares: jest.fn(async () => []),
    createSessionStaticPreviewShare: jest.fn(async () => {
      throw new Error(
        'Uplink Core request failed: Pinned TLS transport failed [NSURLErrorDomain:-1009:NO_AUTH_CHALLENGE]',
      );
    }),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );

  fireEvent.press(await screen.findByLabelText('Open folder demo'));
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create link' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByText('Create link'));

  expect(await screen.findByText(/connection to Verity Core is unavailable/)).toBeTruthy();
  expect(screen.getByText('Worktree / demo')).toBeTruthy();
  expect(screen.getByLabelText('Preview PIN').props.value).toBe('123456');
  expect(screen.getByText('Create link')).toBeTruthy();
});

it('explains an Uplink internal error and permits retrying the same folder', async () => {
  const createSessionStaticPreviewShare = jest
    .fn()
    .mockRejectedValueOnce(new Error('Uplink refused public preview: internal'))
    .mockResolvedValueOnce({
      id: 'share-two',
      targetKind: 'static-folder',
      sessionId: 'session-one',
      staticPath: 'demo',
      state: 'active',
      publicOrigin: 'https://retry.example',
      expiresAt: '2030-01-01T01:00:00Z',
    });
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) =>
      path ? [] : ['demo'],
    ),
    listPublicPreviewShares: jest.fn(async () => []),
    createSessionStaticPreviewShare,
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );
  // The directory is selected by navigating into it; no second selection step exists.
  fireEvent.press(await screen.findByLabelText('Open folder demo'));
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create link' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByText('Create link'));
  expect(
    await screen.findByText('Uplink could not create this link. Please try again later.'),
  ).toBeTruthy();
  expect(screen.getByLabelText('Back to parent folder')).toBeTruthy();
  fireEvent.press(screen.getByText('Create link'));
  expect(await screen.findByText('https://retry.example')).toBeTruthy();
  expect(createSessionStaticPreviewShare).toHaveBeenCalledTimes(2);
});

it('keeps a newly created link when the initial share list arrives late', async () => {
  let resolveShares!: (shares: PublicPreviewShare[]) => void;
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) =>
      path ? [] : ['demo'],
    ),
    listPublicPreviewShares: jest.fn(
      () =>
        new Promise<PublicPreviewShare[]>((resolve) => {
          resolveShares = resolve;
        }),
    ),
    createSessionStaticPreviewShare: jest.fn(async () => ({
      id: 'share-new',
      targetKind: 'static-folder',
      sessionId: 'session-one',
      staticPath: 'demo',
      state: 'active',
      publicOrigin: 'https://new.example',
      expiresAt: '2030-01-01T01:00:00Z',
    })),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );
  fireEvent.press(await screen.findByLabelText('Open folder demo'));
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create link' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByText('Create link'));
  expect(await screen.findByText('https://new.example')).toBeTruthy();
  await act(async () => resolveShares([]));
  expect(screen.getByText('https://new.example')).toBeTruthy();
});

it('finishes loading a new folder when a link creation completes during navigation', async () => {
  let resolveCreate!: (share: PublicPreviewShare) => void;
  let resolveOther!: (folders: string[]) => void;
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) => {
      if (path === 'other')
        return await new Promise<string[]>((resolve) => {
          resolveOther = resolve;
        });
      return path ? [] : ['demo', 'other'];
    }),
    listPublicPreviewShares: jest.fn(async () => []),
    createSessionStaticPreviewShare: jest.fn(
      () =>
        new Promise<PublicPreviewShare>((resolve) => {
          resolveCreate = resolve;
        }),
    ),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );
  fireEvent.press(await screen.findByLabelText('Open folder demo'));
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create link' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByText('Create link'));
  fireEvent.press(screen.getByLabelText('Back to parent folder'));
  fireEvent.press(await screen.findByLabelText('Open folder other'));
  await act(async () =>
    resolveCreate({
      id: 'share-new',
      projectId: 'project-one',
      sessionId: 'session-one',
      targetKind: 'static-folder',
      staticPath: 'demo',
      state: 'active',
      publicOrigin: 'https://new.example',
      expiresAt: '2030-01-01T01:00:00Z',
    } as PublicPreviewShare),
  );
  await act(async () => resolveOther([]));
  expect(screen.getByText('https://new.example')).toBeTruthy();
  expect(screen.queryByText('Worktree / other')).toBeNull();
});

it('ignores a child-folder response after returning to the session root', async () => {
  let resolveChild!: (directories: string[]) => void;
  let rootLoads = 0;
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) => {
      if (path === 'site') {
        return await new Promise<string[]>((resolve) => {
          resolveChild = resolve;
        });
      }
      rootLoads += 1;
      return rootLoads === 1 ? ['site'] : ['other'];
    }),
    listPublicPreviewShares: jest.fn(async () => []),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );

  fireEvent.press(await screen.findByLabelText('Open folder site'));
  fireEvent.press(screen.getByLabelText('Back to parent folder'));
  expect(await screen.findByLabelText('Open folder other')).toBeTruthy();
  await act(async () => resolveChild(['dist']));
  expect(screen.queryByLabelText('Open folder dist')).toBeNull();
  expect(screen.getByLabelText('Open folder other')).toBeTruthy();
});

it('does not offer folders from the previous location when navigation fails', async () => {
  const client = {
    listSessionStaticPreviewDirectories: jest.fn(async (_sessionId: string, path: string) => {
      if (path === 'site') throw new Error('Folder unavailable');
      return ['site'];
    }),
    listPublicPreviewShares: jest.fn(async () => []),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
    />,
  );

  fireEvent.press(await screen.findByLabelText('Open folder site'));
  expect(await screen.findByText('Folder unavailable')).toBeTruthy();
  expect(screen.queryByLabelText('Open folder site')).toBeNull();
  expect(screen.queryByLabelText('Open folder site/site')).toBeNull();
});
