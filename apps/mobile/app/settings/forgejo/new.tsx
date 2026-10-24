// Connecting the Forgejo instance: server URL and an access token the server
// validates before storing. The token never comes back to the app.
import { forgejoConnection, type VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  SecretPasteField,
  SettingsDisclosure,
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { Button, HintBox, TextField } from '../../../components/ui';
import { createVerityClient } from '../../../lib/client';
import { forgejoConnectionError } from '../../../lib/codeHosts';

export default function NewForgejoConnectionScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Connect to your Verity server first."
        screenTitle="Connect Forgejo"
      />
    );
  }
  return <NewForgejoConnection client={client} />;
}

function NewForgejoConnection({ client }: { client: VerityClient }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [customCaPem, setCustomCaPem] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | undefined>();
  const inFlight = useRef(false);

  // The app keeps one Forgejo connection; a second visit manages the existing one.
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => client.listConnections())
      .then((list) => {
        const existing = forgejoConnection(list);
        if (active && existing)
          router.replace({ pathname: '/settings/forgejo/[id]', params: { id: existing.id } });
      })
      .catch(() => {
        // Creating still works; the server validates whatever is submitted.
      });
    return () => {
      active = false;
    };
  }, [client]);
  const incomplete = baseUrl.trim() === '' || token.trim() === '';

  const connect = useCallback(() => {
    if (inFlight.current || incomplete) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    void client
      .createForgejoConnection({
        baseUrl: baseUrl.trim(),
        label: 'Forgejo',
        token: token.trim(),
        ...(customCaPem.trim() === '' ? {} : { customCaPem: customCaPem.trim() }),
      })
      .then((connection) =>
        router.replace({ pathname: '/settings/forgejo/[id]', params: { id: connection.id } }),
      )
      .catch((caught: unknown) => setError(forgejoConnectionError(caught)))
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  }, [baseUrl, client, customCaPem, incomplete, token]);

  return (
    <SettingsScaffold
      title="Connect Forgejo"
      detail
      footer={
        <Button
          label="Connect Forgejo"
          onPress={connect}
          loading={busy}
          disabled={incomplete || busy}
          fullWidth
        />
      }
    >
      <SettingsGroup title="Instance">
        <SettingsPanel>
          <TextField
            label="Server URL"
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder="https://git.example.org"
            keyboardType="url"
            literal
            disabled={busy}
          />
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup
        title="Access"
        description="Create a token in Forgejo under Settings → Applications with read and write access to repositories and issues. Repository-specific tokens are supported; user access is not required."
      >
        <SettingsPanel>
          <SecretPasteField
            label="Access token"
            placeholder="Paste token"
            value={token}
            onChangeText={setToken}
            configured={false}
            editable={!busy}
            onBlur={() => undefined}
            masked
          />
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup title="Certificate">
        <SettingsDisclosure
          title="Custom certificate"
          summary={customCaPem.trim() === '' ? 'Optional' : 'Added'}
          icon="shield"
        >
          <View style={styles.pathContent}>
            <SecretPasteField
              label="CA certificate (PEM)"
              placeholder="-----BEGIN CERTIFICATE-----"
              value={customCaPem}
              onChangeText={setCustomCaPem}
              configured={customCaPem.trim() !== ''}
              editable={!busy}
              onBlur={() => undefined}
            />
          </View>
        </SettingsDisclosure>
      </SettingsGroup>
      {error ? <HintBox title={error.title} message={error.message} /> : null}
    </SettingsScaffold>
  );
}
