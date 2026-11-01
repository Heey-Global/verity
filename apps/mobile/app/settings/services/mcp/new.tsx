// Remote HTTP MCP setup uses metadata discovery, with manual OAuth as a fallback.
import { type VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Platform, Text } from 'react-native';
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';
import { mcpOAuthCallbackUri } from '../../../../lib/mcpOAuth';
import { Button, Card, TextField, ToggleRow } from '../../../../components/ui';

export default function NewMcpConnectionScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage MCP connections."
        screenTitle="Add MCP connection"
      />
    );
  return <NewMcpConnectionView client={client} />;
}

function NewMcpConnectionView({ client }: { client: VerityClient }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [useOAuth, setUseOAuth] = useState(false);
  const [manual, setManual] = useState(false);
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthAuthorizationEndpoint, setOauthAuthorizationEndpoint] = useState('');
  const [oauthTokenEndpoint, setOauthTokenEndpoint] = useState('');
  const [oauthScopes, setOauthScopes] = useState('');
  const [tokenAuthMethod, setTokenAuthMethod] = useState<
    'none' | 'client_secret_post' | 'client_secret_basic'
  >('client_secret_post');
  const [discoveredUrl, setDiscoveredUrl] = useState<string | undefined>();
  const [registrationAvailable, setRegistrationAvailable] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submissionInFlight = useRef(false);
  const discoveryRevision = useRef(0);
  const callback = mcpOAuthCallbackUri();
  const unsupportedWeb =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const detected = discoveredUrl === url.trim();

  const discover = async () => {
    const requestedUrl = url.trim();
    const revision = ++discoveryRevision.current;
    setDiscovering(true);
    setError(undefined);
    try {
      const result = await client.discoverHttpMcpOAuth(requestedUrl);
      if (revision !== discoveryRevision.current) return;
      setOauthAuthorizationEndpoint(result.authorizationEndpoint);
      setOauthTokenEndpoint(result.tokenEndpoint);
      setOauthScopes(result.scopes);
      setRegistrationAvailable(result.registrationAvailable);
      setDiscoveredUrl(requestedUrl);
    } catch {
      if (revision === discoveryRevision.current) {
        setManual(true);
        setError(
          'OAuth could not be detected. Check the URL or enter the provider settings under Advanced.',
        );
      }
    } finally {
      if (revision === discoveryRevision.current) setDiscovering(false);
    }
  };

  const add = () => {
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
              ...(oauthClientId.trim()
                ? { oauthClientId: oauthClientId.trim(), oauthTokenAuthMethod: tokenAuthMethod }
                : {}),
              ...(oauthClientSecret.trim() ? { oauthClientSecret: oauthClientSecret.trim() } : {}),
              ...((detected || manual) && oauthAuthorizationEndpoint.trim()
                ? { oauthAuthorizationEndpoint: oauthAuthorizationEndpoint.trim() }
                : {}),
              ...((detected || manual) && oauthTokenEndpoint.trim()
                ? { oauthTokenEndpoint: oauthTokenEndpoint.trim() }
                : {}),
              ...(detected || manual ? { oauthScopes: oauthScopes.trim() } : {}),
            }
          : authorization.trim()
            ? { authorization: authorization.trim() }
            : {}),
      })
      .then(() => router.back())
      .catch((caught: unknown) =>
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not save the MCP connection. Use a public HTTPS URL.',
        ),
      )
      .finally(() => {
        submissionInFlight.current = false;
        setBusy(false);
      });
  };
  const incomplete =
    name.trim() === '' ||
    url.trim() === '' ||
    (useOAuth &&
      (unsupportedWeb ||
        (manual &&
          (((!detected || !registrationAvailable) && !oauthClientId.trim()) ||
            !oauthAuthorizationEndpoint.trim() ||
            !oauthTokenEndpoint.trim())) ||
        (detected && !registrationAvailable && !oauthClientId.trim())));

  return (
    <SettingsScaffold title="Add MCP connection" detail>
      <SettingsGroup title="Server">
        <SettingsPanel>
          <TextField
            label="Connection name"
            value={name}
            onChangeText={setName}
            placeholder="my-tools"
            literal
            disabled={busy}
          />
          <TextField
            label="Remote HTTPS MCP URL"
            value={url}
            onChangeText={(value) => {
              ++discoveryRevision.current;
              setDiscovering(false);
              setDiscoveredUrl(undefined);
              setRegistrationAvailable(false);
              if (!manual) {
                setOauthAuthorizationEndpoint('');
                setOauthTokenEndpoint('');
                setOauthScopes('');
              }
              setUrl(value);
            }}
            keyboardType="url"
            placeholder="https://mcp.example.com/mcp"
            disabled={busy}
          />
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup title="Authentication">
        <SettingsPanel>
          <Card flush>
            <ToggleRow
              title="Use OAuth 2.0"
              value={useOAuth}
              disabled={busy}
              onValueChange={setUseOAuth}
            />
          </Card>
          {useOAuth ? (
            <>
              {unsupportedWeb ? (
                <Text style={styles.fieldError}>
                  Web OAuth requires HTTPS or localhost. Open Verity through an HTTPS address, such
                  as your Tailscale HTTPS hostname.
                </Text>
              ) : null}
              <Button
                label="Detect OAuth settings"
                disabled={!url.trim() || busy}
                loading={discovering}
                onPress={() => {
                  void discover();
                }}
              />
              {detected ? (
                <Text style={styles.pathLabel}>
                  {registrationAvailable
                    ? 'OAuth detected. Verity can register a client automatically.'
                    : 'OAuth detected. This provider requires your own OAuth client ID.'}
                </Text>
              ) : null}
              <TextField
                label="OAuth client ID"
                value={oauthClientId}
                onChangeText={setOauthClientId}
                placeholder="Leave empty for automatic registration"
                literal
                disabled={busy}
              />
              <TextField
                label="OAuth client secret (optional)"
                value={oauthClientSecret}
                onChangeText={setOauthClientSecret}
                secret
                disabled={busy}
              />
              <Text style={styles.pathLabel}>OAuth callback URL</Text>
              <Text selectable style={styles.pathLabel}>
                {callback}
              </Text>
              <Button
                label="Copy callback URL"
                variant="secondary"
                onPress={() => {
                  void Clipboard.setStringAsync(callback);
                }}
              />
              <Text style={styles.pathLabel}>
                When using your own OAuth app, register this exact callback URL with the provider.
                Automatic registration configures it for you.
              </Text>
              <Card flush>
                <ToggleRow
                  title="Advanced OAuth settings"
                  value={manual}
                  disabled={busy}
                  onValueChange={setManual}
                />
              </Card>
              {manual ? (
                <>
                  <Card flush>
                    {(
                      [
                        ['client_secret_post', 'Client secret in request body'],
                        ['client_secret_basic', 'Client secret via HTTP Basic'],
                        ['none', 'Public client (PKCE only)'],
                      ] as const
                    ).map(([method, title]) => (
                      <SettingsChoiceRow
                        key={method}
                        title={title}
                        selected={tokenAuthMethod === method}
                        disabled={busy}
                        onPress={() => setTokenAuthMethod(method)}
                      />
                    ))}
                  </Card>
                  <TextField
                    label="Authorization endpoint"
                    value={oauthAuthorizationEndpoint}
                    onChangeText={setOauthAuthorizationEndpoint}
                    keyboardType="url"
                    disabled={busy}
                  />
                  <TextField
                    label="Token endpoint"
                    value={oauthTokenEndpoint}
                    onChangeText={setOauthTokenEndpoint}
                    keyboardType="url"
                    disabled={busy}
                  />
                  <TextField
                    label="OAuth scopes"
                    value={oauthScopes}
                    onChangeText={setOauthScopes}
                    placeholder="Provider scopes, passed unchanged"
                    literal
                    disabled={busy}
                  />
                </>
              ) : null}
            </>
          ) : (
            <TextField
              label="Authorization header (optional)"
              accessibilityLabel="Authorization header"
              value={authorization}
              onChangeText={setAuthorization}
              placeholder="Bearer …"
              secret
              disabled={busy}
            />
          )}
        </SettingsPanel>
      </SettingsGroup>
      {error !== undefined ? (
        <Text style={styles.fieldError} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button
        label="Add connection"
        accessibilityLabel="Add MCP connection"
        loading={busy}
        disabled={incomplete || discovering}
        onPress={add}
        fullWidth
      />
    </SettingsScaffold>
  );
}
