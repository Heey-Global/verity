import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsScaffold } from '../../components/settings/SettingsChrome';
import {
  Button,
  Card,
  ConfirmSheet,
  Group,
  HintBox,
  IconButton,
  Row,
  SectionHeader,
  Sheet,
  StatusDot,
  StatusTag,
  Text,
  TextField,
  Toggle,
  ToggleRow,
} from '../../components/ui';

/**
 * Every design-system building block in every state, rendered with the live
 * theme (docs/design-system.md § 5). Reached from Diagnostics in advanced mode;
 * it is the visual reference for building and reviewing screens, on device and
 * on the web.
 */
export default function DesignSystemCatalog() {
  const [sharing, setSharing] = useState(true);
  const [remote, setRemote] = useState(false);
  const [key, setKey] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const simulateLoading = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1500);
  };
  return (
    <SettingsScaffold title="Design system" detail>
      <View style={styles.section}>
        <SectionHeader title="Type" />
        <Text variant="display">
          Your server,{' '}
          <Text variant="display" tone="signature">
            reachable anywhere.
          </Text>
        </Text>
        <Text variant="title">Title · Premium is active</Text>
        <Text variant="row">Row · Online sharing</Text>
        <Text variant="body">Body · Premium connects your server to Verity Uplink.</Text>
        <Text variant="subtitle">Subtitle · Preview links over the internet</Text>
        <Text variant="footnote">Footnote · App 1.65.1 · Server 4.35.0</Text>
        <Text variant="eyebrow">Eyebrow</Text>
        <Text variant="label">Label</Text>
        <Text variant="code">feat/checkout · a1b2c3d</Text>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Buttons" />
        <Button label="Activate" onPress={simulateLoading} loading={loading} fullWidth />
        <Button label="Cancel" variant="secondary" onPress={() => undefined} fullWidth />
        <Button label="Activate" onPress={() => undefined} disabled fullWidth />
        <View style={styles.inline}>
          <Button label="Copy" variant="secondary" size="compact" onPress={() => undefined} />
          <Button label="Start" size="compact" onPress={() => undefined} />
          <Button label="Replace" variant="text" size="compact" onPress={() => undefined} />
          <IconButton icon="plus" accessibilityLabel="Add" onPress={() => undefined} />
          <IconButton icon="more-horizontal" accessibilityLabel="More" onPress={() => undefined} />
        </View>
        {/* Destructive is only the confirming action; the trigger stays secondary. */}
        <Button
          label="Remove subscription key"
          variant="secondary"
          onPress={() => setConfirmOpen(true)}
          fullWidth
        />
      </View>

      <View style={styles.section}>
        <SectionHeader title="Grouped list" />
        <Group>
          <Row
            title="Server update"
            subtitle="4.36.0 available"
            leading={{ icon: 'download' }}
            trailing={<StatusTag intent="needsSetup" label="Update" />}
            onPress={() => undefined}
            navigates
          />
          <Row
            title="Verity Premium"
            leading={{ icon: 'zap' }}
            trailing={<StatusTag intent="ready" label="Active" />}
            onPress={() => undefined}
            navigates
          />
          <Row title="Tasks" leading={{ icon: 'check-square' }} trailing="On" />
          <Row title="Test remote access" subtitle="Disabled" onPress={() => undefined} disabled />
        </Group>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Cards" />
        <Card selected>
          <View style={styles.cardBody}>
            <Text variant="row">Subscription</Text>
            <Text variant="subtitle">Connected to Uplink</Text>
          </View>
          <StatusTag intent="ready" label="Active" />
        </Card>
        <Card>
          <ToggleRow
            title="Online sharing"
            subtitle="Preview links over the internet"
            value={sharing}
            onValueChange={setSharing}
          />
        </Card>
        <Card>
          <ToggleRow
            title="Remote access"
            subtitle={
              remote ? 'Reach your server from anywhere' : 'Off · not reachable from outside'
            }
            value={remote}
            onValueChange={setRemote}
          />
        </Card>
        <Card muted>
          <View style={styles.cardBody}>
            <Text variant="row">Teams</Text>
            <Text variant="subtitle">Shared projects and sessions</Text>
          </View>
          <StatusTag intent="optional" label="Soon" />
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Status" />
        <View style={styles.inline}>
          <StatusTag intent="ready" label="Active" />
          <StatusTag intent="needsSetup" label="Rejected" />
          <StatusTag intent="optional" label="Soon" />
          <StatusTag intent="transient" label="Connecting" />
        </View>
        <Group>
          <Row title="Uplink" trailing={<StatusDot intent="ready" label="Connected" />} />
          <Row title="Online sharing" trailing={<StatusDot intent="ready" label="On" />} />
          <Row
            title="Remote access"
            subtitle="Switched off in Verity Premium"
            trailing={<StatusDot intent="optional" label="Off" />}
          />
        </Group>
        <View style={styles.inline}>
          <Toggle value />
          <Toggle value={false} />
          <Toggle value disabled />
          <Toggle value switching />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Fields" />
        <TextField
          label="Server address"
          value=""
          onChangeText={() => undefined}
          placeholder="https://"
        />
        <TextField
          label="Uplink subscription key"
          value={key}
          onChangeText={setKey}
          placeholder="Paste your subscription key"
          secret
          error={
            key.length > 0 && key.length < 8
              ? { title: 'Key not recognized', message: 'This key is not known to Verity Uplink.' }
              : undefined
          }
        />
        <TextField label="Notes" value={notes} onChangeText={setNotes} multiline />
        <TextField
          label="Server address"
          value="https://verity.example"
          onChangeText={() => undefined}
          disabled
        />
        <HintBox title="Key not recognized" message="Check it in your account." />
      </View>

      <View style={styles.section}>
        <SectionHeader title="Sheets" />
        <Button
          label="Open sheet"
          variant="secondary"
          onPress={() => setSheetOpen(true)}
          fullWidth
        />
      </View>

      <Sheet
        visible={sheetOpen}
        title="Start dev server"
        onClose={() => setSheetOpen(false)}
        footer={<Button label="Start" onPress={() => setSheetOpen(false)} fullWidth />}
      >
        <TextField label="Command" value="npm run dev" onChangeText={() => undefined} />
      </Sheet>
      <ConfirmSheet
        visible={confirmOpen}
        title="Remove subscription key?"
        message="Online sharing and remote access will stop."
        confirmLabel="Remove key"
        destructive
        onConfirm={() =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              setConfirmOpen(false);
              resolve();
            }, 1200),
          )
        }
        onCancel={() => setConfirmOpen(false)}
      />
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing.sm },
  inline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing.sm },
  cardBody: { flex: 1, gap: theme.spacing.xxs },
}));
