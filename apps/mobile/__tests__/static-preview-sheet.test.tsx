import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Modal, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { PublicPreviewShare, SessionDevServer, VerityClient } from '@verity/mobile';
import { openLocalPreview } from '../components/project/previewAccess';
import { StaticPreviewSheet } from '../components/project/StaticPreviewSheet';

jest.mock('../components/project/previewAccess', () => ({
  openLocalPreview: jest.fn(async () => undefined),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));

const generatedPin = expect.stringMatching(/^\d{6}$/);

const vite: SessionDevServer = {
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
    pin: '123456',
    expiresAt: '2030-01-01T01:00:00Z',
    ...overrides,
  }) as PublicPreviewShare;

const folderShare = (overrides: Partial<PublicPreviewShare> = {}) =>
  ({
    id: 'folder-share',
    sessionId: 'session-one',
    targetKind: 'static-folder',
    devServerId: null,
    targetPort: null,
    staticPath: 'dist',
    state: 'active',
    publicOrigin: 'https://dist.example',
    pin: '654321',
    expiresAt: '2030-01-01T01:00:00Z',
    ...overrides,
  }) as PublicPreviewShare;

const localShare = {
  id: 'local-one',
  url: 'http://server:8100/',
  projectId: 'project-one',
  sessionId: 'session-one',
  targetPort: 5173,
  staticPath: null,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
};

function makeClient(overrides: Partial<VerityClient> = {}) {
  return {
    getPreviewCapabilities: jest.fn(async () => ({ publicSharing: 'available' })),
    listSessionLocalPreviewShares: jest.fn(async () => []),
    listSessionStaticPreviewEntries: jest.fn(async () => ({
      directories: ['dist', 'docs'],
      files: ['index.html'],
    })),
    listPublicPreviewShares: jest.fn(async () => []),
    listSessionDevServers: jest.fn(async () => [vite]),
    ...overrides,
  } as unknown as VerityClient;
}

