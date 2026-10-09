import { useTaskPreferences } from '../../lib/taskPreferences';
// Settings, top level: what is left to set up, where everything lives, and the
// two app-wide switches. Everything with a form of its own is one tap deeper.
//
// The rule this screen keeps is that it fits on a phone without scrolling past
// the fold to find the thing that needs attention: the checklist names what is
// unfinished, and each row below it is a destination, not a control.
import {
  settingsChecklist,
  settingsChecklistHeadline,
  type SettingsChecklistItemId,
  type VerityClient,
} from '@verity/mobile';
import * as Application from 'expo-application';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsPanel,
  SettingsSaveState,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../components/settings/settingsStyles';
import { shareUpdateDiagnostics } from '../../lib/updateDiagnostics';
import { checkForAppUpdate } from '../../lib/automaticUpdates';
import { runningReleaseVersion } from '../../lib/buildInfo';
import { createVerityClient, getVerityBaseUrl } from '../../lib/client';
import { useServerUpdateBadge } from '../../lib/serverUpdateBadge';
import { enterDemoMode, isDemoMode } from '../../lib/demoMode';
import {
  retryFailedVeritySettings,
  saveVeritySettings,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../lib/settingsStore';

// The one operator-facing app version names the JavaScript bundle that is actually
// running. Embedded bundles use the native `.0` marketing version; an OTA carries
// its own stamped patch version and therefore replaces the displayed value.
const APP_VERSION_LABEL = runningReleaseVersion(Application.nativeApplicationVersion);

// Where each unfinished setup step is actually fixed. Exhaustive over the id
// union by type, so a checklist item added in `@verity/mobile` cannot ship
// without a destination — a row that explains a problem but goes nowhere is
// worse than no row.
const CHECKLIST_ROUTES: Readonly<Record<SettingsChecklistItemId, Href>> = {
  secretStore: '/settings/secret-store' as Href,
  githubAccess: '/settings/github' as Href,
  commitAuthor: '/settings/github' as Href,
  verifiedCommits: '/settings/github' as Href,
};

export default function SettingsIndexScreen() {
  const client = useMemo(() => createVerityClient(), []);

  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to edit Verity settings."
      />
    );
  }
  return <SettingsIndexView client={client} />;
}

