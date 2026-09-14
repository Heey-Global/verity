// Shows the current signing PUBLIC key so it can be (re-)added to GitHub as a
// Signing Key — the step that makes Verity-signed commits verify. Public
// material, so it loads even while the secret store is sealed.
import { type VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';

import { settingsStyles as styles } from './settingsStyles';

const GITHUB_SIGNING_KEY_URL = 'https://github.com/settings/ssh/new';

export function SigningKeyDisplay({
  client,
  identity,
  onGenerated,
}: {
  client: VerityClient;
  identity?: { gitUserName: string; gitUserEmail: string };
  onGenerated?: () => void;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; publicKey: string | null; configured: boolean }
    | { kind: 'error' }
  >({ kind: 'loading' });
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | undefined>(undefined);

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

  const generate = (): void => {
    if (generating) return;
    setGenerating(true);
    setGenerationError(undefined);
    void client
      .generateSigningKey(identity)
      .then((result) => {
        if (result.ok && result.publicKey !== undefined) {
          setState({ kind: 'ready', publicKey: result.publicKey, configured: true });
          onGenerated?.();
          return;
        }
        setGenerationError(
          result.error === 'locked'
            ? 'Unlock the secret store, then try again.'
            : result.error || 'Set the commit author above, then try again.',
        );
      })
      .catch(() => setGenerationError('Could not create the signing key.'))
      .finally(() => setGenerating(false));
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
            : 'No signing key yet. Create one here, then add the public key to GitHub.'}
        </Text>
        {!state.configured ? (
          <>
            <Pressable
              onPress={generate}
              disabled={generating}
              accessibilityRole="button"
              accessibilityLabel="Create signing key"
              style={({ pressed }) => [
                styles.signingKeyButton,
                generating ? styles.buttonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={styles.signingKeyButtonText}>
                {generating ? 'Creating…' : 'Create signing key'}
              </Text>
            </Pressable>
            {generationError !== undefined ? (
              <Text style={styles.fieldError}>{generationError}</Text>
            ) : null}
          </>
        ) : null}
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
