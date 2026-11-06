import type { SessionFileContent, VerityClient } from '@verity/mobile';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FileContentPreview } from '../files/FileContentPreview';
import { FileSheetHeader, HeaderIconButton, HeaderTextButton } from '../files/FileSheetHeader';
import { MarkdownItem } from '../files/MarkdownItem';
import { Button, Text, TextField, useConfirm } from '../ui';
import { shareDownload } from '../../lib/shareDownload';
import {
  downloadKnowledge,
  folderTitle,
  knowledgeDownloadUrl,
  parentFolder,
  readKnowledge,
  writeKnowledge,
  type KnowledgeScope,
} from './knowledgeScope';

/**
 * One knowledge file for reading: Markdown rendered across the full width,
 * with Source a tab away. Edit (where the server allows it) swaps in the text
 * for editing, with Cancel and Save where Edit was; Download hands the original
 * to the share sheet.
 *
 * `stack` puts the name and actions into the navigation header of its own
 * screen; `pane` draws them itself, for the wide layout's right column, with a
 * close button that brings the session back.
 */
export function KnowledgeFileView({
  client,
  scope,
  file,
  chrome,
  onClose,
  onDirtyChange,
}: {
  client: VerityClient;
  scope: KnowledgeScope;
  file: string;
  chrome: 'stack' | 'pane';
  onClose?: () => void;
  /** Whether there are unsaved edits, so a host that replaces the view can ask first. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [content, setContent] = useState<SessionFileContent>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const [confirm, confirmSheet] = useConfirm();
  const projectId = scope.kind === 'project' ? scope.projectId : '';
  // A save answered after the operator moved to another file must not land on it.
  // Scope and path together: the same path in another project is another file.
  const identity = `${scope.kind}:${projectId}:${file}`;
  const current = useRef(identity);
  current.current = identity;

  useEffect(() => {
    let active = true;
    setContent(undefined);
    setError(undefined);
    setDraft(undefined);
    setSaveError(undefined);
    readKnowledge(client, scope, file).then(
      (next) => {
        if (active) setContent(next);
      },
      (failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not open file');
      },
    );
    return () => {
      active = false;
    };
    // `scope` is compared by what it names, so a fresh object does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scope.kind, projectId, file, attempt]);

  const save = useCallback(async () => {
    if (draft === undefined || !content?.version || saving) return;
    const target = identity;
    setSaving(true);
    try {
      const next = await writeKnowledge(client, scope, file, draft, content.version);
      if (current.current !== target) return;
      setContent(next);
      setDraft(undefined);
      setSaveError(undefined);
    } catch (failure) {
      if (current.current !== target) return;
      // The draft stays, so a conflict or a dropped connection loses nothing.
      setSaveError(failure instanceof Error ? failure.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }, [client, content?.version, draft, file, identity, saving, scope]);

  // After a failed save: read the file's current version again but keep the
  // draft, so the next Save applies it on top of whatever changed meanwhile.
  const refreshVersion = useCallback(() => {
    const target = identity;
    readKnowledge(client, scope, file).then(
      (next) => {
        if (current.current !== target) return;
        setContent(next);
        setSaveError(undefined);
      },
      (failure: unknown) => {
        if (current.current !== target) return;
        setSaveError(failure instanceof Error ? failure.message : 'Could not reload file');
      },
    );
  }, [client, file, identity, scope]);

  const download = useCallback(() => {
    setDownloading(true);
    void shareDownload({
      url: knowledgeDownloadUrl(client, scope, file),
      path: file,
      cacheFolder: scope.kind === 'shared' ? 'shared-knowledge' : `knowledge-${projectId}`,
      webBlob: () => downloadKnowledge(client, scope, file),
    })
      .catch((failure: unknown) =>
        Alert.alert(
          'Could not download file',
          failure instanceof Error ? failure.message : String(failure),
        ),
      )
      .finally(() => setDownloading(false));
  }, [client, file, projectId, scope]);

  const name = file.split('/').at(-1) ?? file;
  const editing = draft !== undefined;
  const dirty = editing && draft !== content?.content;
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  useEffect(() => report.current?.(dirty), [dirty]);
  // Gone means nothing left unsaved here.
  useEffect(() => () => report.current?.(false), []);
  const canEdit = content?.editable === true && content.version !== undefined;
  const actions = editing ? (
    <View style={styles.actions}>
      <HeaderTextButton
        label="Cancel"
        disabled={saving}
        onPress={() => {
          setDraft(undefined);
          setSaveError(undefined);
        }}
      />
      <HeaderTextButton
        label="Save"
        emphasis="strong"
        busy={saving}
        disabled={draft === content?.content}
        onPress={() => void save()}
      />
    </View>
  ) : (
    <View style={styles.actions}>
      <HeaderIconButton
        icon="download"
        accessibilityLabel="Download original"
        busy={downloading}
        onPress={download}
      />
      {canEdit ? <HeaderTextButton label="Edit" onPress={() => setDraft(content.content)} /> : null}
    </View>
  );

  let body;
  if (error !== undefined)
    body = (
      <View style={styles.message}>
        <Text variant="body" tone="muted">
          {error}
        </Text>
        <Button
          label="Retry"
          variant="secondary"
          size="compact"
          onPress={() => setAttempt((value) => value + 1)}
        />
      </View>
    );
  else if (content === undefined) body = <ActivityIndicator style={styles.loading} />;
  else if (editing)
    body = (
      <ScrollView contentContainerStyle={styles.editor} keyboardShouldPersistTaps="handled">
        {saveError !== undefined ? (
          <View style={styles.saveError}>
            <Text variant="body" tone="muted">
              {saveError}
            </Text>
            <Button label="Retry" variant="secondary" size="compact" onPress={refreshVersion} />
          </View>
        ) : null}
        <TextField
          label="Content"
          value={draft}
          onChangeText={setDraft}
          multiline
          lines={{ min: 16, max: 60 }}
          disabled={saving}
          literal
        />
      </ScrollView>
    );
  else
    body = (
      <View style={styles.reader}>
        <FileContentPreview
          key={file}
          path={file}
          content={content.content}
          listStyle={styles.list}
          bodyStyle={styles.listBody}
          textStyle={styles.source}
          renderMarkdown={(item) => <MarkdownItem item={item} />}
        />
      </View>
    );

  return (
    <View style={styles.root} testID="knowledge-file">
      {chrome === 'stack' ? (
        <Stack.Screen options={{ title: name, headerRight: () => actions }} />
      ) : (
        <FileSheetHeader
          title={name}
          subtitle={folderTitle(scope, parentFolder(file))}
          trailing={
            <View style={styles.actions}>
              {actions}
              {onClose ? (
                <HeaderIconButton
                  icon="x"
                  accessibilityLabel="Close file"
                  onPress={() =>
                    dirty
                      ? confirm({
                          title: 'Discard changes?',
                          message: 'Your edits to this file are not saved.',
                          confirmLabel: 'Discard',
                          destructive: true,
                          onConfirm: onClose,
                        })
                      : onClose()
                  }
                />
              ) : null}
            </View>
          }
        />
      )}
      {content?.warning ? (
        <Text variant="subtitle" tone="muted" style={styles.warning}>
          {content.warning}
        </Text>
      ) : null}
      {body}
      {confirmSheet}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  reader: { flex: 1, paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm },
  list: { flex: 1 },
  listBody: { paddingVertical: theme.spacing.md, gap: theme.spacing.xs },
  source: { ...theme.typography.code, color: theme.colors.text },
  editor: { padding: theme.spacing.lg },
  message: { padding: theme.spacing.lg, gap: theme.spacing.sm, alignItems: 'flex-start' },
  saveError: { gap: theme.spacing.sm, alignItems: 'flex-start', paddingBottom: theme.spacing.md },
  loading: { paddingVertical: theme.spacing.xl },
  warning: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm },
}));
