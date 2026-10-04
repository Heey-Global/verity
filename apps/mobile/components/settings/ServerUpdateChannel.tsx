import type { VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';
import { SettingsChoiceRow, SettingsGroup, SettingsListPanel } from './SettingsChrome';
import { settingsStyles as styles } from './settingsStyles';

type Channel = 'stable' | 'staging';

/** Channel preferences belong to the paired Server, independently of this app's OTA channel. */
export function ServerUpdateChannel({
  client,
  disabled,
  onChanged,
  onSavingChange,
  onChanging,
}: {
  client: VerityClient;
  disabled: boolean;
  onChanged: () => Promise<unknown>;
  onSavingChange: (value: boolean) => void;
  onChanging: () => void;
}) {
  const [channel, setChannel] = useState<Channel>();
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
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

  useEffect(() => {
    if (!reconciling) return;
    let active = true;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void client
        .getServerUpdateChannel()
        .then(async (current) => {
          if (!active) return;
          setChannel(current);
          setError(undefined);
          await onChanged();
          if (!active) return;
          setReconciling(false);
          setSaving(false);
          onSavingChange(false);
        })
        .catch(() => undefined)
        .finally(() => {
          reading = false;
        });
    }, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, onChanged, onSavingChange, reconciling]);

  const save = (next: Channel) => {
    let unknown = false;
    onChanging();
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
        if (current === undefined) {
          unknown = true;
          setReconciling(true);
          setError('The channel change is unconfirmed. Checking the server…');
          return;
        }
        await onChanged();
        if (current !== next) setError('The channel was not changed. Try again.');
      })
      .finally(() => {
        if (!unknown) {
          setSaving(false);
          onSavingChange(false);
        }
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
    <SettingsGroup
      title="Update channel"
      description="Choose which releases this server is offered. Updates are always installed manually."
    >
      <SettingsListPanel>
        {(['stable', 'staging'] as const).map((value) => (
          <SettingsChoiceRow
            key={value}
            title={value === 'stable' ? 'Stable' : 'Prereleases'}
            subtitle={
              value === 'stable'
                ? 'Approved releases for regular use.'
                : 'Early versions before general release. May contain bugs.'
            }
            selected={channel === value}
            disabled={disabled || saving}
            onPress={() => select(value)}
          />
        ))}
      </SettingsListPanel>
      {saving ? <Text style={styles.groupDescription}>Changing channel…</Text> : null}
      {error ? <Text style={styles.reproHint}>{error}</Text> : null}
    </SettingsGroup>
  );
}
