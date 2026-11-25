import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { Row, Text } from '../../components/ui';

export const ignore = () => undefined;

/** Sample values only; nothing in these mockups talks to a server. */
export const SAMPLE = {
  detailLeft: '42 min left',
  detailMinutes: '42 min',
  detailUntil: '15:42',
  version: '1.95.4',
  created: '25 Nov 2026, 14:58',
  uptime: '3 d 4 h',
} as const;

export function Fill({ children }: { children: ReactNode }) {
  return <View style={styles.root}>{children}</View>;
}

export function Actions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

export function Body({ children }: { children: ReactNode }) {
  return <View style={styles.body}>{children}</View>;
}

export const value = (text: string) => <Text variant="bodySmall">{text}</Text>;

/** The new section at the top of Settings › Diagnostics. */
export function ServerMonitoringGroup({ detailActive }: { detailActive: boolean }) {
  return (
    <SettingsGroup
      title="Server monitoring"
      description="Counts requests, traffic, resources, external calls and database load on this server. Nothing is sent anywhere unless you share a report."
    >
      <SettingsListPanel>
        <SettingsToggleRow
          label="Measure server load and traffic"
          subtitle="Counters in memory, under 20 MB and 1 % latency"
          value
          onValueChange={ignore}
        />
        <Row
          leading={{ icon: 'search' }}
          title="Detail mode"
          subtitle="More detail while troubleshooting"
          trailing={value(detailActive ? `On · ${SAMPLE.detailLeft}` : 'Off')}
          onPress={ignore}
          navigates
        />
        <SettingsNavRow
          icon="file-text"
          title="Create diagnostic report"
          subtitle="Preview, then copy, save or share"
          onPress={ignore}
        />
      </SettingsListPanel>
    </SettingsGroup>
  );
}

/** Settings › Diagnostics with the new section and the existing ones below it. */
export function DiagnosticsScreen({ detailActive }: { detailActive: boolean }) {
  return (
    <SettingsScaffold title="Diagnostics" detail state={{ error: undefined, saving: false }}>
      <ServerMonitoringGroup detailActive={detailActive} />
      <SettingsGroup title="Server recording">
        <SettingsListPanel>
          <Row title="Return path recording" trailing={value('Off')} onPress={ignore} navigates />
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup title="More">
        <SettingsListPanel>
          <Row title="Live transcription test" onPress={ignore} navigates />
          <Row title="Matrix import errors" subtitle="No import errors" />
          <SettingsToggleRow
            label="Record interaction diagnostics"
            subtitle="Gestures and app responsiveness without chat contents"
            value={false}
            onValueChange={ignore}
          />
          <Row title="Export app update logs" onPress={ignore} navigates />
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  body: { gap: theme.spacing.md, paddingBottom: theme.spacing.md },
}));
