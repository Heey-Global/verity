import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Modal, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { PublicPreviewShare, VerityClient } from '@verity/mobile';
import { StaticPreviewSheet } from '../components/project/StaticPreviewSheet';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));

const generatedPin = expect.stringMatching(/^\d{6}$/);

// Folder and server rows only pick what to share. Expiry and the link follow
// on their own step, so every create goes through this second button.
async function pickFolder(name = 'Share this folder') {
  await waitFor(() =>
    expect(screen.getByRole('button', { name }).props.accessibilityState.disabled).toBe(false),
  );
  fireEvent.press(screen.getByRole('button', { name }));
  expect(await screen.findByText('LINK EXPIRES AFTER')).toBeTruthy();
}

// A PIN shown before the link exists reads as a link that is already out there.
it('shows no PIN before the link exists and then the one it was created with', async () => {
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({
      directories: [],
      files: ['index.html'],
    })),
    listPublicPreviewShares: jest.fn(async () => []),
    createSessionStaticPreviewShare: jest.fn(
      async (_sessionId: string, body: { pin: string; staticPath: string }) => ({
        id: 'root-share',
        sessionId: 'session-one',
        targetKind: 'static-folder',
        staticPath: body.staticPath,
        state: 'active',
        publicOrigin: 'https://root.example',
        pin: body.pin,
        expiresAt: '2030-01-01T01:00:00Z',
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

  expect(await screen.findByLabelText('File index.html')).toBeTruthy();
  expect(screen.queryByText(/\d{3} \d{3}/)).toBeNull();
  await pickFolder();
  expect(screen.getByText('Share Worktree')).toBeTruthy();
  expect(screen.getByText('Protected by a PIN')).toBeTruthy();
  expect(screen.queryByText(/\d{3} \d{3}/)).toBeNull();
  expect(client.createSessionStaticPreviewShare).not.toHaveBeenCalled();

  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));
  await waitFor(() =>
    expect(client.createSessionStaticPreviewShare).toHaveBeenCalledWith('session-one', {
      staticPath: '.',
      pin: generatedPin,
      ttlSeconds: 3600,
    }),
  );
  const [[, { pin }]] = (client.createSessionStaticPreviewShare as jest.Mock).mock.calls as [
    [string, { pin: string }],
  ];
  expect(await screen.findByText(pin.replace(/(\d{3})(?=\d)/g, '$1 '))).toBeTruthy();
});

it('submits the duration picked on the link step', async () => {
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
  await pickFolder();
  fireEvent.press(screen.getByRole('radio', { name: '30 days' }));
  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));
  await waitFor(() =>
    expect(client.createSessionStaticPreviewShare).toHaveBeenCalledWith('session-one', {
      staticPath: '.',
      pin: generatedPin,
      ttlSeconds: 30 * 24 * 60 * 60,
    }),
  );
});

// A locked share stays live for authenticated visitors, but its PIN no longer admits anyone.
it('explains a locked PIN and lets it be stopped and replaced without sharing the PIN', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.style === 'destructive')?.onPress?.();
  });
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
    listPublicPreviewShares: jest.fn(async () => [
      {
        id: 'locked-share',
        sessionId: 'session-one',
        targetKind: 'static-folder',
        staticPath: 'site',
        state: 'active',
        publicOrigin: 'https://locked.example',
        pin: '482913',
        pinLocked: true,
        expiresAt: '2030-01-01T01:00:00Z',
      },
    ]),
    stopPublicPreviewShare: jest.fn(async () => undefined),
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
    expect(
      await screen.findByText(/PIN access locked after too many failed attempts/),
    ).toBeTruthy();
    expect(screen.getByText('Your preview is live')).toBeTruthy();
    expect(screen.queryByText('482 913')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy PIN' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share link and PIN' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open preview in browser' })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Stop sharing' }));
    expect(await screen.findByText('Link stopped')).toBeTruthy();
    expect(client.stopPublicPreviewShare).toHaveBeenCalledWith('locked-share');
    fireEvent.press(screen.getByRole('button', { name: 'Create a new link' }));
    expect(await screen.findByRole('button', { name: 'Share this folder' })).toBeTruthy();
  } finally {
    alert.mockRestore();
  }
});

