import {
  isDriveFolder,
  type DriveFile,
  type ProjectDriveFolder,
  type VerityClient,
} from '@verity/mobile';
import { File as FsFile } from 'expo-file-system';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking } from 'react-native';

import { pickSessionFiles } from '../../../lib/attachments';
import { driveOverview, singleDriveFolderPath } from '../../../lib/driveHierarchy';
import { ensureGoogleWorkspaceAccess } from '../../../lib/googleDrive';
import type { ConfirmRequest } from '../../ui';
import type { FileAction } from '../FileActionMenu';
import type { PickerEntry } from '../explorer/FolderPicker';
import { fileActions } from '../explorer/fileActions';

const CHAT_MIME = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** A pseudo-entry of the overview of several Drive links or accounts. */
export const isDriveOverviewEntry = (file: DriveFile) =>
  file.id.startsWith('link:') || file.id.startsWith('account:');

/**
 * The Google Drive tab of a session's Files: the project's linked folders, the
 * folder being browsed and what can be done with an entry. Its rows use the
 * same explorer row and menu as Code; this holds only what Drive does
 * differently — versions on every change, a trash instead of deletion.
 */
export function useSessionDrive({
  client,
  projectId,
  sessionId,
  active,
  reloadKey,
  reload,
  mutating,
  setMutating,
  setUploading,
  setLoading,
  setError,
  confirm,
  onClose,
}: {
  client: VerityClient;
  projectId: string | null;
  sessionId: string;
  active: boolean;
  reloadKey: number;
  reload: () => void;
  mutating: boolean;
  setMutating: (value: boolean) => void;
  setUploading: (value: boolean) => void;
  setLoading: (value: boolean) => void;
  setError: (value: string | null) => void;
  confirm: (request: ConfirmRequest) => void;
  onClose: () => void;
}) {
  const [canWrite, setCanWrite] = useState(false);
  const [links, setLinks] = useState<ProjectDriveFolder[]>([]);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [path, setPath] = useState<Array<{ id: string; name: string }>>([]);
  const [entries, setEntries] = useState<DriveFile[]>([]);
  const [unconfigured, setUnconfigured] = useState(false);
  const link = links.find((candidate) => candidate.id === linkId);
  const accountId = link?.accountId;
  /** The Drive folder being listed, or undefined in the overview. */
  const parentId = (() => {
    if (!link) return undefined;
    const last = path.at(-1)?.id;
    return !last || last.startsWith('link:') ? link.folderId : last;
  })();

  useEffect(() => {
    if (!active || !projectId) return;
    let live = true;
    const load = async (): Promise<void> => {
      setCanWrite(false);
      setLoading(true);
      setError(null);
      setUnconfigured(false);
      try {
        const next = await client.listProjectDriveFolders(projectId);
        if (!live) return;
        setLinks(next);
        if (next.length === 0) {
          if (path.length) setPath([]);
          setEntries([]);
          setLinkId(null);
          setUnconfigured(true);
          return;
        }
        let trail = path;
        if (next.length === 1 && !trail.some((part) => part.id.startsWith('link:'))) {
          trail = singleDriveFolderPath(next);
          setPath(trail);
        }
        const selectedId = trail.find((part) => part.id.startsWith('link:'))?.id.slice(5);
        const selected = next.find((candidate) => candidate.id === selectedId);
        if (!selected) {
          if (selectedId) {
            setPath([]);
            return;
          }
          const account = trail.find((part) => part.id.startsWith('account:'))?.id.slice(8);
          setLinkId(null);
          if (account && !next.some((candidate) => candidate.accountId === account)) {
            setPath([]);
            return;
          }
          setEntries(driveOverview(next, account));
          return;
        }
        setLinkId(selected.id);
        setCanWrite(selected.accessMode === 'read-write');
        const last = trail.at(-1)?.id;
        const parent = !last || last.startsWith('link:') ? selected.folderId : last;
        const page = await client.listProjectGoogleDriveFiles(projectId, selected.id, {
          parentId: parent,
        });
        if (live) setEntries(page.files);
      } catch (caught) {
        if (live) {
          setEntries([]);
          setError(message(caught));
        }
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    return () => {
      live = false;
    };
    // The setters are stable; listing again for them would only repeat the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, active, path, projectId, reloadKey]);

  const run = useCallback(
    (title: string, work: () => Promise<void>) => {
      setMutating(true);
      void work()
        .catch((caught: unknown) => Alert.alert(title, message(caught)))
        .finally(() => setMutating(false));
    },
    [setMutating],
  );

  const upload = useCallback(() => {
    if (!projectId || !linkId || !canWrite || parentId === undefined) return;
    void (async () => {
      let picked: Awaited<ReturnType<typeof pickSessionFiles>> = [];
      try {
        picked = await pickSessionFiles();
        if (picked.length === 0) return;
        setUploading(true);
        for (const file of picked) {
          await client.uploadProjectGoogleDriveFile(projectId, linkId, {
            parentId,
            fileName: file.fileName,
            mimeType: 'application/octet-stream',
            data: new FsFile(file.uri),
          });
        }
        reload();
      } catch (caught) {
        Alert.alert('Could not upload file', message(caught));
      } finally {
        for (const file of picked) {
          try {
            new FsFile(file.uri).delete();
          } catch {
            // Best effort cleanup of the document picker cache copy.
          }
        }
        setUploading(false);
      }
    })();
  }, [canWrite, client, linkId, parentId, projectId, reload, setUploading]);

  /** Every change to a Drive file names the version it was made against. */
  const version = useCallback(
    async (file: DriveFile) => {
      if (!projectId || !linkId) throw new Error('No Google Drive folder is open.');
      const snapshot = await client.getProjectGoogleDriveFile(projectId, linkId, file.id);
      if (!snapshot.version)
        throw new Error('This file has no version. Reload the folder and try again.');
      return snapshot.version;
    },
    [client, linkId, projectId],
  );

  const trash = useCallback(
    (file: DriveFile) => {
      if (!projectId || !linkId || !canWrite || mutating) return;
      void version(file).then(
        (expectedVersion) =>
          confirm({
            title: 'Move to Google Drive trash?',
            message: `${file.name}\n\n${isDriveFolder(file) ? 'The folder and its contents will be moved to the trash.' : 'The file will be moved to the trash.'}`,
            confirmLabel: 'Move to trash',
            destructive: true,
            onConfirm: async () => {
              setMutating(true);
              try {
                await client.trashProjectGoogleDriveFile(
                  projectId,
                  linkId,
                  file.id,
                  expectedVersion,
                );
                reload();
              } catch (caught) {
                Alert.alert('Could not delete', message(caught));
                throw caught;
              } finally {
                setMutating(false);
              }
            },
          }),
        (caught: unknown) => setError(message(caught)),
      );
    },
    [
      canWrite,
      client,
      confirm,
      linkId,
      mutating,
      projectId,
      reload,
      setError,
      setMutating,
      version,
    ],
  );

  const rename = useCallback(
    async (file: DriveFile, name: string) => {
      if (!projectId || !linkId) return;
      await client.updateProjectGoogleDriveFile(projectId, linkId, file.id, {
        expectedVersion: await version(file),
        name,
      });
      reload();
    },
    [client, linkId, projectId, reload, version],
  );

  const move = useCallback(
    async (files: readonly DriveFile[], destination: string) => {
      if (!projectId || !linkId) return;
      try {
        for (const file of files)
          await client.updateProjectGoogleDriveFile(projectId, linkId, file.id, {
            expectedVersion: await version(file),
            parentId: destination,
          });
      } finally {
        // What moved before a failure is listed in its new place.
        reload();
      }
    },
    [client, linkId, projectId, reload, version],
  );

  const createFolder = useCallback(
    async (parent: string, name: string): Promise<PickerEntry> => {
      if (!projectId || !linkId) throw new Error('No Google Drive folder is open.');
      const created = await client.createProjectGoogleDriveFolder(projectId, linkId, {
        parentId: parent,
        name,
      });
      return { id: created.id, name: created.name, folder: true };
    },
    [client, linkId, projectId],
  );

  const listFolders = useCallback(
    async (parent: string): Promise<PickerEntry[]> => {
      if (!projectId || !linkId) return [];
      const page = await client.listProjectGoogleDriveFiles(projectId, linkId, {
        parentId: parent,
      });
      return page.files.map((file) => ({
        id: file.id,
        name: file.name,
        folder: isDriveFolder(file),
      }));
    },
    [client, linkId, projectId],
  );

  const useInChat = useCallback(
    (file: DriveFile) =>
      run('Could not use file in chat', async () => {
        if (!linkId) return;
        if (!(await ensureGoogleWorkspaceAccess(client, file.mimeType, accountId))) return;
        await client.assignSessionGoogleWorkspaceFile(sessionId, file.id, accountId, linkId);
        onClose();
      }),
    [accountId, client, linkId, onClose, run, sessionId],
  );

  const addToKnowledge = useCallback(
    (file: DriveFile) =>
      run('Could not add file', async () => {
        if (!projectId || !linkId) return;
        const result = await client.importProjectGoogleDriveFile(projectId, linkId, file.id);
        Alert.alert('Added to Project Knowledge', result.path);
      }),
    [client, linkId, projectId, run],
  );

  /** A file opens where it lives; the rest of what it offers is in its menu. */
  const openInDrive = useCallback((file: DriveFile) => {
    if (file.webViewLink) void Linking.openURL(file.webViewLink);
  }, []);

  /** The row menu: Drive's own actions first, then the explorer's. */
  const actionsFor = useCallback(
    (file: DriveFile, handlers: { rename: () => void; move: () => void }): FileAction[] => {
      const folder = isDriveFolder(file);
      return [
        ...(!folder && file.webViewLink
          ? [
              {
                key: 'open',
                label: 'Open in Google Drive',
                icon: 'external-link' as const,
                onPress: () => openInDrive(file),
              },
            ]
          : []),
        ...(!folder && CHAT_MIME.has(file.mimeType)
          ? [
              {
                key: 'chat',
                label: 'Use in this chat',
                icon: 'message-circle' as const,
                onPress: () => useInChat(file),
              },
            ]
          : []),
        ...(!folder
          ? [
              {
                key: 'import',
                label: 'Add to Project Knowledge',
                icon: 'book-open' as const,
                onPress: () => addToKnowledge(file),
              },
            ]
          : []),
        ...fileActions(
          canWrite
            ? { rename: handlers.rename, move: handlers.move, trash: () => trash(file) }
            : {},
        ),
      ];
    },
    [addToKnowledge, canWrite, openInDrive, trash, useInChat],
  );

  return {
    links,
    link,
    linkId,
    path,
    setPath,
    parentId,
    entries,
    canWrite,
    unconfigured,
    upload,
    trash,
    rename,
    move,
    createFolder,
    listFolders,
    openInDrive,
    actionsFor,
  };
}
