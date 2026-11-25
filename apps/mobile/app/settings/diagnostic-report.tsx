import type { DiagnosticReport, VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Share, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsGroup, SettingsScaffold } from '../../components/settings/SettingsChrome';
import { Button, Card, Group, Row, Text } from '../../components/ui';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { createVerityClient } from '../../lib/client';
import { formatDuration, summarizeReport } from '../../lib/diagnosticReportSummary';
import { loadSharingModule } from '../../lib/sessionFileUi';

const FILE_NAME = 'verity-diagnostic-report.json';

/**
 * Settings › Diagnostics › Diagnostic report (ADR 0032): the report as the
 * server built it, previewed before it leaves the device. Sharing is the only
 * way it reaches anyone; the server never sends it on its own.
 */
export default function DiagnosticReportScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <DiagnosticReportView client={client} />
  ) : (
    <SettingsScaffold title="Diagnostic report" detail>
      <Text variant="bodySmall" tone="muted">
        Connect to a server to create a report.
      </Text>
    </SettingsScaffold>
  );
}

export function DiagnosticReportView({ client }: { client: VerityClient }) {
  const [loaded, setLoaded] = useState<{ report: DiagnosticReport; text: string } | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    setError(undefined);
    client.monitoring
      .report()
      .then(setLoaded)
      .catch(() => setError('Could not create the report. Only administrators can create one.'));
  }, [client]);
  useEffect(load, [load]);

  const copy = () =>
    loaded &&
    Clipboard.setStringAsync(loaded.text).catch(() =>
      Alert.alert('Copy failed', 'The clipboard is not available.'),
    );
  const save = async () => {
    if (loaded === null) return;
    const sharing = await loadSharingModule();
    if (sharing === undefined || !(await sharing.isAvailableAsync())) {
      Alert.alert('Saving is not available', 'Copy the report instead.');
      return;
    }
    try {
      const file = new File(Paths.cache, FILE_NAME);
      if (file.exists) file.delete();
      file.write(loaded.text);
      await sharing.shareAsync(file.uri, {
        mimeType: 'application/json',
        dialogTitle: 'Save diagnostic report',
      });
    } catch (cause) {
      Alert.alert('Could not save the report', cause instanceof Error ? cause.message : '');
    }
  };
  const share = () =>
    loaded &&
    Share.share({ message: loaded.text }).catch(() =>
      Alert.alert('Share failed', 'Copy the report instead.'),
    );

  const report = loaded?.report;
  return (
    <SettingsScaffold
      title="Diagnostic report"
      detail
      onRetry={load}
      state={{ error, saving: false }}
      footer={
        loaded === null ? undefined : (
          <View style={styles.footer}>
            <View style={styles.actions}>
              <Button
                label="Copy"
                variant="secondary"
                size="compact"
                icon="copy"
                onPress={() => void copy()}
              />
              <Button
                label="Save file"
                variant="secondary"
                size="compact"
                icon="download"
                onPress={() => void save()}
              />
            </View>
            <Button label="Share" icon="share" onPress={() => void share()} fullWidth />
          </View>
        )
      }
    >
      {report === undefined ? (
        error === undefined ? (
          <Text variant="bodySmall" tone="muted">
            Creating report…
          </Text>
        ) : null
      ) : (
        <>
          <SettingsGroup title="Report">
            <Group>
              <Row
                title="Server version"
                trailing={<Text variant="bodySmall">{report.server.version}</Text>}
              />
              <Row
                title="Covers"
                trailing={
                  <Text variant="bodySmall">
                    {report.monitoring.measurementEnabled
                      ? `Last ${formatDuration(report.monitoring.coveredSeconds)}`
                      : 'Measurement is off'}
                  </Text>
                }
              />
              <Row
                title="Created"
                trailing={
                  <Text variant="bodySmall">{new Date(report.generatedAt).toLocaleString()}</Text>
                }
              />
            </Group>
          </SettingsGroup>
          <SettingsGroup title="Summary">
            <Group>
              {summarizeReport(report).map((area) => (
                <Row key={area.title} title={area.title} subtitle={area.summary} />
              ))}
            </Group>
          </SettingsGroup>
          <Card>
            <View style={styles.note}>
              <Text variant="subtitle">Not included</Text>
              <Text variant="bodySmall" tone="muted">
                Messages, transcripts, file contents, secrets, tokens and full addresses. Project
                and session names are replaced by short codes.
              </Text>
            </View>
          </Card>
          <SettingsGroup title="Technical content">
            <CodeBlock text={loaded!.text} />
          </SettingsGroup>
        </>
      )}
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: { gap: theme.spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  note: { gap: theme.spacing.xs },
}));
