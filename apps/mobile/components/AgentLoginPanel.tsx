import {
  VerityApiError,
  type AgentLogin,
  type AgentLoginProvider,
  type VerityClient,
} from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type LoginState = {
  login: AgentLogin | null;
  code: string;
  copied: boolean;
  openedLoginPage: boolean;
  busy: boolean;
  error: string | null;
};

export type AgentLoginConfiguredState = {
  claude: boolean;
  codex: boolean;
};

const PROVIDERS: readonly AgentLoginProvider[] = ['claude', 'codex'];

function emptyLoginState(): LoginState {
  return { login: null, code: '', copied: false, openedLoginPage: false, busy: false, error: null };
}

function isSealedError(caught: unknown): boolean {
  return (
    caught instanceof VerityApiError &&
    caught.status === 503 &&
    caught.message.toLowerCase().includes('sealed')
  );
}

function isMissingLoginSession(caught: unknown): boolean {
  return (
    caught instanceof VerityApiError &&
    caught.status === 404 &&
    caught.message.toLowerCase().includes('login session not found')
  );
}

export function AgentLoginPanel({
  client,
  configured,
  onConfiguredChange,
  onActiveChange,
  onSealed,
  showGuidance = true,
  allowDisconnect = false,
  autoStartProvider,
}: {
  client: VerityClient;
  configured: AgentLoginConfiguredState;
  onConfiguredChange?: (provider: AgentLoginProvider, configured: boolean) => void;
  onActiveChange?: (active: boolean) => void;
  onSealed?: () => void;
  showGuidance?: boolean;
  allowDisconnect?: boolean;
  /** Starts a fresh provider login once when reached from an auth failure. */
  autoStartProvider?: AgentLoginProvider;
}) {
  const [logins, setLogins] = useState<Record<AgentLoginProvider, LoginState>>({
    claude: emptyLoginState(),
    codex: emptyLoginState(),
  });

  const autoStartAttempted = useRef(false);
  const patchProvider = useCallback((provider: AgentLoginProvider, patch: Partial<LoginState>) => {
    setLogins((current) => ({
      ...current,
      [provider]: { ...current[provider], ...patch },
    }));
  }, []);

  const refreshConfigured = useCallback(
    (provider: AgentLoginProvider, login: AgentLogin) => {
      if (!login.configured && login.status !== 'complete') return;
      onConfiguredChange?.(provider, true);
    },
    [onConfiguredChange],
  );

  const handleSealed = useCallback(
    (provider: AgentLoginProvider) => {
      patchProvider(provider, { busy: false, error: null });
      onSealed?.();
    },
    [onSealed, patchProvider],
  );

  const poll = (provider: AgentLoginProvider, sessionId: string) => {
    void client
      .getAgentLogin(sessionId)
      .then((login) => {
        patchProvider(provider, { login, error: login.status === 'failed' ? login.message : null });
        refreshConfigured(provider, login);
      })
      .catch((caught) => {
        if (isSealedError(caught)) {
          patchProvider(provider, { login: null, busy: false, error: null });
          onSealed?.();
          return;
        }
        if (isMissingLoginSession(caught)) {
          patchProvider(provider, { login: null, busy: false, error: null });
          return;
        }
        patchProvider(provider, {
          error: caught instanceof VerityApiError ? caught.message : 'Could not refresh login.',
        });
      });
  };

  useEffect(() => {
    const active = PROVIDERS.filter((provider) => {
      const login = logins[provider].login;
      return (
        login !== null &&
        (login.status === 'starting' || login.status === 'ready' || login.status === 'waiting')
      );
    });
    onActiveChange?.(active.length > 0);
    if (active.length === 0) return;
    const timer = setInterval(() => {
      for (const provider of active) {
        const sessionId = logins[provider].login?.sessionId;
        if (!sessionId) continue;
        poll(provider, sessionId);
      }
    }, 2500);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    return () => clearInterval(timer);
  }, [logins, onActiveChange]);

  const start = useCallback(
    (provider: AgentLoginProvider) => {
      patchProvider(provider, {
        login: null,
        busy: true,
        error: null,
        copied: false,
        openedLoginPage: false,
      });
      void client
        .startAgentLogin(provider)
        .then((login) => {
          patchProvider(provider, { login, busy: false });
          refreshConfigured(provider, login);
        })
        .catch((caught) => {
          if (isSealedError(caught)) {
            handleSealed(provider);
            return;
          }
          patchProvider(provider, {
            busy: false,
            error: caught instanceof VerityApiError ? caught.message : 'Could not start login.',
          });
        });
    },
    [client, handleSealed, patchProvider, refreshConfigured],
  );

  useEffect(() => {
    if (autoStartProvider === undefined || autoStartAttempted.current) return;
    autoStartAttempted.current = true;
    start(autoStartProvider);
  }, [autoStartProvider, start]);

  const disconnect = (provider: AgentLoginProvider) => {
    patchProvider(provider, { busy: true, error: null });
    void client
      .disconnectAgentLogin(provider)
      .then(() => {
        patchProvider(provider, emptyLoginState());
        onConfiguredChange?.(provider, false);
      })
      .catch((caught) => {
        if (isSealedError(caught)) {
          handleSealed(provider);
          return;
        }
        patchProvider(provider, {
          busy: false,
          error: caught instanceof VerityApiError ? caught.message : 'Could not disconnect login.',
        });
      });
  };

  const submitCode = (provider: AgentLoginProvider) => {
    const state = logins[provider];
    const sessionId = state.login?.sessionId;
    if (!sessionId || state.code.trim().length === 0) return;
    patchProvider(provider, { busy: true, error: null });
    void client
      .submitAgentLoginCode(sessionId, state.code)
      .then((login) => {
        patchProvider(provider, { login, code: '', busy: false });
        refreshConfigured(provider, login);
      })
      .catch((caught) => {
        if (isSealedError(caught)) {
          handleSealed(provider);
          return;
        }
        patchProvider(provider, {
          busy: false,
          error: caught instanceof VerityApiError ? caught.message : 'Could not submit code.',
        });
      });
  };

  const copyCode = (provider: AgentLoginProvider, code: string) => {
    void Clipboard.setStringAsync(code).then(() => {
      patchProvider(provider, { copied: true });
      const timer = setTimeout(() => patchProvider(provider, { copied: false }), 700);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    });
  };

  return (
    <>
      {showGuidance ? (
        <View style={styles.guidance}>
          <Text style={styles.guidanceTitle} accessibilityRole="header">
            Connect Claude or Codex
          </Text>
          <Text style={styles.guidanceStep}>
            Connect at least one agent subscription. Verity starts the login on this server, stores
            the resulting credential encrypted, and uses it only for agent sessions.
          </Text>
        </View>
      ) : null}
      <ProviderCard
        provider="claude"
        title="Claude"
        configured={configured.claude}
        state={logins.claude}
        allowDisconnect={allowDisconnect}
        onStart={() => start('claude')}
        onDisconnect={() => disconnect('claude')}
        onCopyCode={(code) => copyCode('claude', code)}
        onChangeCode={(code) => patchProvider('claude', { code })}
        onOpenLoginPage={() => patchProvider('claude', { openedLoginPage: true })}
        onSubmitCode={() => submitCode('claude')}
      />
      <ProviderCard
        provider="codex"
        title="Codex"
        configured={configured.codex}
        state={logins.codex}
        allowDisconnect={allowDisconnect}
        onStart={() => start('codex')}
        onDisconnect={() => disconnect('codex')}
        onCopyCode={(code) => copyCode('codex', code)}
        onChangeCode={(code) => patchProvider('codex', { code })}
        onOpenLoginPage={() => patchProvider('codex', { openedLoginPage: true })}
        onSubmitCode={() => submitCode('codex')}
      />
    </>
  );
}

