import { VerityApiError, type VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import {
  SecretPasteField,
  SettingsField,
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../../lib/client';

export default function MatrixAccountScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Connect to your Verity server to configure Matrix."
        screenTitle="Matrix account"
      />
    );
  }
  return <MatrixAccountView client={client} />;
}

type SavedAccount = { endpoint: string; username: string; passwordConfigured: boolean };

/**
 * The Matrix account form has two shapes, because the server has two rules.
 *
 * Before the first save every field is required. After it, the homeserver and
 * account ID are fixed — the server refuses to change them because the worker's
 * device store and room bindings belong to that identity — and only the password
 * may be replaced. Showing the fixed values as editable inputs invited edits the
 * server would reject, so the configured shape shows them as plain text and
 * offers nothing but a password box.
 */
function MatrixAccountView({ client }: { client: VerityClient }) {
  const [saved, setSaved] = useState<SavedAccount | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const config = await client.getMatrixConfig();
      setSaved(
        config
          ? {
              endpoint: config.endpoint,
              username: config.username,
              passwordConfigured: config.passwordConfigured,
            }
          : null,
      );
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

  const configured = saved !== null;
  // What a save would send: the fixed identity once configured, the typed one before.
  const account = saved
    ? { endpoint: saved.endpoint, username: saved.username }
    : { endpoint: endpoint.trim(), username: username.trim() };
  const passwordConfigured = saved?.passwordConfigured ?? false;
  const dirty = configured
    ? password !== ''
    : endpoint.trim() !== '' || username.trim() !== '' || password !== '';
  const complete = account.endpoint !== '' && account.username !== '' && password !== '';
  const canSave = complete && !busy;

  const save = async () => {
    setBusy(true);
    try {
      await client.saveMatrixConfig({ ...account, password });
      setPassword('');
      setSaveError(null);
      setSavedAt(Date.now());
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
    <SettingsScaffold
      title="Matrix account"
      detail
      onRetry={loadError ? () => void reload() : undefined}
    >
      <SettingsGroup
        title="Account"
        description={
          configured
            ? 'The homeserver and account ID are fixed once saved. Only the password can be replaced.'
            : 'One Matrix account serves all projects.'
        }
      >
        {loading ? (
          <ActivityIndicator />
        ) : loadError ? null : (
          <SettingsPanel>
            {saved ? (
              <>
                <View style={styles.pathContent}>
                  <Text style={styles.pathLabel}>Homeserver URL</Text>
                  <Text style={styles.reproSubtitle} selectable>
                    {saved.endpoint}
                  </Text>
                </View>
                <View style={styles.pathContent}>
                  <Text style={styles.pathLabel}>Account ID</Text>
                  <Text style={styles.reproSubtitle} selectable>
                    {saved.username}
                  </Text>
                </View>
              </>
            ) : (
              <>
                <SettingsField
                  label="Homeserver URL"
                  value={endpoint}
                  onChangeText={setEndpoint}
                  onBlur={() => {}}
                  placeholder="https://matrix.example.com"
                  accessibilityLabel="Matrix homeserver URL"
                  keyboardType="url"
                />
                <SettingsField
                  label="Account ID"
                  value={username}
                  onChangeText={setUsername}
                  onBlur={() => {}}
                  placeholder="@verity:example.com"
                  accessibilityLabel="Matrix account ID"
                />
              </>
            )}
            <SecretPasteField
              label="Password"
              placeholder={passwordConfigured ? 'Enter a new password to replace it' : 'Password'}
              value={password}
              onChangeText={setPassword}
              configured={passwordConfigured}
              editable={!busy}
              onBlur={() => {}}
              accessibilityLabel="Matrix password"
              masked
            />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              disabled={!canSave}
              onPress={() => void save()}
              style={[styles.primaryButton, !canSave ? styles.buttonDisabled : null]}
            >
              <Text style={styles.primaryButtonLabel}>
                {busy ? 'Saving…' : configured ? 'Update password' : 'Save Matrix account'}
              </Text>
            </Pressable>
            {saveError ? <Text style={styles.fieldError}>{saveError}</Text> : null}
            <Text style={styles.settingsSaveState} accessibilityLiveRegion="polite">
              {busy
                ? 'Saving changes…'
                : dirty
                  ? 'Unsaved changes'
                  : savedAt !== undefined
                    ? `Saved at ${new Date(savedAt).toLocaleTimeString()}.`
                    : configured
                      ? 'All changes saved'
                      : ''}
            </Text>
            <Text style={styles.reproHint}>
              {configured
                ? "The password is stored encrypted on the server. To use a different homeserver or account, reset the connector's device store and room bindings first."
                : "The password is stored encrypted on the server. Assign invited rooms in each project's settings."}
            </Text>
          </SettingsPanel>
        )}
      </SettingsGroup>
      {loadError ? (
        <SettingsPanel>
          <Text style={styles.reproHint}>{loadError}</Text>
        </SettingsPanel>
      ) : null}
    </SettingsScaffold>
  );
}
