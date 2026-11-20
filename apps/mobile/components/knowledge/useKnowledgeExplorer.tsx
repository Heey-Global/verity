import type { SessionFileEntry, VerityClient } from '@verity/mobile';
import { File as FsFile } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';

import { pickSessionFiles } from '../../lib/attachments';
import { getVerityBaseUrl } from '../../lib/client';
import { isTextPreviewCandidate } from '../../lib/fileSelection';
import { breadcrumbSegments, parentPath } from '../../lib/sessionFileUi';
import { FileActionMenu } from '../files/FileActionMenu';
import { FileNameDialog } from '../files/FileNameDialog';
import { FolderPicker, type PickerEntry } from '../files/explorer/FolderPicker';
import { addFileActions, fileActions, fileNameProblem } from '../files/explorer/fileActions';
import { useFileExport } from '../files/session/useFileExport';
import { useConfirm } from '../ui';
import {
  canAddToKnowledgeFolder,
  canChangeKnowledgeEntry,
  canMoveInto,
  isWikiPage,
  knowledgeArea,
} from './knowledgeRules';
import {
  createKnowledgeFolder,
  deleteKnowledge,
  downloadKnowledge,
  knowledgeBacklinks,
  knowledgeDownloadUrl,
  listKnowledge,
  moveKnowledge,
  pushKnowledge,
  readKnowledge,
  renameKnowledge,
  uploadKnowledge,
  writeKnowledge,
  type KnowledgeScope,
} from './knowledgeScope';
import { useKnowledgePane } from './KnowledgePane';
import { invalidateWikiCatalog } from './useWikiCatalog';

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));
const name = (path: string) => path.split('/').at(-1) ?? path;

/**
 * What the explorer does in a knowledge library — Shared or a project's — with
 * the same actions, menus and dialogs as a session's Files: the row menu, the
 * + menu, selecting, Move… through the folder picker, and the confirmation
 * before a Wiki page that other pages link to moves. `overlays` draws them.
 */
