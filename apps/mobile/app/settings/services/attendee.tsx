import { secretStoreManaged, secretWritable, type VerityClient } from '@verity/mobile';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text } from 'react-native';
import {
  SecretPasteField,
  SettingsGroup,
  SettingsPanel,
  SettingsMessage,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { SecretStoreSection } from '../../../components/settings/SecretStoreSection';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../lib/client';
import { useLoadVeritySettings, useVeritySettings } from '../../../lib/settingsStore';
export default function AttendeeScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <AttendeeView client={client} />
  ) : (
    <SettingsMessage
      title="Not connected"
      subtitle="Connect to your Verity server first."
      screenTitle="Attendee"
    />
  );
}
function AttendeeView({ client }: { client: VerityClient }) {
  useLoadVeritySettings(client);
  const { secretStatus } = useVeritySettings();
  const writable =
    secretStatus !== undefined && secretStoreManaged(secretStatus) && secretWritable(secretStatus);
  return (
    <SettingsScaffold title="Attendee" detail>
      <SecretStoreSection client={client} />
      <AttendeeSettings client={client} writable={writable} />
    </SettingsScaffold>
  );
}
function AttendeeSettings({ client, writable }: { client: VerityClient; writable: boolean }) {
  const [configured, setConfigured] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void client
      .getAttendeeSettings?.()
      .then((value) => setConfigured(value.configured))
      .catch(() => undefined);
  }, [client]);
  const run = async (action: 'save' | 'test' | 'remove') => {
    setBusy(true);
    setMessage('');
    try {
      if (action === 'test') {
        await client.testAttendee();
        setMessage('Connection verified.');
      } else {
        await client.saveAttendeeSettings(
          action === 'remove'
            ? null
            : { apiKey: apiKey.trim(), webhookSecret: webhookSecret.trim() },
        );
        setConfigured(action !== 'remove');
        setApiKey('');
        setWebhookSecret('');
        setMessage(
          action === 'remove'
            ? 'Attendee disconnected. Active meetings continue until ended.'
            : 'Attendee saved.',
        );
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsGroup
      title="Attendee"
      description="Online meeting bots and live transcripts. Requires premium Uplink / Online Sharing."
    >
      <SettingsPanel>
        <SecretPasteField
          label="API key"
          onBlur={() => undefined}
          value={apiKey}
          onChangeText={setApiKey}
          configured={configured}
          editable={writable && !busy}
          masked
          placeholder="Paste the Attendee API key…"
        />
        <SecretPasteField
          label="Webhook secret"
          onBlur={() => undefined}
          value={webhookSecret}
          onChangeText={setWebhookSecret}
          configured={configured}
          editable={writable && !busy}
          masked
          placeholder="From Attendee Settings → Webhooks…"
        />
        {!writable ? (
          <Text style={styles.reproHint}>Unlock the secret store to configure Attendee.</Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!writable || busy || !apiKey.trim() || !webhookSecret.trim()}
          onPress={() => void run('save')}
        >
          <Text style={styles.reproHint}>Save Attendee</Text>
        </Pressable>
        {configured ? (
          <>
            <Pressable
              accessibilityRole="button"
              disabled={!writable || busy}
              onPress={() => void run('test')}
            >
              <Text style={styles.reproHint}>Test connection</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!writable || busy}
              onPress={() => void run('remove')}
            >
              <Text style={styles.reproHint}>Remove connection</Text>
            </Pressable>
          </>
        ) : null}
        {message ? <Text style={styles.reproHint}>{message}</Text> : null}
      </SettingsPanel>
    </SettingsGroup>
  );
}
