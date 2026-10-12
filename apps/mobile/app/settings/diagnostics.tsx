import { type IntegrationSource, type VerityClient } from '@verity/mobile';
import * as Application from 'expo-application';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CardRow, Eyebrow, RowCard, Tag } from '../../components/premium/PremiumChrome';
import { MatrixImportErrors } from '../../components/settings/MatrixImportErrors';
import { PublicPreviewDiagnostics } from '../../components/settings/PublicPreviewDiagnostics';
import { ReturnPathDiagnostics } from '../../components/settings/ReturnPathDiagnostics';
import { SettingsGroup, SettingsScaffold } from '../../components/settings/SettingsChrome';
import { runningReleaseVersion } from '../../lib/buildInfo';
import { createVerityClient } from '../../lib/client';
import {
  setGestureDiagnosticsEnabled,
  useGestureDiagnosticsEnabled,
} from '../../lib/gestureDiagnostics';
import { useLoadVeritySettings, useVeritySettings } from '../../lib/settingsStore';
import { shareRemoteControlCiInputs } from '../../lib/remoteControlCiExport';
import { shareUpdateDiagnostics } from '../../lib/updateDiagnostics';

export default function DiagnosticsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <DiagnosticsSettings client={client} />
  ) : (
    <SettingsScaffold title="Diagnostics" detail>
      <PublicPreviewDiagnostics client={null} keyConfigured={undefined} />
    </SettingsScaffold>
  );
}
export function DiagnosticsSettings({ client }: { client: VerityClient }) {
  useLoadVeritySettings(client);
  const { settings } = useVeritySettings();
  const [sources, setSources] = useState<IntegrationSource[] | null>(null);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showImportErrors, setShowImportErrors] = useState(false);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const recordingGestures = useGestureDiagnosticsEnabled();
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
  const exportRemoteInputs = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await shareRemoteControlCiInputs();
    } catch {
      Alert.alert(
        'Export unavailable',
        'Select a paired server with Remote Control enabled and a TLS pin before exporting.',
      );
    } finally {
      setExporting(false);
    }
  };
  const errorCount = sources?.reduce((total, source) => total + source.importDiagnostics.length, 0);
  return (
    <SettingsScaffold title="Diagnostics" detail>
      <PublicPreviewDiagnostics
        client={client}
        keyConfigured={settings?.uplinkSubscriptionKeyConfigured}
      >
        <View style={local.section}>
          <Eyebrow>Server recording</Eyebrow>
          <ReturnPathDiagnostics client={client} />
        </View>
        <View style={local.section}>
          <Eyebrow>More</Eyebrow>
          <RowCard>
            <CardRow
              title="Live transcription test"
              onPress={() => router.push('/settings/live-meeting-stt')}
            />
            <CardRow
              title="Matrix import errors"
              subtitle={
                error
                  ? 'Could not load import errors. Reopen Diagnostics to retry.'
                  : sources === null
                    ? 'Loading…'
                    : sources.length === 0
                      ? 'No import errors'
                      : `${sources.length} ${sources.length === 1 ? 'source' : 'sources'} · ${
                          showImportErrors ? 'hide details' : 'show details'
                        }`
              }
              trailing={
                errorCount !== undefined && errorCount > 0 ? (
                  <Tag label={String(errorCount)} tone="error" />
                ) : null
              }
              chevron={sources !== null && sources.length > 0}
              {...(sources !== null && sources.length > 0
                ? { onPress: () => setShowImportErrors((shown) => !shown) }
                : {})}
            />
            <CardRow
              title="Record overview gestures"
              subtitle="Until the app restarts. Logs how session rows react to swipes and holds for the export below."
              switchValue={recordingGestures}
              onPress={() => setGestureDiagnosticsEnabled(!recordingGestures)}
            />
            <CardRow
              title="Export app update logs"
              subtitle={
                exporting
                  ? 'Preparing…'
                  : `App ${runningReleaseVersion(Application.nativeApplicationVersion)}${serverVersion ? ` · Server ${serverVersion}` : ''}`
              }
              disabled={exporting}
              onPress={() => void exportLogs()}
            />
            <CardRow
              title="Export Remote Control test inputs"
              subtitle="Addresses, routing handle and TLS pin. No tokens or tickets."
              disabled={exporting}
              onPress={() => void exportRemoteInputs()}
            />
            {settings?.advancedModeEnabled === true ? (
              <CardRow
                title="Design system"
                subtitle="Every building block in every state"
                onPress={() => router.push('/settings/design-system')}
              />
            ) : null}
          </RowCard>
        </View>
        {showImportErrors && sources !== null && sources.length > 0
          ? sources.map((source) => (
              <SettingsGroup
                key={`${source.accountId}:${source.sourceId}`}
                title={source.displayName}
              >
                <MatrixImportErrors source={source} />
              </SettingsGroup>
            ))
          : null}
      </PublicPreviewDiagnostics>
    </SettingsScaffold>
  );
}

const local = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing.sm },
}));
