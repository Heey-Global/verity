// Settings, top level: what is left to set up, where everything lives, and the
// two app-wide switches. Everything with a form of its own is one tap deeper.
//
// The rule this screen keeps is that it fits on a phone without scrolling past
// the fold to find the thing that needs attention: the checklist names what is
// unfinished, and each row below it is a destination, not a control.
import {
  modelDisplayName,
  settingsChecklist,
  settingsChecklistHeadline,
  commitAuthorReady,
  githubRepositoryAccessReady,
  secretStoreManaged,
  secretStoreReady,
  verifiedCommitsReady,
  type SettingsChecklistItemId,
  type VerityClient,
} from '@verity/mobile';
import * as Application from 'expo-application';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

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
import { checkForAppUpdate } from '../../lib/automaticUpdates';
import { runningReleaseVersion } from '../../lib/buildInfo';
import { createVerityClient, getVerityBaseUrl } from '../../lib/client';
import { useServerUpdateBadge } from '../../lib/serverUpdateBadge';
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
  secretStore: '/settings/services' as Href,
  githubAccess: '/settings/github' as Href,
  commitAuthor: '/settings/github' as Href,
  verifiedCommits: '/settings/github' as Href,
};

export default function SettingsIndexScreen() {
  const { agentLogin } = useLocalSearchParams<{ agentLogin?: string | string[] }>();
  const client = useMemo(() => createVerityClient(), []);

  // `/settings?agentLogin=…` used to open the AI-login panel on the one big
  // screen. The panel now lives under Connected services; forward rather than
  // break links held by an older notification or an un-updated client.
  useEffect(() => {
    if (agentLogin === 'claude' || agentLogin === 'codex') {
      router.replace(`/settings/services?agentLogin=${agentLogin}` as Href);
    }
  }, [agentLogin]);

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
  const { theme } = useUnistyles();
  const reload = useLoadVeritySettings(client);
  const { settings, secretStatus, loading, failed } = useVeritySettings();
  const [checkingForUpdate, setCheckingForUpdate] = useState(false);
  const [pendingAdvancedMode, setPendingAdvancedMode] = useState<boolean | undefined>(undefined);
  const updateAwaits = useServerUpdateBadge(true);

  const checkForManualUpdate = useCallback(() => {
    if (checkingForUpdate) return;
    setCheckingForUpdate(true);
    void checkForAppUpdate()
      .then((result) => {
        if (result === 'current') Alert.alert('Verity is up to date', APP_VERSION_LABEL);
        if (result === 'busy') Alert.alert('Update check in progress');
        if (result === 'disabled') Alert.alert('Updates unavailable', 'EAS Update is disabled.');
        if (result === 'failed') {
          Alert.alert('Update failed', 'Could not check for an update. Try again later.');
        }
      })
      .finally(() => setCheckingForUpdate(false));
  }, [checkingForUpdate]);

  const checklist = settingsChecklist({ settings, secretStatus, failed });
  const githubReady =
    githubRepositoryAccessReady(settings) &&
    commitAuthorReady(settings) &&
    verifiedCommitsReady(settings);
  const servicesNeedsUnlock = secretStoreManaged(secretStatus) && !secretStoreReady(secretStatus);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.setup.text} />
      </View>
    );
  }

  return (
    <SettingsScaffold
      title="Settings"
      onRetry={() =>
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        })
      }
    >
      {checklist.kind === 'ready' && checklist.remaining > 0 ? (
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

      <SettingsGroup title="Setup">
        <SettingsListPanel>
          <SettingsNavRow
            icon="github"
            title="GitHub"
            subtitle="Repository access, commit author, signing key"
            status={{
              intent: githubReady ? 'ready' : 'needsSetup',
              label: githubReady ? 'Ready' : 'Needs setup',
            }}
            onPress={() => router.push('/settings/github')}
          />
          <SettingsNavRow
            icon="key"
            title="Connected services"
            subtitle="Secret store, AI logins, transcription, MCP"
            status={servicesNeedsUnlock ? { intent: 'needsSetup', label: 'Locked' } : undefined}
            onPress={() => router.push('/settings/services')}
          />
          <SettingsNavRow
            icon="tool"
            title="Maintenance"
            subtitle="Server updates and reprovisioning"
            // The header's update dot points at Settings because that is where an
            // update can be started — which is now one screen further in. The row
            // carries the badge on, so the dot never leads to a screen that says
            // nothing about the update it announced.
            status={updateAwaits ? { intent: 'needsSetup', label: 'Update available' } : undefined}
            onPress={() => router.push('/settings/maintenance')}
          />
        </SettingsListPanel>
      </SettingsGroup>

      {/* Wiki maintenance runs on one model for every project, so the choice is
          a server setting and lives with the other server settings. The row
          carries the current value because "which model is writing my Wiki" is
          the question that brings anyone here. */}
      <SettingsGroup title="Knowledge">
        <SettingsListPanel>
          <SettingsNavRow
            icon="book-open"
            title="Knowledge model"
            subtitle="Runs Wiki maintenance in every project"
            // "Not set" is a claim about the server, so it waits for the
            // settings to arrive rather than flashing on every open.
            value={
              settings
                ? settings.knowledgeModel
                  ? modelDisplayName(settings.knowledgeModel)
                  : 'Not set'
                : undefined
            }
            status={
              settings && !settings.knowledgeModel
                ? { intent: 'needsSetup', label: 'Maintenance paused' }
                : undefined
            }
            onPress={() => router.push('/settings/knowledge')}
            accessibilityLabel="Knowledge model"
          />
        </SettingsListPanel>
      </SettingsGroup>

      {/* Server connection — the recovery path if the saved address is wrong or the
          server moved (IP / Tailscale name change). Routes to the onboarding step in
          reconfigure mode; the only way back to it once a non-null URL is persisted. */}
      <SettingsGroup title="This app">
        <SettingsListPanel>
          <SettingsNavRow
            icon="server"
            title="Server"
            value={getVerityBaseUrl() ?? 'Not set'}
            onPress={() => router.push('/onboarding/server-url?reconfigure=1')}
            accessibilityLabel="Change server address"
          />
          <SettingsNavRow
            icon="smartphone"
            title="Paired devices"
            onPress={() => router.push('/devices')}
            accessibilityLabel="Manage paired devices"
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
            disabled={pendingAdvancedMode !== undefined}
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
