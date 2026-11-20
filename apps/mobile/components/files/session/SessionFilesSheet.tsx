import type {
  DriveFile,
  SessionFileContent,
  SessionFileEntry,
  SessionFileRoot,
  VerityClient,
} from '@verity/mobile';
import { isDriveFolder, VerityApiError } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { File as FsFile } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUnistyles } from 'react-native-unistyles';

import {
  droppedFileData,
  pickSessionFiles,
  releaseDroppedFile,
  type DroppedFileDescriptor,
} from '../../../lib/attachments';
import { getAuthToken } from '../../../lib/authToken';
import { isDemoMode } from '../../../lib/demoMode';
import {
  dragItemsForRow,
  fileNameFromPath,
  isSelectableFile,
  isTextPreviewCandidate,
  retainVisibleSelection,
  selectionForModifierClick,
  selectionSummary,
  toggleFileSelection,
  type ClickModifiers,
  type DragFileItem,
} from '../../../lib/fileSelection';
import { getServerProfile } from '../../../lib/serverProfile';
import {
  breadcrumbSegments,
  fileDeletionBatch,
  fileEntryMeta,
  fileIcon,
  parentPath,
  renameProblem,
} from '../../../lib/sessionFileUi';
import { MarkdownLine, MarkdownTable } from '../../chat/MarkdownText';
import { DragSource } from '../../DragSource';
import { DropZone } from '../../DropZone';
import { Icon, type IconName } from '../../Icon';
import { useConfirm } from '../../ui';
import { WikiDetails } from '../../WikiDetails';
import { CodeWorkspaceNotice } from '../CodeWorkspaceNotice';
import { FileActionMenu, type FileAction } from '../FileActionMenu';
import { FileBreadcrumb } from '../FileBreadcrumb';
import { FileContentPreview } from '../FileContentPreview';
import { FileNameDialog } from '../FileNameDialog';
import { FileRootTabs } from '../FileRootTabs';
import { FileSheetHeader, HeaderIconButton, HeaderTextButton } from '../FileSheetHeader';
import { FileTextEditor } from '../FileTextEditor';
import { ResizableSheetPanel } from '../ResizableSheet';
import { useCodeWorkspaceAvailability } from '../useCodeWorkspaceAvailability';
import { KNOWLEDGE_ICON } from '../knowledgeIcon';
import { useFileExport } from './useFileExport';
import { sessionFilesStyles as styles } from './sessionFilesStyles';
import { isDriveOverviewEntry, useSessionDrive } from './useSessionDrive';
import { SelectionBar } from '../explorer/ExplorerBar';
import { ExplorerRow } from '../explorer/ExplorerRow';
import { addFileActions, fileActions, fileNameProblem } from '../explorer/fileActions';
import { FolderPicker, type PickerEntry } from '../explorer/FolderPicker';

// Where the native drag zone owns the long press; see the row's onLongPress.
const longPressDrags = Platform.OS === 'ios' && Platform.isPad;
const FILE_ROOT_ICON: Record<SessionFileRoot, IconName> = {
  worktree: 'folder',
  knowledge: KNOWLEDGE_ICON,
  shared: KNOWLEDGE_ICON,
  documents: KNOWLEDGE_ICON,
  sources: KNOWLEDGE_ICON,
  drafts: 'folder',
};

/** Ceiling for a file dropped into the browser for upload. The server streams
 * the body to disk and caps only on free space, but the native drop target
 * copies the file into the app's temporary directory first — so this bounds that
 * copy rather than the transfer. Far above the composer's attachment cap, which
 * exists for an unrelated reason (base64 inside a turn). */
const MAX_DROPPED_UPLOAD_BYTES = 100_000_000;
/** Ceiling across one drop. The native side copies every accepted file before
 * the first upload starts, so without this the per-file cap alone would let a
 * full drop take `MAX_DROPPED_UPLOADS × MAX_DROPPED_UPLOAD_BYTES` of scratch
 * space. Files past the budget are reported as skipped. */
const MAX_DROPPED_UPLOAD_TOTAL_BYTES = 250_000_000;
/** Files accepted from a single drop into the browser. */
const MAX_DROPPED_UPLOADS = 24;

/** A session's Files: its Code and Google Drive, with the Wiki and Sources
 *  views a document session adds, as one explorer in a resizable sheet. */
