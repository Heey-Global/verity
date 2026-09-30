import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { PublicPreviewShare, VerityClient } from '@verity/mobile';
import { StaticPreviewSheet } from '../components/project/StaticPreviewSheet';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));

it('generates a PIN that can be replaced before the link is created', async () => {
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
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

  const input = await screen.findByLabelText('Preview PIN');
  expect(input.props.value).toMatch(/^\d{12}$/);
  fireEvent.changeText(input, '987654');
  expect(screen.getByLabelText('Preview PIN').props.value).toBe('987654');
  fireEvent.press(screen.getByRole('button', { name: 'Generate a new PIN' }));
  expect(screen.getByLabelText('Preview PIN').props.value).toMatch(/^\d{12}$/);
});

it('requires a longer PIN for a 30-day share and submits that duration', async () => {
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({
      directories: [],
      files: ['index.html'],
    })),
    listPublicPreviewShares: jest.fn(async () => []),
    createSessionStaticPreviewShare: jest.fn(async () => ({
      id: 'share-long',
      sessionId: 'session-one',
      targetKind: 'static-folder',
      staticPath: '.',
      state: 'active',
      publicOrigin: 'https://long.example',
      pin: '123456789012',
      expiresAt: '2030-01-31T00:00:00Z',
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
  expect(await screen.findByLabelText('File index.html')).toBeTruthy();
  fireEvent.press(screen.getByRole('radio', { name: '30 days' }));
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456');
  expect(
    screen.getByRole('button', { name: 'Create link' }).props.accessibilityState.disabled,
  ).toBe(true);
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456789012');
  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));
  await waitFor(() =>
    expect(client.createSessionStaticPreviewShare).toHaveBeenCalledWith('session-one', {
      staticPath: '.',
      pin: '123456789012',
      ttlSeconds: 30 * 24 * 60 * 60,
    }),
  );
});

it('shows and copies the saved PIN on a reopened link and shares it with the URL', async () => {
  const shareAction = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
    listPublicPreviewShares: jest.fn(async () => [
      {
        id: 'share-existing',
        sessionId: 'session-one',
        targetKind: 'static-folder',
        staticPath: 'site',
        state: 'active',
        publicOrigin: 'https://existing.example',
        pin: '482913',
        expiresAt: '2030-01-01T01:00:00Z',
      },
    ]),
  } as unknown as VerityClient;
  try {
    render(
      <StaticPreviewSheet
        client={client}
        projectId="project-one"
        sessionId="session-one"
        onClose={jest.fn()}
      />,
    );

    expect(await screen.findByText('482 913')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Copy PIN' }));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('482913'));
    fireEvent.press(screen.getByRole('button', { name: 'Share link and PIN' }));
    expect(shareAction).toHaveBeenCalledWith({
      message: expect.stringContaining(
        'Preview: https://existing.example\nPIN: 482913\nAvailable ',
      ),
    });
  } finally {
    shareAction.mockRestore();
  }
});

