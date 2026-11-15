// The signed-in person's own OpenCode provider: its address and API key. The
// server saves them only after the provider answered with its model list, and
// the key never comes back to the app.
import type { VerityClient } from '@verity/mobile';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';

import { SettingsMessage, SettingsScaffold } from '../../../components/settings/SettingsChrome';
import { Button, Card, TextField } from '../../../components/ui';
import { createVerityClient } from '../../../lib/client';

export default function OpenCodeAccountScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup first."
        screenTitle="OpenCode"
      />
    );
  }
  return <OpenCodeAccountView client={client} />;
}

export function OpenCodeAccountView({
  client,
  onDone = () => router.back(),
}: {
  client: VerityClient;
  onDone?: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const ready = baseUrl.trim() !== '' && apiKey.trim() !== '';

  const save = () => {
    if (!ready) return;
    setSaving(true);
    setError(undefined);
    client
      .setOpenCodeConnection({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
      .then(() => onDone())
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not connect OpenCode'),
      )
      .finally(() => setSaving(false));
  };

  return (
    <SettingsScaffold
      title="OpenCode"
      detail
      state={{ error, saving }}
      footer={
        <Button label="Connect" onPress={save} disabled={!ready} loading={saving} fullWidth />
      }
    >
      <Card stacked>
        <TextField
          label="Provider address"
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder="https://api.example.com/v1"
          keyboardType="url"
          literal
        />
        <TextField label="API key" value={apiKey} onChangeText={setApiKey} secret literal />
      </Card>
    </SettingsScaffold>
  );
}
