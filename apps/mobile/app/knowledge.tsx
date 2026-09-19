import type {
  KnowledgeDocument,
  KnowledgeFolder,
  KnowledgeRevision,
  VerityClient,
} from '@verity/mobile';
import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, Text, TextInput, View } from 'react-native';
import { createVerityClient } from '../lib/client';
import { KnowledgeButton as Button } from '../components/knowledge/KnowledgeButton';
import { KnowledgeMarkdown } from '../components/knowledge/KnowledgeMarkdown';
import { styles } from '../components/knowledge/styles';

export default function KnowledgeScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const params = useLocalSearchParams<{ folderId?: string }>();
  return client ? (
    <Library client={client} initialFolder={params.folderId ?? null} />
  ) : (
    <Text style={styles.text}>Connect to your server to open Knowledge.</Text>
  );
}

export function Library({
  client,
  initialFolder,
}: {
  client: VerityClient;
  initialFolder: string | null;
}) {
  const navigation = useNavigation();
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [folderId, setFolderId] = useState(initialFolder);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [revisions, setRevisions] = useState<KnowledgeRevision[] | null>(null);
  const [revision, setRevision] = useState<KnowledgeRevision | null>(null);
  const [hasMoreRevisions, setHasMoreRevisions] = useState(false);
  const [query, setQuery] = useState('');
  const [folderName, setFolderName] = useState('');
  const [moving, setMoving] = useState(false);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const leaving = useRef(false);
  const dirty =
    editing && (creating || title !== document?.title || body !== document?.bodyMarkdown);
  const confirm = useCallback(
    (message: string, action: () => void) =>
      Alert.alert('Knowledge', message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: action },
      ]),
    [],
  );
  const leave = (action: () => void) => {
    if (lock.current) return;
    if (dirty) confirm('Discard unsaved changes?', action);
    else action();
  };
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (event) => {
        if (lock.current) {
          event.preventDefault();
          return;
        }
        if (!dirty || leaving.current) return;
        event.preventDefault();
        confirm('Discard unsaved changes?', () => {
          leaving.current = true;
          navigation.dispatch(event.data.action);
        });
      }),
    [navigation, dirty, confirm],
  );
  const refresh = useCallback(async () => {
    const [nextFolders, nextDocuments] = await Promise.all([
      client.listKnowledgeFolders(),
      client.listKnowledgeDocuments(folderId ?? undefined, query || undefined),
    ]);
    setFolders(nextFolders);
    setDocuments(nextDocuments);
    setHasMore(nextDocuments.length === 100);
  }, [client, folderId, query]);
  useEffect(() => {
    let active = true;
    void Promise.all([
      client.listKnowledgeFolders(),
      client.listKnowledgeDocuments(folderId ?? undefined, query || undefined),
    ])
      .then(([nextFolders, nextDocuments]) => {
        if (active) {
          setFolders(nextFolders);
          setDocuments(nextDocuments);
          setHasMore(nextDocuments.length === 100);
        }
      })
      .catch((e: unknown) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [client, folderId, query]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(
        `${String(e)}. If this is a revision conflict, keep your draft and reopen the latest document before reconciling.`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const showFolder = (id: string | null) => {
    setFolderId(id);
    setDocument(null);
    setEditing(false);
    setCreating(false);
    setQuery('');
    setRevisions(null);
    setRevision(null);
    setMoving(false);
    setTransfer(null);
  };
  const openFolder = (id: string | null) => leave(() => showFolder(id));
  const openDocument = (id: string) =>
    leave(() => {
      void run(async () => {
        const next = await client.getKnowledgeDocument(id);
        setDocument(next);
        setFolderId(next.folderId);
        setEditing(false);
        setCreating(false);
        setRevisions(null);
        setRevision(null);
      });
    });
  const openLinkedDocument = (url: string) => {
    leave(() => {
      void run(async () => {
        if (!document || /^[a-z][a-z0-9+.-]*:/i.test(url)) return;
        const rawPath = decodeURIComponent(url.split('#')[0] ?? '');
        if (!rawPath) return;
        let targetFolder: string | null = rawPath.startsWith('/') ? null : document.folderId;
        const segments = rawPath.split('/').filter(Boolean);
        const name = segments.pop();
        if (!name) return;
        for (const segment of segments) {
          if (segment === '.') continue;
          if (segment === '..') {
            targetFolder = folders.find((f) => f.id === targetFolder)?.parentId ?? null;
          } else {
            const next = folders.find((f) => f.parentId === targetFolder && f.name === segment);
            if (!next) throw new Error('Linked folder not found');
            targetFolder = next.id;
          }
        }
        if (!targetFolder) throw new Error('Linked document must belong to a folder');
        const candidates = await client.listKnowledgeDocuments(
          targetFolder,
          name.replace(/\.md$/, ''),
        );
        const target = candidates.find((d) => d.title === name || `${d.title}.md` === name);
        if (!target) throw new Error('Linked document not found');
        setDocument(await client.getKnowledgeDocument(target.id));
        setFolderId(targetFolder);
        setEditing(false);
        setCreating(false);
        setPreview(false);
        setRevisions(null);
        setRevision(null);
      });
    });
  };
  const currentFolder = folders.find((f) => f.id === folderId);
  const path: KnowledgeFolder[] = [];
  let ancestor = currentFolder;
  const seen = new Set<string>();
  while (ancestor && !seen.has(ancestor.id)) {
    seen.add(ancestor.id);
    path.unshift(ancestor);
    ancestor = folders.find((f) => f.id === ancestor?.parentId);
  }
  const startEdit = () => {
    setRevisions(null);
    setRevision(null);
    setMoving(false);
    setTitle(document?.title ?? '');
    setBody(document?.bodyMarkdown ?? '');
    setEditing(true);
    setPreview(false);
  };
  const save = () => {
    void run(async () => {
      const next =
        creating && folderId
          ? await client.createKnowledgeDocument({ folderId, title, bodyMarkdown: body })
          : document
            ? await client.saveKnowledgeDocument(document.id, {
                title,
                bodyMarkdown: body,
                expectedRevisionId: document.currentRevisionId,
              })
            : null;
      if (next) {
        setDocument(next);
        setEditing(false);
        setCreating(false);
        await refresh();
      }
    });
  };
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Knowledge', gestureEnabled: !dirty && !busy }} />
      <Text style={styles.muted}>
        Your knowledge library. Project grants control agent access; you can manage all folders
        here.
      </Text>
      <View style={styles.row}>
        <Button label="Knowledge root" onPress={() => openFolder(null)} />
        {path.map((f) => (
          <Button key={f.id} label={f.name} onPress={() => openFolder(f.id)} />
        ))}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {busy ? <Text style={styles.muted}>Working…</Text> : null}
      {document || creating ? (
        <View style={styles.group}>
          {editing ? (
            <>
              <TextInput
                accessibilityLabel="Document title"
                style={styles.input}
                value={title}
                onChangeText={setTitle}
                editable={!busy}
              />
              <TextInput
                accessibilityLabel="Markdown source"
                multiline
                style={[styles.input, styles.editor]}
                value={body}
                onChangeText={setBody}
                editable={!busy}
              />
              <View style={styles.row}>
                <Button label="Save" disabled={busy || !title.trim()} onPress={save} />
                <Button
                  label="Cancel editing"
                  disabled={busy}
                  onPress={() =>
                    leave(() => {
                      setEditing(false);
                      setCreating(false);
                    })
                  }
                />
                <Button
                  label={preview ? 'Hide preview' : 'Preview'}
                  onPress={() => setPreview(!preview)}
                />
              </View>
              {preview ? <KnowledgeMarkdown body={body} onLink={openLinkedDocument} /> : null}
            </>
          ) : (
            <>
              <Text style={styles.heading}>{document?.title}</Text>
              <KnowledgeMarkdown body={document?.bodyMarkdown ?? ''} onLink={openLinkedDocument} />
              <View style={styles.row}>
                <Button label="Edit" disabled={busy} onPress={startEdit} />
                <Button
                  label="Revision history"
                  disabled={busy}
                  onPress={() => {
                    void run(async () => {
                      if (document) {
                        const next = await client.listKnowledgeRevisions(document.id);
                        setRevisions(next);
                        setHasMoreRevisions(next.length === 100);
                      }
                    });
                  }}
                />
                <Button
                  label="Export document"
                  disabled={busy}
                  onPress={() => {
                    void run(async () => {
                      if (!document) return;
                      const file = new File(Paths.cache, `knowledge-${document.id}.md`);
                      try {
                        file.create({ overwrite: true });
                        file.write(document.bodyMarkdown ?? '');
                        await Sharing.shareAsync(file.uri, {
                          mimeType: 'text/markdown',
                          dialogTitle: document.title,
                        });
                      } finally {
                        if (file.exists) file.delete();
                      }
                    });
                  }}
                />
                <Button label="Move document" disabled={busy} onPress={() => setMoving(!moving)} />
                <Button
                  label="Delete document"
                  disabled={busy}
                  onPress={() =>
                    confirm(
                      'Delete this document? Projects will lose access. Existing session contexts containing it must be retired.',
                      () => {
                        void run(async () => {
                          if (document) await client.deleteKnowledgeDocument(document.id);
                          setDocument(null);
                          await refresh();
                        });
                      },
                    )
                  }
                />
              </View>
            </>
          )}
          {revisions ? (
            <View style={styles.group}>
              <Text style={styles.heading}>Revision history</Text>
              {hasMoreRevisions ? (
                <Button
                  label="Load more revisions"
                  disabled={busy}
                  onPress={() => {
                    void run(async () => {
                      if (!document) return;
                      const next = await client.listKnowledgeRevisions(
                        document.id,
                        revisions.length,
                      );
                      setRevisions((current) => [...(current ?? []), ...next]);
                      setHasMoreRevisions(next.length === 100);
                    });
                  }}
                />
              ) : null}
              {revisions.map((r) => (
                <Button
                  key={r.id}
                  label={`${new Date(r.createdAt).toLocaleString()} — ${r.authorIdentity === 'operator' ? 'You' : 'Agent'}${r.sessionId ? ` · ${r.sessionId.slice(0, 8)}` : ''}`}
                  onPress={() => setRevision(r)}
                />
              ))}
            </View>
          ) : null}
          {revision ? (
            <View style={styles.group}>
              <KnowledgeMarkdown body={revision.bodyMarkdown} />
              {revision.sessionId ? (
                <Button
                  label="Open source session"
                  onPress={() =>
                    router.push({ pathname: '/session/[id]', params: { id: revision.sessionId! } })
                  }
                />
              ) : null}
              <Button
                label="Restore this revision"
                disabled={busy}
                onPress={() =>
                  confirm('Restore this version as a new revision?', () => {
                    void run(async () => {
                      if (document) {
                        setDocument(
                          await client.restoreKnowledgeRevision(
                            document.id,
                            revision.id,
                            document.currentRevisionId,
                          ),
                        );
                        setRevisions(null);
                        setRevision(null);
                      }
                    });
                  })
                }
              />
            </View>
          ) : null}
        </View>
      ) : (
        <View style={styles.group}>
          <TextInput
            accessibilityLabel="Search knowledge"
            editable={!busy}
            placeholder="Search documents"
            style={styles.input}
            value={query}
            onChangeText={setQuery}
          />
          {folders
            .filter((f) => f.parentId === folderId)
            .map((f) => (
              <Button key={f.id} label={`Folder: ${f.name}`} onPress={() => openFolder(f.id)} />
            ))}
          {documents
            .filter((d) => query || d.folderId === folderId)
            .map((d) => (
              <Button key={d.id} label={d.title} onPress={() => openDocument(d.id)} />
            ))}
          {hasMore ? (
            <Button
              label="Load more documents"
              disabled={busy}
              onPress={() => {
                void run(async () => {
                  const next = await client.listKnowledgeDocuments(
                    folderId ?? undefined,
                    query || undefined,
                    documents.length,
                  );
                  setDocuments((current) => [
                    ...current,
                    ...next.filter((d) => !current.some((old) => old.id === d.id)),
                  ]);
                  setHasMore(next.length === 100);
                });
              }}
            />
          ) : null}
          <TextInput
            accessibilityLabel="Folder name"
            placeholder="Folder name"
            style={styles.input}
            value={folderName}
            onChangeText={setFolderName}
          />
          <View style={styles.row}>
            <Button
              label="Create folder"
              disabled={busy || !folderName.trim()}
              onPress={() => {
                void run(async () => {
                  await client.createKnowledgeFolder({ name: folderName, parentId: folderId });
                  setFolderName('');
                  await refresh();
                });
              }}
            />
            {folderId ? (
              <>
                <Button
                  label="New document"
                  disabled={busy}
                  onPress={() => {
                    setCreating(true);
                    setTitle('');
                    setBody('');
                    setEditing(true);
                    setPreview(false);
                  }}
                />
                <Button
                  label="Rename folder"
                  disabled={busy || !folderName.trim()}
                  onPress={() => {
                    void run(async () => {
                      await client.updateKnowledgeFolder(folderId, { name: folderName });
                      setFolderName('');
                      await refresh();
                    });
                  }}
                />
                <Button label="Move folder" disabled={busy} onPress={() => setMoving(!moving)} />
                <Button
                  label="Delete folder"
                  disabled={busy}
                  onPress={() =>
                    confirm(
                      'Delete this folder and its contents? Project access changes may retire affected session contexts.',
                      () => {
                        void run(async () => {
                          await client.deleteKnowledgeFolder(folderId);
                          showFolder(currentFolder?.parentId ?? null);
                        });
                      },
                    )
                  }
                />
              </>
            ) : null}
          </View>
          {folderId ? (
            <View style={styles.row}>
              <Button
                label="Import Markdown files"
                disabled={busy}
                onPress={() => {
                  void run(async () => {
                    const picked = await DocumentPicker.getDocumentAsync({
                      multiple: true,
                      copyToCacheDirectory: true,
                      type: ['text/markdown', 'text/plain'],
                    });
                    if (picked.canceled) return;
                    const entries = [];
                    try {
                      if (picked.assets.length > 100)
                        throw new Error('Import at most 100 documents at a time');
                      if (
                        picked.assets.reduce((sum, asset) => sum + (asset.size ?? 0), 0) >
                        2 * 1024 * 1024
                      )
                        throw new Error('Import is limited to 2 MiB');
                      for (const asset of picked.assets) {
                        if ((asset.size ?? 0) > 256 * 1024)
                          throw new Error('Each document is limited to 256 KiB');
                        if (!asset.name.toLowerCase().endsWith('.md'))
                          throw new Error('Only .md files can be imported');
                        entries.push({
                          path: asset.name,
                          bodyMarkdown: await new File(asset.uri).text(),
                        });
                      }
                      if (folderId) await client.importKnowledge(folderId, entries);
                      await refresh();
                    } finally {
                      for (const asset of picked.assets) {
                        try {
                          new File(asset.uri).delete();
                        } catch {
                          /* Cache cleanup must not hide the import outcome. */
                        }
                      }
                    }
                  });
                }}
              />
              <Button
                label="Import folder bundle"
                disabled={busy}
                onPress={() => setTransfer('')}
              />
              <Button
                label="Export Markdown bundle"
                disabled={busy}
                onPress={() => {
                  void run(async () => {
                    const exported = await client.exportKnowledge(folderId);
                    setTransfer(JSON.stringify(exported, null, 2));
                  });
                }}
              />
            </View>
          ) : null}
        </View>
      )}
      {moving ? (
        <View style={styles.group}>
          <Text style={styles.heading}>Move to folder</Text>
          {[
            ...(!document ? [{ id: '', name: 'Knowledge root', parentId: null }] : []),
            ...folders.filter((f) => f.id !== folderId),
          ].map((f) => (
            <Button
              key={f.id}
              label={`Move to ${f.name}`}
              disabled={busy}
              onPress={() => {
                void run(async () => {
                  const preview = document
                    ? await client.previewKnowledgeDocumentMove(document.id, f.id)
                    : folderId
                      ? await client.previewKnowledgeFolderMove(folderId, f.id || null)
                      : null;
                  if (!preview) return;
                  const changes = preview.affectedProjects
                    .map(
                      (p) =>
                        `${p.projectId}: read +${p.gainedRead}/−${p.lostRead}, write +${p.gainedWrite}/−${p.lostWrite}`,
                    )
                    .join('\n');
                  confirm(
                    `${changes || 'No project access changes.'}\nCounts include folders and documents. Sessions losing read access will be retired. Move?`,
                    () => {
                      void run(async () => {
                        if (document) {
                          const moved = await client.moveKnowledgeDocument(
                            document.id,
                            f.id,
                            preview.policyToken,
                          );
                          setDocument(moved);
                          setFolderId(moved.folderId);
                        } else if (folderId)
                          await client.updateKnowledgeFolder(folderId, {
                            parentId: f.id || null,
                            expectedPolicyToken: preview.policyToken,
                          });
                        setMoving(false);
                        await refresh();
                      });
                    },
                  );
                });
              }}
            />
          ))}
        </View>
      ) : null}
      {transfer !== null ? (
        <View style={styles.group}>
          <Text style={styles.heading}>Markdown transfer</Text>
          <Text style={styles.muted}>
            Portable JSON bundle: documents with relative path and bodyMarkdown. Folder structure is
            preserved. Import rejects collisions.
          </Text>
          <TextInput
            accessibilityLabel="Markdown import or export bundle"
            multiline
            style={[styles.input, styles.editor]}
            value={transfer}
            onChangeText={setTransfer}
          />
          <View style={styles.row}>
            <Button
              label="Copy bundle"
              onPress={() => {
                void Clipboard.setStringAsync(transfer);
              }}
            />
            <Button
              label="Share bundle"
              onPress={() => {
                void run(async () => {
                  const file = new File(Paths.cache, 'knowledge-export.json');
                  try {
                    file.create({ overwrite: true });
                    file.write(transfer);
                    await Sharing.shareAsync(file.uri, { mimeType: 'application/json' });
                  } finally {
                    if (file.exists) file.delete();
                  }
                });
              }}
            />
            <Button
              label="Import bundle"
              disabled={busy || !folderId}
              onPress={() => {
                void run(async () => {
                  const data: unknown = JSON.parse(transfer);
                  if (
                    !data ||
                    typeof data !== 'object' ||
                    !('documents' in data) ||
                    !Array.isArray(data.documents)
                  )
                    throw new Error('Expected a documents array');
                  const entries = data.documents.map((item: unknown) => {
                    if (
                      !item ||
                      typeof item !== 'object' ||
                      !('path' in item) ||
                      !('bodyMarkdown' in item) ||
                      typeof item.path !== 'string' ||
                      typeof item.bodyMarkdown !== 'string'
                    )
                      throw new Error('Each document needs path and bodyMarkdown');
                    return { path: item.path, bodyMarkdown: item.bodyMarkdown };
                  });
                  if (folderId) await client.importKnowledge(folderId, entries);
                  setTransfer(null);
                  await refresh();
                });
              }}
            />
            <Button label="Close transfer" onPress={() => setTransfer(null)} />
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
