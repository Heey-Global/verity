import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { IconName } from '../../Icon';
import { FileBreadcrumb } from '../FileBreadcrumb';
import { FileEntryRow } from '../FileEntryRow';
import { FileNameDialog } from '../FileNameDialog';
import { FileSheetHeader, HeaderTextButton } from '../FileSheetHeader';
import { ResizableSheetPanel } from '../ResizableSheet';
import { ExplorerBar } from './ExplorerBar';
import { fileNameProblem } from './fileActions';

export interface PickerEntry {
  /** Identifies the folder to `list` and `onPick`: a path, or a Drive id. */
  id: string;
  name: string;
  folder: boolean;
}

/**
 * "Move…": the explorer itself as a folder picker, in the same sheet as the
 * session's Files — Cancel and Move where a selection has Select All and Done,
 * the breadcrumb always shown because it names the destination, files dimmed,
 * and New folder… in the bar under the list. It never leaves the area it
 * opened in (a Wiki, Sources, a Drive link, a session root).
 */
export function FolderPicker({
  title,
  root,
  start,
  current,
  list,
  excluded,
  createFolder,
  onPick,
  onCancel,
}: {
  title: string;
  /** The area's top, which the breadcrumb starts at and the picker never leaves. */
  root: { id: string; label: string; icon: IconName };
  /** The trail from `root` to the folder the picker opens at. */
  start: readonly PickerEntry[];
  /** The folder the entries are in now; moving there would change nothing. */
  current: string;
  list: (folder: string) => Promise<PickerEntry[]>;
  /** Folders that cannot receive the entries: themselves and what is inside. */
  excluded?: (id: string) => boolean;
  createFolder?: ((parent: string, name: string) => Promise<PickerEntry>) | undefined;
  onPick: (folder: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { theme } = useUnistyles();
  const [trail, setTrail] = useState<readonly PickerEntry[]>(start);
  const [entries, setEntries] = useState<PickerEntry[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const folder = trail.at(-1)?.id ?? root.id;

  useEffect(() => {
    let active = true;
    setEntries(undefined);
    setError(undefined);
    list(folder).then(
      (next) => {
        if (active) setEntries(next);
      },
      (failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [folder, list, attempt]);

  const pick = useCallback(() => {
    if (busy) return;
    setBusy(true);
    onPick(folder)
      .catch((failure: unknown) =>
        Alert.alert('Could not move', failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false));
  }, [busy, folder, onPick]);

  const unchanged = folder === current;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={busy ? () => {} : onCancel}>
      <GestureHandlerRootView style={styles.flex}>
        <Pressable
          style={styles.backdrop}
          onPress={busy ? undefined : onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel moving"
        />
        <ResizableSheetPanel>
          <FileSheetHeader
            leading={<HeaderTextButton label="Cancel" disabled={busy} onPress={onCancel} />}
            title={title}
            trailing={
              <HeaderTextButton
                label="Move"
                emphasis="strong"
                busy={busy}
                disabled={unchanged || entries === undefined}
                accessibilityLabel={`Move to ${trail.at(-1)?.name ?? root.label}`}
                onPress={pick}
              />
            }
          />
          <FileBreadcrumb
            rootIcon={root.icon}
            rootLabel={root.label}
            segments={trail.map((entry) => ({ key: entry.id, name: entry.name }))}
            disabled={busy}
            onNavigate={(index) => setTrail((current) => current.slice(0, index + 1))}
          />
          <ScrollView style={styles.flex}>
            {error !== undefined ? (
              <Text style={styles.message}>{error}</Text>
            ) : entries === undefined ? (
              <ActivityIndicator style={styles.loading} color={theme.colors.textMuted} />
            ) : entries.length === 0 ? (
              <Text style={styles.message}>No folders here.</Text>
            ) : (
              entries.map((entry) => (
                <FileEntryRow
                  key={entry.id}
                  name={entry.name}
                  icon={entry.folder ? 'folder' : 'file-text'}
                  inert={!entry.folder || busy || excluded?.(entry.id) === true}
                  onPress={() => setTrail((current) => [...current, entry])}
                />
              ))
            )}
          </ScrollView>
          {createFolder ? (
            <ExplorerBar>
              <HeaderTextButton
                label="New folder…"
                disabled={busy || entries === undefined}
                onPress={() => setNaming(true)}
              />
            </ExplorerBar>
          ) : null}
          {naming && createFolder ? (
            <FileNameDialog
              title="New folder"
              initialName="New folder"
              allowUnchanged
              confirmLabel="Create"
              validate={(name) =>
                fileNameProblem(
                  name,
                  (entries ?? []).map((entry) => entry.name),
                )
              }
              onCancel={() => setNaming(false)}
              onSubmit={async (name) => {
                const created = await createFolder(folder, name);
                setNaming(false);
                setAttempt((value) => value + 1);
                setTrail((current) => [...current, created]);
              }}
            />
          ) : null}
        </ResizableSheetPanel>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: theme.colors.scrim },
  loading: { paddingVertical: theme.spacing.lg },
  message: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.bodySmall.fontSize,
    paddingVertical: theme.spacing.md,
  },
}));
