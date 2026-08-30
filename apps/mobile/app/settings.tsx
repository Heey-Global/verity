// Global Verity settings: server connection, connected services, GitHub-backed
// repository/commit setup, and server-wide maintenance policy.
import {
  VerityApiError,
  describeServerUpdate,
  reprovisionActiveProjects,
  secretPatchFromDraft,
  secretUiMode,
  secretWritable,
  serverUpdatePollMs,
  publishServerUpdateStatusMutation,
  showsServerUpdatePanel,
  transcriptionBackendStatus,
  validateMasterPassword,
  type AgentLoginProvider,
  type VerityClient,
  type VeritySettings,
  type VeritySettingsPatch,
  type SecretSettingsDraft,
  type SecretStatus,
  type ServerUpdateStatus,
} from '@verity/mobile';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Application from 'expo-application';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentLoginPanel } from '../components/AgentLoginPanel';
import { StatusPill } from '../components/StatusPill';
import { setAuthToken } from '../lib/authToken';
import { checkForAppUpdate } from '../lib/automaticUpdates';
import { runningReleaseVersion } from '../lib/buildInfo';
import { createVerityClient, getVerityBaseUrl } from '../lib/client';

// Plain (non-secret) fields whose values round-trip through GET/PATCH /settings.
// The write-only secret paste fields live in `SecretSettingsDraft` (see below) so
// they can never be echoed back from the server — the draft is the only place they
// exist client-side, and they're cleared after a successful save.
type SettingsDraft = {
  advancedModeEnabled: boolean;
  gitUserName: string;
  gitUserEmail: string;
  gitSshPrivateKeyPath: string;
  gitSshPublicKeyPath: string;
  gitKnownHostsPath: string;
  gitAllowedSignersPath: string;
  githubAppId: string;
  githubAppInstallationId: string;
  transcribeBaseUrl: string;
  transcribeModel: string;
  transcribeBackendMode: 'local' | 'external' | null;
};

type ToggleFieldKey = 'advancedModeEnabled';
type FieldKey = Exclude<keyof SettingsDraft, ToggleFieldKey | 'transcribeBackendMode'>;

const EMPTY_DRAFT: SettingsDraft = {
  advancedModeEnabled: false,
  gitUserName: '',
  gitUserEmail: '',
  gitSshPrivateKeyPath: '',
  gitSshPublicKeyPath: '',
  gitKnownHostsPath: '',
  gitAllowedSignersPath: '',
  githubAppId: '',
  githubAppInstallationId: '',
  transcribeBaseUrl: '',
  transcribeModel: '',
  transcribeBackendMode: null,
};

// Write-only paste boxes: never populated from server state, always start empty,
// and are omitted from the save patch unless the operator typed something (see
// `secretPatchFromDraft`). Kept separate from `SettingsDraft` for that reason.
const EMPTY_SECRET_DRAFT: SecretSettingsDraft = {
  githubAppId: '',
  githubAppInstallationId: '',
  githubAppPrivateKey: '',
  gitSshPrivateKey: '',
  codexAuthJson: '',
  dopplerServiceToken: '',
  uplinkSubscriptionKey: '',
  transcribeApiKey: '',
};

// All text fields still round-trip through the API. The legacy/deployment-level
// file-path values remain preserved here, but are deliberately not exposed in the
// mobile UI; operators configure those through the deployment's GitOps source.
const ALL_DRAFT_FIELDS: FieldKey[] = [
  'gitUserName',
  'gitUserEmail',
  'gitSshPrivateKeyPath',
  'gitSshPublicKeyPath',
  'gitKnownHostsPath',
  'gitAllowedSignersPath',
  'githubAppId',
  'githubAppInstallationId',
  'transcribeBaseUrl',
  'transcribeModel',
];
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

type ReproState =
  | { phase: 'idle' }
  | { phase: 'empty' }
  | { phase: 'running'; total: number; done: number }
  | { phase: 'done'; total: number; done: number; failed: string[] };

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function valueFromSettings(settings: VeritySettings | null, key: FieldKey): string {
  return settings?.[key] ?? '';
}

function draftFromSettings(settings: VeritySettings | null): SettingsDraft {
  return {
    gitUserName: valueFromSettings(settings, 'gitUserName'),
    gitUserEmail: valueFromSettings(settings, 'gitUserEmail'),
    gitSshPrivateKeyPath: valueFromSettings(settings, 'gitSshPrivateKeyPath'),
    gitSshPublicKeyPath: valueFromSettings(settings, 'gitSshPublicKeyPath'),
    gitKnownHostsPath: valueFromSettings(settings, 'gitKnownHostsPath'),
    gitAllowedSignersPath: valueFromSettings(settings, 'gitAllowedSignersPath'),
    githubAppId: valueFromSettings(settings, 'githubAppId'),
    githubAppInstallationId: valueFromSettings(settings, 'githubAppInstallationId'),
    transcribeBaseUrl: valueFromSettings(settings, 'transcribeBaseUrl'),
    transcribeModel: valueFromSettings(settings, 'transcribeModel'),
    transcribeBackendMode: settings?.transcribeBackendMode ?? null,
    advancedModeEnabled: settings?.advancedModeEnabled ?? false,
  };
}