function ProviderCard({
  provider,
  title,
  configured,
  state,
  allowDisconnect,
  onStart,
  onDisconnect,
  onCopyCode,
  onChangeCode,
  onOpenLoginPage,
  onSubmitCode,
}: {
  provider: AgentLoginProvider;
  title: string;
  configured: boolean;
  state: LoginState;
  allowDisconnect: boolean;
  onStart: () => void;
  onDisconnect: () => void;
  onCopyCode: (code: string) => void;
  onChangeCode: (code: string) => void;
  onOpenLoginPage: () => void;
  onSubmitCode: () => void;
}) {
  const { theme } = useUnistyles();
  const login = state.login;
  // An explicit login session takes precedence over the previously stored
  // credential. During re-login the parent remains `configured` until the new
  // credential is saved, but the operator still needs to see and complete the
  // active login flow.
  const ready = login === null ? configured : login.configured || login.status === 'complete';
  const statusText = ready
    ? 'Configured'
    : login?.status === 'failed'
      ? 'Failed'
      : login?.status === 'waiting'
        ? 'Waiting'
        : login?.status === 'ready'
          ? 'Ready'
          : login?.status === 'starting'
            ? 'Starting'
            : 'Not set';
  const canOpenLoginPage =
    login?.verificationUri !== undefined &&
    login.verificationUri !== null &&
    (provider === 'claude' ? login.status === 'ready' : login.userCode !== null);
  const isPreparing = state.busy || (!ready && login?.status === 'starting');
  const isWaitingForCompletion = !ready && login?.status === 'waiting';
  const loginBoxVisible =
    !ready &&
    login !== null &&
    login.status !== 'failed' &&
    (canOpenLoginPage || login.userCode !== null || (login.needsCode && login.status === 'ready'));
  const openLoginLabel = login?.userCode ? '2. Open login page' : '1. Open login page';
  const codePrompt = login?.userCode
    ? '3. Return to Verity and wait for confirmation.'
    : '2. Paste the code Claude shows after sign-in.';
  const primaryButtonVisible = !ready && !loginBoxVisible;
  const codeStepActive =
    login?.needsCode === true &&
    (state.openedLoginPage || login.status === 'waiting' || state.code.trim().length > 0);
  const buttonLabel = isPreparing
    ? 'Preparing...'
    : isWaitingForCompletion
      ? 'Waiting...'
      : login?.status === 'failed'
        ? 'Restart ' + title + ' login'
        : 'Connect ' + title;

  return (
    <View style={styles.card}>
      <View style={styles.labelRow}>
        <View style={styles.providerTitleGroup}>
          <Text style={styles.label}>{title}</Text>
          <Text style={styles.providerCopy}>
            {provider === 'claude'
              ? 'Connect your Claude subscription to this Verity server.'
              : 'Connect your Codex subscription to this Verity server.'}
          </Text>
        </View>
        <View style={[styles.pill, ready ? styles.pillReady : null]}>
          <Text style={[styles.pillText, ready ? styles.pillTextReady : null]}>{statusText}</Text>
        </View>
      </View>

      {ready ? (
        <>
          <Text style={styles.success}>{title} connected.</Text>
          {allowDisconnect ? (
            <View style={styles.actionRow}>
              <Pressable
                style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
                onPress={onStart}
                disabled={state.busy}
                accessibilityRole="button"
                accessibilityLabel={'Reconnect ' + title}
              >
                {state.busy ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
                <Text style={styles.linkLabel}>Re-login</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.dangerButton, pressed ? styles.pressed : null]}
                onPress={onDisconnect}
                disabled={state.busy}
                accessibilityRole="button"
                accessibilityLabel={'Logout ' + title}
              >
                {state.busy ? (
                  <ActivityIndicator size="small" color={theme.colors.tone.danger} />
                ) : null}
                <Text style={styles.dangerLabel}>Logout</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : null}

      {primaryButtonVisible ? (
        <Pressable
          style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
          onPress={onStart}
          disabled={isPreparing || isWaitingForCompletion}
          accessibilityRole="button"
          accessibilityLabel={buttonLabel}
        >
          {isPreparing || isWaitingForCompletion ? (
            <ActivityIndicator size="small" color={theme.colors.background} />
          ) : null}
          <Text style={styles.primaryButtonLabel}>{buttonLabel}</Text>
        </Pressable>
      ) : null}

      {loginBoxVisible ? (
        <View style={styles.loginBox}>
          {login.userCode ? (
            <>
              <Text style={styles.stepActive}>1. Copy this device code.</Text>
              <View style={styles.codeRow}>
                <Text style={styles.code}>{login.userCode}</Text>
                <Pressable
                  onPress={() => onCopyCode(login.userCode ?? '')}
                  accessibilityRole="button"
                  accessibilityLabel={'Copy ' + title + ' code'}
                  hitSlop={8}
                  style={({ pressed }) => [styles.copyChip, pressed ? styles.pressed : null]}
                >
                  <Text style={styles.copyLabel}>{state.copied ? 'Copied' : 'Copy'}</Text>
                </Pressable>
              </View>
            </>
          ) : null}
          {canOpenLoginPage ? (
            <Pressable
              onPress={() => {
                onOpenLoginPage();
                void Linking.openURL(login.verificationUri ?? '');
              }}
              accessibilityRole="link"
              accessibilityLabel={'Open ' + title + ' login page'}
              style={({ pressed }) => [styles.linkButton, pressed ? styles.pressed : null]}
            >
              <Text style={styles.linkLabel}>{openLoginLabel}</Text>
            </Pressable>
          ) : null}
          {login.needsCode && login.status !== 'complete' ? (
            <View style={styles.field}>
              <Text style={[styles.footnote, codeStepActive ? styles.stepActive : null]}>
                {codePrompt}
              </Text>
              <TextInput
                style={styles.input}
                value={state.code}
                onChangeText={onChangeCode}
                placeholder="Paste Claude code..."
                placeholderTextColor={theme.colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                accessibilityLabel="Claude returned code"
              />
              <Pressable
                style={({ pressed }) => [
                  styles.submitButton,
                  state.code.trim().length === 0 ? styles.buttonDisabled : null,
                  pressed ? styles.pressed : null,
                ]}
                onPress={onSubmitCode}
                disabled={state.code.trim().length === 0 || state.busy}
                accessibilityRole="button"
                accessibilityLabel="Submit Claude code"
              >
                <Text style={styles.secondaryButtonLabel}>Submit code</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {(state.error ?? login?.message) ? (
        <Text style={styles.error} accessibilityRole="alert">
          {state.error ?? login?.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  guidance: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  guidanceTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
    marginBottom: theme.spacing.xs,
  },
  guidanceStep: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  providerTitleGroup: {
    flex: 1,
    gap: 6,
  },
  label: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  providerCopy: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  pill: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  pillReady: {
    borderColor: theme.colors.tone.done,
  },
  pillText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '800',
  },
  pillTextReady: {
    color: theme.colors.tone.done,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  primaryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '900',
  },
  submitButton: {
    minHeight: 42,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  secondaryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.sm,
    fontWeight: '900',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  loginBox: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  linkButton: {
    alignSelf: 'flex-start',
    paddingVertical: theme.spacing.xs,
  },
  linkLabel: {
    color: theme.colors.accent,
    fontSize: theme.text.sm,
    fontWeight: '900',
  },
  codeRow: {
    minHeight: 50,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  code: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '900',
    letterSpacing: 0,
  },
  copyChip: {
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
  },
  copyLabel: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '900',
  },
  field: {
    gap: theme.spacing.xs,
  },
  input: {
    minHeight: 48,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.text,
    backgroundColor: theme.colors.background,
    fontSize: theme.text.sm,
  },
  footnote: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  stepActive: {
    color: theme.colors.accent,
    fontWeight: '900',
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  success: {
    color: theme.colors.tone.done,
    fontSize: theme.text.sm,
    fontWeight: '800',
  },
  actionRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
  },
  dangerButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.tone.danger,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.xs,
  },
  dangerLabel: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '900',
  },
  pressed: {
    opacity: 0.72,
  },
}));
