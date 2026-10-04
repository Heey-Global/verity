import { useCallback, useEffect, useRef, useState } from 'react';
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

// The sheet asks two questions, one per step. Step one: which target, a server
// running in the session or a folder of the worktree. Step two: which access,
// opening it on the server's own network or sharing it publicly through the
// Uplink. Both accesses sit side by side as cards because both can be active
// at once, and each card owns its own state and primary action.

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

function folderTitle(path: string): string {
  const normalized = normalizeFolder(path);
  return normalized === '.' ? 'Worktree' : (normalized.split('/').pop() ?? normalized);
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
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, sessionId]);

  // Folder browsing. The target list shows the worktree root and its top-level
  // folders; "Browse folders" walks deeper with the same explorer.
  const [browsing, setBrowsing] = useState(false);
  const [path, setPath] = useState('');
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [folderError, setFolderError] = useState<string>();
  const [rootDirectories, setRootDirectories] = useState<string[]>([]);
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
        if (path === '') setRootDirectories(entries.directories);
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
    setBrowsing(false);
    setTarget(next);
  };

  const leaveTarget = () => {
    setError(undefined);
    setTarget(undefined);
  };

  const leaveBrowser = () => {
    setBrowsing(false);
    if (path !== '') navigate('');
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

  const onRequestClose = () => {
    if (busy) return;
    if (target) leaveTarget();
    else if (browsing) leaveBrowser();
    else onClose();
  };

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
  const liveFolderPaths = new Set<string>([
    ...shares
      .filter((share) => share.targetKind === 'static-folder' && isLive(share))
      .map((share) => normalizeFolder(share.staticPath)),
    ...localShares
      .filter((share) => share.targetPort === null && localIsLive(share))
      .map((share) => normalizeFolder(share.staticPath)),
  ]);
  const folderRows = Array.from(
    new Set<string>([
      '.',
      ...rootDirectories,
      ...Array.from(liveFolderPaths).filter((folder) => folder !== '.'),
    ]),
  );

  const renderBadge = (selection: PreviewTarget) => {
    const local = localShareFor(selection);
    const pub = publicShareFor(selection);
    if (!local && !pub) return null;
    return (
      <View style={styles.badges}>
        {local ? (
          <View style={[styles.badge, styles.badgeLocal]}>
            <View style={[styles.badgeDot, styles.badgeDotLocal]} />
            <Text style={styles.badgeText}>Local open</Text>
          </View>
        ) : null}
        {pub ? (
          <View style={[styles.badge, styles.badgePublic]}>
            <View style={[styles.badgeDot, styles.badgeDotPublic]} />
            <Text style={styles.badgeText}>{`Public ${expiryLabel(pub.expiresAt)}`}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  const renderServerRow = (server: SessionDevServer) => {
    const selection: PreviewTarget = { kind: 'port', server };
    const port = String(server.port);
    return (
      <Pressable
        key={`${server.scope ?? 'session'}:${port}`}
        style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
        onPress={() => pick(selection)}
        accessibilityRole="button"
        accessibilityLabel={`${server.name} on port ${port}`}
      >
        <View style={styles.rowMain}>
          <View style={[styles.serverDot, server.reachable ? null : styles.serverDotLoopback]} />
          <View style={styles.rowText}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {server.name}
              <Text style={styles.rowPort}>{` :${port}`}</Text>
            </Text>
            <Text style={styles.rowDetail} numberOfLines={1}>
              {serverDetail(server)}
            </Text>
          </View>
          <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
        </View>
        {renderBadge(selection)}
      </Pressable>
    );
  };

  const renderFolderRow = (folder: string) => {
    const selection: PreviewTarget = { kind: 'folder', path: folder === '.' ? '' : folder };
    return (
      <Pressable
        key={`folder:${folder}`}
        style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
        onPress={() => pick(selection)}
        accessibilityRole="button"
        accessibilityLabel={folder === '.' ? 'Worktree root folder' : `Folder ${folder}`}
      >
        <View style={styles.rowMain}>
          <Icon name="folder" size={18} color={theme.colors.textMuted} />
          <View style={styles.rowText}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {folder === '.' ? 'Worktree' : folder}
            </Text>
          </View>
          <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
        </View>
        {renderBadge(selection)}
      </Pressable>
    );
  };

  const renderTargetList = () => (
    <View style={styles.content}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.list}
        accessibilityLabel="Preview targets"
      >
        {devServersSupported ? (
          <>
            <Text style={styles.label}>RUNNING IN THIS SESSION</Text>
            {devServersLoading && devServers.length === 0 ? (
              <ActivityIndicator style={styles.loading} color={theme.colors.textMuted} />
            ) : null}
            {!devServersLoading &&
            sessionServers.length === 0 &&
            orphanPorts.length === 0 &&
            !devServerError ? (
              <View style={styles.emptyRow}>
                <Icon name="monitor" size={18} color={theme.colors.textFaint} />
                <Text style={styles.caption}>
                  No dev server running. When one starts in this session, it shows up here.
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
              return (
                <Pressable
                  key={`orphan:${port}`}
                  style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                  onPress={() => pick({ kind: 'port', server })}
                  accessibilityRole="button"
                  accessibilityLabel={`Show link for port ${port}`}
                >
                  <View style={styles.rowMain}>
                    <View style={styles.rowText}>
                      <Text style={styles.rowTitle}>{`Port ${port}`}</Text>
                      <Text style={styles.rowDetail}>Active access without a detected server</Text>
                    </View>
                    <Icon name="chevron-right" size={18} color={theme.colors.textFaint} />
                  </View>
                  {renderBadge({ kind: 'port', server })}
                </Pressable>
              );
            })}
            {projectServers.length > 0 ? (
              <>
                <Text style={styles.label}>RUNNING IN THIS PROJECT</Text>
                {projectServers.map(renderServerRow)}
              </>
            ) : null}
          </>
        ) : null}
        <Text style={styles.label}>FOLDERS</Text>
        {folderRows.map(renderFolderRow)}
        <Pressable
          onPress={() => setBrowsing(true)}
          accessibilityRole="button"
          accessibilityLabel="Browse folders"
          style={styles.inlineAction}
        >
          <Icon name="search" size={16} color={theme.colors.primary} />
          <Text style={styles.inlineActionText}>Browse folders…</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
      <Text style={[styles.caption, styles.centered]}>
        Open = on your server’s network · Share = public through Uplink
      </Text>
    </View>
  );

  const renderBrowser = () => (
    <View style={styles.content}>
      <View style={styles.browserHeader}>
        <Pressable
          onPress={() => (path ? navigate(path.split('/').slice(0, -1).join('/')) : leaveBrowser())}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={path ? 'Back to parent folder' : 'Back to preview targets'}
        >
          <Icon name="chevron-left" size={20} color={theme.colors.primary} />
        </Pressable>
        <View style={styles.rowText}>
          <Text style={styles.browserTitle} numberOfLines={1}>
            {folderTitle(path)}
          </Text>
          <Text style={styles.rowDetail} numberOfLines={1}>
            {path ? `Worktree / ${path}` : 'Worktree root'}
          </Text>
        </View>
      </View>
      <ScrollView style={styles.scroll} accessibilityLabel="Preview folder explorer">
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
              <Icon name="file" size={18} color={theme.colors.textFaint} />
              <Text style={styles.fileName} numberOfLines={2}>
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
        <Pressable
          onPress={() => pick({ kind: 'folder', path })}
          disabled={!folderReady}
          accessibilityRole="button"
          accessibilityLabel={path ? `Use folder ${path}` : 'Use the worktree root'}
          accessibilityState={{ disabled: !folderReady }}
          style={[styles.primaryButton, !folderReady ? styles.primaryButtonDisabled : null]}
        >
          <Text style={styles.primaryText} numberOfLines={1}>
            {path ? `Use “${folderTitle(path)}”` : 'Use the worktree root'}
          </Text>
        </Pressable>
      </View>
    </View>
  );

  const renderLocalCard = (selection: PreviewTarget) => {
    const share = localShareFor(selection);
    const working = busy === 'local';
    return (
      <View
        style={[styles.card, share ? styles.cardLocalActive : null]}
        accessibilityLabel="Open on your network"
      >
        <View style={styles.cardHeader}>
          <Text style={styles.label}>OPEN ON YOUR NETWORK</Text>
          {share ? (
            <View style={[styles.badge, styles.badgeLocal]}>
              <View style={[styles.badgeDot, styles.badgeDotLocal]} />
              <Text style={styles.badgeText}>Active</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.caption}>
          For you and devices on your server’s network. No access protection, no TLS.
        </Text>
        <View style={styles.actions}>
          <Pressable
            onPress={() => void openLocal(selection)}
            disabled={busy !== undefined}
            accessibilityRole="button"
            accessibilityLabel="Open"
            accessibilityState={{ disabled: busy !== undefined, busy: working }}
            style={[styles.primaryButton, styles.actionGrow]}
          >
            {working ? <ActivityIndicator size="small" color={theme.colors.onPrimary} /> : null}
            <Text style={styles.primaryText}>{working ? 'Opening…' : 'Open'}</Text>
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
            <Text style={styles.link} numberOfLines={1}>
              {share.url}
            </Text>
            <Pressable
              onPress={() => stopLocal(share)}
              disabled={busy !== undefined}
              accessibilityRole="button"
              accessibilityLabel="Stop local access"
              hitSlop={8}
            >
              <Text style={styles.dangerText}>{busy === 'stop-local' ? 'Stopping…' : 'Stop'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const renderPublicCard = (selection: PreviewTarget) => {
    const share = publicShareFor(selection);
    const creating = busy === 'public';
    const stopping = busy === 'stop-public';
    if (share) {
      const pending = share.state !== 'active' || stopping;
      return (
        <View
          style={[styles.card, styles.cardPublicActive, stopping ? styles.cardDimmed : null]}
          accessibilityLabel="Share publicly"
        >
          <View style={styles.cardHeader}>
            <Text style={styles.label}>SHARE PUBLICLY</Text>
            <View style={[styles.badge, styles.badgePublic]}>
              <View
                style={[styles.badgeDot, pending ? styles.badgeDotPending : styles.badgeDotPublic]}
              />
              <Text style={styles.badgeText}>
                {stopping || share.state === 'revoking'
                  ? 'Stopping'
                  : share.state === 'creating'
                    ? 'Starting'
                    : `Active ${expiryLabel(share.expiresAt)}`}
              </Text>
            </View>
          </View>
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
                  <Text style={styles.primaryText}>Share</Text>
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
            <Text style={styles.caption}>
              {`Visitors need link and PIN · ${remainingLabel(share.expiresAt)}`}
            </Text>
            <Pressable
              onPress={() => stopPublic(share)}
              disabled={busy !== undefined}
              accessibilityRole="button"
              accessibilityLabel="Stop sharing"
              accessibilityState={{ disabled: busy !== undefined, busy: stopping }}
              hitSlop={8}
            >
              <Text style={styles.dangerText}>{stopping ? 'Stopping…' : 'Stop'}</Text>
            </Pressable>
          </View>
        </View>
      );
    }
    if (publicSharing !== 'available') {
      const premium = publicSharing === 'premium-required';
      return (
        <View style={styles.card} accessibilityLabel="Share publicly">
          <View style={styles.cardHeader}>
            <Text style={styles.label}>SHARE PUBLICLY</Text>
            <View style={[styles.badge, premium ? styles.badgePremium : styles.badgeMuted]}>
              <View
                style={[styles.badgeDot, premium ? styles.badgeDotPremium : styles.badgeDotMuted]}
              />
              <Text style={styles.badgeText}>
                {premium ? 'Premium' : 'Temporarily unavailable'}
              </Text>
            </View>
          </View>
          <Text style={styles.caption}>
            A link through Uplink, with a PIN and an expiry, for anyone you send it to.
          </Text>
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
    return (
      <View style={styles.card} accessibilityLabel="Share publicly">
        <View style={styles.cardHeader}>
          <Text style={styles.label}>SHARE PUBLICLY</Text>
          {justStopped ? (
            <Text style={styles.caption} accessibilityLiveRegion="polite">
              Link stopped
            </Text>
          ) : null}
        </View>
        <Text style={styles.caption}>
          A link through Uplink, with a PIN and an expiry, for anyone you send it to.
        </Text>
        <Text style={styles.label}>EXPIRES AFTER</Text>
        <View style={styles.durations}>
          {PUBLIC_PREVIEW_DURATIONS.map((option) => (
            <Pressable
              key={option.seconds}
              onPress={() => setDuration(option.seconds)}
              disabled={creating}
              accessibilityRole="radio"
              accessibilityLabel={option.a11y}
              accessibilityState={{ selected: duration === option.seconds }}
              style={[styles.duration, duration === option.seconds ? styles.durationActive : null]}
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
        <View style={styles.accessNote}>
          <Icon name="lock" size={18} color={theme.colors.textMuted} />
          <View style={styles.rowText}>
            <Text style={styles.accessTitle}>Protected by a PIN</Text>
            <Text style={styles.caption}>You get it together with the link.</Text>
          </View>
        </View>
        <Pressable
          onPress={() => void createPublic(selection)}
          disabled={busy !== undefined}
          accessibilityRole="button"
          accessibilityLabel={creating ? 'Creating link' : 'Create public link'}
          accessibilityState={{ disabled: busy !== undefined, busy: creating }}
          style={styles.primaryButton}
        >
          {creating ? <ActivityIndicator size="small" color={theme.colors.onPrimary} /> : null}
          <Text style={styles.primaryText}>
            {creating ? 'Creating link…' : 'Create public link'}
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
    <View style={styles.content}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.list}
        accessibilityLabel="Preview access"
      >
        {renderLocalCard(selection)}
        {renderPublicCard(selection)}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </View>
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
          {target ? renderAccess(target) : browsing ? renderBrowser() : renderTargetList()}
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
  emptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  row: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  rowPressed: { borderColor: theme.colors.primary },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  rowPort: { color: theme.colors.textMuted, fontWeight: '500' },
  rowDetail: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  serverDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.tone.done },
  serverDotLoopback: { backgroundColor: theme.colors.tone.attention },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs },
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
  browserHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  browserTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
  },
  fileName: { flex: 1, color: theme.colors.textMuted, fontSize: theme.text.md },
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
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
  accessNote: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  accessTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
}));
