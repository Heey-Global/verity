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
  type PublicPreviewShare,
  type SessionDevServer,
  type VerityClient,
} from '@verity/mobile';
import { openLocalPreview } from './previewAccess';
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
// and primary action.

/** "until 20:14", or with the day when the link outlives today. */
function expiryLabel(expiresAt: string | Date, now = new Date()): string {
  const expiry = new Date(expiresAt);
  const time = expiry.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (expiry.toDateString() === now.toDateString()) return `until ${time}`;
  return `until ${expiry.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

function remainingLabel(expiresAt: string | Date, now = new Date()): string {
  const minutes = Math.max(0, Math.round((new Date(expiresAt).getTime() - now.getTime()) / 60_000));
  if (minutes >= 24 * 60) {
    const days = Math.ceil(minutes / (24 * 60));
    return `${days} ${days === 1 ? 'day' : 'days'} left`;
  }
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`;
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
  if (target.kind === 'port') return isPortShare(share) && share.targetPort === target.server.port;
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
}: {
  client: VerityClient;
  projectId: string;
  sessionId: string;
  onClose: () => void;
  detectedServers?: SessionDevServer[] | undefined;
  initialServer?: SessionDevServer | undefined;
  onOpenSettings?: (() => void) | undefined;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [publicSharing, setPublicSharing] = useState<PublicSharing>('unavailable');
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false);
  const [localShares, setLocalShares] = useState<LocalPreviewShare[]>([]);
  const [localSharesLoaded, setLocalSharesLoaded] = useState(false);
  const [publicSharesLoaded, setPublicSharesLoaded] = useState(false);
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

  const stopPublic = (share: PublicPreviewShare) => {
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

  // Re-render while a link is shown so "N min left" counts down and an
  // expired link drops out of the sheet instead of staying on screen.
  const [, setTick] = useState(0);
  const ticking = shares.some(isLive) || localShares.some(localIsLive);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, [ticking]);

  const folderReady = loadedPath === path && !loading && !folderError;
  const sessionServers = devServers.filter((server) => server.scope !== 'project');
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
  ).filter((port) => !devServers.some((server) => server.port === port));
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
    sessionServers.length > 0 || projectServers.length > 0 || orphanPorts.length > 0;
  const defaultTab: PreviewTab = hasServerTargets ? 'server' : 'folder';
  const activeTab: PreviewTab = !devServersSupported ? 'folder' : (tab ?? defaultTab);
  // The default is decided once, when servers and accesses are known; a server
  // or link arriving later only marks its tab instead of switching under the
  // user's finger.
  const initialStateKnown =
    !devServersLoading &&
    localSharesLoaded &&
    (publicSharesLoaded || (capabilitiesLoaded && publicSharing === 'premium-required'));
  useEffect(() => {
    if (tab === undefined && initialStateKnown) setTab(defaultTab);
  }, [defaultTab, initialStateKnown, tab]);

  const onRequestClose = () => {
    if (busy) return;
    if (target) leaveTarget();
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
            {value === 'server' && sessionServers.length > 0 ? (
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
        Web apps, APIs or Storybook started in this session. Visitors see your changes live.
      </Text>
      {devServersLoading && devServers.length === 0 ? (
        <ActivityIndicator style={styles.loading} color={theme.colors.textMuted} />
      ) : null}
      {!devServersLoading &&
      sessionServers.length === 0 &&
      orphanPorts.length === 0 &&
      !devServerError ? (
        <View style={styles.emptyCard}>
          <Icon name="server" size={22} color={theme.colors.textFaint} />
          <Text style={styles.emptyTitle}>No dev server running</Text>
          <Text style={[styles.caption, styles.centered]}>
            Ask the agent to start one. It shows up here as soon as it listens.
          </Text>
        </View>
      ) : null}
      {devServerError ? <Text style={styles.error}>{devServerError}</Text> : null}
      {sessionServers.map(renderServerRow)}
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
          {projectServers.map(renderServerRow)}
        </>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );

  const renderFolderTab = () => (
    <>
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
            {path ? `Worktree / ${path}` : 'HTML, slides or a built site, served as files'}
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
            style={[styles.primaryButton, styles.actionGrow]}
          >
            {working ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Icon name="external-link" size={16} color={theme.colors.onPrimary} />
            )}
            <Text style={styles.primaryText}>{working ? 'Opening…' : 'Open in browser'}</Text>
          </Pressable>
          <Pressable
            onPress={() => void copyLocal(selection)}
            disabled={busy !== undefined}
            accessibilityRole="button"
            accessibilityLabel="Copy local link"
            style={styles.secondaryButton}
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
          <View style={styles.cardFooter}>
            <Text style={styles.linkMuted} numberOfLines={1}>
              {share.url}
            </Text>
            <Pressable
              onPress={() => stopLocal(share)}
              disabled={busy !== undefined}
              accessibilityRole="button"
              accessibilityLabel="Turn off local access"
              hitSlop={8}
            >
              <Text style={styles.dangerText}>
                {busy === 'stop-local' ? 'Turning off…' : 'Turn off'}
              </Text>
            </Pressable>
          </View>
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
                      : `Live ${expiryLabel(share.expiresAt)}`}
                </Text>
              </View>
            ),
          })}
          {share.publicOrigin ? (
            <View style={styles.linkBox}>
              <Text style={styles.linkLabel}>LINK</Text>
              <Pressable
                disabled={stopping}
                onPress={() => void Linking.openURL(share.publicOrigin!).catch(() => undefined)}
                accessibilityRole="link"
                accessibilityLabel={`Open preview link ${share.publicOrigin}`}
              >
                <Text style={styles.link} numberOfLines={2}>
                  {share.publicOrigin}
                </Text>
              </Pressable>
              {share.pinLocked ? (
                <Text style={styles.error}>
                  PIN access locked after too many failed attempts. Already signed-in visitors can
                  still use this link. Stop sharing, then create a new link to let new visitors in.
                </Text>
              ) : (
                <View style={styles.pinRow}>
                  <Text style={styles.linkLabel}>PIN</Text>
                  <Text
                    style={styles.pinValue}
                    accessibilityLabel={`PIN ${share.pin.split('').join(' ')}`}
                  >
                    {pinLabel(share.pin)}
                  </Text>
                  <Pressable
                    onPress={() =>
                      void Clipboard.setStringAsync(share.pin).then(() => setCopied('pin'))
                    }
                    disabled={stopping}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Copy PIN"
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
          {share.publicOrigin ? (
            <View style={styles.actions}>
              {!share.pinLocked ? (
                <Pressable
                  style={[styles.primaryButton, styles.actionGrow]}
                  onPress={() =>
                    void Share.share({ message: shareMessage(share) }).catch(() => undefined)
                  }
                  disabled={stopping}
                  accessibilityRole="button"
                  accessibilityLabel="Share link and PIN"
                >
                  <Icon name="share" size={16} color={theme.colors.onPrimary} />
                  <Text style={styles.primaryText}>Send link and PIN</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={styles.secondaryButton}
                onPress={() =>
                  void Clipboard.setStringAsync(share.publicOrigin!).then(() =>
                    setCopied('public-link'),
                  )
                }
                disabled={stopping}
                accessibilityRole="button"
                accessibilityLabel="Copy preview link"
              >
                <Icon
                  name={copied === 'public-link' ? 'check' : 'copy'}
                  size={16}
                  color={theme.colors.text}
                />
                <Text style={styles.secondaryText}>
                  {copied === 'public-link' ? 'Copied' : 'Copy link'}
                </Text>
              </Pressable>
            </View>
          ) : null}
          <View style={styles.cardFooter}>
            <Text style={styles.caption}>{remainingLabel(share.expiresAt)}</Text>
            <Pressable
              onPress={() => stopPublic(share)}
              disabled={busy !== undefined}
              accessibilityRole="button"
              accessibilityLabel="Stop sharing"
              accessibilityState={{ disabled: busy !== undefined, busy: stopping }}
              hitSlop={8}
            >
              <Text style={styles.dangerText}>{stopping ? 'Stopping…' : 'Stop sharing'}</Text>
            </Pressable>
          </View>
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
            {target ? (
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
            {target ? (
              renderAccess(target)
            ) : (
              <>
                {devServersSupported ? renderTabs() : null}
                {activeTab === 'server' ? renderServerTab() : renderFolderTab()}
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

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
  },
  headerBack: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
  content: { flex: 1, minHeight: 0, gap: theme.spacing.md },
  scroll: { flex: 1, minHeight: 0 },
  list: { gap: theme.spacing.sm, paddingBottom: theme.spacing.md },
  footer: { gap: theme.spacing.md },
  label: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
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
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  actionGrow: { flex: 1 },
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
  link: { flex: 1, minWidth: 0, color: theme.colors.text, fontSize: theme.text.sm },
  linkMuted: { flex: 1, minWidth: 0, color: theme.colors.textMuted, fontSize: theme.text.sm },
  linkBox: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  linkLabel: { color: theme.colors.textFaint, fontSize: theme.text.xs, fontWeight: '600' },
  pinRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  pinValue: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.lg,
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
