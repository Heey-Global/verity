// Connected services: the credentials and optional integrations Verity hands to
// project containers. Everything on this screen is gated on the secret store —
// while it is sealed the boxes are read-only, because a write would 503 and the
// operator would be left guessing why.
import {
  secretStoreManaged,
  secretWritable,
  transcriptionBackendStatus,
  type AgentLoginProvider,
  type VerityClient,
} from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AgentLoginPanel } from '../../../components/AgentLoginPanel';
import { SecretStoreSection } from '../../../components/settings/SecretStoreSection';
import {
  SecretPasteField,
  SettingsDisclosure,
  SettingsField,
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsPanel,
  SettingsSaveState,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { StatusPill } from '../../../components/StatusPill';
import { createVerityClient } from '../../../lib/client';
import {
  patchVeritySettingsLocally,
  refreshSecretStatus,
  retryFailedVeritySettings,
  saveVeritySettings,
  setVeritySettingsError,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../../lib/settingsStore';
import { useSecretFields } from '../../../lib/useSecretFields';
import { useSettingsFields } from '../../../lib/useSettingsFields';

// Module-level: these arrays' identity drives the field hooks, and they are the
// complete list of keys a save from this screen may contain.
const TEXT_FIELDS = ['transcribeBaseUrl', 'transcribeModel', 'opencodeBaseUrl'] as const;
const SECRET_FIELDS = [
  'uplinkSubscriptionKey',
  'transcribeApiKey',
  'opencodeApiKey',
  'dopplerServiceToken',
] as const;

/**
 * Which login the `?agentLogin=` deep link should open on arrival, if any.
 *
 * Matched against the known providers rather than cast: the parameter comes off a
 * URL and can say anything — including, when it is repeated, an array — and an
 * unrecognised value has to land on the panel doing nothing rather than
 * auto-start a provider that does not exist.
 */
function autoStartLoginProvider(
  agentLogin: string | string[] | undefined,
): AgentLoginProvider | undefined {
  return agentLogin === 'claude' || agentLogin === 'codex' ? agentLogin : undefined;
}

export default function ServicesSettingsScreen() {
  const { agentLogin } = useLocalSearchParams<{ agentLogin?: string | string[] }>();
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to edit Verity settings."
        screenTitle="Connected services"
      />
    );
  }
  return <ServicesSettingsView client={client} agentLogin={agentLogin} />;
}

