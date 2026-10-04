import type { VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { settingsStyles as styles } from './settingsStyles';

type Channel = 'stable' | 'staging';

/** Channel preferences belong to the paired Server, independently of this app's OTA channel. */
export function ServerUpdateChannel({
  client,
  disabled,
  onChanged,
  onSavingChange,
}: {
  client: VerityClient;
  disabled: boolean;
  onChanged: () => Promise<unknown>;
  onSavingChange: (value: boolean) => void;
}) {
  const [channel, setChannel] = useState<Channel>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void client
        .getServerUpdateChannel()
        .then((value) => {
          if (active) setChannel(value);
        })
        .catch(() => {
          if (active) setChannel(undefined);
        });
      return () => {
        active = false;
      };
    }, [client]),
  );

  const save = (next: Channel) => {
    setSaving(true);
    onSavingChange(true);
    setError(undefined);
    void client
      .setServerUpdateChannel(next)
      .then(async (value) => {
        setChannel(value);
        await onChanged();
      })
      .catch(async () => {
        // A lost response can follow a successful durable write. Re-read before offering another change.
        const current = await client.getServerUpdateChannel().catch(() => undefined);
        if (current !== undefined) setChannel(current);
        if (current === next) {
          await onChanged();
          return;
        }
        setError('Could not confirm the update channel. Try again.');
      })
      .finally(() => {
        setSaving(false);
        onSavingChange(false);
      });
  };
  const select = (next: Channel) => {
    if (next === channel || disabled || saving) return;
    Alert.alert(
      next === 'staging' ? 'Use prereleases?' : 'Use stable releases?',
      next === 'staging'
        ? 'This server will receive versions that are still being tested and may contain bugs. Updates are installed manually. Returning to Stable does not install an older version.'
        : 'This server will receive approved releases. If your current version is newer, it will wait for a newer stable release. No downgrade will be installed.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Change channel', onPress: () => save(next) },
      ],
    );
  };
  if (channel === undefined) return null;
  return (
    <View>
      <Text style={styles.updateTitle}>Server update channel</Text>
      <Text style={styles.updateDetail}>
        Choose which releases this server receives. Updates are installed manually.
      </Text>
      {(['stable', 'staging'] as const).map((value) => (
        <Pressable
          key={value}
          accessibilityRole="radio"
          accessibilityState={{ checked: channel === value, disabled: disabled || saving }}
          disabled={disabled || saving}
          onPress={() => select(value)}
          style={styles.updateButton}
        >
          <Text style={styles.updateTitle}>
            {value === 'stable' ? 'Stable' : 'Prereleases'}
            {channel === value ? ' ✓' : ''}
          </Text>
          <Text style={styles.updateDetail}>
            {value === 'stable'
              ? 'Approved releases for regular use.'
              : 'New versions before general release. May contain bugs.'}
          </Text>
        </Pressable>
      ))}
      {saving ? <Text style={styles.updateDetail}>Changing channel…</Text> : null}
      {error ? <Text style={styles.reproHint}>{error}</Text> : null}
    </View>
  );
}
