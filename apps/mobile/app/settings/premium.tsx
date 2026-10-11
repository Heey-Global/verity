import { secretWritable, type UplinkDiagnostics, type VerityClient } from '@verity/mobile';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../components/Icon';
import { StatusPill } from '../../components/StatusPill';
import { Confetti } from '../../components/premium/Confetti';
import { PremiumBadge } from '../../components/premium/PremiumBadge';
import { premiumFeatures } from '../../components/premium/premiumFeatures';
import {
  SecretPasteField,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsPanel,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { settingsStyles } from '../../components/settings/settingsStyles';
import { createVerityClient } from '../../lib/client';
import {
  saveVeritySettings,
  retryFailedVeritySettings,
  useLoadVeritySettings,
  useVeritySettings,
} from '../../lib/settingsStore';

export default function PremiumScreen() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? <PremiumSettings client={client} /> : <SettingsMessage title="Not connected" />;
}

export function PremiumSettings({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const reload = useLoadVeritySettings(client);
  const { settings, secretStatus, saving, failed, loading } = useVeritySettings();
  const [mode, setMode] = useState<'default' | 'entry' | 'activated'>('default');
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<UplinkDiagnostics | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await client.getUplinkDiagnostics();
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setStatus(null);
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const retry = () => {
    void retryFailedVeritySettings(client).then((retried) => {
      if (!retried) void reload();
    });
  };
  const configured = settings?.uplinkSubscriptionKeyConfigured === true;
  const writable = secretStatus !== undefined && secretWritable(secretStatus);
  const activate = async () => {
    if (checking || !writable || !key.trim()) return;
    const attempt = ++generation.current;
    setChecking(true);
    setMessage(null);
    try {
      if ((await saveVeritySettings(client, { uplinkSubscriptionKey: key.trim() })) !== 'saved')
        return;
      if (!mounted.current || attempt !== generation.current) return;
      setKey('');
      // A stored key is not proof of activation. Only a fresh Uplink welcome is.
      for (let tries = 0; tries < 15; tries += 1) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          client.getUplinkDiagnostics(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Activation check timed out')), 5000);
          }),
        ]).finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
        });
        if (!mounted.current || attempt !== generation.current) return;
        setStatus(next);
        if (next.control === 'connected') {
          setMode('activated');
          if (Platform.OS !== 'web')
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
              () => undefined,
            );
          return;
        }
        if (next.control === 'rejected') {
          setMessage(
            next.reason === 'expired'
              ? 'This subscription key has expired.'
              : next.reason === 'revoked'
                ? 'This subscription key was revoked.'
                : 'This subscription key was not recognized.',
          );
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
      setMessage('Uplink has not confirmed the key yet. Check Diagnostics or try again.');
    } catch {
      if (mounted.current)
        setMessage('Could not confirm activation. Check your connection and try again.');
    } finally {
      if (mounted.current && attempt === generation.current) setChecking(false);
    }
  };
  const changeFeature = (
    settingsKey: 'premiumSharingEnabled' | 'premiumRemoteAccessEnabled',
    enabled: boolean,
  ) => {
    const save = () => {
      void saveVeritySettings(client, { [settingsKey]: enabled }).then(() => refresh());
    };
    if (!enabled) {
      Alert.alert(
        settingsKey === 'premiumSharingEnabled'
          ? 'Turn off Online sharing?'
          : 'Turn off Remote access?',
        settingsKey === 'premiumSharingEnabled'
          ? 'Active public links will be revoked.'
          : 'Open remote connections will end. Reconnect through your local network or VPN to manage this server.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Turn off', style: 'destructive', onPress: save },
        ],
      );
    } else save();
  };
  const remove = () =>
    Alert.alert(
      'Remove subscription key?',
      'Online sharing and Remote access will stop. Active public links will be revoked.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void saveVeritySettings(client, { uplinkSubscriptionKey: null }).then((result) => {
              if (result === 'saved' && mounted.current) {
                setMode('default');
                setStatus(null);
                setMessage(null);
                setKey('');
              }
            });
          },
        },
      ],
    );
  const action = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.cta, disabled ? settingsStyles.buttonDisabled : null]}
    >
      {checking ? <ActivityIndicator color={theme.colors.onPrimary} /> : null}
      <Text style={settingsStyles.primaryButtonLabel}>{label}</Text>
    </Pressable>
  );
  const manage = configured && mode === 'default';
  if (settings === null && (loading || failed))
    return (
      <SettingsMessage
        screenTitle="Verity Premium"
        title={failed ? 'Could not load settings' : 'Loading…'}
        onRetry={failed ? retry : undefined}
      />
    );
  return (
    <SettingsScaffold title="Verity Premium" detail onRetry={retry}>
      {mode === 'activated' ? (
        <>
          <Confetti />
          <View style={styles.hero}>
            <Icon name="check-circle" size={48} color={theme.colors.accent} />
            <Text style={styles.headline}>Premium is active</Text>
            <Text style={styles.lead}>Your server, connected.</Text>
          </View>
        </>
      ) : !manage && mode !== 'entry' ? (
        <View style={styles.hero}>
          <Text style={styles.headline}>Your server,</Text>
          <Text style={[styles.headline, styles.accent]}>reachable anywhere.</Text>
          <Text style={styles.lead}>Unlock more with Verity Premium.</Text>
        </View>
      ) : null}
      {mode === 'entry' ? (
        <SettingsPanel>
          <Text style={styles.eyebrow}>ACTIVATE PREMIUM</Text>
          <SecretPasteField
            label="Uplink subscription key"
            placeholder="Paste your subscription key"
            value={key}
            onChangeText={setKey}
            configured={configured}
            editable={writable && !checking}
            onBlur={() => {}}
            masked
          />
          <Text style={styles.lead}>Stored encrypted. Never shown again.</Text>
          {message ? (
            <Text style={settingsStyles.fieldError} accessibilityRole="alert">
              {message}
            </Text>
          ) : null}
          {action(
            checking ? 'Checking with Uplink…' : 'Activate',
            () => void activate(),
            checking || !writable || !key.trim(),
          )}
          <Pressable
            accessibilityRole="button"
            disabled={checking}
            onPress={() => {
              setMode('default');
              setKey('');
            }}
          >
            <Text style={settingsStyles.linkText}>Back</Text>
          </Pressable>
        </SettingsPanel>
      ) : (
        <>
          {manage ? (
            <SettingsPanel>
              <View style={styles.row}>
                <Text style={styles.title}>Subscription</Text>
                <PremiumBadge />
              </View>
              <StatusPill
                intent={
                  status?.control === 'connected'
                    ? 'ready'
                    : status?.control === 'rejected'
                      ? 'needsSetup'
                      : 'transient'
                }
                label={
                  status?.control === 'connected'
                    ? 'Active'
                    : status?.control === 'rejected'
                      ? 'Key rejected'
                      : 'Awaiting connection'
                }
              />
              <Pressable
                accessibilityRole="button"
                disabled={!writable || saving > 0}
                onPress={() => {
                  setMode('entry');
                  setMessage(null);
                }}
              >
                <Text style={settingsStyles.linkText}>Replace subscription key</Text>
              </Pressable>
            </SettingsPanel>
          ) : (
            <Text style={styles.eyebrow}>WHAT YOU GET</Text>
          )}
          {premiumFeatures.map((feature) => (
            <SettingsPanel key={feature.id}>
              {manage &&
              feature.settingsKey !== null &&
              settings?.[feature.settingsKey] !== undefined ? (
                <SettingsToggleRow
                  label={feature.name}
                  subtitle={feature.description}
                  icon={<Icon name={feature.icon} size={20} color={theme.colors.primary} />}
                  value={settings?.[feature.settingsKey] === true}
                  disabled={saving > 0 || !writable}
                  onValueChange={(enabled) => changeFeature(feature.settingsKey, enabled)}
                />
              ) : (
                <View style={styles.row}>
                  <Icon
                    name={feature.icon}
                    size={20}
                    color={feature.id === 'teams' ? theme.colors.textFaint : theme.colors.primary}
                  />
                  <View style={styles.body}>
                    <Text style={styles.title}>{feature.name}</Text>
                    <Text style={styles.lead}>{feature.description}</Text>
                  </View>
                  {feature.id === 'teams' ? <Text style={styles.lead}>Coming soon</Text> : null}
                </View>
              )}
              {manage && feature.settingsKey !== null ? (
                <>
                  <Text style={styles.lead}>
                    {status?.features?.[feature.id]?.enabled === false
                      ? 'Off'
                      : status?.control === 'connected' &&
                          status.features?.[feature.id]?.granted === false
                        ? 'Not included in your subscription'
                        : status?.features?.[feature.id]?.effective
                          ? 'Ready'
                          : 'Waiting for Uplink'}
                  </Text>
                </>
              ) : null}
            </SettingsPanel>
          ))}
          {mode === 'activated' ? (
            action('Continue', () => setMode('default'))
          ) : !manage ? (
            action(
              'Enter subscription key',
              () => {
                setMode('entry');
                setMessage(null);
              },
              loading || failed,
            )
          ) : (
            <>
              <SettingsListPanel>
                <SettingsNavRow
                  icon="activity"
                  title="Diagnostics"
                  subtitle="Connection status and tests"
                  onPress={() => router.push('/settings/diagnostics')}
                />
              </SettingsListPanel>
              <Pressable
                accessibilityRole="button"
                disabled={!writable || saving > 0}
                onPress={remove}
              >
                <Text style={styles.danger}>Remove subscription key</Text>
              </Pressable>
            </>
          )}
        </>
      )}
      {!writable && secretStatus !== undefined ? (
        <SettingsListPanel>
          <SettingsNavRow
            icon="lock"
            title="Unlock the secret store"
            onPress={() => router.push('/settings/secret-store')}
          />
        </SettingsListPanel>
      ) : null}
    </SettingsScaffold>
  );
}
const styles = StyleSheet.create((theme) => ({
  hero: { paddingVertical: theme.spacing.xl, gap: theme.spacing.sm },
  headline: { fontSize: theme.text.xl, fontWeight: '600', color: theme.colors.text },
  accent: { color: theme.colors.accent },
  eyebrow: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '600',
    letterSpacing: 1,
  },
  title: { color: theme.colors.text, fontSize: theme.text.md, fontWeight: '600' },
  lead: { color: theme.colors.textMuted, fontSize: theme.text.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  body: { flex: 1, gap: theme.spacing.xs },
  cta: {
    minHeight: 48,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  danger: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    paddingVertical: theme.spacing.md,
  },
}));
