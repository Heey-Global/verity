// The instance's Doppler connections (docs/adr/0031-multiple-doppler-connections.md):
// one token per Doppler workplace, each usable by any project's bindings. Tokens
// are entered here once, checked by the server and never shown again.
import type { DopplerConnection, DopplerConnectionUsage, VerityClient } from '@verity/mobile';
import { useCallback, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useScanResource } from '../../lib/useScanResource';
import { SettingsGroup } from '../settings/SettingsChrome';
import {
  Button,
  Group,
  HintBox,
  IconButton,
  Row,
  SectionHeader,
  Sheet,
  Text,
  TextField,
} from '../ui';

type Mode =
  | { kind: 'add' }
  | { kind: 'menu'; connection: DopplerConnection }
  | { kind: 'rename'; connection: DopplerConnection }
  | { kind: 'token'; connection: DopplerConnection }
  | { kind: 'delete'; connection: DopplerConnection; usage: DopplerConnectionUsage['projects'] };

const projects = (count: number) => (count === 1 ? '1 project' : `${count} projects`);

export function connectionSummary(connection: DopplerConnection): string {
  const parts = [
    connection.workplaceName ?? connection.workplaceSlug,
    projects(connection.projectCount),
    connection.hasToken ? null : 'personal tokens only',
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

export function DopplerConnections({
  client,
  writable,
}: {
  client: VerityClient;
  writable: boolean;
}) {
  const resource = useScanResource(useCallback(() => client.doppler.listConnections(), [client]));
  const [mode, setMode] = useState<Mode>();
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const connections = resource.data ?? [];

  const open = (next: Mode) => {
    setError(undefined);
    setToken('');
    setLabel(next.kind === 'rename' ? next.connection.label : '');
    setMode(next);
  };
  const close = () => {
    setMode(undefined);
    setToken('');
  };
  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      close();
      resource.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  };
  const askDelete = async (connection: DopplerConnection) => {
    setBusy(true);
    try {
      const usage = await client.doppler.connectionUsage(connection.id);
      open({ kind: 'delete', connection, usage: usage.projects });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check where it is used.');
    } finally {
      setBusy(false);
    }
  };

  let title = '';
  let body: ReactNode = null;
  let footer: ReactNode = null;
  if (mode?.kind === 'add' || mode?.kind === 'token' || mode?.kind === 'rename') {
    const adding = mode.kind === 'add';
    const renaming = mode.kind === 'rename';
    title = adding
      ? 'Add Doppler connection'
      : renaming
        ? `Rename ${mode.connection.label}`
        : `Replace token for ${mode.connection.label}`;
    body = (
      <View style={styles.fields}>
        {adding || renaming ? (
          <TextField
            label="Connection label"
            value={label}
            onChangeText={setLabel}
            maxLength={80}
          />
        ) : null}
        {adding || !renaming ? (
          <TextField
            label="Doppler token"
            placeholder="dp.sa.…"
            value={token}
            onChangeText={setToken}
            secret
            literal
          />
        ) : null}
        {renaming ? null : (
          <Text variant="body" tone="muted">
            Verity checks the token and identifies its Doppler workplace before saving.
          </Text>
        )}
      </View>
    );
    footer = (
      <Button
        label={renaming ? 'Save' : adding ? 'Validate and add' : 'Validate and replace'}
        fullWidth
        disabled={
          busy ||
          (renaming || adding ? label.trim() === '' : false) ||
          (!renaming && token.trim() === '')
        }
        onPress={() =>
          void run(
            () =>
              adding
                ? client.doppler.addConnection({ label: label.trim(), token: token.trim() })
                : client.doppler.updateConnection(
                    mode.connection.id,
                    renaming ? { label: label.trim() } : { token: token.trim() },
                  ),
            'Could not save the Doppler connection.',
          )
        }
      />
    );
  } else if (mode?.kind === 'menu') {
    const { connection } = mode;
    title = connection.label;
    body = (
      <View style={styles.fields}>
        <Text variant="body" tone="muted">
          {connectionSummary(connection)}
        </Text>
        <Group>
          <Row
            title="Rename"
            leading={{ icon: 'edit-2' }}
            navigates
            onPress={() => open({ kind: 'rename', connection })}
          />
          <Row
            title="Replace token"
            subtitle="Verity checks the new token before saving"
            leading={{ icon: 'refresh-cw' }}
            navigates
            onPress={() => open({ kind: 'token', connection })}
          />
        </Group>
      </View>
    );
    footer = (
      <Button
        label="Delete connection"
        variant="destructive"
        fullWidth
        disabled={busy}
        onPress={() => void askDelete(connection)}
      />
    );
  } else if (mode?.kind === 'delete') {
    const { connection, usage } = mode;
    title = `Delete ${connection.label}?`;
    body = (
      <View style={styles.fields}>
        {usage.length > 0 ? (
          <>
            <HintBox
              title="Connection in use"
              message={`Deleting ${connection.label} removes the bindings below from their Verity projects, together with everyone's personal tokens for it.`}
            />
            <SectionHeader title="Affected projects" />
            <Group>
              {usage.map((project) => (
                <Row
                  key={project.projectId}
                  title={project.projectName}
                  subtitle={project.bindings
                    .map((binding) => `${binding.dopplerProject}/${binding.dopplerConfig}`)
                    .join(', ')}
                  wrap
                />
              ))}
            </Group>
          </>
        ) : (
          <Text variant="body" tone="muted">
            No project uses this connection.
          </Text>
        )}
      </View>
    );
    footer = (
      <View style={styles.fields}>
        <Button
          label="Delete connection"
          variant="destructive"
          fullWidth
          disabled={busy}
          onPress={() =>
            void run(
              () => client.doppler.removeConnection(connection.id),
              'Could not delete the Doppler connection.',
            )
          }
        />
        <Button label="Cancel" variant="text" fullWidth onPress={close} />
      </View>
    );
  }

  return (
    <SettingsGroup
      title="Connections"
      description="One Doppler token per workplace. Projects bind any Doppler project and config of these connections."
    >
      {resource.error ? <Text tone="attention">{resource.error}</Text> : null}
      <Group>
        {connections.length === 0 ? (
          <Row
            title={resource.data === undefined ? 'Loading…' : 'No Doppler connections'}
            leading={{ icon: 'link' }}
          />
        ) : (
          connections.map((connection) => (
            <Row
              key={connection.id}
              title={connection.label}
              subtitle={connectionSummary(connection)}
              leading={{ icon: 'link' }}
              trailing={
                writable ? (
                  <IconButton
                    icon="more-horizontal"
                    accessibilityLabel={`Manage ${connection.label}`}
                    disabled={busy}
                    onPress={() => open({ kind: 'menu', connection })}
                  />
                ) : undefined
              }
            />
          ))
        )}
      </Group>
      <Button
        label="Add connection"
        icon="plus"
        variant="secondary"
        disabled={busy || !writable}
        onPress={() => open({ kind: 'add' })}
      />
      <Sheet
        visible={writable && mode !== undefined}
        title={title}
        onClose={close}
        footer={
          <View style={styles.fields}>
            {error ? <Text tone="attention">{error}</Text> : null}
            {footer}
          </View>
        }
      >
        {body}
      </Sheet>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing.md },
}));
