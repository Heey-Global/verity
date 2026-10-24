// The Forgejo connection: where it lives, which projects use it, its token and
// certificate. The server re-validates every credential change.
import {
  VerityApiError,
  codeHostFromConnection,
  type ForgeConnection,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SecretPasteField,
  SettingsDisclosure,
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { Button, HintBox, StatusDot, useConfirm } from '../../../components/ui';
import { createVerityClient } from '../../../lib/client';
import { forgejoConnectionError } from '../../../lib/codeHosts';

export default function ForgejoConnectionScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const connectionId = Array.isArray(id) ? (id[0] ?? '') : (id ?? '');
  const client = useMemo(() => createVerityClient(), []);
  if (!client || connectionId === '') {
    return (
      <SettingsMessage
        title="Connection unavailable"
        subtitle="Go back and open the connection again."
        screenTitle="Forgejo"
      />
    );
  }
  return <ForgejoConnectionView client={client} connectionId={connectionId} />;
}

type Failure = { title: string; message: string };

function ForgejoConnectionView({
  client,
  connectionId,
}: {
  client: VerityClient;
  connectionId: string;
}) {
  const { theme } = useUnistyles();
  const [confirm, confirmSheet] = useConfirm();
  const [connection, setConnection] = useState<ForgeConnection | null | undefined>(undefined);
  const [projects, setProjects] = useState<number | undefined>(undefined);
  const [token, setToken] = useState('');
  const [customCaPem, setCustomCaPem] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [generation, setGeneration] = useState(0);
  const inFlight = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.allSettled([
        Promise.resolve().then(() => client.listConnections()),
        Promise.resolve().then(() => client.getConnectionUsage()),
      ]).then(([list, usage]) => {
        if (!active) return;
        if (list.status === 'fulfilled') {
          const found = list.value?.connections.find((item) => item.id === connectionId) ?? null;
          setConnection(found);
        } else setConnection(null);
        if (usage.status === 'fulfilled') setProjects(usage.value.forgejo[connectionId] ?? 0);
      });
      return () => {
        active = false;
      };
    }, [client, connectionId, generation]),
  );

  const update = useCallback(
    (body: Parameters<VerityClient['updateForgejoConnection']>[1], after?: () => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setFailure(undefined);
      void client
        .updateForgejoConnection(connectionId, body)
        .then((next) => {
          setConnection(next);
          after?.();
        })
        .catch((caught: unknown) => setFailure(forgejoConnectionError(caught)))
        .finally(() => {
          inFlight.current = false;
          setBusy(false);
        });
    },
    [client, connectionId],
  );

  if (connection === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.text} />
      </View>
    );
  }
  if (connection === null) {
    return (
      <SettingsMessage
        title="Connection not found"
        subtitle="It may have been removed on another device."
        screenTitle="Forgejo"
        onRetry={() => setGeneration((value) => value + 1)}
      />
    );
  }
  const host = codeHostFromConnection(connection);
  const inUse = (projects ?? 0) > 0;
  const disconnect = () =>
    confirm({
      title: 'Disconnect Forgejo',
      message: `Verity removes the token for ${host.host}. You can connect it again later.`,
      confirmLabel: 'Disconnect',
      destructive: true,
      onConfirm: () => {
        setBusy(true);
        setFailure(undefined);
        void client
          .deleteConnection(connectionId)
          .then(() => router.back())
          .catch((caught: unknown) =>
            setFailure(
              caught instanceof VerityApiError && caught.status === 409
                ? {
                    title: 'Still in use',
                    message: 'Projects use this connection. Remove them first.',
                  }
                : forgejoConnectionError(caught),
            ),
          )
          .finally(() => setBusy(false));
      },
    });

  return (
    <SettingsScaffold title={host.title} detail>
      <SettingsGroup title="Connection">
        <SettingsPanel>
          <Fact label="Server" value={host.host} />
          <View style={styles.serviceStatusRow}>
            <Text style={styles.pathLabel}>Status</Text>
            <StatusDot intent="ready" label="Connected" />
          </View>
          <Fact
            label="Used in"
            value={
              projects === undefined
                ? '—'
                : `${String(projects)} ${projects === 1 ? 'project' : 'projects'}`
            }
          />
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup title="Access">
        <SettingsDisclosure title="Access token" summary="Configured" icon="key">
          <SecretPasteField
            label="New access token"
            placeholder="Paste token"
            value={token}
            onChangeText={setToken}
            configured
            editable={!busy}
            onBlur={() => undefined}
            masked
          />
          <View style={styles.selfStart}>
            <Button
              label="Replace token"
              variant="secondary"
              size="compact"
              disabled={busy || token.trim() === ''}
              onPress={() => update({ token: token.trim() }, () => setToken(''))}
            />
          </View>
        </SettingsDisclosure>
        <SettingsDisclosure
          title="Custom certificate"
          summary={connection.customCaPem ? 'Configured' : 'Not configured'}
          icon="shield"
        >
          <SecretPasteField
            label="CA certificate (PEM)"
            placeholder="-----BEGIN CERTIFICATE-----"
            value={customCaPem}
            onChangeText={setCustomCaPem}
            configured={Boolean(connection.customCaPem)}
            editable={!busy}
            onBlur={() => undefined}
          />
          <View style={styles.selfStart}>
            <Button
              label="Save certificate"
              variant="secondary"
              size="compact"
              disabled={busy || customCaPem.trim() === ''}
              onPress={() => update({ customCaPem: customCaPem.trim() }, () => setCustomCaPem(''))}
            />
          </View>
          {connection.customCaPem ? (
            <View style={styles.selfStart}>
              <Button
                label="Remove certificate"
                variant="text"
                size="compact"
                disabled={busy}
                onPress={() => update({ customCaPem: null })}
              />
            </View>
          ) : null}
        </SettingsDisclosure>
      </SettingsGroup>
      {failure ? <HintBox title={failure.title} message={failure.message} /> : null}
      <SettingsGroup
        title="Disconnect"
        {...(inUse
          ? {
              description: `Used by ${String(projects)} ${projects === 1 ? 'project' : 'projects'}. Remove them before disconnecting.`,
            }
          : {})}
      >
        <View style={styles.selfStart}>
          <Button
            label="Disconnect Forgejo"
            variant="destructive"
            disabled={busy || inUse}
            onPress={disconnect}
          />
        </View>
      </SettingsGroup>
      {confirmSheet}
    </SettingsScaffold>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.serviceStatusRow}>
      <Text style={styles.pathLabel}>{label}</Text>
      <Text style={styles.reproStatus} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}
