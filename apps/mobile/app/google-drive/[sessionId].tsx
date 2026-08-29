// Google Drive picker (ADR 0009): browse the connected account's Drive, tap a
// file to import it into the session worktree under docs/reference/. Reached from
// the composer attach menu's "Google Drive" row. If no account is connected yet,
// this screen runs the native OAuth (PKCE) connect first.
import {
  VerityApiError,
  isDriveFolder,
  type VerityClient,
  type VeritySettings,
  type DriveFile,
} from '@verity/mobile';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../../components/Icon';
import { createVerityClient } from '../../lib/client';
import { runGoogleDriveAuth } from '../../lib/googleDrive';

type Crumb = { id: string; name: string };
type DriveView = 'my-drive' | 'shared-with-me';

// A Feather glyph per Drive item: folders, native Google editor types, and a
// generic file fall-back — enough to scan a listing at a glance.
function iconForFile(file: DriveFile): IconName {
  if (isDriveFolder(file)) return 'folder';
  if (file.mimeType === 'application/vnd.google-apps.document') return 'file-text';
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') return 'grid';
  if (file.mimeType === 'application/vnd.google-apps.presentation') return 'monitor';
  return 'file';
}

export default function GoogleDrivePickerScreen() {
  const { theme } = useUnistyles();
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Stack.Screen options={{ title: 'Google Drive' }} />
        <Icon name="cloud" size={40} color={theme.colors.textMuted} />
        <Text style={styles.emptyTitle}>Not connected</Text>
        <Text style={styles.emptyBody}>
          Configure your Verity server address in setup before importing from Google Drive.
        </Text>
      </View>
    );
  }
  return <GoogleDrivePicker client={client} sessionId={sessionId} />;
}

