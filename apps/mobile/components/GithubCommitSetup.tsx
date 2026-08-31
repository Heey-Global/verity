import { VerityApiError, type VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const GITHUB_SIGNING_KEY_URL = 'https://github.com/settings/ssh/new';

type Phase =
  | { kind: 'loading' }
  | { kind: 'generating' }
  | { kind: 'needsAuthor'; message?: string }
  | { kind: 'ready'; publicKey: string }
  // A signing key is already configured (e.g. via a server-side path) but its
  // public key is not readable here, so there is nothing to copy. Signing still
  // works, so this is a done state — not a dead end.
  | { kind: 'configured' }
  | { kind: 'error'; message: string };

/** Connected half of the one-page GitHub onboarding flow. It appears only after
 * authorization, derives the commit author when GitHub can provide it, creates
 * the signing key server-side, and gates completion on the GitHub registration
 * hand-off. */
export function GithubCommitSetup({
  client,
  onCompletionChange,
}: {
  client: VerityClient;
  onCompletionChange: (complete: boolean) => void;
}) {
  const { theme } = useUnistyles();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const authorReady = name.trim().length > 0 && email.trim().length > 0;

  useEffect(() => {
    onCompletionChange(copied || confirmed || phase.kind === 'configured');
  }, [confirmed, copied, onCompletionChange, phase.kind]);

  const loadAuthor = useCallback(() => {
    return client.getVeritySettings().then((settings) => {
      setName(settings?.gitUserName ?? '');
      setEmail(settings?.gitUserEmail ?? '');
      return settings;
    });
  }, [client]);

  const generate = useCallback(
    (identity?: { gitUserName: string; gitUserEmail: string }) => {
      setPhase({ kind: 'generating' });
      setCopied(false);
      setConfirmed(false);
      void client
        .generateSigningKey(identity)
        .then(async (result) => {
          if (!result.ok || result.publicKey === undefined) {
            if (result.error === 'locked') {
              setPhase({ kind: 'error', message: 'Unlock the secret store, then try again.' });
              return;
            }
            setPhase({
              kind: 'needsAuthor',
              ...(result.error ? { message: result.error } : {}),
            });
            return;
          }
          await loadAuthor();
          setPhase({ kind: 'ready', publicKey: result.publicKey });
        })
        .catch((caught) => {
          setPhase({
            kind: 'error',
            message:
              caught instanceof VerityApiError
                ? caught.message
                : 'Could not finish GitHub commit setup.',
          });
        });
    },
    [client, loadAuthor],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([client.getVeritySettings(), client.getSigningKey()])
      .then(([settings, key]) => {
        if (cancelled) return;
        setName(settings?.gitUserName ?? '');
        setEmail(settings?.gitUserEmail ?? '');
        if (key.publicKey !== null) {
          setPhase({ kind: 'ready', publicKey: key.publicKey });
          return;
        }
        if (key.configured) {
          setPhase({ kind: 'configured' });
          return;
        }
        // Generate immediately after GitHub authorization. Personal installs can
        // provide the author automatically; organization installs fall back to
        // the two fields below without exposing that implementation detail first.
        generate(
          settings?.gitUserName && settings.gitUserEmail
            ? { gitUserName: settings.gitUserName, gitUserEmail: settings.gitUserEmail }
            : undefined,
        );
      })
      .catch((caught) => {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message:
            caught instanceof VerityApiError ? caught.message : 'Could not load GitHub setup.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [client, generate]);

  const submitAuthor = () => {
    if (!authorReady || phase.kind === 'generating') return;
    generate({ gitUserName: name.trim(), gitUserEmail: email.trim() });
  };

  const copy = (publicKey: string) => {
    void Clipboard.setStringAsync(publicKey).then(() => setCopied(true));
  };

  if (phase.kind === 'loading' || phase.kind === 'generating') {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={theme.colors.primary} />
        <View style={styles.loadingCopy}>
          <Text style={styles.title}>Finishing GitHub setup…</Text>
          <Text style={styles.description}>
            Loading the commit author and preparing verified commits.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.connectedRow}>
        <Text style={styles.connectedGlyph}>✓</Text>
        <View style={styles.loadingCopy}>
          <Text style={styles.title}>GitHub connected</Text>
          <Text style={styles.description}>Repository access is authorized.</Text>
        </View>
      </View>

      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>Commit author</Text>
      <Text style={styles.description}>
        This name and GitHub-verified email appear on commits created by Verity.
      </Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        editable={phase.kind !== 'ready' && phase.kind !== 'configured'}
        placeholder="Name shown on commits"
        placeholderTextColor={theme.colors.textFaint}
        autoCapitalize="words"
        autoCorrect={false}
        accessibilityLabel="Commit name"
      />
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        editable={phase.kind !== 'ready' && phase.kind !== 'configured'}
        placeholder="GitHub-verified email"
        placeholderTextColor={theme.colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        accessibilityLabel="Commit email"
      />

      {phase.kind === 'needsAuthor' ? (
        <>
          <Text style={styles.hint}>
            GitHub could not provide a personal commit author. Enter yours once to continue.
          </Text>
          {phase.message ? <Text style={styles.error}>{phase.message}</Text> : null}
          <Pressable
            style={[styles.primaryButton, !authorReady ? styles.buttonDisabled : null]}
            onPress={submitAuthor}
            disabled={!authorReady}
            accessibilityRole="button"
            accessibilityLabel="Create signing key"
          >
            <Text style={styles.primaryButtonLabel}>Continue</Text>
          </Pressable>
        </>
      ) : null}

      {phase.kind === 'error' ? (
        <View style={styles.errorBlock}>
          <Text style={styles.error} accessibilityRole="alert">
            {phase.message}
          </Text>
          <Pressable onPress={() => generate()} accessibilityRole="button">
            <Text style={styles.linkText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {phase.kind === 'configured' ? (
        <>
          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>Verified commits</Text>
          <Text style={styles.description}>
            A signing key is already configured. If commits are not showing as Verified, re-add its
            public key to GitHub as a Signing Key from Settings.
          </Text>
        </>
      ) : null}

      {phase.kind === 'ready' ? (
        <>
          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>Verified commits</Text>
          <Text style={styles.description}>
            Add this public key to the same GitHub account as a Signing Key.
          </Text>
          <Pressable
            style={styles.keyBox}
            onPress={() => copy(phase.publicKey)}
            accessibilityRole="button"
            accessibilityLabel="Signing public key. Double tap to copy"
          >
            <Text style={styles.keyText} selectable>
              {phase.publicKey}
            </Text>
          </Pressable>
          <View style={styles.actions}>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => copy(phase.publicKey)}
              accessibilityRole="button"
              accessibilityLabel="Copy signing public key"
            >
              <Text style={styles.secondaryButtonLabel}>{copied ? 'Copied ✓' : 'Copy key'}</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => void Linking.openURL(GITHUB_SIGNING_KEY_URL)}
              accessibilityRole="link"
              accessibilityLabel="Open GitHub signing key settings"
            >
              <Text style={styles.secondaryButtonLabel}>Open GitHub ↗</Text>
            </Pressable>
          </View>
          <Pressable
            style={styles.checkboxRow}
            onPress={() => setConfirmed((value) => !value)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: confirmed }}
            accessibilityLabel="I added the signing key to GitHub"
          >
            <View style={[styles.checkbox, confirmed ? styles.checkboxChecked : null]}>
              <Text style={styles.checkboxGlyph}>{confirmed ? '✓' : ''}</Text>
            </View>
            <Text style={styles.checkboxLabel}>I added the signing key to GitHub</Text>
          </Pressable>
          <Text style={styles.hint}>
            Next becomes available after copying the key or confirming that it is already added.
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  loadingCopy: { flex: 1, gap: theme.spacing.xs },
  connectedRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  connectedGlyph: { color: theme.colors.tone.done, fontSize: theme.text.xl, fontWeight: '800' },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '800' },
  sectionTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '800' },
  description: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border },
  input: {
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    fontSize: theme.text.md,
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  errorBlock: { gap: theme.spacing.sm },
  linkText: { color: theme.colors.primary, fontSize: theme.text.sm, fontWeight: '700' },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
  },
  buttonDisabled: { opacity: 0.45 },
  primaryButtonLabel: { color: theme.colors.onPrimary, fontSize: theme.text.md, fontWeight: '800' },
  keyBox: {
    minHeight: 72,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  keyText: { color: theme.colors.text, fontSize: theme.text.xs, lineHeight: 18 * theme.fontScale },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryButtonLabel: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  checkboxRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  checkbox: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  checkboxChecked: { backgroundColor: theme.colors.tone.done, borderColor: theme.colors.tone.done },
  checkboxGlyph: { color: theme.colors.background, fontSize: theme.text.sm, fontWeight: '800' },
  checkboxLabel: { flex: 1, color: theme.colors.text, fontSize: theme.text.sm },
}));
