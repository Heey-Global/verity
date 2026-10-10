import { type IntegrationSource, type VerityClient } from '@verity/mobile';
import * as Application from 'expo-application';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Text } from 'react-native';
import { MatrixImportErrors } from '../../components/settings/MatrixImportErrors';
import { PublicPreviewDiagnostics } from '../../components/settings/PublicPreviewDiagnostics';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsPanel,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../components/settings/settingsStyles';
import { runningReleaseVersion } from '../../lib/buildInfo';
import { createVerityClient } from '../../lib/client';
import { useLoadVeritySettings, useVeritySettings } from '../../lib/settingsStore';
import { shareUpdateDiagnostics } from '../../lib/updateDiagnostics';

export default function DiagnosticsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <DiagnosticsSettings client={client} />
  ) : (
    <SettingsMessage title="Not connected" />
  );
}
export function DiagnosticsSettings({ client }: { client: VerityClient }) {
  useLoadVeritySettings(client);
  const { settings } = useVeritySettings();
  const [sources, setSources] = useState<IntegrationSource[] | null>(null);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void client
        .getHealth()
        .then((health) => {
          if (active) setServerVersion(health.version ?? null);
        })
        .catch(() => {
          if (active) setServerVersion(null);
        });
      void client
        .listIntegrations()
        .then((result) => {
          if (active) {
            setSources(
              result.sources.filter(
                (source) =>
                  source.importDiagnostics.length > 0 || source.importDiagnosticsTruncated,
              ),
            );
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
      return () => {
        active = false;
      };
    }, [client]),
  );
  const exportLogs = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await shareUpdateDiagnostics();
    } catch {
      Alert.alert('Export failed', 'Could not export update diagnostics. Try again later.');
    } finally {
      setExporting(false);
    }
  };
  return (
    <SettingsScaffold title="Diagnostics" detail>
      <SettingsGroup title="Connection">
        <PublicPreviewDiagnostics
          client={client}
          keyConfigured={settings?.uplinkSubscriptionKeyConfigured}
        />
      </SettingsGroup>
      <SettingsGroup title="Transcription">
        <SettingsListPanel>
          <SettingsNavRow
            icon="mic"
            title="Live transcription test"
            onPress={() => router.push('/settings/live-meeting-stt')}
          />
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup title="Integrations">
        <SettingsPanel>
          <Text style={styles.disclosureTitle}>Matrix import errors</Text>
          {error ? (
            <Text style={styles.fieldError}>
              Could not load import errors. Reopen Diagnostics to retry.
            </Text>
          ) : sources === null ? (
            <Text style={styles.reproSubtitle}>Loading…</Text>
          ) : sources.length === 0 ? (
            <Text style={styles.reproSubtitle}>No import errors</Text>
          ) : (
            sources.map((source) => (
              <SettingsGroup
                key={`${source.accountId}:${source.sourceId}`}
                title={source.displayName}
              >
                <MatrixImportErrors source={source} />
              </SettingsGroup>
            ))
          )}
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup title="App">
        <SettingsListPanel>
          <SettingsNavRow
            icon="file-text"
            title="Export app update logs"
            subtitle={
              exporting
                ? 'Preparing…'
                : `App ${runningReleaseVersion(Application.nativeApplicationVersion)}${serverVersion ? ` · Server ${serverVersion}` : ''}`
            }
            disabled={exporting}
            onPress={() => void exportLogs()}
          />
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
