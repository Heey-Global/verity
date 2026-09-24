import { VerityApiError, type VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import {
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../lib/client';

export default function MatrixSettingsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Connect to your Verity server to configure Matrix."
        screenTitle="Matrix"
      />
    );
  }
  return <MatrixSettingsView client={client} />;
}

function MatrixSettingsView({ client }: { client: VerityClient }) {
  const [endpoint, setEndpoint] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const config = await client.getMatrixConfig();
      setEndpoint(config?.endpoint ?? '');
      setUsername(config?.username ?? '');
      setPasswordConfigured(config?.passwordConfigured ?? false);
      setLoadError(null);
    } catch (cause) {
      setLoadError(
        cause instanceof VerityApiError && cause.status === 404
          ? 'Matrix settings are unavailable on this Verity server. Update the server and retry.'
          : 'Could not load Matrix settings. Check the server connection and retry.',
      );
    } finally {
      setLoading(false);
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const save = async () => {
    setBusy(true);
    try {
      await client.saveMatrixConfig({
        endpoint: endpoint.trim(),
        username: username.trim(),
        password,
      });
      setPassword('');
      setSaveError(null);
      await reload();
    } catch (cause) {
      setSaveError(
        cause instanceof VerityApiError
          ? cause.status === 404
            ? 'Matrix settings are unavailable on this Verity server. Update the server and retry.'
            : cause.status === 409
              ? cause.message
              : cause.status === 400
                ? 'Check the Matrix URL and account ID.'
                : `Could not save the Matrix account (server error ${cause.status}).`
          : 'Could not reach the Verity server to save the Matrix account.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsScaffold title="Matrix" detail onRetry={loadError ? () => void reload() : undefined}>
      <SettingsGroup title="Account" description="One Matrix account serves all projects.">
        {loading ? (
          <ActivityIndicator />
        ) : loadError ? null : (
          <SettingsPanel>
            <View>
              <TextInput
                accessibilityLabel="Matrix homeserver URL"
                value={endpoint}
                onChangeText={setEndpoint}
                placeholder="https://matrix.example.com"
                autoCapitalize="none"
                style={styles.input}
              />
              <TextInput
                accessibilityLabel="Matrix account ID"
                value={username}
                onChangeText={setUsername}
                placeholder="@verity:example.com"
                autoCapitalize="none"
                style={styles.input}
              />
              <TextInput
                accessibilityLabel="Matrix password"
                value={password}
                onChangeText={setPassword}
                placeholder={
                  passwordConfigured ? 'Password saved; enter a new one to replace it' : 'Password'
                }
                secureTextEntry
                style={styles.input}
              />
              <Pressable
                accessibilityRole="button"
                disabled={busy || !endpoint || !username || !password}
                onPress={() => void save()}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonLabel}>Save Matrix account</Text>
              </Pressable>
              <Text style={styles.reproHint}>
                The password is stored encrypted on the server. Assign invited rooms in each
                project's settings.
              </Text>
            </View>
          </SettingsPanel>
        )}
      </SettingsGroup>
      {loadError || saveError ? (
        <SettingsPanel>
          <Text style={styles.reproHint}>{loadError ?? saveError}</Text>
        </SettingsPanel>
      ) : null}
    </SettingsScaffold>
  );
}
