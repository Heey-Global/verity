import { ProjectKnowledge } from '../components/knowledge/ProjectKnowledge';
import { KnowledgeOriginal } from '../components/knowledge/KnowledgeOriginal';
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
import { Alert, Modal, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '../components/Icon';
import { createVerityClient } from '../lib/client';
import { KnowledgeButton as Button } from '../components/knowledge/KnowledgeButton';
import { KnowledgeMarkdown } from '../components/knowledge/KnowledgeMarkdown';
import { styles } from '../components/knowledge/styles';

export default function KnowledgeScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const params = useLocalSearchParams<{ folderId?: string; projectId?: string }>();
  return client ? (
    <Library client={client} initialFolder={params.folderId ?? null} projectId={params.projectId} />
  ) : (
    <Text style={styles.text}>Connect to your server to open Knowledge.</Text>
  );
}

export function Library({
  client,
  initialFolder,
  projectId,
}: {
  client: VerityClient;
  initialFolder: string | null;
  projectId?: string;
}) {
  const navigation = useNavigation();
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const split = width >= 900;
  const [folderAction, setFolderAction] = useState<'create' | 'rename' | null>(null);
  const [moreActions, setMoreActions] = useState(false);
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [folderId, setFolderId] = useState(initialFolder);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set());
  const activeProjectId = useMemo(() => {
    if (projectId) return projectId;
    let current = folders.find((folder) => folder.id === folderId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.projectId) return current.projectId;
      seen.add(current.id);
      current = folders.find((folder) => folder.id === current?.parentId);
    }
    return undefined;
  }, [projectId, folders, folderId]);
  const onSpace = useCallback(
    (space: { sourcesFolderId: string }) => {
      if (!initialFolder) setFolderId((current) => current ?? space.sourcesFolderId);
    },
    [initialFolder],
  );
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [editing, setEditing] = useState(false);
  const [hasOriginal, setHasOriginal] = useState<boolean | null>(null);
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
    setFolderAction(null);
    setMoreActions(false);
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
  const toggleFolder = (id: string, isOpen: boolean) => {
    if (isOpen) {
      setExpandedFolderIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      return;
    }
    leave(() => {
      setExpandedFolderIds((current) => new Set(current).add(id));
      showFolder(id);
    });
  };
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
  const folderPathLabel = (folder: KnowledgeFolder): string => {
    const names = [folder.name];
    const seen = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = folders.find((candidate) => candidate.id === parentId);
      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parentId;
    }
    return names.join(' / ');
  };
  const path: KnowledgeFolder[] = [];
  let ancestor = currentFolder;
  const seen = new Set<string>();
  while (ancestor && !seen.has(ancestor.id)) {
    seen.add(ancestor.id);
    path.unshift(ancestor);
    ancestor = folders.find((f) => f.id === ancestor?.parentId);
  }
  const pathKey = path.map((folder) => folder.id).join('/');
  useEffect(() => {
    if (!path.length) return;
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const folder of path) {
        if (!next.has(folder.id)) {
          next.add(folder.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [pathKey]);
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
  const renderDocument = (entry: KnowledgeDocument, depth: number) => (
    <Pressable
      key={entry.id}
      accessibilityRole="button"
      accessibilityLabel={entry.title}
      disabled={busy}
      onPress={() => openDocument(entry.id)}
      style={[styles.explorerRow, { paddingLeft: 28 + depth * 16 }]}
    >
      <Icon name="file-text" size={17} color={theme.colors.textMuted} />
      <Text numberOfLines={1} style={styles.entryText}>
        {entry.title}
      </Text>
      {entry.stale ? <Text style={styles.muted}>Source changed</Text> : null}
    </Pressable>
  );
  const renderFolders = (parentId: string | null, depth: number): React.ReactNode =>
    folders
      .filter((folder) => folder.parentId === parentId)
      .map((folder) => {
        const isOpen = expandedFolderIds.has(folder.id);
        return (
          <View key={folder.id}>
            <View
              style={[
                styles.explorerRow,
                folder.id === folderId && styles.selectedRow,
                { paddingLeft: depth * 16 },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${isOpen ? 'Collapse' : 'Expand'} folder: ${folder.name}`}
                accessibilityState={{ expanded: isOpen }}
                disabled={busy}
                onPress={() => toggleFolder(folder.id, isOpen)}
                style={styles.explorerToggle}
              >
                <Icon
                  name={isOpen ? 'chevron-down' : 'chevron-right'}
                  size={15}
                  color={theme.colors.textMuted}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Folder: ${folder.name}`}
                accessibilityState={{ selected: folder.id === folderId }}
                disabled={busy}
                onPress={() => openFolder(folder.id)}
                style={styles.explorerEntry}
              >
                <Icon name="folder" size={18} color={theme.colors.textMuted} />
                <Text numberOfLines={1} style={styles.entryText}>
                  {folder.name}
                </Text>
              </Pressable>
            </View>
            {isOpen ? (
              <>
                {renderFolders(folder.id, depth + 1)}
                {folder.id === folderId
                  ? documents
                      .filter((entry) => entry.folderId === folder.id)
                      .map((entry) => renderDocument(entry, depth + 1))
                  : null}
              </>
            ) : null}
          </View>
        );
      });
  const loadMoreDocuments = hasMore ? (
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
            ...next.filter((entry) => !current.some((old) => old.id === entry.id)),
          ]);
          setHasMore(next.length === 100);
        });
      }}
    />
  ) : null;
  return (
    // Keep fields visible when editing a deeply scrolled folder or document.
    <KeyboardAwareScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Knowledge', gestureEnabled: !dirty && !busy }} />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {busy ? <Text style={styles.muted}>Working…</Text> : null}
      <View style={split && (document || creating) ? styles.knowledgeSplit : undefined}>
        {split && (document || creating) ? (
          <View style={styles.knowledgeMasterPane}>
            <TextInput
              accessibilityLabel="Search knowledge"
              editable={!busy}
              placeholder="Search documents"
              placeholderTextColor={theme.colors.textMuted}
              style={styles.input}
              value={query}
              onChangeText={setQuery}
            />
            {!query ? renderFolders(null, 0) : documents.map((entry) => renderDocument(entry, 0))}
            {loadMoreDocuments}
          </View>
        ) : null}
        {document || creating ? (
          <View style={[styles.group, split ? styles.knowledgeDetailPane : null]}>
            {activeProjectId ? (
              <ProjectKnowledge
                key={activeProjectId}
                client={client}
                projectId={activeProjectId}
                document={document}
                folders={folders}
                blocked={busy || editing || creating}
                onSpace={onSpace}
              />
            ) : null}
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
                {document?.stale ? (
                  <Text style={styles.muted}>
                    Source changed or removed. Review this Wiki page before relying on it.
                  </Text>
                ) : null}
                {document ? (
                  <KnowledgeOriginal
                    client={client}
                    document={document}
                    onOriginal={setHasOriginal}
                    onReplaced={async (next) => {
                      setDocument(next);
                      await refresh();
                    }}
                  />
                ) : null}
                <KnowledgeMarkdown
                  body={document?.bodyMarkdown ?? ''}
                  onLink={openLinkedDocument}
                />
                <View style={styles.row}>
                  {!split ? (
                    <Button
                      icon="arrow-left"
                      iconOnly
                      label="Back to folder"
                      disabled={busy}
                      onPress={() => openFolder(document?.folderId ?? folderId)}
                    />
                  ) : null}
                  {hasOriginal !== true ? (
                    <Button
                      icon="edit-2"
                      iconOnly
                      label="Edit"
                      disabled={busy || hasOriginal === null}
                      onPress={startEdit}
                    />
                  ) : null}
                  <Button
                    icon="clock"
                    iconOnly
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
                    icon="share"
                    iconOnly
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
                  <Button
                    icon="corner-up-right"
                    iconOnly
                    label="Move document"
                    disabled={busy}
                    onPress={() => setMoving(!moving)}
                  />
                  <Button
                    icon="trash-2"
                    iconOnly
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
                      router.push({
                        pathname: '/session/[id]',
                        params: { id: revision.sessionId! },
                      })
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
                          await refresh();
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
              placeholderTextColor={theme.colors.textMuted}
              style={styles.input}
              value={query}
              onChangeText={setQuery}
            />
            <View style={styles.toolbar}>
              {currentFolder ? (
                <Button
                  icon="arrow-up"
                  iconOnly
                  label="Open parent folder"
                  disabled={busy}
                  onPress={() => openFolder(currentFolder.parentId)}
                />
              ) : null}
              <Button
                icon="folder-plus"
                iconOnly
                label="New folder"
                disabled={busy}
                onPress={() => {
                  setFolderAction('create');
                  setFolderName('');
                }}
              />
              <Button
                icon="file-plus"
                iconOnly
                label="New document"
                disabled={busy || !folderId}
                onPress={() => {
                  setCreating(true);
                  setTitle('');
                  setBody('');
                  setEditing(true);
                  setPreview(false);
                }}
              />
              <Button
                icon="upload"
                iconOnly
                label="Import Markdown files"
                disabled={busy || !folderId}
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
                icon="upload-cloud"
                iconOnly
                label="Upload original files"
                disabled={busy || !folderId}
                onPress={() => {
                  void run(async () => {
                    const picked = await DocumentPicker.getDocumentAsync({
                      multiple: true,
                      copyToCacheDirectory: true,
                      type: '*/*',
                    });
                    if (picked.canceled) return;
                    let uploaded = 0;
                    let failure: unknown;
                    try {
                      for (const asset of picked.assets)
                        if ((asset.size ?? 0) > 10 * 1024 * 1024)
                          throw new Error('Each original is limited to 10 MiB');
                      for (const asset of picked.assets) {
                        if (folderId)
                          await client.uploadKnowledgeSource({
                            folderId,
                            filename: asset.name,
                            base64: await new File(asset.uri).base64(),
                          });
                        uploaded += 1;
                      }
                    } catch (error) {
                      failure = error;
                    } finally {
                      for (const asset of picked.assets) {
                        try {
                          new File(asset.uri).delete();
                        } catch {
                          /* Preserve the upload outcome. */
                        }
                      }
                    }
                    if (uploaded > 0)
                      try {
                        await refresh();
                      } catch (error) {
                        failure ??= error;
                      }
                    if (failure) throw failure;
                  });
                }}
              />
              <Button
                icon="more-horizontal"
                iconOnly
                label="More folder actions"
                disabled={busy || !folderId}
                onPress={() => setMoreActions(!moreActions)}
              />
            </View>
            {activeProjectId ? (
              <ProjectKnowledge
                key={activeProjectId}
                client={client}
                projectId={activeProjectId}
                folders={folders}
                blocked={busy || editing || creating}
                onSpace={onSpace}
              />
            ) : null}
            {folderAction ? (
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel="Folder name"
                  placeholder="Folder name"
                  placeholderTextColor={theme.colors.textMuted}
                  autoFocus
                  style={[styles.input, styles.cell]}
                  value={folderName}
                  onChangeText={setFolderName}
                  editable={!busy}
                />
                <Button
                  icon="check"
                  iconOnly
                  label={folderAction === 'create' ? 'Create folder' : 'Save folder name'}
                  disabled={busy || !folderName.trim()}
                  onPress={() => {
                    void run(async () => {
                      if (folderAction === 'create')
                        await client.createKnowledgeFolder({
                          name: folderName,
                          parentId: folderId,
                        });
                      else if (folderId)
                        await client.updateKnowledgeFolder(folderId, { name: folderName });
                      setFolderName('');
                      setFolderAction(null);
                      await refresh();
                    });
                  }}
                />
                <Button
                  icon="x"
                  iconOnly
                  label="Cancel folder editing"
                  disabled={busy}
                  onPress={() => setFolderAction(null)}
                />
              </View>
            ) : null}
            <Modal
              visible={moreActions && !!folderId}
              transparent
              animationType="fade"
              onRequestClose={() => setMoreActions(false)}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close folder actions"
                style={styles.menuBackdrop}
                onPress={() => setMoreActions(false)}
              >
                <Pressable style={styles.menuCard} onPress={() => undefined}>
                  <Text style={styles.heading}>Folder actions</Text>
                  <View style={styles.group}>
                    <Button
                      icon="edit-2"
                      label="Rename folder"
                      disabled={busy || !!currentFolder?.role}
                      onPress={() => {
                        setMoreActions(false);
                        setFolderAction('rename');
                        setFolderName(currentFolder?.name ?? '');
                      }}
                    />
                    <Button
                      icon="corner-up-right"
                      label="Move folder"
                      disabled={busy || !!currentFolder?.role}
                      onPress={() => {
                        setMoreActions(false);
                        setMoving(!moving);
                      }}
                    />
                    <Button
                      icon="trash-2"
                      label="Delete folder"
                      disabled={busy || !!currentFolder?.role}
                      onPress={() => {
                        const selectedFolderId = folderId;
                        if (!selectedFolderId) return;
                        setMoreActions(false);
                        confirm(
                          'Delete this folder and its contents? Project access changes may retire affected session contexts.',
                          () => {
                            void run(async () => {
                              await client.deleteKnowledgeFolder(selectedFolderId);
                              showFolder(currentFolder?.parentId ?? null);
                            });
                          },
                        );
                      }}
                    />
                    <Button
                      icon="upload"
                      label="Import source bundle"
                      disabled={busy}
                      onPress={() => {
                        const selectedFolderId = folderId;
                        if (!selectedFolderId) return;
                        setMoreActions(false);
                        void run(async () => {
                          const picked = await DocumentPicker.getDocumentAsync({
                            multiple: false,
                            copyToCacheDirectory: true,
                            type: 'application/json',
                          });
                          if (picked.canceled) return;
                          const asset = picked.assets[0];
                          if (!asset) return;
                          const file = new File(asset.uri);
                          try {
                            if ((asset.size ?? 0) > 20 * 1024 * 1024)
                              throw new Error('Source bundles are limited to 20 MiB');
                            const bundle: unknown = JSON.parse(await file.text());
                            await client.importKnowledgeSourceBundle(selectedFolderId, bundle);
                            await refresh();
                          } finally {
                            try {
                              file.delete();
                            } catch {
                              /* Preserve the import outcome. */
                            }
                          }
                        });
                      }}
                    />
                    <Button
                      icon="download"
                      label="Export source bundle"
                      disabled={busy}
                      onPress={() => {
                        const selectedFolderId = folderId;
                        if (!selectedFolderId) return;
                        setMoreActions(false);
                        void run(async () => {
                          const bundle = await client.exportKnowledgeSourceBundle(selectedFolderId);
                          const file = new File(Paths.cache, 'knowledge-sources.json');
                          try {
                            file.create({ overwrite: true });
                            file.write(JSON.stringify(bundle));
                            await Sharing.shareAsync(file.uri, { mimeType: 'application/json' });
                          } finally {
                            if (file.exists) file.delete();
                          }
                        });
                      }}
                    />
                    <Text style={styles.muted}>
                      Source bundles include current originals and extracted content; full history
                      is retained in server backups.
                    </Text>
                    <Button
                      icon="download"
                      label="Import folder bundle"
                      disabled={busy}
                      onPress={() => {
                        setMoreActions(false);
                        setTransfer('');
                      }}
                    />
                    <Button
                      icon="share"
                      label="Export Markdown bundle"
                      disabled={busy}
                      onPress={() => {
                        const selectedFolderId = folderId;
                        if (!selectedFolderId) return;
                        setMoreActions(false);
                        void run(async () => {
                          const exported = await client.exportKnowledge(selectedFolderId);
                          setTransfer(JSON.stringify(exported, null, 2));
                        });
                      }}
                    />
                  </View>
                </Pressable>
              </Pressable>
            </Modal>
            {!query ? renderFolders(null, 0) : null}
            {query ? documents.map((d) => renderDocument(d, 0)) : null}
            {!folders.length && !query ? (
              <Text style={styles.muted}>Create a folder to start your library.</Text>
            ) : null}
            {loadMoreDocuments}
          </View>
        )}
      </View>
      {moving ? (
        <View style={[styles.group, split ? styles.knowledgeDetailAction : null]}>
          <Text style={styles.heading}>Move to folder</Text>
          {[
            ...(!document ? [{ id: '', name: 'Knowledge root', parentId: null }] : []),
            ...folders.filter((f) => f.id !== folderId),
          ].map((f) => (
            <Button
              key={f.id}
              label={`Move to ${f.id ? folderPathLabel(f) : f.name}`}
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
                        // Document moves change folderId; its effect loads the destination.
                        // Refreshing here would publish the captured source-folder listing.
                        if (!document) await refresh();
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
        <View style={[styles.group, split ? styles.knowledgeDetailAction : null]}>
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
    </KeyboardAwareScrollView>
  );
}
