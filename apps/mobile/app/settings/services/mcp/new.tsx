// Adding one remote HTTP MCP connection.
//
// A full screen rather than a form wedged under the list: OAuth needs five more
// fields than a static header does, and the operator is pasting endpoints from
// another app while filling it in.
import { type VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';
import { isOfficialGmailMcpUrl } from '../../../../lib/mcpOAuth';

export default function NewMcpConnectionScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage MCP connections."
        screenTitle="Add MCP connection"
      />
    );
  }
  return <NewMcpConnectionView client={client} />;
}

function NewMcpConnectionView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [useOAuth, setUseOAuth] = useState(false);
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthAuthorizationEndpoint, setOauthAuthorizationEndpoint] = useState('');
  const [oauthTokenEndpoint, setOauthTokenEndpoint] = useState('');
  const [oauthScopes, setOauthScopes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const submissionInFlight = useRef(false);

  const add = useCallback(() => {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    setBusy(true);
    setError(undefined);
    void client
      .createHttpMcpConnection({
        name: name.trim(),
        url: url.trim(),
        authType: useOAuth ? 'oauth' : authorization.trim() === '' ? 'none' : 'static',
        ...(useOAuth
          ? {
              oauthClientId: oauthClientId.trim(),
              ...(oauthClientSecret.trim() === ''
                ? {}
                : { oauthClientSecret: oauthClientSecret.trim() }),
              oauthAuthorizationEndpoint: oauthAuthorizationEndpoint.trim(),
              oauthTokenEndpoint: oauthTokenEndpoint.trim(),
              oauthScopes: oauthScopes.trim(),
            }
          : authorization.trim() === ''
            ? {}
            : { authorization: authorization.trim() }),
      })
      // Back to the list, which reloads on focus and shows the new connection —
      // including its "Connect OAuth" action, which is the next step.
      .then(() => router.back())
      .catch(() => setError('Could not save the MCP connection. Use a public HTTPS URL.'))
      .finally(() => {
        submissionInFlight.current = false;
        setBusy(false);
      });
  }, [
    authorization,
    client,
    name,
    oauthAuthorizationEndpoint,
    oauthClientId,
    oauthClientSecret,
    oauthScopes,
    oauthTokenEndpoint,
    url,
    useOAuth,
  ]);

  const oauthFields: {
    label: string;
    value: string;
    onChangeText: (next: string) => void;
    placeholder: string;
    secure?: boolean;
  }[] = [
    {
      label: 'OAuth client ID',
      value: oauthClientId,
      onChangeText: setOauthClientId,
      placeholder: 'Client ID',
    },
    {
      label: 'OAuth client secret (optional)',
      value: oauthClientSecret,
      onChangeText: setOauthClientSecret,
      placeholder: 'Client secret',
      secure: true,
    },
    {
      label: 'Authorization endpoint',
      value: oauthAuthorizationEndpoint,
      onChangeText: setOauthAuthorizationEndpoint,
      placeholder: 'https://accounts.example.com/oauth/authorize',
    },
    {
      label: 'Token endpoint',
      value: oauthTokenEndpoint,
      onChangeText: setOauthTokenEndpoint,
      placeholder: 'https://accounts.example.com/oauth/token',
    },
    {
      label: 'OAuth scopes (space-separated)',
      value: oauthScopes,
      onChangeText: setOauthScopes,
      placeholder: 'openid profile',
    },
  ];

  const incomplete =
    name.trim() === '' ||
    url.trim() === '' ||
    (useOAuth &&
      (oauthClientId.trim() === '' ||
        oauthAuthorizationEndpoint.trim() === '' ||
        oauthTokenEndpoint.trim() === '' ||
        oauthScopes.trim() === ''));

  return (
    <SettingsScaffold title="Add MCP connection" detail>
      <SettingsGroup title="Server">
        <SettingsPanel>
          <View style={styles.pathContent}>
            <Text style={styles.pathLabel}>Connection name</Text>
            <TextInput
              style={styles.pathInput}
              value={name}
              onChangeText={setName}
              placeholder="gmail"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              accessibilityLabel="Connection name"
            />
          </View>
          <View style={styles.pathContent}>
            <Text style={styles.pathLabel}>Remote HTTPS MCP URL</Text>
            <TextInput
              style={styles.pathInput}
              value={url}
              onChangeText={setUrl}
              placeholder="https://mcp.example.com/gmail"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="Remote HTTPS MCP URL"
            />
          </View>
        </SettingsPanel>
      </SettingsGroup>

      <SettingsGroup title="Authentication">
        <SettingsPanel>
          <Pressable
            style={({ pressed }) => [styles.reproButton, pressed ? styles.pressed : null]}
            onPress={() => {
              if (Platform.OS !== 'ios') return;
              const next = !useOAuth;
              setUseOAuth(next);
              // Google's endpoints are not discoverable from the MCP URL, and
              // typing them by hand is where this flow usually fails.
              if (next && isOfficialGmailMcpUrl(url.trim())) {
                setOauthAuthorizationEndpoint('https://accounts.google.com/o/oauth2/v2/auth');
                setOauthTokenEndpoint('https://oauth2.googleapis.com/token');
                setOauthScopes(
                  'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
                );
              }
            }}
            accessibilityRole="switch"
            accessibilityState={{ checked: useOAuth }}
            disabled={Platform.OS !== 'ios'}
          >
            <Text style={styles.reproButtonLabel}>
              {Platform.OS !== 'ios'
                ? 'OAuth 2.0 requires Verity for iOS'
                : useOAuth
                  ? 'OAuth 2.0 enabled'
                  : 'Use OAuth 2.0'}
            </Text>
          </Pressable>

          {useOAuth ? (
            oauthFields.map((field) => (
              <View style={styles.pathContent} key={field.label}>
                <Text style={styles.pathLabel}>{field.label}</Text>
                <TextInput
                  style={styles.pathInput}
                  value={field.value}
                  onChangeText={field.onChangeText}
                  placeholder={field.placeholder}
                  placeholderTextColor={theme.colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={field.secure === true}
                  accessibilityLabel={field.label}
                />
              </View>
            ))
          ) : (
            <View style={styles.pathContent}>
              <Text style={styles.pathLabel}>Authorization header (optional)</Text>
              <TextInput
                style={styles.pathInput}
                value={authorization}
                onChangeText={setAuthorization}
                placeholder="Bearer …"
                placeholderTextColor={theme.colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                accessibilityLabel="Authorization header"
              />
            </View>
          )}
        </SettingsPanel>
      </SettingsGroup>

      {error !== undefined ? <Text style={styles.fieldError}>{error}</Text> : null}

      <Pressable
        style={({ pressed }) => [
          styles.primaryButton,
          busy || incomplete ? styles.buttonDisabled : null,
          pressed ? styles.pressed : null,
        ]}
        onPress={add}
        disabled={busy || incomplete}
        accessibilityRole="button"
        accessibilityLabel="Add MCP connection"
      >
        <Text style={styles.primaryButtonLabel}>{busy ? 'Saving…' : 'Add connection'}</Text>
      </Pressable>
    </SettingsScaffold>
  );
}
