import {
  DETAIL_MODE_MINUTES,
  type DetailModeMinutes,
  type MonitoringState,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  detailModeLabel,
  detailStarterName,
  formatDuration,
} from '../../lib/diagnosticReportSummary';
import { Button, Group, Row, Sheet, Text } from '../ui';
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsToggleRow,
} from './SettingsChrome';

const DURATION_LABELS: Record<DetailModeMinutes, string> = {
  15: '15 minutes',
  60: '1 hour',
  240: '4 hours',
};

/**
 * Settings › Diagnostics › Server monitoring (ADR 0032): the measurement
 * switch, timed detail mode and the way to the diagnostic report. A server
 * without monitoring, or a person who is not an administrator, sees nothing.
 */
export function ServerMonitoring({ client }: { client: VerityClient }) {
  const [state, setState] = useState<MonitoringState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [minutes, setMinutes] = useState<DetailModeMinutes>(60);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void client.monitoring
        .state()
        .then((next) => {
          if (active) {
            setState(next);
            setUnavailable(false);
          }
        })
        .catch(() => {
          if (active) setUnavailable(true);
        });
      return () => {
        active = false;
      };
    }, [client]),
  );

  const change = async (action: () => Promise<MonitoringState>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setState(await action());
      return true;
    } catch {
      setError('The server did not accept the change. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (unavailable || state === null) return null;
  const detail = state.detailMode;
  return (
    <SettingsGroup
      title="Server monitoring"
      description="Counts requests, traffic and resources on this server. Nothing is sent anywhere unless you share a report."
    >
      <SettingsListPanel>
        <SettingsToggleRow
          label="Measure server load and traffic"
          subtitle="Counters in memory, under 20 MB and 1 % latency"
          value={state.measurementEnabled}
          disabled={busy}
          onValueChange={(enabled) =>
            void change(() => client.monitoring.setMeasurementEnabled(enabled))
          }
        />
        <Row
          leading={{ icon: 'search' }}
          title="Detail mode"
          subtitle="More detail while troubleshooting"
          trailing={<Text variant="bodySmall">{detailModeLabel(state)}</Text>}
          disabled={!state.measurementEnabled}
          onPress={() => setSheet(true)}
          navigates
        />
        <SettingsNavRow
          icon="file-text"
          title="Create diagnostic report"
          subtitle="Preview, then copy, save or share"
          onPress={() => router.push('/settings/diagnostic-report')}
        />
      </SettingsListPanel>
      {error !== null ? (
        <Text variant="footnote" tone="attention">
          {error}
        </Text>
      ) : null}
      <Sheet
        visible={sheet}
        title="Detail mode"
        onClose={() => setSheet(false)}
        footer={
          detail.active ? (
            <Button
              label="Stop detail mode"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void change(() => client.monitoring.stopDetailMode()).then(
                  (done) => done && setSheet(false),
                )
              }
              fullWidth
            />
          ) : (
            <Button
              label={`Start for ${DURATION_LABELS[minutes]}`}
              disabled={busy}
              onPress={() =>
                void change(() => client.monitoring.startDetailMode(minutes)).then(
                  (done) => done && setSheet(false),
                )
              }
              fullWidth
            />
          )
        }
      >
        <View style={styles.body}>
          {detail.active ? (
            <>
              <Group>
                <Row
                  title="Running until"
                  trailing={
                    <Text variant="bodySmall">
                      {detail.until === null
                        ? ''
                        : new Date(detail.until).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                    </Text>
                  }
                />
                <Row
                  title="Time left"
                  trailing={
                    <Text variant="bodySmall">{formatDuration(detail.remainingSeconds)}</Text>
                  }
                />
                <Row
                  title="Started by"
                  trailing={<Text variant="bodySmall">{detailStarterName(detail.startedBy)}</Text>}
                />
              </Group>
              <Text variant="bodySmall" tone="muted">
                The next diagnostic report includes the detailed breakdown from this period.
              </Text>
            </>
          ) : (
            <>
              <Text variant="bodySmall" tone="muted">
                Records more per request while you look for a problem. It turns itself off when the
                time is up.
              </Text>
              <Group>
                {DETAIL_MODE_MINUTES.map((option) => (
                  <SettingsChoiceRow
                    key={option}
                    title={DURATION_LABELS[option]}
                    selected={option === minutes}
                    onPress={() => setMinutes(option)}
                  />
                ))}
              </Group>
              <Text variant="subtitle">Recorded additionally</Text>
              <Text variant="bodySmall">
                The slowest requests with their timing, route and size.
              </Text>
              <Text variant="subtitle">Never recorded</Text>
              <Text variant="bodySmall" tone="muted">
                Messages, transcripts, file contents, secrets and query values.
              </Text>
              <Text variant="footnote">Adds a few percent of server load while it runs.</Text>
            </>
          )}
        </View>
      </Sheet>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing.md, paddingBottom: theme.spacing.md },
}));