it('refreshes PIN lock status while the live link is open', async () => {
  jest.useFakeTimers();
  const share = {
    id: 'share-one',
    sessionId: 'session-one',
    targetKind: 'static-folder',
    staticPath: 'site',
    state: 'active',
    publicOrigin: 'https://live.example',
    pin: '123456',
    expiresAt: '2030-01-01T01:00:00Z',
  };
  const listPublicPreviewShares = jest
    .fn()
    .mockResolvedValueOnce([share])
    .mockResolvedValue([{ ...share, pinLocked: true }]);
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
    listPublicPreviewShares,
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
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Copy PIN' })).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(4_000);
    });
    expect(listPublicPreviewShares).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/PIN access locked after too many failed attempts/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy PIN' })).toBeNull();
  } finally {
    jest.useRealTimers();
  }
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
  await pickFolder('Share folder site/dist');
  expect(screen.getByText('Share dist')).toBeTruthy();
  expect(screen.getByText('Worktree / site/dist')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));

  await waitFor(() =>
    expect(client.createSessionStaticPreviewShare).toHaveBeenCalledWith('session-one', {
      staticPath: 'site/dist',
      pin: generatedPin,
      ttlSeconds: 3600,
    }),
  );
  expect(await screen.findByText('https://preview.example')).toBeTruthy();
  expect(screen.getByText(/left · until/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull();
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
  expect(screen.queryByRole('button', { name: 'Share this folder' })).toBeNull();
  expect(screen.queryByText('Create another link')).toBeNull();
});

it('stays on the link step for the same folder after Core is unreachable', async () => {
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
  await pickFolder('Share folder demo');
  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));

  expect(await screen.findByText(/connection to Verity Core is unavailable/)).toBeTruthy();
  expect(screen.getByText('Share demo')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create link' })).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Back to folder' }));
  expect(await screen.findByText('Worktree / demo')).toBeTruthy();
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
  fireEvent.press(await screen.findByLabelText('Open folder demo'));
  await pickFolder('Share folder demo');
  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));
  expect(
    await screen.findByText('Uplink could not create this link. Please try again later.'),
  ).toBeTruthy();
  expect(screen.getByText('Share demo')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));
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
  await pickFolder('Share folder demo');
  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));
  expect(await screen.findByText('https://new.example')).toBeTruthy();
  await act(async () => resolveShares([]));
  expect(screen.getByText('https://new.example')).toBeTruthy();
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
  await pickFolder();
  fireEvent.press(screen.getByRole('button', { name: 'Create link' }));

  // The Uplink alone spends seconds on a create. A disabled button with no
  // other change reads as a tap that did not register.
  const button = await screen.findByRole('button', { name: 'Creating link' });
  expect(button.props.accessibilityState.busy).toBe(true);
  expect(screen.getByText('Creating link…')).toBeTruthy();
  expect(screen.getByText(/This takes a few seconds/)).toBeTruthy();
  // Leaving mid-create would drop the user back into the explorer while the link
  // still lands a moment later, unannounced.
  expect(
    screen.getByRole('button', { name: 'Back to folder' }).props.accessibilityState.disabled,
  ).toBe(true);

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
    expect(screen.queryByRole('button', { name: 'Share this folder' })).toBeNull();

    await act(async () => resolveStop());

    // And afterwards it confirms, instead of dropping the user into the create
    // form as if nothing had happened.
    expect(screen.getByText('Link stopped')).toBeTruthy();
    expect(screen.getByText(/The link for site no longer works/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share this folder' })).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Create a new link' }));
    expect(await screen.findByRole('button', { name: 'Share this folder' })).toBeTruthy();
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

