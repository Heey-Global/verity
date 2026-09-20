import * as DocumentPicker from 'expo-document-picker';
import type { KnowledgeDocument, KnowledgeSource, VerityClient } from '@verity/mobile';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { KnowledgeButton as Button } from './KnowledgeButton';
import { styles } from './styles';

export function KnowledgeOriginal({
  client,
  document,
  onReplaced,
  onOriginal,
}: {
  client: VerityClient;
  document: KnowledgeDocument;
  onReplaced: (document: KnowledgeDocument) => Promise<void>;
  onOriginal: (exists: boolean | null) => void;
}) {
  const [source, setSource] = useState<KnowledgeSource | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const selection = useRef({ id: document.id, revisionId: document.currentRevisionId });
  const replacementGeneration = useRef(0);
  selection.current = { id: document.id, revisionId: document.currentRevisionId };
  useEffect(
    () => () => {
      replacementGeneration.current += 1;
    },
    [],
  );
  useEffect(() => {
    let active = true;
    setSource(null);
    setError('');
    setBusy(false);
    if (typeof client.getKnowledgeSource !== 'function') {
      onOriginal(false);
      return;
    }
    onOriginal(null);
    void client
      .getKnowledgeSource(document.id, document.currentRevisionId)
      .then((next) => {
        if (active) {
          setSource(next);
          onOriginal(next !== null);
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
    };
  }, [client, document.id, document.currentRevisionId, lookupAttempt, onOriginal]);
  return (
    <View style={styles.group}>
      {error ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          {!source ? (
            <Button
              icon="refresh-cw"
              label="Retry original lookup"
              disabled={busy}
              onPress={() => setLookupAttempt((attempt) => attempt + 1)}
            />
          ) : null}
        </>
      ) : null}
      {source ? (
        <>
          <Text style={styles.muted}>
            {source.filename} · {source.processingState} · {Math.ceil(source.size / 1024)} KiB
          </Text>
          {source.processingNote ? <Text style={styles.muted}>{source.processingNote}</Text> : null}
          {source.previews
            .filter((preview) =>
              ['image/png', 'image/jpeg', 'image/webp'].includes(preview.mediaType),
            )
            .map((preview, index) => (
              <Image
                key={index}
                accessibilityLabel={preview.label}
                source={{ uri: `data:${preview.mediaType};base64,${preview.base64}` }}
                resizeMode="contain"
                style={{ width: '100%', height: 240 }}
              />
            ))}
          <Button
            icon="upload"
            label="Replace original file"
            disabled={busy}
            onPress={() => {
              const startedFor = selection.current;
              const generation = ++replacementGeneration.current;
              const stillSelected = () =>
                replacementGeneration.current === generation &&
                selection.current.id === startedFor.id &&
                selection.current.revisionId === startedFor.revisionId;
              setBusy(true);
              setError('');
              void (async () => {
                try {
                  const picked = await DocumentPicker.getDocumentAsync({
                    multiple: false,
                    copyToCacheDirectory: true,
                    type: '*/*',
                  });
                  if (picked.canceled) return;
                  const asset = picked.assets[0];
                  if (!asset) return;
                  const file = new File(asset.uri);
                  try {
                    if ((asset.size ?? 0) > 10 * 1024 * 1024)
                      throw new Error('Each original is limited to 10 MiB');
                    const next = await client.replaceKnowledgeSource(document.id, {
                      expectedRevisionId: document.currentRevisionId,
                      filename: asset.name,
                      base64: await file.base64(),
                    });
                    if (stillSelected()) await onReplaced(next);
                  } finally {
                    try {
                      file.delete();
                    } catch {
                      /* Preserve upload outcome. */
                    }
                  }
                } catch (failure) {
                  if (stillSelected()) setError(String(failure));
                } finally {
                  if (stillSelected()) setBusy(false);
                }
              })();
            }}
          />
          {source.processingState === 'failed' ? (
            <Text style={styles.muted}>
              Replace the file to retry processing; previous versions stay available.
            </Text>
          ) : null}
          <Button
            icon="download"
            label="Open original file"
            disabled={busy}
            onPress={() => {
              setBusy(true);
              setError('');
              void (async () => {
                const filename = source.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
                const file = new File(Paths.cache, `knowledge-${document.id}-${filename}`);
                try {
                  const bytes = await client.downloadKnowledgeOriginal(
                    document.id,
                    source.revisionId,
                  );
                  file.create({ overwrite: true });
                  file.write(new Uint8Array(bytes));
                  await Sharing.shareAsync(file.uri, {
                    mimeType: source.mediaType,
                    dialogTitle: source.filename,
                  });
                } catch (failure) {
                  setError(String(failure));
                } finally {
                  if (file.exists) file.delete();
                  setBusy(false);
                }
              })();
            }}
          />
        </>
      ) : null}
    </View>
  );
}
