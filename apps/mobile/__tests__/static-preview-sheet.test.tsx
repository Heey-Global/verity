import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking, Modal, Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type {
  ManagedDevServer,
  PublicPreviewShare,
  SessionDevServer,
  VerityClient,
} from '@verity/mobile';
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

// Step one separates the two kinds of target, because they behave differently:
// a dev server is live, a folder is served as files. The sheet opens on the
// servers while one runs, and the folder tab is the explorer itself.
it('separates running servers and static folders into two tabs', async () => {
  renderSheet(makeClient());
  expect(await screen.findByRole('button', { name: 'Vite on port 5173' })).toBeTruthy();
  expect(screen.getByText('web · node node_modules/.bin/vite --host 0.0.0.0')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Dev server' }).props.accessibilityState.selected).toBe(
    true,
  );
  expect(screen.queryByRole('button', { name: 'Open folder dist' })).toBeNull();
  fireEvent.press(screen.getByRole('tab', { name: 'Static files' }));
  expect(await screen.findByRole('button', { name: 'Open folder dist' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open folder docs' })).toBeTruthy();
  expect(screen.getByLabelText('File index.html')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Vite on port 5173' })).toBeNull();
});

// Each tab says what it is for in plain words. Without that line the static
// tab was a bare file list and users could not tell the two paths apart.
it('explains what each tab previews', async () => {
  renderSheet(makeClient());
  expect(await screen.findByText(/Make a server running in this session/)).toBeTruthy();
  expect(screen.queryByText(/Make a folder of finished files/)).toBeNull();
  fireEvent.press(screen.getByRole('tab', { name: 'Static files' }));
  expect(await screen.findByText(/Make a folder of finished files/)).toBeTruthy();
  expect(screen.queryByText(/Make a server running in this session/)).toBeNull();
});

it('opens on static files when no server runs in the session', async () => {
  renderSheet(makeClient({ listSessionDevServers: jest.fn(async () => []) }), {
    detectedServers: [],
  });
  expect(await screen.findByRole('button', { name: 'Open folder dist' })).toBeTruthy();
  fireEvent.press(screen.getByRole('tab', { name: 'Dev server' }));
  expect(await screen.findByText('No dev server running')).toBeTruthy();
});

// Step two shows both accesses as equals. A public link form that already
// exists must not pre-create anything, and the PIN appears only once the link
// exists, because a PIN on screen reads as a link that is already out there.
it('shows both access cards for a picked server and creates the public link on demand', async () => {
  const createSessionPortPreviewShare = jest.fn(async () => portShare());
  renderSheet(makeClient({ createSessionPortPreviewShare }));

  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  expect(await screen.findByLabelText('On your network')).toBeTruthy();
  expect(screen.getByLabelText('Over the internet')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open in browser' })).toBeTruthy();
  expect(screen.queryByText(/\d{3} \d{3}/)).toBeNull();
  expect(createSessionPortPreviewShare).not.toHaveBeenCalled();

  fireEvent.press(screen.getByRole('radio', { name: '24 hours' }));
  fireEvent.press(screen.getByRole('button', { name: 'Create link with PIN' }));
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
  expect(screen.getByRole('button', { name: 'Open in browser' })).toBeTruthy();
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
  fireEvent.press(screen.getByRole('button', { name: 'Create link with PIN' }));
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
  fireEvent.press(await screen.findByRole('button', { name: 'Open in browser' }));
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
  expect(screen.getByText('On')).toBeTruthy();
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
  fireEvent.press(await screen.findByRole('button', { name: 'Open in browser' }));
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
  expect(await screen.findByText('On network')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Vite on port 5173' }));
  expect(await screen.findByText('http://server:8100/')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Turn off local access' }));
  await waitFor(() => expect(stopLocalPreviewShare).toHaveBeenCalledWith('local-one'));
  await waitFor(() => expect(screen.queryByText('http://server:8100/')).toBeNull());
  expect(screen.getByRole('button', { name: 'Open in browser' })).toBeTruthy();
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
  expect(screen.queryByRole('button', { name: 'Create link with PIN' })).toBeNull();
  expect(screen.queryByRole('radio', { name: '24 hours' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Open Premium settings' }));
  expect(openSettings).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'Open in browser' }));
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
  expect(screen.queryByRole('button', { name: 'Create link with PIN' })).toBeNull();
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
  expect(screen.getByText(/^Live until/)).toBeTruthy();
  // The badge already carries the expiry; a second countdown under the card
  // read as a different deadline. One copy control per credential row, too.
  expect(screen.queryByText(/ left$/)).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Copy preview link' })).toHaveLength(1);

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
  expect(await screen.findByRole('button', { name: 'Create link with PIN' })).toBeTruthy();
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
  expect(await screen.findByText('On network')).toBeTruthy();
  expect(await screen.findByText(/^Online until/)).toBeTruthy();
  // A shared folder is listed on top of the explorer even when it sits deeper,
  // so its link can be found again without walking the tree.
  fireEvent.press(screen.getByRole('tab', { name: 'Static files' }));
  expect(await screen.findByRole('button', { name: 'Shared folder dist' })).toBeTruthy();
  expect(screen.getByText(/^Online until/)).toBeTruthy();
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
  fireEvent.press(await screen.findByRole('tab', { name: 'Static files' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Shared folder docs' }));
  expect(await screen.findByText('https://docs.example')).toBeTruthy();
  expect(screen.queryByText('https://dist.example')).toBeNull();
});

it('creates a static share for the whole worktree from the explorer root', async () => {
  const createSessionStaticPreviewShare = jest.fn(
    async (_sessionId: string, body: { pin: string; staticPath: string }) =>
      folderShare({ id: 'root-share', staticPath: body.staticPath, pin: body.pin }),
  );
  renderSheet(makeClient({ createSessionStaticPreviewShare }));
  fireEvent.press(await screen.findByRole('tab', { name: 'Static files' }));
  const whole = await screen.findByRole('button', { name: 'Preview the whole worktree' });
  await waitFor(() => expect(whole.props.accessibilityState.disabled).toBe(false));
  fireEvent.press(whole);
  expect(await screen.findByText('Whole worktree')).toBeTruthy();
  expect(screen.getByText('Worktree root')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create link with PIN' }));
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
  fireEvent.press(await screen.findByRole('tab', { name: 'Static files' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Open folder docs' }));
  expect(await screen.findByLabelText('File README.md')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Open folder docs/slides' }));
  expect(await screen.findByLabelText('File index.html')).toBeTruthy();
  const use = screen.getByRole('button', { name: 'Preview folder docs/slides' });
  await waitFor(() => expect(use.props.accessibilityState.disabled).toBe(false));
  fireEvent.press(use);
  expect(await screen.findByText('slides')).toBeTruthy();
  expect(screen.getByText('Worktree / docs/slides')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create link with PIN' }));
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
  fireEvent.press(await screen.findByRole('tab', { name: 'Static files' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Open folder docs' }));
  expect(await screen.findByText('Folder vanished')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open folder docs' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Preview folder docs' }).props.accessibilityState.disabled,
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
  expect(await screen.findByText('OTHER SERVERS IN THIS PROJECT')).toBeTruthy();
  expect(screen.getByText('Started outside this session.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Storybook on port 8080' })).toBeTruthy();
});

it('updates detected servers from the live snapshot without polling', async () => {
  const listSessionDevServers = jest.fn(async () => [vite]);
  const view = renderSheet(makeClient({ listSessionDevServers }), { detectedServers: [] });
  fireEvent.press(await screen.findByRole('tab', { name: 'Dev server' }));
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

// The default tab is decided once the first state is known; a server that
// starts later must not pull the folder root away from the user.
it('keeps the folder root when a server starts after the sheet opened', async () => {
  const view = renderSheet(makeClient(), { detectedServers: [] });
  await screen.findByRole('button', { name: 'Open folder docs' });
  await waitFor(() =>
    expect(
      screen.getByRole('tab', { name: 'Static files' }).props.accessibilityState.selected,
    ).toBe(true),
  );
  view.rerender(
    <StaticPreviewSheet
      client={makeClient()}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
      detectedServers={[vite]}
    />,
  );
  expect(await screen.findByTestId('preview-tab-server-dot')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Preview the whole worktree' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Vite on port 5173' })).toBeNull();
});

it('settles the folder tab without waiting for links when the Uplink is unavailable', async () => {
  const client = makeClient({
    getPreviewCapabilities: jest.fn(async () => ({ publicSharing: 'unavailable' as const })),
    listPublicPreviewShares: jest.fn(() => new Promise<PublicPreviewShare[]>(() => undefined)),
  });
  // No fallback timeout: only the unavailable Uplink may settle the tab here.
  const view = renderSheet(client, { detectedServers: [], settleTimeoutMs: 60_000 });
  await waitFor(() =>
    expect(
      screen.getByRole('tab', { name: 'Static files' }).props.accessibilityState.selected,
    ).toBe(true),
  );
  view.rerender(
    <StaticPreviewSheet
      client={client}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
      detectedServers={[vite]}
    />,
  );
  expect(await screen.findByTestId('preview-tab-server-dot')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Vite on port 5173' })).toBeNull();
});

// A list that never answers must not leave the sheet loading forever.
it('decides the default tab after the timeout when a list hangs', async () => {
  renderSheet(
    makeClient({
      listSessionDevServers: jest.fn(() => new Promise<SessionDevServer[]>(() => undefined)),
    }),
    { settleTimeoutMs: 10 },
  );
  expect(await screen.findByRole('button', { name: 'Open folder dist' })).toBeTruthy();
});

// A server that starts while the user walks the folders marks the server tab
// but must not switch away from the explorer.
it('keeps the folder explorer open when a server starts during browsing', async () => {
  const view = renderSheet(makeClient(), { detectedServers: [] });
  fireEvent.press(await screen.findByRole('button', { name: 'Open folder docs' }));
  await screen.findByRole('button', { name: 'Back to parent folder' });
  view.rerender(
    <StaticPreviewSheet
      client={makeClient()}
      projectId="project-one"
      sessionId="session-one"
      onClose={jest.fn()}
      detectedServers={[vite]}
    />,
  );
  expect(await screen.findByTestId('preview-tab-server-dot')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Back to parent folder' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Vite on port 5173' })).toBeNull();
});

// Without the live snapshot the servers arrive by polling. The sheet waits for
// them instead of showing the folders first and then jumping to the servers.
it('shows no tab content until the polled servers decide the default', async () => {
  let resolve: (servers: SessionDevServer[]) => void = () => undefined;
  renderSheet(
    makeClient({
      listSessionDevServers: jest.fn(
        () =>
          new Promise<SessionDevServer[]>((done) => {
            resolve = done;
          }),
      ),
    }),
    { settleTimeoutMs: 60_000 },
  );
  await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
  expect(screen.queryByRole('button', { name: 'Open folder dist' })).toBeNull();
  await act(async () => {
    resolve([vite]);
  });
  expect(await screen.findByRole('button', { name: 'Vite on port 5173' })).toBeTruthy();
});

// A Core without port detection reports null; the sheet then lists folders
// only instead of an empty server section.
it('lists folders only when Core has no port detection', async () => {
  renderSheet(makeClient({ listSessionDevServers: jest.fn(async () => null) }));
  expect(await screen.findByRole('button', { name: 'Open folder dist' })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('tab')).toBeNull());
});

it('explains an Uplink internal error and allows retrying', async () => {
  const createSessionPortPreviewShare = jest
    .fn()
    .mockRejectedValueOnce(new Error('Uplink refused public preview: internal'))
    .mockResolvedValueOnce(portShare());
  renderSheet(makeClient({ createSessionPortPreviewShare }));
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Create link with PIN' }));
  expect(
    await screen.findByText('Uplink could not create this link. Please try again later.'),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Create link with PIN' }));
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
  fireEvent.press(await screen.findByRole('button', { name: 'Create link with PIN' }));
  expect(await screen.findByText('Creating link…')).toBeTruthy();
  expect(screen.getByText(/takes a few seconds/)).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Open in browser' }).props.accessibilityState.disabled,
  ).toBe(true);
  await act(async () => {
    resolve(portShare());
  });
  expect(await screen.findByText('https://vite.example')).toBeTruthy();
});

// Android back reaches the sheet through Modal.onRequestClose. It walks back
// one step at a time rather than closing from the access step.
it('steps back from the access step and out of nested folders on Android back', async () => {
  const onClose = jest.fn();
  renderSheet(makeClient(), { onClose });
  fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
  expect(await screen.findByLabelText('On your network')).toBeTruthy();
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(await screen.findByRole('button', { name: 'Vite on port 5173' })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('tab', { name: 'Static files' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Open folder docs' }));
  expect(await screen.findByRole('button', { name: 'Back to parent folder' })).toBeTruthy();
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(await screen.findByRole('button', { name: 'Preview the whole worktree' })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
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
  fireEvent.press(await screen.findByRole('button', { name: 'Create link with PIN' }));
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
  fireEvent.press(await screen.findByRole('button', { name: 'Turn off local access' }));
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
  fireEvent.press(screen.getByRole('button', { name: 'Open in browser' }));
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
  await screen.findByText('On network');
  fireEvent.press(screen.getByRole('button', { name: 'Vite on port 5173' }));
  fireEvent.press(screen.getByRole('button', { name: 'Open in browser' }));
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
  fireEvent.press(screen.getByRole('button', { name: 'Open in browser' }));
  await waitFor(() => expect(openLocalPreview).toHaveBeenCalled());
  await act(async () => jest.mocked(openLocalPreview).mock.calls[0]![2]());
  expect(share).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      'This PIN is locked. Stop sharing and create a new link before sharing it again.',
    ),
  ).toBeTruthy();
});

it('checks the updated PIN lock when a delayed network-dialog action is selected', async () => {
  jest.useFakeTimers();
  try {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    const listPublicPreviewShares = jest
      .fn()
      .mockResolvedValueOnce([portShare()])
      .mockResolvedValue([portShare({ pinLocked: true })]);
    renderSheet(
      makeClient({
        listSessionLocalPreviewShares: jest.fn(async () => [localShare]),
        listPublicPreviewShares,
      }),
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Vite on port 5173' }));
    await screen.findByText('https://vite.example');
    fireEvent.press(screen.getByRole('button', { name: 'Open in browser' }));
    await waitFor(() => expect(openLocalPreview).toHaveBeenCalled());
    const fallback = jest.mocked(openLocalPreview).mock.calls[0]![2];
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Share link and PIN' })).toBeNull(),
    );
    await act(async () => fallback());
    expect(share).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'This PIN is locked. Stop sharing and create a new link before sharing it again.',
      ),
    ).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

it('directs a second folder to its existing public link and blocks fallback creation', async () => {
  const createSessionStaticPreviewShare = jest.fn();
  renderSheet(
    makeClient({
      listPublicPreviewShares: jest.fn(async () => [folderShare()]),
      createSessionStaticPreviewShare,
      createSessionLocalPreviewShare: jest.fn(async () => ({
        ...localShare,
        targetPort: null,
        staticPath: 'docs',
      })),
    }),
  );
  fireEvent.press(await screen.findByRole('tab', { name: 'Static files' }));
  await screen.findByRole('button', { name: 'Shared folder dist' });
  fireEvent.press(await screen.findByRole('button', { name: 'Open folder docs' }));
  const docs = await screen.findByRole('button', { name: 'Preview folder docs' });
  await waitFor(() => expect(docs.props.accessibilityState.disabled).toBe(false));
  fireEvent.press(docs);
  expect(await screen.findByRole('button', { name: 'Manage existing folder link' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create link with PIN' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Open in browser' }));
  await waitFor(() => expect(openLocalPreview).toHaveBeenCalled());
  await act(async () => jest.mocked(openLocalPreview).mock.calls[0]![2]());
  expect(createSessionStaticPreviewShare).not.toHaveBeenCalled();
  expect(
    screen.getByText('Stop the existing public folder link before sharing another folder.'),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Manage existing folder link' }));
  expect(await screen.findByText('https://dist.example')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeTruthy();
});

describe('managed dev servers', () => {
  const demo = (overrides: Partial<ManagedDevServer> = {}): ManagedDevServer => ({
    id: 'srv-1',
    name: 'Curtis Demo',
    command: 'node server.mjs --port {port}',
    workdir: 'curtis-voice',
    approved: true,
    accessSwitches: true,
    instance: {
      id: 'inst-1',
      localShareId: 'local-share-1',
      sessionId: 'session-one',
      state: 'running',
      desired: 'running',
      detail: null,
      url: 'http://verity.local:8104/',
      sandboxPort: 41000,
      awaitingApproval: false,
      localOn: true,
      restartToApply: false,
      startedAt: null,
    },
    elsewhere: [],
    ...overrides,
  });
  const link = (overrides: Partial<PublicPreviewShare> = {}): PublicPreviewShare =>
    ({
      id: 'link-1',
      projectId: 'project-one',
      devServerId: null,
      targetKind: 'dev-server',
      targetPort: 41000,
      sessionId: 'session-one',
      managedInstanceId: 'inst-1',
      staticPath: null,
      state: 'active',
      publicOrigin: 'https://ene41q3je23zkvpa.share.verity.build',
      pin: '268080',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
      failure: null,
      ...overrides,
    }) as PublicPreviewShare;
  const managedClient = (servers: ManagedDevServer[], overrides: Partial<VerityClient> = {}) =>
    makeClient({
      listSessionDevServers: jest.fn(async () => [
        { ...vite, port: 41000, name: 'node', managedInstanceId: 'inst-1' },
        { ...vite, port: 3000, name: 'API', pid: 41, workdir: 'api', command: 'node api.js' },
      ]),
      listManagedDevServers: jest.fn(async () => servers),
      managedDevServerLogs: jest.fn(async () => 'Listening\n'),
      ...overrides,
    });
  /** Answers each native dialog in turn with the button of that text. */
  const answer = (...texts: string[]) =>
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const text = texts.shift();
      buttons?.find((button) => button.text === text)?.onPress?.();
    });

  // The sandbox port is internal: the block names the server and its network
  // address, and its listener does not show up again as an unmanaged server.
  it('shows each server with its state and both accesses, apart from unmanaged listeners', async () => {
    renderSheet(managedClient([demo()]));
    expect(await screen.findByText('Curtis Demo')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('verity.local:8104')).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Local for Curtis Demo' }).props.accessibilityState,
    ).toMatchObject({ checked: true });
    expect(
      screen.getByRole('switch', { name: 'Shared online for Curtis Demo' }).props
        .accessibilityState,
    ).toMatchObject({ checked: false });
    expect(screen.queryByText(/41000/)).toBeNull();
    expect(screen.getByText('NOT MANAGED')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'API on port 3000' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'node on port 41000' })).toBeNull();
  });

  // Local publishes the agent's command on the network, so the operator sees
  // exactly what runs and approves only that.
  it('shows the command and approves exactly it before Local turns on', async () => {
    const approveManagedDevServer = jest.fn(async () => []);
    const setManagedDevServerLocal = jest.fn(async () => demo());
    const alert = answer('Allow');
    renderSheet(
      managedClient([demo({ approved: false, instance: null })], {
        approveManagedDevServer,
        setManagedDevServerLocal,
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Local for Curtis Demo' }));
    await waitFor(() =>
      expect(setManagedDevServerLocal).toHaveBeenCalledWith('session-one', 'srv-1', true),
    );
    expect(alert.mock.calls[0]?.[1]).toContain('node server.mjs --port {port}');
    expect(alert.mock.calls[0]?.[1]).toContain('curtis-voice');
    expect(alert.mock.calls[0]?.[1]).toContain('without a PIN');
    expect(approveManagedDevServer).toHaveBeenCalledWith(
      'session-one',
      'srv-1',
      { command: 'node server.mjs --port {port}', workdir: 'curtis-voice' },
      {},
    );
  });

  it('does not turn Local on when the operator cancels the approval', async () => {
    const setManagedDevServerLocal = jest.fn();
    answer('Cancel');
    renderSheet(
      managedClient([demo({ approved: false, instance: null })], { setManagedDevServerLocal }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Local for Curtis Demo' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(setManagedDevServerLocal).not.toHaveBeenCalled();
  });

  // Stopping a dev server is not destructive (design language): no dialog.
  it('turns Local off without asking', async () => {
    const setManagedDevServerLocal = jest.fn(async () => demo());
    const alert = jest.spyOn(Alert, 'alert');
    renderSheet(managedClient([demo()], { setManagedDevServerLocal }));
    fireEvent.press(await screen.findByRole('switch', { name: 'Local for Curtis Demo' }));
    await waitFor(() =>
      expect(setManagedDevServerLocal).toHaveBeenCalledWith('session-one', 'srv-1', false),
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it('opens the local address straight from the block', async () => {
    renderSheet(managedClient([demo()]));
    fireEvent.press(await screen.findByRole('link', { name: 'Open Curtis Demo on your network' }));
    await waitFor(() =>
      expect(openLocalPreview).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'local-share-1', url: 'http://verity.local:8104/' }),
        'available',
        expect.any(Function),
        undefined,
      ),
    );
  });

  it('opens a managed response without localShareId by finding the real local share', async () => {
    const server = demo();
    delete server.instance!.localShareId;
    renderSheet(
      managedClient([server], {
        listSessionLocalPreviewShares: jest.fn(async () => [
          { ...localShare, id: 'another-access', targetPort: server.instance!.sandboxPort },
          { ...localShare, url: server.instance!.url!, targetPort: server.instance!.sandboxPort },
        ]),
      }),
    );
    fireEvent.press(await screen.findByRole('link', { name: 'Open Curtis Demo on your network' }));
    await waitFor(() =>
      expect(openLocalPreview).toHaveBeenCalledWith(
        expect.objectContaining({ id: localShare.id, url: server.instance!.url }),
        'available',
        expect.any(Function),
        undefined,
      ),
    );
  });

  // Shared online asks how long the link lives and creates it for the
  // instance; a running server is not started again.
  it('creates a public link with the chosen lifetime for a running server', async () => {
    const createSessionPortPreviewShare = jest.fn(async () => link());
    const controlManagedDevServer = jest.fn();
    answer('24 hours');
    renderSheet(
      managedClient([demo()], { createSessionPortPreviewShare, controlManagedDevServer }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(createSessionPortPreviewShare).toHaveBeenCalledWith('session-one', {
        targetPort: 41000,
        managedInstanceId: 'inst-1',
        pin: expect.stringMatching(/^\d{6}$/u),
        ttlSeconds: 86_400,
      }),
    );
    expect(controlManagedDevServer).not.toHaveBeenCalled();
  });

  // Shared online alone must not also open the server on the local network.
  it('starts a stopped server for Shared online with Local left off', async () => {
    const stopped = demo({
      instance: {
        ...demo().instance!,
        state: 'stopped',
        desired: 'stopped',
        url: null,
        localOn: false,
      },
    });
    const running = demo({ instance: { ...demo().instance!, url: null, localOn: false } });
    const listManagedDevServers = jest
      .fn()
      .mockResolvedValueOnce([stopped])
      .mockResolvedValue([running]);
    const controlManagedDevServer = jest.fn(async () => running);
    const createSessionPortPreviewShare = jest.fn(async () => link());
    answer('1 hour');
    renderSheet(
      managedClient([stopped], {
        listManagedDevServers,
        controlManagedDevServer,
        createSessionPortPreviewShare,
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() => expect(createSessionPortPreviewShare).toHaveBeenCalled());
    expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'start', {
      local: false,
    });
  });

  it('approves for Shared online without opening the server locally', async () => {
    const approveManagedDevServer = jest.fn(async () => []);
    answer('1 hour', 'Share');
    renderSheet(
      managedClient(
        [
          demo({
            approved: false,
            instance: { ...demo().instance!, url: null, awaitingApproval: true, localOn: false },
          }),
        ],
        {
          approveManagedDevServer,
          createSessionPortPreviewShare: jest.fn(async () => link()),
        },
      ),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(approveManagedDevServer).toHaveBeenCalledWith(
        'session-one',
        'srv-1',
        { command: 'node server.mjs --port {port}', workdir: 'curtis-voice' },
        { local: false },
      ),
    );
  });

  // Started only for the link: a failed link must not leave it running with
  // no access on.
  it('stops a server it started for Shared online when the link fails', async () => {
    const stopped = demo({
      instance: {
        ...demo().instance!,
        state: 'stopped',
        desired: 'stopped',
        url: null,
        localOn: false,
      },
    });
    const running = demo({ instance: { ...demo().instance!, url: null, localOn: false } });
    const controlManagedDevServer = jest.fn(async () => running);
    answer('1 hour');
    renderSheet(
      managedClient([stopped], {
        listManagedDevServers: jest
          .fn()
          .mockResolvedValueOnce([stopped])
          .mockResolvedValue([running]),
        controlManagedDevServer,
        createSessionPortPreviewShare: jest.fn(async () => {
          throw new Error('Uplink refused');
        }),
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'stop', {
        onlyIfUnshared: true,
      }),
    );
  });

  it('starts a changed command before creating the public link', async () => {
    const changed = demo({
      instance: { ...demo().instance!, restartToApply: true, localOn: false, url: null },
    });
    const running = demo({ instance: { ...changed.instance!, restartToApply: false } });
    const controlManagedDevServer = jest.fn(async () => running);
    const createSessionPortPreviewShare = jest.fn(async () => link());
    answer('1 hour');
    renderSheet(
      managedClient([changed], {
        controlManagedDevServer,
        createSessionPortPreviewShare,
        listManagedDevServers: jest
          .fn()
          .mockResolvedValueOnce([changed])
          .mockResolvedValue([running]),
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() => expect(createSessionPortPreviewShare).toHaveBeenCalled());
    expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'start', {
      local: false,
    });
    expect(controlManagedDevServer.mock.invocationCallOrder[0]).toBeLessThan(
      createSessionPortPreviewShare.mock.invocationCallOrder[0]!,
    );
  });

  it('conditionally stops after a failed start response', async () => {
    const server = demo({
      instance: {
        ...demo().instance!,
        state: 'stopped',
        desired: 'stopped',
        url: null,
        localOn: false,
      },
    });
    const controlManagedDevServer = jest
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue(server);
    const createSessionPortPreviewShare = jest.fn();
    answer('1 hour');
    renderSheet(
      managedClient([server], { controlManagedDevServer, createSessionPortPreviewShare }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'stop', {
        onlyIfUnshared: true,
      }),
    );
    expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
  });

  it('allows stopping a link while it is still being created', async () => {
    const stopPublicPreviewShare = jest.fn(async () => {});
    answer('Stop sharing');
    renderSheet(
      managedClient([demo()], {
        listPublicPreviewShares: jest.fn(async () => [
          link({ state: 'creating', publicOrigin: null }),
        ]),
        stopPublicPreviewShare,
      }),
    );
    const toggle = await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' });
    await waitFor(() => expect(toggle.props.accessibilityState.checked).toBe(true));
    expect(toggle.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(toggle);
    await waitFor(() => expect(stopPublicPreviewShare).toHaveBeenCalledWith('link-1'));
  });

  it('disables other server switches while a managed action is pending', async () => {
    let complete!: (server: ManagedDevServer) => void;
    const pending = new Promise<ManagedDevServer>((resolve) => {
      complete = resolve;
    });
    const first = demo();
    const second = demo({ id: 'srv-2', name: 'API' });
    const setManagedDevServerLocal = jest.fn(async () => pending);
    renderSheet(managedClient([first, second], { setManagedDevServerLocal }));
    fireEvent.press(await screen.findByRole('switch', { name: 'Local for Curtis Demo' }));
    const other = screen.getByRole('switch', { name: 'Local for API' });
    expect(other.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(other);
    expect(setManagedDevServerLocal).toHaveBeenCalledTimes(1);
    await act(async () => complete(first));
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Local for API' }).props.accessibilityState.disabled,
      ).toBe(false),
    );
  });

  it('cleans up a running online-only instance when creating its link fails', async () => {
    const server = demo({ instance: { ...demo().instance!, url: null, localOn: false } });
    const controlManagedDevServer = jest.fn(async () => server);
    answer('1 hour');
    renderSheet(
      managedClient([server], {
        controlManagedDevServer,
        createSessionPortPreviewShare: jest.fn(async () => {
          throw new Error('Uplink refused');
        }),
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'stop', {
        onlyIfUnshared: true,
      }),
    );
  });

  it('requires consent to LAN exposure before sharing online on an older Core', async () => {
    const createSessionPortPreviewShare = jest.fn(async () => link());
    const alert = answer('1 hour', 'Cancel');
    renderSheet(
      managedClient([demo({ accessSwitches: undefined })], { createSessionPortPreviewShare }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        'Share online and on your network?',
        expect.stringContaining('without a PIN'),
        expect.any(Array),
        expect.any(Object),
      ),
    );
    expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
  });

  // Stopped elsewhere while the link waits: give up at once instead of polling
  // for over a minute with the server's fate unclear.
  it('gives up on the link when the server stops while it starts', async () => {
    const stopped = demo({
      instance: {
        ...demo().instance!,
        state: 'stopped',
        desired: 'stopped',
        url: null,
        localOn: false,
      },
    });
    const controlManagedDevServer = jest.fn(async () => stopped);
    const createSessionPortPreviewShare = jest.fn(async () => link());
    answer('1 hour');
    renderSheet(
      managedClient([stopped], {
        listManagedDevServers: jest.fn(async () => [stopped]),
        controlManagedDevServer,
        createSessionPortPreviewShare,
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'stop', {
        onlyIfUnshared: true,
      }),
    );
    expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
  });

  // Closed while the server starts: the link and its PIN would reach nobody,
  // and the server started only for it must not keep running.
  it('makes no link after the sheet closes during the start', async () => {
    const stopped = demo({
      instance: {
        ...demo().instance!,
        state: 'stopped',
        desired: 'stopped',
        url: null,
        localOn: false,
      },
    });
    const starting = demo({
      instance: { ...stopped.instance!, state: 'starting', desired: 'running' },
    });
    const controlManagedDevServer = jest.fn(async () => starting);
    const createSessionPortPreviewShare = jest.fn(async () => link());
    answer('1 hour');
    const view = renderSheet(
      managedClient([stopped], {
        listManagedDevServers: jest
          .fn()
          .mockResolvedValueOnce([stopped])
          .mockResolvedValue([starting]),
        controlManagedDevServer,
        createSessionPortPreviewShare,
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'start', {
        local: false,
      }),
    );
    view.unmount();
    await waitFor(
      () =>
        expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'stop', {
          onlyIfUnshared: true,
        }),
      { timeout: 4_000 },
    );
    expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
  });

  it.each([
    ['1 hour', 3600],
    ['24 hours', 86400],
    ['7 days', 604800],
    ['30 days', 2592000],
  ])('offers %s without exceeding the native dialog button limit', async (label, seconds) => {
    const createSessionPortPreviewShare = jest.fn(async () => link());
    const alert = answer(
      ...(seconds > 86400 ? ['More durations', String(label)] : [String(label)]),
    );
    renderSheet(managedClient([demo()], { createSessionPortPreviewShare }));
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      expect(createSessionPortPreviewShare).toHaveBeenCalledWith(
        'session-one',
        expect.objectContaining({ ttlSeconds: seconds }),
      ),
    );
    for (const call of alert.mock.calls)
      expect(call[2]!.length).toBeLessThanOrEqual(Platform.OS === 'ios' ? 4 : 3);
  });

  it('offers Cancel directly in the first iOS lifetime dialog', async () => {
    const previous = Platform.OS;
    Platform.OS = 'ios';
    try {
      const createSessionPortPreviewShare = jest.fn(async () => link());
      const alert = answer('Cancel');
      renderSheet(managedClient([demo()], { createSessionPortPreviewShare }));
      fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
      await waitFor(() => expect(alert).toHaveBeenCalled());
      expect(alert.mock.calls[0]![2]!.some((button) => button.text === 'Cancel')).toBe(true);
      expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
    } finally {
      Platform.OS = previous;
    }
  });

  it.each(['list', 'create'])('cleans up when closed during the %s request', async (phase) => {
    let complete!: (value: any) => void;
    const pending = new Promise<any>((resolve) => {
      complete = resolve;
    });
    const stopped = demo({
      instance: {
        ...demo().instance!,
        state: 'stopped',
        desired: 'stopped',
        url: null,
        localOn: false,
      },
    });
    const running = demo({ instance: { ...demo().instance!, localOn: false, url: null } });
    const listManagedDevServers = jest
      .fn()
      .mockResolvedValueOnce([stopped])
      .mockImplementation(async () => (phase === 'list' ? pending : [running]));
    const createSessionPortPreviewShare = jest.fn(async () =>
      phase === 'create' ? pending : link(),
    );
    const stopPublicPreviewShare = jest.fn(async () => {});
    const controlManagedDevServer = jest.fn(async () => running);
    answer('1 hour');
    const view = renderSheet(
      managedClient([stopped], {
        listManagedDevServers,
        createSessionPortPreviewShare,
        stopPublicPreviewShare,
        controlManagedDevServer,
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() =>
      phase === 'list'
        ? expect(listManagedDevServers).toHaveBeenCalledTimes(2)
        : expect(createSessionPortPreviewShare).toHaveBeenCalled(),
    );
    view.unmount();
    await act(async () => {
      complete(phase === 'list' ? [running] : link());
    });
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'stop', {
        onlyIfUnshared: true,
      }),
    );
    if (phase === 'list') expect(createSessionPortPreviewShare).not.toHaveBeenCalled();
    else expect(stopPublicPreviewShare).toHaveBeenCalledWith('link-1');
  });

  // A link the Uplink has not given an address yet is already on; pressing the
  // switch again must not create a second one.
  it('shows a link without an address yet as being created', async () => {
    renderSheet(
      managedClient([demo()], {
        listPublicPreviewShares: jest.fn(async () => [
          link({ state: 'creating', publicOrigin: null }),
        ]),
      }),
    );
    expect(await screen.findByText('Creating link…')).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Shared online for Curtis Demo' }).props
        .accessibilityState,
    ).toMatchObject({ checked: true });
  });

  // An older Core has no Local route and rejects unknown body fields with 400;
  // its switch started and stopped the server, also before it ever ran.
  it('falls back to start and stop on a Core without the Local switch', async () => {
    const server = demo({ accessSwitches: undefined });
    delete server.instance!.localOn;
    const controlManagedDevServer = jest.fn(async () => server);
    const setManagedDevServerLocal = jest.fn();
    renderSheet(managedClient([server], { controlManagedDevServer, setManagedDevServerLocal }));
    fireEvent.press(await screen.findByRole('switch', { name: 'Local for Curtis Demo' }));
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'stop'),
    );
    expect(setManagedDevServerLocal).not.toHaveBeenCalled();
  });

  it('approves and starts without the Local field on an older Core', async () => {
    const approveManagedDevServer = jest.fn(async () => []);
    const controlManagedDevServer = jest.fn(async () => demo());
    answer('Allow');
    renderSheet(
      managedClient([demo({ accessSwitches: undefined, approved: false, instance: null })], {
        approveManagedDevServer,
        controlManagedDevServer,
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Local for Curtis Demo' }));
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'start'),
    );
    expect(approveManagedDevServer).toHaveBeenCalledWith(
      'session-one',
      'srv-1',
      { command: 'node server.mjs --port {port}', workdir: 'curtis-voice' },
      {},
    );
  });

  it('shows the public link, opens it with the PIN, and copies the PIN', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    renderSheet(
      managedClient([demo()], { listPublicPreviewShares: jest.fn(async () => [link()]) }),
    );
    fireEvent.press(
      await screen.findByRole('link', { name: 'Open the public link of Curtis Demo' }),
    );
    expect(open).toHaveBeenCalledWith('https://ene41q3je23zkvpa.share.verity.build/?pin=268080');
    expect(screen.getByText('ene41q…share.verity.build')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Copy PIN 2 6 8 0 8 0' }));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('268080'));
  });

  // Ending a public link affects visitors, so it asks; the server decides
  // whether the server stops with it.
  it('asks before Shared online turns off and then stops the link', async () => {
    const stopPublicPreviewShare = jest.fn(async () => undefined);
    answer('Stop sharing');
    renderSheet(
      managedClient([demo()], {
        listPublicPreviewShares: jest.fn(async () => [link()]),
        stopPublicPreviewShare,
      }),
    );
    fireEvent.press(await screen.findByRole('switch', { name: 'Shared online for Curtis Demo' }));
    await waitFor(() => expect(stopPublicPreviewShare).toHaveBeenCalledWith('link-1'));
  });

  it('offers Premium instead of the Shared online switch without entitlement', async () => {
    const onOpenSettings = jest.fn();
    renderSheet(
      managedClient([demo()], {
        getPreviewCapabilities: jest.fn(async () => ({
          publicSharing: 'premium-required' as const,
        })),
      }),
      { onOpenSettings },
    );
    fireEvent.press(
      await screen.findByRole('button', {
        name: 'Shared online needs Verity Premium. Open settings',
      }),
    );
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole('switch', { name: 'Shared online for Curtis Demo' })).toBeNull();
  });

  it('marks a server the agent started without approval as not shared yet', async () => {
    renderSheet(
      managedClient([
        demo({
          approved: false,
          instance: { ...demo().instance!, url: null, awaitingApproval: true, localOn: false },
        }),
      ]),
    );
    expect(await screen.findByText('not shared yet')).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Local for Curtis Demo' }).props.accessibilityState,
    ).toMatchObject({ checked: false });
  });

  it('asks the agent to fix a crashed server and shows its last output', async () => {
    const onAskAgent = jest.fn();
    const crashed = demo({
      instance: {
        ...demo().instance!,
        state: 'crashed',
        desired: 'stopped',
        url: null,
        detail: 'The server exited with code 1',
      },
    });
    renderSheet(managedClient([crashed]), { onAskAgent });
    fireEvent.press(
      await screen.findByRole('button', { name: /Curtis Demo, Crashed\. View output/u }),
    );
    expect(await screen.findByText('LAST OUTPUT')).toBeTruthy();
    expect(await screen.findByText('Listening')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Ask the agent to fix it' }));
    expect(onAskAgent).toHaveBeenCalledWith(
      expect.stringContaining('verity-dev-server logs "Curtis Demo"'),
    );
  });

  // Stop from the details ends both accesses; a public link asks first.
  it('keeps overview switches disabled while Stop from details revokes the link', async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const stopPublicPreviewShare = jest.fn(async () => pending);
    const setManagedDevServerLocal = jest.fn();
    answer('Stop sharing');
    renderSheet(
      managedClient([demo()], {
        listPublicPreviewShares: jest.fn(async () => [link()]),
        stopPublicPreviewShare,
        setManagedDevServerLocal,
      }),
    );
    await screen.findByRole('link', { name: 'Open the public link of Curtis Demo' });
    fireEvent.press(screen.getByRole('button', { name: /Curtis Demo, Running\. Details/u }));
    fireEvent.press(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopPublicPreviewShare).toHaveBeenCalled());
    fireEvent.press(screen.getByRole('button', { name: 'Back to preview targets' }));
    const toggle = screen.getByRole('switch', { name: 'Local for Curtis Demo' });
    expect(toggle.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(toggle);
    expect(setManagedDevServerLocal).not.toHaveBeenCalled();
    await act(async () => complete());
  });

  it('stops the public link and the server from the details after confirming', async () => {
    const stopPublicPreviewShare = jest.fn(async () => undefined);
    const controlManagedDevServer = jest.fn(async () => demo());
    answer('Stop sharing');
    renderSheet(
      managedClient([demo()], {
        listPublicPreviewShares: jest.fn(async () => [link()]),
        stopPublicPreviewShare,
        controlManagedDevServer,
      }),
    );
    await screen.findByRole('link', { name: 'Open the public link of Curtis Demo' });
    fireEvent.press(screen.getByRole('button', { name: /Curtis Demo, Running\. Details/u }));
    fireEvent.press(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(controlManagedDevServer).toHaveBeenCalledWith('session-one', 'srv-1', 'stop'),
    );
    expect(stopPublicPreviewShare).toHaveBeenCalledWith('link-1');
  });

  it('asks the agent to save an unmanaged server as an entry', async () => {
    const onAskAgent = jest.fn();
    renderSheet(managedClient([demo()]), { onAskAgent });
    fireEvent.press(await screen.findByRole('button', { name: 'Save API as an entry' }));
    expect(onAskAgent).toHaveBeenCalledWith(expect.stringContaining('verity-dev-server add'));
  });
});