function GoogleDrivePicker({ client, sessionId }: { client: VerityClient; sessionId: string }) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();

  const [settings, setSettings] = useState<VeritySettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [path, setPath] = useState<Crumb[]>([]);
  const [driveView, setDriveView] = useState<DriveView>('my-drive');
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const requestSequence = useRef(0);

  const connected = settings?.googleDriveConnected === true;
  const clientId = settings?.googleDriveClientId ?? '';
  const parentId = path.length > 0 ? path[path.length - 1]?.id : undefined;

  const loadSettings = useCallback(async () => {
    try {
      const next = await client.getVeritySettings();
      setSettings(next);
    } catch {
      setSettings(null);
    } finally {
      setSettingsLoaded(true);
    }
  }, [client]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadFiles = useCallback(
    async (
      folderId: string | undefined,
      query: string,
      sharedWithMe: boolean,
      append: boolean,
      pageToken?: string,
    ) => {
      const sequence = ++requestSequence.current;
      setLoading(true);
      setError(null);
      try {
        const page = await client.listGoogleDriveFiles({
          ...(query.length > 0 ? { query } : { parentId: folderId }),
          ...(sharedWithMe && query.length === 0 && folderId === undefined
            ? { sharedWithMe: true }
            : {}),
          pageToken,
        });
        if (sequence !== requestSequence.current) return;
        setFiles((current) => (append ? [...current, ...page.files] : page.files));
        setNextPageToken(page.nextPageToken);
      } catch (err) {
        if (sequence !== requestSequence.current) return;
        const message =
          err instanceof VerityApiError ? err.message : 'Could not load Google Drive.';
        setError(message);
        if (!append) setFiles([]);
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [client],
  );

  // Reload when the folder changes or after the search input settles. Drive
  // performs the search, so results are not limited to the current loaded page.
  useEffect(() => {
    if (!connected) return;
    void loadFiles(parentId, debouncedQuery, driveView === 'shared-with-me', false);
  }, [connected, debouncedQuery, driveView, loadFiles, parentId]);

  const connect = useCallback(() => {
    if (clientId.length === 0) {
      Alert.alert(
        'Google Drive not set up',
        'Add your Google Drive client id in Settings → Connected services first.',
      );
      return;
    }
    setConnecting(true);
    void (async () => {
      try {
        const result = await runGoogleDriveAuth(clientId);
        if (result.kind === 'cancelled') return;
        await client.connectGoogleDrive({
          code: result.code,
          codeVerifier: result.codeVerifier,
          redirectUri: result.redirectUri,
        });
        await loadSettings();
      } catch (err) {
        const message =
          err instanceof VerityApiError ? err.message : 'Google sign-in failed. Please try again.';
        Alert.alert('Could not connect', message);
      } finally {
        setConnecting(false);
      }
    })();
  }, [client, clientId, loadSettings]);

  const openFolder = useCallback(
    (folder: DriveFile) => {
      const openedFromSearch = debouncedQuery.length > 0;
      setSearchQuery('');
      setDebouncedQuery('');
      // Global search results are not necessarily children of the folder shown
      // before the search. Start a fresh path so "Up" returns to Drive root
      // instead of presenting a hierarchy that does not exist.
      setPath((current) => [
        ...(openedFromSearch ? [] : current),
        { id: folder.id, name: folder.name },
      ]);
    },
    [debouncedQuery],
  );

  const goUp = useCallback(() => {
    setPath((current) => current.slice(0, -1));
  }, []);

  const disconnect = useCallback(() => {
    void (async () => {
      try {
        await client.disconnectGoogleDrive();
        setPath([]);
        setFiles([]);
        await loadSettings();
      } catch (err) {
        const message =
          err instanceof VerityApiError ? err.message : 'Could not disconnect Google Drive.';
        Alert.alert('Could not disconnect', message);
      }
    })();
  }, [client, loadSettings]);

  const importFile = useCallback(
    (file: DriveFile) => {
      if (importingId !== null) return;
      setImportingId(file.id);
      void (async () => {
        try {
          const result = await client.importGoogleDriveFile(sessionId, file.id);
          Alert.alert('Added to project', `${file.name}\n→ ${result.path}`, [
            { text: 'Done', onPress: () => router.back() },
            { text: 'Add another' },
          ]);
        } catch (err) {
          const message =
            err instanceof VerityApiError ? err.message : 'Could not import this file.';
          Alert.alert('Import failed', message);
        } finally {
          setImportingId(null);
        }
      })();
    },
    [client, importingId, sessionId],
  );

  const onPressItem = useCallback(
    (file: DriveFile) => {
      if (isDriveFolder(file)) openFolder(file);
      else importFile(file);
    },
    [openFolder, importFile],
  );

  const title = path.length > 0 ? (path[path.length - 1]?.name ?? 'Google Drive') : 'Google Drive';

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <Stack.Screen
        options={{
          title,
          // Disconnecting the account belongs here in the Drive flow, not in
          // Settings (the client id is server-configured, never user-set).
          headerRight: connected
            ? () => (
                <Pressable
                  onPress={disconnect}
                  accessibilityRole="button"
                  accessibilityLabel="Disconnect Google Drive"
                  hitSlop={8}
                >
                  <Text style={styles.headerAction}>Disconnect</Text>
                </Pressable>
              )
            : undefined,
        }}
      />

      {!settingsLoaded ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : !connected ? (
        <View style={styles.centered}>
          <Icon name="cloud" size={40} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>Connect Google Drive</Text>
          <Text style={styles.emptyBody}>
            Sign in once to browse your Drive and pull documents into this project. You can
            reconnect any time if the connection expires.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
            onPress={connect}
            disabled={connecting}
            accessibilityRole="button"
            accessibilityLabel="Connect Google Drive"
          >
            {connecting ? (
              <ActivityIndicator color={theme.colors.onPrimary} />
            ) : (
              <Text style={styles.primaryButtonLabel}>Connect Google Drive</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.searchContainer}>
            <Icon name="search" size={18} color={theme.colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search Google Drive"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search Google Drive"
            />
            {searchQuery.length > 0 ? (
              <Pressable
                onPress={() => {
                  setSearchQuery('');
                  setDebouncedQuery('');
                }}
                accessibilityRole="button"
                accessibilityLabel="Clear Google Drive search"
                hitSlop={8}
              >
                <Icon name="x" size={18} color={theme.colors.textMuted} />
              </Pressable>
            ) : null}
          </View>

          {path.length === 0 && debouncedQuery.length === 0 ? (
            <View style={styles.driveViewTabs}>
              {(
                [
                  ['my-drive', 'My Drive'],
                  ['shared-with-me', 'Shared with me'],
                ] as const
              ).map(([view, label]) => {
                const selected = driveView === view;
                return (
                  <Pressable
                    key={view}
                    style={[styles.driveViewTab, selected ? styles.driveViewTabSelected : null]}
                    onPress={() => setDriveView(view)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                  >
                    <Text
                      style={[
                        styles.driveViewTabLabel,
                        selected ? styles.driveViewTabLabelSelected : null,
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {path.length > 0 && debouncedQuery.length === 0 ? (
            <Pressable
              style={({ pressed }) => [styles.upRow, pressed ? styles.itemPressed : null]}
              onPress={goUp}
              accessibilityRole="button"
              accessibilityLabel="Back to parent folder"
            >
              <Icon name="corner-left-up" size={20} color={theme.colors.textMuted} />
              <Text style={styles.upLabel}>Up</Text>
            </Pressable>
          ) : null}

          <FlatList
            data={files}
            keyExtractor={(item) => item.id}
            contentContainerStyle={files.length === 0 ? styles.listEmpty : styles.listContent}
            renderItem={({ item }) => {
              const isImporting = importingId === item.id;
              return (
                <Pressable
                  style={({ pressed }) => [styles.itemRow, pressed ? styles.itemPressed : null]}
                  onPress={() => onPressItem(item)}
                  disabled={importingId !== null}
                  accessibilityRole="button"
                  accessibilityLabel={
                    isDriveFolder(item) ? `Open folder ${item.name}` : `Import ${item.name}`
                  }
                >
                  <Icon name={iconForFile(item)} size={22} color={theme.colors.textMuted} />
                  <Text style={styles.itemLabel} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {isImporting ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : isDriveFolder(item) ? (
                    <Icon name="chevron-right" size={20} color={theme.colors.textFaint} />
                  ) : (
                    <Icon name="download" size={18} color={theme.colors.textFaint} />
                  )}
                </Pressable>
              );
            }}
            ListEmptyComponent={
              loading ? null : (
                <Text style={styles.emptyBody}>
                  {debouncedQuery.length > 0
                    ? `No files found for “${debouncedQuery}”.`
                    : 'This folder is empty.'}
                </Text>
              )
            }
            ListFooterComponent={
              <View style={styles.footer}>
                {loading ? <ActivityIndicator color={theme.colors.primary} /> : null}
                {error !== null ? (
                  <Text style={styles.error} accessibilityRole="alert">
                    {error}
                  </Text>
                ) : null}
                {!loading && nextPageToken !== undefined ? (
                  <Pressable
                    onPress={() =>
                      void loadFiles(
                        parentId,
                        debouncedQuery,
                        driveView === 'shared-with-me',
                        true,
                        nextPageToken,
                      )
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Load more"
                  >
                    <Text style={styles.linkText}>Load more</Text>
                  </Pressable>
                ) : null}
              </View>
            }
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
  },
  emptyTitle: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '800' },
  emptyBody: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    textAlign: 'center',
    padding: theme.spacing.lg,
  },
  primaryButton: {
    minHeight: 48,
    minWidth: 220,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.lg,
  },
  primaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  pressed: { opacity: 0.78 },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginHorizontal: theme.spacing.lg,
    marginVertical: theme.spacing.sm,
    minHeight: 42,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: theme.spacing.md,
  },
  searchInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.md,
    paddingVertical: theme.spacing.sm,
  },
  driveViewTabs: {
    flexDirection: 'row',
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 3,
  },
  driveViewTab: {
    flex: 1,
    alignItems: 'center',
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  driveViewTabSelected: { backgroundColor: theme.colors.surface },
  driveViewTabLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  driveViewTabLabelSelected: { color: theme.colors.text },
  listContent: { paddingVertical: theme.spacing.xs },
  listEmpty: { flexGrow: 1 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 52,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  itemPressed: { backgroundColor: theme.colors.surfaceAlt },
  itemLabel: { flex: 1, color: theme.colors.text, fontSize: theme.text.md },
  upRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  upLabel: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '700' },
  footer: { padding: theme.spacing.lg, gap: theme.spacing.sm, alignItems: 'center' },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    textAlign: 'center',
  },
  linkText: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '700' },
  headerAction: { color: theme.colors.tone.danger, fontSize: theme.text.sm, fontWeight: '700' },
}));