// The base patch preserves Git identity and legacy deployment-level signing paths.
// GitHub-App identifiers and write-only secret VALUES are produced by
// `secretPatchFromDraft`; an empty paste box never clears a configured secret.
function patchFromDraft(
  draft: SettingsDraft,
  secretDraft: SecretSettingsDraft,
): VeritySettingsPatch {
  return {
    gitUserName: trimOrNull(draft.gitUserName),
    gitUserEmail: trimOrNull(draft.gitUserEmail),
    gitSshPrivateKeyPath: trimOrNull(draft.gitSshPrivateKeyPath),
    gitSshPublicKeyPath: trimOrNull(draft.gitSshPublicKeyPath),
    gitKnownHostsPath: trimOrNull(draft.gitKnownHostsPath),
    gitAllowedSignersPath: trimOrNull(draft.gitAllowedSignersPath),
    transcribeBaseUrl: trimOrNull(draft.transcribeBaseUrl),
    transcribeModel: trimOrNull(draft.transcribeModel),
    transcribeBackendMode: draft.transcribeBackendMode,
    advancedModeEnabled: draft.advancedModeEnabled,
    ...secretPatchFromDraft({
      githubAppId: draft.githubAppId,
      githubAppInstallationId: draft.githubAppInstallationId,
      githubAppPrivateKey: secretDraft.githubAppPrivateKey,
      gitSshPrivateKey: secretDraft.gitSshPrivateKey,
      codexAuthJson: secretDraft.codexAuthJson,
      dopplerServiceToken: secretDraft.dopplerServiceToken,
      uplinkSubscriptionKey: secretDraft.uplinkSubscriptionKey,
      transcribeApiKey: secretDraft.transcribeApiKey,
    }),
  };
}

function draftEqualsSettings(draft: SettingsDraft, settings: VeritySettings | null): boolean {
  return (
    ALL_DRAFT_FIELDS.every(
      (key) => trimOrNull(draft[key]) === trimOrNull(valueFromSettings(settings, key)),
    ) &&
    draft.advancedModeEnabled === (settings?.advancedModeEnabled ?? false) &&
    draft.transcribeBackendMode === (settings?.transcribeBackendMode ?? null)
  );
}

// A secret paste box counts as a pending change once it holds non-whitespace.
function secretDraftDirty(secretDraft: SecretSettingsDraft): boolean {
  return (
    secretDraft.githubAppPrivateKey.trim().length > 0 ||
    secretDraft.gitSshPrivateKey.trim().length > 0 ||
    secretDraft.codexAuthJson.trim().length > 0 ||
    secretDraft.dopplerServiceToken.trim().length > 0 ||
    secretDraft.uplinkSubscriptionKey.trim().length > 0 ||
    secretDraft.transcribeApiKey.trim().length > 0
  );
}

