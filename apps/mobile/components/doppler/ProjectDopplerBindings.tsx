// A project's Doppler bindings (docs/adr/0031-multiple-doppler-connections.md):
// any Doppler project and config of any instance connection, one of them the
// default. Agents write `NAME` for the default and `project/config/NAME` for the
// others. Each person connects their own token per connection; a missing one is
// shown at the top, and every binding says whether the viewer's token reaches it.
import type {
  DopplerConnection,
  PersonalDopplerTokens,
  ProjectDopplerBinding,
  VerityClient,
} from '@verity/mobile';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useScanResource } from '../../lib/useScanResource';
import {
  Button,
  Group,
  HintBox,
  IconButton,
  OptionList,
  Row,
  SectionHeader,
  Sheet,
  StatusTag,
  Text,
  TextField,
} from '../ui';

type Personal = PersonalDopplerTokens['connections'][number];
type Mode =
  | { kind: 'add' }
  | { kind: 'menu'; binding: ProjectDopplerBinding }
  | { kind: 'remove'; binding: ProjectDopplerBinding }
  | { kind: 'token'; connection: Personal };

/** What the viewer's own token means for a binding; null when nothing to say. */
export function personalTokenState(
  binding: ProjectDopplerBinding,
  tokens: readonly Personal[] | undefined,
): string | null {
  const mine = tokens?.find((entry) => entry.connectionId === binding.connectionId);
  if (mine === undefined) return null;
  if (mine.connected) return 'Your token connected';
  return mine.usesInstanceToken ? 'Instance token' : 'Your token missing';
}

