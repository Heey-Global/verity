import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsGroup, SettingsScaffold } from '../../components/settings/SettingsChrome';
import { Button, Card, Group, Row, Text } from '../../components/ui';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { Actions, Fill, SAMPLE, ignore } from './parts';

const AREAS: readonly { title: string; summary: string }[] = [
  { title: 'Availability', summary: '0.4 % errors · p95 180 ms · 1 restart' },
  { title: 'Traffic', summary: '6.2 GB sent · top: session overview on iPhone, 3.1 GB' },
  { title: 'Resources', summary: 'Server 1.1 of 2 GB RAM · disk 64 % · no out-of-memory' },
  { title: 'External calls', summary: 'GitHub 18,420 · 3 % duplicates · 4,812 of 5,000 left' },
  { title: 'Database', summary: '12 queries per request (p95) · pool 3 of 10 · 2 slow patterns' },
  { title: 'Sessions & sandboxes', summary: '6 running · 2 orphaned worktrees · 1 stale lock' },
  { title: 'Errors', summary: '5 groups · 1 new since 1.95.4' },
  { title: 'Cost', summary: 'Claude 4.1 M tokens · Codex 0.6 M tokens' },
];

const TECHNICAL = `{
  "format": "verity.diagnostic-report/1",
  "server": { "version": "1.95.4", "uptimeSeconds": 274800 },
  "traffic": [{ "route": "/sessions/overview", "client": "ios", "bytesOut": 3328599654 }],
  "sessions": [{ "id": "sha256:4f1c9a2e", "bytesOut": 812004113 }]
}`;

/**
 * The report before it leaves the device: what period it covers, one line per
 * area, what is left out, and the three ways to pass it on.
 */
export default function ReportMockup() {
  return (
    <Fill>
      <SettingsScaffold
        title="Diagnostic report"
        detail
        state={{ error: undefined, saving: false }}
        footer={
          <View style={styles.footer}>
            <Actions>
              <Button
                label="Copy"
                variant="secondary"
                size="compact"
                icon="copy"
                onPress={ignore}
              />
              <Button
                label="Save file"
                variant="secondary"
                size="compact"
                icon="download"
                onPress={ignore}
              />
            </Actions>
            <Button label="Share" icon="share" onPress={ignore} fullWidth />
          </View>
        }
      >
        <SettingsGroup title="Report">
          <Group>
            <Row
              title="Server version"
              trailing={<Text variant="bodySmall">{SAMPLE.version}</Text>}
            />
            <Row
              title="Covers"
              trailing={<Text variant="bodySmall">Since start, {SAMPLE.uptime}</Text>}
            />
            <Row title="Created" trailing={<Text variant="bodySmall">{SAMPLE.created}</Text>} />
          </Group>
        </SettingsGroup>
        <SettingsGroup title="Summary">
          <Group>
            {AREAS.map((area) => (
              <Row key={area.title} title={area.title} subtitle={area.summary} />
            ))}
          </Group>
        </SettingsGroup>
        <Card>
          <View style={styles.note}>
            <Text variant="subtitle">Not included</Text>
            <Text variant="bodySmall" tone="muted">
              Messages, transcripts, file contents, secrets, tokens and full addresses. Project and
              session names are replaced by short codes.
            </Text>
          </View>
        </Card>
        <SettingsGroup title="Technical content">
          <CodeBlock text={TECHNICAL} />
        </SettingsGroup>
      </SettingsScaffold>
    </Fill>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: { gap: theme.spacing.sm },
  note: { gap: theme.spacing.xs },
}));
