// Project settings › Connectors › Network shares: the folders on centrally
// connected SMB shares that this project's agents may use, each read only or
// read and write. Adding a folder runs in one sheet: share, folder, access.
import {
  VerityApiError,
  type NetworkShareAccessMode,
  type NetworkShareConnection,
  type NetworkShareFolderListing,
  type ProjectNetworkShareFolder,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, Sheet, SheetHeaderButton, Text } from '../ui';
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
} from './SettingsChrome';

type Step =
  | { kind: 'share' }
  | { kind: 'folder'; connection: NetworkShareConnection; listing?: NetworkShareFolderListing }
  | {
      kind: 'access';
      connection: NetworkShareConnection;
      path: string;
      accessMode: NetworkShareAccessMode;
    }
  | { kind: 'manage'; folder: ProjectNetworkShareFolder };

const ACCESS_LABELS: Record<NetworkShareAccessMode, string> = {
  'read-only': 'Read only',
  'read-write': 'Read and write',
};

/** `Studio NAS › Projects › Briefs`: the share's name, then the folders inside it. */
function networkShareLocation(label: string, path: string): string {
  return [label, ...path.split('/').filter(Boolean)].join(' › ');
}

function AccessChoices({
  value,
  disabled,
  onChange,
}: {
  value: NetworkShareAccessMode;
  disabled?: boolean;
  onChange: (mode: NetworkShareAccessMode) => void;
}) {
  return (
    <SettingsListPanel>
      <SettingsChoiceRow
        title={ACCESS_LABELS['read-only']}
        subtitle="Agents can browse and read files"
        selected={value === 'read-only'}
        disabled={disabled}
        onPress={() => onChange('read-only')}
      />
      <SettingsChoiceRow
        title={ACCESS_LABELS['read-write']}
        subtitle="Agents can also create and update files"
        selected={value === 'read-write'}
        disabled={disabled}
        onPress={() => onChange('read-write')}
      />
    </SettingsListPanel>
  );
}

