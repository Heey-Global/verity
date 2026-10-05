import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  type LocalPreviewShare,
  type ManagedDevServer,
  type PublicPreviewShare,
  type SessionDevServer,
  type VerityClient,
} from '@verity/mobile';
import { openLocalPreview } from './previewAccess';
import {
  ManagedServerBlock,
  ManagedServerDetail,
  managedLocalOn,
  managedStatus,
} from './ManagedServers';
import { Icon } from '../Icon';
import { SessionFolderRow } from '../SessionFolderRow';
import { generatePreviewPin, PUBLIC_PREVIEW_DURATIONS } from './publicPreviewShare';

// The sheet asks two questions, one per step. Step one: what to preview, picked
// on one of two tabs because the two kinds behave differently — a dev server
// running in the session (live, with hot reload) or static files from a folder
// of the worktree (the folder tab is the explorer itself). Step two: how to
// open it — on the server's own network without a PIN, or over the internet
// through the Uplink with a PIN and an expiry. Both accesses sit side by side as
// cards because both can be active at once, and each card owns its own state
// and actions.

/** "until 20:14", or with the day when the link outlives today. */
function expiryLabel(expiresAt: string | Date, now = new Date()): string {
  const expiry = new Date(expiresAt);
  const time = expiry.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (expiry.toDateString() === now.toDateString()) return `until ${time}`;
  return `until ${expiry.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** "482 913": groups of three are easier to read out and type. */
function pinLabel(pin: string): string {
  return pin.replace(/(\d{3})(?=\d)/g, '$1 ');
}

function shareMessage(share: PublicPreviewShare): string {
  return `Preview: ${share.publicOrigin}\nPIN: ${share.pin}\nAvailable ${expiryLabel(share.expiresAt)}`;
}

/** The worktree root is "" in the explorer and "." on the wire. */
function normalizeFolder(path: string | null | undefined): string {
  return !path || path === '.' ? '.' : path;
}

function parentFolder(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

function folderTitle(path: string): string {
  const normalized = normalizeFolder(path);
  return normalized === '.' ? 'Whole worktree' : (normalized.split('/').pop() ?? normalized);
}

/** A share of a port detected in the session, as opposed to a configured dev server. */
function isPortShare(share: PublicPreviewShare): boolean {
  return (
    share.targetKind === 'dev-server' &&
    share.devServerId === null &&
    typeof share.targetPort === 'number'
  );
}

function isLive(share: PublicPreviewShare): boolean {
  return (
    ['creating', 'active', 'revoking'].includes(share.state) &&
    new Date(share.expiresAt).getTime() > Date.now()
  );
}

function localIsLive(share: LocalPreviewShare): boolean {
  return new Date(share.expiresAt).getTime() > Date.now();
}

/** What step two is about: a detected listener or a folder of the worktree. */
export type PreviewTarget =
  { kind: 'folder'; path: string } | { kind: 'port'; server: SessionDevServer };

function targetTitle(target: PreviewTarget): string {
  if (target.kind === 'port') return `${target.server.name} :${String(target.server.port)}`;
  return folderTitle(target.path);
}

function targetDetail(target: PreviewTarget): string {
  if (target.kind === 'port') return serverDetail(target.server);
  const normalized = normalizeFolder(target.path);
  return normalized === '.' ? 'Worktree root' : `Worktree / ${normalized}`;
}

function serverDetail(server: SessionDevServer): string {
  return server.workdir === '.' ? server.command : `${server.workdir} · ${server.command}`;
}

function publicShareMatches(share: PublicPreviewShare, target: PreviewTarget): boolean {
  if (!isLive(share)) return false;
  if (target.kind === 'port')
    return target.server.managedInstanceId
      ? share.managedInstanceId === target.server.managedInstanceId
      : isPortShare(share) && share.targetPort === target.server.port;
  return (
    share.targetKind === 'static-folder' &&
    normalizeFolder(share.staticPath) === normalizeFolder(target.path)
  );
}

function localShareMatches(share: LocalPreviewShare, target: PreviewTarget): boolean {
  if (!localIsLive(share)) return false;
  if (target.kind === 'port') return share.targetPort === target.server.port;
  return (
    share.targetPort === null && normalizeFolder(share.staticPath) === normalizeFolder(target.path)
  );
}

function previewError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : 'Could not create preview link';
  if (/NSURLErrorDomain:-1009:NO_AUTH_CHALLENGE/u.test(message)) {
    return 'The connection to Verity Core is unavailable. Check your phone’s connection and try again.';
  }
  if (/Uplink refused public preview: internal/u.test(message)) {
    return 'Uplink could not create this link. Please try again later.';
  }
  return message;
}

type PublicSharing = 'available' | 'premium-required' | 'unavailable';

type PreviewTab = 'server' | 'folder';

export function StaticPreviewSheet({
  client,
  projectId,
  sessionId,
  onClose,
  detectedServers,
  initialServer,
  onOpenSettings,
  onAskAgent,
  settleTimeoutMs = 1_000,
}: {
  client: VerityClient;
  projectId: string;
  sessionId: string;
  onClose: () => void;
  detectedServers?: SessionDevServer[] | undefined;
  initialServer?: SessionDevServer | undefined;
  onOpenSettings?: (() => void) | undefined;
  /** Sends a request to the session's agent, for "Save as entry" and crashes. */
  onAskAgent?: ((prompt: string) => void) | undefined;
  /** How long the default tab waits for slow lists before deciding. */
  settleTimeoutMs?: number;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [publicSharing, setPublicSharing] = useState<PublicSharing>('unavailable');
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false);
  const [localShares, setLocalShares] = useState<LocalPreviewShare[]>([]);
  const [localSharesLoaded, setLocalSharesLoaded] = useState(false);
  const [publicSharesLoaded, setPublicSharesLoaded] = useState(false);
  // A list that hangs must not keep the sheet loading: after a second the
  // default tab is decided with what has arrived.
  const [settleTimedOut, setSettleTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettleTimedOut(true), settleTimeoutMs);
    return () => clearTimeout(timer);
  }, [settleTimeoutMs]);
  useEffect(() => {
    let active = true;
    void client
      .getPreviewCapabilities()
      .then((value) => {
        if (active) setPublicSharing(value.publicSharing);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setCapabilitiesLoaded(true);
      });
    void client
      .listSessionLocalPreviewShares(sessionId)
      .then((value) => {
        if (active) setLocalShares(value);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLocalSharesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [client, sessionId]);

  // The folder tab is the explorer; `path` is where it stands.
  const [tab, setTab] = useState<PreviewTab | undefined>(initialServer ? 'server' : undefined);
  const [path, setPath] = useState('');
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [folderError, setFolderError] = useState<string>();
  const requestGeneration = useRef(0);

  const [shares, setShares] = useState<PublicPreviewShare[]>([]);
  // Native dialog callbacks can outlive the render that opened them.
  const currentShares = useRef(shares);
  currentShares.current = shares;
  const [duration, setDuration] = useState(3600);
  const [busy, setBusy] = useState<'local' | 'public' | 'stop-local' | 'stop-public'>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<'local-link' | 'public-link' | 'pin'>();
  const [justStopped, setJustStopped] = useState(false);
  // A Core older than port detection has no such route (the client reports
  // null); the sheet then lists folders only instead of polling.
  const [devServersSupported, setDevServersSupported] = useState(
    typeof client.listSessionDevServers === 'function',
  );
  const [devServers, setDevServers] = useState<SessionDevServer[]>([]);
  const [devServersLoading, setDevServersLoading] = useState(devServersSupported);
  const [devServerError, setDevServerError] = useState<string>();
  const [target, setTarget] = useState<PreviewTarget | undefined>(
    initialServer ? { kind: 'port', server: initialServer } : undefined,
  );
  const createdShareIds = useRef(new Set<string>());
  const stoppedShareIds = useRef(new Set<string>());

  // Servers the agent set up and Verity runs. `null`: this Core has none.
  const [managed, setManaged] = useState<ManagedDevServer[] | null | undefined>(
    typeof client.listManagedDevServers === 'function' ? undefined : null,
  );
  const [managedId, setManagedId] = useState<string | undefined>();
  const [managedPending, setManagedPending] = useState<string>();
  const [managedLogs, setManagedLogs] = useState<string>();
  const loadManaged = useCallback(async () => {
    if (typeof client.listManagedDevServers !== 'function') return;
    try {
      setManaged(await client.listManagedDevServers(sessionId));
    } catch {
      /* Keep the last list; the next refresh tries again. */
    }
  }, [client, sessionId]);
  // Starting takes seconds; a short refresh while the sheet is open shows it
  // move from starting to running without the user pulling.
  useEffect(() => {
    void loadManaged();
    const timer = setInterval(() => void loadManaged(), 3_000);
    return () => clearInterval(timer);
  }, [loadManaged, detectedServers]);
  const selectedManaged = managed?.find((server) => server.id === managedId);
  useEffect(() => {
    if (!managedId) return;
    let active = true;
    const load = () =>
      void client
        .managedDevServerLogs(sessionId, managedId)
        .then((logs) => {
          if (active) setManagedLogs(logs);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 3_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, managedId, sessionId]);

  /** The operator sees exactly what will run before it becomes reachable. */
  const confirmCommand = (server: ManagedDevServer, action: string, mode: 'local' | 'online') =>
    new Promise<boolean>((resolve) =>
      Alert.alert(
        mode === 'local' ? `Allow ${server.name} locally?` : `Share ${server.name} online?`,
        `The agent set this server up. It runs:\n\n${server.command}${
          server.workdir !== '.' ? `\n\nin ${server.workdir}` : ''
        }\n\n${
          mode === 'local'
            ? 'Anyone on your network can open it without a PIN while it runs.'
            : 'Anyone with the public link and its PIN can open it while it runs.'
        }`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: action, onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );

  const [managedSwitch, setManagedSwitch] = useState<{ id: string; kind: 'local' | 'online' }>();
  const sheetOpen = useRef(true);
  useEffect(
    () => () => {
      sheetOpen.current = false;
    },
    [],
  );

  const managedAction = async (
    server: ManagedDevServer,
    kind: 'local' | 'online' | 'other',
    work: () => Promise<unknown>,
  ) => {
    setManagedPending(server.id);
    if (kind !== 'other') setManagedSwitch({ id: server.id, kind });
    setError(undefined);
    try {
      await work();
    } catch (caught) {
      setError(previewError(caught));
    } finally {
      setManagedPending(undefined);
      setManagedSwitch(undefined);
      await loadManaged();
    }
  };

  /** Approves the command the operator was shown; false when they cancel. */
  const approveManaged = async (
    server: ManagedDevServer,
    action: string,
    mode: 'local' | 'online',
  ) => {
    if (server.approved) return true;
    if (!(await confirmCommand(server, action, mode))) return false;
    await client.approveManagedDevServer(
      sessionId,
      server.id,
      { command: server.command, workdir: server.workdir },
      // Approved for a public link only: the server must not also open locally.
      mode === 'online' && server.accessSwitches && !managedLocalOn(server) ? { local: false } : {},
    );
    return true;
  };

  /** The live public link of a managed instance, if any. */
  const managedLinkFor = (server: ManagedDevServer) =>
    server.instance
      ? currentShares.current.find(
          (share) => share.managedInstanceId === server.instance?.id && isLive(share),
        )
      : undefined;

  const askLinkLifetime = () =>
    new Promise<number | undefined>((resolve) =>
      Alert.alert(
        'How long should the link work?',
        'Visitors need the link and its PIN.',
        [
          ...PUBLIC_PREVIEW_DURATIONS.map((option) => ({
            text: option.a11y,
            onPress: () => resolve(option.seconds),
          })),
          { text: 'Cancel', style: 'cancel' as const, onPress: () => resolve(undefined) },
        ],
        { cancelable: true, onDismiss: () => resolve(undefined) },
      ),
    );

  /** Waits until the instance answers on its port; a public link needs that. */
  const waitUntilRunning = async (serverId: string) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      // Closed meanwhile: nobody would see the link or its PIN, so none is made.
      if (!sheetOpen.current) throw new Error('The Preview sheet was closed.');
      const servers = await client.listManagedDevServers(sessionId);
      if (servers) setManaged(servers);
      const instance = servers?.find((value) => value.id === serverId)?.instance;
      if (instance?.state === 'running') return instance;
      if (instance?.state === 'crashed')
        throw new Error(instance.detail ?? 'The server crashed while starting.');
      // Stopped elsewhere meanwhile: waiting longer would only delay the cleanup.
      if (!instance || instance.state === 'stopped')
        throw new Error('The server stopped before the link was ready.');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error('The server did not start in time.');
  };

  const toggleLocal = (server: ManagedDevServer, on: boolean) =>
    void managedAction(server, 'local', async () => {
      if (on && !(await approveManaged(server, 'Allow', 'local'))) return;
      // A Core before the access switches has no Local route; its single
      // switch started and stopped the server.
      if (!server.accessSwitches)
        return client.controlManagedDevServer(sessionId, server.id, on ? 'start' : 'stop');
      return client.setManagedDevServerLocal(sessionId, server.id, on);
    });

  const toggleOnline = (server: ManagedDevServer, on: boolean) => {
    if (!on) {
      const link = managedLinkFor(server);
      if (link) stopPublic(link, () => void loadManaged());
      return;
    }
    void managedAction(server, 'online', async () => {
      if (publicSharing !== 'available') return;
      const ttlSeconds = await askLinkLifetime();
      if (ttlSeconds === undefined) return;
      if (!(await approveManaged(server, 'Share', 'online'))) return;
      const running = server.instance?.state === 'running' || server.instance?.state === 'starting';
      if (!running)
        await client.controlManagedDevServer(
          sessionId,
          server.id,
          'start',
          // An older Core ignores Local and opens the server on the network too;
          // its Local switch then shows that honestly.
          server.accessSwitches ? { local: managedLocalOn(server) } : {},
        );
      let share: PublicPreviewShare;
      try {
        const instance = await waitUntilRunning(server.id);
        share = await client.createSessionPortPreviewShare(sessionId, {
          targetPort: instance.sandboxPort,
          managedInstanceId: instance.id,
          pin: generatePreviewPin(),
          ttlSeconds,
        });
      } catch (caught) {
        // Started only for this link: with no access on, nothing may keep running.
        if (!running && !managedLocalOn(server))
          await client.controlManagedDevServer(sessionId, server.id, 'stop').catch(() => undefined);
        throw caught;
      }
      createdShareIds.current.add(share.id);
      setShares((current) => [share, ...current]);
    });
  };

  /** Start and Start again keep the switches; with both off they turn Local on. */
  const startManaged = (server: ManagedDevServer) =>
    void managedAction(server, 'other', async () => {
      if (!(await approveManaged(server, 'Allow and start', 'local'))) return;
      const keepLocalOff = managedLinkFor(server) !== undefined && !managedLocalOn(server);
      return client.controlManagedDevServer(
        sessionId,
        server.id,
        'start',
        server.accessSwitches && !keepLocalOff ? { local: true } : {},
      );
    });

  const restartManaged = (server: ManagedDevServer) =>
    void managedAction(server, 'other', async () => {
      if (!(await approveManaged(server, 'Allow and restart', 'local'))) return;
      return client.controlManagedDevServer(sessionId, server.id, 'restart');
    });

  /** Stop turns both switches off; ending a public link asks first. */
  const stopManaged = (server: ManagedDevServer) => {
    const stop = () =>
      void managedAction(server, 'other', () =>
        client.controlManagedDevServer(sessionId, server.id, 'stop'),
      );
    const link = managedLinkFor(server);
    if (link) stopPublic(link, stop);
    else stop();
  };

  const openManagedPublic = (server: ManagedDevServer) => {
    const link = managedLinkFor(server);
    if (!link?.publicOrigin) return;
    // The PIN in the address signs this device in; the edge swaps it for a
    // session cookie and strips it from the address.
    const url = new URL(link.publicOrigin);
    url.searchParams.set('pin', link.pin);
    void Linking.openURL(url.toString()).catch((caught: unknown) => setError(previewError(caught)));
  };

  const [pinCopiedFor, setPinCopiedFor] = useState<string>();
  const copyManagedPin = (server: ManagedDevServer) => {
    const link = managedLinkFor(server);
    if (!link) return;
    void Clipboard.setStringAsync(link.pin).then(() => {
      setPinCopiedFor(server.id);
      setTimeout(
        () => setPinCopiedFor((current) => (current === server.id ? undefined : current)),
        1_500,
      );
    });
  };

  const openManaged = async (server: ManagedDevServer) => {
    const url = server.instance?.url;
    if (!url || !server.instance) return;
    try {
      const id =
        server.instance.localShareId ??
        (await client.listSessionLocalPreviewShares(sessionId)).find(
          (share) =>
            share.sessionId === sessionId &&
            share.targetPort === server.instance?.sandboxPort &&
            new URL(share.url).origin === new URL(url).origin,
        )?.id;
      if (!id) throw new Error('Network access changed. Refresh and try again.');
      await openLocalPreview(
        { id, url } as LocalPreviewShare,
        publicSharing,
        () => setManagedId(server.id),
        onOpenSettings,
      );
    } catch (caught) {
      setError(previewError(caught));
    }
  };

  const deleteManaged = (server: ManagedDevServer) =>
    Alert.alert(
      `Delete ${server.name}?`,
      'Verity stops it in every session and forgets the entry. The agent can set it up again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            void managedAction(server, 'other', async () => {
              await client.deleteManagedDevServer(sessionId, server.id);
              setManagedId(undefined);
            }),
        },
      ],
    );

  const navigate = (nextPath: string) => {
    // Walking the folders pins the tab: a server starting meanwhile must not
    // pull the explorer away from under the user's finger.
    setTab('folder');
    requestGeneration.current += 1;
    setDirectories([]);
    setFiles([]);
    setLoadedPath(null);
    setLoading(true);
    setFolderError(undefined);
    setPath(nextPath);
  };

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const entries = client.listSessionStaticPreviewEntries
        ? await client.listSessionStaticPreviewEntries(sessionId, path)
        : {
            directories: await client.listSessionStaticPreviewDirectories(sessionId, path),
            files: [],
          };
      if (generation === requestGeneration.current) {
        setDirectories(entries.directories);
        setFiles(entries.files);
        setLoadedPath(path);
        setFolderError(undefined);
      }
    } catch (caught) {
      if (generation === requestGeneration.current) {
        setDirectories([]);
        setFiles([]);
        setLoadedPath(null);
        setFolderError(caught instanceof Error ? caught.message : 'Could not load preview folders');
      }
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [client, path, sessionId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!capabilitiesLoaded || publicSharing === 'premium-required') return;
    let active = true;
    let inFlight = false;
    const loadShares = () => {
      if (inFlight) return;
      inFlight = true;
      void client
        .listPublicPreviewShares(projectId)
        .then((nextShares) => {
          if (!active) return;
          setShares((current) => {
            const own = current
              .filter((share) => createdShareIds.current.has(share.id))
              .map((share) => {
                const latest = nextShares.find(
                  (item) => item.id === share.id && item.sessionId === sessionId,
                );
                return latest ? { ...share, ...latest } : share;
              });
            const remote = nextShares.filter(
              (share) =>
                (share.targetKind === 'static-folder' || isPortShare(share)) &&
                share.sessionId === sessionId &&
                !stoppedShareIds.current.has(share.id) &&
                !createdShareIds.current.has(share.id),
            );
            return [...own, ...remote];
          });
        })
        .catch((caught: unknown) => {
          if (active) setError(previewError(caught));
        })
        .finally(() => {
          inFlight = false;
          if (active) setPublicSharesLoaded(true);
        });
    };
    loadShares();
    const timer = setInterval(loadShares, 4_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [capabilitiesLoaded, client, projectId, publicSharing, sessionId]);

  useEffect(() => {
    if (detectedServers !== undefined) {
      setDevServers(detectedServers);
      setDevServersLoading(false);
      return;
    }
    if (!devServersSupported) return;
    let active = true;
    void client
      .listSessionDevServers(sessionId)
      .then((servers) => {
        if (!active) return;
        if (servers === null) setDevServersSupported(false);
        else setDevServers(servers);
        setDevServersLoading(false);
      })
      .catch((caught) => {
        if (active) {
          setDevServerError(previewError(caught));
          setDevServersLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, detectedServers, devServersSupported, sessionId]);

  const localShareFor = (selection: PreviewTarget) =>
    localShares.find((share) => localShareMatches(share, selection));
  const publicShareFor = (selection: PreviewTarget) =>
    currentShares.current.find((share) => publicShareMatches(share, selection));

  const conflictingFolderShare = (selection: PreviewTarget) =>
    selection.kind === 'folder'
      ? currentShares.current.find(
          (share) =>
            share.targetKind === 'static-folder' &&
            isLive(share) &&
            !publicShareMatches(share, selection),
        )
      : undefined;

  const ensureLocalShare = async (selection: PreviewTarget): Promise<LocalPreviewShare> => {
    const existing = localShareFor(selection);
    if (existing) {
      const latest = await client.listSessionLocalPreviewShares(sessionId);
      setLocalShares(latest);
      const live = latest.find((share) => localShareMatches(share, selection));
      if (live) return live;
    }
    const share = await client.createSessionLocalPreviewShare(
      sessionId,
      selection.kind === 'port'
        ? { targetPort: selection.server.port }
        : { staticPath: normalizeFolder(selection.path) },
    );
    setLocalShares((current) => [
      ...current.filter(
        (value) =>
          value.id !== share.id &&
          !(value.targetPort === share.targetPort && value.staticPath === share.staticPath),
      ),
      share,
    ]);
    return share;
  };

  const createPublic = async (selection: PreviewTarget) => {
    if (busy || publicSharing !== 'available') return;
    if (conflictingFolderShare(selection)) {
      setError('Stop the existing public folder link before sharing another folder.');
      return;
    }
    setBusy('public');
    setError(undefined);
    setJustStopped(false);
    const pin = generatePreviewPin();
    try {
      const share =
        selection.kind === 'port'
          ? await client.createSessionPortPreviewShare(sessionId, {
              targetPort: selection.server.port,
              ...(selection.server.managedInstanceId
                ? { managedInstanceId: selection.server.managedInstanceId }
                : {}),
              pin,
              ttlSeconds: duration,
            })
          : await client.createSessionStaticPreviewShare(sessionId, {
              staticPath: normalizeFolder(selection.path),
              pin,
              ttlSeconds: duration,
            });
      createdShareIds.current.add(share.id);
      setShares((current) => [share, ...current]);
    } catch (caught) {
      setError(previewError(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const openLocal = async (selection: PreviewTarget) => {
    if (busy) return;
    setBusy('local');
    setError(undefined);
    try {
      const share = await ensureLocalShare(selection);
      await openLocalPreview(
        share,
        publicSharing,
        () => {
          const existing = publicShareFor(selection);
          if (existing?.pinLocked) {
            setError(
              'This PIN is locked. Stop sharing and create a new link before sharing it again.',
            );
          } else if (existing) {
            void Share.share({ message: shareMessage(existing) }).catch((caught: unknown) =>
              setError(previewError(caught)),
            );
          } else {
            void createPublic(selection);
          }
        },
        onOpenSettings,
      );
    } catch (caught) {
      setError(previewError(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const copyLocal = async (selection: PreviewTarget) => {
    if (busy) return;
    setBusy('local');
    setError(undefined);
    try {
      const share = await ensureLocalShare(selection);
      await Clipboard.setStringAsync(share.url);
      setCopied('local-link');
    } catch (caught) {
      setError(previewError(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const stopLocal = (share: LocalPreviewShare) => {
    if (busy) return;
    setBusy('stop-local');
    setError(undefined);
    void client
      .stopLocalPreviewShare(share.id)
      .then(() => setLocalShares((current) => current.filter((value) => value.id !== share.id)))
      .catch((caught) => setError(previewError(caught)))
      .finally(() => setBusy(undefined));
  };

  const stopPublic = (share: PublicPreviewShare, after?: () => void) => {
    Alert.alert('Stop public link?', 'The link will stop working immediately.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop sharing',
        style: 'destructive',
        onPress: () => {
          setBusy('stop-public');
          setError(undefined);
          void client
            .stopPublicPreviewShare(share.id)
            .then(() => {
              stoppedShareIds.current.add(share.id);
              createdShareIds.current.delete(share.id);
              setShares((current) => current.filter((item) => item.id !== share.id));
              setJustStopped(true);
              after?.();
            })
            .catch((caught: unknown) =>
              setError(caught instanceof Error ? caught.message : 'Could not stop preview'),
            )
            .finally(() => setBusy(undefined));
        },
      },
    ]);
  };

  const pick = (next: PreviewTarget) => {
    setError(undefined);
    setCopied(undefined);
    setJustStopped(false);
    setTab(next.kind === 'port' ? 'server' : 'folder');
    setTarget(next);
  };

  const leaveTarget = () => {
    setError(undefined);
    setTarget(undefined);
  };

  const chooseTab = (next: PreviewTab) => {
    setError(undefined);
    setTab(next);
  };

  // Re-render while a link is shown so the "Live until" badge stays current and an
  // expired link drops out of the sheet instead of staying on screen.
  const [, setTick] = useState(0);
  const ticking = shares.some(isLive) || localShares.some(localIsLive);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, [ticking]);

  const folderReady = loadedPath === path && !loading && !folderError;
  const sessionServers = devServers.filter(
    (server) => server.scope !== 'project' && !server.managedInstanceId,
  );
  const managedRunning = (managed ?? []).some(
    (server) => server.instance?.state === 'running' || server.instance?.state === 'starting',
  );
  const projectServers = devServers.filter((server) => server.scope === 'project');
  // Discovery can lose a listener while its access still needs to be stopped.
  const orphanPorts = Array.from(
    new Set([
      ...shares
        .filter((share) => isPortShare(share) && isLive(share))
        .map((share) => share.targetPort!),
      ...localShares
        .filter((share) => share.targetPort !== null && localIsLive(share))
        .map((share) => share.targetPort!),
    ]),
  ).filter(
    (port) =>
      !devServers.some((server) => server.port === port) &&
      !(managed ?? []).some((server) => server.instance?.sandboxPort === port),
  );
  const liveFolderPaths = Array.from(
    new Set<string>([
      ...shares
        .filter((share) => share.targetKind === 'static-folder' && isLive(share))
        .map((share) => normalizeFolder(share.staticPath)),
      ...localShares
        .filter((share) => share.targetPort === null && localIsLive(share))
        .map((share) => normalizeFolder(share.staticPath)),
    ]),
  );
  // Until the user picks a tab, the sheet opens where something is: on the
  // servers when one runs or still has an access, otherwise on the folders.
  // A Core without port detection has no server tab at all.
  const hasServerTargets =
    sessionServers.length > 0 ||
    projectServers.length > 0 ||
    orphanPorts.length > 0 ||
    (managed ?? []).length > 0;
  const defaultTab: PreviewTab = hasServerTargets ? 'server' : 'folder';
  const activeTab: PreviewTab = !devServersSupported ? 'folder' : (tab ?? defaultTab);
  // The default is decided once, when servers and accesses are known; a server
  // or link arriving later only marks its tab instead of switching under the
  // user's finger.
  const initialStateKnown =
    settleTimedOut ||
    (!devServersLoading && hasServerTargets) ||
    (managed !== undefined && (managed ?? []).length > 0) ||
    (!devServersLoading &&
      localSharesLoaded &&
      (publicSharesLoaded || (capabilitiesLoaded && publicSharing !== 'available')));
  useEffect(() => {
    // A tab the user picked meanwhile wins over the default.
    if (tab === undefined && initialStateKnown) setTab((current) => current ?? defaultTab);
  }, [defaultTab, initialStateKnown, tab]);

  const onRequestClose = () => {
    if (busy) return;
    if (managedId) setManagedId(undefined);
    else if (target) leaveTarget();
    else if (activeTab === 'folder' && path !== '') navigate(parentFolder(path));
    else onClose();
  };

  const renderBadge = (selection: PreviewTarget) => {
    const local = localShareFor(selection);
    const pub = publicShareFor(selection);
    if (!local && !pub) return null;
    return (
      <View style={styles.badges}>
        {local ? (
          <View style={[styles.badge, styles.badgeLocal]}>
            <Icon name="wifi" size={11} color={theme.colors.tone.done} />
            <Text style={styles.badgeText}>On network</Text>
          </View>
        ) : null}
        {pub ? (
          <View style={[styles.badge, styles.badgePublic]}>
            <Icon name="globe" size={11} color={theme.colors.primary} />
            <Text style={styles.badgeText}>{`Online ${expiryLabel(pub.expiresAt)}`}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  const renderTargetRow = ({
    key,
    selection,
    icon,
    title,
    port,
    detail,
    accessibilityLabel,
    loopback = false,
  }: {
    key: string;
    selection: PreviewTarget;
    icon: 'server' | 'folder';
    title: string;
    port?: string;
    detail?: string;
    accessibilityLabel: string;
    loopback?: boolean;
  }) => (
    <Pressable
      key={key}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
      onPress={() => pick(selection)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.rowIcon}>
        <Icon name={icon} size={18} color={theme.colors.textMuted} />
        {icon === 'server' ? (
          <View style={[styles.serverDot, loopback ? styles.serverDotLoopback : null]} />
        ) : null}
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
          {port ? <Text style={styles.rowPort}>{` :${port}`}</Text> : null}
        </Text>
        {detail ? (
          <Text style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
        {renderBadge(selection)}
      </View>
      <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
    </Pressable>
  );

  const renderServerRow = (server: SessionDevServer) =>
    renderTargetRow({
      key: `${server.scope ?? 'session'}:${String(server.port)}`,
      selection: { kind: 'port', server },
      icon: 'server',
      title: server.name,
      port: String(server.port),
      detail: serverDetail(server),
      accessibilityLabel: `${server.name} on port ${String(server.port)}`,
      loopback: !server.reachable,
    });

  const renderTabs = () => (
    <View style={styles.tabs} accessibilityRole="tablist">
      {(
        [
          ['server', 'Dev server', 'server'],
          ['folder', 'Static files', 'folder'],
        ] as const
      ).map(([value, label, icon]) => {
        const selected = activeTab === value;
        return (
          <Pressable
            key={value}
            onPress={() => chooseTab(value)}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            style={[styles.tab, selected ? styles.tabActive : null]}
          >
            <Icon
              name={icon}
              size={16}
              color={selected ? theme.colors.text : theme.colors.textMuted}
            />
            <Text style={selected ? styles.tabTextActive : styles.tabText}>{label}</Text>
            {value === 'server' && (sessionServers.length > 0 || managedRunning) ? (
              <View style={styles.tabDot} testID="preview-tab-server-dot" />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );

  const renderServerTab = () => (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.list}
      accessibilityLabel="Dev servers"
    >
      <Text style={styles.caption}>
        Make a server running in this session, like a website or an API, available on your network
        or through a public link.
      </Text>
      {devServersLoading && devServers.length === 0 && !managed?.length ? (
        <ActivityIndicator style={styles.loading} color={theme.colors.textMuted} />
      ) : null}
      {managed && managed.length > 0 ? (
        <>
          <View style={styles.sectionHeader}>
            <Text style={styles.label}>YOUR SERVERS</Text>
            <Text style={styles.sectionHint}>Set up by the agent</Text>
          </View>
          {managed.map((server) => {
            const link = managedLinkFor(server);
            return (
              <ManagedServerBlock
                key={server.id}
                server={server}
                publicLink={
                  // A link still being created counts as on, so the switch
                  // cannot start a second one meanwhile.
                  link
                    ? {
                        origin: link.publicOrigin ?? null,
                        pin: link.pin,
                        expiresAt: link.expiresAt,
                        pinLocked: link.pinLocked === true,
                        pending: link.state !== 'active' || !link.publicOrigin,
                      }
                    : undefined
                }
                publicSharing={publicSharing}
                pending={managedSwitch?.id === server.id ? managedSwitch.kind : undefined}
                pinCopied={pinCopiedFor === server.id}
                onLocal={(on) => toggleLocal(server, on)}
                onOnline={(on) => toggleOnline(server, on)}
                onOpenLocal={() => void openManaged(server)}
                onOpenPublic={() => openManagedPublic(server)}
                onSharePublic={() => {
                  if (link)
                    void Share.share({ message: shareMessage(link) }).catch(() => undefined);
                }}
                onCopyPin={() => copyManagedPin(server)}
                onDetails={() => {
                  setError(undefined);
                  setManagedLogs(undefined);
                  setManagedId(server.id);
                }}
                onStopElsewhere={(instanceId) =>
                  void client
                    .stopManagedDevServerInstance(sessionId, instanceId)
                    .then(setManaged)
                    .catch((caught: unknown) => setError(previewError(caught)))
                }
                onOpenSettings={onOpenSettings}
              />
            );
          })}
        </>
      ) : null}
      {!devServersLoading &&
      managed !== undefined &&
      !managed?.length &&
      sessionServers.length === 0 &&
      orphanPorts.length === 0 &&
      !devServerError ? (
        <View style={styles.emptyCard}>
          <Icon name="server" size={22} color={theme.colors.textFaint} />
          <Text style={styles.emptyTitle}>
            {managed === null ? 'No dev server running' : 'No servers yet'}
          </Text>
          <Text style={[styles.caption, styles.centered]}>
            {managed === null
              ? 'Ask the agent to start your app. It appears here as soon as it is reachable.'
              : 'Ask the agent to set up your app as a server. You can then switch it on and off here.'}
          </Text>
        </View>
      ) : null}
      {devServerError ? <Text style={styles.error}>{devServerError}</Text> : null}
      {sessionServers.length > 0 && managed !== null ? (
        <>
          <Text style={[styles.label, styles.sectionLabel]}>NOT MANAGED</Text>
          <Text style={styles.caption}>
            Started outside Verity. Saving one lets you switch it on and off here.
          </Text>
        </>
      ) : null}
      {sessionServers.map((server) => (
        <View key={`unmanaged:${String(server.port)}`} style={styles.unmanaged}>
          {renderServerRow(server)}
          {onAskAgent && managed !== null ? (
            <Pressable
              onPress={() => {
                onAskAgent(
                  `Set up the server that runs \`${server.command}\` in ${server.workdir === '.' ? 'the worktree root' : server.workdir} as a Verity dev server entry with verity-dev-server add, using $PORT or {port} instead of a fixed port. Then stop the old process and start the entry with verity-dev-server start.`,
                );
                onClose();
              }}
              accessibilityRole="button"
              accessibilityLabel={`Save ${server.name} as an entry`}
              style={styles.saveEntry}
            >
              <Icon name="bookmark" size={14} color={theme.colors.primary} />
              <Text style={styles.saveEntryText}>Save as entry</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {orphanPorts.map((targetPort) => {
        const port = String(targetPort);
        const server: SessionDevServer = {
          port: targetPort,
          reachable: true,
          pid: 0,
          name: 'Port',
          command: 'Shared link',
          workdir: '.',
        };
        return renderTargetRow({
          key: `orphan:${port}`,
          selection: { kind: 'port', server },
          icon: 'server',
          title: `Port ${port}`,
          detail: 'Still shared, but no server is listening right now',
          accessibilityLabel: `Show link for port ${port}`,
          loopback: true,
        });
      })}
      {projectServers.length > 0 ? (
        <>
          <Text style={[styles.label, styles.sectionLabel]}>OTHER SERVERS IN THIS PROJECT</Text>
          <Text style={styles.caption}>Started outside this session.</Text>
          {projectServers.map(renderServerRow)}
        </>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );

  const renderFolderTab = () => (
    <>
      <Text style={styles.caption}>
        Make a folder of finished files, like an HTML page or slides, available as a website on your
        network or through a public link.
      </Text>
      <View style={styles.browserHeader}>
        {path ? (
          <Pressable
            onPress={() => navigate(parentFolder(path))}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Back to parent folder"
            style={styles.browserBack}
          >
            <Icon name="chevron-left" size={20} color={theme.colors.primary} />
          </Pressable>
        ) : (
          <Icon name="folder" size={18} color={theme.colors.textMuted} />
        )}
        <View style={styles.rowText}>
          <Text style={styles.browserTitle} numberOfLines={1}>
            {path ? folderTitle(path) : 'Worktree'}
          </Text>
          <Text style={styles.rowDetail} numberOfLines={1}>
            {path ? `Worktree / ${path}` : 'Root of this session’s files'}
          </Text>
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.browserList}
        accessibilityLabel="Preview folder explorer"
      >
        {path === '' && liveFolderPaths.length > 0 ? (
          <View style={styles.list}>
            <Text style={styles.label}>SHARED NOW</Text>
            {liveFolderPaths.map((folder) =>
              renderTargetRow({
                key: `live:${folder}`,
                selection: { kind: 'folder', path: folder === '.' ? '' : folder },
                icon: 'folder',
                title: folder === '.' ? 'Whole worktree' : folderTitle(folder),
                detail: folder === '.' ? 'Worktree root' : `Worktree / ${folder}`,
                accessibilityLabel:
                  folder === '.' ? 'Shared worktree root' : `Shared folder ${folder}`,
              }),
            )}
            <Text style={[styles.label, styles.sectionLabel]}>ALL FOLDERS</Text>
          </View>
        ) : null}
        {loading ? (
          <ActivityIndicator style={styles.loading} color={theme.colors.textMuted} />
        ) : null}
        {!loading &&
          !folderError &&
          directories.map((name) => {
            const child = path ? `${path}/${name}` : name;
            return (
              <SessionFolderRow
                key={child}
                name={name}
                onPress={() => navigate(child)}
                accessibilityLabel={`Open folder ${child}`}
              />
            );
          })}
        {!loading &&
          !folderError &&
          files.map((name) => (
            <View key={`file:${name}`} style={styles.fileRow} accessibilityLabel={`File ${name}`}>
              <Icon
                name={name === 'index.html' ? 'globe' : 'file'}
                size={18}
                color={name === 'index.html' ? theme.colors.primary : theme.colors.textFaint}
              />
              <Text
                style={[styles.fileName, name === 'index.html' ? styles.fileNameEntry : null]}
                numberOfLines={2}
              >
                {name}
              </Text>
            </View>
          ))}
        {!loading && !folderError && directories.length === 0 && files.length === 0 ? (
          <Text style={styles.empty}>Empty folder</Text>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        {folderError ? <Text style={styles.error}>{folderError}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          onPress={() => pick({ kind: 'folder', path })}
          disabled={!folderReady}
          accessibilityRole="button"
          accessibilityLabel={path ? `Preview folder ${path}` : 'Preview the whole worktree'}
          accessibilityState={{ disabled: !folderReady }}
          style={[styles.primaryButton, !folderReady ? styles.primaryButtonDisabled : null]}
        >
          <Text style={styles.primaryText} numberOfLines={1}>
            {path ? `Preview “${folderTitle(path)}”` : 'Preview the whole worktree'}
          </Text>
        </Pressable>
      </View>
    </>
  );

  const renderCardHeading = ({
    icon,
    title,
    description,
    status,
  }: {
    icon: 'wifi' | 'globe';
    title: string;
    description: string;
    status?: ReactNode;
  }) => (
    <View style={styles.cardHeading}>
      <View style={styles.cardIcon}>
        <Icon name={icon} size={18} color={theme.colors.text} />
      </View>
      <View style={styles.rowText}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>{title}</Text>
          {status}
        </View>
        <Text style={styles.caption}>{description}</Text>
      </View>
    </View>
  );

  const renderLocalCard = (selection: PreviewTarget) => {
    const share = localShareFor(selection);
    const working = busy === 'local';
    return (
      <View
        style={[styles.card, share ? styles.cardLocalActive : null]}
        accessibilityLabel="On your network"
      >
        {renderCardHeading({
          icon: 'wifi',
          title: 'On your network',
          description:
            'Straight from your Verity server, at home or over VPN. No PIN and not encrypted: anyone on that network can open it.',
          status: share ? (
            <View style={[styles.badge, styles.badgeLocal]}>
              <View style={[styles.badgeDot, styles.badgeDotLocal]} />
              <Text style={styles.badgeText}>On</Text>
            </View>
          ) : null,
        })}
        <View style={styles.actions}>
          <Pressable
            onPress={() => void openLocal(selection)}
            disabled={busy !== undefined}
            accessibilityRole="button"
            accessibilityLabel="Open in browser"
            accessibilityState={{ disabled: busy !== undefined, busy: working }}
            style={[styles.primaryButton, styles.actionButton]}
          >
            {working ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Icon name="external-link" size={16} color={theme.colors.onPrimary} />
            )}
            <Text style={styles.actionPrimaryText}>{working ? 'Opening…' : 'Open in browser'}</Text>
          </Pressable>
          <Pressable
            onPress={() => void copyLocal(selection)}
            disabled={busy !== undefined}
            accessibilityRole="button"
            accessibilityLabel="Copy local link"
            style={[styles.secondaryButton, styles.actionButton]}
          >
            <Icon
              name={copied === 'local-link' ? 'check' : 'copy'}
              size={16}
              color={theme.colors.text}
            />
            <Text style={styles.secondaryText}>
              {copied === 'local-link' ? 'Copied' : 'Copy link'}
            </Text>
          </Pressable>
        </View>
        {share ? (
          <>
            <Text style={styles.linkMuted} numberOfLines={1}>
              {share.url}
            </Text>
            <Pressable
              onPress={() => stopLocal(share)}
              disabled={busy !== undefined}
              accessibilityRole="button"
              accessibilityLabel="Turn off local access"
              style={styles.dangerButton}
            >
              <Icon name="slash" size={16} color={theme.colors.tone.danger} />
              <Text style={styles.dangerText}>
                {busy === 'stop-local' ? 'Turning off…' : 'Turn off'}
              </Text>
            </Pressable>
          </>
        ) : null}
      </View>
    );
  };

  const publicDescription =
    'A link through Uplink for anyone you send it to. Protected by a PIN, expires automatically.';

  const renderPublicCard = (selection: PreviewTarget) => {
    const share = publicShareFor(selection);
    const creating = busy === 'public';
    const stopping = busy === 'stop-public';
    const offline =
      selection.kind === 'port' &&
      !!selection.server.managedInstanceId &&
      managed?.find((entry) => entry.instance?.id === selection.server.managedInstanceId)?.instance
        ?.state !== 'running';
    if (share) {
      const pending = share.state !== 'active' || stopping;
      return (
        <View
          style={[styles.card, styles.cardPublicActive, stopping ? styles.cardDimmed : null]}
          accessibilityLabel="Over the internet"
        >
          {renderCardHeading({
            icon: 'globe',
            title: 'Over the internet',
            description: share.pinLocked
              ? 'Visitors need the link and the PIN.'
              : 'Send link and PIN to whoever should see it.',
            status: (
              <View style={[styles.badge, styles.badgePublic]}>
                <View
                  style={[
                    styles.badgeDot,
                    pending ? styles.badgeDotPending : styles.badgeDotPublic,
                  ]}
                />
                <Text style={styles.badgeText}>
                  {stopping || share.state === 'revoking'
                    ? 'Stopping'
                    : share.state === 'creating'
                      ? 'Starting'
                      : `${offline ? 'Currently offline ·' : 'Live'} ${expiryLabel(share.expiresAt)}`}
                </Text>
              </View>
            ),
          })}
          {share.publicOrigin ? (
            <View style={styles.linkBox}>
              <View style={styles.credentialRow}>
                <Text style={styles.linkLabel}>LINK</Text>
                <Pressable
                  style={styles.credentialValue}
                  disabled={stopping}
                  onPress={() => void Linking.openURL(share.publicOrigin!).catch(() => undefined)}
                  accessibilityRole="link"
                  accessibilityLabel={`Open preview link ${share.publicOrigin}`}
                >
                  <Text style={styles.linkValue} numberOfLines={1} ellipsizeMode="middle">
                    {share.publicOrigin}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    void Clipboard.setStringAsync(share.publicOrigin!).then(() =>
                      setCopied('public-link'),
                    )
                  }
                  disabled={stopping}
                  hitSlop={14}
                  accessibilityRole="button"
                  accessibilityLabel={
                    copied === 'public-link' ? 'Link copied' : 'Copy preview link'
                  }
                >
                  <Icon
                    name={copied === 'public-link' ? 'check' : 'copy'}
                    size={18}
                    color={theme.colors.primary}
                  />
                </Pressable>
              </View>
              {share.pinLocked ? (
                <Text style={[styles.error, styles.credentialDivider, styles.lockedNote]}>
                  PIN access locked after too many failed attempts. Already signed-in visitors can
                  still use this link. Stop sharing, then create a new link to let new visitors in.
                </Text>
              ) : (
                <View style={[styles.credentialRow, styles.credentialDivider]}>
                  <Text style={styles.linkLabel}>PIN</Text>
                  <Text
                    style={[styles.credentialValue, styles.pinValue]}
                    accessibilityLabel={`PIN ${share.pin.split('').join(' ')}`}
                  >
                    {pinLabel(share.pin)}
                  </Text>
                  <Pressable
                    onPress={() =>
                      void Clipboard.setStringAsync(share.pin).then(() => setCopied('pin'))
                    }
                    disabled={stopping}
                    hitSlop={14}
                    accessibilityRole="button"
                    accessibilityLabel={copied === 'pin' ? 'PIN copied' : 'Copy PIN'}
                  >
                    <Icon
                      name={copied === 'pin' ? 'check' : 'copy'}
                      size={18}
                      color={theme.colors.primary}
                    />
                  </Pressable>
                </View>
              )}
            </View>
          ) : (
            <Text style={styles.caption}>The link starts working in a moment.</Text>
          )}
          {share.publicOrigin && !share.pinLocked ? (
            <View style={styles.actions}>
              <Pressable
                style={[styles.primaryButton, styles.actionButton]}
                onPress={() =>
                  void Share.share({ message: shareMessage(share) }).catch(() => undefined)
                }
                disabled={stopping}
                accessibilityRole="button"
                accessibilityLabel="Share link and PIN"
              >
                <Icon name="share" size={16} color={theme.colors.onPrimary} />
                <Text style={styles.actionPrimaryText}>Send link and PIN</Text>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            onPress={() => stopPublic(share)}
            disabled={busy !== undefined}
            accessibilityRole="button"
            accessibilityLabel="Stop sharing"
            accessibilityState={{ disabled: busy !== undefined, busy: stopping }}
            style={styles.dangerButton}
          >
            {stopping ? (
              <ActivityIndicator size="small" color={theme.colors.tone.danger} />
            ) : (
              <Icon name="slash" size={16} color={theme.colors.tone.danger} />
            )}
            <Text style={styles.dangerText}>{stopping ? 'Stopping…' : 'Stop sharing'}</Text>
          </Pressable>
        </View>
      );
    }
    if (publicSharing !== 'available') {
      const premium = publicSharing === 'premium-required';
      return (
        <View style={styles.card} accessibilityLabel="Over the internet">
          {renderCardHeading({
            icon: 'globe',
            title: 'Over the internet',
            description: publicDescription,
            status: (
              <View style={[styles.badge, premium ? styles.badgePremium : styles.badgeMuted]}>
                <View
                  style={[styles.badgeDot, premium ? styles.badgeDotPremium : styles.badgeDotMuted]}
                />
                <Text style={styles.badgeText}>
                  {premium ? 'Premium' : 'Temporarily unavailable'}
                </Text>
              </View>
            ),
          })}
          <Text style={styles.body}>
            {premium
              ? 'Public sharing is part of Verity Premium.'
              : 'Uplink is not reachable right now. Public links return once it is.'}
          </Text>
          {premium && onOpenSettings ? (
            <Pressable
              onPress={onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Open Premium settings"
              style={styles.inlineAction}
            >
              <Text style={styles.inlineActionText}>Learn more ›</Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
    const otherFolder = conflictingFolderShare(selection);
    if (otherFolder) {
      return (
        <View style={styles.card} accessibilityLabel="Over the internet">
          {renderCardHeading({
            icon: 'globe',
            title: 'Over the internet',
            description:
              'Only one folder per session can be online. Stop the existing link before sharing another folder.',
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Manage existing folder link"
            style={styles.secondaryButton}
            onPress={() => pick({ kind: 'folder', path: normalizeFolder(otherFolder.staticPath) })}
          >
            <Text style={styles.secondaryText}>
              Manage {folderTitle(normalizeFolder(otherFolder.staticPath))}
            </Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={styles.card} accessibilityLabel="Over the internet">
        {renderCardHeading({
          icon: 'globe',
          title: 'Over the internet',
          description: publicDescription,
          status: justStopped ? (
            <Text style={styles.caption} accessibilityLiveRegion="polite">
              Link stopped
            </Text>
          ) : null,
        })}
        <View style={styles.durationGroup}>
          <Text style={styles.label}>LINK EXPIRES AFTER</Text>
          <View style={styles.durations}>
            {PUBLIC_PREVIEW_DURATIONS.map((option) => (
              <Pressable
                key={option.seconds}
                onPress={() => setDuration(option.seconds)}
                disabled={creating}
                accessibilityRole="radio"
                accessibilityLabel={option.a11y}
                accessibilityState={{ selected: duration === option.seconds }}
                style={[
                  styles.duration,
                  duration === option.seconds ? styles.durationActive : null,
                ]}
              >
                <Text
                  style={
                    duration === option.seconds ? styles.durationTextActive : styles.durationText
                  }
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <Pressable
          onPress={() => void createPublic(selection)}
          disabled={busy !== undefined}
          accessibilityRole="button"
          accessibilityLabel={creating ? 'Creating link' : 'Create link with PIN'}
          accessibilityState={{ disabled: busy !== undefined, busy: creating }}
          style={styles.secondaryButton}
        >
          {creating ? (
            <ActivityIndicator size="small" color={theme.colors.text} />
          ) : (
            <Icon name="lock" size={16} color={theme.colors.text} />
          )}
          <Text style={styles.secondaryText}>
            {creating ? 'Creating link…' : 'Create link with PIN'}
          </Text>
        </Pressable>
        {creating ? (
          <Text style={[styles.caption, styles.centered]} accessibilityLiveRegion="polite">
            Setting up a secure public link. This takes a few seconds.
          </Text>
        ) : null}
      </View>
    );
  };

  const renderManagedDetail = (server: ManagedDevServer) => (
    <>
      <ManagedServerDetail
        server={server}
        logs={managedLogs}
        busy={managedPending !== undefined}
        onStart={() => startManaged(server)}
        onStop={() => stopManaged(server)}
        onRestart={() => restartManaged(server)}
        onAskAgent={
          onAskAgent
            ? () => {
                onAskAgent(
                  `The dev server "${server.name}" crashed${server.instance?.detail ? ` (${server.instance.detail})` : ''}. Read its output with verity-dev-server logs "${server.name}", fix the cause, and start it again with verity-dev-server start "${server.name}".`,
                );
                onClose();
              }
            : undefined
        }
        onDelete={() => deleteManaged(server)}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );

  const renderAccess = (selection: PreviewTarget) => (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.list}
      accessibilityLabel="Preview access"
    >
      <Text style={styles.caption}>How do you want to open it?</Text>
      {renderLocalCard(selection)}
      {renderPublicCard(selection)}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onRequestClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior="padding" automaticOffset>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + theme.spacing.md }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            {selectedManaged ? (
              <Pressable
                onPress={() => setManagedId(undefined)}
                style={styles.headerBack}
                accessibilityRole="button"
                accessibilityLabel="Back to preview targets"
                hitSlop={12}
              >
                <Icon name="chevron-left" size={22} color={theme.colors.text} />
                <View style={styles.rowText}>
                  <Text style={styles.title} numberOfLines={1}>
                    {selectedManaged.name}
                  </Text>
                </View>
              </Pressable>
            ) : target ? (
              <Pressable
                onPress={leaveTarget}
                disabled={busy !== undefined}
                style={styles.headerBack}
                accessibilityRole="button"
                accessibilityLabel="Back to preview targets"
                hitSlop={12}
              >
                <Icon name="chevron-left" size={22} color={theme.colors.text} />
                <View style={styles.rowText}>
                  <Text style={styles.title} numberOfLines={1}>
                    {targetTitle(target)}
                  </Text>
                  <Text style={styles.rowDetail} numberOfLines={1}>
                    {targetDetail(target)}
                  </Text>
                </View>
              </Pressable>
            ) : (
              <Text style={styles.title}>Preview</Text>
            )}
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close preview"
              hitSlop={12}
            >
              <Icon name="x" size={20} color={theme.colors.textMuted} />
            </Pressable>
          </View>
          <View style={styles.content}>
            {selectedManaged ? (
              renderManagedDetail(selectedManaged)
            ) : target ? (
              renderAccess(target)
            ) : (
              <>
                {devServersSupported ? renderTabs() : null}
                {devServersSupported && tab === undefined && !initialStateKnown ? (
                  <ActivityIndicator style={styles.loading} color={theme.colors.textMuted} />
                ) : activeTab === 'server' ? (
                  renderServerTab()
                ) : (
                  renderFolderTab()
                )}
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** On wide screens the sheet keeps one readable column instead of stretching. */
const SHEET_CONTENT_MAX_WIDTH = 640;

const styles = StyleSheet.create((theme) => ({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    height: '86%',
    minHeight: 0,
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.border,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing.md,
    marginBottom: theme.spacing.md,
    width: '100%',
    maxWidth: SHEET_CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  headerBack: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
  content: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing.md,
    width: '100%',
    maxWidth: SHEET_CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  scroll: { flex: 1, minHeight: 0 },
  list: { gap: theme.spacing.sm, paddingBottom: theme.spacing.md },
  footer: { gap: theme.spacing.md },
  label: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  sectionHint: { color: theme.colors.textFaint, fontSize: theme.text.xs },
  unmanaged: { gap: 4 },
  saveEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    alignSelf: 'flex-end',
    paddingVertical: theme.spacing.xs,
  },
  saveEntryText: { color: theme.colors.primary, fontSize: theme.text.xs, fontWeight: '600' },
  caption: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  body: { color: theme.colors.text, fontSize: theme.text.sm },
  centered: { textAlign: 'center' },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm },
  loading: { padding: theme.spacing.md },
  empty: { color: theme.colors.textMuted, padding: theme.spacing.sm, fontSize: theme.text.sm },
  sectionLabel: { marginTop: theme.spacing.md },
  emptyCard: {
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border,
  },
  emptyTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  tabs: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 40,
    borderRadius: theme.radius.sm,
  },
  tabActive: { backgroundColor: theme.colors.surface },
  tabText: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '600' },
  tabTextActive: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  tabDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.tone.done },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    minHeight: 56,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  rowPressed: { borderColor: theme.colors.primary },
  rowIcon: { width: 22, alignItems: 'center' },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  rowPort: { color: theme.colors.textMuted, fontWeight: '500' },
  rowDetail: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  serverDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.tone.done,
  },
  serverDotLoopback: { backgroundColor: theme.colors.tone.attention },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs, marginTop: 4 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
  },
  badgeLocal: {
    borderColor: theme.colors.tone.done,
    backgroundColor: `${theme.colors.tone.done}22`,
  },
  badgePublic: { borderColor: theme.colors.primary, backgroundColor: `${theme.colors.primary}22` },
  badgePremium: { borderColor: theme.colors.accent, backgroundColor: `${theme.colors.accent}22` },
  badgeMuted: { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  badgeDot: { width: 7, height: 7, borderRadius: 4 },
  badgeDotLocal: { backgroundColor: theme.colors.tone.done },
  badgeDotPublic: { backgroundColor: theme.colors.primary },
  badgeDotPending: { backgroundColor: theme.colors.tone.attention },
  badgeDotPremium: { backgroundColor: theme.colors.accent },
  badgeDotMuted: { backgroundColor: theme.colors.textFaint },
  badgeText: { color: theme.colors.text, fontSize: theme.text.xs, fontWeight: '600' },
  inlineAction: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  inlineActionText: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '600' },
  browserHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 40,
    paddingHorizontal: theme.spacing.xs,
  },
  browserBack: { width: 22, alignItems: 'center' },
  browserList: { paddingBottom: theme.spacing.md },
  browserTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
  },
  fileName: { flex: 1, color: theme.colors.textMuted, fontSize: theme.text.md },
  fileNameEntry: { color: theme.colors.text },
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  cardHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  cardTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  cardLocalActive: { borderColor: theme.colors.tone.done },
  cardPublicActive: { borderColor: theme.colors.primary },
  cardDimmed: { opacity: 0.7 },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  // Buttons in a card row share the width evenly and use one text size, so the
  // filled one stands out by colour rather than by being larger.
  actionButton: { flex: 1, gap: theme.spacing.xs, paddingHorizontal: theme.spacing.sm },
  actionPrimaryText: { color: theme.colors.onPrimary, fontWeight: '600', fontSize: theme.text.sm },
  dangerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 48,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.tone.danger,
    backgroundColor: theme.colors.surface,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    minHeight: 48,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  primaryButtonDisabled: { opacity: 0.45 },
  primaryText: { color: theme.colors.onPrimary, fontWeight: '700', fontSize: theme.text.md },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 48,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  secondaryText: { color: theme.colors.text, fontWeight: '600', fontSize: theme.text.sm },
  dangerText: { color: theme.colors.tone.danger, fontWeight: '700', fontSize: theme.text.sm },
  linkMuted: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  linkBox: {
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  linkLabel: {
    width: 36,
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  // Link and PIN share one row layout: label column, value, copy icon. The
  // value text has the same size in both rows so neither looks like an add-on.
  credentialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 48,
  },
  credentialDivider: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  credentialValue: { flex: 1, minWidth: 0 },
  lockedNote: { paddingVertical: theme.spacing.md },
  linkValue: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  pinValue: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  durationGroup: { gap: theme.spacing.xs },
  durations: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  duration: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.sm,
  },
  durationActive: { backgroundColor: theme.colors.primary },
  durationText: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
  durationTextActive: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '700' },
}));
