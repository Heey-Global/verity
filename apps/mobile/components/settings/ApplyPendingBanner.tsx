// Saved settings that have not reached running project containers yet.
//
// Git identity, signing material and credentials are baked into a container
// when it is created, so a saved change only lands after a recreate. This used
// to be a permanent "Running containers" row on a Maintenance screen that
// nobody visited at the moment it mattered. It now appears where the change
// was made, and only while there is something to apply.
import { VerityApiError, reprovisionActiveProjects } from '@verity/mobile';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import {
  clearApplyPending,
  setVeritySettingsError,
  useVeritySettings,
} from '../../lib/settingsStore';
import { settingsStyles as styles } from './settingsStyles';

type ReproState =
  | { phase: 'idle' }
  | { phase: 'running'; total: number; done: number }
  | { phase: 'done'; total: number; failed: string[] };

export function ApplyPendingBanner() {
  const { theme } = useUnistyles();
  const { applyPending, saving } = useVeritySettings();
  const [repro, setRepro] = useState<ReproState>({ phase: 'idle' });

  const apply = useCallback(() => {
    const client = createVerityClient();
    if (client === null || repro.phase === 'running' || saving > 0) return;
    setVeritySettingsError(undefined);
    setRepro({ phase: 'running', total: 0, done: 0 });
    void (async () => {
      try {
        const projects = await client.listProjects();
        const result = await reprovisionActiveProjects(
          projects,
          (projectId) => client.recreateProjectContainer(projectId),
          (progress) => setRepro({ phase: 'running', ...progress }),
        );
        setRepro({ phase: 'done', total: result.total, failed: result.failed });
        // A container that failed to come back still runs the old settings, so
        // the prompt stays until every one of them has been recreated.
        if (result.failed.length === 0) clearApplyPending();
      } catch (caught) {
        setVeritySettingsError(
          caught instanceof VerityApiError ? caught.message : 'Could not reprovision',
        );
        setRepro({ phase: 'idle' });
      }
    })();
  }, [repro.phase, saving]);

  // A clean run clears `applyPending`; its outcome is still worth one line.
  if (!applyPending) {
    if (repro.phase !== 'done' || repro.failed.length > 0) return null;
    return (
      <View style={styles.banner} accessibilityLiveRegion="polite">
        <Text style={styles.bannerText}>
          {repro.total === 0
            ? 'No running containers — new ones start with these settings.'
            : `Applied to ${String(repro.total)} running container${repro.total === 1 ? '' : 's'}.`}
        </Text>
        <Pressable
          onPress={() => setRepro({ phase: 'idle' })}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        >
          <Text style={styles.bannerAction}>OK</Text>
        </Pressable>
      </View>
    );
  }

  const running = repro.phase === 'running';
  const message = running
    ? `Applying to running containers… ${String(repro.done)}/${String(repro.total)}`
    : repro.phase === 'done'
      ? `Not applied to ${repro.failed.join(', ')}.`
      : 'Saved. Running containers keep the old settings until they are recreated.';

  return (
    <View style={styles.banner} accessibilityLiveRegion="polite">
      <Text style={styles.bannerText} numberOfLines={3}>
        {message}
      </Text>
      <Pressable
        onPress={apply}
        disabled={running || saving > 0}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Apply saved settings to running containers"
        style={running || saving > 0 ? styles.buttonDisabled : null}
      >
        {running ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <Text style={styles.bannerAction}>{repro.phase === 'done' ? 'Retry' : 'Apply'}</Text>
        )}
      </Pressable>
    </View>
  );
}