function ServicesSettingsView({
  client,
  agentLogin,
}: {
  client: VerityClient;
  agentLogin?: string | string[];
}) {
  const reload = useLoadVeritySettings(client);
  const { settings, secretStatus } = useVeritySettings();
  const text = useSettingsFields(client, TEXT_FIELDS);
  const secrets = useSecretFields(client, SECRET_FIELDS);

  // Secret values may only be written once the store is unlocked (a write while
  // sealed 503s). Until the first status resolves, treat as not-yet-writable.
  const writable = secretStatus !== undefined && secretWritable(secretStatus);
  // Whether this deployment manages a cipher at all. `unmanaged` (and the
  // pre-fetch `undefined`) mean there is no secret store, so the paste fields and
  // the unlock hints hide — matching SecretStoreSection, which renders nothing.
  const managed = secretStoreManaged(secretStatus);
  const backendMode = settings?.transcribeBackendMode ?? null;
  const opencodeReady =
    (settings?.opencodeApiKeyConfigured ?? false) &&
    text.values.opencodeBaseUrl.trim() !== '' &&
    (settings?.opencodeModels ?? '').trim() !== '';

  return (
    <SettingsScaffold
      title="Services"
      detail
      onRetry={() => {
        const hasDirtyFields = text.dirty || secrets.dirty;
        if (text.dirty) text.commit();
        if (secrets.dirty) secrets.commit();
        if (!hasDirtyFields) {
          void retryFailedVeritySettings(client).then((retried) => {
            if (!retried) reload();
          });
        }
      }}
    >
      <SecretStoreSection client={client} />

      {managed ? (
        <SettingsGroup title="AI backends" description="Subscriptions and API providers.">
          {writable ? (
            <View style={styles.panelStack}>
              <AgentLoginPanel
                client={client}
                configured={{
                  claude: settings?.claudeCodeOauthCredentialsConfigured ?? false,
                  codex: settings?.codexAuthJsonConfigured ?? false,
                }}
                onConfiguredChange={(provider, configured) =>
                  patchVeritySettingsLocally((current) => ({
                    ...current,
                    ...(provider === 'claude'
                      ? { claudeCodeOauthCredentialsConfigured: configured }
                      : { codexAuthJsonConfigured: configured }),
                  }))
                }
                onSealed={() => {
                  setVeritySettingsError('Unlock the secret store first.');
                  void refreshSecretStatus(client);
                }}
                compact
                showGuidance={false}
                allowDisconnect
                autoStartProvider={autoStartLoginProvider(agentLogin)}
              />
            </View>
          ) : (
            <SettingsPanel>
              <Text style={styles.reproHint}>
                {autoStartLoginProvider(agentLogin) === undefined
                  ? 'Unlock the secret store to change these.'
                  : // Arrived from the banner's "Sign in to Codex", into a store
                    // that cannot hold the new login yet. Saying only "unlock to
                    // change these" reads as if the tap went nowhere; the panel
                    // mounts and auto-starts the moment the store is unlocked.
                    'Unlock the secret store to sign in — the login will start once it is open.'}
              </Text>
            </SettingsPanel>
          )}

          <SettingsDisclosure
            onCollapse={() => {
              text.commit();
              secrets.commit();
            }}
            title="OpenCode"
            summary={opencodeReady ? 'Configured' : 'Not configured'}
          >
            <Text style={styles.reproSubtitle}>
              Verity automatically loads all models offered by your OpenAI-compatible API.
            </Text>
            <SettingsField
              label="API base URL"
              value={text.values.opencodeBaseUrl}
              onChangeText={(value) => text.set('opencodeBaseUrl', value)}
              onBlur={text.commit}
              placeholder="https://api.example.com/v1"
              accessibilityLabel="OpenCode API base URL"
              keyboardType="url"
            />
            <SecretPasteField
              label="API key"
              placeholder="Paste the provider API key…"
              value={secrets.values.opencodeApiKey}
              onChangeText={(value) => secrets.set('opencodeApiKey', value)}
              configured={settings?.opencodeApiKeyConfigured ?? false}
              editable={writable}
              onBlur={secrets.commit}
              masked
            />
            {!writable ? (
              <Text style={styles.reproHint}>Unlock credentials to configure OpenCode.</Text>
            ) : null}
          </SettingsDisclosure>
        </SettingsGroup>
      ) : null}

      {managed ? (
        <SettingsGroup title="Meeting transcription">
          <SettingsDisclosure
            onCollapse={() => {
              text.commit();
              secrets.commit();
            }}
            title="Transcription"
            summary={
              transcriptionBackendStatus(
                backendMode,
                settings?.transcribeExternalConfigured === true,
              ).label
            }
          >
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.disclosureTitle}>Backend</Text>
              {/*
                What counts as "set up" is a contract with the server, not a
                rendering detail — it lives in `transcriptionBackendStatus` and
                is tested there. Neither a backend this deployment cannot run
                (the removed local one) nor one it cannot reach (external with
                no URL/model) may read as ready while uploads are rejected.
                `transcribeExternalConfigured` is the server's own answer, so
                the pill agrees with the upload path even when the endpoint
                comes from the deployment environment rather than these fields.
              */}
              <StatusPill
                quiet
                {...transcriptionBackendStatus(
                  backendMode,
                  settings?.transcribeExternalConfigured === true,
                )}
              />
            </View>
            <Text style={styles.reproSubtitle}>
              Choose where Verity processes meeting audio. You can change this later.
            </Text>
            <View style={styles.backendChoices} accessibilityRole="radiogroup">
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{
                  checked: backendMode === 'local',
                  disabled: settings?.transcribeLocalAvailable !== true,
                }}
                accessibilityLabel="Use local transcription"
                disabled={settings?.transcribeLocalAvailable !== true}
                onPress={() => void saveVeritySettings(client, { transcribeBackendMode: 'local' })}
                style={[
                  styles.backendChoice,
                  backendMode === 'local' ? styles.backendChoiceSelected : null,
                  settings?.transcribeLocalAvailable !== true ? styles.backendChoiceDisabled : null,
                ]}
              >
                <Text style={styles.backendChoiceTitle}>Local</Text>
                <Text style={styles.reproHint}>
                  {settings?.transcribeLocalAvailable
                    ? 'Audio stays on your Verity host.'
                    : 'Not available in this deployment.'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: backendMode === 'external' }}
                accessibilityLabel="Use external transcription"
                onPress={() =>
                  void saveVeritySettings(client, { transcribeBackendMode: 'external' })
                }
                style={[
                  styles.backendChoice,
                  backendMode === 'external' ? styles.backendChoiceSelected : null,
                ]}
              >
                <Text style={styles.backendChoiceTitle}>External service</Text>
                <Text style={styles.reproHint}>Use an OpenAI-compatible speech API.</Text>
              </Pressable>
            </View>
            {backendMode === 'external' ? (
              <>
                <SettingsField
                  label="API base URL"
                  value={text.values.transcribeBaseUrl}
                  onChangeText={(value) => text.set('transcribeBaseUrl', value)}
                  onBlur={text.commit}
                  placeholder="https://api.example.com/v1/openai"
                  accessibilityLabel="Transcription API base URL"
                  keyboardType="url"
                />
                <SecretPasteField
                  label="API token"
                  placeholder="Paste the transcription token…"
                  value={secrets.values.transcribeApiKey}
                  onChangeText={(value) => secrets.set('transcribeApiKey', value)}
                  configured={settings?.transcribeApiKeyConfigured ?? false}
                  editable={writable}
                  onBlur={secrets.commit}
                  masked
                />
                <SettingsField
                  label="Model"
                  value={text.values.transcribeModel}
                  onChangeText={(value) => text.set('transcribeModel', value)}
                  onBlur={text.commit}
                  placeholder="openai/whisper-large-v3"
                  accessibilityLabel="Transcription model"
                />
                {!writable ? (
                  <Text style={styles.reproHint}>Unlock the secret store to change the token.</Text>
                ) : null}
              </>
            ) : null}
          </SettingsDisclosure>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Tools">
        <SettingsListPanel>
          <SettingsNavRow
            icon="link"
            title="MCP connections"
            subtitle="Remote HTTP MCP servers, enabled per project"
            onPress={() => router.push('/settings/services/mcp')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      {managed ? (
        <SettingsGroup title="Credentials">
          <SettingsDisclosure
            onCollapse={() => {
              text.commit();
              secrets.commit();
            }}
            title="Doppler"
            summary={settings?.dopplerServiceTokenConfigured ? 'Configured' : 'Optional'}
          >
            <Text style={styles.reproSubtitle}>
              Account token used by project-level Doppler bindings. Stored encrypted and never shown
              again.
            </Text>
            <SecretPasteField
              label="Service Account token (dp.sa.…)"
              placeholder="Paste the Doppler token…"
              value={secrets.values.dopplerServiceToken}
              onChangeText={(value) => secrets.set('dopplerServiceToken', value)}
              configured={settings?.dopplerServiceTokenConfigured ?? false}
              editable={writable}
              onBlur={secrets.commit}
            />
            {!writable ? (
              <Text style={styles.reproHint}>Unlock the secret store to change this.</Text>
            ) : null}
          </SettingsDisclosure>

          <SettingsDisclosure
            onCollapse={() => {
              text.commit();
              secrets.commit();
            }}
            title="Public Preview"
            summary={settings?.uplinkSubscriptionKeyConfigured ? 'Configured' : 'Optional'}
          >
            <Text style={styles.reproSubtitle}>
              Subscription key for paid public links through Verity Uplink. Stored encrypted and
              never shown again.
            </Text>
            <SecretPasteField
              label="Verity subscription key"
              placeholder="Paste subscription key…"
              value={secrets.values.uplinkSubscriptionKey}
              onChangeText={(value) => secrets.set('uplinkSubscriptionKey', value)}
              configured={settings?.uplinkSubscriptionKeyConfigured ?? false}
              editable={writable}
              onBlur={secrets.commit}
            />
            {!writable ? (
              <Text style={styles.reproHint}>Unlock the secret store to change this.</Text>
            ) : null}
          </SettingsDisclosure>
        </SettingsGroup>
      ) : null}

      <SettingsSaveState dirty={text.dirty || secrets.dirty} />
    </SettingsScaffold>
  );
}
