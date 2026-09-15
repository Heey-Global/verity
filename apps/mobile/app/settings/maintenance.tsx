// Maintenance: replacing the Verity server itself, and pushing saved settings
// into project containers that are already running.
import { VerityApiError, reprovisionActiveProjects, type VerityClient } from '@verity/mobile';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ServerUpdateSection } from '../../components/settings/ServerUpdateSection';
import {
  SettingsGroup,
  SettingsMessage,
  SettingsSaveState,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../components/settings/settingsStyles';
import { createVerityClient } from '../../lib/client';
import {
  clearApplyPending,
  retryFailedVeritySettings,
  setVeritySettingsError,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../lib/settingsStore';

type ReproState =
  | { phase: 'idle' }
  | { phase: 'empty' }
  | { phase: 'running'; total: number; done: number }
  | { phase: 'done'; total: number; done: number; failed: string[] };

export default function MaintenanceSettingsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage this server."
        screenTitle="Maintenance"
      />
    );
  }
  return <MaintenanceSettingsView client={client} />;
}

function MaintenanceSettingsView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const reload = useLoadVeritySettings(client);
  const { applyPending, saving } = useVeritySettings();
  const [repro, setRepro] = useState<ReproState>({ phase: 'idle' });

  const reprovision = useCallback(() => {
    if (repro.phase === 'running' || saving > 0) return;
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
        if (result.total === 0) {
          setRepro({ phase: 'empty' });
          clearApplyPending();
          return;
        }
        setRepro({
          phase: 'done',
          total: result.total,
          done: result.done,
          failed: result.failed,
        });
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
  }, [client, repro.phase, saving]);

  return (
    <SettingsScaffold
      title="Maintenance"
      detail
      onRetry={() =>
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        })
      }
    >
      <SettingsGroup title="Server">
        <ServerUpdateSection client={client} />
      </SettingsGroup>

      <SettingsGroup title="Project containers">
        <View style={styles.reproPanel}>
          <Text style={styles.reproTitle}>Apply to running containers</Text>
          <Text style={styles.reproSubtitle}>
            Saved settings reach existing project containers after reprovisioning. This recreates
            each running container.
          </Text>
          {applyPending ? (
            <Text style={styles.reproStatus} accessibilityLiveRegion="polite">
              Settings changed since these containers started.
            </Text>
          ) : null}
          <ReproStatus state={repro} />
          <Pressable
            style={({ pressed }) => [
              styles.reproButton,
              saving > 0 || repro.phase === 'running' ? styles.buttonDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={reprovision}
            disabled={saving > 0 || repro.phase === 'running'}
            accessibilityRole="button"
            accessibilityLabel="Reprovision running containers now"
          >
            {repro.phase === 'running' ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : null}
            <Text style={styles.reproButtonLabel}>
              {repro.phase === 'running' ? 'Reprovisioning…' : 'Reprovision now'}
            </Text>
          </Pressable>
          {saving > 0 ? <Text style={styles.reproHint}>Saving changes first…</Text> : null}
        </View>
      </SettingsGroup>

      <SettingsSaveState />
    </SettingsScaffold>
  );
}

function ReproStatus({ state }: { state: ReproState }) {
  if (state.phase === 'idle') return null;
  if (state.phase === 'empty') {
    return <Text style={styles.reproStatus}>No running containers to reprovision.</Text>;
  }
  if (state.phase === 'running') {
    return (
      <Text style={styles.reproStatus}>
        Reprovisioning {state.done}/{state.total}…
      </Text>
    );
  }
  const ok = state.done - state.failed.length;
  return (
    <Text style={styles.reproStatus}>
      Reprovisioned {ok}/{state.total}
      {state.failed.length > 0 ? ` · failed: ${state.failed.join(', ')}` : ''}.
    </Text>
  );
}
