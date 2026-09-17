import { type VerityClient } from '@verity/mobile';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  SecretPasteField,
  SettingsField,
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsSaveState,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../../components/settings/settingsStyles';
import { createVerityClient } from '../../../lib/client';
import {
  retryFailedVeritySettings,
  saveVeritySettings,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../../lib/settingsStore';
import { useSecretFields } from '../../../lib/useSecretFields';
import { useSettingsFields } from '../../../lib/useSettingsFields';

const TEXT_FIELDS = ['opencodeBaseUrl'] as const;
const SECRET_FIELDS = ['opencodeApiKey'] as const;

function modelIds(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]/u)
    .map((model) => model.trim())
    .filter((model, index, all) => model.length > 0 && all.indexOf(model) === index);
}

export default function OpenCodeSettingsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to edit OpenCode."
        screenTitle="OpenCode"
      />
    );
  }
  return <OpenCodeSettingsView client={client} />;
}

function OpenCodeSettingsView({ client }: { client: VerityClient }) {
  const reload = useLoadVeritySettings(client);
  const { settings, secretStatus } = useVeritySettings();
  const text = useSettingsFields(client, TEXT_FIELDS);
  const secrets = useSecretFields(client, SECRET_FIELDS);
  const models = modelIds(settings?.opencodeModels);
  const [disabled, setDisabled] = useState(() => new Set<string>());
  const writable = secretStatus === 'unlocked' || secretStatus === 'unmanaged';
  const disabledModelCount = models.filter((model) => disabled.has(model)).length;
  const allModelsEnabled = disabledModelCount === 0;

  useEffect(() => {
    setDisabled(new Set(modelIds(settings?.opencodeDisabledModels)));
  }, [settings?.opencodeDisabledModels]);

  const saveDisabled = (next: Set<string>) => {
    setDisabled(next);
    void saveVeritySettings(client, {
      opencodeDisabledModels: models.filter((model) => next.has(model)).join('\n'),
    });
  };

  return (
    <SettingsScaffold
      title="OpenCode"
      detail
      onRetry={() => {
        const dirty = text.dirty || secrets.dirty;
        if (text.dirty) text.commit();
        if (secrets.dirty) secrets.commit();
        if (!dirty) {
          void retryFailedVeritySettings(client).then((retried) => {
            if (!retried) reload();
          });
        }
      }}
    >
      <SettingsGroup title="Connection" description="OpenAI-compatible API used by OpenCode.">
        <SettingsPanel>
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
        </SettingsPanel>
      </SettingsGroup>

      <SettingsGroup
        title="Models"
        description="Choose which discovered models appear in sessions. Newly discovered models are enabled automatically."
      >
        {models.length === 0 ? (
          <SettingsPanel>
            <Text style={styles.reproHint}>
              Save a working connection to load the provider's models.
            </Text>
          </SettingsPanel>
        ) : (
          <SettingsPanel>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.reproSubtitle}>
                {String(models.length - disabledModelCount)} of {String(models.length)} enabled
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={allModelsEnabled ? 'Disable all models' : 'Enable all models'}
                onPress={() => saveDisabled(allModelsEnabled ? new Set(models) : new Set())}
              >
                <Text style={styles.linkText}>
                  {allModelsEnabled ? 'Disable all' : 'Enable all'}
                </Text>
              </Pressable>
            </View>
            {models.map((model) => (
              <SettingsToggleRow
                key={model}
                label={model}
                value={!disabled.has(model)}
                onValueChange={(enabled) => {
                  const next = new Set(disabled);
                  if (enabled) next.delete(model);
                  else next.add(model);
                  saveDisabled(next);
                }}
              />
            ))}
          </SettingsPanel>
        )}
      </SettingsGroup>

      <SettingsSaveState dirty={text.dirty || secrets.dirty} />
    </SettingsScaffold>
  );
}
