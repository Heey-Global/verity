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
import type { PublicPreviewShare, VerityClient } from '@verity/mobile';

const DURATIONS = [
  { label: '15 min', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '2 hours', seconds: 7200 },
  { label: '4 hours', seconds: 14400 },
  { label: '8 hours', seconds: 28800 },
] as const;

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
  const [path, setPath] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [shares, setShares] = useState<PublicPreviewShare[]>([]);
  const [pin, setPin] = useState('');
  const [duration, setDuration] = useState(3600);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copiedId, setCopiedId] = useState<string>();
  const requestGeneration = useRef(0);

  const navigate = (nextPath: string) => {
    requestGeneration.current += 1;
    setDirectories([]);
    setLoading(true);
    setPath(nextPath);
  };

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const [nextDirectories, nextShares] = await Promise.all([
        client.listSessionStaticPreviewDirectories(sessionId, path),
        client.listPublicPreviewShares(projectId),
      ]);
      if (generation === requestGeneration.current) {
        setDirectories(nextDirectories);
        setShares(
          nextShares.filter(
            (share) => share.targetKind === 'static-folder' && share.sessionId === sessionId,
          ),
        );
        setError(undefined);
      }
    } catch (caught) {
      if (generation === requestGeneration.current) {
        setDirectories([]);
        setError(caught instanceof Error ? caught.message : 'Could not load preview folders');
      }
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [client, path, projectId, sessionId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);

  const create = async () => {
    if (!selectedPath || !/^\d{6,12}$/.test(pin) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const share = await client.createSessionStaticPreviewShare(sessionId, {
        staticPath: selectedPath,
        pin,
        ttlSeconds: duration,
      });
      requestGeneration.current += 1;
      setLoading(false);
      setShares((current) => [share, ...current]);
      setPin('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create preview link');
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
            .then(() => setShares((current) => current.filter((item) => item.id !== share.id)))
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
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView
        contentContainerStyle={{ padding: 24, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 22, fontWeight: '700' }}>Share static preview</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close preview sharing"
          >
            <Text>Close</Text>
          </Pressable>
        </View>
        <Text>
          Choose a folder from this session's worktree. Only that folder is mounted into the public
          preview connector. Give the PIN to your viewers separately; it cannot be shown again.
        </Text>
        {error ? <Text style={{ color: '#b42318' }}>{error}</Text> : null}
        {activeShares.map((share) => (
          <View key={share.id} style={{ borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 }}>
            <Text style={{ fontWeight: '700' }}>
              {share.staticPath} · {share.state}
            </Text>
            <Text>Available until {new Date(share.expiresAt).toLocaleString()}</Text>
            {share.publicOrigin ? <Text selectable>{share.publicOrigin}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 24 }}>
              {share.publicOrigin ? (
                <Pressable
                  onPress={() =>
                    void Clipboard.setStringAsync(share.publicOrigin!).then(() =>
                      setCopiedId(share.id),
                    )
                  }
                  accessibilityRole="button"
                >
                  <Text>{copiedId === share.id ? 'Copied' : 'Copy link'}</Text>
                </Pressable>
              ) : null}
              <Pressable onPress={() => stop(share)} disabled={busy} accessibilityRole="button">
                <Text>Stop</Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Text style={{ fontWeight: '700' }}>Folder</Text>
        <Text>{path || 'Session root'}</Text>
        {path ? (
          <Pressable
            onPress={() => navigate(path.split('/').slice(0, -1).join('/'))}
            accessibilityRole="button"
          >
            <Text>.. Parent folder</Text>
          </Pressable>
        ) : null}
        {loading ? (
          <ActivityIndicator />
        ) : (
          directories.map((name) => {
            const child = path ? `${path}/${name}` : name;
            return (
              <View
                key={child}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                }}
              >
                <Pressable onPress={() => navigate(child)} accessibilityRole="button">
                  <Text>📁 {name}</Text>
                </Pressable>
                <Pressable
                  onPress={() => setSelectedPath(child)}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${child}`}
                >
                  <Text>Select</Text>
                </Pressable>
              </View>
            );
          })
        )}
        {path ? (
          <Pressable onPress={() => setSelectedPath(path)} accessibilityRole="button">
            <Text>Share this folder</Text>
          </Pressable>
        ) : null}
        <Text>Selected: {selectedPath || 'Choose a folder'}</Text>
        <Text style={{ fontWeight: '700' }}>Expires after</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {DURATIONS.map((option) => (
            <Pressable
              key={option.seconds}
              onPress={() => setDuration(option.seconds)}
              accessibilityRole="radio"
              accessibilityState={{ selected: duration === option.seconds }}
            >
              <Text style={{ fontWeight: duration === option.seconds ? '700' : '400' }}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text>PIN (6–12 digits)</Text>
        <TextInput
          value={pin}
          onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 12))}
          keyboardType="number-pad"
          secureTextEntry
          accessibilityLabel="Preview PIN"
          style={{ borderWidth: 1, borderRadius: 8, padding: 12 }}
        />
        <Pressable
          onPress={() => void create()}
          disabled={!selectedPath || !/^\d{6,12}$/.test(pin) || busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !selectedPath || !/^\d{6,12}$/.test(pin) || busy }}
        >
          <Text
            style={{
              fontWeight: '700',
              opacity: !selectedPath || !/^\d{6,12}$/.test(pin) || busy ? 0.5 : 1,
            }}
          >
            {busy ? 'Creating…' : 'Create link'}
          </Text>
        </Pressable>
      </ScrollView>
    </Modal>
  );
}