export function SessionFilesSheet({
  client,
  sessionId,
  projectId,
  baseUrl,
  initialFilePath,
  initialRoot = 'worktree',
  onClose,
}: {
  client: VerityClient;
  sessionId: string;
  projectId: string | null;
  baseUrl: string;
  initialFilePath: string | null;
  initialRoot?: SessionFileRoot;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  const [confirm, confirmSheet] = useConfirm();
  const [documentSession, setDocumentSession] = useState(false);
  const [codeAvailable, setCodeAvailable] = useState(true);
  // The server reports a missing checkout instead of handing out Documents in its place.
  const [codeMissing, setCodeMissing] = useState(false);
  const [restore, setRestore] = useState<{ running: boolean; failure: string | null }>({
    running: false,
    failure: null,
  });
  const [documentStatus, setDocumentStatus] = useState<{
    pending: boolean;
    running: boolean;
    warning?: string;
    inspectionError?: boolean;
    excludedEntries?: { path: string; reason: 'generated' | 'unsupported' }[];
  }>();
  const [path, setPath] = useState(initialFilePath ? parentPath(initialFilePath) : '');
  const [root, setRoot] = useState<SessionFileRoot>(initialRoot);
  const [entries, setEntries] = useState<SessionFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionFileContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [driveActive, setDriveActive] = useState(false);
  // The file whose action menu is open, and the one being renamed. Both are drawn
  // over the sheet (see FileActionMenu), so they live here rather than in a row.
  const [menuFor, setMenuFor] = useState<{ path: string; inPreview: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<SessionFileContent | null>(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState(false);
  // The entries "Move…" is choosing a folder for, from the menu or the selection.
  const [moving, setMoving] = useState<readonly string[] | null>(null);
  const [driveMenuFor, setDriveMenuFor] = useState<DriveFile | null>(null);
  const [driveRenaming, setDriveRenaming] = useState<DriveFile | null>(null);
  const [driveMoving, setDriveMoving] = useState<readonly DriveFile[] | null>(null);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const drive = useSessionDrive({
    client,
    projectId,
    sessionId,
    active: driveActive,
    reloadKey,
    reload,
    mutating,
    setMutating,
    setUploading,
    setLoading,
    setError,
    confirm,
    onClose,
  });
  // Monotonic id of the newest preview fetch; a resolved fetch whose id no longer
  // matches is a superseded tap and is dropped. See openFile.
  const previewRequest = useRef(0);
  // Modifier keys held at the last touch down, reported by the native row before
  // its press fires (see DragSource). Shared by the whole list rather than kept
  // per row, because a press only ever follows its own report — and consumed by
  // that press, so it can never be read twice.
  const modifiers = useRef<ClickModifiers>({ shift: false, command: false });
  // What the next modifier-click needs to know about the last one: the row a
  // shift-click measures its range from, and the rows the last one contributed
  // so a smaller range can take them back. A ref, not state: it changes what the
  // next click means, never what is on screen.
  const modifierClick = useRef<{ anchor: string | null; range: string[] }>({
    anchor: null,
    range: [],
  });
  // Read on every render rather than memoized: the bearer lives in a module
  // variable that a biometric unlock can fill in after this sheet has mounted,
  // and a memo keyed on baseUrl would hand the native drag source the empty
  // string it saw first.
  const token = getAuthToken(baseUrl);
  const authorization = token !== null && token.length > 0 ? `Bearer ${token}` : '';
  const directTlsPin =
    getServerProfile()?.endpoints.find(({ url }) => url === baseUrl)?.transport === 'direct'
      ? getServerProfile()?.endpoints.find(({ url }) => url === baseUrl)?.tlsPin
      : undefined;

  // The earlier deep-link effect reads `openWith` without depending on its identity.
  const openWithRef = useRef<((filePath: string) => void) | null>(null);

  useCodeWorkspaceAvailability({
    client,
    sessionId,
    codeAvailable,
    onAvailable: (dir) => {
      setCodeAvailable(true);
      setCodeMissing(false);
      if (dir.workspaceKind) setDocumentSession(dir.workspaceKind === 'documents');
    },
    onReload: () => setReloadKey((value) => value + 1),
  });

  useEffect(() => {
    if (!initialFilePath) return;
    // Shares openFile's request token so a tap during this initial fetch wins even
    // if the deep-linked file resolves afterwards.
    const request = (previewRequest.current += 1);
    const active = () => previewRequest.current === request;
    setPath(parentPath(initialFilePath));
    setError(null);
    setPreviewLoading(true);
    void client
      .getSessionFileContent(sessionId, initialFilePath, initialRoot)
      .then((file) => {
        if (active()) setPreview(file);
      })
      .catch((err) => {
        if (!active()) return;
        // Same hand-off as a tap in the list: a binary or oversized file opens in
        // another app instead of dead-ending on "file is not a text file".
        if (err instanceof VerityApiError && (err.status === 413 || err.status === 415)) {
          openWithRef.current?.(initialFilePath);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active()) setPreviewLoading(false);
      });
    return () => {
      previewRequest.current += 1;
    };
  }, [client, sessionId, initialFilePath, initialRoot]);

  useEffect(() => {
    if (driveActive) return;
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .listSessionFiles(sessionId, path, root)
      .then((dir) => {
        if (!active) return;
        setDocumentStatus(dir.documentStatus);
        setCodeAvailable(dir.codeAvailable ?? true);
        setCodeMissing(dir.codeWorkspaceUnavailable === true);
        if (dir.workspaceKind) setDocumentSession(dir.workspaceKind === 'documents');
        if (
          !initialFilePath &&
          root === 'worktree' &&
          dir.codeWorkspaceUnavailable !== true &&
          (dir.codeAvailable === false || dir.workspaceKind === 'documents') &&
          projectId
        )
          setDriveActive(true);
        setEntries(dir.entries);
        setTruncated(dir.truncated);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setEntries([]);
        setDocumentStatus(undefined);
        setTruncated(false);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    client,
    driveActive,
    sessionId,
    path,
    root,
    reloadKey,
    initialFilePath,
    initialRoot,
    projectId,
  ]);

  // A reload — an upload landed, or the agent changed the tree — can retire rows
  // the selection still names. Pruning keeps the header count honest and stops a
  // drag from promising a file that is no longer listed.
  useEffect(() => {
    setSelected((current) => {
      const retained = retainVisibleSelection(current, entries);
      return retained.length === current.length ? current : retained;
    });
  }, [entries]);

  // Leaving a directory ends selection outright. Every selected row belongs to
  // the directory being left, so carrying the mode across would show an empty
  // "0 selected" header over rows that were never chosen.
  useEffect(() => {
    setSelecting(false);
    setSelected([]);
    modifierClick.current = { anchor: null, range: [] };
  }, [path]);

  const uploadFiles = useCallback(() => {
    void (async () => {
      let uploaded = false;
      let picked: Awaited<ReturnType<typeof pickSessionFiles>> = [];
      try {
        picked = await pickSessionFiles();
        if (picked.length === 0) return;
        setUploading(true);
        for (const file of picked) {
          await client.uploadSessionFile(sessionId, {
            path,
            fileName: file.fileName,
            data: new FsFile(file.uri),
            root,
          });
          uploaded = true;
        }
      } catch (err) {
        Alert.alert('Could not upload file', err instanceof Error ? err.message : String(err));
      } finally {
        // DocumentPicker copied every selected item into our cache. Dispose all
        // copies after success or failure; otherwise repeated large selections
        // permanently consume app storage.
        for (const file of picked) {
          try {
            new FsFile(file.uri).delete();
          } catch {
            // Best effort; the OS may already have reaped the temporary file.
          }
        }
        if (uploaded) setReloadKey((key) => key + 1);
        setUploading(false);
      }
    })();
  }, [client, path, root, sessionId]);

  const uploadDroppedFiles = useCallback(
    (files: readonly DroppedFileDescriptor[]) => {
      void (async () => {
        let uploaded = false;
        const failures: string[] = [];
        setUploading(true);
        try {
          // Each file is its own attempt: one rejected name — a collision, an
          // unwritable path — must not discard the rest of the drop, whose
          // temporary copies are deleted below either way.
          for (const file of files) {
            try {
              await client.uploadSessionFile(sessionId, {
                path,
                fileName: file.fileName,
                data: await droppedFileData(file.uri),
                root,
              });
              uploaded = true;
            } catch (err) {
              failures.push(
                `${file.fileName}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (failures.length > 0) {
            Alert.alert(
              failures.length === 1 ? 'Could not upload file' : 'Some files were not uploaded',
              failures.join('\n'),
            );
          }
        } finally {
          // These are the native drop target's own temporary copies. Unlike the
          // attachment path there is no reader that disposes of them, so a
          // failure partway through must not strand the rest.
          for (const file of files) {
            try {
              releaseDroppedFile(file.uri);
            } catch {
              // Best effort; the OS also clears the app's temporary directory.
            }
          }
          if (uploaded) setReloadKey((key) => key + 1);
          setUploading(false);
        }
      })();
    },
    [client, path, root, sessionId],
  );

  const onUploadDropRejected = useCallback((errors: string[]) => {
    if (errors.length > 0) Alert.alert('Could not upload', errors.join('\n'));
  }, []);

  const { openWith, chooseExport } = useFileExport({
    baseUrl,
    cacheKey: sessionId,
    downloadUrl: (filePath) => client.sessionFileDownloadUrl(sessionId, filePath, root),
    download: (filePath) => client.downloadSessionFile(sessionId, filePath, root),
    readText: (filePath) => client.getSessionFileContent(sessionId, filePath, root),
  });
  openWithRef.current = openWith;

  const openFile = useCallback(
    (entry: SessionFileEntry) => {
      // Every tap invalidates whatever fetch is in flight: a large file takes long
      // enough that a second tap (or a directory hop) lands first, and without this
      // the slower response would win — showing a file the operator already left,
      // or clearing the spinner while the newer request is still running.
      const request = (previewRequest.current += 1);
      if (entry.kind === 'directory') {
        setPath(entry.path);
        setPreview(null);
        setPreviewLoading(false);
        return;
      }
      if (entry.kind !== 'file') return;
      setError(null);
      // A large file takes a moment to fetch AND to lay out; without this the sheet
      // sits unchanged after the tap and the open reads as a dead press.
      setPreviewLoading(true);
      void client
        .getSessionFileContent(sessionId, entry.path, root)
        .then((file) => {
          if (previewRequest.current !== request) return;
          setPreview(file);
        })
        .catch((err) => {
          if (previewRequest.current !== request) return;
          if (err instanceof VerityApiError && (err.status === 413 || err.status === 415)) {
            openWith(entry.path);
            return;
          }
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (previewRequest.current !== request) return;
          setPreviewLoading(false);
        });
    },
    [client, sessionId, openWith, root],
  );

  const toggleSelected = useCallback((entry: SessionFileEntry) => {
    if (!isSelectableFile(entry)) return;
    modifierClick.current = { anchor: entry.path, range: [] };
    setSelected((current) => toggleFileSelection(current, entry.path));
  }, []);

  // Selection starts from a row, never from the header: the file you held or
  // chose "Select" for is the first one picked, so the mode never opens empty.
  const startSelection = useCallback(
    (entry: SessionFileEntry) => {
      if (mutating || driveActive || !isSelectableFile(entry)) return;
      modifierClick.current = { anchor: entry.path, range: [] };
      setSelected([entry.path]);
      setSelecting(true);
      void Haptics.selectionAsync();
    },
    [driveActive, mutating],
  );

  const endSelection = useCallback(() => {
    setSelecting(false);
    setSelected([]);
    modifierClick.current = { anchor: null, range: [] };
  }, []);

  const confirmDelete = useCallback(
    (
      paths: readonly string[],
      onDeleted: (deleted: readonly string[], complete: boolean) => void,
    ) => {
      if (mutating || paths.length === 0) return;
      const folder =
        paths.length === 1 &&
        entries.some((entry) => entry.path === paths[0] && entry.kind === 'directory');
      const batch = fileDeletionBatch(paths, (filePath) =>
        client.deleteSessionFile(sessionId, root, filePath),
      );
      confirm({
        title: folder
          ? 'Delete folder and its contents?'
          : paths.length === 1
            ? 'Delete file?'
            : `Delete ${paths.length} files?`,
        message: `${paths
          .slice(0, 5)
          .map((filePath) => fileNameFromPath(filePath))
          .join(
            '\n',
          )}\n\n${folder ? 'This permanently removes the folder and everything inside it.' : 'This permanently removes the selected files.'}`,
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: async () => {
          setMutating(true);
          const deleted = batch.deleted;
          try {
            await batch.run();
            onDeleted(deleted, true);
          } catch (error) {
            onDeleted(deleted, false);
            Alert.alert('Could not delete', error instanceof Error ? error.message : String(error));
            throw error;
          } finally {
            if (deleted.length) setReloadKey((key) => key + 1);
            setMutating(false);
          }
        },
      });
    },
    [client, confirm, entries, mutating, root, sessionId],
  );

  const deleteSelectedFiles = useCallback(() => {
    confirmDelete(selected, (deleted, complete) => {
      if (complete) endSelection();
      else setSelected((current) => current.filter((path) => !deleted.includes(path)));
    });
  }, [confirmDelete, endSelection, selected]);

  const closePreview = useCallback(() => {
    // Also drops a fetch still in flight, so leaving the preview can't be undone
    // a second later by a slow response.
    previewRequest.current += 1;
    setPreview(null);
    setPreviewLoading(false);
  }, []);

  const renameFile = useCallback(
    async (filePath: string, name: string) => {
      setMutating(true);
      try {
        const renamed = await client.renameSessionFile(sessionId, root, filePath, name);
        setPreview((current) =>
          current?.path === filePath ? { ...current, path: renamed.path } : current,
        );
        setRenaming(null);
        setReloadKey((key) => key + 1);
      } catch (err) {
        // A server from before worktree renames answers with the knowledge-only
        // refusal, which reads as nonsense on the Files tab.
        if (
          err instanceof VerityApiError &&
          err.status === 400 &&
          root === 'worktree' &&
          /only knowledge files/.test(err.message)
        ) {
          throw new Error('Update the Verity server to rename files here.');
        }
        throw err;
      } finally {
        setMutating(false);
      }
    },
    [client, root, sessionId],
  );

  const selectableEntries = useMemo(() => entries.filter(isSelectableFile), [entries]);
  const allSelected =
    selectableEntries.length > 0 &&
    selectableEntries.every((entry) => selected.includes(entry.path));

  const rememberModifiers = useCallback((held: ClickModifiers) => {
    modifiers.current = held;
  }, []);

  const forgetModifiers = useCallback(() => {
    modifiers.current = { shift: false, command: false };
  }, []);

  // What a press on a row means. A command- or shift-click selects — entering
  // selection mode on its own, so a Mac operator never has to find the header
  // toggle first — and anything else keeps the touch behaviour: pick the row in
  // selection mode, open it outside of one.
  const pressFileRow = useCallback(
    (entry: SessionFileEntry) => {
      if (mutating) return;
      // Consumed, not just read: every touch reports its own flags before its
      // press, so a press that finds a report left over is one that had no touch
      // behind it — VoiceOver activation, say — and must not inherit whatever was
      // held last. Touches that end in a drag or a scroll withdraw their own
      // report (see forgetModifiers), so nothing is left standing there either.
      const held = modifiers.current;
      modifiers.current = { shift: false, command: false };
      const next = selectionForModifierClick(
        { selected, ...modifierClick.current },
        entry,
        held,
        entries,
      );
      if (next) {
        modifierClick.current = { anchor: next.anchor, range: next.range };
        setSelected(next.selected);
        setSelecting(true);
        return;
      }
      if (selecting) {
        toggleSelected(entry);
        return;
      }
      openFile(entry);
    },
    [entries, mutating, openFile, selected, selecting, toggleSelected],
  );

  const downloadUrlFor = useCallback(
    (filePath: string) => client.sessionFileDownloadUrl(sessionId, filePath, root),
    [client, root, sessionId],
  );

  // Every row needs its own drag payload, and each selected row's payload is the
  // same ordered selection — so it is built once here rather than per row, which
  // would be quadratic in the size of the selection.
  const dragItemsByPath = useMemo(() => {
    const chosen = new Set(selected);
    const anySelected = entries.find((entry) => isSelectableFile(entry) && chosen.has(entry.path));
    const selectionItems = anySelected
      ? dragItemsForRow(anySelected, selected, entries, downloadUrlFor)
      : [];
    const byPath = new Map<string, DragFileItem[]>();
    for (const entry of entries) {
      if (!isSelectableFile(entry)) continue;
      byPath.set(
        entry.path,
        chosen.has(entry.path)
          ? selectionItems
          : // An empty selection is the "row outside the selection" case, which
            // is exactly what an unselected row should drag.
            dragItemsForRow(entry, [], entries, downloadUrlFor),
      );
    }
    return byPath;
  }, [entries, selected, downloadUrlFor]);

  const editFile = async (filePath: string) => {
    if (mutating) return;
    setMutating(true);
    try {
      const file = await client.getSessionFileContent(sessionId, filePath, root);
      if (file.editable === false) throw new Error('This preview is read-only.');
      if (!file.version || !file.editable)
        throw new Error('Update the Verity server to edit text files.');
      setEditing(file);
    } catch (error) {
      Alert.alert('Could not edit file', error instanceof Error ? error.message : String(error));
    } finally {
      setMutating(false);
    }
  };
  const listSessionFolders = useCallback(
    async (folder: string): Promise<PickerEntry[]> =>
      (await client.listSessionFiles(sessionId, folder, root)).entries
        .filter((entry) => entry.kind === 'directory' || entry.kind === 'file')
        .map((entry) => ({ id: entry.path, name: entry.name, folder: entry.kind === 'directory' })),
    [client, root, sessionId],
  );

  // One menu for files and folders, in the explorer's fixed order; a folder
  // offers only what changes it. The open file adds Copy and Print, and drops
  // Open and Edit, which its header already has.
  const menuActions: FileAction[] = (() => {
    if (menuFor === null) return [];
    const entry = entries.find((candidate) => candidate.path === menuFor.path);
    const folder = entry?.kind === 'directory';
    const content = menuFor.inPreview ? preview : null;
    const changes = root !== 'drafts';
    return fileActions({
      open: !menuFor.inPreview && entry && !folder ? () => void openFile(entry) : undefined,
      // Offered only where it will do something: a file past the download
      // limit has a menu but cannot be selected (see isSelectableFile).
      select:
        !menuFor.inPreview && entry && isSelectableFile(entry)
          ? () => startSelection(entry)
          : undefined,
      // Chunked rendering means native text selection stops at each block, so
      // drag-selecting the whole file does not work — this copies the exact
      // content the server returned instead.
      copy: content
        ? () =>
            void Clipboard.setStringAsync(content.content)
              .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
              .catch((err: unknown) =>
                Alert.alert('Could not copy', err instanceof Error ? err.message : String(err)),
              )
        : undefined,
      export: content && Platform.OS !== 'web' ? () => chooseExport(content) : undefined,
      openWith: !folder ? () => openWith(menuFor.path) : undefined,
      edit:
        !folder &&
        root !== 'sources' &&
        changes &&
        isTextPreviewCandidate(menuFor.path) &&
        !menuFor.inPreview
          ? () => void editFile(menuFor.path)
          : undefined,
      // A Wiki page is renamed from the Knowledge page, which keeps the links
      // other pages hold to it; this route would leave them pointing nowhere.
      rename:
        changes && !wikiRoot(root, menuFor.path) ? () => setRenaming(menuFor.path) : undefined,
      // Knowledge moves from its library page, whose rules keep Decisions and
      // the Sources import folders in place; here only Code moves.
      move: changes && root === 'worktree' ? () => setMoving([menuFor.path]) : undefined,
      delete: changes
        ? () =>
            confirmDelete([menuFor.path], (deleted) => {
              if (deleted.length === 0) return;
              setSelected((current) => current.filter((path) => !deleted.includes(path)));
              if (menuFor.inPreview) closePreview();
            })
        : undefined,
    });
  })();

  const restoreCodeWorkspace = (): void => {
    setRestore({ running: true, failure: null });
    void client.restoreSessionCodeWorkspace(sessionId).then(
      () => {
        setRestore({ running: false, failure: null });
        setCodeMissing(false);
        setCodeAvailable(true);
        setReloadKey((key) => key + 1);
      },
      (err: unknown) =>
        setRestore({ running: false, failure: err instanceof Error ? err.message : String(err) }),
    );
  };
  const navigateRoot = (candidate: typeof root): void => {
    if (mutating || (!driveActive && candidate === root && path === '')) return;
    previewRequest.current += 1;
    endSelection();
    setDriveActive(false);
    setRoot(candidate);
    setPath('');
    setEntries([]);
    setTruncated(false);
    setLoading(true);
    setPreview(null);
    setPreviewLoading(false);
    setError(null);
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.flex}>
        <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityRole="button">
          <View />
        </Pressable>
        <ResizableSheetPanel>
          {!preview ? (
            selecting ? (
              <FileSheetHeader
                leading={
                  <HeaderTextButton
                    label={allSelected ? 'Select None' : 'Select All'}
                    disabled={mutating}
                    onPress={() => {
                      modifierClick.current = { anchor: null, range: [] };
                      setSelected(allSelected ? [] : selectableEntries.map((entry) => entry.path));
                    }}
                  />
                }
                title={selected.length > 0 ? selectionSummary(selected.length) : 'Select files'}
                trailing={
                  // Text, not a glyph: the old toggle turned into an X beside the X
                  // that closes the sheet, and nobody could tell which ended what.
                  <HeaderTextButton
                    label="Done"
                    emphasis="strong"
                    disabled={mutating}
                    accessibilityLabel="Done selecting files"
                    onPress={endSelection}
                  />
                }
              />
            ) : (
              <FileSheetHeader
                title="Files"
                trailing={
                  <>
                    {/* One way in to adding, as in every file app's toolbar. Selecting
                      is not up here: a long press on a row starts it, as does
                      "Select" in the row's menu, so the bar stays two glyphs. */}
                    <HeaderIconButton
                      icon="plus"
                      tint
                      busy={uploading}
                      disabled={
                        mutating ||
                        root === 'drafts' ||
                        error !== null ||
                        (driveActive && (drive.unconfigured || !drive.canWrite || !drive.parentId))
                      }
                      accessibilityLabel={
                        driveActive && !drive.canWrite
                          ? 'Google Drive is read-only'
                          : 'New or upload files'
                      }
                      onPress={() => setAdding(true)}
                    />
                    <HeaderIconButton icon="x" accessibilityLabel="Close files" onPress={onClose} />
                  </>
                }
              />
            )
          ) : null}
          {!preview ? (
            <FileRootTabs
              codeIcon={FILE_ROOT_ICON.worktree}
              codeActive={!driveActive && root === 'worktree'}
              codeDisabled={documentSession || (!codeAvailable && !codeMissing)}
              driveActive={driveActive}
              drive={Boolean(projectId)}
              disabled={mutating}
              onCode={() => navigateRoot('worktree')}
              onDrive={() => {
                previewRequest.current += 1;
                endSelection();
                setDriveActive(true);
                setLoading(true);
                setPreview(null);
                setError(null);
              }}
            />
          ) : null}
          {preview ? null : driveActive ? (
            (drive.links.length > 1 ? drive.path.length > 0 : drive.path.length > 1) ? (
              <FileBreadcrumb
                rootIcon="hard-drive"
                rootLabel={
                  drive.links.length > 1 ? 'Google Drive' : (drive.path[0]?.name ?? 'Google Drive')
                }
                segments={(drive.links.length > 1 ? drive.path : drive.path.slice(1)).map(
                  ({ id, name }) => ({ key: id, name }),
                )}
                disabled={mutating}
                onNavigate={(index) =>
                  drive.setPath((current) =>
                    current.slice(0, index + (drive.links.length > 1 ? 1 : 2)),
                  )
                }
              />
            ) : null
          ) : path ? (
            // At the top of a tab the tab itself says where you are; a breadcrumb
            // of nothing but the root would be a control with nowhere to go.
            <FileBreadcrumb
              rootIcon={FILE_ROOT_ICON[root]}
              rootLabel={rootLabel(root, documentSession)}
              segments={breadcrumbSegments(path).map((segment) => ({
                key: segment.path,
                name: segment.name,
              }))}
              disabled={mutating || selecting}
              onNavigate={(index) =>
                setPath(index < 0 ? '' : breadcrumbSegments(path)[index]!.path)
              }
            />
          ) : null}
          {!driveActive ? (
            <WikiDetails
              root={root}
              documentSession={documentSession}
              status={documentStatus}
              error={error}
              hasConflicts={
                root === 'documents' && !path && entries.some((entry) => entry.name === 'Conflicts')
              }
              disabled={mutating}
              navigate={navigateRoot}
            />
          ) : null}
          {driveActive ? (
            <ScrollView style={styles.filesList}>
              {error ? <Text style={styles.sheetError}>{error}</Text> : null}
              {drive.unconfigured && projectId ? (
                <View style={styles.driveSetupNotice}>
                  <Icon name="hard-drive" size={28} color={theme.colors.textFaint} />
                  <Text style={styles.emptyTitle}>No Google Drive folder</Text>
                  <Text style={styles.emptySubtitle}>
                    Connect a folder in the project settings to use its documents in this project.
                  </Text>
                  <Pressable
                    onPress={() => {
                      onClose();
                      router.push({
                        pathname: '/project/[id]/settings/services',
                        params: { id: projectId, section: 'drive' },
                      });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Open project settings to connect Google Drive"
                    style={({ pressed }) => [
                      styles.driveSetupButton,
                      pressed ? styles.driveSetupButtonPressed : null,
                    ]}
                  >
                    <Text style={styles.driveSetupButtonLabel}>Connect a folder</Text>
                  </Pressable>
                </View>
              ) : loading ? (
                <View style={styles.sheetLoading}>
                  <ActivityIndicator color={theme.colors.textMuted} />
                </View>
              ) : drive.entries.length === 0 && !error ? (
                <Text style={styles.sheetEmpty}>This folder is empty.</Text>
              ) : (
                drive.entries.map((file) => {
                  const folder = isDriveFolder(file);
                  const overview = isDriveOverviewEntry(file);
                  const enter = () =>
                    drive.setPath((current) => [...current, { id: file.id, name: file.name }]);
                  const menu = () => setDriveMenuFor(file);
                  return (
                    <ExplorerRow
                      key={file.id}
                      name={file.name}
                      icon={folder ? 'folder' : 'file'}
                      meta={overview ? undefined : driveEntryMeta(file)}
                      disabled={mutating}
                      deleteLabel="Move to trash"
                      onPress={
                        folder ? enter : file.webViewLink ? () => drive.openInDrive(file) : menu
                      }
                      onMenu={overview ? undefined : menu}
                      onDelete={!overview && drive.canWrite ? () => drive.trash(file) : undefined}
                    />
                  );
                })
              )}
            </ScrollView>
          ) : preview ? (
            <View style={styles.filesPreviewWrap}>
              <FileSheetHeader
                leading={
                  <HeaderIconButton
                    icon="chevron-left"
                    accessibilityLabel="Back to file list"
                    onPress={closePreview}
                  />
                }
                title={fileNameFromPath(preview.path)}
                subtitle={parentPath(preview.path) || null}
                trailing={
                  <>
                    {preview.editable && preview.version ? (
                      <HeaderTextButton
                        label="Edit"
                        disabled={mutating}
                        onPress={() => setEditing(preview)}
                      />
                    ) : null}
                    <HeaderIconButton
                      icon="more-horizontal"
                      disabled={mutating}
                      accessibilityLabel={`More actions for ${fileNameFromPath(preview.path)}`}
                      onPress={() => setMenuFor({ path: preview.path, inPreview: true })}
                    />
                    <HeaderIconButton icon="x" accessibilityLabel="Close files" onPress={onClose} />
                  </>
                }
              />
              <FileContentPreview
                key={preview.path}
                path={preview.path}
                content={preview.content}
                listStyle={styles.filesPreview}
                bodyStyle={styles.filesPreviewBody}
                textStyle={styles.filesPreviewText}
                renderMarkdown={(item) =>
                  item.type === 'table' ? (
                    <MarkdownTable header={item.header} rows={item.rows} />
                  ) : item.type === 'code' ? (
                    <View style={styles.codeBlock}>
                      {item.lang ? <Text style={styles.codeLang}>{item.lang}</Text> : null}
                      <Text selectable style={styles.codeText}>
                        {item.content}
                      </Text>
                    </View>
                  ) : (
                    <MarkdownLine
                      line={item.content}
                      onOpenLocalFile={null}
                      onOpenAppLink={null}
                      sessionFileImageSource={null}
                      onOpenImage={() => {}}
                    />
                  )
                }
              />
            </View>
          ) : previewLoading ? (
            <View style={styles.sheetLoading}>
              <ActivityIndicator color={theme.colors.textMuted} />
            </View>
          ) : (
            <>
              {error &&
              root !== 'documents' &&
              root !== 'drafts' &&
              !(documentSession && root === 'worktree') ? (
                <Text style={styles.sheetError}>{error}</Text>
              ) : null}
              {truncated ? (
                <Text style={styles.sheetLimited}>Showing first 1000 entries</Text>
              ) : null}
              {loading ? (
                <View style={styles.sheetLoading}>
                  <ActivityIndicator color={theme.colors.textMuted} />
                </View>
              ) : codeMissing && root === 'worktree' ? (
                <CodeWorkspaceNotice
                  restoring={restore.running}
                  failure={restore.failure}
                  onRestore={restoreCodeWorkspace}
                  onOpenDocuments={projectId ? () => navigateRoot('documents') : undefined}
                />
              ) : (
                <DropZone
                  style={styles.filesDropZone}
                  enabled={!uploading && root !== 'drafts'}
                  maxFiles={MAX_DROPPED_UPLOADS}
                  maxFileBytes={MAX_DROPPED_UPLOAD_BYTES}
                  maxTotalBytes={MAX_DROPPED_UPLOAD_TOTAL_BYTES}
                  onFiles={uploadDroppedFiles}
                  onRejected={onUploadDropRejected}
                  onActiveChange={setDropActive}
                >
                  {/* A touch that turned into a scroll never reaches a press, so
                    the modifiers it reported have to be withdrawn here too. */}
                  <ScrollView style={styles.filesList} onScrollBeginDrag={forgetModifiers}>
                    {entries.length === 0 ? (
                      <Text style={styles.sheetEmpty}>
                        {error
                          ? 'Files could not be loaded. Reopen this view to try again.'
                          : 'No files'}
                      </Text>
                    ) : (
                      entries.map((entry) => {
                        const meta = fileEntryMeta(entry);
                        const selectable = isSelectableFile(entry);
                        const picked = selectable && selected.includes(entry.path);
                        // In selection mode only files respond: a directory has
                        // nothing to select, and navigating away would discard the
                        // selection you are still building.
                        const inert = selecting
                          ? !selectable
                          : entry.kind === 'symlink' || entry.kind === 'other';
                        return (
                          <DragSource
                            key={entry.path}
                            // Every row stays draggable while selecting: grabbing
                            // one outside the selection drags just that file, the
                            // same as Finder. `items` already encodes which.
                            enabled={!isDemoMode()}
                            items={dragItemsByPath.get(entry.path) ?? []}
                            authorization={authorization}
                            tlsPin={directTlsPin ?? ''}
                            origin={baseUrl}
                            // The selection has done its job once the files land
                            // somewhere; leaving it up would strand the sheet in a
                            // mode you have to dismiss by hand. A row dragged from
                            // outside the selection did not carry it, so it leaves
                            // the selection alone.
                            onDelivered={selecting && picked ? endSelection : undefined}
                            onModifiers={rememberModifiers}
                          >
                            <ExplorerRow
                              name={entry.name}
                              icon={fileIcon(entry)}
                              meta={meta}
                              selecting={selecting}
                              picked={picked}
                              inert={inert}
                              disabled={mutating}
                              onPress={() => pressFileRow(entry)}
                              // Not on iPad, where a long press is the lift that
                              // starts a native drag (UIDragInteraction is off on
                              // iPhone by default); both firing at ~500 ms would
                              // race. There the row menu and ⌘-click remain.
                              onLongPress={
                                !selecting && selectable && !longPressDrags
                                  ? () => startSelection(entry)
                                  : undefined
                              }
                              onMenu={() => setMenuFor({ path: entry.path, inPreview: false })}
                              onDelete={
                                root !== 'drafts' &&
                                (entry.kind === 'file' || entry.kind === 'directory')
                                  ? () => confirmDelete([entry.path], () => undefined)
                                  : undefined
                              }
                            />
                          </DragSource>
                        );
                      })
                    )}
                  </ScrollView>
                  {dropActive ? (
                    <View pointerEvents="none" style={styles.filesDropHint}>
                      <Icon name="download" size={18} color={theme.colors.action} />
                      <Text style={styles.filesDropHintText}>Drop to upload to /{path}</Text>
                    </View>
                  ) : null}
                </DropZone>
              )}
              {selecting ? (
                <SelectionBar
                  count={selected.length}
                  disabled={root === 'drafts' || mutating}
                  onMove={root === 'worktree' ? () => setMoving(selected) : undefined}
                  onDelete={deleteSelectedFiles}
                />
              ) : null}
            </>
          )}
          {confirmSheet}
          {menuFor ? (
            <FileActionMenu
              title={fileNameFromPath(menuFor.path)}
              actions={menuActions}
              onDismiss={() => setMenuFor(null)}
            />
          ) : null}
          {driveMenuFor ? (
            <FileActionMenu
              title={driveMenuFor.name}
              actions={drive.actionsFor(driveMenuFor, {
                rename: () => setDriveRenaming(driveMenuFor),
                move: () => setDriveMoving([driveMenuFor]),
              })}
              onDismiss={() => setDriveMenuFor(null)}
            />
          ) : null}
          {adding ? (
            <FileActionMenu
              title="Add files"
              onDismiss={() => setAdding(false)}
              actions={
                driveActive
                  ? addFileActions({ folder: () => setNaming(true), upload: drive.upload })
                  : addFileActions({
                      create: root === 'sources' ? undefined : () => setCreating(true),
                      // Shared knowledge is managed from Settings, not a session.
                      folder: root === 'shared' ? undefined : () => setNaming(true),
                      upload: uploadFiles,
                    })
              }
            />
          ) : null}
          {naming ? (
            <FileNameDialog
              title="New folder"
              initialName="New folder"
              allowUnchanged
              confirmLabel="Create"
              validate={(name) =>
                fileNameProblem(
                  name,
                  driveActive
                    ? drive.entries.map((file) => file.name)
                    : entries.map((entry) => entry.name),
                )
              }
              onCancel={() => setNaming(false)}
              onSubmit={async (name) => {
                if (driveActive) {
                  if (drive.parentId) await drive.createFolder(drive.parentId, name);
                } else await client.createSessionFolder(sessionId, writableRoot(root), path, name);
                setNaming(false);
                reload();
              }}
            />
          ) : null}
          {creating ? (
            <FileNameDialog
              title="New Markdown file"
              initialName="note.md"
              allowUnchanged
              confirmLabel="Create"
              validate={(name) =>
                renameProblem(
                  name,
                  '',
                  entries.map((entry) => entry.name),
                ) ?? (!/\.md$/i.test(name) ? 'Use a .md extension.' : null)
              }
              onCancel={() => setCreating(false)}
              onSubmit={async (name) => {
                setCreating(false);
                setEditing({
                  path: [path, name].filter(Boolean).join('/'),
                  content: '',
                  size: 0,
                  editable: true,
                });
              }}
            />
          ) : null}
          {editing ? (
            <FileTextEditor
              file={editing}
              onCancel={() => setEditing(null)}
              onRead={(filePath) => client.getSessionFileContent(sessionId, filePath, root)}
              onHistory={() => client.listSessionFileVersions(sessionId, root, editing.path)}
              onVersion={(version) =>
                client.readSessionFileVersion(sessionId, root, editing.path, version)
              }
              onSave={(filePath, content, version) =>
                client.saveSessionFileContent(sessionId, root, filePath, content, version)
              }
              onSaved={(file) => {
                if (file.warning) Alert.alert('File saved', file.warning);
                setEditing(null);
                setPreview(file);
                setPath(parentPath(file.path));
                setReloadKey((key) => key + 1);
              }}
            />
          ) : null}
          {renaming ? (
            <FileNameDialog
              title="Rename"
              subtitle={parentPath(renaming) ? `in /${parentPath(renaming)}` : undefined}
              initialName={fileNameFromPath(renaming)}
              confirmLabel="Rename"
              validate={(name) =>
                renameProblem(
                  name,
                  fileNameFromPath(renaming),
                  entries.filter((entry) => entry.path !== renaming).map((entry) => entry.name),
                )
              }
              onSubmit={(name) => renameFile(renaming, name)}
              onCancel={() => setRenaming(null)}
            />
          ) : null}
          {driveRenaming ? (
            <FileNameDialog
              title="Rename"
              initialName={driveRenaming.name}
              confirmLabel="Rename"
              validate={(name) =>
                fileNameProblem(
                  name,
                  drive.entries
                    .filter((file) => file.id !== driveRenaming.id)
                    .map((file) => file.name),
                )
              }
              onSubmit={async (name) => {
                await drive.rename(driveRenaming, name);
                setDriveRenaming(null);
              }}
              onCancel={() => setDriveRenaming(null)}
            />
          ) : null}
          {moving ? (
            <FolderPicker
              title={moveTitle(moving.length)}
              root={{ id: '', label: rootLabel(root, documentSession), icon: FILE_ROOT_ICON[root] }}
              start={breadcrumbSegments(path).map((segment) => ({
                id: segment.path,
                name: segment.name,
                folder: true,
              }))}
              current={path}
              list={listSessionFolders}
              excluded={(id) => moving.some((moved) => id === moved || id.startsWith(`${moved}/`))}
              createFolder={async (parent, name) => {
                const created = await client.createSessionFolder(
                  sessionId,
                  writableRoot(root),
                  parent,
                  name,
                );
                return { id: created.path, name, folder: true };
              }}
              onPick={async (destination) => {
                // One move per entry: whatever moved before a failure is listed
                // in its new place, and leaves the selection, before the error shows.
                try {
                  for (const moved of moving) {
                    await client.moveSessionFile(sessionId, {
                      root,
                      path: moved,
                      toRoot: root,
                      toPath: destination,
                    });
                    // A retry after a failure moves only what is still left.
                    setMoving((current) => current?.filter((path) => path !== moved) ?? null);
                  }
                  setMoving(null);
                  closePreview();
                } finally {
                  endSelection();
                  reload();
                }
              }}
              onCancel={() => setMoving(null)}
            />
          ) : null}
          {driveMoving && drive.link ? (
            <FolderPicker
              title={moveTitle(driveMoving.length)}
              root={{ id: drive.link.folderId, label: drive.link.name, icon: 'hard-drive' }}
              start={drive.path
                .filter((part) => !isDriveOverviewEntry({ ...part, mimeType: '' }))
                .map((part) => ({ ...part, folder: true }))}
              current={drive.parentId ?? drive.link.folderId}
              list={drive.listFolders}
              excluded={(id) => driveMoving.some((file) => file.id === id)}
              createFolder={drive.createFolder}
              onPick={async (destination) => {
                await drive.move(driveMoving, destination);
                setDriveMoving(null);
              }}
              onCancel={() => setDriveMoving(null)}
            />
          ) : null}
        </ResizableSheetPanel>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** What a root is called at the start of its breadcrumb and in the folder picker. */
function rootLabel(root: SessionFileRoot, documentSession: boolean): string {
  if (root === 'worktree') return documentSession ? 'My edits' : 'Code';
  if (root === 'sources') return 'Sources';
  if (root === 'documents') return 'Wiki';
  if (root === 'drafts') return 'Session edits';
  return root === 'knowledge' ? 'Project' : 'Global';
}

function moveTitle(count: number): string {
  return count === 1 ? 'Move 1 item' : `Move ${count} items`;
}

const DRIVE_KINDS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Docs',
  'application/vnd.google-apps.spreadsheet': 'Google Sheets',
  'application/vnd.google-apps.presentation': 'Google Slides',
};

/** The line under a Drive entry: its kind where Drive names it, and its date. */
function driveEntryMeta(file: DriveFile): string | undefined {
  const date = file.modifiedTime
    ? new Date(file.modifiedTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : undefined;
  return [DRIVE_KINDS[file.mimeType], date].filter(Boolean).join(' · ') || undefined;
}

/** Session edits are only read here; nothing offers a change in them. */
function writableRoot(root: SessionFileRoot): Exclude<SessionFileRoot, 'drafts'> {
  if (root === 'drafts') throw new Error('Session edits are read-only here.');
  return root;
}

/** Whether `path` of `root` lies in a project Wiki, whose links follow a rename. */
function wikiRoot(root: SessionFileRoot, path: string): boolean {
  return root === 'documents' || (root === 'knowledge' && path.startsWith('insights/'));
}