function SettingsIndexView({ client }: { client: VerityClient }) {
  const taskPreferences = useTaskPreferences();
  const reload = useLoadVeritySettings(client);
  const { settings, secretStatus, loading, failed } = useVeritySettings();
  const [checkingForUpdate, setCheckingForUpdate] = useState(false);
  const [pendingAdvancedMode, setPendingAdvancedMode] = useState<boolean | undefined>(undefined);
  const updateVersion = useServerUpdateBadge(true);
  const [connectedCount, setConnectedCount] = useState<number | undefined>(undefined);
  // Re-read on focus: this screen stays mounted under /devices, where the
  // count changes.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      // Only the row's subtitle depends on it, so a failure leaves the row bare
      // rather than raising a banner over the whole screen.
      client
        .listPairedDevices()
        .then((devices) => active && setConnectedCount(devices.length))
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, [client]),
  );

  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const exportDiagnostics = async () => {
    if (exportingDiagnostics) return;
    setExportingDiagnostics(true);
    try {
      await shareUpdateDiagnostics();
    } catch {
      Alert.alert('Export failed', 'Could not export update diagnostics. Try again later.');
    } finally {
      setExportingDiagnostics(false);
    }
  };

  const checkForManualUpdate = useCallback(() => {
    if (checkingForUpdate) return;
    setCheckingForUpdate(true);
    void checkForAppUpdate()
      .then((result) => {
        if (result === 'current') Alert.alert('Verity is up to date', APP_VERSION_LABEL);
        if (result === 'busy') Alert.alert('Update check in progress');
        if (result === 'disabled') Alert.alert('Updates unavailable', 'EAS Update is disabled.');
        if (typeof result === 'object' && result.status === 'failed') {
          Alert.alert('Update failed', result.message);
        }
      })
      .finally(() => setCheckingForUpdate(false));
  }, [checkingForUpdate]);

  const checklist = settingsChecklist({ settings, secretStatus, failed });

  return (
    <SettingsScaffold
      title="Settings"
      onRetry={() =>
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        })
      }
    >
      {!loading && checklist.kind === 'ready' && checklist.remaining > 0 ? (
        <View style={styles.checklistPanel}>
          <Text style={styles.checklistHeadline} accessibilityRole="header">
            {settingsChecklistHeadline(checklist)}
          </Text>
          <Text style={styles.checklistSubtitle}>
            Verity can run agents already. These steps unlock the rest.
          </Text>
          {checklist.items.map((item) => (
            <Pressable
              key={item.id}
              style={({ pressed }) => [styles.checklistRow, pressed ? styles.pressed : null]}
              onPress={() => router.push(CHECKLIST_ROUTES[item.id])}
              accessibilityRole="button"
              accessibilityLabel={`${item.title}. ${item.done ? 'Done' : item.detail}`}
            >
              <Text style={styles.checklistMark}>{item.done ? '✓' : '○'}</Text>
              <View style={styles.checklistRowBody}>
                <Text
                  style={[
                    styles.checklistRowTitle,
                    item.done ? styles.checklistRowTitleDone : null,
                  ]}
                >
                  {item.title}
                </Text>
                {!item.done ? <Text style={styles.checklistSubtitle}>{item.detail}</Text> : null}
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}

      <SettingsGroup title="Connections">
        <SettingsListPanel>
          <SettingsNavRow
            icon="link"
            title="Connections"
            subtitle="AI, code, documents and other services"
            onPress={() => router.push('/settings/services')}
          />
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup title="Access">
        <SettingsListPanel>
          <SettingsNavRow
            icon="monitor"
            title="Devices & Web Browsers"
            subtitle={connectedCount !== undefined ? `${connectedCount} connected` : undefined}
            onPress={() => router.push('/devices')}
            accessibilityLabel="Manage devices and web browsers"
          />
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup title="Server">
        <SettingsListPanel>
          <SettingsNavRow
            icon="download"
            title="Server update"
            subtitle={updateVersion !== null ? `Version ${updateVersion} available` : undefined}
            status={updateVersion !== null ? { intent: 'needsSetup', label: 'Update' } : undefined}
            onPress={() => router.push('/settings/server-update')}
          />
          <SettingsNavRow
            icon="globe"
            title="Remote access"
            subtitle="Verity Uplink"
            onPress={() => router.push('/settings/remote-access')}
          />
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup title="Features">
        <SettingsListPanel>
          <SettingsNavRow
            icon="check-square"
            title="Tasks"
            subtitle="Capture bubble, screenshot suggestions"
            value={taskPreferences.enabled ? 'On' : 'Off'}
            onPress={() => router.push('/settings/tasks')}
          />
          <SettingsNavRow
            icon="mic"
            title="Meeting transcription"
            onPress={() => router.push('/settings/transcription')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      {/* Server connection — the recovery path if the saved address is wrong or the
          server moved (IP / Tailscale name change). Routes to the onboarding step in
          reconfigure mode; the only way back to it once a non-null URL is persisted. */}
      <SettingsGroup title="This app">
        <SettingsListPanel>
          <SettingsNavRow
            icon="file-text"
            title="Diagnostics"
            subtitle={exportingDiagnostics ? 'Preparing…' : 'Export app update logs'}
            onPress={() => void exportDiagnostics()}
          />
          {!isDemoMode() ? (
            <SettingsNavRow
              icon="play"
              title="Try demo"
              subtitle="Local sample data and simulated AI; your server connection is preserved"
              onPress={() => {
                void enterDemoMode()
                  .then(() => router.replace('/'))
                  .catch((error: unknown) =>
                    Alert.alert(
                      'Could not start demo',
                      error instanceof Error ? error.message : 'Please try again.',
                    ),
                  );
              }}
            />
          ) : null}
          <SettingsNavRow
            icon="server"
            title="Server address"
            value={isDemoMode() ? 'Local demo' : (getVerityBaseUrl() ?? 'Not set')}
            onPress={() => {
              if (isDemoMode()) {
                Alert.alert('Demo mode', 'Exit the demo to connect to your own Verity server.');
              } else {
                router.push('/onboarding/server-url?reconfigure=1');
              }
            }}
            accessibilityLabel="Change server address"
          />
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup title="Advanced">
        <SettingsPanel>
          <Text style={styles.disclosureTitle}>Verity Control</Text>
          <Text style={styles.reproSubtitle}>
            Show an internal Verity Control workspace for server administration sessions.
          </Text>
          <SettingsToggleRow
            label="Advanced mode"
            value={pendingAdvancedMode ?? settings?.advancedModeEnabled ?? false}
            disabled={loading || settings === null || pendingAdvancedMode !== undefined}
            onValueChange={(value) => {
              setPendingAdvancedMode(value);
              void saveVeritySettings(client, { advancedModeEnabled: value }).finally(() =>
                setPendingAdvancedMode(undefined),
              );
            }}
          />
        </SettingsPanel>
      </SettingsGroup>

      <View style={styles.settingsGroup}>
        <SettingsSaveState />
        {/* The exact JS bundle version currently running. Long-pressing performs
            an immediate, serialized EAS Update check. */}
        <Pressable
          onLongPress={checkForManualUpdate}
          delayLongPress={600}
          disabled={checkingForUpdate}
          accessibilityRole="button"
          accessibilityLabel={`Version ${APP_VERSION_LABEL}`}
          accessibilityHint="Long press to check for an update"
        >
          <Text style={styles.versionFootnote}>{APP_VERSION_LABEL}</Text>
        </Pressable>
      </View>
    </SettingsScaffold>
  );
}
