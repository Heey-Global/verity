import { subscribeLiveRefresh } from '../lib/liveConnection';
import {
  VerityApiError,
  type AgentLogin,
  type AgentLoginProvider,
  type VerityClient,
} from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentProviderIcon } from './AgentProviderIcon';
import { Button, StatusTag, TextField } from './ui';

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
  compact = false,
  selectedProvider,
  subscriptionPlans = {},
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
  /** Settings frame each provider as a standalone card; onboarding shows the guided flow. */
  compact?: boolean;
  selectedProvider?: AgentLoginProvider;
  /** Plan labels the server derived from each stored login, when it knows one. */
  subscriptionPlans?: Partial<Record<AgentLoginProvider, string | null>>;
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

  const poll = useCallback(
    (provider: AgentLoginProvider, sessionId: string) => {
      const pollKey = `${provider}:${sessionId}`;
      if (pollsInFlight.current.has(pollKey)) return;
      pollsInFlight.current.add(pollKey);
      void client
        .getAgentLogin(sessionId)
        .then((login) => {
          if (currentSessions.current[provider] !== sessionId) return;
          patchProvider(provider, {
            login,
            error: login.status === 'failed' ? login.message : null,
          });
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
    },
    [client, patchProvider, refreshConfigured, onSealed],
  );

  const activeLoginIds = JSON.stringify(
    PROVIDERS.flatMap((provider) => {
      const login = logins[provider].login;
      return login && ['starting', 'ready', 'waiting'].includes(login.status)
        ? [[provider, login.sessionId]]
        : [];
    }),
  );
  useEffect(() => {
    const active = JSON.parse(activeLoginIds) as Array<[AgentLoginProvider, string]>;
    onActiveChange?.(active.length > 0);
    if (active.length === 0) return;
    const refresh = () => {
      for (const [provider, sessionId] of active) poll(provider, sessionId);
    };
    return subscribeLiveRefresh(
      client,
      refresh,
      (path) => path.startsWith('/settings/agent-logins/'),
      active.map(([, sessionId]) => ({
        path: `/settings/agent-logins/${encodeURIComponent(sessionId)}`,
      })),
    );
  }, [activeLoginIds, client, poll, onActiveChange]);

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
      {selectedProvider === undefined || selectedProvider === 'claude' ? (
        <ProviderCard
          provider="claude"
          title="Claude"
          configured={configured.claude}
          state={logins.claude}
          subscriptionPlan={subscriptionPlans.claude ?? null}
          compact={compact}
          allowDisconnect={allowDisconnect}
          onStart={() => start('claude')}
          onDisconnect={() => disconnect('claude')}
          onCopyCode={(code) => copyCode('claude', code)}
          onPasteCode={() => pasteCode('claude')}
          onChangeCode={(code) => patchProvider('claude', { code })}
          onOpenLoginPage={() => patchProvider('claude', { openedLoginPage: true })}
          onSubmitCode={() => submitCode('claude')}
        />
      ) : null}
      {selectedProvider === undefined || selectedProvider === 'codex' ? (
        <ProviderCard
          provider="codex"
          title="Codex"
          configured={configured.codex}
          state={logins.codex}
          subscriptionPlan={subscriptionPlans.codex ?? null}
          compact={compact}
          allowDisconnect={allowDisconnect}
          onStart={() => start('codex')}
          onDisconnect={() => disconnect('codex')}
          onCopyCode={(code) => copyCode('codex', code)}
          onPasteCode={() => pasteCode('codex')}
          onChangeCode={(code) => patchProvider('codex', { code })}
          onOpenLoginPage={() => patchProvider('codex', { openedLoginPage: true })}
          onSubmitCode={() => submitCode('codex')}
        />
      ) : null}
    </>
  );
}

