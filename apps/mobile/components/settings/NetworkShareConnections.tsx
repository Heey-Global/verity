// Settings › Connectors › Network shares: SMB shares the server connects to,
// for example shared folders on a NAS. Projects then get individual folders on
// them (ProjectNetworkShares). Passwords are entered here and never shown again.
import {
  VerityApiError,
  type NetworkShareConnection,
  type NetworkShareTestResult,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, Sheet, Text, TextField, useConfirm } from '../ui';
import type { StatusIntent } from '../ui/Status';
import { SettingsGroup, SettingsListPanel, SettingsNavRow } from './SettingsChrome';

type Mode =
  | { kind: 'add' }
  | { kind: 'menu'; connection: NetworkShareConnection }
  | { kind: 'edit'; connection: NetworkShareConnection };

type Field = 'label' | 'address' | 'username' | 'password';

const STATUS_LABELS: Record<string, string> = {
  unreachable: 'Unreachable',
  sign_in_failed: 'Sign-in failed',
  encryption_unavailable: 'Not encrypted',
  share_not_found: 'Shared folder missing',
  timeout: 'Unreachable',
};

/** Which field a server error is about, so it shows next to that field. */
const ERROR_FIELDS: Record<string, Field> = {
  unreachable: 'address',
  timeout: 'address',
  share_not_found: 'address',
  encryption_unavailable: 'address',
  sign_in_failed: 'password',
};

function statusOf(result: NetworkShareTestResult | undefined): {
  intent: StatusIntent;
  label: string;
} {
  if (result === undefined) return { intent: 'transient', label: 'Checking' };
  if (result.ok) return { intent: 'ready', label: 'Connected' };
  return { intent: 'needsSetup', label: STATUS_LABELS[result.code ?? ''] ?? 'Not available' };
}

const projects = (count: number) =>
  count === 1 ? 'Used in 1 project' : `Used in ${count} projects`;