// The bottom button shares the folder the explorer is in, so it has to say
// which one; a stale name would share a different folder than the one shown.
it('names the folder the explorer is in on the share button', async () => {
  let resolveDocs!: (entries: { directories: string[]; files: string[] }) => void;
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async (_session: string, path: string) =>
      path === 'docs'
        ? await new Promise<{ directories: string[]; files: string[] }>((resolve) => {
            resolveDocs = resolve;
          })
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
  fireEvent.press(await screen.findByLabelText('Open folder docs'));
  expect(screen.getByText('Share “docs”')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Share folder docs' }).props.accessibilityState.disabled,
  ).toBe(true);
  await act(async () => resolveDocs({ directories: [], files: ['guide.md'] }));
  expect(screen.getByLabelText('File guide.md')).toBeTruthy();
  await pickFolder('Share folder docs');
  expect(screen.getByText('Share docs')).toBeTruthy();
});

// Android back reaches the sheet through Modal.onRequestClose. Left on onClose,
// it threw away the whole sheet from the link step instead of going back.
it('goes back from the link step on Android back instead of closing the sheet', async () => {
  const onClose = jest.fn();
  const client = {
    listSessionStaticPreviewEntries: jest.fn(async () => ({ directories: [], files: [] })),
    listPublicPreviewShares: jest.fn(async () => []),
  } as unknown as VerityClient;
  render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={onClose}
    />,
  );
  await pickFolder();
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(await screen.findByRole('button', { name: 'Share this folder' })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(onClose).toHaveBeenCalledTimes(1);
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
  // The sheet always opens on Folder, so every server test starts with a tap.
  const openServers = async () =>
    fireEvent.press(await screen.findByRole('tab', { name: 'Dev server' }));

  it('shares the picked server after the link step and shows its live link', async () => {
    const createSessionPortPreviewShare = jest.fn(async () => portShare());
    renderSheet({
      listSessionDevServers: jest.fn(async () => [vite]),
      createSessionPortPreviewShare,
    });

    await openServers();
    const row = await screen.findByRole('button', { name: 'Share Vite on port 5173' });
    expect(screen.getByText('web · node node_modules/.bin/vite --host 0.0.0.0')).toBeTruthy();
    expect(screen.queryByText('LINK EXPIRES AFTER')).toBeNull();
    fireEvent.press(row);
    expect(await screen.findByText('Share Vite :5173')).toBeTruthy();
    expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() =>
      expect(createSessionPortPreviewShare).toHaveBeenCalledWith('session-one', {
        targetPort: 5173,
        pin: generatedPin,
        ttlSeconds: 3600,
      }),
    );
    expect(await screen.findByText('https://vite.example')).toBeTruthy();
    expect(screen.getByText('Vite :5173')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Back to dev servers' }));
    expect(screen.getByRole('button', { name: 'Show link for port 5173' })).toBeTruthy();
  });

  // With several servers listed, a row tap must share that one and no other.
  it('shares only the server that was picked from several', async () => {
    const createSessionPortPreviewShare = jest.fn(async () =>
      portShare({ targetPort: 3000, publicOrigin: 'https://api.example' }),
    );
    renderSheet({
      listSessionDevServers: jest.fn(async () => [
        vite,
        { ...vite, port: 3000, pid: 41, name: 'API', workdir: 'api' },
      ]),
      createSessionPortPreviewShare,
    });

    await openServers();
    fireEvent.press(await screen.findByRole('button', { name: 'Share API on port 3000' }));
    expect(await screen.findByText('Share API :3000')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(createSessionPortPreviewShare).toHaveBeenCalledTimes(1));
    expect(createSessionPortPreviewShare).toHaveBeenCalledWith(
      'session-one',
      expect.objectContaining({ targetPort: 3000 }),
    );
    expect(await screen.findByText('https://api.example')).toBeTruthy();
  });

  it('explains why a loopback-only server cannot be shared instead of offering a link', async () => {
    renderSheet({
      listSessionDevServers: jest.fn(async () => [{ ...vite, reachable: false }]),
      createSessionPortPreviewShare: jest.fn(),
    });

    await openServers();
    expect(await screen.findByText('Local only')).toBeTruthy();
    expect(screen.getByText(/Restart it with --host 0\.0\.0\.0/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share Vite on port 5173' })).toBeNull();
  });

  // The link stays reachable from the row, but without the hint nothing says
  // why it may not load any more.
  it('keeps the loopback hint on a server whose link is still live', async () => {
    renderSheet({
      listSessionDevServers: jest.fn(async () => [{ ...vite, reachable: false }]),
      listPublicPreviewShares: jest.fn(async () => [portShare()]),
    });

    await openServers();
    expect(await screen.findByRole('button', { name: 'Show link for port 5173' })).toBeTruthy();
    expect(screen.getByText(/Restart it with --host 0\.0\.0\.0/u)).toBeTruthy();
  });

  // Folder is the default and sits first; the sheet must not open on an empty
  // Dev server list just because port detection exists.
  it('opens on the folder tab, left of Dev server, while no server runs', async () => {
    const listSessionDevServers = jest.fn(async () => []);
    renderSheet({ listSessionDevServers });

    await waitFor(() => expect(listSessionDevServers).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Share this folder' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.props.accessibilityState.selected)).toEqual([true, false]);
    expect(screen.getByRole('tab', { name: 'Folder' })).toBe(tabs[0]);
    expect(screen.queryByText('No dev server running')).toBeNull();
    expect(screen.queryByTestId('dev-server-tab-dot')).toBeNull();
  });

  // The sheet opens on the explorer, so an error shown only on the other tab
  // would leave existing links unlisted with nothing saying why.
  it('shows a failed share list on the folder tab it opens on', async () => {
    renderSheet({
      listSessionDevServers: jest.fn(async () => []),
      listPublicPreviewShares: jest.fn(async () => {
        throw new Error('Uplink offline');
      }),
    });

    expect(await screen.findByText('Uplink offline')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Folder' }).props.accessibilityState.selected).toBe(
      true,
    );
  });

  // Detection only marks the tab. Switching to it made the sheet wait on the
  // probe and moved the explorer away from someone already using it.
  it('stays on Folder and marks the Dev server tab when a server runs', async () => {
    renderSheet({ listSessionDevServers: jest.fn(async () => [vite]) });

    expect(await screen.findByTestId('dev-server-tab-dot')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Folder' }).props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.getByRole('tab', { name: 'Dev server' }).props.accessibilityHint).toBe(
      'A dev server is running',
    );
    expect(screen.getByRole('button', { name: 'Share this folder' })).toBeTruthy();
  });

  it('marks the Dev server tab when a server starts while the sheet is open', async () => {
    jest.useFakeTimers();
    try {
      const listSessionDevServers = jest
        .fn<Promise<(typeof vite)[]>, [string]>()
        .mockResolvedValueOnce([])
        .mockResolvedValue([vite]);
      renderSheet({ listSessionDevServers });

      await waitFor(() => expect(listSessionDevServers).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('dev-server-tab-dot')).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(4_000);
      });
      expect(await screen.findByTestId('dev-server-tab-dot')).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Folder' }).props.accessibilityState.selected).toBe(
        true,
      );
    } finally {
      jest.useRealTimers();
    }
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

      await openServers();
      expect(await screen.findByText('No dev server running')).toBeTruthy();
      expect(listSessionDevServers).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(4_000);
      });
      expect(await screen.findByRole('button', { name: 'Share Vite on port 5173' })).toBeTruthy();
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

      expect(await screen.findByRole('button', { name: 'Share this folder' })).toBeTruthy();
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
    expect(await screen.findByRole('button', { name: 'Share Vite on port 5173' })).toBeTruthy();
  });

  it('keeps an active port link accessible when discovery finds no server', async () => {
    renderSheet({
      listSessionDevServers: jest.fn(async () => []),
      listPublicPreviewShares: jest.fn(async () => [portShare()]),
    });

    // A public link nobody can see from Folder is easy to forget running.
    expect(await screen.findByTestId('dev-server-tab-dot')).toBeTruthy();
    await openServers();
    fireEvent.press(await screen.findByRole('button', { name: 'Show link for port 5173' }));
    expect(await screen.findByText('https://vite.example')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeTruthy();
  });
});