it('creates a share for index.html in the worktree root', async () => {
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({
      directories: [],
      files: ['index.html'],
    })),
    listPublicPreviewShares: jest.fn(async () => []),
    createSessionStaticPreviewShare: jest.fn(async () => ({
      id: 'root-share',
      sessionId: 'session-one',
      targetKind: 'static-folder',
      staticPath: '.',
      state: 'active',
      publicOrigin: 'https://root.example',
      pin: '123456',
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
  expect(await screen.findByLabelText('File index.html')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Preview PIN'), '123456');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create link' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByText('Create link'));
  await waitFor(() =>
    expect(client.createSessionStaticPreviewShare).toHaveBeenCalledWith('session-one', {
      staticPath: '.',
      pin: '123456',
      ttlSeconds: 3600,
    }),
  );
  expect(await screen.findByText('123 456')).toBeTruthy();
});

it('creates and shows a static share for the folder selected in the session worktree', async () => {
  const share = {
    id: 'share-one',
    projectId: 'project-one',
    sessionId: 'session-one',
    targetKind: 'static-folder' as const,
    staticPath: 'site/dist',
    state: 'active' as const,
    publicOrigin: 'https://preview.example',
    pin: '123456',
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
  expect(screen.getByText(/left · until/)).toBeTruthy();
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
        pin: '123456',
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
      pin: '123456',
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
      pin: '123456',
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
      pin: '123456',
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

it('shows progress while a link is being created instead of only dimming the button', async () => {
  let resolveCreate!: (share: PublicPreviewShare) => void;
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
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
  fireEvent.changeText(await screen.findByLabelText('Preview PIN'), '123456');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create link' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
  fireEvent.press(screen.getByText('Create link'));

  // The Uplink alone spends seconds on a create. A disabled button with no
  // other change reads as a tap that did not register.
  const button = await screen.findByRole('button', { name: 'Creating link' });
  expect(button.props.accessibilityState.busy).toBe(true);
  expect(screen.getByText('Creating link…')).toBeTruthy();
  expect(screen.getByText(/This takes a few seconds/)).toBeTruthy();

  await act(async () =>
    resolveCreate({
      id: 'share-new',
      sessionId: 'session-one',
      targetKind: 'static-folder',
      staticPath: '.',
      state: 'active',
      publicOrigin: 'https://new.example',
      pin: '123456',
      expiresAt: '2030-01-01T01:00:00Z',
    } as unknown as PublicPreviewShare),
  );
  expect(screen.getByText('Your preview is live')).toBeTruthy();
});

it('shows the stop in progress and confirms it before offering a new link', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.style === 'destructive')?.onPress?.();
  });
  let resolveStop!: () => void;
  const onClose = jest.fn();
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
    listPublicPreviewShares: jest.fn(async () => [
      {
        id: 'share-existing',
        sessionId: 'session-one',
        targetKind: 'static-folder',
        staticPath: 'site',
        state: 'active',
        publicOrigin: 'https://existing.example',
        pin: '123456',
        expiresAt: '2030-01-01T01:00:00Z',
      },
    ]),
    stopPublicPreviewShare: jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    ),
  } as unknown as VerityClient;
  try {
    render(
      <StaticPreviewSheet
        client={client}
        projectId="project-one"
        sessionId="session-one"
        onClose={onClose}
      />,
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Stop sharing' }));

    // While the Uplink removes the edge the sheet must say so, not sit still.
    expect(await screen.findByText('Stopping link…')).toBeTruthy();
    expect(screen.getByText('Stopping your preview')).toBeTruthy();
    expect(screen.queryByText('Your preview is live')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop sharing' }).props.accessibilityState.busy).toBe(
      true,
    );
    expect(screen.queryByLabelText('Preview PIN')).toBeNull();

    await act(async () => resolveStop());

    // And afterwards it confirms, instead of dropping the user into the create
    // form as if nothing had happened.
    expect(screen.getByText('Link stopped')).toBeTruthy();
    expect(screen.getByText(/The link for site no longer works/)).toBeTruthy();
    expect(screen.queryByLabelText('Preview PIN')).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Create a new link' }));
    expect(await screen.findByLabelText('Preview PIN')).toBeTruthy();
  } finally {
    alert.mockRestore();
  }
});

it('keeps the link and explains when stopping fails', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.style === 'destructive')?.onPress?.();
  });
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
    listPublicPreviewShares: jest.fn(async () => [
      {
        id: 'share-existing',
        sessionId: 'session-one',
        targetKind: 'static-folder',
        staticPath: '.',
        state: 'active',
        publicOrigin: 'https://existing.example',
        pin: '123456',
        expiresAt: '2030-01-01T01:00:00Z',
      },
    ]),
    stopPublicPreviewShare: jest.fn(async () => {
      throw new Error('Uplink offline');
    }),
  } as unknown as VerityClient;
  try {
    render(
      <StaticPreviewSheet
        client={client}
        projectId="project-one"
        sessionId="session-one"
        onClose={jest.fn()}
      />,
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Stop sharing' }));
    expect(await screen.findByText('Uplink offline')).toBeTruthy();
    expect(screen.getByText('https://existing.example')).toBeTruthy();
    expect(screen.getByText('Stop sharing')).toBeTruthy();
    expect(screen.queryByText('Link stopped')).toBeNull();
  } finally {
    alert.mockRestore();
  }
});

