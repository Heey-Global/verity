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
  const [githubOpened, setGithubOpened] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const authorReady = name.trim().length > 0 && email.trim().length > 0;

  useEffect(() => {
    onCompletionChange(confirmed || phase.kind === 'configured');
  }, [confirmed, onCompletionChange, phase.kind]);

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
      setGithubOpened(false);
      setHandoffError(null);
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
    setHandoffError(null);
    void Clipboard.setStringAsync(publicKey)
      .then(() => setCopied(true))
      .catch(() => setHandoffError('Could not copy the key. Select it manually, then continue.'));
  };

  const openGithub = () => {
    setHandoffError(null);
    void Linking.openURL(GITHUB_SIGNING_KEY_URL)
      .then(() => setGithubOpened(true))
      .catch(() =>
        setHandoffError('Could not open GitHub. Open GitHub signing key settings manually.'),
      );
  };

  if (phase.kind === 'loading' || phase.kind === 'generating') {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={theme.colors.setup.text} />
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
          <View style={styles.verificationIntro}>
            <Text style={styles.sectionTitle}>Finish commit verification</Text>
            <Text style={styles.description}>
              Verity signs every commit it creates with this key. Adding the public key to GitHub
              lets GitHub mark those commits as Verified, so you and your team can trust where they
              came from.
            </Text>
            <Text style={styles.requiredLabel}>Required before you continue</Text>
          </View>

          <View style={styles.guidedStep}>
            <View style={[styles.stepBadge, copied ? styles.stepBadgeDone : null]}>
              <Text style={styles.stepBadgeLabel}>{copied ? '✓' : '1'}</Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={styles.stepTitle}>Copy your public signing key</Text>
              <Text style={styles.description}>Only the public key is shared with GitHub.</Text>
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
              <Pressable
                style={copied ? styles.retryButton : styles.primaryButton}
                onPress={() => copy(phase.publicKey)}
                accessibilityRole="button"
                accessibilityLabel="Copy signing public key"
              >
                <Text style={copied ? styles.retryButtonLabel : styles.primaryButtonLabel}>
                  {copied ? 'Copy again' : 'Copy signing key'}
                </Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.stepConnector} />

          <View style={styles.guidedStep}>
            <View style={[styles.stepBadge, githubOpened ? styles.stepBadgeDone : null]}>
              <Text style={styles.stepBadgeLabel}>{githubOpened ? '✓' : '2'}</Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={styles.stepTitle}>Add it to GitHub</Text>
              <Text style={styles.description}>
                In GitHub, choose “Signing Key” as the key type, paste the key, and save it. Then
                return to Verity.
              </Text>
              <Pressable
                style={copied && !githubOpened ? styles.primaryButton : styles.secondaryButton}
                onPress={openGithub}
                accessibilityRole="link"
                accessibilityLabel="Open GitHub signing key settings"
              >
                <Text
                  style={
                    copied && !githubOpened
                      ? styles.primaryButtonLabel
                      : styles.secondaryButtonLabel
                  }
                >
                  {githubOpened ? 'Open GitHub again ↗' : 'Open GitHub ↗'}
                </Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.stepConnector} />

          <View style={styles.guidedStep}>
            <View style={[styles.stepBadge, confirmed ? styles.stepBadgeDone : null]}>
              <Text style={styles.stepBadgeLabel}>{confirmed ? '✓' : '3'}</Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={styles.stepTitle}>Confirm it is saved</Text>
              <Text style={styles.description}>
                Next stays locked until you confirm the signing key is on your GitHub account.
              </Text>
              <Pressable
                style={[styles.checkboxRow, confirmed ? styles.confirmedRow : null]}
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
            </View>
          </View>
          {handoffError ? (
            <Text style={styles.error} accessibilityRole="alert">
              {handoffError}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
  },
  loadingCopy: { flex: 1, gap: theme.spacing.xs },
  connectedRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  connectedGlyph: { color: theme.colors.tone.done, fontSize: theme.text.xl, fontWeight: '600' },
  title: { color: theme.colors.text, fontSize: theme.text.lg, fontWeight: '600' },
  sectionTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  description: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.setup.border },
  input: {
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
    backgroundColor: theme.colors.background,
    color: theme.colors.text,
    fontSize: theme.text.md,
  },
  hint: {
    color: theme.colors.setup.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  errorBlock: { gap: theme.spacing.sm },
  linkText: { color: theme.colors.setup.text, fontSize: theme.text.sm, fontWeight: '700' },
  primaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primary,
  },
  buttonDisabled: { opacity: 0.45 },
  primaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '600',
  },
  keyBox: {
    minHeight: 72,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  keyText: { color: theme.colors.text, fontSize: theme.text.xs, lineHeight: 18 * theme.fontScale },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  secondaryButtonLabel: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '700' },
  verificationIntro: { gap: theme.spacing.sm },
  requiredLabel: { color: theme.colors.setup.text, fontSize: theme.text.xs, fontWeight: '600' },
  guidedStep: { flexDirection: 'row', gap: theme.spacing.md },
  stepBadge: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: theme.colors.primary,
  },
  stepBadgeDone: { backgroundColor: theme.colors.tone.done },
  stepBadgeLabel: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '600' },
  stepContent: { flex: 1, gap: theme.spacing.sm },
  stepTitle: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  stepConnector: {
    width: 2,
    height: theme.spacing.md,
    marginLeft: 14,
    backgroundColor: theme.colors.setup.border,
  },
  retryButton: { minHeight: 36, alignItems: 'flex-start', justifyContent: 'center' },
  retryButtonLabel: { color: theme.colors.setup.text, fontSize: theme.text.sm, fontWeight: '700' },
  checkboxRow: {
    minHeight: 52,
    padding: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  confirmedRow: { borderColor: theme.colors.tone.done },
  checkbox: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.setup.border,
  },
  checkboxChecked: { backgroundColor: theme.colors.tone.done, borderColor: theme.colors.tone.done },
  checkboxGlyph: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '600' },
  checkboxLabel: { flex: 1, color: theme.colors.text, fontSize: theme.text.sm },
}));