export function ProjectNetworkShares({
  client,
  projectId,
  onlyWhenUsed = false,
}: {
  client: VerityClient;
  projectId: string;
  /**
   * Shows nothing while there is no share to pick from and no folder to show,
   * as on the combined connectors screen, whose index hides the row likewise.
   */
  onlyWhenUsed?: boolean;
}) {
  const [folders, setFolders] = useState<ProjectNetworkShareFolder[]>();
  /** Undefined while loading; null when the person may not manage folders. */
  const [connections, setConnections] = useState<NetworkShareConnection[] | null>();
  const [step, setStep] = useState<Step>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  /** Only the latest load may update the list; an older one finishing late is dropped. */
  const loads = useRef(0);
  const load = useCallback(async () => {
    const current = ++loads.current;
    const [list, shares] = await Promise.all([
      client.networkShares.listProjectFolders(projectId),
      // Folders stay visible when the shares cannot be listed; only managing waits.
      client.networkShares
        .listConnections()
        .then((connections) => ({ connections }))
        .catch((cause: unknown) => ({
          connections: null,
          ...(cause instanceof VerityApiError && cause.status === 403
            ? {}
            : {
                error: cause instanceof Error ? cause.message : 'Could not load network shares.',
              }),
        })),
    ]);
    if (current !== loads.current) return;
    setFolders(list);
    setError('error' in shares ? shares.error : undefined);
    setConnections(shares.connections);
  }, [client, projectId]);
  useFocusEffect(
    useCallback(() => {
      const started = loads.current + 1;
      void load().catch((cause: unknown) => {
        if (started === loads.current)
          setError(cause instanceof Error ? cause.message : 'Could not load network shares.');
      });
      return () => {
        // Leaving the screen ends interest in any load still running.
        loads.current++;
      };
    }, [load]),
  );

  /** Changes still running; closing a sheet must not let a second one start meanwhile. */
  const changing = useRef(0);
  const perform = async (action: () => Promise<unknown>, after?: () => void) => {
    const opened = navigation.current;
    changing.current++;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      // A sheet closed or replaced meanwhile is left as the user has it.
      if (opened === navigation.current) after?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change folder access.');
      return;
    } finally {
      changing.current--;
      setBusy(changing.current > 0);
    }
    // The change is done; a failed refresh must not read as a failed change.
    await load().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Could not load network shares.'),
    );
  };

  /** Bumped on every navigation and on close, so a late listing cannot take over the sheet. */
  const navigation = useRef(0);
  const browse = async (connection: NetworkShareConnection, path: string) => {
    const current = ++navigation.current;
    setBusy(true);
    setError(undefined);
    try {
      const listing = await client.networkShares.browseFolders(connection.id, path);
      if (current === navigation.current) setStep({ kind: 'folder', connection, listing });
    } catch (cause) {
      if (current === navigation.current)
        setError(cause instanceof Error ? cause.message : 'Could not open the folder.');
    } finally {
      if (current === navigation.current) setBusy(false);
    }
  };
  const closeSheet = () => {
    navigation.current++;
    setBusy(changing.current > 0);
    setStep(undefined);
  };

  const startAdding = () => {
    setError(undefined);
    if (connections && connections.length === 0) {
      router.push('/settings/services/network-shares');
      return;
    }
    if (connections?.length === 1) {
      setStep({ kind: 'folder', connection: connections[0]! });
      void browse(connections[0]!, '');
      return;
    }
    setStep({ kind: 'share' });
  };

  const back = (): void => {
    if (busy) return;
    setError(undefined);
    if (step?.kind === 'access') {
      void browse(step.connection, step.path);
      return;
    }
    if (step?.kind === 'folder') {
      const path = step.listing?.path ?? '';
      if (path) void browse(step.connection, path.split('/').slice(0, -1).join('/'));
      else if (connections && connections.length > 1) setStep({ kind: 'share' });
      else closeSheet();
    }
  };
  const backButton = (
    <SheetHeaderButton icon="arrow-left" accessibilityLabel="Back" onPress={back} />
  );

  let title = '';
  let headerAction: ReactNode;
  let body: ReactNode = null;
  let footer: ReactNode = null;
  if (step?.kind === 'share') {
    title = 'Add folder from';
    body = (
      <SettingsListPanel>
        {(connections ?? []).map((connection) => (
          <SettingsNavRow
            key={connection.id}
            icon="hard-drive"
            title={connection.label}
            subtitle={connection.address.replace(/^smb:\/\//, '')}
            disabled={busy}
            onPress={() => void browse(connection, '')}
          />
        ))}
      </SettingsListPanel>
    );
  } else if (step?.kind === 'folder') {
    const path = step.listing?.path ?? '';
    title = path.split('/').at(-1) || step.connection.label;
    headerAction = backButton;
    body = (
      <View style={styles.stack}>
        <Text variant="body" tone="muted">
          {networkShareLocation(step.connection.label, path)}
        </Text>
        {step.listing === undefined ? (
          <Text variant="body" tone="muted">
            Loading…
          </Text>
        ) : step.listing.folders.length === 0 ? (
          <Text variant="body" tone="muted">
            No folders inside.
          </Text>
        ) : (
          <Group>
            {step.listing.folders.map((folder) => (
              <Row
                key={folder.path}
                title={folder.name}
                leading={{ icon: 'folder' }}
                navigates
                disabled={busy}
                onPress={() => void browse(step.connection, folder.path)}
              />
            ))}
          </Group>
        )}
      </View>
    );
    footer = (
      <Button
        label="Use this folder"
        fullWidth
        disabled={busy || step.listing === undefined}
        onPress={() =>
          setStep({ kind: 'access', connection: step.connection, path, accessMode: 'read-only' })
        }
      />
    );
  } else if (step?.kind === 'access') {
    const name = step.path.split('/').at(-1) || step.connection.label;
    title = `Access to “${name}”`;
    headerAction = backButton;
    body = (
      <View style={styles.stack}>
        <Text variant="body" tone="muted">
          {`${networkShareLocation(step.connection.label, step.path)}, including its subfolders`}
        </Text>
        <AccessChoices
          value={step.accessMode}
          disabled={busy}
          onChange={(accessMode) => setStep({ ...step, accessMode })}
        />
        <Text variant="bodySmall" tone="muted">
          You can change this later. Agents never get more rights than the NAS account allows.
        </Text>
      </View>
    );
    footer = (
      <Button
        label="Add folder"
        fullWidth
        loading={busy}
        disabled={busy}
        onPress={() =>
          void perform(
            () =>
              client.networkShares.grantProjectFolder(projectId, {
                connectionId: step.connection.id,
                path: step.path,
                accessMode: step.accessMode,
              }),
            () => setStep(undefined),
          )
        }
      />
    );
  } else if (step?.kind === 'manage') {
    const { folder } = step;
    title = folder.name;
    body = (
      <View style={styles.stack}>
        <Text variant="body" tone="muted">
          {networkShareLocation(folder.connectionLabel, folder.path)}
        </Text>
        {folder.stale ? (
          <Text variant="body" tone="attention">
            The share now points to another server or shared folder. Remove this folder and add it
            again.
          </Text>
        ) : (
          <AccessChoices
            value={folder.accessMode}
            disabled={busy}
            onChange={(accessMode) =>
              void perform(async () => {
                const opened = navigation.current;
                const updated = await client.networkShares.setProjectFolderAccess(
                  projectId,
                  folder.id,
                  accessMode,
                );
                // A sheet closed meanwhile stays closed.
                if (opened === navigation.current) setStep({ kind: 'manage', folder: updated });
              })
            }
          />
        )}
        <Text variant="bodySmall" tone="muted">
          Removing the folder only ends this project’s access. The files stay on the share.
        </Text>
      </View>
    );
    footer = (
      <Button
        label="Remove from project"
        variant="destructive"
        fullWidth
        disabled={busy}
        onPress={() =>
          void perform(
            () => client.networkShares.removeProjectFolder(projectId, folder.id),
            () => setStep(undefined),
          )
        }
      />
    );
  }

  const canManage = connections !== null && connections !== undefined;
  const unused = folders !== undefined && folders.length === 0 && !connections?.length;
  // A load error still shows: hiding it would read as “nothing is shared”.
  if (onlyWhenUsed && !error && (unused || folders === undefined)) return null;
  return (
    <SettingsGroup
      title="Folders for this project"
      description="Agents in this project can use only these folders. Everything else on the share stays out of reach."
    >
      {error && step === undefined ? <Text tone="attention">{error}</Text> : null}
      <SettingsListPanel>
        {(folders ?? []).map((folder) => (
          <SettingsNavRow
            key={folder.id}
            icon="folder"
            title={folder.name}
            subtitle={networkShareLocation(folder.connectionLabel, folder.path)}
            {...(folder.stale
              ? { status: { intent: 'needsSetup' as const, label: 'Add again' } }
              : { value: ACCESS_LABELS[folder.accessMode] })}
            disabled={!canManage}
            onPress={() => {
              setError(undefined);
              setStep({ kind: 'manage', folder });
            }}
          />
        ))}
        {folders?.length === 0 && !canManage ? (
          <Row title="No folders shared with this project" leading={{ icon: 'folder' }} />
        ) : null}
        {canManage ? (
          <SettingsNavRow title="Add folder" icon="plus" disabled={busy} onPress={startAdding} />
        ) : null}
      </SettingsListPanel>
      <Sheet
        visible={step !== undefined}
        title={title}
        headerAction={headerAction}
        onClose={closeSheet}
        footer={
          footer || error ? (
            <View style={styles.stack}>
              {error ? <Text tone="attention">{error}</Text> : null}
              {footer}
            </View>
          ) : undefined
        }
      >
        {body}
      </Sheet>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing.md },
}));