it('counts the remaining time down while the sheet stays open', async () => {
  jest.useFakeTimers({ now: new Date('2030-01-01T00:15:00Z') });
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
    listPublicPreviewShares: jest.fn(async () => [
      {
        id: 'share-existing',
        sessionId: 'session-one',
        targetKind: 'static-folder',
        staticPath: 'site',
        state: 'active',
        publicOrigin: 'https://existing.example',
        pin: '123456',
        expiresAt: '2030-01-01T01:00:00Z',
      },
    ]),
  } as unknown as VerityClient;
  try {
    render(
      <StaticPreviewSheet
        client={client}
        projectId="project-one"
        sessionId="session-one"
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText(/^45 min left/)).toBeTruthy();

    // Rendered once and never again, the label would still promise time the
    // link no longer has.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/^44 min left/)).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

it('says whether the selected folder has a start page', async () => {
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async (_session: string, path: string) =>
      path === 'docs'
        ? { directories: [], files: ['guide.md'] }
        : { directories: ['docs'], files: ['index.html'] },
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
  expect(await screen.findByText('index.html opens as the start page')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Open folder docs'));
  expect(await screen.findByText('No index.html in this folder')).toBeTruthy();
  expect(screen.queryByText('index.html opens as the start page')).toBeNull();
});

describe('dev server tab', () => {
  const vite = {
    port: 5173,
    reachable: true,
    pid: 40,
    name: 'Vite',
    command: 'node node_modules/.bin/vite --host 0.0.0.0',
    workdir: 'web',
  };
  const portShare = (overrides: Partial<PublicPreviewShare> = {}) =>
    ({
      id: 'port-share',
      sessionId: 'session-one',
      targetKind: 'dev-server',
      devServerId: null,
      targetPort: 5173,
      staticPath: null,
      state: 'active',
      publicOrigin: 'https://vite.example',
      pin: '123456789012',
      expiresAt: '2030-01-01T01:00:00Z',
      ...overrides,
    }) as PublicPreviewShare;
  const renderSheet = (client: Partial<VerityClient>) =>
    render(
      <StaticPreviewSheet
        client={
          {
            listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
            listPublicPreviewShares: jest.fn(async () => []),
            ...client,
          } as unknown as VerityClient
        }
        projectId="project-one"
        sessionId="session-one"
        onClose={jest.fn()}
      />,
    );

  it('shares a detected server with the generated PIN and shows its live link', async () => {
    const createSessionPortPreviewShare = jest.fn(async () => portShare());
    renderSheet({
      listSessionDevServers: jest.fn(async () => [vite]),
      createSessionPortPreviewShare,
    });

    expect(await screen.findByLabelText('Vite on port 5173')).toBeTruthy();
    expect(screen.getByText('web · node node_modules/.bin/vite --host 0.0.0.0')).toBeTruthy();
    const pin = screen.getByLabelText('Preview PIN').props.value as string;
    fireEvent.press(screen.getByRole('button', { name: 'Share port 5173' }));

    await waitFor(() =>
      expect(createSessionPortPreviewShare).toHaveBeenCalledWith('session-one', {
        targetPort: 5173,
        pin,
        ttlSeconds: 3600,
      }),
    );
    expect(await screen.findByText('https://vite.example')).toBeTruthy();
    expect(screen.getByText('Vite :5173')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Back to dev servers' }));
    expect(screen.getByRole('button', { name: 'Show link for port 5173' })).toBeTruthy();
  });

  it('explains why a loopback-only server cannot be shared instead of offering a link', async () => {
    renderSheet({
      listSessionDevServers: jest.fn(async () => [{ ...vite, reachable: false }]),
      createSessionPortPreviewShare: jest.fn(),
    });

    expect(await screen.findByText('Local only')).toBeTruthy();
    expect(screen.getByText(/Restart it with --host 0\.0\.0\.0/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share port 5173' })).toBeNull();
  });

  // The agent starts servers while the sheet is open; without the poll the list
  // would stay on "No dev server running" until the sheet is reopened.
  it('picks up a server that starts while the sheet is open', async () => {
    jest.useFakeTimers();
    try {
      const listSessionDevServers = jest
        .fn<Promise<(typeof vite)[]>, [string]>()
        .mockResolvedValueOnce([])
        .mockResolvedValue([vite]);
      renderSheet({ listSessionDevServers });

      expect(await screen.findByText('No dev server running')).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(4_000);
      });
      expect(await screen.findByLabelText('Vite on port 5173')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  // A Core older than port detection has no such route. Without the fallback the
  // sheet would open on an error and keep polling a 404 every few seconds.
  it('falls back to the folder flow when Core has no port detection', async () => {
    jest.useFakeTimers();
    try {
      const listSessionDevServers = jest.fn(async () => null);
      renderSheet({ listSessionDevServers });

      expect(await screen.findByText('FOLDER TO SHARE')).toBeTruthy();
      expect(screen.queryByRole('tab', { name: 'Dev server' })).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(12_000);
      });
      expect(listSessionDevServers).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens on the folder tab when only a folder link is live', async () => {
    renderSheet({
      listSessionDevServers: jest.fn(async () => [vite]),
      listPublicPreviewShares: jest.fn(async () => [
        portShare({
          id: 'folder-share',
          targetKind: 'static-folder',
          targetPort: null,
          staticPath: 'site',
          publicOrigin: 'https://folder.example',
        }),
      ]),
    });

    expect(await screen.findByText('https://folder.example')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Folder' }).props.accessibilityState.selected).toBe(
      true,
    );
    fireEvent.press(screen.getByRole('tab', { name: 'Dev server' }));
    expect(await screen.findByRole('button', { name: 'Share port 5173' })).toBeTruthy();
  });

  it('keeps an active port link accessible when discovery finds no server', async () => {
    renderSheet({
      listSessionDevServers: jest.fn(async () => []),
      listPublicPreviewShares: jest.fn(async () => [portShare()]),
    });

    fireEvent.press(await screen.findByRole('button', { name: 'Show link for port 5173' }));
    expect(await screen.findByText('https://vite.example')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeTruthy();
  });
});
