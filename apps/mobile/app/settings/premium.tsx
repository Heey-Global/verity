import { secretWritable, type UplinkDiagnostics, type VerityClient } from '@verity/mobile';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '../../components/Icon';
import { Toggle } from '../../components/Toggle';
import { Confetti } from '../../components/premium/Confetti';
import {
  CardRow,
  CardText,
  Eyebrow,
  IconTile,
  KeyField,
  PremiumCard,
  PremiumCta,
  StatusDot,
  Tag,
  TrailingValue,
  premiumChromeStyles as chrome,
} from '../../components/premium/PremiumChrome';
import { premiumFeatures } from '../../components/premium/premiumFeatures';
import { Button, ConfirmSheet } from '../../components/ui';
import { tint } from '../../components/ui/tint';
import {
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsScaffold,
} from '../../components/settings/SettingsChrome';
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
  const [rejection, setRejection] = useState<{ tag: string; sentence: string } | null>(null);
  const [confirming, setConfirming] = useState<
    'premiumSharingEnabled' | 'premiumRemoteAccessEnabled' | 'remove' | null
  >(null);
  // The sheet fades out after it closes; its wording stays until it is gone.
  const [asking, setAsking] = useState<NonNullable<typeof confirming>>('remove');
  const ask = (kind: NonNullable<typeof confirming>) => {
    setAsking(kind);
    setConfirming(kind);
  };
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
    setRejection(null);
    try {
      if ((await saveVeritySettings(client, { uplinkSubscriptionKey: key.trim() })) !== 'saved')
        return;
      if (!mounted.current || attempt !== generation.current) return;
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
        if (
          next.control === 'connected' ||
          (next.entitlement === 'checked' && next.control === 'idle')
        ) {
          setKey('');
          setMode('activated');
          if (Platform.OS !== 'web')
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
              () => undefined,
            );
          return;
        }
        if (next.control === 'rejected') {
          const rejected = rejectionFor(next.reason);
          setRejection(rejected);
          setMessage(rejected.sentence);
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
    // Turning a feature off ends what it is doing, so it is confirmed first.
    if (!enabled) ask(settingsKey);
    else void saveVeritySettings(client, { [settingsKey]: enabled }).then(() => refresh());
  };
  const confirmChange = async () => {
    if (confirming === 'remove') {
      const result = await saveVeritySettings(client, { uplinkSubscriptionKey: null });
      if (result === 'saved' && mounted.current) {
        setMode('default');
        setStatus(null);
        setMessage(null);
        setKey('');
      }
    } else if (confirming !== null) {
      await saveVeritySettings(client, { [confirming]: false });
      void refresh();
    }
    // A failed write is reported by the screen's error banner, which offers Retry.
    if (mounted.current) setConfirming(null);
  };
  const manage = configured && mode === 'default';
  if (settings === null && (loading || failed))
    return (
      <SettingsMessage
        screenTitle="Verity Premium"
        title={failed ? 'Could not load settings' : 'Loading…'}
        onRetry={failed ? retry : undefined}
      />
    );
  const busy = saving > 0 || !writable;
  const featureCard = (feature: (typeof premiumFeatures)[number], activated: boolean) => {
    if (feature.settingsKey === null) {
      return (
        <PremiumCard key={feature.id} soft>
          {activated ? null : <IconTile name={feature.icon} />}
          <CardText title={feature.name} subtitle={manage ? feature.description : feature.pitch} />
          <Tag label="Soon" />
        </PremiumCard>
      );
    }
    const enabled = settings?.[feature.settingsKey];
    if ((!manage && !activated) || enabled === undefined) {
      return (
        <PremiumCard key={feature.id}>
          <IconTile name={feature.icon} />
          <CardText title={feature.name} subtitle={feature.pitch} />
        </PremiumCard>
      );
    }
    const state = status?.features?.[feature.id];
    const notIncluded =
      (status?.control === 'connected' || status?.entitlement === 'checked') &&
      state?.granted === false;
    const subtitle = !enabled
      ? feature.offSubtitle
      : notIncluded
        ? 'Not included in your subscription'
        : activated
          ? 'Included in your subscription'
          : feature.description;
    const settingsKey = feature.settingsKey;
    return (
      <Pressable
        key={feature.id}
        style={({ pressed }) => [
          chrome.card,
          notIncluded ? chrome.soft : null,
          busy ? chrome.disabled : null,
          pressed ? chrome.pressed : null,
        ]}
        onPress={() => changeFeature(settingsKey, !enabled)}
        disabled={busy}
        accessibilityRole="switch"
        accessibilityLabel={feature.name}
        accessibilityState={{ checked: enabled, disabled: busy }}
      >
        <CardText title={feature.name} subtitle={subtitle} />
        <Toggle value={enabled} />
      </Pressable>
    );
  };
  // Uplink connects only while a feature needs it (#1519): an idle control
  // channel with checked rights is as active as a connected one.
  const connection =
    status?.control === 'idle' && status.entitlement === 'checked' ? 'onDemand' : status?.control;
  const active = connection === 'connected' || connection === 'onDemand';
  const sharingOff = settings?.premiumSharingEnabled === false;
  const remoteOff = settings?.premiumRemoteAccessEnabled === false;
  const footer =
    mode === 'activated' ? (
      <PremiumCta label="Continue" ghost onPress={() => setMode('default')} />
    ) : mode === 'entry' ? (
      <PremiumCta
        label={checking ? 'Checking with Uplink…' : 'Activate'}
        busy={checking}
        disabled={!writable || !key.trim()}
        onPress={() => void activate()}
      />
    ) : !configured ? (
      <PremiumCta
        label="Enter subscription key"
        icon="key"
        disabled={loading || failed}
        onPress={() => {
          setMode('entry');
          setMessage(null);
        }}
      />
    ) : undefined;
  return (
    <SettingsScaffold title="Verity Premium" detail onRetry={retry} footer={footer}>
      {mode === 'activated' ? (
        <>
          <Confetti />
          <View style={styles.hero}>
            <View style={styles.check}>
              <Icon name="check" size={40} color={theme.colors.signature} />
            </View>
            <Text style={styles.heroTitle}>Premium is active</Text>
            <Text style={styles.heroLead}>
              Your server is connected to Verity Uplink.
              {'\n'}
              {activatedSummary(status)}
            </Text>
          </View>
          <View style={styles.stack}>
            {premiumFeatures
              .filter((feature) => feature.settingsKey !== null)
              .map((feature) => featureCard(feature, true))}
          </View>
        </>
      ) : mode === 'entry' ? (
        <View style={styles.stack}>
          <Eyebrow>Subscription key</Eyebrow>
          <KeyField
            value={key}
            onChangeText={(value) => {
              setKey(value);
              setRejection(null);
              setMessage(null);
            }}
            editable={writable && !checking}
            error={
              rejection !== null ? { title: rejection.tag, message: rejection.sentence } : undefined
            }
            onSubmit={() => {
              // Same gate as the Activate button: Return on an empty field must
              // never overwrite a stored key.
              if (writable && key.trim()) void activate();
            }}
          />
          {/* A rejection is explained by the field's hint box; repeating its
              sentence here would say it twice. */}
          {rejection === null ? (
            <Text
              style={[styles.help, message ? styles.error : null]}
              accessibilityRole={message ? 'alert' : undefined}
            >
              {message ??
                'From your Verity account. Stored encrypted on your server, never shown again.'}
            </Text>
          ) : null}
          <View style={styles.inline}>
            <Button
              label="Cancel"
              variant="text"
              disabled={checking}
              onPress={() => {
                setMode('default');
                setKey('');
                setMessage(null);
                setRejection(null);
              }}
            />
          </View>
        </View>
      ) : !configured ? (
        <>
          <View style={styles.intro}>
            <Text style={styles.headline}>
              Your server,{'\n'}
              <Text style={styles.accent}>reachable anywhere.</Text>
            </Text>
            <Text style={styles.lead}>Premium connects your server to Verity Uplink.</Text>
          </View>
          <View style={styles.stack}>
            <Eyebrow>What you get</Eyebrow>
            {premiumFeatures.map((feature) => featureCard(feature, false))}
          </View>
        </>
      ) : (
        <>
          <View style={styles.stack}>
            <PremiumCard selected>
              <IconTile name="zap" accent />
              <CardText
                title="Subscription"
                subtitle={
                  connection === 'connected'
                    ? 'Connected to Uplink'
                    : connection === 'onDemand'
                      ? 'Connects when a feature is in use'
                      : connection === 'disabled'
                        ? 'Uplink is disabled on this server'
                        : connection === 'idle'
                          ? 'Checked when a feature is first used'
                          : connection === 'rejected'
                            ? rejectionFor(status?.reason).sentence
                            : 'Waiting for Uplink'
                }
              />
              <Tag
                label={
                  active
                    ? 'Active'
                    : connection === 'idle'
                      ? 'Idle'
                      : connection === 'disabled'
                        ? 'Disabled'
                        : connection === 'rejected'
                          ? 'Rejected'
                          : 'Connecting'
                }
                tone={active ? 'ok' : connection === 'rejected' ? 'error' : 'neutral'}
              />
            </PremiumCard>
            <CardRow
              title="Subscription key"
              subtitle="Stored encrypted on your server"
              trailing={<TrailingValue>Replace</TrailingValue>}
              accessibilityLabel="Replace subscription key"
              disabled={busy}
              onPress={() => {
                setMode('entry');
                setMessage(null);
                setRejection(null);
              }}
            />
          </View>
          <View style={styles.stack}>
            <Eyebrow>Features</Eyebrow>
            {premiumFeatures.map((feature) => featureCard(feature, false))}
          </View>
          <View style={styles.stack}>
            <Eyebrow>Diagnostics</Eyebrow>
            <PremiumCard
              accessibilityLabel="Connection diagnostics"
              onPress={() => router.push('/settings/diagnostics')}
            >
              <IconTile name="activity" />
              <CardText
                title="Connection"
                subtitle={
                  active
                    ? `${connection === 'connected' ? 'Uplink connected' : 'Uplink on demand'} · ${featureSummary(status)}`
                    : connection === 'idle'
                      ? 'Uplink idle · rights not checked yet'
                      : connection === 'disabled'
                        ? 'Uplink disabled on this server'
                        : connection === 'rejected'
                          ? 'Subscription key rejected'
                          : 'Waiting for Uplink'
                }
              />
              <StatusDot tone={active ? 'ok' : connection === 'rejected' ? 'error' : 'off'} />
              <Icon name="chevron-right" size={16} color={theme.colors.textMuted} />
            </PremiumCard>
          </View>
          <View style={styles.inline}>
            <Button
              label="Remove subscription key"
              variant="text"
              disabled={busy}
              onPress={() => ask('remove')}
            />
          </View>
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
      <ConfirmSheet
        visible={confirming !== null}
        title={
          asking === 'remove'
            ? 'Remove subscription key?'
            : asking === 'premiumSharingEnabled'
              ? 'Turn off Online sharing?'
              : 'Turn off Remote access?'
        }
        message={
          asking === 'remove'
            ? 'Online sharing and Remote access will stop. Active public links will be revoked.'
            : asking === 'premiumSharingEnabled'
              ? 'Active public links will be revoked.'
              : 'Open remote connections will end. Reconnect through your local network or VPN to manage this server.'
        }
        confirmLabel={asking === 'remove' ? 'Remove key' : 'Turn off'}
        destructive
        onConfirm={confirmChange}
        onCancel={() => setConfirming(null)}
      />
    </SettingsScaffold>
  );
}

function rejectionFor(reason: UplinkDiagnostics['reason']): { tag: string; sentence: string } {
  if (reason === 'expired')
    return { tag: 'Expired', sentence: 'This key has expired. Renew it in your account.' };
  if (reason === 'revoked')
    return { tag: 'Revoked', sentence: 'This key was revoked. Check it in your account.' };
  return {
    tag: 'Unknown',
    sentence: 'This key is not known to Verity Uplink. Check it in your account.',
  };
}

/** Whether a feature works now. While the control channel idles (#1519) only
 * Online sharing dials Uplink on demand, so a granted share counts as on;
 * Remote access keeps the channel up while usable, so idle means it is not.
 * A Core that predates `features` reports readiness in the top-level fields. */
function featureOn(status: UplinkDiagnostics | null, id: 'sharing' | 'remoteAccess'): boolean {
  if (status?.features === undefined) {
    return id === 'sharing' ? status?.sharing === 'ready' : status?.remoteControl === 'ready';
  }
  const state = status.features[id] as (typeof status.features)[typeof id] | undefined;
  if (state === undefined) {
    return id === 'sharing' ? status.sharing === 'ready' : status.remoteControl === 'ready';
  }
  if (state.enabled === false) return false;
  if (state.effective) return true;
  return (
    id === 'sharing' &&
    state.granted &&
    status.control === 'idle' &&
    status.entitlement === 'checked'
  );
}

function activatedSummary(status: UplinkDiagnostics | null): string {
  const sharing = featureOn(status, 'sharing');
  const remote = featureOn(status, 'remoteAccess');
  if (sharing && remote) return 'Online sharing and remote access are on.';
  if (sharing) return 'Online sharing is on.';
  if (remote) return 'Remote access is on.';
  return 'Your features turn on as soon as Uplink confirms them.';
}

/** "all features on", or which feature is off — switched off or not included. */
function featureSummary(status: UplinkDiagnostics | null): string {
  const off = premiumFeatures
    .filter((feature) => feature.settingsKey !== null)
    .filter((feature) => !featureOn(status, feature.id as 'sharing' | 'remoteAccess'))
    .map((feature) => feature.name.toLowerCase());
  if (off.length === 0) return 'all features on';
  return off.length > 1 ? 'features off' : `${off[0]} off`;
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing.sm },
  intro: { gap: theme.spacing.sm, paddingTop: theme.spacing.md },
  headline: { ...theme.typography.display, color: theme.colors.text },
  accent: { color: theme.colors.signature },
  lead: { ...theme.typography.body, color: theme.colors.textMuted },
  error: { color: theme.colors.attention },
  help: { ...theme.typography.subtitle, color: theme.colors.textMuted },
  // A text button keeps the width of its label instead of spanning the column.
  inline: { flexDirection: 'row' },
  hero: {
    alignItems: 'center',
    gap: 10,
    paddingTop: 34,
    paddingBottom: theme.spacing.md,
  },
  check: {
    width: 84,
    height: 84,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: tint(theme.colors.signature, 'border'),
    backgroundColor: tint(theme.colors.signature, 'fill'),
    shadowColor: theme.colors.signature,
    shadowOpacity: 0.35,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 0 },
  },
  heroTitle: { ...theme.typography.display, color: theme.colors.text },
  heroLead: { ...theme.typography.body, color: theme.colors.textMuted, textAlign: 'center' },
}));
