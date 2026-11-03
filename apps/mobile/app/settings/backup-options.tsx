// Backup options: how often, pause, and a new recovery key. Each change is saved
// as soon as it is made; there is no Save button anywhere in Settings.
import { type VerityClient } from '@verity/mobile';
import { router, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  DEFAULT_INTERVAL_MS,
  INTERVAL_CHOICES,
  formatInterval,
} from '../../components/settings/backup/backupText';
import { useBackupStatus } from '../../components/settings/backup/useBackupStatus';
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsMessage,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { Button, Card, Group, Row, Sheet, Text, ToggleRow } from '../../components/ui';
import { createVerityClient } from '../../lib/client';

export default function BackupOptionsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage backups."
        screenTitle="Options"
      />
    );
  return <BackupOptionsView client={client} />;
}

function BackupOptionsView({ client }: { client: VerityClient }) {
  const { state, reload } = useBackupStatus(client);
  const [sheet, setSheet] = useState<'interval' | 'key' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const status = state.kind === 'ready' && state.status.available ? state.status : undefined;
  const interval = status?.intervalMs ?? DEFAULT_INTERVAL_MS;

  const save = (policy: { paused?: boolean; intervalMs?: number }): void => {
    setSaving(true);
    setError(undefined);
    void client
      .setBackupPolicy(policy)
      .then(reload)
      .catch(() => setError('Could not save the change. Try again.'))
      .finally(() => setSaving(false));
  };

  return (
    <SettingsScaffold
      title="Options"
      detail
      state={{ error: error ?? (state.kind === 'error' ? state.message : undefined), saving }}
      onRetry={() => void reload()}
    >
      <SettingsGroup title="Schedule">
        <Group>
          <Row
            leading={{ icon: 'clock' }}
            title="How often"
            trailing={formatInterval(interval)}
            navigates
            disabled={status === undefined || saving}
            onPress={() => setSheet('interval')}
          />
          <ToggleRow
            leading={{ icon: 'pause' }}
            title="Pause backups"
            subtitle="Existing backups are kept"
            value={status?.paused === true}
            disabled={status === undefined || saving}
            onValueChange={(paused) => save({ paused })}
          />
        </Group>
      </SettingsGroup>
      <SettingsGroup title="Recovery key">
        <Group>
          <Row
            leading={{ icon: 'key', signature: true }}
            title="Create new recovery key"
            subtitle="If you lost your current one"
            navigates
            disabled={status === undefined}
            onPress={() => setSheet('key')}
          />
        </Group>
      </SettingsGroup>

      <Sheet visible={sheet === 'interval'} title="How often" onClose={() => setSheet(null)}>
        <Group>
          {INTERVAL_CHOICES.map((choice) => (
            <SettingsChoiceRow
              key={choice}
              title={formatInterval(choice, 'long').replace(/^./, (c) => c.toUpperCase())}
              subtitle={choice === DEFAULT_INTERVAL_MS ? 'Recommended' : undefined}
              selected={choice === interval}
              onPress={() => {
                setSheet(null);
                if (choice !== interval) save({ intervalMs: choice });
              }}
            />
          ))}
        </Group>
      </Sheet>

      <Sheet
        visible={sheet === 'key'}
        title="Create new recovery key"
        onClose={() => setSheet(null)}
        footer={
          <Button
            label="Create new key"
            fullWidth
            onPress={() => {
              setSheet(null);
              router.push('/settings/backup-new-key' as Href);
            }}
          />
        }
      >
        <View style={styles.stack}>
          <Card flush>
            <Row
              leading={{ icon: 'hard-drive' }}
              title="Older backups are kept"
              subtitle="They still require your old key. Replacing the key does not delete them; normal retention rules still apply."
            />
          </Card>
          <Card flush>
            <Row
              leading={{ icon: 'lock', signature: true }}
              title="New backups use the new key"
              subtitle="Your old key cannot open any backup made from now on."
            />
          </Card>
          <Text variant="footnote" tone="faint">
            Someone else saw your key? Also have the server identity rotated with the Verity
            installer.
          </Text>
        </View>
      </Sheet>
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing.sm },
}));