function renderSheet(
  client: VerityClient,
  props: Partial<Parameters<typeof StaticPreviewSheet>[0]> = {},
) {
  return render(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

// Step one lists both kinds of target together: the question "what" is answered
// before "where", and nothing hides behind a tab.
it('lists running servers and worktree folders together as targets', async () => {
  renderSheet(makeClient());
  expect(await screen.findByRole('button', { name: 'Vite on port 5173' })).toBeTruthy();
  expect(screen.getByText('web · node node_modules/.bin/vite --host 0.0.0.0')).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Worktree root folder' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Folder dist' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Folder docs' })).toBeTruthy();
  expect(screen.queryByRole('tab')).toBeNull();
});

// Step two shows both accesses as equals. A public link form that already
// exists must not pre-create anything, and the PIN appears only once the link
// exists, because a PIN on screen reads as a link that is already out there.
it('shows both access cards for a picked server and creates the public link on demand', async () => {
  const createSessionPortPreviewShare = jest.fn(async () => portShare());
  renderSheet(makeClient({ createSessionPortPreviewShare }));

  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  expect(await screen.findByLabelText('Open on your network')).toBeTruthy();
  expect(screen.getByLabelText('Share publicly')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  expect(screen.getByText('Protected by a PIN')).toBeTruthy();
  expect(screen.queryByText(/\d{3} \d{3}/)).toBeNull();
  expect(createSessionPortPreviewShare).not.toHaveBeenCalled();

  fireEvent.press(screen.getByRole('radio', { name: '24 hours' }));
  fireEvent.press(screen.getByRole('button', { name: 'Create public link' }));
  await waitFor(() =>
    expect(createSessionPortPreviewShare).toHaveBeenCalledWith('session-one', {
      targetPort: 5173,
      pin: generatedPin,
      ttlSeconds: 86400,
    }),
  );
  expect(await screen.findByText('https://vite.example')).toBeTruthy();
  expect(screen.getByText('123 456')).toBeTruthy();
  // Both cards stay on screen: the local one is unaffected by the public link.
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
});

it('shares only the server that was picked from several', async () => {
  const createSessionPortPreviewShare = jest.fn(async () =>
    portShare({ targetPort: 3000, publicOrigin: 'https://api.example' }),
  );
  renderSheet(
    makeClient({
      listSessionDevServers: jest.fn(async () => [
        vite,
        { ...vite, port: 3000, pid: 41, name: 'API', workdir: 'api' },
      ]),
      createSessionPortPreviewShare,
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'API on port 3000' }));
  expect(await screen.findByText('API :3000')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create public link' }));
  await waitFor(() =>
    expect(createSessionPortPreviewShare).toHaveBeenCalledWith(
      'session-one',
      expect.objectContaining({ targetPort: 3000 }),
    ),
  );
  expect(await screen.findByText('https://api.example')).toBeTruthy();
});

// Opening locally creates the local share once and hands the reachability
// decision to previewAccess, without touching the public path.
it('opens a server on the local network without creating a public link', async () => {
  const createSessionLocalPreviewShare = jest.fn(async () => localShare);
  const createSessionPortPreviewShare = jest.fn();
  const openSettings = jest.fn();
  renderSheet(makeClient({ createSessionLocalPreviewShare, createSessionPortPreviewShare }), {
    onOpenSettings: openSettings,
  });
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Open' }));
  await waitFor(() =>
    expect(createSessionLocalPreviewShare).toHaveBeenCalledWith('session-one', {
      targetPort: 5173,
    }),
  );
  expect(openLocalPreview).toHaveBeenCalledWith(
    localShare,
    'available',
    expect.any(Function),
    openSettings,
  );
  expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
  expect(await screen.findByText('http://server:8100/')).toBeTruthy();
  expect(screen.getByText('Active')).toBeTruthy();
});

// The unreachable dialog's "Share publicly" lands directly on a link with the
// duration shown in the card: the dialog was the deliberate step.
it('creates the public link when the unreachable dialog asks to share instead', async () => {
  const createSessionPortPreviewShare = jest.fn(async () => portShare());
  renderSheet(
    makeClient({
      createSessionLocalPreviewShare: jest.fn(async () => localShare),
      createSessionPortPreviewShare,
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Open' }));
  await waitFor(() => expect(openLocalPreview).toHaveBeenCalled());
  const sharePublicly = (openLocalPreview as jest.Mock).mock.calls[0]?.[2] as () => void;
  act(() => sharePublicly());
  await waitFor(() =>
    expect(createSessionPortPreviewShare).toHaveBeenCalledWith(
      'session-one',
      expect.objectContaining({ targetPort: 5173, ttlSeconds: 3600 }),
    ),
  );
});

it('copies the local link, creating the local share on first use', async () => {
  const createSessionLocalPreviewShare = jest.fn(async () => localShare);
  renderSheet(
    makeClient({
      createSessionLocalPreviewShare,
      listSessionLocalPreviewShares: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([localShare]),
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Copy local link' }));
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('http://server:8100/'));
  expect(createSessionLocalPreviewShare).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('Copied')).toBeTruthy();
  // A second copy reuses the share instead of allocating another port.
  fireEvent.press(screen.getByRole('button', { name: 'Copy local link' }));
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(2));
  expect(createSessionLocalPreviewShare).toHaveBeenCalledTimes(1);
});

it('marks a target with an existing local share and lets it be stopped from its card', async () => {
  const stopLocalPreviewShare = jest.fn(async () => undefined);
  renderSheet(
    makeClient({
      getPreviewCapabilities: jest.fn(async () => ({ publicSharing: 'premium-required' as const })),
      listSessionLocalPreviewShares: jest.fn(async () => [localShare]),
      stopLocalPreviewShare,
    }),
  );
  expect(await screen.findByText('Local open')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Vite on port 5173' }));
  expect(await screen.findByText('http://server:8100/')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Stop local access' }));
  await waitFor(() => expect(stopLocalPreviewShare).toHaveBeenCalledWith('local-one'));
  await waitFor(() => expect(screen.queryByText('http://server:8100/')).toBeNull());
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
});

// Without entitlement the public card stays visible and explains itself. It
// must not render a create button that does nothing, and the local card must
// keep working.
it('shows the public card as Premium without a create button for a free user', async () => {
  const createSessionLocalPreviewShare = jest.fn(async () => localShare);
  const openSettings = jest.fn();
  renderSheet(
    makeClient({
      getPreviewCapabilities: jest.fn(async () => ({ publicSharing: 'premium-required' as const })),
      createSessionLocalPreviewShare,
      createSessionStaticPreviewShare: jest.fn(),
    }),
    { onOpenSettings: openSettings },
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  expect(await screen.findByText('Premium')).toBeTruthy();
  expect(screen.getByText('Public sharing is part of Verity Premium.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create public link' })).toBeNull();
  expect(screen.queryByText('Protected by a PIN')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Open Premium settings' }));
  expect(openSettings).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(createSessionLocalPreviewShare).toHaveBeenCalledTimes(1));
  expect(openLocalPreview).toHaveBeenCalledWith(
    localShare,
    'premium-required',
    expect.any(Function),
    openSettings,
  );
});

it('says the Uplink is temporarily unavailable rather than Premium when it is offline', async () => {
  renderSheet(
    makeClient({
      getPreviewCapabilities: jest.fn(async () => ({ publicSharing: 'unavailable' as const })),
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  expect(await screen.findByText('Temporarily unavailable')).toBeTruthy();
  expect(screen.queryByText('Premium')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create public link' })).toBeNull();
});

// Reopening the sheet on a server with a live link shows link and PIN at once
// and lets the link be shared and stopped; stopping asks first.
it('shows the live public link with its PIN on reopen and stops it after confirming', async () => {
  const stopPublicPreviewShare = jest.fn(async () => undefined);
  renderSheet(
    makeClient({
      listPublicPreviewShares: jest.fn(async () => [portShare()]),
      stopPublicPreviewShare,
    }),
    { initialServer: vite },
  );
  expect(await screen.findByText('https://vite.example')).toBeTruthy();
  expect(screen.getByText('123 456')).toBeTruthy();
  expect(screen.getByText(/^Active until/)).toBeTruthy();

  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
  fireEvent.press(screen.getByRole('button', { name: 'Share link and PIN' }));
  expect(share).toHaveBeenCalledWith({
    message: expect.stringContaining('PIN: 123456'),
  });

  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  fireEvent.press(screen.getByRole('button', { name: 'Stop sharing' }));
  expect(stopPublicPreviewShare).not.toHaveBeenCalled();
  const confirm = alert.mock.calls[0]?.[2]?.find((choice) => choice.text === 'Stop sharing');
  act(() => confirm?.onPress?.());
  await waitFor(() => expect(stopPublicPreviewShare).toHaveBeenCalledWith('port-share'));
  expect(await screen.findByRole('button', { name: 'Create public link' })).toBeTruthy();
  expect(screen.getByText('Link stopped')).toBeTruthy();
  expect(screen.queryByText('https://vite.example')).toBeNull();
});

it('explains a locked PIN and keeps the PIN out of the share action', async () => {
  renderSheet(
    makeClient({
      listPublicPreviewShares: jest.fn(async () => [portShare({ pinLocked: true })]),
    }),
    { initialServer: vite },
  );
  expect(await screen.findByText(/PIN access locked/)).toBeTruthy();
  expect(screen.queryByText('123 456')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Share link and PIN' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy preview link' })).toBeTruthy();
});

// A row badge tells apart "open locally" from "public until" so step one
// already answers which access is active without opening the target.
it('badges rows with their active accesses', async () => {
  renderSheet(
    makeClient({
      listSessionLocalPreviewShares: jest.fn(async () => [localShare]),
      listPublicPreviewShares: jest.fn(async () => [portShare(), folderShare()]),
    }),
  );
  expect(await screen.findByText('Local open')).toBeTruthy();
  await waitFor(() => expect(screen.getAllByText(/^Public until/)).toHaveLength(2));
  // The folder with a public link is listed even though it is not a root folder.
  expect(screen.getByRole('button', { name: 'Folder dist' })).toBeTruthy();
});

// Folder shares are matched by path, not "any folder": two folders can be
// public at once and each card shows its own link.
it('shows the public link of the picked folder only', async () => {
  renderSheet(
    makeClient({
      listPublicPreviewShares: jest.fn(async () => [
        folderShare(),
        folderShare({ id: 'docs-share', staticPath: 'docs', publicOrigin: 'https://docs.example' }),
      ]),
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Folder docs' }));
  expect(await screen.findByText('https://docs.example')).toBeTruthy();
  expect(screen.queryByText('https://dist.example')).toBeNull();
});

it('creates a static share for the worktree root picked from the list', async () => {
  const createSessionStaticPreviewShare = jest.fn(
    async (_sessionId: string, body: { pin: string; staticPath: string }) =>
      folderShare({ id: 'root-share', staticPath: body.staticPath, pin: body.pin }),
  );
  renderSheet(makeClient({ createSessionStaticPreviewShare }));
  fireEvent.press(await screen.findByRole('button', { name: 'Worktree root folder' }));
  expect(await screen.findByText('Worktree')).toBeTruthy();
  expect(screen.getByText('Worktree root')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create public link' }));
  await waitFor(() =>
    expect(createSessionStaticPreviewShare).toHaveBeenCalledWith('session-one', {
      staticPath: '.',
      pin: generatedPin,
      ttlSeconds: 3600,
    }),
  );
  const [[, { pin }]] = (createSessionStaticPreviewShare as jest.Mock).mock.calls as [
    [string, { pin: string }],
  ];
  expect(await screen.findByText(pin.replace(/(\d{3})(?=\d)/g, '$1 '))).toBeTruthy();
});

// Deeper folders are reached through the explorer; files are shown so the
// publish root can be checked before it is used.
it('browses into a nested folder and uses it as the target', async () => {
  const listSessionStaticPreviewEntries = jest.fn(async (_sessionId: string, path: string) =>
    path === ''
      ? { directories: ['docs'], files: [] }
      : path === 'docs'
        ? { directories: ['slides'], files: ['README.md'] }
        : { directories: [], files: ['index.html'] },
  );
  const createSessionStaticPreviewShare = jest.fn(async () =>
    folderShare({ staticPath: 'docs/slides' }),
  );
  renderSheet(makeClient({ listSessionStaticPreviewEntries, createSessionStaticPreviewShare }));
  fireEvent.press(await screen.findByRole('button', { name: 'Browse folders' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Open folder docs' }));
  expect(await screen.findByLabelText('File README.md')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Open folder docs/slides' }));
  expect(await screen.findByLabelText('File index.html')).toBeTruthy();
  const use = screen.getByRole('button', { name: 'Use folder docs/slides' });
  await waitFor(() => expect(use.props.accessibilityState.disabled).toBe(false));
  fireEvent.press(use);
  expect(await screen.findByText('slides')).toBeTruthy();
  expect(screen.getByText('Worktree / docs/slides')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create public link' }));
  await waitFor(() =>
    expect(createSessionStaticPreviewShare).toHaveBeenCalledWith(
      'session-one',
      expect.objectContaining({ staticPath: 'docs/slides' }),
    ),
  );
});

it('does not offer folders from the previous location when navigation fails', async () => {
  const listSessionStaticPreviewEntries = jest.fn(async (_sessionId: string, path: string) => {
    if (path === '') return { directories: ['docs'], files: [] };
    throw new Error('Folder vanished');
  });
  renderSheet(makeClient({ listSessionStaticPreviewEntries }));
  fireEvent.press(await screen.findByRole('button', { name: 'Browse folders' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Open folder docs' }));
  expect(await screen.findByText('Folder vanished')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open folder docs' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Use folder docs' }).props.accessibilityState.disabled,
  ).toBe(true);
});

// Loopback listeners are shareable: the sandbox forwarder bridges them, so the
// row must not be hidden or disabled.
it('lists loopback listeners as targets', async () => {
  renderSheet(
    makeClient({ listSessionDevServers: jest.fn(async () => [{ ...vite, reachable: false }]) }),
  );
  expect(await screen.findByRole('button', { name: 'Vite on port 5173' })).toBeTruthy();
});

it('keeps a live port link reachable when discovery no longer sees its server', async () => {
  renderSheet(
    makeClient({
      listSessionDevServers: jest.fn(async () => []),
      listPublicPreviewShares: jest.fn(async () => [portShare()]),
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Show link for port 5173' }));
  expect(await screen.findByText('https://vite.example')).toBeTruthy();
});

it('separates project listeners from the session’s own', async () => {
  renderSheet(
    makeClient({
      listSessionDevServers: jest.fn(async () => [
        vite,
        { ...vite, port: 8080, pid: 7, name: 'Storybook', scope: 'project' as const },
      ]),
    }),
  );
  expect(await screen.findByText('RUNNING IN THIS PROJECT')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Storybook on port 8080' })).toBeTruthy();
});

it('updates detected servers from the live snapshot without polling', async () => {
  const listSessionDevServers = jest.fn(async () => [vite]);
  const view = renderSheet(makeClient({ listSessionDevServers }), { detectedServers: [] });
  expect(await screen.findByText(/No dev server running/)).toBeTruthy();
  view.rerender(
    <StaticPreviewSheet
      client={makeClient({ listSessionDevServers })}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
      detectedServers={[vite]}
    />,
  );
  expect(await screen.findByRole('button', { name: 'Vite on port 5173' })).toBeTruthy();
  expect(listSessionDevServers).not.toHaveBeenCalled();
});

// A Core without port detection reports null; the sheet then lists folders
// only instead of an empty server section.
it('lists folders only when Core has no port detection', async () => {
  renderSheet(makeClient({ listSessionDevServers: jest.fn(async () => null) }));
  expect(await screen.findByRole('button', { name: 'Worktree root folder' })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('RUNNING IN THIS SESSION')).toBeNull());
});

it('explains an Uplink internal error and allows retrying', async () => {
  const createSessionPortPreviewShare = jest
    .fn()
    .mockRejectedValueOnce(new Error('Uplink refused public preview: internal'))
    .mockResolvedValueOnce(portShare());
  renderSheet(makeClient({ createSessionPortPreviewShare }));
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Create public link' }));
  expect(
    await screen.findByText('Uplink could not create this link. Please try again later.'),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create public link' }));
  expect(await screen.findByText('https://vite.example')).toBeTruthy();
});

it('shows progress while a public link is being created', async () => {
  let resolve: (share: PublicPreviewShare) => void = () => undefined;
  const createSessionPortPreviewShare = jest.fn(
    () =>
      new Promise<PublicPreviewShare>((done) => {
        resolve = done;
      }),
  );
  renderSheet(makeClient({ createSessionPortPreviewShare }));
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Create public link' }));
  expect(await screen.findByText('Creating link…')).toBeTruthy();
  expect(screen.getByText(/takes a few seconds/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open' }).props.accessibilityState.disabled).toBe(true);
  await act(async () => {
    resolve(portShare());
  });
  expect(await screen.findByText('https://vite.example')).toBeTruthy();
});

// Android back reaches the sheet through Modal.onRequestClose. It walks back
// one step at a time rather than closing from the access step.
it('steps back from the access step and the browser on Android back', async () => {
  const onClose = jest.fn();
  renderSheet(makeClient(), { onClose });
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  expect(await screen.findByLabelText('Open on your network')).toBeTruthy();
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(await screen.findByRole('button', { name: 'Browse folders' })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Browse folders' }));
  expect(await screen.findByLabelText('Preview folder explorer')).toBeTruthy();
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(await screen.findByRole('button', { name: 'Browse folders' })).toBeTruthy();
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('keeps a newly created link when the share list arrives late without it', async () => {
  let resolveList: (shares: PublicPreviewShare[]) => void = () => undefined;
  const listPublicPreviewShares = jest.fn(
    () =>
      new Promise<PublicPreviewShare[]>((done) => {
        resolveList = done;
      }),
  );
  renderSheet(
    makeClient({
      listPublicPreviewShares,
      createSessionPortPreviewShare: jest.fn(async () => portShare()),
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Create public link' }));
  expect(await screen.findByText('https://vite.example')).toBeTruthy();
  await act(async () => {
    resolveList([]);
  });
  expect(screen.getByText('https://vite.example')).toBeTruthy();
});

it('keeps a local port access stoppable after its listener disappears', async () => {
  const stopLocalPreviewShare = jest.fn(async () => undefined);
  renderSheet(
    makeClient({
      listSessionDevServers: jest.fn(async () => []),
      listSessionLocalPreviewShares: jest.fn(async () => [localShare]),
      stopLocalPreviewShare,
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Show link for port 5173' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Stop local access' }));
  await waitFor(() => expect(stopLocalPreviewShare).toHaveBeenCalledWith(localShare.id));
});

it('reuses the public link when local access is unreachable and both accesses exist', async () => {
  const createSessionPortPreviewShare = jest.fn();
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
  renderSheet(
    makeClient({
      listSessionLocalPreviewShares: jest.fn(async () => [localShare]),
      listPublicPreviewShares: jest.fn(async () => [portShare()]),
      createSessionPortPreviewShare,
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  await screen.findByText('https://vite.example');
  fireEvent.press(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(openLocalPreview).toHaveBeenCalled());
  const fallback = jest.mocked(openLocalPreview).mock.calls[0]![2];
  await act(async () => fallback());
  expect(share).toHaveBeenCalledWith({ message: expect.stringContaining('https://vite.example') });
  expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
});

it('replaces a cached local access revoked by Core before opening', async () => {
  const replacement = { ...localShare, id: 'local-new', url: 'http://server:8101/' };
  const createSessionLocalPreviewShare = jest.fn(async () => replacement);
  renderSheet(
    makeClient({
      listSessionLocalPreviewShares: jest
        .fn()
        .mockResolvedValueOnce([localShare])
        .mockResolvedValue([]),
      createSessionLocalPreviewShare,
    }),
  );
  await screen.findByText('Local open');
  fireEvent.press(screen.getByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() =>
    expect(openLocalPreview).toHaveBeenCalledWith(
      replacement,
      'available',
      expect.any(Function),
      undefined,
    ),
  );
});

it('does not share a locked PIN from the unreachable-local fallback', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
  renderSheet(
    makeClient({
      listSessionLocalPreviewShares: jest.fn(async () => [localShare]),
      listPublicPreviewShares: jest.fn(async () => [portShare({ pinLocked: true })]),
    }),
  );
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  await screen.findByText('https://vite.example');
  fireEvent.press(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(openLocalPreview).toHaveBeenCalled());
  await act(async () => jest.mocked(openLocalPreview).mock.calls[0]![2]());
  expect(share).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      'This PIN is locked. Stop sharing and create a new link before sharing it again.',
    ),
  ).toBeTruthy();
});
