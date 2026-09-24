// Google Drive picker (ADRs 0009/0016): browse the connected account to import a
// reference file or assign one native Workspace file to the session. Reached from
// the corresponding composer attach-menu row. If no account is connected yet,
// this screen runs the native OAuth (PKCE) connect first.
import {
  VerityApiError,
  isDriveFolder,
  type VerityClient,
  type VeritySettings,
  type DriveFile,
} from '@verity/mobile';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { File as FsFile } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../../components/Icon';
import { createVerityClient } from '../../lib/client';
import { runGoogleDriveAuth } from '../../lib/googleDrive';
import { pickSessionFiles } from '../../lib/attachments';

type Crumb = { id: string; name: string };
type DriveView = 'my-drive' | 'shared';

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
  const { sessionId, purpose } = useLocalSearchParams<{
    sessionId: string;
    purpose?: 'import' | 'workspace' | 'folder' | 'project';
  }>();
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
  return <GoogleDrivePicker client={client} sessionId={sessionId} purpose={purpose ?? 'import'} />;
}

function GoogleDrivePicker({
  client,
  sessionId,
  purpose,
}: {
  client: VerityClient;
  sessionId: string;
  purpose: 'import' | 'workspace' | 'folder' | 'project';
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();

  const [settings, setSettings] = useState<VeritySettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [path, setPath] = useState<Crumb[]>([]);
  const [driveView, setDriveView] = useState<DriveView>('my-drive');
  const [sharedDriveId, setSharedDriveId] = useState<string | null>(null);
  const [sharedDriveIds, setSharedDriveIds] = useState<Set<string>>(() => new Set());
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [projectFolderId, setProjectFolderId] = useState<string | null>(null);
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
    if (purpose !== 'project') return;
    void client
      .getProject(sessionId)
      .then((detail) => {
        const id = detail.settings?.googleDriveFolderId;
        const name = detail.settings?.googleDriveFolderName;
        if (!id || !name) throw new Error('No Google Drive folder is connected to this project');
        setProjectFolderId(id);
        setPath([{ id, name }]);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load the Drive folder.'),
      );
  }, [client, purpose, sessionId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadFiles = useCallback(
    async (folderId: string | undefined, query: string, append: boolean, pageToken?: string) => {
      if (purpose === 'project' && projectFolderId === null) {
        setLoading(false);
        return;
      }
      const sequence = ++requestSequence.current;
      setLoading(true);
      setError(null);
      try {
        if (purpose === 'project') {
          if (!projectFolderId) return;
          const page = await client.listProjectGoogleDriveFiles(sessionId, projectFolderId, {
            ...(folderId ? { parentId: folderId } : {}),
            ...(pageToken ? { pageToken } : {}),
          });
          if (sequence !== requestSequence.current) return;
          setFiles((current) => (append ? [...current, ...page.files] : page.files));
          setNextPageToken(page.nextPageToken);
          return;
        }
        const sharedRoot =
          driveView === 'shared' && sharedDriveId === null && folderId === undefined;
        const page = await client.listGoogleDriveFiles({
          ...(query.length > 0 ? { query } : { parentId: folderId }),
          ...(sharedRoot && query.length === 0 ? { sharedWithMe: true } : {}),
          ...(sharedDriveId ? { driveId: sharedDriveId } : {}),
          pageToken,
          purpose,
        });
        if (sequence !== requestSequence.current) return;
        let driveFolders: DriveFile[] = [];
        if (sharedRoot && query.length === 0 && !append) {
          const drives = [];
          let drivesPageToken: string | undefined;
          do {
            const drivesPage = await client.listGoogleSharedDrives(drivesPageToken);
            drives.push(...drivesPage.drives);
            drivesPageToken = drivesPage.nextPageToken;
          } while (drivesPageToken !== undefined);
          if (sequence !== requestSequence.current) return;
          setSharedDriveIds(new Set(drives.map((drive) => `shared-drive:${drive.id}`)));
          driveFolders = drives.map((drive) => ({
            id: `shared-drive:${drive.id}`,
            name: drive.name,
            mimeType: 'application/vnd.google-apps.folder',
          }));
        }
        setFiles((current) =>
          append
            ? [
                ...current,
                ...page.files.filter(
                  (candidate) => !current.some((existing) => existing.id === candidate.id),
                ),
              ]
            : [...driveFolders, ...page.files],
        );
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
    [client, driveView, projectFolderId, purpose, sessionId, sharedDriveId],
  );

  // Reload when the folder changes or after the search input settles. Drive
  // performs the search, so results are not limited to the current loaded page.
  useEffect(() => {
    if (!connected) return;
    void loadFiles(parentId, debouncedQuery, false);
  }, [connected, debouncedQuery, driveView, loadFiles, parentId]);

  const connect = useCallback(async (): Promise<boolean> => {
    if (clientId.length === 0) {
      Alert.alert(
        'Google Drive not set up',
        'This Verity server does not provide Google Workspace sign-in. Update the server or configure GOOGLE_AUTH_ID on a custom deployment.',
      );
      return false;
    }
    setConnecting(true);
    try {
      const result = await runGoogleDriveAuth(clientId);
      if (result.kind === 'cancelled') return false;
      await client.connectGoogleDrive({
        code: result.code,
        codeVerifier: result.codeVerifier,
        redirectUri: result.redirectUri,
      });
      await loadSettings();
      return true;
    } catch (err) {
      const message =
        err instanceof VerityApiError ? err.message : 'Google sign-in failed. Please try again.';
      Alert.alert('Could not connect', message);
      return false;
    } finally {
      setConnecting(false);
    }
  }, [client, clientId, loadSettings, purpose]);

  const openFolder = useCallback(
    (folder: DriveFile) => {
      const openedFromSearch = debouncedQuery.length > 0;
      setSearchQuery('');
      setDebouncedQuery('');
      if (driveView === 'shared' && sharedDriveId === null && sharedDriveIds.has(folder.id)) {
        const driveId = folder.id.slice('shared-drive:'.length);
        setSharedDriveId(driveId);
        setPath([{ id: driveId, name: folder.name }]);
        return;
      }
      // Global search results are not necessarily children of the folder shown
      // before the search. Start a fresh path so "Up" returns to Drive root
      // instead of presenting a hierarchy that does not exist.
      setPath((current) => [
        ...(openedFromSearch ? [] : current),
        { id: folder.id, name: folder.name },
      ]);
    },
    [debouncedQuery, driveView, sharedDriveId, sharedDriveIds],
  );

  const goUp = useCallback(() => {
    setPath((current) => {
      if (purpose === 'project' && current.length <= 1) return current;
      if (driveView === 'shared' && current.length === 1) setSharedDriveId(null);
      return current.slice(0, -1);
    });
  }, [driveView, purpose]);

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
          Alert.alert('Added to project', `${file.name}\n→ Knowledge/${result.path}`, [
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

  const assignWorkspaceFile = useCallback(
    (file: DriveFile) => {
      if (importingId !== null) return;
      const nativeTypes = new Set([
        'application/vnd.google-apps.document',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.google-apps.presentation',
      ]);
      if (!nativeTypes.has(file.mimeType)) {
        Alert.alert(
          'Convert this file first',
          'Open it in Google Docs, Sheets, or Slides and save it in the matching Google format. The converted file has a new link.',
        );
        return;
      }
      if (file.canEdit === false) {
        Alert.alert('Edit access required', 'Ask the file owner to give you edit access first.');
        return;
      }
      setImportingId(file.id);
      void (async () => {
        try {
          await client.assignSessionGoogleWorkspaceFile(sessionId, file.id);
          router.back();
        } catch (err) {
          const message =
            err instanceof VerityApiError ? err.message : 'Could not assign this Workspace file.';
          if (
            err instanceof VerityApiError &&
            err.status === 403 &&
            message === 'Reconnect Google Drive to grant Workspace editing access'
          ) {
            Alert.alert(
              'Reconnect Google Drive',
              'Google needs your approval for Workspace editing access. Reconnect, then Verity will assign this file automatically.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Reconnect',
                  onPress: () => {
                    setImportingId(file.id);
                    void (async () => {
                      try {
                        if (!(await connect())) return;
                        await client.assignSessionGoogleWorkspaceFile(sessionId, file.id);
                        router.back();
                      } catch (retryError) {
                        const retryMessage =
                          retryError instanceof VerityApiError
                            ? retryError.message
                            : 'Could not assign this Workspace file.';
                        Alert.alert('Could not assign file', retryMessage);
                      } finally {
                        setImportingId(null);
                      }
                    })();
                  },
                },
              ],
            );
          } else {
            Alert.alert('Could not assign file', message);
          }
        } finally {
          setImportingId(null);
        }
      })();
    },
    [client, connect, importingId, sessionId],
  );

  const connectCurrentFolder = useCallback(() => {
    const folder = path.at(-1);
    if (folder === undefined || importingId !== null) return;
    setImportingId(folder.id);
    void client
      .connectProjectGoogleDriveFolder(sessionId, folder.id)
      .then(() => router.back())
      .catch((err: unknown) =>
        Alert.alert(
          'Could not connect folder',
          err instanceof VerityApiError ? err.message : 'Could not connect this folder.',
        ),
      )
      .finally(() => setImportingId(null));
  }, [client, importingId, path, sessionId]);

  const uploadFiles = useCallback(() => {
    if (!projectFolderId || !parentId || importingId !== null) return;
    void (async () => {
      const picked = await pickSessionFiles();
      if (picked.length === 0) return;
      setImportingId('upload');
      let uploaded = false;
      try {
        for (const file of picked) {
          await client.uploadProjectGoogleDriveFile(sessionId, projectFolderId, {
            parentId,
            fileName: file.fileName,
            mimeType: 'application/octet-stream',
            data: new FsFile(file.uri),
          });
          uploaded = true;
        }
      } catch (caught) {
        Alert.alert(
          'Could not upload file',
          caught instanceof Error ? caught.message : String(caught),
        );
      } finally {
        for (const file of picked) {
          try {
            new FsFile(file.uri).delete();
          } catch {
            // The OS may already have removed the picker cache copy.
          }
        }
        setImportingId(null);
        if (uploaded) await loadFiles(parentId, '', false);
      }
    })().catch((caught: unknown) =>
      Alert.alert(
        'Could not pick files',
        caught instanceof Error ? caught.message : String(caught),
      ),
    );
  }, [client, importingId, loadFiles, parentId, projectFolderId, sessionId]);

  const useProjectFile = useCallback(
    (file: DriveFile) => {
      if (!projectFolderId) return;
      Alert.alert(file.name, 'This file stays in Google Drive.', [
        { text: 'Cancel', style: 'cancel' },
        ...(file.webViewLink
          ? [
              {
                text: 'Open in Google Drive',
                onPress: () => void Linking.openURL(file.webViewLink!),
              },
            ]
          : []),
        {
          text: 'Add to Project Knowledge',
          onPress: () => {
            setImportingId(file.id);
            void client
              .importProjectGoogleDriveFile(sessionId, projectFolderId, file.id)
              .then((result) => Alert.alert('Added to Project Knowledge', result.path))
              .catch((caught: unknown) =>
                Alert.alert(
                  'Could not add file',
                  caught instanceof Error ? caught.message : String(caught),
                ),
              )
              .finally(() => setImportingId(null));
          },
        },
      ]);
    },
    [client, projectFolderId, sessionId],
  );

  const onPressItem = useCallback(
    (file: DriveFile) => {
      if (isDriveFolder(file)) openFolder(file);
      else if (purpose === 'project') useProjectFile(file);
      else if (purpose === 'workspace') assignWorkspaceFile(file);
      else importFile(file);
    },
    [assignWorkspaceFile, importFile, openFolder, purpose, useProjectFile],
  );

  const rootTitle =
    purpose === 'workspace'
      ? 'Choose Workspace file'
      : purpose === 'folder'
        ? 'Choose Drive folder'
        : purpose === 'project'
          ? 'Google Drive'
          : 'Google Drive';
  const title = path.length > 0 ? (path[path.length - 1]?.name ?? rootTitle) : rootTitle;

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <Stack.Screen
        options={{
          title,
          // Disconnecting the account belongs here in the Drive flow, not in
          // Settings (the client id is server-configured, never user-set).
          headerRight:
            connected && purpose === 'project'
              ? () => (
                  <Pressable
                    onPress={uploadFiles}
                    disabled={importingId !== null || !parentId}
                    accessibilityRole="button"
                    accessibilityLabel="Upload files to Google Drive"
                    hitSlop={8}
                  >
                    <Text style={styles.headerAction}>Upload</Text>
                  </Pressable>
                )
              : connected
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
            Google grants Verity access to files in this account. Projects can use only the folder
            you connect in their settings. You can disconnect at any time.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
            onPress={() => void connect()}
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
          {purpose === 'folder' && path.length > 0 ? (
            <Pressable
              style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
              onPress={connectCurrentFolder}
              disabled={importingId !== null}
              accessibilityRole="button"
              accessibilityLabel={`Connect ${path.at(-1)?.name ?? 'this folder'}`}
            >
              <Text style={styles.primaryButtonLabel}>Connect this folder</Text>
            </Pressable>
          ) : null}
          {purpose !== 'project' ? (
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
          ) : null}

          {purpose !== 'project' && path.length === 0 && debouncedQuery.length === 0 ? (
            <View style={styles.driveViewTabs}>
              {(
                [
                  ['my-drive', 'My Drive'],
                  ['shared', 'Shared'],
                ] as const
              ).map(([view, label]) => {
                const selected = driveView === view;
                return (
                  <Pressable
                    key={view}
                    style={[styles.driveViewTab, selected ? styles.driveViewTabSelected : null]}
                    onPress={() => {
                      setSharedDriveId(null);
                      setDriveView(view);
                    }}
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

          {path.length > (purpose === 'project' ? 1 : 0) && debouncedQuery.length === 0 ? (
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
              const isSharedDrive =
                driveView === 'shared' && sharedDriveId === null && sharedDriveIds.has(item.id);
              return (
                <Pressable
                  style={({ pressed }) => [styles.itemRow, pressed ? styles.itemPressed : null]}
                  onPress={() => onPressItem(item)}
                  disabled={importingId !== null}
                  accessibilityRole="button"
                  accessibilityLabel={
                    isSharedDrive
                      ? `Open shared drive ${item.name}`
                      : isDriveFolder(item)
                        ? `Open folder ${item.name}`
                        : purpose === 'workspace'
                          ? `Assign ${item.name}`
                          : `Import ${item.name}`
                  }
                >
                  <Icon name={iconForFile(item)} size={22} color={theme.colors.textMuted} />
                  <View style={styles.itemText}>
                    <Text style={styles.itemLabel} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {isSharedDrive ? <Text style={styles.itemMeta}>Shared drive</Text> : null}
                  </View>
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
                    onPress={() => void loadFiles(parentId, debouncedQuery, true, nextPageToken)}
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
  itemText: { flex: 1, gap: 2 },
  itemLabel: { color: theme.colors.text, fontSize: theme.text.md },
  itemMeta: { color: theme.colors.textMuted, fontSize: theme.text.xs },
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
