// GitHub: the three things that have to be true before Verity can work on a
// repository on the operator's behalf — access to it, an author to commit as,
// and a signing key GitHub recognises.
//
// This screen owns exactly two stored fields (`gitUserName`, `gitUserEmail`).
// Everything else here is either navigation or read-only status, and the save
// patch is built from those two keys alone — see `useSettingsFields`.
import {
  githubRepositoryAccessReady,
  verifiedCommitsReady,
  type VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsMessage,
  SettingsPanel,
  SettingsSaveState,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
import { SigningKeyDisplay } from '../../components/settings/SigningKeyDisplay';
import { settingsStyles as styles } from '../../components/settings/settingsStyles';
import { StatusPill } from '../../components/StatusPill';
import { createVerityClient } from '../../lib/client';
import {
  patchVeritySettingsLocally,
  retryFailedVeritySettings,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../lib/settingsStore';
import { useSettingsFields } from '../../lib/useSettingsFields';

// Module-level: the hook syncs on this array's identity, and it is also the
// literal list of keys a save from this screen may contain.
const AUTHOR_FIELDS = ['gitUserName', 'gitUserEmail'] as const;

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

export default function GitHubSettingsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to edit Verity settings."
        screenTitle="GitHub"
      />
    );
  }
  return <GitHubSettingsView client={client} />;
}

function GitHubSettingsView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const reload = useLoadVeritySettings(client);
  const { settings } = useVeritySettings();
  const author = useSettingsFields(client, AUTHOR_FIELDS);

  const connected = githubRepositoryAccessReady(settings);
  // Readiness follows the draft, not the stored value: the operator has just
  // typed a name and email, and a pill that stays red until the blur lands
  // reads as if the typing did not count.
  const identityReady =
    author.values.gitUserName.trim() !== '' && author.values.gitUserEmail.trim() !== '';
  const signingReady = verifiedCommitsReady(settings);

  return (
    <SettingsScaffold
      title="GitHub"
      detail
      onRetry={() => {
        if (author.dirty) {
          author.commit();
          return;
        }
        void retryFailedVeritySettings(client).then((retried) => {
          if (!retried) reload();
        });
      }}
    >
      <SettingsGroup
        title="Repository access"
        description="GitHub lets Verity clone repositories, push branches, and open pull requests."
      >
        <SettingsPanel>
          <View style={styles.serviceStatusRow}>
            <Text style={styles.serviceStatusLabel}>GitHub connection</Text>
            <StatusPill
              quiet
              intent={connected ? 'ready' : 'needsSetup'}
              label={connected ? 'Connected' : 'Not connected'}
            />
          </View>
          {!connected ? (
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
        </SettingsPanel>
      </SettingsGroup>

      <SettingsGroup title="Commit author">
        <SettingsPanel>
          <View style={styles.serviceStatusRow}>
            <Text style={styles.serviceStatusLabel}>Author identity</Text>
            <StatusPill
              quiet
              intent={identityReady ? 'ready' : 'needsSetup'}
              label={identityReady ? 'Ready' : 'Needs setup'}
            />
          </View>
          <Text style={styles.reproSubtitle}>
            GitHub grants repository access but may not expose a personal commit author for
            organization connections. Enter the name and GitHub-verified email that Verity should
            write to commits.
          </Text>
          <View style={styles.identityRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initialsFor(author.values.gitUserName)}</Text>
            </View>
            <View style={styles.identityCol}>
              <TextInput
                style={styles.identityName}
                value={author.values.gitUserName}
                onChangeText={(value) => author.set('gitUserName', value)}
                onBlur={author.commit}
                placeholder="Name shown on commits"
                placeholderTextColor={theme.colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
                accessibilityLabel="Commit name"
              />
              <TextInput
                style={styles.identityEmail}
                value={author.values.gitUserEmail}
                onChangeText={(value) => author.set('gitUserEmail', value)}
                onBlur={author.commit}
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
        </SettingsPanel>
      </SettingsGroup>

      <SettingsGroup title="Verified commits">
        <SettingsPanel>
          <View style={styles.serviceStatusRow}>
            <Text style={styles.serviceStatusLabel}>Signing</Text>
            <StatusPill
              quiet
              intent={signingReady ? 'ready' : 'needsSetup'}
              label={signingReady ? 'Ready' : 'Needs setup'}
            />
          </View>
          <SigningKeyDisplay
            client={client}
            onGenerated={() => {
              patchVeritySettingsLocally(
                (current) => ({
                  ...current,
                  gitSshPrivateKeyConfigured: true,
                  gitSshPublicKeyConfigured: true,
                }),
                true,
              );
              reload();
            }}
            identity={
              identityReady
                ? {
                    gitUserName: author.values.gitUserName.trim(),
                    gitUserEmail: author.values.gitUserEmail.trim(),
                  }
                : undefined
            }
          />
        </SettingsPanel>
      </SettingsGroup>

      <SettingsSaveState dirty={author.dirty} />
    </SettingsScaffold>
  );
}