const shortAddress = (address: string) => address.replace(/^smb:\/\//, '');

// SMB servers treat names without case, and so does the server when it decides
// whether a change moves the share to a new target; a case-only edit keeps the
// projects' folders and the saved password.
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const changesAddress = (connection: NetworkShareConnection, form: { address: string }) =>
  !sameName(form.address, connection.address);
const changesAccount = (connection: NetworkShareConnection, form: { username: string }) =>
  !sameName(form.username, connection.username);

export function NetworkShareConnections({ client }: { client: VerityClient }) {
  const [connections, setConnections] = useState<NetworkShareConnection[]>();
  const [tests, setTests] = useState<Record<string, NetworkShareTestResult>>({});
  const [loadError, setLoadError] = useState<string>();
  const [mode, setMode] = useState<Mode>();
  const [form, setForm] = useState<Record<Field, string>>({
    label: '',
    address: '',
    username: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: Field; message: string }>();
  const [confirm, confirmSheet] = useConfirm();
  const generation = useRef(0);

  const test = useCallback(
    async (connection: NetworkShareConnection, current: number, fresh = false) => {
      const result = await client.networkShares
        .testConnection(connection.id, fresh)
        .catch((): NetworkShareTestResult => ({ ok: false }));
      if (current === generation.current)
        setTests((previous) => ({ ...previous, [connection.id]: result }));
    },
    [client],
  );
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const list = await client.networkShares.listConnections();
      if (current !== generation.current) return;
      setConnections(list);
      setTests({});
      setLoadError(undefined);
      // Tests run on their own: a slow NAS must not hold up saving or removing.
      for (const connection of list) void test(connection, current);
    } catch (cause) {
      if (current === generation.current)
        setLoadError(cause instanceof Error ? cause.message : 'Could not load network shares.');
    }
  }, [client, test]);
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        generation.current++;
      };
    }, [load]),
  );

  const open = (next: Mode) => {
    setError(undefined);
    setForm(
      next.kind === 'edit'
        ? {
            label: next.connection.label,
            address: next.connection.address,
            username: next.connection.username,
            password: '',
          }
        : { label: '', address: '', username: '', password: '' },
    );
    setMode(next);
  };
  const close = () => setMode(undefined);
  const set = (field: Field) => (value: string) =>
    setForm((previous) => ({ ...previous, [field]: value }));
  const fieldError = (field: Field) =>
    error?.field === field ? { title: 'Could not connect', message: error.message } : undefined;

  const save = async (current = mode, values = form) => {
    if (!current || current.kind === 'menu') return;
    setBusy(true);
    setError(undefined);
    try {
      if (current.kind === 'add')
        await client.networkShares.addConnection({
          label: values.label.trim(),
          address: values.address.trim(),
          username: values.username.trim(),
          password: values.password,
        });
      else {
        const { connection } = current;
        await client.networkShares.updateConnection(connection.id, {
          ...(values.label.trim() !== connection.label ? { label: values.label.trim() } : {}),
          ...(values.address.trim() !== connection.address
            ? { address: values.address.trim() }
            : {}),
          ...(values.username.trim() !== connection.username
            ? { username: values.username.trim() }
            : {}),
          ...(values.password ? { password: values.password } : {}),
        });
      }
      close();
      await load();
    } catch (cause) {
      // A save confirmed outside the sheet reopens it with the error.
      setMode(current);
      const code = cause instanceof VerityApiError ? cause.code : undefined;
      setError({
        ...(code && ERROR_FIELDS[code] ? { field: ERROR_FIELDS[code] } : {}),
        message: cause instanceof Error ? cause.message : 'Could not save the network share.',
      });
    } finally {
      setBusy(false);
    }
  };

  /** A new address or account ends every project's folders on the share; ask first. */
  const requestSave = () => {
    const address = mode?.kind === 'edit' && changesAddress(mode.connection, form);
    const account = mode?.kind === 'edit' && changesAccount(mode.connection, form);
    if (mode?.kind === 'edit' && mode.connection.projectCount > 0 && (address || account)) {
      const current = mode;
      const values = form;
      const what = address ? 'address' : 'account';
      setMode(undefined);
      confirm({
        title: `Change the ${what} of ${current.connection.label}?`,
        message: `${projects(current.connection.projectCount)}. Those projects lose their folders on this share and need them added again.`,
        confirmLabel: `Change ${what}`,
        destructive: true,
        afterSheet: true,
        onConfirm: () => save(current, values),
      });
      return;
    }
    void save();
  };

  const disconnect = (connection: NetworkShareConnection) =>
    confirm({
      title: `Disconnect ${connection.label}?`,
      message:
        connection.projectCount > 0
          ? `${projects(connection.projectCount)}. Those projects lose their folders on this share. Files stay on the share.`
          : 'No project uses it. Files stay on the share.',
      confirmLabel: 'Disconnect',
      destructive: true,
      afterSheet: true,
      onConfirm: async () => {
        try {
          await client.networkShares.removeConnection(connection.id);
        } catch (cause) {
          setLoadError(cause instanceof Error ? cause.message : 'Could not disconnect the share.');
          // Keeps the confirmation open for another try.
          throw cause;
        }
        setLoadError(undefined);
        await load();
      },
    });

  let title = '';
  let body: ReactNode = null;
  let footer: ReactNode = null;
  if (mode?.kind === 'add' || mode?.kind === 'edit') {
    const adding = mode.kind === 'add';
    // The saved password is never sent to a new server or tried with another account.
    const addressChanged = mode.kind === 'edit' && changesAddress(mode.connection, form);
    const accountChanged = mode.kind === 'edit' && changesAccount(mode.connection, form);
    const needsPassword = adding || addressChanged || accountChanged;
    title = adding ? 'Add network share' : `Edit ${mode.connection.label}`;
    body = (
      <View style={styles.fields}>
        <TextField label="Name" value={form.label} onChangeText={set('label')} maxLength={100} />
        <View style={styles.field}>
          <TextField
            label="Address"
            placeholder="smb://nas.local/team"
            value={form.address}
            onChangeText={set('address')}
            keyboardType="url"
            literal
            error={fieldError('address')}
          />
          <Text variant="bodySmall" tone="muted">
            The address you would open in Finder or Explorer: the NAS, then the shared folder. On a
            Synology NAS, the shared folders are listed under Control Panel › Shared Folder.
          </Text>
        </View>
        <TextField
          label="Username"
          value={form.username}
          onChangeText={set('username')}
          literal
          error={fieldError('username')}
        />
        <View style={styles.field}>
          <TextField
            label="Password"
            value={form.password}
            onChangeText={set('password')}
            secret
            literal
            error={fieldError('password')}
          />
          {adding ? null : (
            <Text variant="bodySmall" tone="muted">
              {addressChanged
                ? 'Enter the password again for the new address.'
                : accountChanged
                  ? 'Enter the password of the new account.'
                  : 'Leave empty to keep the saved password.'}
            </Text>
          )}
        </View>
        {error && !error.field ? <Text tone="attention">{error.message}</Text> : null}
        <Text variant="body" tone="muted">
          The Verity server must reach the NAS on your network or through a VPN. Verity only
          connects with SMB3 encryption; agents never see the password.
        </Text>
      </View>
    );
    footer = (
      <Button
        label={adding ? 'Test and add' : 'Test and save'}
        fullWidth
        loading={busy}
        disabled={
          busy ||
          !form.label.trim() ||
          !form.address.trim() ||
          !form.username.trim() ||
          (needsPassword && !form.password)
        }
        onPress={requestSave}
      />
    );
  } else if (mode?.kind === 'menu') {
    const { connection } = mode;
    title = connection.label;
    body = (
      <View style={styles.fields}>
        <Text variant="body" tone="muted">
          {`${shortAddress(connection.address)} · ${connection.username} · ${projects(connection.projectCount)}`}
        </Text>
        <Group>
          <Row
            title="Test connection"
            subtitle={statusOf(tests[connection.id]).label}
            leading={{ icon: 'activity' }}
            onPress={() => {
              setTests((previous) => {
                const next = { ...previous };
                delete next[connection.id];
                return next;
              });
              void test(connection, generation.current, true);
            }}
          />
          <Row
            title="Edit"
            subtitle="Name, address and sign-in"
            leading={{ icon: 'edit-2' }}
            navigates
            onPress={() => open({ kind: 'edit', connection })}
          />
        </Group>
        <Text variant="bodySmall" tone="muted">
          A new address or account ends project access to this share; folders must be added again.
        </Text>
      </View>
    );
    footer = (
      <Button
        label="Disconnect share"
        variant="destructive"
        fullWidth
        onPress={() => {
          close();
          disconnect(connection);
        }}
      />
    );
  }

  return (
    <SettingsGroup
      title="Shares"
      description="Connect an SMB share once, for example a folder on a Synology or other NAS. Then choose in each project which folders its agents may use."
    >
      {loadError ? <Text tone="attention">{loadError}</Text> : null}
      <SettingsListPanel>
        {(connections ?? []).map((connection) => (
          <SettingsNavRow
            key={connection.id}
            icon="hard-drive"
            title={connection.label}
            subtitle={`${shortAddress(connection.address)} · ${projects(connection.projectCount)}`}
            status={statusOf(tests[connection.id])}
            onPress={() => open({ kind: 'menu', connection })}
          />
        ))}
        <SettingsNavRow
          title="Add network share"
          icon="plus"
          disabled={connections === undefined}
          onPress={() => open({ kind: 'add' })}
        />
      </SettingsListPanel>
      <Sheet visible={mode !== undefined} title={title} onClose={close} footer={footer}>
        {body}
      </Sheet>
      {confirmSheet}
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing.md },
  field: { gap: theme.spacing.xs },
}));
