// MCP connections: remote HTTP MCP servers configured once here, then enabled
// explicitly per project. Credentials stay on the Verity server — the app sends
// them, and never reads them back.
import { type HttpMcpConnection, type VerityClient } from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { StatusPill } from '../../../../components/StatusPill';
import { createVerityClient } from '../../../../lib/client';
import { runMcpOAuth } from '../../../../lib/mcpOAuth';

export default function McpConnectionsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage MCP connections."
        screenTitle="MCP connections"
      />
    );
  }
  return <McpConnectionsView client={client} />;
}

function McpConnectionsView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [connections, setConnections] = useState<HttpMcpConnection[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const supported = typeof (client as Partial<VerityClient>).listHttpMcpConnections === 'function';
  // Only the newest list response may land: a remove and a refocus can race.
  const revision = useRef(0);
  const mutationInFlight = useRef(false);

  const load = useCallback(async (): Promise<boolean> => {
    if (!supported) {
      // An older server that predates MCP connections. Nothing to show, and
      // nothing wrong either — an error banner here would be a lie.
      setConnections([]);
      return false;
    }
    const generation = ++revision.current;
    return client
      .listHttpMcpConnections()
      .then((loaded) => {
        if (revision.current === generation) {
          setConnections(loaded);
          setError(undefined);
        }
        return true;
      })
      .catch(() => {
        if (revision.current === generation) {
          setConnections((current) => current ?? []);
          setError('Could not load MCP connections.');
        }
        return false;
      });
  }, [client, supported]);

  // Reload on focus, not just on mount: the operator gets here again by popping
  // the Add screen, and a connection they just created has to be on the list.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const connectOAuth = useCallback(
    (connection: HttpMcpConnection) => {
      if (mutationInFlight.current) return;
      mutationInFlight.current = true;
      setBusy(true);
      setError(undefined);
      void runMcpOAuth(connection)
        .then(async (result) => {
          if (result.kind === 'cancelled') return;
          await client.completeHttpMcpOAuth(connection.id, result);
          await load();
        })
        .catch(() => setError('Could not authorize the MCP connection.'))
        .finally(() => {
          mutationInFlight.current = false;
          setBusy(false);
        });
    },
    [client, load],
  );

  const remove = useCallback(
    (connection: HttpMcpConnection) => {
      Alert.alert(
        'Remove MCP connection?',
        `This also removes ${connection.name} from every project.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              if (mutationInFlight.current) return;
              mutationInFlight.current = true;
              revision.current += 1;
              setBusy(true);
              setError(undefined);
              void client
                .deleteHttpMcpConnection(connection.id)
                .then(() => load())
                .catch(() => setError('Could not remove the MCP connection.'))
                .finally(() => {
                  mutationInFlight.current = false;
                  setBusy(false);
                });
            },
          },
        ],
      );
    },
    [client, load],
  );

  return (
    <SettingsScaffold title="MCP connections" detail onRetry={() => void load()}>
      <SettingsGroup
        title="Connections"
        description="Configure remote HTTP MCP servers once, then enable them explicitly per project. Credentials stay on the Verity server."
      >
        {connections === undefined ? (
          <View style={styles.signingKeyLoadingRow}>
            <ActivityIndicator size="small" color={theme.colors.setup.text} />
            <Text style={styles.disclosureSummary}>Loading connections…</Text>
          </View>
        ) : null}
        {connections?.length === 0 ? (
          <Text style={styles.reproSubtitle}>No MCP connections yet.</Text>
        ) : null}
        {connections?.map((connection) => (
          <SettingsPanel key={connection.id}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.disclosureTitle}>{connection.name}</Text>
              {connection.authType === 'oauth' ? (
                <StatusPill
                  quiet
                  intent={connection.oauthConnected ? 'ready' : 'needsSetup'}
                  label={connection.oauthConnected ? 'Authorized' : 'Not authorized'}
                />
              ) : null}
            </View>
            <Text style={styles.identityEmail} numberOfLines={1}>
              {connection.url}
            </Text>
            {connection.authType === 'oauth' ? (
              <Pressable
                style={({ pressed }) => [
                  styles.reproButton,
                  busy ? styles.buttonDisabled : null,
                  pressed ? styles.pressed : null,
                ]}
                onPress={() => connectOAuth(connection)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`${connection.oauthConnected ? 'Reconnect' : 'Connect'} OAuth for ${connection.name}`}
              >
                <Text style={styles.reproButtonLabel}>
                  {connection.oauthConnected ? 'Reconnect OAuth' : 'Connect OAuth'}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [
                styles.reproButton,
                busy ? styles.buttonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => remove(connection)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${connection.name} MCP connection`}
            >
              <Text style={styles.reproButtonLabel}>Remove</Text>
            </Pressable>
          </SettingsPanel>
        ))}
        {error !== undefined ? <Text style={styles.fieldError}>{error}</Text> : null}
        {supported ? (
          <SettingsListPanel>
            <SettingsNavRow
              icon="plus"
              title="Add connection"
              onPress={() => router.push('/settings/services/mcp/new')}
            />
          </SettingsListPanel>
        ) : null}
      </SettingsGroup>
    </SettingsScaffold>
  );
}
