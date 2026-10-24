import type { ProjectDriveFolder, VerityClient } from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { SettingsDisclosure, SettingsNavRow, SettingsToggleRow } from './SettingsChrome';
import { useGoogleAccountPicker, googleAccountSupports } from './GoogleAccountPicker';
import { useConfirm } from '../ui';

export function ProjectGoogleDriveFolders({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const [folders, setFolders] = useState<ProjectDriveFolder[]>([]);
  const [busy, setBusy] = useState(false);
  const [chooseAccount, accountSheet] = useGoogleAccountPicker();
  const [confirm, confirmSheet] = useConfirm();
  const reload = useCallback(async () => {
    setFolders(await client.listProjectDriveFolders(projectId));
  }, [client, projectId]);
  useFocusEffect(
    useCallback(() => {
      void reload().catch((error: unknown) =>
        Alert.alert('Could not load Drive folders', String(error)),
      );
    }, [reload]),
  );
  const perform = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      await reload();
    } catch (error) {
      Alert.alert('Could not change Drive folder', String(error));
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const accounts = (await client.listGoogleAccounts()).filter((account) =>
      googleAccountSupports(account, 'drive'),
    );
    const choice = await chooseAccount({ accounts });
    if (choice?.kind === 'add') {
      router.push('/settings/google');
      return;
    }
    if (choice?.kind !== 'account') return;
    router.push({
      pathname: '/google-drive/[sessionId]',
      params: { sessionId: projectId, accountId: choice.accountId },
    });
  };
  return (
    <SettingsDisclosure
      title="Google Drive folders"
      icon="folder"
      summary={folders.length ? `${folders.length} connected` : 'Not connected'}
    >
      {folders.map((folder) => (
        <SettingsDisclosure
          key={folder.id}
          title={folder.name}
          icon="folder"
          summary={folder.accountEmail}
        >
          <SettingsToggleRow
            label="Allow changes to Google Drive files"
            value={folder.accessMode === 'read-write'}
            disabled={busy}
            onValueChange={(enabled) =>
              void perform(() =>
                client.connectProjectGoogleDriveFolder(
                  projectId,
                  folder.folderId,
                  enabled ? 'read-write' : 'read-only',
                  folder.accountId,
                ),
              )
            }
          />
          <SettingsNavRow
            title="Disconnect folder"
            subtitle="Files stay in Google Drive"
            icon="x"
            disabled={busy}
            onPress={() =>
              confirm({
                title: 'Disconnect Drive folder?',
                message: `${folder.name} (${folder.accountEmail}) will no longer be available to this project. Files stay in Google Drive.`,
                confirmLabel: 'Disconnect',
                destructive: true,
                onConfirm: () =>
                  perform(() => client.unlinkProjectDriveFolder(projectId, folder.id)),
              })
            }
          />
        </SettingsDisclosure>
      ))}
      <SettingsNavRow
        title="Add folder"
        icon="plus"
        disabled={busy}
        onPress={() =>
          void add().catch((error: unknown) =>
            Alert.alert('Could not choose account', String(error)),
          )
        }
      />
      {accountSheet}
      {confirmSheet}
    </SettingsDisclosure>
  );
}
