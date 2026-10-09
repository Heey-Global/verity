// Saved settings that have not reached running project containers yet.
//
// Git identity, signing material and credentials are baked into a container
// when it is created, so a saved change only lands after a recreate. This used
// to be a permanent "Running containers" row on a Maintenance screen that
// nobody visited at the moment it mattered. It now appears where the change
// was made, and only while there is something to apply.
import { VerityApiError, reprovisionActiveProjects } from '@verity/mobile';
import { useCallback } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import {
  applyPendingGeneration,
  applyRunScope,
  clearApplyPending,
  setApplyRun,
  setVeritySettingsError,
  useVeritySettings,
  veritySettingsSnapshot,
} from '../../lib/settingsStore';
import { settingsStyles as styles } from './settingsStyles';

export function ApplyPendingBanner() {
  const { theme } = useUnistyles();
  const { applyPending, applyRun: repro, saving } = useVeritySettings();

  const apply = useCallback(() => {
    const client = createVerityClient();
    // Read from the store, not this render: another screen's banner may have
    // started a run since, and two runs would recreate each container twice.
    const current = veritySettingsSnapshot();
    if (client === null || current.applyRun.phase === 'running' || current.saving > 0) return;
    setVeritySettingsError(undefined);
    const generation = applyPendingGeneration();
    const scope = applyRunScope();
    setApplyRun({ phase: 'running', total: 0, done: 0 }, scope);
    void (async () => {
      try {
        const projects = await client.listProjects();
        const result = await reprovisionActiveProjects(
          projects,
          (projectId) => client.recreateProjectContainer(projectId),
          (progress) => setApplyRun({ phase: 'running', ...progress }, scope),
        );
        // A save during the run missed the containers recreated before it, so
        // every container needs another pass and this run's result is moot.
        if (generation !== applyPendingGeneration()) {
          setApplyRun({ phase: 'idle' }, scope);
          return;
        }
        setApplyRun({ phase: 'done', total: result.total, failed: result.failed }, scope);
        // A container that failed to come back still runs the old settings, so
        // the prompt stays until every one of them has been recreated.
        if (result.failed.length === 0) clearApplyPending(generation);
      } catch (caught) {
        if (scope !== applyRunScope()) return;
        setVeritySettingsError(
          caught instanceof VerityApiError ? caught.message : 'Could not reprovision',
        );
        setApplyRun({ phase: 'idle' }, scope);
      }
    })();
  }, []);

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

  const running = repro.phase === 'running';
  const message = running
    ? repro.total === 0
      ? 'Applying to running containers…'
      : `Applying to running containers… ${String(repro.done)}/${String(repro.total)}`
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
        style={running || saving > 0 ? styles.buttonDisabled : undefined}
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
