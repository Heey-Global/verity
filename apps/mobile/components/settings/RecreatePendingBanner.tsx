// Saved settings that have not reached running project containers yet.
//
// It appears where the change was made, and only while there is something to
// recreate; the Server update screen keeps a standing entry for changes this
// app did not see being saved.
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { setApplyRun, useVeritySettings } from '../../lib/settingsStore';
import { recreateRunMessage, startRecreateRun } from './recreateContainers';
import { settingsStyles as styles } from './settingsStyles';

export const RECREATE_LABEL = 'Recreate running containers';

export function RecreatePendingBanner() {
  const { theme } = useUnistyles();
  const { applyPending, applyRun: run, saving } = useVeritySettings();

  // Nothing saved, nothing running: nothing to say. A run is reported wherever
  // it was started — the standing entry included — so a failure stays in view.
  if (!applyPending && run.phase === 'idle') return null;

  // A clean run clears `applyPending`; its outcome is still worth one line.
  if (run.phase === 'done' && run.failed.length === 0) {
    return (
      <View style={styles.banner} accessibilityLiveRegion="polite">
        <Text style={styles.bannerText}>{recreateRunMessage(run)}</Text>
        <Pressable
          onPress={() => setApplyRun({ phase: 'idle' })}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        >
          <Text style={styles.bannerAction}>OK</Text>
        </Pressable>
      </View>
    );
  }

  const running = run.phase === 'running';
  const message =
    recreateRunMessage(run) ??
    'Saved. Running containers keep the old settings until they are recreated.';

  return (
    <View style={styles.banner} accessibilityLiveRegion="polite">
      <Text style={styles.bannerText} numberOfLines={3}>
        {message}
      </Text>
      <Pressable
        onPress={startRecreateRun}
        disabled={running || saving > 0}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={RECREATE_LABEL}
        style={running || saving > 0 ? styles.buttonDisabled : null}
      >
        {running ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <Text style={styles.bannerAction}>{run.phase === 'done' ? 'Retry' : 'Recreate'}</Text>
        )}
      </Pressable>
    </View>
  );
}
