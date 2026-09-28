import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PublicPreviewShare, VerityClient } from '@verity/mobile';
import { Icon } from '../Icon';
import { SessionFolderRow } from '../SessionFolderRow';

const DURATIONS = [
  { label: '15 min', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '2 hours', seconds: 7200 },
  { label: '4 hours', seconds: 14400 },
  { label: '8 hours', seconds: 28800 },
] as const;

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
  const [shares, setShares] = useState<PublicPreviewShare[]>([]);
  const [pin, setPin] = useState('');
  const [duration, setDuration] = useState(3600);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [folderError, setFolderError] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();
  const requestGeneration = useRef(0);
  const createdShareIds = useRef(new Set<string>());
  const stoppedShareIds = useRef(new Set<string>());

  const navigate = (nextPath: string) => {
    requestGeneration.current += 1;
    setDirectories([]);
    setLoadedPath(null);
    setLoading(true);
    setFolderError(undefined);
    setPath(nextPath);
  };

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const nextDirectories = await client.listSessionStaticPreviewDirectories(sessionId, path);
      if (generation === requestGeneration.current) {
        setDirectories(nextDirectories);
        setLoadedPath(path);
        setFolderError(undefined);
      }
    } catch (caught) {
      if (generation === requestGeneration.current) {
        setDirectories([]);
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
                share.targetKind === 'static-folder' &&
                share.sessionId === sessionId &&
                !stoppedShareIds.current.has(share.id) &&
                !createdShareIds.current.has(share.id),
            );
            return [...local, ...remote];
          });
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(previewError(caught));
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

  const create = async () => {
    if (!path || loadedPath !== path || !/^\d{6,12}$/.test(pin) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const share = await client.createSessionStaticPreviewShare(sessionId, {
        staticPath: path,
        pin,
        ttlSeconds: duration,
      });
      createdShareIds.current.add(share.id);
      setShares((current) => [share, ...current]);
      setPin('');
    } catch (caught) {
      setError(previewError(caught));
    } finally {
      setBusy(false);
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
          void client
            .stopPublicPreviewShare(share.id)
            .then(() => {
              stoppedShareIds.current.add(share.id);
              createdShareIds.current.delete(share.id);
              setShares((current) => current.filter((item) => item.id !== share.id));
            })
            .catch((caught: unknown) =>
              setError(caught instanceof Error ? caught.message : 'Could not stop preview'),
            )
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  const activeShares = shares.filter((share) =>
    ['creating', 'active', 'revoking'].includes(share.state),
  );
  const canCreate = Boolean(path && loadedPath === path && /^\d{6,12}$/.test(pin) && !busy);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + theme.spacing.md }]}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={styles.title}>Preview</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close preview sharing"
            hitSlop={12}
          >
            <Icon name="x" size={20} color={theme.colors.textMuted} />
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {activeShares.map((share) => (
            <View key={share.id} style={styles.shareCard}>
              <Text style={styles.folderName}>{share.staticPath}</Text>
              <Text style={styles.caption}>
                Available until {new Date(share.expiresAt).toLocaleString()}
              </Text>
              {share.publicOrigin ? (
                <Text selectable style={styles.link}>
                  {share.publicOrigin}
                </Text>
              ) : null}
              <View style={styles.actions}>
                {share.publicOrigin ? (
                  <Pressable
                    onPress={() =>
                      void Clipboard.setStringAsync(share.publicOrigin!).then(() =>
                        setCopiedId(share.id),
                      )
                    }
                    accessibilityRole="button"
                  >
                    <Text style={styles.actionText}>
                      {copiedId === share.id ? 'Copied' : 'Copy link'}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={() => stop(share)} disabled={busy} accessibilityRole="button">
                  <Text style={styles.dangerText}>Stop sharing</Text>
                </Pressable>
              </View>
            </View>
          ))}
          <Text style={styles.label}>FOLDER</Text>
          <View style={styles.browser}>
            <View style={styles.browserHeader}>
              <Icon name="folder" size={18} color={theme.colors.textMuted} />
              <Text style={styles.browserPath} numberOfLines={1}>
                Worktree{path ? ` / ${path}` : ''}
              </Text>
              {path && loadedPath === path ? (
                <Icon name="check" size={18} color={theme.colors.primary} />
              ) : null}
            </View>
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
            {!loading && !folderError && directories.length === 0 ? (
              <Text style={styles.empty}>No subfolders</Text>
            ) : null}
          </View>
          {folderError ? <Text style={styles.error}>{folderError}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.label}>EXPIRES AFTER</Text>
          <View style={styles.durations}>
            {DURATIONS.map((option) => (
              <Pressable
                key={option.seconds}
                onPress={() => setDuration(option.seconds)}
                accessibilityRole="radio"
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
          <Text style={styles.label}>PIN · 6–12 DIGITS</Text>
          <TextInput
            value={pin}
            onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 12))}
            keyboardType="number-pad"
            secureTextEntry
            accessibilityLabel="Preview PIN"
            style={styles.input}
            placeholder="Enter PIN"
            placeholderTextColor={theme.colors.textFaint}
          />
          <Pressable
            onPress={() => void create()}
            disabled={!canCreate}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canCreate }}
            style={[styles.createButton, !canCreate ? styles.createButtonDisabled : null]}
          >
            <Text style={styles.createText}>{busy ? 'Creating…' : 'Create link'}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    maxHeight: '82%',
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
    marginBottom: theme.spacing.md,
  },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '700' },
  content: { gap: theme.spacing.md, paddingBottom: theme.spacing.md },
  label: { color: theme.colors.textMuted, fontSize: theme.text.xs, fontWeight: '600' },
  browser: {
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
  folderName: { flex: 1, color: theme.colors.text, fontSize: theme.text.md },
  loading: { padding: theme.spacing.md },
  empty: { color: theme.colors.textMuted, padding: theme.spacing.sm, fontSize: theme.text.sm },
  durations: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs },
  duration: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  durationActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  durationText: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  durationTextActive: {
    color: theme.colors.background,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  input: {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
  },
  createButton: {
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
  },
  createButtonDisabled: { opacity: 0.45 },
  createText: { color: theme.colors.background, fontWeight: '700', fontSize: theme.text.md },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm },
  shareCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  caption: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  link: { color: theme.colors.primary, fontSize: theme.text.sm },
  actions: { flexDirection: 'row', gap: theme.spacing.lg },
  actionText: { color: theme.colors.primary, fontWeight: '600' },
  dangerText: { color: theme.colors.tone.danger, fontWeight: '600' },
}));