// "h-teske" → "HT", "holger" → "HO". Two-letter monogram for the identity avatar.
function initialsFor(name: string): string {
  const parts = name
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return '··';
  const raw =
    parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`;
  return raw.toUpperCase();
}

// The one operator-facing app version names the JavaScript bundle that is actually
// running. Embedded bundles use the native `.0` marketing version; an OTA carries
// its own stamped patch version and therefore replaces the displayed value.
const APP_VERSION_LABEL = runningReleaseVersion(Application.nativeApplicationVersion);

/**
 * Which login the `?agentLogin=` deep link should open on arrival, if any.
 *
 * Matched against the known providers rather than cast: the parameter comes off a
 * URL and can say anything — including, when it is repeated, an array — and an
 * unrecognised value has to land on the panel doing nothing rather than
 * auto-start a provider that does not exist.
 */
function autoStartLoginProvider(
  agentLogin: string | string[] | undefined,
): AgentLoginProvider | undefined {
  return agentLogin === 'claude' || agentLogin === 'codex' ? agentLogin : undefined;
}

export default function SettingsScreen() {
  const { agentLogin } = useLocalSearchParams<{ agentLogin?: string | string[] }>();
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <CenteredMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to edit Verity settings."
      />
    );
  }

  return <SettingsView client={client} agentLogin={agentLogin} />;
}

function SettingsView({
  client,
  agentLogin,
}: {
  client: VerityClient;
  agentLogin?: string | string[];
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<VeritySettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft>(EMPTY_DRAFT);
  const [secretDraft, setSecretDraft] = useState<SecretSettingsDraft>(EMPTY_SECRET_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveQueued, setSaveQueued] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  const [repro, setRepro] = useState<ReproState>({ phase: 'idle' });
  const [applyPending, setApplyPending] = useState(false);
  // Secret-store lifecycle: `undefined` until the first status fetch resolves.
  const [secretStatus, setSecretStatus] = useState<SecretStatus | undefined>(undefined);
  const [checkingForUpdate, setCheckingForUpdate] = useState(false);
  const editVersion = useRef(0);

  const updateAgentConfigured = useCallback((provider: 'claude' | 'codex', configured: boolean) => {
    setSettings((current) =>
      current === null
        ? current
        : {
            ...current,
            ...(provider === 'claude'
              ? { claudeCodeOauthCredentialsConfigured: configured }
              : { codexAuthJsonConfigured: configured }),
          },
    );
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(undefined);
    void client
      .getVeritySettings()
      .then((next) => {
        setSettings(next);
        const nextDraft = draftFromSettings(next);
        setDraft(nextDraft);
      })
      .catch((caught) => {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not load settings');
      })
      .finally(() => setLoading(false));
  }, [client]);

  // Secret-store status is auxiliary to the settings form: a fetch failure leaves
  // the last known value (or undefined → the section renders a neutral spinner)
  // rather than blocking the whole screen behind the error banner.
  const refreshSecretStatus = useCallback(() => {
    void client
      .getSecretStatus()
      .then(setSecretStatus)
      .catch(() => {
        /* non-fatal — keep the previous status */
      });
  }, [client]);

  useEffect(() => {
    load();
    refreshSecretStatus();
  }, [load, refreshSecretStatus]);

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

  const secretDirty = secretDraftDirty(secretDraft);
  const dirty = !draftEqualsSettings(draft, settings) || secretDirty;
  const identityReady =
    trimOrNull(draft.gitUserName) !== null && trimOrNull(draft.gitUserEmail) !== null;
  const signingReady =
    (settings?.gitSshPrivateKeyConfigured ?? false) ||
    trimOrNull(draft.gitSshPrivateKeyPath) !== null;
  // Secret values may only be written once the store is unlocked (a write while
  // sealed 503s). Until the first status resolves, treat as not-yet-writable.
  const secretWritableNow = secretStatus !== undefined && secretWritable(secretStatus);
  // Whether this deployment manages a cipher at all. `unmanaged` (and the pre-fetch
  // `undefined`) mean there's no secret store — the paste fields + unlock hint hide,
  // matching SecretStoreSection which renders nothing in those cases.
  const secretManaged = secretStatus !== undefined && secretStatus !== 'unmanaged';
  // "Connected" means the complete App credential tuple is usable. Partial state
  // stays editable instead of claiming a connection that cannot mint a token.
  const githubConnected =
    (settings?.githubAppPrivateKeyConfigured ?? false) &&
    settings?.githubAppId !== null &&
    settings?.githubAppId !== undefined &&
    settings?.githubAppInstallationId !== null &&
    settings?.githubAppInstallationId !== undefined;

  const updateField = useCallback((key: FieldKey, value: string) => {
    editVersion.current += 1;
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const updateSecretField = useCallback((key: keyof SecretSettingsDraft, value: string) => {
    editVersion.current += 1;
    setSecretDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const updateToggleField = useCallback((key: ToggleFieldKey, value: boolean) => {
    editVersion.current += 1;
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveQueued(true);
  }, []);

  const updateTranscriptionBackend = useCallback((value: 'local' | 'external') => {
    editVersion.current += 1;
    setDraft((current) => ({ ...current, transcribeBackendMode: value }));
    setSaveQueued(true);
  }, []);

  const save = useCallback(() => {
    if (!dirty) return;
    if (saving) {
      setSaveQueued(true);
      return;
    }
    const savingVersion = editVersion.current;
    const requiresContainerApply =
      secretDirty ||
      ALL_DRAFT_FIELDS.some(
        (key) => trimOrNull(draft[key]) !== trimOrNull(valueFromSettings(settings, key)),
      );
    setSaving(true);
    setError(undefined);
    setRepro({ phase: 'idle' });
    const patch = patchFromDraft(draft, secretDraft);
    const submittedSecrets = secretDraft;
    // The request owns an immutable snapshot now. Do not retain plaintext in
    // component state for the lifetime of a failed or slow network request.
    if (secretDirty) setSecretDraft(EMPTY_SECRET_DRAFT);
    void client
      .updateVeritySettings(patch)
      .then((next) => {
        setSettings(next);
        if (editVersion.current === savingVersion) {
          setDraft(draftFromSettings(next));
        }
        setSavedAt(next.updatedAt);
        if (requiresContainerApply) setApplyPending(true);
      })
      .catch((caught) => {
        setSecretDraft((current) => {
          const restored = { ...current };
          for (const key of Object.keys(submittedSecrets) as (keyof SecretSettingsDraft)[]) {
            if (restored[key] === '') restored[key] = submittedSecrets[key];
          }
          return restored;
        });
        // A 503 means the store is sealed — a secret write can't land until it's
        // unlocked. Surface that specifically; other failures use the generic copy.
        setError(
          caught instanceof VerityApiError
            ? caught.status === 503
              ? 'Unlock the secret store first.'
              : caught.message
            : 'Could not save settings',
        );
      })
      .finally(() => setSaving(false));
  }, [client, dirty, draft, saving, secretDirty, secretDraft, settings]);

  const requestSave = useCallback(() => save(), [save]);

  useEffect(() => {
    if (!saving && saveQueued) {
      setSaveQueued(false);
      save();
    }
  }, [save, saveQueued, saving]);

  const reprovision = useCallback(() => {
    if (repro.phase === 'running' || dirty) return;
    setError(undefined);
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
          setApplyPending(false);
          return;
        }
        setRepro({
          phase: 'done',
          total: result.total,
          done: result.done,
          failed: result.failed,
        });
        setApplyPending(result.failed.length > 0);
      } catch (caught) {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not reprovision');
        setRepro({ phase: 'idle' });
      }
    })();
  }, [client, dirty, repro.phase]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: 'Settings' }} />
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: 'Settings' }} />
      {error ? <StaleBanner message={error} onRetry={dirty ? save : load} /> : null}
      {saving ? (
        <View style={styles.autoSaveBanner} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.autoSaveBannerText}>Saving changes…</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {/* Server connection — the recovery path if the saved address is wrong or the
            server moved (IP / Tailscale name change). Routes to the onboarding step in
            reconfigure mode; the only way back to it once a non-null URL is persisted. */}
        <View style={styles.settingsGroup}>
          <Text style={styles.groupHeader}>This app</Text>
          <View style={styles.panel}>
            <Text style={styles.disclosureTitle}>Server</Text>
            <Text style={styles.identityEmail} numberOfLines={1}>
              {getVerityBaseUrl() ?? 'Not set'}
            </Text>
            <Pressable
              style={({ pressed }) => [styles.disclosure, pressed ? styles.pressed : null]}
              onPress={() => router.push('/onboarding/server-url?reconfigure=1')}
              accessibilityRole="button"
              accessibilityLabel="Change server address"
            >
              <Text style={styles.disclosureTitle}>Change server address</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.settingsGroup}>
          <Text style={styles.groupHeader}>GitHub</Text>
          <Text style={styles.groupDescription}>
            Repository access and verified commits from Verity projects.
          </Text>
          <View style={styles.panel}>
            <Text style={styles.disclosureTitle}>GitHub connection</Text>
            <Text style={styles.reproSubtitle}>
              GitHub lets Verity clone repositories, push branches, and open pull requests.
            </Text>
            <View style={styles.serviceStatusRow}>
              <Text style={styles.serviceStatusLabel}>Repository access</Text>
              <StatusPill
                intent={githubConnected ? 'ready' : 'needsSetup'}
                label={githubConnected ? 'Connected' : 'Not connected'}
              />
            </View>
            {!githubConnected ? (
              <Text style={styles.reproSubtitle}>
                Connect GitHub to give Verity access to your repositories.
              </Text>
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.reproButton, pressed ? styles.pressed : null]}
              onPress={() => router.push('/github-connect')}
              accessibilityRole="button"
              accessibilityLabel="Manage GitHub connection"
            >
              <Text style={styles.reproButtonLabel}>Manage GitHub connection</Text>
            </Pressable>

            <View style={styles.connectedServiceSubsection}>
              <View style={styles.serviceStatusRow}>
                <Text style={styles.serviceStatusLabel}>Commit author</Text>
                <StatusPill
                  intent={identityReady ? 'ready' : 'needsSetup'}
                  label={identityReady ? 'Ready' : 'Needs setup'}
                />
              </View>
              <Text style={styles.reproSubtitle}>
                GitHub grants repository access but may not expose a personal commit author for
                organization connections. Enter the name and GitHub-verified email that Verity
                should write to commits.
              </Text>
              <View style={styles.identityRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initialsFor(draft.gitUserName)}</Text>
                </View>
                <View style={styles.identityCol}>
                  <TextInput
                    style={styles.identityName}
                    value={draft.gitUserName}
                    onChangeText={(value) => updateField('gitUserName', value)}
                    onBlur={requestSave}
                    placeholder="Name shown on commits"
                    placeholderTextColor={theme.colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                    accessibilityLabel="Commit name"
                  />
                  <TextInput
                    style={styles.identityEmail}
                    value={draft.gitUserEmail}
                    onChangeText={(value) => updateField('gitUserEmail', value)}
                    onBlur={requestSave}
                    placeholder="GitHub-verified email"
                    placeholderTextColor={theme.colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    returnKeyType="done"
                    accessibilityLabel="Commit email"
                  />
                </View>
              </View>
              <View style={styles.serviceStatusRow}>
                <Text style={styles.serviceStatusLabel}>Verified commits</Text>
                <StatusPill
                  intent={signingReady ? 'ready' : 'needsSetup'}
                  label={signingReady ? 'Ready' : 'Needs setup'}
                />
              </View>
              <SigningKeyDisplay client={client} />
            </View>
          </View>
        </View>

        <View style={styles.settingsGroup}>
          <Text style={styles.groupHeader}>Connected services</Text>
          <Text style={styles.groupDescription}>
            Encrypted credentials and optional services available to Verity projects.
          </Text>
          <SecretStoreSection
            status={secretStatus}
            onUnlocked={refreshSecretStatus}
            onError={setError}
            initSecretPassword={async (pw) => {
              const res = await client.initSecretPassword(pw);
              if (res?.token) await setAuthToken(getVerityBaseUrl(), res.token, res.tokenId);
            }}
            unlockSecret={async (pw) => {
              const res = await client.unlockSecret(pw);
              if (res?.token) await setAuthToken(getVerityBaseUrl(), res.token, res.tokenId);
            }}
          />

          {secretManaged ? (
            <View style={styles.panel}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.disclosureTitle}>Public Preview</Text>
                <StatusPill
                  intent={settings?.uplinkSubscriptionKeyConfigured ? 'ready' : 'optional'}
                  label={settings?.uplinkSubscriptionKeyConfigured ? 'Configured' : 'Optional'}
                />
              </View>
              <Text style={styles.reproSubtitle}>
                Subscription key for paid public links through Verity Uplink. Stored encrypted and
                never shown again.
              </Text>
              <SecretPasteField
                label="Verity subscription key"
                placeholder="Paste subscription key…"
                value={secretDraft.uplinkSubscriptionKey}
                onChangeText={(value) => updateSecretField('uplinkSubscriptionKey', value)}
                configured={settings?.uplinkSubscriptionKeyConfigured ?? false}
                editable={secretWritableNow}
                onBlur={requestSave}
              />
              {!secretWritableNow ? (
                <Text style={styles.reproHint}>Unlock the secret store to change this.</Text>
              ) : null}
            </View>
          ) : null}

          {secretManaged ? (
            <View style={styles.panel}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.disclosureTitle}>Meeting transcription</Text>
                {/*
                  What counts as "set up" is a contract with the server, not a
                  rendering detail — it lives in `transcriptionBackendStatus` and
                  is tested there. Neither a backend this deployment cannot run
                  (the removed local one) nor one it cannot reach (external with
                  no URL/model) may read as ready while uploads are rejected.
                  `transcribeExternalConfigured` is the server's own answer, so
                  the pill agrees with the upload path even when the endpoint
                  comes from the deployment environment rather than these fields.
                */}
                <StatusPill
                  {...transcriptionBackendStatus(
                    draft.transcribeBackendMode,
                    settings?.transcribeExternalConfigured === true,
                  )}
                />
              </View>
              <Text style={styles.reproSubtitle}>
                Choose where Verity processes meeting audio. You can change this later.
              </Text>
              <View style={styles.backendChoices} accessibilityRole="radiogroup">
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: draft.transcribeBackendMode === 'local',
                    disabled: settings?.transcribeLocalAvailable !== true,
                  }}
                  accessibilityLabel="Use local transcription"
                  disabled={settings?.transcribeLocalAvailable !== true}
                  onPress={() => updateTranscriptionBackend('local')}
                  style={[
                    styles.backendChoice,
                    draft.transcribeBackendMode === 'local' ? styles.backendChoiceSelected : null,
                    settings?.transcribeLocalAvailable !== true
                      ? styles.backendChoiceDisabled
                      : null,
                  ]}
                >
                  <Text style={styles.backendChoiceTitle}>Local</Text>
                  <Text style={styles.reproHint}>
                    {settings?.transcribeLocalAvailable
                      ? 'Audio stays on your Verity host.'
                      : 'Not available in this deployment.'}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: draft.transcribeBackendMode === 'external' }}
                  accessibilityLabel="Use external transcription"
                  onPress={() => updateTranscriptionBackend('external')}
                  style={[
                    styles.backendChoice,
                    draft.transcribeBackendMode === 'external'
                      ? styles.backendChoiceSelected
                      : null,
                  ]}
                >
                  <Text style={styles.backendChoiceTitle}>External service</Text>
                  <Text style={styles.reproHint}>Use an OpenAI-compatible speech API.</Text>
                </Pressable>
              </View>
              {draft.transcribeBackendMode === 'external' ? (
                <>
                  <View style={styles.pathContent}>
                    <Text style={styles.pathLabel}>API base URL</Text>
                    <TextInput
                      style={styles.secretInput}
                      value={draft.transcribeBaseUrl}
                      onChangeText={(value) => updateField('transcribeBaseUrl', value)}
                      onBlur={requestSave}
                      placeholder="https://api.example.com/v1/openai"
                      placeholderTextColor={theme.colors.textFaint}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      accessibilityLabel="Transcription API base URL"
                    />
                  </View>
                  <SecretPasteField
                    label="API token"
                    placeholder="Paste the transcription token…"
                    value={secretDraft.transcribeApiKey}
                    onChangeText={(value) => updateSecretField('transcribeApiKey', value)}
                    configured={settings?.transcribeApiKeyConfigured ?? false}
                    editable={secretWritableNow}
                    onBlur={requestSave}
                    masked
                  />
                  <View style={styles.pathContent}>
                    <Text style={styles.pathLabel}>Model</Text>
                    <TextInput
                      style={styles.secretInput}
                      value={draft.transcribeModel}
                      onChangeText={(value) => updateField('transcribeModel', value)}
                      onBlur={requestSave}
                      placeholder="openai/whisper-large-v3"
                      placeholderTextColor={theme.colors.textFaint}
                      autoCapitalize="none"
                      autoCorrect={false}
                      accessibilityLabel="Transcription model"
                    />
                  </View>
                  {!secretWritableNow ? (
                    <Text style={styles.reproHint}>
                      Unlock the secret store to change the token.
                    </Text>
                  ) : null}
                </>
              ) : null}
            </View>
          ) : null}

          {secretManaged ? (
            <View style={styles.panel}>
              <Text style={styles.disclosureTitle}>AI backend logins</Text>
              <Text style={styles.reproSubtitle}>
                Connect or rotate Claude and Codex subscriptions. Credentials stay encrypted on this
                Verity server.
              </Text>
              {secretWritableNow ? (
                <AgentLoginPanel
                  client={client}
                  configured={{
                    claude: settings?.claudeCodeOauthCredentialsConfigured ?? false,
                    codex: settings?.codexAuthJsonConfigured ?? false,
                  }}
                  onConfiguredChange={updateAgentConfigured}
                  onSealed={() => {
                    setError('Unlock the secret store first.');
                    refreshSecretStatus();
                  }}
                  showGuidance={false}
                  allowDisconnect
                  autoStartProvider={autoStartLoginProvider(agentLogin)}
                />
              ) : (
                <Text style={styles.reproHint}>
                  {autoStartLoginProvider(agentLogin) === undefined
                    ? 'Unlock the secret store to change these.'
                    : // Arrived from the banner's "Sign in to Codex", into a store
                      // that cannot hold the new login yet. Saying only "unlock to
                      // change these" reads as if the tap went nowhere; the panel
                      // mounts and auto-starts the moment the store is unlocked.
                      'Unlock the secret store to sign in — the login will start once it is open.'}
                </Text>
              )}
            </View>
          ) : null}

          {secretManaged ? (
            <View style={styles.panel}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.disclosureTitle}>Doppler</Text>
                <StatusPill
                  intent={settings?.dopplerServiceTokenConfigured ? 'ready' : 'optional'}
                  label={settings?.dopplerServiceTokenConfigured ? 'Configured' : 'Optional'}
                />
              </View>
              <Text style={styles.reproSubtitle}>
                Account token used by project-level Doppler bindings. Stored encrypted and never
                shown again.
              </Text>
              <SecretPasteField
                label="Service Account token (dp.sa.…)"
                placeholder="Paste the Doppler token…"
                value={secretDraft.dopplerServiceToken}
                onChangeText={(value) => updateSecretField('dopplerServiceToken', value)}
                configured={settings?.dopplerServiceTokenConfigured ?? false}
                editable={secretWritableNow}
                onBlur={requestSave}
              />
              {!secretWritableNow ? (
                <Text style={styles.reproHint}>Unlock the secret store to change this.</Text>
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={styles.settingsGroup}>
          <Text style={styles.groupHeader}>Advanced</Text>
          <View style={styles.panel}>
            <Text style={styles.disclosureTitle}>Verity Control</Text>
            <Text style={styles.reproSubtitle}>
              Show an internal Verity Control workspace for server administration sessions.
            </Text>
            <ToggleRow
              label="Advanced mode"
              value={draft.advancedModeEnabled}
              onValueChange={(value) => updateToggleField('advancedModeEnabled', value)}
            />
          </View>
        </View>

        <View style={styles.settingsGroup}>
          <Text style={styles.groupHeader}>Maintenance</Text>
          <ServerUpdateSection client={client} />

          <Text style={styles.settingsSaveState} accessibilityLiveRegion="polite">
            {saving || dirty ? 'Saving changes…' : 'All changes saved'}
          </Text>

          {/* Apply to running containers only appears after a relevant saved change. */}
          {applyPending || repro.phase !== 'idle' ? (
            <View style={styles.reproPanel}>
              <Text style={styles.reproTitle}>Apply to running containers</Text>
              <Text style={styles.reproSubtitle}>
                Saved settings reach existing project containers after reprovisioning. This
                recreates each running container.
              </Text>
              {repro.phase === 'running' || !dirty ? <ReproStatus state={repro} /> : null}
              <Pressable
                style={({ pressed }) => [
                  styles.reproButton,
                  dirty || repro.phase === 'running' ? styles.buttonDisabled : null,
                  pressed ? styles.pressed : null,
                ]}
                onPress={reprovision}
                disabled={dirty || repro.phase === 'running'}
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
              {dirty ? <Text style={styles.reproHint}>Saving changes first…</Text> : null}
            </View>
          ) : null}

          {savedAt ? (
            <Text style={styles.footnote}>Last saved {new Date(savedAt).toLocaleString()}.</Text>
          ) : null}

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
      </ScrollView>
    </View>
  );
}

/**
 * Verity updating itself (ADR 0008 D4). Two things make this panel different
 * from every other one on this screen: the server it talks to is the thing
 * being replaced, so requests are expected to fail during activation; and the
 * install target is never chosen here — the button forwards the exact digest
 * the server reported, so the app cannot name an image of its own.
 */
function ServerUpdateSection({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [status, setStatus] = useState<ServerUpdateStatus | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(() => {
    const generation = ++refreshGeneration.current;
    return (
      client
        .getServerUpdates()
        .then((next) => {
          if (generation === refreshGeneration.current) {
            setStatus(next);
            publishServerUpdateStatusMutation(next);
          }
        })
        // A poll that fails mid-cutover is expected: the old server is gone and
        // the new one is not serving yet. Keep the last known operation on
        // screen rather than blanking the panel.
        .catch(() => undefined)
    );
  }, [client]);

  // Expo Router can keep this route mounted after navigating away. Refresh on
  // every focus so a transient `unreachable` result does not remain on screen
  // forever (that idle state intentionally has no background polling).
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const operation = status?.operation ?? null;
  const pollMs = serverUpdatePollMs(operation);
  useEffect(() => {
    if (pollMs === null) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  const install = useCallback(
    (targetDigest: string, idempotencyKey: string) => {
      if (starting) return;
      setStarting(true);
      setActionError(undefined);
      // The key is derived by describeServerUpdate: stable for a retry after a
      // dropped response, distinct for a retry after a failed attempt.
      void client
        .requestServerUpdate({ idempotencyKey, targetDigest })
        .then((accepted) => {
          refreshGeneration.current += 1;
          setStatus((current) => {
            if (current === undefined) return current;
            const next = { ...current, operation: accepted };
            publishServerUpdateStatusMutation(next);
            return next;
          });
        })
        .catch(async (caught) => {
          // A refused request is final. Anything else may be a lost response to
          // a request the server did accept — asking once tells the two apart,
          // and finding an operation resumes polling instead of leaving the
          // panel idle while Verity is already replacing itself.
          if (caught instanceof VerityApiError && caught.status === 403) {
            setActionError('Set a master password before updating Verity.');
            return;
          }
          const current = await client.getServerUpdates().catch(() => undefined);
          if (current !== undefined && serverUpdatePollMs(current.operation) !== null) {
            setStatus(current);
            publishServerUpdateStatusMutation(current);
            return;
          }
          setActionError('Could not start the update.');
        })
        .finally(() => setStarting(false));
    },
    [client, starting],
  );

  if (status === undefined || !showsServerUpdatePanel(status)) return null;
  const view = describeServerUpdate(status);
  const target = view.targetDigest;
  const attempt = view.idempotencyKey;

  return (
    <View style={styles.reproPanel}>
      <Text style={styles.reproTitle}>{view.title}</Text>
      <Text style={styles.reproSubtitle}>{view.detail}</Text>
      {view.progress !== null ? (
        <View style={styles.updateProgressRow}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={styles.reproStatus} accessibilityLiveRegion="polite">
            {`Step ${String(view.progress.step)} of ${String(view.progress.total)}`}
          </Text>
        </View>
      ) : null}
      {view.action !== null && target !== null && attempt !== null ? (
        <Pressable
          style={({ pressed }) => [
            styles.reproButton,
            starting ? styles.buttonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => install(target, attempt)}
          disabled={starting}
          accessibilityRole="button"
          accessibilityLabel={view.action}
        >
          {starting ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
          <Text style={styles.reproButtonLabel}>{starting ? 'Starting…' : view.action}</Text>
        </Pressable>
      ) : null}
      {actionError !== undefined ? <Text style={styles.reproHint}>{actionError}</Text> : null}
    </View>
  );
}

// The at-rest secret store's master-password lifecycle: onboarding (set), unlock
// after a restart (unlock), or a compact "Unlocked" pill once the key is loaded.
// `unmanaged` (and the pre-fetch `undefined`) render nothing. Passwords live only
// in this component's local state and are never logged or hoisted into the draft.
function SecretStoreSection({
  status,
  onUnlocked,
  onError,
  initSecretPassword,
  unlockSecret,
}: {
  status: SecretStatus | undefined;
  onUnlocked: () => void;
  onError: (message: string) => void;
  initSecretPassword: (password: string) => Promise<void>;
  unlockSecret: (password: string) => Promise<void>;
}) {
  const { theme } = useUnistyles();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Lets the master-password field's return key jump to Confirm during onboarding.
  const confirmRef = useRef<TextInput>(null);

  if (status === undefined || status === 'unmanaged') return null;

  const mode = secretUiMode(status);
  if (mode === 'hidden') return null;

  const reset = () => {
    setPassword('');
    setConfirm('');
    setFieldError(undefined);
  };

  const submitInit = () => {
    if (busy) return;
    const validation = validateMasterPassword(password, confirm);
    if (validation) {
      setFieldError(validation);
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    void initSecretPassword(password)
      .then(() => {
        reset();
        onUnlocked();
      })
      .catch((caught) => {
        // 409 = the store already has a password (e.g. set from another client /
        // a concurrent restart). The `set` form is stale — refetch status so the
        // section advances to `unlock`/`ready` instead of staying stuck. Mirrors
        // how the unlock path recovers on a rejected attempt.
        if (caught instanceof VerityApiError && caught.status === 409) {
          reset();
          onUnlocked();
          return;
        }
        onError(caught instanceof VerityApiError ? caught.message : 'Could not set the password');
      })
      .finally(() => setBusy(false));
  };

  const submitUnlock = () => {
    if (busy) return;
    setFieldError(undefined);
    setBusy(true);
    void unlockSecret(password)
      .then(() => {
        reset();
        onUnlocked();
      })
      .catch((caught) => {
        if (caught instanceof VerityApiError && caught.status === 401) {
          setFieldError('Incorrect password.');
          return;
        }
        onError(caught instanceof VerityApiError ? caught.message : 'Could not unlock');
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.panel}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.disclosureTitle}>Secret store</Text>
        {mode === 'ready' ? <StatusPill intent="ready" label="Unlocked" /> : null}
      </View>
      <Text style={styles.sectionSubtitle}>
        {mode === 'set'
          ? 'Set a master password to protect secrets at rest.'
          : mode === 'unlock'
            ? 'Enter the master password to unlock stored secrets after a restart.'
            : 'Secrets are unlocked and available to project containers.'}
      </Text>

      {mode === 'set' || mode === 'unlock' ? (
        <View style={styles.secretStoreForm}>
          <View style={styles.pathContent}>
            <Text style={styles.pathLabel}>Master password</Text>
            <TextInput
              style={styles.pathInput}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={theme.colors.textFaint}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType={mode === 'set' ? 'next' : 'done'}
              // Hardware/software Return submits (unlock) or advances to Confirm (set),
              // so the flow doesn't require reaching for the button (#unlock-enter).
              onSubmitEditing={() => {
                if (mode === 'set') {
                  confirmRef.current?.focus();
                } else if (password.length > 0) {
                  submitUnlock();
                }
              }}
            />
          </View>
          {mode === 'set' ? (
            <View style={styles.pathContent}>
              <Text style={styles.pathLabel}>Confirm password</Text>
              <TextInput
                ref={confirmRef}
                style={styles.pathInput}
                value={confirm}
                onChangeText={setConfirm}
                placeholder="••••••••"
                placeholderTextColor={theme.colors.textFaint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="done"
                onSubmitEditing={submitInit}
              />
            </View>
          ) : null}
          {fieldError ? <Text style={styles.fieldError}>{fieldError}</Text> : null}
          <View style={styles.actionRow}>
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                busy || password.length === 0 ? styles.buttonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={mode === 'set' ? submitInit : submitUnlock}
              disabled={busy || password.length === 0}
              accessibilityRole="button"
              accessibilityLabel={mode === 'set' ? 'Set master password' : 'Unlock secret store'}
            >
              {busy ? <ActivityIndicator size="small" color={theme.colors.background} /> : null}
              <Text style={styles.primaryButtonLabel}>
                {mode === 'set' ? 'Set master password' : 'Unlock'}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// A write-only secret paste box: the value is never read back from the server, so the
// pill reflects the server's `*Configured` boolean, not the (always-empty on load)
// box. Disabled with a muted look when the secret store isn't unlocked.
//
// PEM callers use multiline because newlines must survive and React Native cannot
// reliably mask multiline inputs. Single-line tokens opt into `masked`, which uses
// secureTextEntry and omits the visible-value warning.
function SecretPasteField({
  label,
  placeholder,
  value,
  onChangeText,
  configured,
  editable,
  onBlur,
  masked = false,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  configured: boolean;
  editable: boolean;
  onBlur: () => void;
  masked?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.pathContent}>
      <View style={styles.secretLabelRow}>
        <Text style={styles.pathLabel}>{label}</Text>
        <StatusPill
          intent={configured ? 'ready' : 'optional'}
          label={configured ? 'Configured' : 'Not configured'}
        />
      </View>
      <TextInput
        style={[styles.secretInput, !editable ? styles.secretInputDisabled : null]}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        editable={editable}
        multiline={!masked}
        secureTextEntry={masked}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
      {editable && !masked ? (
        <Text style={styles.footnote}>The key is visible while entering.</Text>
      ) : null}
    </View>
  );
}

function ToggleRow({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.toggleRow, pressed ? styles.pressed : null]}
      onPress={() => onValueChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
    >
      <Text style={styles.toggleLabel}>{label}</Text>
      <View style={[styles.toggleTrack, value ? styles.toggleTrackOn : null]}>
        <View style={[styles.toggleKnob, value ? styles.toggleKnobOn : null]} />
      </View>
    </Pressable>
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

function StaleBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText} numberOfLines={2}>
        {message}
      </Text>
      <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button">
        <Text style={styles.bannerAction}>Retry</Text>
      </Pressable>
    </View>
  );
}

function CenteredMessage({
  title,
  subtitle,
  onRetry,
}: {
  title: string;
  subtitle?: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.centered}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <Text style={styles.centerTitle}>{title}</Text>
      {subtitle ? <Text style={styles.centerSubtitle}>{subtitle}</Text> : null}
      {onRetry ? (
        <Pressable style={styles.retryButton} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.retryButtonLabel}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const GITHUB_SIGNING_KEY_URL = 'https://github.com/settings/ssh/new';

/** Shows the current signing PUBLIC key so it can be (re-)added to GitHub as a
 *  Signing Key — the step that makes Verity-signed commits verify. Public
 *  material, so it loads even while the secret store is sealed. */
function SigningKeyDisplay({ client }: { client: VerityClient }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; publicKey: string | null; configured: boolean }
    | { kind: 'error' }
  >({ kind: 'loading' });
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    void client
      .getSigningKey()
      .then((info) =>
        setState({ kind: 'ready', publicKey: info.publicKey, configured: info.configured }),
      )
      .catch(() => setState({ kind: 'error' }));
  }, [client]);
  useEffect(() => load(), [load]);

  const copy = (key: string): void => {
    void Clipboard.setStringAsync(key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (state.kind === 'loading') {
    return (
      <View style={styles.signingKeySection}>
        <View style={styles.signingKeyLoadingRow}>
          <ActivityIndicator size="small" />
          <Text style={styles.disclosureSummary}>Loading signing key…</Text>
        </View>
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <Pressable
        style={styles.signingKeySection}
        onPress={load}
        accessibilityRole="button"
        accessibilityLabel="Retry loading signing key"
      >
        <Text style={styles.disclosureSummary}>Could not load the signing key. Tap to retry.</Text>
      </Pressable>
    );
  }
  if (state.publicKey === null) {
    return (
      <View style={styles.signingKeySection}>
        <Text style={styles.pathLabel}>Signing key</Text>
        <Text style={styles.disclosureSummary}>
          {state.configured
            ? 'A signing method is configured, but no public key is available to display.'
            : 'No signing key yet — set up GitHub commits during onboarding, then add the public key to GitHub.'}
        </Text>
      </View>
    );
  }

  const publicKey = state.publicKey;
  return (
    <View style={styles.signingKeySection}>
      <Text style={styles.pathLabel}>Signing key — add it to GitHub as a Signing Key</Text>
      <Pressable
        onPress={() => copy(publicKey)}
        accessibilityRole="button"
        accessibilityLabel="Signing public key. Double tap to copy"
        style={({ pressed }) => [styles.signingKeyBlock, pressed ? styles.pressed : null]}
      >
        <Text style={styles.signingKeyText} selectable>
          {publicKey}
        </Text>
      </Pressable>
      <View style={styles.signingKeyActions}>
        <Pressable
          onPress={() => copy(publicKey)}
          accessibilityRole="button"
          accessibilityLabel="Copy signing public key"
          style={({ pressed }) => [styles.signingKeyButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.signingKeyButtonText}>{copied ? 'Copied ✓' : 'Copy key'}</Text>
        </Pressable>
        <Pressable
          onPress={() => void Linking.openURL(GITHUB_SIGNING_KEY_URL).catch(() => undefined)}
          accessibilityRole="button"
          accessibilityLabel="Open GitHub SSH key settings"
          style={({ pressed }) => [styles.signingKeyButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.signingKeyButtonText}>Open GitHub ↗</Text>
        </Pressable>
      </View>
      <Text style={styles.disclosureSummary}>
        On GitHub pick Key type “Signing Key” (not Authentication), on the account whose verified
        email matches the commit email above.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.background,
  },
  centerTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  centerSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    textAlign: 'center',
  },
  content: {
    padding: theme.spacing.md,
    gap: theme.spacing.xl,
  },
  settingsGroup: {
    gap: theme.spacing.sm,
  },
  groupHeader: {
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  groupDescription: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 19 * theme.fontScale,
    marginBottom: theme.spacing.xs,
  },
  sectionHeaderRow: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  sectionSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 19 * theme.fontScale,
    marginBottom: theme.spacing.xs,
  },
  // Generic card panel.
  panel: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  backendChoices: {
    gap: theme.spacing.sm,
  },
  backendChoice: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  backendChoiceSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: `${theme.colors.accent}12`,
  },
  backendChoiceDisabled: {
    opacity: 0.5,
  },
  backendChoiceTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  // Identity profile block.
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${theme.colors.accent}26`,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
  },
  avatarText: {
    color: theme.colors.accent,
    fontSize: theme.text.lg,
    fontWeight: '800',
  },
  identityCol: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  identityName: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  identityEmail: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    paddingVertical: theme.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  // Disclosure and compact service details.
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  disclosureTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  disclosureSummary: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
  },
  serviceStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  serviceStatusLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  connectedServiceSubsection: {
    gap: theme.spacing.md,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  signingKeySection: {
    gap: theme.spacing.sm,
  },
  pathContent: {
    flex: 1,
    gap: theme.spacing.xs,
    paddingLeft: theme.spacing.sm,
  },
  pathLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  pathInput: {
    minHeight: 44,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: theme.text.sm,
    fontFamily: MONO,
  },
  // Secret paste field: a taller, monospace multiline box with a label+status row.
  secretLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  secretInput: {
    minHeight: 88,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: theme.text.sm,
    fontFamily: MONO,
    textAlignVertical: 'top',
  },
  secretInputDisabled: {
    opacity: 0.45,
  },
  fieldError: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.xs,
    fontWeight: '700',
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  summaryValue: {
    flexShrink: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontFamily: MONO,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
  settingsSaveState: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    textAlign: 'center',
    paddingVertical: theme.spacing.xs,
  },
  primaryButton: {
    minHeight: 44,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  primaryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  secondaryButton: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  secretStoreForm: {
    gap: theme.spacing.sm,
  },
  secondaryButtonLabel: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.7,
  },
  // Reprovision sub-panel.
  reproPanel: {
    marginTop: theme.spacing.xs,
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  reproTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  reproSubtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  reproStatus: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  reproButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
  },
  reproButtonLabel: {
    color: theme.colors.accent,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  reproHint: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    textAlign: 'center',
  },
  updateProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  toggleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  toggleLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  toggleTrack: {
    width: 46,
    height: 26,
    padding: 3,
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  toggleTrackOn: {
    borderColor: theme.colors.accent,
    backgroundColor: `${theme.colors.accent}33`,
  },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.textMuted,
  },
  toggleKnobOn: {
    transform: [{ translateX: 20 }],
    backgroundColor: theme.colors.accent,
  },
  footnote: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  versionFootnote: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  autoSaveBanner: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  autoSaveBannerText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  bannerText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
  },
  bannerAction: {
    color: theme.colors.accent,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  retryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  retryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  signingKeyLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  signingKeyBlock: {
    marginTop: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  signingKeyText: {
    color: theme.colors.text,
    fontSize: theme.text.xs,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16 * theme.fontScale,
  },
  signingKeyActions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  signingKeyButton: {
    minHeight: 40,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  signingKeyButtonText: {
    color: theme.colors.accent,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
}));
