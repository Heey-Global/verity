import { resetFeatureHints } from '../../lib/featureHints';
import { useTaskPreferences } from '../../lib/taskPreferences';
// Settings, top level: what is left to set up, where everything lives, and the
// two app-wide switches. Everything with a form of its own is one tap deeper.
//
// The rule this screen keeps is that it fits on a phone without scrolling past
// the fold to find the thing that needs attention: the checklist names what is
// unfinished, and each row below it is a destination, not a control.
import {
  githubRepositoryAccessReady,
  settingsChecklist,
  settingsChecklistHeadline,
  type AuditHealth,
  type BackupStatus,
  type SettingsChecklistItemId,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../../components/settings/settingsStyles';
import { backupRowSummary } from '../../components/settings/backup/backupText';
import { useAppStoreUpdateVersion } from '../../lib/appUpdateFacts';
import { githubActionNeeded, useGithubPermission } from '../../lib/githubPermission';
import { createVerityClient, getVerityBaseUrl } from '../../lib/client';
import { useServerUpdateBadge } from '../../lib/serverUpdateBadge';
import { enterDemoMode, isDemoMode } from '../../lib/demoMode';
import {
  retryFailedVeritySettings,
  saveVeritySettings,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../lib/settingsStore';

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
  const githubConnected = githubRepositoryAccessReady(settings);
  // Surfaced on the Connections row so a grant still owed in GitHub is visible
  // without first opening the connection that needs it.
  const githubPermission = useGithubPermission(client, githubConnected);
  const githubActionPending = githubConnected && githubActionNeeded(githubPermission);
  const [pendingAdvancedMode, setPendingAdvancedMode] = useState<boolean | undefined>(undefined);
  const updateVersion = useServerUpdateBadge(true);
  const appStoreVersion = useAppStoreUpdateVersion(true);
  const [connectedCount, setConnectedCount] = useState<number | undefined>(undefined);
  const keyConfigured = settings?.uplinkSubscriptionKeyConfigured === true;
  const [uplinkState, setUplinkState] = useState<'active' | 'rejected' | 'pending'>('pending');
  // `null` until the Server says this device may read audit logs; members and
  // Servers without the trail never show the row.
  const [auditHealth, setAuditHealth] = useState<AuditHealth | null>(null);
  // An unavailable capability still has a useful explanation. A denied request
  // (members get 403) must not expose administrator controls.
  const [backup, setBackup] = useState<BackupStatus | null>(null);
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
      client
        .auditHealth()
        .then((health) => active && setAuditHealth(health))
        .catch(() => undefined);
      client
        .getBackupStatus()
        .then((status) => active && setBackup(status))
        .catch(() => active && setBackup(null));
      // A stored key is not an active subscription: Uplink may have refused it.
      // Keep the last known state while re-reading so the row does not flicker.
      if (keyConfigured) {
        client
          .getUplinkDiagnostics()
          .then(
            (status) =>
              active &&
              setUplinkState(
                status.control === 'connected' ||
                  (status.control === 'idle' && status.entitlement === 'checked')
                  ? 'active'
                  : status.control === 'rejected'
                    ? 'rejected'
                    : 'pending',
              ),
          )
          .catch(() => active && setUplinkState('pending'));
      }
      return () => {
        active = false;
      };
    }, [client, keyConfigured]),
  );

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

      <SettingsGroup title="Features">
        <SettingsListPanel>
          <SettingsNavRow
            icon="user"
            title="Assistant"
            subtitle="Voice notes, mail and calendar, project tasks"
            onPress={() => router.push('/settings/assistant')}
          />
          <SettingsNavRow
            icon="activity"
            title="QA · CI supervision"
            subtitle="Project monitoring and repair ownership"
            onPress={() => router.push('/settings/repairs')}
          />
          <SettingsNavRow
            icon="link"
            title="Connections"
            subtitle="AI, code, documents and other services"
            status={
              githubActionPending ? { intent: 'needsSetup', label: 'Action needed' } : undefined
            }
            onPress={() => router.push('/settings/services')}
          />
          <SettingsNavRow
            icon="check-square"
            title="Tasks"
            subtitle="Capture bubble, screenshot tips"
            status={
              taskPreferences.enabled
                ? { intent: 'ready', label: 'On' }
                : { intent: 'optional', label: 'Off' }
            }
            onPress={() => router.push('/settings/tasks')}
          />
          <SettingsNavRow
            icon="mic"
            title="Meeting transcription"
            onPress={() => router.push('/settings/transcription')}
          />
          <SettingsNavRow
            icon="shield"
            title="Vulnerability scan"
            subtitle="Known vulnerabilities in code projects"
            onPress={() => router.push('/settings/vulnerability-scan')}
          />
          <SettingsNavRow
            icon="zap"
            signature
            title="Verity Premium"
            subtitle="Online sharing, remote access"
            status={
              !settings?.uplinkSubscriptionKeyConfigured
                ? { intent: 'optional', label: 'Not active' }
                : uplinkState === 'rejected'
                  ? { intent: 'needsSetup', label: 'Key rejected' }
                  : uplinkState === 'active'
                    ? { intent: 'ready', label: 'Active' }
                    : { intent: 'optional', label: 'Configured' }
            }
            onPress={() => router.push('/settings/premium')}
          />
          <SettingsToggleRow
            label="Verity Control"
            subtitle="Advanced mode for server administration sessions"
            value={pendingAdvancedMode ?? settings?.advancedModeEnabled ?? false}
            disabled={loading || settings === null || pendingAdvancedMode !== undefined}
            onValueChange={(value) => {
              setPendingAdvancedMode(value);
              void saveVeritySettings(client, { advancedModeEnabled: value }).finally(() =>
                setPendingAdvancedMode(undefined),
              );
            }}
          />
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup title="App & Server">
        <SettingsListPanel>
          <SettingsNavRow
            icon="download"
            title="Updates"
            subtitle={
              updateVersion !== null
                ? `Server version ${updateVersion} available`
                : appStoreVersion !== null
                  ? `App version ${appStoreVersion} available`
                  : 'Server and app'
            }
            // Only what needs a tap: a downloaded smaller app update applies on
            // its own the next time the app starts.
            status={
              updateVersion !== null || appStoreVersion !== null
                ? { intent: 'needsSetup', label: 'Update' }
                : undefined
            }
            onPress={() => router.push('/settings/server-update')}
          />
          {backup !== null ? (
            <SettingsNavRow
              icon="hard-drive"
              title="Backup"
              {...backupRowSummary(backup)}
              onPress={() => router.push('/settings/backup' as Href)}
            />
          ) : null}
          <SettingsNavRow
            icon="server"
            title="Server address"
            subtitle={isDemoMode() ? 'Local demo' : (getVerityBaseUrl() ?? 'Not set')}
            onPress={() => {
              if (isDemoMode()) {
                Alert.alert('Demo mode', 'Exit the demo to connect to your own Verity server.');
              } else {
                router.push('/onboarding/server-url?reconfigure=1');
              }
            }}
            accessibilityLabel="Change server address"
          />
          <SettingsNavRow
            icon="monitor"
            title="Devices & Web Browsers"
            subtitle={connectedCount !== undefined ? `${connectedCount} connected` : undefined}
            onPress={() => router.push('/devices')}
            accessibilityLabel="Manage devices and web browsers"
          />
          {auditHealth !== null ? (
            <SettingsNavRow
              icon="file-text"
              title="Logs"
              subtitle="Audit history and system output"
              status={
                auditHealth.status === 'degraded'
                  ? { intent: 'needsSetup', label: 'Needs review' }
                  : undefined
              }
              onPress={() => router.push('/settings/audit-logs' as Href)}
            />
          ) : null}
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup title="This app">
        <SettingsListPanel>
          {!isDemoMode() ? (
            <SettingsNavRow
              icon="help-circle"
              title="Show welcome tour again"
              subtitle="Replays the welcome session and hints"
              onPress={() => {
                void resetFeatureHints()
                  .then(() =>
                    router.push({ pathname: '/onboarding/starter', params: { replay: '1' } }),
                  )
                  .catch((error: unknown) =>
                    Alert.alert(
                      'Could not reset hints',
                      error instanceof Error ? error.message : 'Please try again.',
                    ),
                  );
              }}
            />
          ) : null}
          <SettingsNavRow
            icon="activity"
            title="Diagnostics"
            onPress={() => router.push('/settings/diagnostics')}
          />
          {!isDemoMode() ? (
            <SettingsNavRow
              icon="play"
              title="Try demo"
              subtitle="Sample data and simulated AI"
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
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
