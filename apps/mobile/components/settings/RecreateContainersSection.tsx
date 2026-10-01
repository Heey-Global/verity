// The standing way to recreate running containers. The banner after a save only
// knows about changes this app made since it started; one saved before a
// restart, or from another device, would otherwise have no way to land short of
// recreating each project by hand.
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { setApplyRun, useVeritySettings, veritySettingsSnapshot } from '../../lib/settingsStore';
import { RECREATE_LABEL } from './RecreatePendingBanner';
import { recreateRunMessage, startRecreateRun } from './recreateContainers';
import { SettingsPanel } from './SettingsChrome';
import { settingsStyles as styles } from './settingsStyles';

export function RecreateContainersSection() {
  const { theme } = useUnistyles();
  const { applyPending, applyRun: run, saving } = useVeritySettings();
  // A success read here is done with once the operator leaves; kept, it would
  // turn up as a banner on whichever screen comes next. A failure keeps its
  // Retry there, and a run still going is reported there when it ends.
  useEffect(
    () => () => {
      const { applyRun } = veritySettingsSnapshot();
      if (applyRun.phase === 'done' && applyRun.failed.length === 0) {
        setApplyRun({ phase: 'idle' });
      }
    },
    [],
  );

  const running = run.phase === 'running';
  const busy = running || saving > 0;
  const message =
    recreateRunMessage(run) ??
    (applyPending ? 'Saved settings have not reached the running containers yet.' : null);

  return (
    <SettingsPanel>
      <Text style={styles.updateDetail}>
        Containers take the saved git identity, signing keys and credentials when they are created.
        Recreating restarts each running project container with the current settings.
      </Text>
      {message !== null ? (
        <Text style={styles.reproStatus} accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.reproButton,
          busy ? styles.buttonDisabled : null,
          pressed ? styles.pressed : null,
        ]}
        onPress={startRecreateRun}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={RECREATE_LABEL}
      >
        {running ? <ActivityIndicator size="small" color={theme.colors.setup.text} /> : null}
        <Text style={styles.reproButtonLabel}>{running ? 'Recreating…' : RECREATE_LABEL}</Text>
      </Pressable>
      {saving > 0 ? <Text style={styles.reproHint}>Saving changes first…</Text> : null}
    </SettingsPanel>
  );
}
