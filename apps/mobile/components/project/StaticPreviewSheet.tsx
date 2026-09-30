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
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PublicPreviewShare, SessionDevServer, VerityClient } from '@verity/mobile';
import { Icon } from '../Icon';
import { SessionFolderRow } from '../SessionFolderRow';
import {
  generatePreviewPin,
  LONG_PREVIEW_DURATION_SECONDS,
  PUBLIC_PREVIEW_DURATIONS,
  validPreviewPin,
} from './publicPreviewShare';

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

function folderLabel(staticPath: string | null): string {
  return !staticPath || staticPath === '.' ? 'Worktree' : staticPath;
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

function serverLabel(port: number, servers: readonly SessionDevServer[]): string {
  const server = servers.find((item) => item.port === port);
  return `${server?.name ?? 'Dev server'} :${String(port)}`;
}

type PreviewTab = 'server' | 'folder';

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

export function StaticPreviewSheet({
  client,
  projectId,
  sessionId,
  onClose,
}: {
  client: VerityClient;
  projectId: string;
  sessionId: string;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [path, setPath] = useState('');
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [shares, setShares] = useState<PublicPreviewShare[]>([]);
  const [sharesLoading, setSharesLoading] = useState(true);
  const [pin, setPin] = useState(generatePreviewPin);
  const [duration, setDuration] = useState(3600);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [folderError, setFolderError] = useState<string>();
  const [copied, setCopied] = useState<{ id: string; what: 'link' | 'pin' }>();
  // Stopping takes an Uplink round trip. Without its own state the button just
  // sat there and the sheet later jumped to the create form unannounced.
  const [stoppingId, setStoppingId] = useState<string>();
  const [stopped, setStopped] = useState<{ tab: PreviewTab; label: string }>();
  // Older Cores have no port detection; the sheet then offers folders only.
  const devServersSupported = typeof client.listSessionDevServers === 'function';
  const [tab, setTab] = useState<PreviewTab>(devServersSupported ? 'server' : 'folder');
  const tabChosen = useRef(false);
  const [devServers, setDevServers] = useState<SessionDevServer[]>([]);
  const [devServersLoading, setDevServersLoading] = useState(devServersSupported);
  const [devServerError, setDevServerError] = useState<string>();
  const [openPort, setOpenPort] = useState<number>();
  const [creatingPort, setCreatingPort] = useState<number>();
  const requestGeneration = useRef(0);
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
    let active = true;
    void client
      .listPublicPreviewShares(projectId)
      .then((nextShares) => {
        if (active) {
          setShares((current) => {
            const local = current.filter((share) => createdShareIds.current.has(share.id));
            const remote = nextShares.filter(
              (share) =>
                (share.targetKind === 'static-folder' || isPortShare(share)) &&
                share.sessionId === sessionId &&
                !stoppedShareIds.current.has(share.id) &&
                !createdShareIds.current.has(share.id),
            );
            return [...local, ...remote];
          });
          // Reopening on a live folder link lands on it, as before the tabs.
          const live = nextShares.filter((share) => share.sessionId === sessionId && isLive(share));
          if (
            !tabChosen.current &&
            live.some((share) => share.targetKind === 'static-folder') &&
            !live.some(isPortShare)
          ) {
            setTab('folder');
          }
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(previewError(caught));
      })
      .finally(() => {
        if (active) setSharesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, projectId, sessionId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);

  // Servers come and go as the agent starts them; poll while the tab is shown so
  // a freshly started one appears without reopening the sheet.
  const pollDevServers = devServersSupported && tab === 'server';
  useEffect(() => {
    if (!pollDevServers) return;
    let active = true;
    const load = () =>
      client
        .listSessionDevServers(sessionId)
        .then((servers) => {
          if (!active) return;
          setDevServers(servers);
          setDevServerError(undefined);
        })
        .catch((caught: unknown) => {
          if (active) {
            setDevServerError(
              caught instanceof Error ? caught.message : 'Could not look for dev servers',
            );
          }
        })
        .finally(() => {
          if (active) setDevServersLoading(false);
        });
    void load();
    const timer = setInterval(() => void load(), 4_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, pollDevServers, sessionId]);

  const selectTab = (next: PreviewTab) => {
    tabChosen.current = true;
    setError(undefined);
    setTab(next);
  };

  const create = async () => {
    if (loadedPath !== path || !validPreviewPin(pin, duration) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const share = await client.createSessionStaticPreviewShare(sessionId, {
        staticPath: path || '.',
        pin,
        ttlSeconds: duration,
      });
      createdShareIds.current.add(share.id);
      setShares((current) => [share, ...current]);
      setPin(generatePreviewPin());
    } catch (caught) {
      setError(previewError(caught));
    } finally {
      setBusy(false);
    }
  };

  const createForPort = async (server: SessionDevServer) => {
    if (!server.reachable || !validPreviewPin(pin, duration) || busy) return;
    setBusy(true);
    setCreatingPort(server.port);
    setError(undefined);
    try {
      const share = await client.createSessionPortPreviewShare(sessionId, {
        targetPort: server.port,
        pin,
        ttlSeconds: duration,
      });
      createdShareIds.current.add(share.id);
      setShares((current) => [share, ...current]);
      setPin(generatePreviewPin());
      setStopped(undefined);
      setOpenPort(server.port);
    } catch (caught) {
      setError(previewError(caught));
    } finally {
      setBusy(false);
      setCreatingPort(undefined);
    }
  };

  const stop = (share: PublicPreviewShare) => {
    Alert.alert('Stop preview?', 'The link will stop working immediately.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop sharing',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          setError(undefined);
          setStoppingId(share.id);
          void client
            .stopPublicPreviewShare(share.id)
            .then(() => {
              stoppedShareIds.current.add(share.id);
              createdShareIds.current.delete(share.id);
              setStopped(
                isPortShare(share)
                  ? { tab: 'server', label: serverLabel(share.targetPort!, devServers) }
                  : { tab: 'folder', label: folderLabel(share.staticPath ?? null) },
              );
              setShares((current) => current.filter((item) => item.id !== share.id));
            })
            .catch((caught: unknown) =>
              setError(caught instanceof Error ? caught.message : 'Could not stop preview'),
            )
            .finally(() => {
              setBusy(false);
              setStoppingId(undefined);
            });
        },
      },
    ]);
  };

  const portShare = (port: number) =>
    shares.find((share) => isPortShare(share) && share.targetPort === port && isLive(share));
  const activeShare =
    tab === 'folder'
      ? shares.find((share) => share.targetKind === 'static-folder' && isLive(share))
      : openPort === undefined
        ? undefined
        : portShare(openPort);
  const activeIsPort = activeShare !== undefined && isPortShare(activeShare);
  const stoppedVisible = activeShare === undefined && stopped?.tab === tab;
  const serverDetails = tab === 'server' && (activeShare !== undefined || stoppedVisible);
  const detailsVisible = activeShare !== undefined || stoppedVisible;
  const backToServers = () => {
    setStopped(undefined);
    setOpenPort(undefined);
  };
  const hasIndex = files.includes('index.html');
  const canCreate = loadedPath === path && validPreviewPin(pin, duration) && !busy;
  const stopping = activeShare !== undefined && stoppingId === activeShare.id;
  // Re-render while a link is shown so "N min left" counts down and an
  // expired link drops out of the sheet instead of staying on screen.
  const [, setTick] = useState(0);
  const ticking = activeShare !== undefined || shares.some(isLive);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const expirySettings = (
    <>
      <Text style={styles.label}>EXPIRES AFTER</Text>
      <View style={styles.durations}>
        {PUBLIC_PREVIEW_DURATIONS.map((option) => (
          <Pressable
            key={option.seconds}
            onPress={() => setDuration(option.seconds)}
            accessibilityRole="radio"
            accessibilityLabel={option.a11y}
            accessibilityState={{ selected: duration === option.seconds }}
            style={[styles.duration, duration === option.seconds ? styles.durationActive : null]}
          >
            <Text
              style={duration === option.seconds ? styles.durationTextActive : styles.durationText}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.pinLabelRow}>
        <Text style={styles.label}>PIN</Text>
        <Text style={styles.pinHint}>Visitors need it to open the link</Text>
      </View>
      <View style={styles.pinInputRow}>
        <TextInput
          value={pin}
          onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 12))}
          keyboardType="number-pad"
          accessibilityLabel="Preview PIN"
          accessibilityHint={
            duration >= LONG_PREVIEW_DURATION_SECONDS ? '12 digits' : '6 to 12 digits'
          }
          style={styles.pinInput}
          placeholder={duration >= LONG_PREVIEW_DURATION_SECONDS ? '12 digits' : '6–12 digits'}
          placeholderTextColor={theme.colors.textFaint}
        />
        <Pressable
          onPress={() => setPin(generatePreviewPin())}
          hitSlop={8}
          style={styles.pinRefresh}
          accessibilityRole="button"
          accessibilityLabel="Generate a new PIN"
        >
          <Icon name="refresh-cw" size={18} color={theme.colors.primary} />
        </Pressable>
      </View>
    </>
  );
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior="padding" automaticOffset>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" />
        <View
          style={[
            styles.sheet,
            !detailsVisible ? styles.createSheet : null,
            { paddingBottom: insets.bottom + theme.spacing.md },
          ]}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>Share preview</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close preview sharing"
              hitSlop={12}
            >
              <Icon name="x" size={20} color={theme.colors.textMuted} />
            </Pressable>
          </View>
          {devServersSupported ? (
            <View style={styles.tabs} accessibilityRole="tablist">
              {(
                [
                  ['server', 'Dev server'],
                  ['folder', 'Folder'],
                ] as const
              ).map(([value, label]) => (
                <Pressable
                  key={value}
                  onPress={() => selectTab(value)}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: tab === value }}
                  style={[styles.tab, tab === value ? styles.tabActive : null]}
                >
                  <Text style={tab === value ? styles.tabTextActive : styles.tabText}>{label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {serverDetails ? (
            <Pressable
              onPress={backToServers}
              style={styles.backRow}
              accessibilityRole="button"
              accessibilityLabel="Back to dev servers"
              hitSlop={8}
            >
              <Icon name="chevron-left" size={16} color={theme.colors.primary} />
              <Text style={styles.backText}>All dev servers</Text>
            </Pressable>
          ) : null}
          {detailsVisible ? (
            <View style={styles.detailsBody}>
              <ScrollView
                style={styles.detailsScroll}
                contentContainerStyle={styles.detailsContent}
                accessibilityLabel={activeShare ? 'Active preview link' : 'Preview link stopped'}
              >
                {sharesLoading && !activeShare && !stoppedVisible ? (
                  <ActivityIndicator color={theme.colors.textMuted} />
                ) : null}
                {activeShare ? (
                  <View style={[styles.shareCard, stopping ? styles.shareCardStopping : null]}>
                    <View style={styles.statusPill}>
                      <View
                        style={[
                          styles.statusDot,
                          activeShare.state !== 'active' || stopping
                            ? styles.statusDotPending
                            : null,
                        ]}
                      />
                      <Text style={styles.statusText}>
                        {stopping
                          ? 'Stopping'
                          : activeShare.state === 'active'
                            ? 'Live'
                            : activeShare.state === 'creating'
                              ? 'Starting'
                              : 'Stopping'}
                      </Text>
                    </View>
                    <View style={styles.heroText}>
                      <Text style={styles.heroTitle}>
                        {stopping || activeShare.state === 'revoking'
                          ? 'Stopping your preview'
                          : activeShare.state === 'creating'
                            ? 'Starting your preview'
                            : 'Your preview is live'}
                      </Text>
                      <Text style={styles.caption}>
                        {stopping || activeShare.state === 'revoking'
                          ? 'Switching the link off. This takes a few seconds.'
                          : activeShare.state === 'creating'
                            ? 'The link starts working in a moment.'
                            : activeIsPort
                              ? 'Anyone with this link and the PIN can open the dev server.'
                              : 'Anyone with this link and the PIN can view the folder.'}
                      </Text>
                    </View>
                    {activeShare.publicOrigin ? (
                      <>
                        <Pressable
                          style={styles.linkBox}
                          disabled={stopping}
                          onPress={() =>
                            void Linking.openURL(activeShare.publicOrigin!).catch(() => undefined)
                          }
                          accessibilityRole="link"
                          accessibilityLabel={`Open preview link ${activeShare.publicOrigin}`}
                        >
                          <Icon name="link" size={16} color={theme.colors.primary} />
                          <Text style={styles.link} numberOfLines={2}>
                            {activeShare.publicOrigin}
                          </Text>
                        </Pressable>
                        <View style={styles.pinBox}>
                          <Icon name="lock" size={16} color={theme.colors.textMuted} />
                          <Text
                            style={styles.pinValue}
                            accessibilityLabel={`PIN ${activeShare.pin.split('').join(' ')}`}
                          >
                            {pinLabel(activeShare.pin)}
                          </Text>
                          <Pressable
                            onPress={() =>
                              void Clipboard.setStringAsync(activeShare.pin).then(() =>
                                setCopied({ id: activeShare.id, what: 'pin' }),
                              )
                            }
                            disabled={stopping}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel="Copy PIN"
                          >
                            <Icon
                              name={
                                copied?.id === activeShare.id && copied.what === 'pin'
                                  ? 'check'
                                  : 'copy'
                              }
                              size={18}
                              color={theme.colors.primary}
                            />
                          </Pressable>
                        </View>
                        <View style={styles.actions}>
                          <Pressable
                            style={[styles.actionButton, styles.actionButtonPrimary]}
                            onPress={() =>
                              void Share.share({ message: shareMessage(activeShare) }).catch(
                                () => undefined,
                              )
                            }
                            disabled={stopping}
                            accessibilityRole="button"
                            accessibilityLabel="Share link and PIN"
                          >
                            <Icon name="share" size={16} color={theme.colors.onPrimary} />
                            <Text style={styles.actionTextPrimary}>Share</Text>
                          </Pressable>
                          <Pressable
                            style={styles.actionButton}
                            onPress={() =>
                              void Clipboard.setStringAsync(activeShare.publicOrigin!).then(() =>
                                setCopied({ id: activeShare.id, what: 'link' }),
                              )
                            }
                            disabled={stopping}
                            accessibilityRole="button"
                            accessibilityLabel="Copy preview link"
                          >
                            <Icon
                              name={
                                copied?.id === activeShare.id && copied.what === 'link'
                                  ? 'check'
                                  : 'copy'
                              }
                              size={16}
                              color={theme.colors.text}
                            />
                            <Text style={styles.actionText}>
                              {copied?.id === activeShare.id && copied.what === 'link'
                                ? 'Copied'
                                : 'Copy link'}
                            </Text>
                          </Pressable>
                          <Pressable
                            style={styles.actionButton}
                            onPress={() =>
                              void Linking.openURL(activeShare.publicOrigin!).catch(() => undefined)
                            }
                            disabled={stopping}
                            accessibilityRole="button"
                            accessibilityLabel="Open preview in browser"
                          >
                            <Icon name="external-link" size={16} color={theme.colors.text} />
                            <Text style={styles.actionText}>Open</Text>
                          </Pressable>
                        </View>
                      </>
                    ) : null}
                    <View style={styles.facts}>
                      <View style={styles.fact}>
                        <Icon
                          name={activeIsPort ? 'server' : 'folder'}
                          size={16}
                          color={theme.colors.textMuted}
                        />
                        <Text style={styles.factLabel}>{activeIsPort ? 'Server' : 'Folder'}</Text>
                        <Text style={styles.factValue} numberOfLines={1}>
                          {activeIsPort
                            ? serverLabel(activeShare.targetPort!, devServers)
                            : folderLabel(activeShare.staticPath)}
                        </Text>
                      </View>
                      <View style={styles.fact}>
                        <Icon name="clock" size={16} color={theme.colors.textMuted} />
                        <Text style={styles.factLabel}>Expires</Text>
                        <Text style={styles.factValue} numberOfLines={1}>
                          {`${remainingLabel(activeShare.expiresAt)} · ${expiryLabel(activeShare.expiresAt)}`}
                        </Text>
                      </View>
                    </View>
                  </View>
                ) : null}
                {stoppedVisible ? (
                  <View style={styles.stoppedCard} accessibilityLiveRegion="polite">
                    <Icon name="check-circle" size={32} color={theme.colors.tone.done} />
                    <Text style={styles.heroTitle}>Link stopped</Text>
                    <Text style={[styles.caption, styles.centered]}>
                      {`The link for ${stopped?.label ?? 'this preview'} no longer works. Anyone who still has it sees nothing.`}
                    </Text>
                  </View>
                ) : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </ScrollView>
              {activeShare ? (
                <Pressable
                  style={[styles.stopButton, stopping ? styles.stopButtonBusy : null]}
                  onPress={() => stop(activeShare)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Stop sharing"
                  accessibilityState={{ disabled: busy, busy: stopping }}
                >
                  {stopping ? (
                    <ActivityIndicator size="small" color={theme.colors.tone.danger} />
                  ) : (
                    <Icon name="slash" size={16} color={theme.colors.tone.danger} />
                  )}
                  <Text style={styles.dangerText}>
                    {stopping ? 'Stopping link…' : 'Stop sharing'}
                  </Text>
                </Pressable>
              ) : null}
              {stoppedVisible ? (
                <View style={styles.stoppedActions}>
                  <Pressable
                    style={styles.createButton}
                    onPress={() => (tab === 'server' ? backToServers() : setStopped(undefined))}
                    accessibilityRole="button"
                  >
                    <Text style={styles.createText}>
                      {tab === 'server' ? 'Back to dev servers' : 'Create a new link'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={onClose}
                    accessibilityRole="button"
                  >
                    <Text style={styles.secondaryText}>Done</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : tab === 'server' ? (
            <View style={styles.content}>
              <Text style={styles.label}>RUNNING IN THIS SESSION</Text>
              <ScrollView
                style={styles.explorer}
                contentContainerStyle={styles.serverList}
                accessibilityLabel="Dev servers in this session"
              >
                {devServersLoading && devServers.length === 0 ? (
                  <ActivityIndicator style={styles.loading} color={theme.colors.textMuted} />
                ) : null}
                {!devServersLoading && devServers.length === 0 && !devServerError ? (
                  <View style={styles.emptyServers}>
                    <Icon name="monitor" size={28} color={theme.colors.textFaint} />
                    <Text style={styles.heroTitle}>No dev server running</Text>
                    <Text style={[styles.caption, styles.centered]}>
                      When a server starts in this session, it shows up here automatically.
                    </Text>
                  </View>
                ) : null}
                {devServers.map((server) => {
                  const live = portShare(server.port);
                  const creating = creatingPort === server.port;
                  const port = String(server.port);
                  return (
                    <View
                      key={port}
                      style={styles.serverRow}
                      accessibilityLabel={`${server.name} on port ${port}`}
                    >
                      <View style={styles.serverMain}>
                        <View
                          style={[
                            styles.serverDot,
                            server.reachable ? null : styles.serverDotLocal,
                          ]}
                        />
                        <View style={styles.serverText}>
                          <Text style={styles.serverName} numberOfLines={1}>
                            {server.name}
                            <Text style={styles.serverPort}>{` :${port}`}</Text>
                          </Text>
                          <Text style={styles.serverCommand} numberOfLines={1}>
                            {server.workdir === '.'
                              ? server.command
                              : `${server.workdir} · ${server.command}`}
                          </Text>
                        </View>
                        {live ? (
                          <Pressable
                            style={styles.livePill}
                            onPress={() => {
                              setStopped(undefined);
                              setOpenPort(server.port);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`Show link for port ${port}`}
                          >
                            <View style={styles.statusDot} />
                            <Text style={styles.liveText}>Live</Text>
                            <Icon name="chevron-right" size={14} color={theme.colors.primary} />
                          </Pressable>
                        ) : server.reachable ? (
                          <Pressable
                            style={[
                              styles.shareButton,
                              busy || !validPreviewPin(pin, duration)
                                ? styles.createButtonDisabled
                                : null,
                            ]}
                            onPress={() => void createForPort(server)}
                            disabled={busy || !validPreviewPin(pin, duration)}
                            accessibilityRole="button"
                            accessibilityLabel={
                              creating ? `Creating link for port ${port}` : `Share port ${port}`
                            }
                            accessibilityState={{
                              disabled: busy || !validPreviewPin(pin, duration),
                              busy: creating,
                            }}
                          >
                            {creating ? (
                              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
                            ) : (
                              <Icon name="share-2" size={14} color={theme.colors.onPrimary} />
                            )}
                            <Text style={styles.shareButtonText}>
                              {creating ? 'Creating…' : 'Share link'}
                            </Text>
                          </Pressable>
                        ) : (
                          <Text style={styles.localOnly}>Local only</Text>
                        )}
                      </View>
                      {!server.reachable ? (
                        <View style={styles.localHint}>
                          <Icon name="info" size={14} color={theme.colors.tone.attention} />
                          <Text style={styles.localHintText}>
                            Listens on localhost only, so the link cannot reach it. Restart it with
                            --host 0.0.0.0 to share it.
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
              <View style={styles.footer}>
                {devServerError ? <Text style={styles.error}>{devServerError}</Text> : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
                {devServers.some((server) => server.reachable && !portShare(server.port))
                  ? expirySettings
                  : null}
                {busy ? (
                  <Text style={[styles.caption, styles.centered]} accessibilityLiveRegion="polite">
                    Setting up a secure public link. This takes a few seconds.
                  </Text>
                ) : null}
              </View>
            </View>
          ) : (
            <View style={styles.content}>
              <Text style={styles.label}>FOLDER TO SHARE</Text>
              <View style={styles.browser}>
                <View style={styles.browserHeader}>
                  <Icon name="folder" size={18} color={theme.colors.textMuted} />
                  <Text style={styles.browserPath} numberOfLines={1}>
                    Worktree{path ? ` / ${path}` : ''}
                  </Text>
                  {loadedPath === path ? (
                    <Icon name="check" size={18} color={theme.colors.primary} />
                  ) : null}
                </View>
                <ScrollView
                  style={styles.explorer}
                  keyboardShouldPersistTaps="handled"
                  accessibilityLabel="Preview folder explorer"
                >
                  {path ? (
                    <SessionFolderRow
                      name=".."
                      parent
                      onPress={() => navigate(path.split('/').slice(0, -1).join('/'))}
                      accessibilityLabel="Back to parent folder"
                    />
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
                      <View
                        key={`file:${name}`}
                        style={styles.fileRow}
                        accessibilityLabel={`File ${name}`}
                      >
                        <Icon name="file-text" size={18} color={theme.colors.textMuted} />
                        <Text style={styles.fileName} numberOfLines={2}>
                          {name}
                        </Text>
                      </View>
                    ))}
                  {!loading && !folderError && directories.length === 0 && files.length === 0 ? (
                    <Text style={styles.empty}>Empty folder</Text>
                  ) : null}
                </ScrollView>
              </View>
              {loadedPath === path && !loading && !folderError ? (
                <View style={styles.entryHint}>
                  <Icon
                    name={hasIndex ? 'check-circle' : 'info'}
                    size={14}
                    color={hasIndex ? theme.colors.tone.done : theme.colors.textMuted}
                  />
                  <Text style={styles.entryHintText}>
                    {hasIndex
                      ? 'index.html opens as the start page'
                      : 'No index.html in this folder'}
                  </Text>
                </View>
              ) : null}
              <View style={styles.footer}>
                {folderError ? <Text style={styles.error}>{folderError}</Text> : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
                {expirySettings}
                <Pressable
                  onPress={() => void create()}
                  disabled={!canCreate}
                  accessibilityRole="button"
                  accessibilityLabel={busy ? 'Creating link' : 'Create link'}
                  accessibilityState={{ disabled: !canCreate, busy }}
                  style={[
                    styles.createButton,
                    !canCreate && !busy ? styles.createButtonDisabled : null,
                  ]}
                >
                  {busy ? <ActivityIndicator size="small" color={theme.colors.onPrimary} /> : null}
                  <Text style={styles.createText}>{busy ? 'Creating link…' : 'Create link'}</Text>
                </Pressable>
                {busy ? (
                  <Text style={[styles.caption, styles.centered]} accessibilityLiveRegion="polite">
                    Setting up a secure public link. This takes a few seconds.
                  </Text>
                ) : null}
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    maxHeight: '82%',
    minHeight: 0,
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
  },
  createSheet: { height: '82%' },
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
    marginBottom: theme.spacing.md,
  },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
  content: { flex: 1, minHeight: 0, gap: theme.spacing.md },
  detailsBody: { flexShrink: 1, minHeight: 0, gap: theme.spacing.md },
  detailsScroll: { flexShrink: 1 },
  explorer: { flex: 1, minHeight: 0 },
  detailsContent: { gap: theme.spacing.md, paddingBottom: theme.spacing.md },
  footer: { gap: theme.spacing.md },
  label: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
  browser: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  browserHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceAlt,
  },
  browserPath: { flex: 1, color: theme.colors.text, fontSize: theme.text.sm },
  loading: { padding: theme.spacing.md },
  empty: { color: theme.colors.textMuted, padding: theme.spacing.sm, fontSize: theme.text.sm },
  fileRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: theme.spacing.sm,
  },
  fileName: { flex: 1, color: theme.colors.textMuted, fontSize: theme.text.md },
  durations: {
    flexDirection: 'row',
    padding: 3,
    gap: 3,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  duration: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.sm + 1,
  },
  durationActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  durationText: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '600' },
  durationTextActive: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  pinLabelRow: { flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm },
  pinHint: { color: theme.colors.textFaint, fontSize: theme.text.xs },
  pinInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingLeft: theme.spacing.md,
  },
  pinInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '600',
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
  },
  pinRefresh: { padding: theme.spacing.md },
  pinBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  pinValue: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  entryHint: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs, marginTop: -4 },
  entryHintText: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    minHeight: 48,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
  },
  createButtonDisabled: { opacity: 0.45 },
  createText: { color: theme.colors.onPrimary, fontWeight: '700', fontSize: theme.text.md },
  centered: { textAlign: 'center' },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm },
  shareCard: { gap: theme.spacing.lg },
  shareCardStopping: { opacity: 0.6 },
  statusPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.tone.done },
  statusDotPending: { backgroundColor: theme.colors.tone.attention },
  statusText: {
    color: theme.colors.text,
    fontSize: theme.text.xs,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  heroText: { gap: theme.spacing.xs },
  heroTitle: { color: theme.colors.text, fontSize: theme.text.xl - 4, fontWeight: '700' },
  caption: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  linkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  link: { flex: 1, minWidth: 0, color: theme.colors.primary, fontSize: theme.text.sm },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    minHeight: 44,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  actionButtonPrimary: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  actionText: { color: theme.colors.text, fontWeight: '600', fontSize: theme.text.sm },
  actionTextPrimary: { color: theme.colors.onPrimary, fontWeight: '700', fontSize: theme.text.sm },
  facts: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  fact: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  factLabel: { width: 64, color: theme.colors.textMuted, fontSize: theme.text.sm },
  factValue: { flex: 1, color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
  stopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.tone.danger,
  },
  stopButtonBusy: { opacity: 0.8 },
  dangerText: { color: theme.colors.tone.danger, fontWeight: '700', fontSize: theme.text.md },
  stoppedCard: {
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
  },
  stoppedActions: { gap: theme.spacing.sm },
  tabs: {
    flexDirection: 'row',
    padding: 3,
    gap: 3,
    marginBottom: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  tab: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.sm + 1,
  },
  tabActive: { backgroundColor: theme.colors.surface },
  tabText: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '600' },
  tabTextActive: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 2,
    marginBottom: theme.spacing.sm,
  },
  backText: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '600' },
  serverList: { gap: theme.spacing.sm },
  emptyServers: {
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
  },
  serverRow: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  serverMain: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  serverDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.tone.done },
  serverDotLocal: { backgroundColor: theme.colors.tone.attention },
  serverText: { flex: 1, minWidth: 0, gap: 2 },
  serverName: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '700' },
  serverPort: { color: theme.colors.textMuted, fontWeight: '600' },
  serverCommand: { color: theme.colors.textFaint, fontSize: theme.text.xs },
  shareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    minHeight: 36,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  shareButtonText: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '700' },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    minHeight: 36,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  liveText: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '700' },
  localOnly: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
  localHint: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs },
  localHintText: { flex: 1, color: theme.colors.textMuted, fontSize: theme.text.xs },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: theme.radius.md,
  },
  secondaryText: { color: theme.colors.textMuted, fontWeight: '600', fontSize: theme.text.md },
}));
