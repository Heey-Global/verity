import { VerityApiError, type SessionFileContent } from '@verity/mobile';
import { useState } from 'react';
import { Alert, Modal, Platform, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { renameProblem, parentPath } from '../../lib/sessionFileUi';
import { FileActionMenu } from './FileActionMenu';
import { FileNameDialog } from './FileNameDialog';
import { FileToolbarButton } from './FileToolbarButton';

export function FileTextEditor({
  file,
  onSave,
  onRead,
  onSaved,
  onCancel,
}: {
  file: SessionFileContent;
  onSave: (path: string, content: string, version: string | null) => Promise<SessionFileContent>;
  onRead: (path: string) => Promise<SessionFileContent>;
  onSaved: (file: SessionFileContent) => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [base, setBase] = useState(file);
  const [draft, setDraft] = useState(file.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [copy, setCopy] = useState(false);
  const dirty = draft !== base.content || base.version === undefined;
  const tooLarge = new TextEncoder().encode(draft).length > 1_000_000;
  const save = async (path = base.path, version: string | null = base.version ?? null) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await onSave(path, draft, version));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      if (error instanceof VerityApiError && error.status === 409) setConflict(true);
      throw error;
    } finally {
      setBusy(false);
    }
  };
  const saveCurrent = () => {
    void save().catch(() => {});
  };
  const close = () => {
    if (busy) return;
    if (!dirty) {
      onCancel();
      return;
    }
    Alert.alert('Unsaved changes', 'Save your changes before closing?', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onCancel },
      { text: 'Save', onPress: saveCurrent },
    ]);
  };
  const reload = async (overwrite: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const latest = await onRead(base.path);
      if (!latest.editable || !latest.version) throw new Error('This file cannot be edited.');
      if (overwrite) await save(base.path, latest.version);
      else {
        setBase(latest);
        setDraft(latest.content);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const name = base.path.split('/').pop() ?? 'note.md';
  const copyName = name.includes('.') ? name.replace(/(\.[^.]+)$/, '-copy$1') : `${name}-copy`;
  return (
    <Modal visible animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView
        style={[styles.editor, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        behavior="padding"
      >
        <View style={styles.toolbar}>
          <FileToolbarButton label="Cancel" disabled={busy} onPress={close} />
          <Text style={styles.title} numberOfLines={1}>
            {name}
            {dirty ? ' • edited' : ''}
          </Text>
          <FileToolbarButton
            label="Save"
            tone="primary"
            disabled={!dirty || tooLarge}
            busy={busy}
            onPress={saveCurrent}
          />
        </View>
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {tooLarge ? <Text style={styles.error}>Text exceeds the 1 MB editing limit.</Text> : null}
        <TextInput
          accessibilityLabel="File contents"
          multiline
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          value={draft}
          onChangeText={setDraft}
          editable={!busy}
          style={styles.input}
          textAlignVertical="top"
        />
        {conflict ? (
          <FileActionMenu
            title="File changed since you opened it"
            onDismiss={() => setConflict(false)}
            actions={[
              {
                key: 'reload',
                label: 'Reload and discard edits',
                icon: 'refresh-cw',
                onPress: () => {
                  void reload(false);
                },
              },
              {
                key: 'overwrite',
                label: 'Overwrite with my edits',
                icon: 'save',
                onPress: () => {
                  void reload(true);
                },
              },
              { key: 'copy', label: 'Save a copy…', icon: 'copy', onPress: () => setCopy(true) },
            ]}
          />
        ) : null}
        {copy ? (
          <FileNameDialog
            title="Save a copy"
            initialName={copyName}
            allowUnchanged
            confirmLabel="Save copy"
            validate={(name) => renameProblem(name, '', [])}
            onCancel={() => setCopy(false)}
            onSubmit={(name) => save([parentPath(base.path), name].filter(Boolean).join('/'), null)}
          />
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}
const styles = StyleSheet.create((theme) => ({
  editor: { flex: 1, backgroundColor: theme.colors.surface, paddingTop: 48, paddingBottom: 24 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
  },
  title: { flex: 1, color: theme.colors.text, fontSize: theme.text.sm },
  error: {
    color: theme.colors.tone.danger,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  input: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    padding: theme.spacing.lg,
  },
}));