function ProviderCard({
  provider,
  title,
  configured,
  state,
  subscriptionPlan,
  allowDisconnect,
  compact,
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
  subscriptionPlan: string | null;
  allowDisconnect: boolean;
  compact: boolean;
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

  const content = (
    <View style={compact ? styles.compactCard : styles.card}>
      {!compact ? (
        <View style={styles.labelRow}>
          <View style={styles.providerTitleGroup}>
            <Text style={styles.label}>{title}</Text>
            <Text style={styles.providerCopy}>
              {provider === 'claude'
                ? 'Connect your Claude subscription to this Verity server.'
                : 'Connect your Codex subscription to this Verity server.'}
            </Text>
          </View>
          <StatusTag intent={ready ? 'ready' : 'optional'} label={statusText} />
        </View>
      ) : null}

      {ready ? (
        <>
          {!compact ? <Text style={styles.success}>{title} connected.</Text> : null}
          {allowDisconnect ? (
            <View style={styles.actionRow}>
              <Button
                label="Re-login"
                accessibilityLabel={'Reconnect ' + title}
                variant="secondary"
                size="compact"
                loading={state.busy}
                onPress={onStart}
              />
              <Button
                label="Logout"
                accessibilityLabel={'Logout ' + title}
                variant="destructive"
                size="compact"
                loading={state.busy}
                onPress={onDisconnect}
              />
            </View>
          ) : null}
        </>
      ) : null}

      {primaryButtonVisible ? (
        <Button
          label={buttonLabel}
          loading={isPreparing || isWaitingForCompletion}
          onPress={onStart}
          fullWidth
        />
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
              <View style={styles.inline}>
                <Button
                  label={
                    state.copied
                      ? 'Copied'
                      : state.deviceCodeCopied
                        ? 'Copy code again'
                        : 'Copy code'
                  }
                  accessibilityLabel={'Copy ' + title + ' code'}
                  icon={state.copied ? 'check' : 'copy'}
                  variant={state.deviceCodeCopied ? 'secondary' : 'primary'}
                  size="compact"
                  onPress={() => onCopyCode(login.userCode ?? '')}
                />
              </View>
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
              <View style={styles.inline}>
                <Button
                  label={openLoginLabel}
                  icon="external-link"
                  variant={
                    !state.openedLoginPage && (!deviceCodeFlow || state.deviceCodeCopied)
                      ? 'primary'
                      : 'secondary'
                  }
                  size="compact"
                  onPress={() => {
                    onOpenLoginPage();
                    void Linking.openURL(login.verificationUri ?? '');
                  }}
                />
              </View>
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
                  <ActivityIndicator size="small" color={theme.colors.text} />
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
                <View style={styles.inline}>
                  <Button
                    label="Paste from clipboard"
                    accessibilityLabel={'Paste ' + title + ' code from clipboard'}
                    icon="clipboard"
                    variant="secondary"
                    size="compact"
                    onPress={onPasteCode}
                  />
                </View>
              ) : null}
              <TextField
                label={`${title} code`}
                accessibilityLabel="Claude returned code"
                value={state.code}
                onChangeText={onChangeCode}
                literal
              />
              <Button
                label={`Connect ${title}`}
                accessibilityLabel="Submit Claude code"
                loading={state.busy}
                disabled={state.code.trim().length === 0}
                onPress={onSubmitCode}
                fullWidth
              />
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
  if (!compact) return content;
  // Each provider has its own settings page, so its status and actions are the
  // page: they stay visible instead of waiting behind a disclosure tap.
  const bodyVisible =
    (ready && allowDisconnect) ||
    primaryButtonVisible ||
    loginBoxVisible ||
    Boolean(state.error ?? login?.message);
  return (
    <View style={styles.settingsCard}>
      <View style={styles.settingsCardHeader}>
        <View style={styles.settingsCardIcon}>
          <AgentProviderIcon provider={provider} size={22} color={theme.colors.action} />
        </View>
        <View style={styles.providerTitleGroup}>
          <Text style={styles.label} accessibilityRole="header">
            {title}
          </Text>
          <Text style={styles.providerCopy}>
            {ready
              ? subscriptionPlan !== null
                ? `${title} ${subscriptionPlan} subscription, connected to this Verity server.`
                : 'Subscription connected to this Verity server.'
              : 'Connect your ' + title + ' subscription to use it in sessions.'}
          </Text>
        </View>
        <StatusTag intent={ready ? 'ready' : 'optional'} label={statusText} />
      </View>
      {bodyVisible ? <View style={styles.settingsCardBody}>{content}</View> : null}
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
  // A button keeps the width of its label instead of spanning the column.
  inline: { flexDirection: 'row' },
  compactCard: { gap: theme.spacing.sm },
  settingsCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  settingsCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
  },
  settingsCardIcon: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  settingsCardBody: {
    padding: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  guidance: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  guidanceTitle: {
    ...theme.typography.row,
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
  },
  guidanceStep: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  card: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
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
    ...theme.typography.row,
    color: theme.colors.text,
  },
  providerCopy: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  loginBox: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.xs,
  },
  codeRow: {
    minHeight: 50,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  code: {
    ...theme.typography.title,
    color: theme.colors.text,
  },
  loginStep: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  loginStepActive: {
    borderColor: theme.colors.text,
    backgroundColor: theme.colors.surface,
  },
  stepBadge: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  stepBadgeActive: {
    borderColor: theme.colors.text,
    backgroundColor: theme.colors.action,
  },
  stepBadgeDone: {
    borderColor: theme.colors.success,
    backgroundColor: theme.colors.success,
  },
  stepBadgeLabel: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.onAction,
  },
  stepBadgeLabelMuted: { color: theme.colors.textFaint },
  stepBody: { flex: 1, gap: theme.spacing.sm },
  stepTitle: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.text,
  },
  stepTitlePending: { color: theme.colors.textFaint },
  stepDescription: {
    ...theme.typography.footnote,
    color: theme.colors.textMuted,
  },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  waitingText: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.textMuted,
  },
  error: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.attention,
  },
  success: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.success,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
  },
}));
