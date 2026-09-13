import {
  VerityApiError,
  type AgentLogin,
  type AgentLoginProvider,
  type VerityClient,
} from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type LoginState = {
  login: AgentLogin | null;
  code: string;
  copied: boolean;
  deviceCodeCopied: boolean;
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
  return {
    login: null,
    code: '',
    copied: false,
    deviceCodeCopied: false,
    openedLoginPage: false,
    busy: false,
    error: null,
  };
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
  const currentSessions = useRef<Partial<Record<AgentLoginProvider, string>>>({});
  const requestGenerations = useRef<Record<AgentLoginProvider, number>>({ claude: 0, codex: 0 });
  const pollsInFlight = useRef(new Set<string>());
  useEffect(
    () => () => {
      currentSessions.current = {};
    },
    [],
  );
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
    const pollKey = `${provider}:${sessionId}`;
    if (pollsInFlight.current.has(pollKey)) return;
    pollsInFlight.current.add(pollKey);
    void client
      .getAgentLogin(sessionId)
      .then((login) => {
        if (currentSessions.current[provider] !== sessionId) return;
        patchProvider(provider, { login, error: login.status === 'failed' ? login.message : null });
        refreshConfigured(provider, login);
      })
      .catch((caught) => {
        if (currentSessions.current[provider] !== sessionId) return;
        if (isSealedError(caught)) {
          delete currentSessions.current[provider];
          patchProvider(provider, { login: null, busy: false, error: null });
          onSealed?.();
          return;
        }
        if (isMissingLoginSession(caught)) {
          delete currentSessions.current[provider];
          patchProvider(provider, { login: null, busy: false, error: null });
          return;
        }
        patchProvider(provider, {
          error: caught instanceof VerityApiError ? caught.message : 'Could not refresh login.',
        });
      })
      .finally(() => pollsInFlight.current.delete(pollKey));
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
      const generation = ++requestGenerations.current[provider];
      delete currentSessions.current[provider];
      patchProvider(provider, {
        login: null,
        busy: true,
        error: null,
        copied: false,
        deviceCodeCopied: false,
        openedLoginPage: false,
      });
      void client
        .startAgentLogin(provider)
        .then((login) => {
          if (requestGenerations.current[provider] !== generation) return;
          currentSessions.current[provider] = login.sessionId;
          patchProvider(provider, { login, busy: false });
          refreshConfigured(provider, login);
        })
        .catch((caught) => {
          if (requestGenerations.current[provider] !== generation) return;
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
    const generation = ++requestGenerations.current[provider];
    delete currentSessions.current[provider];
    patchProvider(provider, { busy: true, error: null });
    void client
      .disconnectAgentLogin(provider)
      .then(() => {
        if (requestGenerations.current[provider] !== generation) return;
        patchProvider(provider, emptyLoginState());
        onConfiguredChange?.(provider, false);
      })
      .catch((caught) => {
        if (requestGenerations.current[provider] !== generation) return;
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
    const generation = requestGenerations.current[provider];
    patchProvider(provider, { busy: true, error: null });
    void client
      .submitAgentLoginCode(sessionId, state.code)
      .then((login) => {
        if (
          requestGenerations.current[provider] !== generation ||
          currentSessions.current[provider] !== sessionId
        )
          return;
        currentSessions.current[provider] = login.sessionId;
        patchProvider(provider, { login, code: '', busy: false });
        refreshConfigured(provider, login);
      })
      .catch((caught) => {
        if (requestGenerations.current[provider] !== generation) return;
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
    void Clipboard.setStringAsync(code)
      .then(() => {
        patchProvider(provider, { copied: true, deviceCodeCopied: true, error: null });
        const timer = setTimeout(() => patchProvider(provider, { copied: false }), 700);
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      })
      .catch(() =>
        patchProvider(provider, {
          error: 'Could not copy the code. Select it manually, then continue to the login page.',
        }),
      );
  };

  const pasteCode = (provider: AgentLoginProvider) => {
    void Clipboard.getStringAsync()
      .then((value) => {
        const code = value.trim();
        if (code.length === 0) {
          patchProvider(provider, { error: 'The clipboard does not contain a login code.' });
          return;
        }
        patchProvider(provider, { code, error: null });
      })
      .catch(() => patchProvider(provider, { error: 'Could not read the clipboard.' }));
  };

  return (
    <>
      {showGuidance ? (
        <View style={styles.guidance}>
          <Text style={styles.guidanceTitle} accessibilityRole="header">
            Choose an agent connection
          </Text>
          <Text style={styles.guidanceStep}>
            Connect at least one provider. You can add another later; Verity stores each resulting
            credential encrypted and uses it only for agent sessions.
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
        onPasteCode={() => pasteCode('claude')}
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
        onPasteCode={() => pasteCode('codex')}
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
  onPasteCode,
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
  onPasteCode: () => void;
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
  const returnedCodeFlow = login?.needsCode === true && login.userCode === null;
  const deviceCodeFlow = login?.userCode !== null && login?.userCode !== undefined;
  const openLoginLabel = state.openedLoginPage
    ? 'Open ' + title + ' login again'
    : 'Open ' + title + ' login page';
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
            <ActivityIndicator size="small" color={theme.colors.onPrimary} />
          ) : null}
          <Text style={styles.primaryButtonLabel}>{buttonLabel}</Text>
        </Pressable>
      ) : null}

      {loginBoxVisible ? (
        <View style={styles.loginBox}>
          {login.userCode ? (
            <LoginStep
              number={1}
              title={`Copy your one-time ${title} code`}
              state={state.deviceCodeCopied ? 'done' : 'active'}
            >
              <View style={styles.codeRow}>
                <Text style={styles.code} selectable>
                  {login.userCode}
                </Text>
              </View>
              <Pressable
                onPress={() => onCopyCode(login.userCode ?? '')}
                accessibilityRole="button"
                accessibilityLabel={'Copy ' + title + ' code'}
                style={({ pressed }) => [
                  state.deviceCodeCopied ? styles.linkButton : styles.primaryButton,
                  pressed ? styles.pressed : null,
                ]}
              >
                <Text style={state.deviceCodeCopied ? styles.linkLabel : styles.primaryButtonLabel}>
                  {state.copied
                    ? 'Copied'
                    : state.deviceCodeCopied
                      ? 'Copy code again'
                      : 'Copy code'}
                </Text>
              </Pressable>
            </LoginStep>
          ) : null}
          {canOpenLoginPage ? (
            <LoginStep
              number={deviceCodeFlow ? 2 : 1}
              title={
                deviceCodeFlow
                  ? `Open ${title} and paste the code`
                  : `Sign in to ${title} in your browser`
              }
              description={
                deviceCodeFlow
                  ? `Paste the copied code on the ${title} login page.`
                  : `Return to Verity with the code ${title} shows after sign-in.`
              }
              state={
                state.openedLoginPage
                  ? 'done'
                  : !deviceCodeFlow || state.deviceCodeCopied
                    ? 'active'
                    : 'pending'
              }
            >
              <Pressable
                onPress={() => {
                  onOpenLoginPage();
                  void Linking.openURL(login.verificationUri ?? '');
                }}
                accessibilityRole={state.openedLoginPage ? 'link' : 'button'}
                accessibilityLabel={openLoginLabel}
                style={({ pressed }) => [
                  !state.openedLoginPage && (!deviceCodeFlow || state.deviceCodeCopied)
                    ? styles.primaryButton
                    : styles.linkButton,
                  pressed ? styles.pressed : null,
                ]}
              >
                <Text
                  style={
                    !state.openedLoginPage && (!deviceCodeFlow || state.deviceCodeCopied)
                      ? styles.primaryButtonLabel
                      : styles.linkLabel
                  }
                >
                  {openLoginLabel}
                </Text>
              </Pressable>
            </LoginStep>
          ) : null}
          {deviceCodeFlow ? (
            <LoginStep
              number={3}
              title="Finish there, then return to Verity"
              description="We will detect the completed login automatically."
              state={state.openedLoginPage ? 'active' : 'pending'}
            >
              {state.openedLoginPage ? (
                <View style={styles.waitingRow}>
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                  <Text style={styles.waitingText}>Waiting for sign-in…</Text>
                </View>
              ) : null}
            </LoginStep>
          ) : null}
          {login.needsCode && login.status !== 'complete' ? (
            <LoginStep
              number={2}
              title={
                state.openedLoginPage
                  ? `Paste the code ${title} showed you`
                  : `Return with your ${title} code`
              }
              description="Paste is fastest, or enter the code manually."
              state={codeStepActive ? 'active' : 'pending'}
            >
              {returnedCodeFlow && state.openedLoginPage ? (
                <Pressable
                  style={({ pressed }) => [styles.pasteButton, pressed ? styles.pressed : null]}
                  onPress={onPasteCode}
                  accessibilityRole="button"
                  accessibilityLabel={'Paste ' + title + ' code from clipboard'}
                >
                  <Text style={styles.pasteButtonLabel}>Paste from clipboard</Text>
                </Pressable>
              ) : null}
              <TextInput
                style={styles.input}
                value={state.code}
                onChangeText={onChangeCode}
                placeholder={`${title} code`}
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
                <Text style={styles.secondaryButtonLabel}>Connect {title}</Text>
              </Pressable>
            </LoginStep>
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

function LoginStep({
  number,
  title,
  description,
  state,
  children,
}: {
  number: number;
  title: string;
  description?: string;
  state: 'pending' | 'active' | 'done';
  children?: ReactNode;
}) {
  return (
    <View style={[styles.loginStep, state === 'active' ? styles.loginStepActive : null]}>
      <View
        style={[
          styles.stepBadge,
          state === 'active' ? styles.stepBadgeActive : null,
          state === 'done' ? styles.stepBadgeDone : null,
        ]}
      >
        <Text
          style={[styles.stepBadgeLabel, state === 'pending' ? styles.stepBadgeLabelMuted : null]}
        >
          {state === 'done' ? '✓' : number}
        </Text>
      </View>
      <View style={styles.stepBody}>
        <Text style={[styles.stepTitle, state === 'pending' ? styles.stepTitlePending : null]}>
          {title}
        </Text>
        {description ? <Text style={styles.stepDescription}>{description}</Text> : null}
        {children}
      </View>
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
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  primaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '900',
  },
  submitButton: {
    minHeight: 42,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  pasteButton: {
    minHeight: 42,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  pasteButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '900',
  },
  secondaryButtonLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.sm,
    fontWeight: '900',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  loginBox: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.xs,
  },
  linkButton: {
    alignSelf: 'flex-start',
    paddingVertical: theme.spacing.xs,
  },
  linkLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
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
  loginStep: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  loginStepActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  stepBadge: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  stepBadgeActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  stepBadgeDone: {
    borderColor: theme.colors.tone.done,
    backgroundColor: theme.colors.tone.done,
  },
  stepBadgeLabel: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '900' },
  stepBadgeLabelMuted: { color: theme.colors.textFaint },
  stepBody: { flex: 1, gap: theme.spacing.sm },
  stepTitle: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '900' },
  stepTitlePending: { color: theme.colors.textFaint },
  stepDescription: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  waitingText: { color: theme.colors.textMuted, fontSize: theme.text.sm, fontWeight: '700' },
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