export function useKnowledgeExplorer({
  client,
  scope,
  folder,
  entries,
  reload,
  onOpenFolder,
  onOpenFile,
}: {
  client: VerityClient;
  scope: KnowledgeScope;
  folder: string;
  entries: readonly SessionFileEntry[];
  reload: () => void;
  onOpenFolder: (folder: string) => void;
  onOpenFile: (file: string) => void;
}) {
  const [confirm, confirmSheet] = useConfirm();
  // An open file follows its rename or move, in the wide layout's other column.
  const pane = useKnowledgePane();
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<SessionFileEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState<'folder' | 'page' | null>(null);
  const [renaming, setRenaming] = useState<SessionFileEntry | null>(null);
  const [moving, setMoving] = useState<readonly string[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const names = entries.map((entry) => entry.name);
  const canAdd = canAddToKnowledgeFolder(folder);

  const changed = useCallback(() => {
    if (scope.kind === 'project') invalidateWikiCatalog(scope.projectId);
    reload();
  }, [reload, scope]);

  const { openWith } = useFileExport({
    baseUrl: getVerityBaseUrl() ?? '',
    cacheKey: scope.kind === 'project' ? `knowledge-${scope.projectId}` : 'knowledge-shared',
    downloadUrl: (path) => knowledgeDownloadUrl(client, scope, path),
    download: (path) => downloadKnowledge(client, scope, path),
    readText: (path) => readKnowledge(client, scope, path),
  });

  const endSelection = useCallback(() => {
    setSelecting(false);
    setSelected([]);
  }, []);

  const startSelection = useCallback((entry: SessionFileEntry) => {
    if (entry.kind !== 'file') return;
    setSelected([entry.path]);
    setSelecting(true);
    void Haptics.selectionAsync();
  }, []);

  const toggle = useCallback((entry: SessionFileEntry) => {
    if (entry.kind !== 'file') return;
    setSelected((current) =>
      current.includes(entry.path)
        ? current.filter((path) => path !== entry.path)
        : [...current, entry.path],
    );
  }, []);

  const remove = useCallback(
    (paths: readonly string[]) => {
      if (busy || paths.length === 0) return;
      const folderEntry =
        paths.length === 1 &&
        entries.some((entry) => entry.path === paths[0] && entry.kind === 'directory');
      confirm({
        title: folderEntry
          ? 'Delete folder and its contents?'
          : paths.length === 1
            ? 'Delete file?'
            : `Delete ${paths.length} files?`,
        message: `${paths.slice(0, 5).map(name).join('\n')}\n\n${folderEntry ? 'This permanently removes the folder and everything inside it.' : 'This permanently removes the selected files.'}`,
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: async () => {
          setBusy(true);
          try {
            for (const path of paths) {
              await deleteKnowledge(client, scope, path);
              // A retry after a failure must not ask for what is already gone.
              setSelected((current) => current.filter((selectedPath) => selectedPath !== path));
            }
            endSelection();
          } catch (caught) {
            Alert.alert('Could not delete', message(caught));
            throw caught;
          } finally {
            setBusy(false);
            changed();
          }
        },
      });
    },
    [busy, changed, client, confirm, endSelection, entries, scope],
  );

  /**
   * Runs `act` — a rename or a move — after `close` has put its dialog away, and
   * asks first when other Wiki pages link to what changes: their links follow.
   * The question waits for the dialog to fade out, as iOS presents no modal
   * while another is being dismissed.
   */
  const withLinkCheck = useCallback(
    async (
      paths: readonly string[],
      verb: 'Move' | 'Rename',
      target: string,
      close: () => void,
      work: () => Promise<void>,
    ) => {
      // The list holds still while entries move and their links are rewritten.
      const act = async () => {
        setBusy(true);
        try {
          await work();
        } finally {
          setBusy(false);
        }
      };
      // Wiki pages link to Sources too, and the server rewrites those links as well.
      const pages = paths.some((path) => knowledgeArea(path) !== null)
        ? (await Promise.all(paths.map((path) => knowledgeBacklinks(client, scope, path)))).flatMap(
            (result) => result.pages,
          )
        : [];
      const linking = new Set(
        pages
          .map((page) => page.path)
          // Pages inside a moved folder move with it; they are not other pages.
          .filter((page) => !paths.some((path) => page === path || page.startsWith(`${path}/`))),
      );
      if (linking.size === 0) {
        await act();
        close();
        return;
      }
      close();
      confirm({
        title:
          paths.length === 1 ? `${verb} “${name(paths[0]!)}”?` : `${verb} ${paths.length} items?`,
        message: `${linking.size === 1 ? '1 other page links' : `${linking.size} other pages link`} to ${paths.length === 1 ? 'it' : 'them'}. Their links will point to ${target}.`,
        confirmLabel: verb,
        afterSheet: true,
        onConfirm: async () => {
          try {
            await act();
          } catch (caught) {
            Alert.alert(`Could not ${verb.toLowerCase()}`, message(caught));
            throw caught;
          }
        },
      });
    },
    [client, confirm, scope],
  );

  const reportLinks = (results: readonly { warning?: string | undefined }[]) => {
    const warning = results.find((result) => result.warning)?.warning;
    if (warning) Alert.alert('Done', warning);
  };

  const upload = useCallback(() => {
    void (async () => {
      let picked: Awaited<ReturnType<typeof pickSessionFiles>> = [];
      try {
        picked = await pickSessionFiles();
        if (picked.length === 0) return;
        setBusy(true);
        for (const file of picked)
          await uploadKnowledge(client, scope, {
            path: folder,
            fileName: file.fileName,
            data: new FsFile(file.uri),
          });
      } catch (caught) {
        Alert.alert('Could not upload file', message(caught));
      } finally {
        for (const file of picked) {
          try {
            new FsFile(file.uri).delete();
          } catch {
            // Best effort; the OS may already have reaped the temporary copy.
          }
        }
        setBusy(false);
        if (picked.length > 0) changed();
      }
    })();
  }, [changed, client, folder, scope]);

  const listFolders = useCallback(
    async (parent: string): Promise<PickerEntry[]> =>
      (await listKnowledge(client, scope, parent)).entries
        .filter((entry) => entry.kind === 'directory' || entry.kind === 'file')
        .map((entry) => ({ id: entry.path, name: entry.name, folder: entry.kind === 'directory' })),
    [client, scope],
  );

  const actionsFor = (entry: SessionFileEntry) => {
    const file = entry.kind === 'file';
    const change = canChangeKnowledgeEntry(entry.path);
    return fileActions({
      open: () => (file ? onOpenFile(entry.path) : onOpenFolder(entry.path)),
      select: file ? () => startSelection(entry) : undefined,
      openWith: file ? () => openWith(entry.path) : undefined,
      edit:
        file && isWikiPage(entry.path) && change && isTextPreviewCandidate(entry.path)
          ? () => pushKnowledge(scope, { file: entry.path, edit: '1' })
          : undefined,
      rename: change ? () => setRenaming(entry) : undefined,
      move: change ? () => setMoving([entry.path]) : undefined,
      delete: change ? () => remove([entry.path]) : undefined,
    });
  };

  /** What a row hands the explorer row: its menu, the swipe's Delete, selecting. */
  const rowProps = (entry: SessionFileEntry) => {
    const change = canChangeKnowledgeEntry(entry.path);
    const selectable = entry.kind === 'file';
    return {
      selecting,
      picked: selected.includes(entry.path),
      inert: selecting && !selectable,
      disabled: busy,
      onLongPress: !selecting && selectable ? () => startSelection(entry) : undefined,
      onMenu: () => setMenuFor(entry),
      onDelete: change ? () => remove([entry.path]) : undefined,
      /** In selection mode a press picks the row instead of opening it. */
      press: selecting ? () => toggle(entry) : undefined,
    };
  };

  const area = knowledgeArea(folder);
  const overlays: ReactNode = (
    <>
      {confirmSheet}
      {menuFor ? (
        <FileActionMenu
          title={menuFor.name}
          actions={actionsFor(menuFor)}
          onDismiss={() => setMenuFor(null)}
        />
      ) : null}
      {adding ? (
        <FileActionMenu
          title="Add files"
          onDismiss={() => setAdding(false)}
          actions={addFileActions({
            create: area === 'insights' ? () => setNaming('page') : undefined,
            folder: () => setNaming('folder'),
            upload,
          })}
        />
      ) : null}
      {naming ? (
        <FileNameDialog
          title={naming === 'page' ? 'New Markdown file' : 'New folder'}
          initialName={naming === 'page' ? 'note.md' : 'New folder'}
          allowUnchanged
          confirmLabel="Create"
          validate={(next) =>
            fileNameProblem(next, names) ??
            (naming === 'page' && !/\.md$/i.test(next) ? 'Use a .md extension.' : null)
          }
          onCancel={() => setNaming(null)}
          onSubmit={async (next) => {
            const path = [folder, next].filter(Boolean).join('/');
            if (naming === 'folder') await createKnowledgeFolder(client, scope, folder, next);
            else await writeKnowledge(client, scope, path, '', null);
            setNaming(null);
            changed();
            if (naming === 'page') pushKnowledge(scope, { file: path, edit: '1' });
          }}
        />
      ) : null}
      {renaming ? (
        <FileNameDialog
          title="Rename"
          subtitle={parentPath(renaming.path) ? `in /${parentPath(renaming.path)}` : undefined}
          initialName={renaming.name}
          confirmLabel="Rename"
          validate={(next) =>
            fileNameProblem(
              next,
              names.filter((other) => other !== renaming.name),
            )
          }
          onCancel={() => setRenaming(null)}
          onSubmit={async (next) => {
            const entry = renaming;
            const target = [parentPath(entry.path), next].filter(Boolean).join('/');
            await withLinkCheck(
              [entry.path],
              'Rename',
              target,
              () => setRenaming(null),
              async () => {
                const result = await renameKnowledge(client, scope, entry.path, next);
                pane?.moved?.(scope, entry.path, result.path);
                changed();
                reportLinks([result]);
              },
            );
          }}
        />
      ) : null}
      {moving && area ? (
        <FolderPicker
          title={moving.length === 1 ? 'Move 1 item' : `Move ${moving.length} items`}
          root={{
            id: area,
            label: area === 'insights' ? 'Wiki' : 'Sources',
            icon: area === 'insights' ? 'book-open' : 'paperclip',
          }}
          start={breadcrumbSegments(folder)
            .slice(1)
            .map((segment) => ({ id: segment.path, name: segment.name, folder: true }))}
          current={folder}
          list={listFolders}
          excluded={(id) => !canMoveInto(id, moving)}
          createFolder={async (parent, next) => {
            const created = await createKnowledgeFolder(client, scope, parent, next);
            return { id: created.path, name: next, folder: true };
          }}
          onPick={async (destination) => {
            const label =
              destination.split('/').slice(1).join('/') ||
              (area === 'insights' ? 'the Wiki' : 'Sources');
            const paths = moving;
            await withLinkCheck(
              paths,
              'Move',
              label,
              () => setMoving(null),
              async () => {
                const results = [];
                try {
                  for (const path of paths) {
                    const result = await moveKnowledge(client, scope, path, destination);
                    pane?.moved?.(scope, path, result.path);
                    results.push(result);
                    // A retry after a failure moves only what is still left.
                    setMoving((current) => current?.filter((moved) => moved !== path) ?? null);
                  }
                } finally {
                  // What moved before a failure is listed in its new place.
                  endSelection();
                  changed();
                }
                reportLinks(results);
              },
            );
          }}
          onCancel={() => setMoving(null)}
        />
      ) : null}
    </>
  );

  return {
    busy,
    canAdd,
    openAdd: () => setAdding(true),
    selecting,
    selected,
    selectableCount: useMemo(
      () => entries.filter((entry) => entry.kind === 'file').length,
      [entries],
    ),
    selectAll: () =>
      setSelected(
        selected.length === entries.filter((entry) => entry.kind === 'file').length
          ? []
          : entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path),
      ),
    endSelection,
    moveSelected: () => setMoving(selected),
    deleteSelected: () => remove(selected),
    canChangeSelected: selected.every(canChangeKnowledgeEntry),
    rowProps,
    openMenu: setMenuFor,
    remove,
    overlays,
  };
}
