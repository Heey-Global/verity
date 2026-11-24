// The instance's Doppler connections (docs/adr/0031-multiple-doppler-connections.md):
// one token per Doppler workplace, each usable by any project's bindings. Tokens
// are entered here once, checked by the server and never shown again.
import {
  VerityApiError,
  type DopplerConnection,
  type DopplerConnectionUsage,
  type VerityClient,
} from '@verity/mobile';
import { useCallback, useRef, useState, type ReactNode } from 'react';
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
  | { kind: 'confirm-token'; connection: DopplerConnection }
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
  const [checkingUsage, setCheckingUsage] = useState(false);
  const dialogGeneration = useRef(0);
  const [error, setError] = useState<string>();
  const connections = resource.data ?? [];

  const open = (next: Mode) => {
    dialogGeneration.current++;
    setCheckingUsage(false);
    setError(undefined);
    setToken('');
    setLabel(next.kind === 'rename' ? next.connection.label : '');
    setMode(next);
  };
  const close = () => {
    dialogGeneration.current++;
    setCheckingUsage(false);
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
  const askDelete = async (connection: DopplerConnection, notice?: string) => {
    const generation = ++dialogGeneration.current;
    setCheckingUsage(true);
    setError(undefined);
    try {
      const usage = await client.doppler.connectionUsage(connection.id);
      if (generation !== dialogGeneration.current) return;
      open({ kind: 'delete', connection, usage: usage.projects });
      setError(notice);
    } catch (cause) {
      if (generation === dialogGeneration.current)
        setError(cause instanceof Error ? cause.message : 'Could not check where it is used.');
    } finally {
      if (generation === dialogGeneration.current) setCheckingUsage(false);
    }
  };

  const confirmDelete = async (
    connection: DopplerConnection,
    usage: DopplerConnectionUsage['projects'],
  ) => {
    const generation = dialogGeneration.current;
    setBusy(true);
    setError(undefined);
    try {
      await client.doppler.removeConnection(
        connection.id,
        usage.flatMap((project) => project.bindings.map((binding) => binding.id)),
      );
      if (generation === dialogGeneration.current) close();
      resource.reload();
    } catch (cause) {
      if (generation !== dialogGeneration.current) return;
      if (cause instanceof VerityApiError && cause.status === 409) {
        setMode({ kind: 'menu', connection });
        await askDelete(
          connection,
          'The bindings changed. Review the updated list and confirm again.',
        );
      } else {
        setError(
          cause instanceof Error ? cause.message : 'Could not delete the Doppler connection.',
        );
      }
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
        label={renaming ? 'Save' : adding ? 'Validate and add' : 'Continue'}
        fullWidth
        disabled={
          busy ||
          ((renaming || adding) && label.trim() === '') ||
          (!renaming && token.trim() === '')
        }
        onPress={() => {
          if (mode.kind === 'token') {
            setError(undefined);
            setMode({ kind: 'confirm-token', connection: mode.connection });
            return;
          }
          void run(
            () =>
              mode.kind === 'add'
                ? client.doppler.addConnection({ label: label.trim(), token: token.trim() })
                : client.doppler.updateConnection(mode.connection.id, { label: label.trim() }),
            'Could not save the Doppler connection.',
          );
        }}
      />
    );
  } else if (mode?.kind === 'confirm-token') {
    const { connection } = mode;
    title = `Replace token for ${connection.label}?`;
    body = (
      <HintBox
        title="Personal tokens may be disconnected"
        message="If Verity cannot verify that the new token belongs to the same Doppler workplace, it clears personal tokens for this connection. Affected people will need to reconnect their tokens."
      />
    );
    footer = (
      <View style={styles.fields}>
        <Button
          label="Confirm token replacement"
          fullWidth
          variant="destructive"
          disabled={busy}
          onPress={() =>
            void run(
              () =>
                client.doppler.updateConnection(connection.id, {
                  token: token.trim(),
                  confirmTokenReplacement: true,
                }),
              'Could not replace the Doppler token.',
            )
          }
        />
        <Button
          label="Back"
          variant="text"
          fullWidth
          disabled={busy}
          onPress={() => {
            setError(undefined);
            setMode({ kind: 'token', connection });
          }}
        />
      </View>
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
        disabled={busy || checkingUsage}
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
          <HintBox
            title="No project uses this connection."
            message="Deleting it also removes any personal tokens that are still saved for it."
          />
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
          onPress={() => void confirmDelete(connection, usage)}
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