export function ProjectDopplerBindings({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const bindings = useScanResource(
    useCallback(() => client.doppler.listBindings(projectId), [client, projectId]),
  );
  const [tokens, setTokens] = useState<Personal[]>();
  const [connections, setConnections] = useState<DopplerConnection[]>();
  const [mode, setMode] = useState<Mode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [token, setToken] = useState('');
  const [picked, setPicked] = useState<{ connection?: string; project?: string; config?: string }>(
    {},
  );
  const [options, setOptions] = useState<{ projects?: string[]; configs?: string[] }>({});
  const pickerRequest = useRef(0);
  const list = bindings.data ?? [];
  const bindingKey = list.map((binding) => binding.id).join(',');

  // Personal tokens follow the bindings: one per connection they use.
  useEffect(() => {
    let active = true;
    void client.doppler
      .personalTokens(projectId)
      .then((value) => active && setTokens(value.connections))
      .catch(() => active && setTokens(undefined));
    return () => {
      active = false;
    };
  }, [client, projectId, bindingKey]);

  const close = () => {
    pickerRequest.current++;
    setMode(undefined);
    setToken('');
  };
  const open = (next: Mode) => {
    const request = ++pickerRequest.current;
    setError(undefined);
    setToken('');
    setPicked({});
    setOptions({});
    setMode(next);
    if (next.kind === 'add') {
      setConnections(undefined);
      void client.doppler
        .listConnections()
        .then((value) => {
          if (request !== pickerRequest.current) return;
          setConnections(value);
          if (value.length === 1) void pickConnection(value[0]!.id);
        })
        .catch((cause: unknown) => {
          if (request === pickerRequest.current)
            setError(
              cause instanceof Error ? cause.message : 'Could not load the Doppler connections.',
            );
        });
    }
  };
  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      close();
      bindings.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  };
  const pickConnection = async (connectionId: string) => {
    const request = ++pickerRequest.current;
    setError(undefined);
    setPicked({ connection: connectionId });
    setOptions({});
    const result = await client.listDopplerProjects(connectionId).catch(() => undefined);
    if (request !== pickerRequest.current) return;
    if (result === undefined || 'error' in result)
      setError(result?.error === 'locked' ? 'Unlock the secret store first.' : result?.error);
    else setOptions({ projects: result.projects.map((project) => project.slug) });
  };
  const pickProject = async (project: string) => {
    const request = ++pickerRequest.current;
    setError(undefined);
    setPicked((current) => ({ ...current, project, config: undefined }));
    setOptions((current) => ({ projects: current.projects }));
    const result = await client
      .listDopplerConfigs(project, picked.connection)
      .catch(() => undefined);
    if (request !== pickerRequest.current) return;
    if (result === undefined || 'error' in result) setError(result?.error);
    else setOptions((current) => ({ ...current, configs: result.configs.map((c) => c.name) }));
  };

  const missing = (tokens ?? []).filter((entry) => !entry.connected && !entry.usesInstanceToken);
  let title = '';
  let body: ReactNode = null;
  let footer: ReactNode = null;
  if (mode?.kind === 'add') {
    title = 'Add Doppler binding';
    const available = connections ?? [];
    const hasDuplicateLabels = new Set(available.map(({ label }) => label)).size < available.length;
    const connectionOptions = new Map(
      available.map((connection, index) => [
        hasDuplicateLabels ? `${index + 1}. ${connection.label}` : connection.label,
        connection.id,
      ]),
    );
    const selected = [...connectionOptions].find(([, id]) => id === picked.connection)?.[0];
    body = (
      <View style={styles.fields}>
        {connections !== undefined && connections.length === 0 ? (
          <Text variant="body" tone="muted">
            Add a Doppler connection in Settings, Connectors, Doppler first.
          </Text>
        ) : null}
        {connectionOptions.size > 1 ? (
          <>
            <SectionHeader title="Connection" />
            <OptionList
              options={[...connectionOptions.keys()]}
              selected={selected}
              accessibilityLabel="Doppler connection"
              onSelect={(label) => {
                const id = connectionOptions.get(label);
                if (id !== undefined) void pickConnection(id);
              }}
            />
          </>
        ) : null}
        {options.projects ? (
          <>
            <SectionHeader title="Doppler project" />
            <OptionList
              options={options.projects}
              selected={picked.project}
              accessibilityLabel="Doppler project"
              onSelect={(project) => void pickProject(project)}
            />
          </>
        ) : null}
        {options.configs ? (
          <>
            <SectionHeader title="Config" />
            <OptionList
              options={options.configs}
              selected={picked.config}
              accessibilityLabel="Doppler config"
              onSelect={(config) => setPicked((current) => ({ ...current, config }))}
            />
          </>
        ) : null}
        {picked.project && picked.config ? (
          <Text variant="body" tone="muted">
            {`Agents write secrets as ${picked.project}/${picked.config}/API_KEY`}
          </Text>
        ) : null}
      </View>
    );
    footer = (
      <Button
        label="Add binding"
        fullWidth
        disabled={busy || !picked.connection || !picked.project || !picked.config}
        onPress={() =>
          void run(
            () =>
              client.doppler.addBinding(projectId, {
                connectionId: picked.connection!,
                dopplerProject: picked.project!,
                dopplerConfig: picked.config!,
              }),
            'Could not add the Doppler binding.',
          )
        }
      />
    );
  } else if (mode?.kind === 'menu') {
    const { binding } = mode;
    title = binding.reference;
    body = (
      <View style={styles.fields}>
        <Text variant="body" tone="muted">
          {`${binding.connectionLabel} · Doppler project ${binding.dopplerProject} · config ${binding.dopplerConfig}`}
        </Text>
        {binding.isDefault ? (
          <Text variant="body" tone="muted">
            The default binding: agents write its secrets without a prefix, such as API_KEY.
          </Text>
        ) : (
          <Group>
            <Row
              title="Set as default"
              subtitle={`Agents then write API_KEY instead of ${binding.reference}/API_KEY`}
              leading={{ icon: 'star' }}
              wrap
              disabled={busy}
              onPress={() =>
                void run(
                  () => client.doppler.setDefaultBinding(projectId, binding.id),
                  'Could not change the default binding.',
                )
              }
            />
          </Group>
        )}
      </View>
    );
    footer = (
      <Button
        label="Remove binding"
        variant="destructive"
        fullWidth
        disabled={busy}
        onPress={() => setMode({ kind: 'remove', binding })}
      />
    );
  } else if (mode?.kind === 'remove') {
    const { binding } = mode;
    title = `Remove ${binding.reference}?`;
    body = (
      <Text variant="body" tone="muted">
        {binding.isDefault
          ? 'Agents can no longer read its secrets. The oldest remaining binding becomes the default.'
          : `Agents can no longer read secrets written as ${binding.reference}/NAME.`}
      </Text>
    );
    footer = (
      <View style={styles.fields}>
        <Button
          label="Remove binding"
          variant="destructive"
          fullWidth
          disabled={busy}
          onPress={() =>
            void run(
              () => client.doppler.removeBinding(projectId, binding.id),
              'Could not remove the Doppler binding.',
            )
          }
        />
        <Button label="Cancel" variant="text" fullWidth onPress={close} />
      </View>
    );
  } else if (mode?.kind === 'token') {
    const { connection } = mode;
    title = `Your token for ${connection.label}`;
    body = (
      <View style={styles.fields}>
        <TextField
          label="Your Doppler token"
          placeholder="dp.st.…"
          value={token}
          onChangeText={setToken}
          secret
          literal
        />
        <Text variant="body" tone="muted">
          {`Only your own sessions use this token. Verity checks that it can read ${connection.bindings.join(', ')} before saving.`}
        </Text>
      </View>
    );
    footer = (
      <Button
        label="Validate and connect"
        fullWidth
        disabled={busy || token.trim() === ''}
        onPress={() =>
          void run(async () => {
            const result = await client.doppler.connectPersonalToken(
              projectId,
              connection.connectionId,
              token.trim(),
            );
            setTokens(result.connections);
          }, 'Could not connect the Doppler token.')
        }
      />
    );
  }

  return (
    <View style={styles.fields}>
      {missing.map((connection) => (
        <HintBox
          key={connection.connectionId}
          title="Your Doppler token is missing"
          message={`Your sessions cannot read secrets from ${connection.bindings.join(', ')} until you connect your own token for ${connection.label}.`}
        >
          <Button
            label={`Connect token for ${connection.label}`}
            icon="key"
            onPress={() => open({ kind: 'token', connection })}
          />
        </HintBox>
      ))}
      {bindings.error ? <Text tone="attention">{bindings.error}</Text> : null}
      <Group>
        {list.length === 0 ? (
          <Row
            title={bindings.data === undefined ? 'Loading…' : 'No Doppler bindings'}
            leading={{ icon: 'layers' }}
          />
        ) : (
          list.map((binding) => {
            const state = personalTokenState(binding, tokens);
            return (
              <Row
                key={binding.id}
                title={binding.reference}
                subtitle={
                  state === null ? binding.connectionLabel : `${binding.connectionLabel} · ${state}`
                }
                leading={{ icon: 'layers' }}
                tag={binding.isDefault ? <StatusTag intent="ready" label="Default" /> : undefined}
                trailing={
                  <IconButton
                    icon="more-horizontal"
                    accessibilityLabel={`Manage ${binding.reference}`}
                    disabled={busy}
                    onPress={() => open({ kind: 'menu', binding })}
                  />
                }
              />
            );
          })
        )}
      </Group>
      <Button
        label="Add binding"
        icon="plus"
        variant="secondary"
        disabled={busy}
        onPress={() => open({ kind: 'add' })}
      />
      <Sheet
        visible={mode !== undefined}
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing.md },
}));
