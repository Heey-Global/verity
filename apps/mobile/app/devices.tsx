// Devices & Web Browsers: the paired phones, tablets, Macs and browsers that
// hold access to this server, plus the pairing link that adds one more.
//
// Reached from Settings and dressed in the same chrome as the screens under
// /settings: the scaffold, grouped sections and list rows all come from
// SettingsChrome, so this route does not drift into a look of its own. Errors
// go through the shared settings store for the same reason — one banner, one
// Retry, wherever the operator happens to be standing.
import type { PairedDevice, VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '../components/Icon';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsPanel,
  SettingsScaffold,
} from '../components/settings/SettingsChrome';
import { settingsStyles as styles } from '../components/settings/settingsStyles';
import { StatusPill } from '../components/StatusPill';
import { createVerityClient } from '../lib/client';
import { deviceActivityLabel } from '../lib/deviceActivity';
import { createPairingUri } from '../lib/pairing';
import { getBrowserSession, logoutBrowser } from '../lib/browserSession';
import { getServerProfile } from '../lib/serverProfile';
import { setVeritySettingsError } from '../lib/settingsStore';

/** Pick the row glyph from the label the device reported when it paired. */
function iconForDevice(label: string | null): IconName {
  if (label === null) return 'smartphone';
  if (/browser|safari|\bchrome\b|firefox|\bedge\b/iu.test(label)) return 'globe';
  if (/ipad|tablet/iu.test(label)) return 'tablet';
  if (/mac|desktop|laptop/iu.test(label)) return 'monitor';
  return 'smartphone';
}

type RenameOutcome = 'submitted' | 'pending' | 'noop';

type AccessTab = 'app' | 'browser';
const ACCESS_TABS: readonly { id: AccessTab; label: string; icon: IconName }[] = [
  { id: 'app', label: 'App', icon: 'smartphone' },
  { id: 'browser', label: 'Web Browser', icon: 'globe' },
];

/** The browser client is served under `/app/` on the same origin as the API. */
function webAppAddress(base: string): string {
  return `${base.replace(/\/+$/u, '')}/app/`;
}

export default function DevicesScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage devices and web browsers."
        screenTitle="Devices & Web Browsers"
      />
    );
  }
  return <DevicesView client={client} />;
}

function DevicesView({ client }: { client: VerityClient }) {
  const { theme } = useUnistyles();
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pairingInvitation, setPairingInvitation] = useState<{
    link: string;
    expiresAt: number;
    minutes: number;
    webAddress: string;
  } | null>(null);
  // A browser is most likely inviting another browser; the app most likely
  // another device of its own kind.
  const [tab, setTab] = useState<AccessTab>(Platform.OS === 'web' ? 'browser' : 'app');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const renameQueues = useRef(new Map<string, Promise<void>>());
  const renameTargets = useRef(new Map<string, string>());

  const refresh = useCallback((): Promise<void> => {
    setLoading(true);
    setVeritySettingsError(undefined);
    return client
      .listPairedDevices()
      .then(setDevices)
      .catch((caught: unknown) =>
        setVeritySettingsError(
          caught instanceof Error ? caught.message : 'Could not load paired devices.',
        ),
      )
      .finally(() => setLoading(false));
  }, [client]);
  const load = useCallback((): void => {
    void refresh();
  }, [refresh]);
  useFocusEffect(load);

  useEffect(() => {
    for (const device of devices) {
      if (renameTargets.current.get(device.id) === (device.label ?? '')) {
        renameTargets.current.delete(device.id);
      }
    }
  }, [devices]);

  useEffect(() => {
    if (pairingInvitation === null) return;
    const remaining = pairingInvitation.expiresAt - Date.now();
    if (remaining <= 0) {
      setPairingInvitation(null);
      return;
    }
    const timeout = setTimeout(() => setPairingInvitation(null), remaining);
    return () => clearTimeout(timeout);
  }, [pairingInvitation]);

  // `auto` is the link the screen creates on its own when it opens: a server
  // that cannot be invited to stays quiet then, and only an explicit tap on
  // the fallback button explains why.
  const createInvitation = (auto = false): void => {
    const browserSession = Platform.OS === 'web' ? getBrowserSession() : null;
    const profile = browserSession
      ? {
          serverId: browserSession.serverId,
          identityKey: browserSession.identityKey,
          activeUrl: window.location.origin,
          endpoints: [
            {
              url: window.location.origin,
              transport: 'direct' as const,
              tlsPin: browserSession.tlsPin,
            },
          ],
        }
      : getServerProfile();
    const direct =
      profile?.endpoints.find(
        (endpoint) =>
          endpoint.url === profile.activeUrl && endpoint.transport === 'direct' && endpoint.tlsPin,
      ) ??
      profile?.endpoints.find((endpoint) => endpoint.transport === 'direct' && endpoint.tlsPin);
    if (
      Platform.OS !== 'web' &&
      (profile === null || profile === undefined || direct?.tlsPin === undefined)
    ) {
      if (!auto) {
        setVeritySettingsError(
          'A directly paired server profile is required to add another device.',
        );
      }
      return;
    }
    setWorking(true);
    setVeritySettingsError(undefined);
    void client
      .createPairingInvitation()
      .then((invitation) => {
        const expiresAt = Date.parse(invitation.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          throw new Error('The server returned an expired pairing code.');
        }
        setPairingInvitation({
          link:
            Platform.OS === 'web' && direct?.tlsPin === undefined
              ? invitation.code
              : createPairingUri({
                  version: 1,
                  kind: 'device',
                  serverId: profile!.serverId,
                  identityKey: profile!.identityKey,
                  tlsPin: direct!.tlsPin!,
                  pairingCode: invitation.code,
                  suggestedUrl: direct!.url,
                  expiresAt: invitation.expiresAt,
                }),
          expiresAt,
          minutes: Math.max(1, Math.round((expiresAt - Date.now()) / 60_000)),
          // The same endpoint the link names, so the sign-in page's identity
          // check runs against the server the browser was sent to.
          webAddress: webAppAddress(
            direct?.url ?? (Platform.OS === 'web' ? window.location.origin : profile!.activeUrl),
          ),
        });
      })
      .catch((caught: unknown) =>
        setVeritySettingsError(
          caught instanceof Error ? caught.message : 'Could not create a pairing code.',
        ),
      )
      .finally(() => setWorking(false));
  };

  // Commit on blur, like every other field in Settings. The typed name is held
  // in the row until then, and stays in the field if the server refuses it, so
  // the operator can correct a name rather than retype it — the banner is what
  // says it did not land. The list reloads either way: on success so the row's
  // icon and Remove label follow the new name, on failure so the rest of the row
  // still reflects the server.
  const rename = (device: PairedDevice, label: string): RenameOutcome => {
    const next = label.trim();
    if (next === '') return 'noop';
    const pending = renameTargets.current.get(device.id);
    if (next === pending) return 'pending';
    if (pending === undefined && next === (device.label ?? '')) return 'noop';
    renameTargets.current.set(device.id, next);
    const save = async (): Promise<void> => {
      setVeritySettingsError(undefined);
      try {
        await client.renamePairedDevice(device.id, next);
        await refresh();
      } catch (caught: unknown) {
        // Reload BEFORE reporting, never after: load() clears the banner as it
        // starts, so an error raised first would be wiped by its own reload and
        // the row would snap back to the old name with nothing to explain why.
        load();
        if (renameTargets.current.get(device.id) === next) {
          renameTargets.current.delete(device.id);
        }
        setVeritySettingsError(
          caught instanceof Error ? caught.message : 'Could not rename the device.',
        );
      }
    };
    // Keep saves for one device in submission order. Two quick blurs may overlap
    // on the network; allowing the older request to finish last would restore an
    // obsolete name in the database even though the field shows the newer one.
    const queued = (renameQueues.current.get(device.id) ?? Promise.resolve()).then(save);
    renameQueues.current.set(device.id, queued);
    void queued.finally(() => {
      if (renameQueues.current.get(device.id) === queued) {
        renameQueues.current.delete(device.id);
      }
    });
    return 'submitted';
  };

  const revoke = (device: PairedDevice): void => {
    Alert.alert(
      'Remove paired device?',
      device.label ?? 'This device will lose access to Verity.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setWorking(true);
            setVeritySettingsError(undefined);
            void client
              .revokePairedDevice(device.id)
              .then(load)
              .catch((caught: unknown) =>
                setVeritySettingsError(
                  caught instanceof Error ? caught.message : 'Could not remove the device.',
                ),
              )
              .finally(() => setWorking(false));
          },
        },
      ],
    );
  };

  // The link is what this screen is opened for, so it is there without a tap.
  // Once per visit: every invitation is a one-time code on the server.
  const autoCreated = useRef(false);
  useEffect(() => {
    if (autoCreated.current) return;
    autoCreated.current = true;
    createInvitation(true);
  });

  // Inside a browser without a pinned server profile the invitation is the
  // bare code, which the browser sign-in accepts as well but the app does not.
  const invitationIsLink = pairingInvitation?.link.startsWith('verity:') ?? false;

  return (
    <SettingsScaffold title="Devices & Web Browsers" detail onRetry={load}>
      {Platform.OS === 'web' && (
        <SettingsGroup title="This browser">
          <SettingsPanel>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              onPress={() => {
                void logoutBrowser()
                  .then(() => router.replace('/web-connect'))
                  .catch((caught: unknown) =>
                    setVeritySettingsError(
                      caught instanceof Error ? caught.message : 'Could not sign out.',
                    ),
                  );
              }}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonLabel}>Sign out</Text>
            </Pressable>
          </SettingsPanel>
        </SettingsGroup>
      )}
      <SettingsGroup title="Add access">
        <View style={styles.accessCard}>
          <View style={styles.accessTabs} accessibilityRole="tablist">
            {ACCESS_TABS.map((option) => {
              const selected = option.id === tab;
              return (
                <Pressable
                  key={option.id}
                  style={[styles.accessTab, selected ? styles.accessTabSelected : null]}
                  onPress={() => setTab(option.id)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option.label}
                >
                  <Icon
                    name={option.icon}
                    size={15}
                    color={selected ? theme.colors.text : theme.colors.textMuted}
                  />
                  <Text
                    style={[styles.accessTabLabel, selected ? styles.accessTabLabelSelected : null]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <InvitationBoundary onReset={() => setPairingInvitation(null)}>
            {pairingInvitation ? (
              <>
                {tab === 'app' && !invitationIsLink ? (
                  // A bare code carries no server identity, which the app needs
                  // before it trusts a server; only a browser can redeem it.
                  <Text style={styles.footnote}>
                    The Verity app needs a pairing link. Create it in the app on a device that is
                    already paired.
                  </Text>
                ) : tab === 'app' ? (
                  <View style={styles.qrFrame}>
                    <QRCode
                      value={pairingInvitation.link}
                      size={200}
                      backgroundColor="#ffffff"
                      color="#000000"
                    />
                  </View>
                ) : (
                  <CopyField
                    label="Web address"
                    value={pairingInvitation.webAddress}
                    action="Open"
                    icon="external-link"
                    onPress={() =>
                      void Linking.openURL(pairingInvitation.webAddress).catch(() =>
                        setVeritySettingsError('Could not open the web address.'),
                      )
                    }
                    accessibilityLabel="Open web address"
                  />
                )}
                {tab === 'app' && !invitationIsLink ? null : (
                  <CopyField
                    label={invitationIsLink ? 'Pairing link' : 'Pairing code'}
                    value={pairingInvitation.link}
                    mono
                    action="Copy"
                    icon="copy"
                    onPress={() => void Clipboard.setStringAsync(pairingInvitation.link)}
                    accessibilityLabel={
                      invitationIsLink ? 'Copy pairing link' : 'Copy pairing code'
                    }
                  />
                )}
                <View style={styles.invitationHint}>
                  <Text style={styles.footnote}>
                    Valid for {pairingInvitation.minutes} minute
                    {pairingInvitation.minutes === 1 ? '' : 's'} · works once ·
                  </Text>
                  <Pressable
                    onPress={() => createInvitation()}
                    disabled={working}
                    style={working ? styles.buttonDisabled : null}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: working }}
                    accessibilityLabel="Create a new pairing link"
                  >
                    <Text style={styles.linkText}>{working ? 'Creating…' : 'New link'}</Text>
                  </Pressable>
                </View>
              </>
            ) : working ? (
              <ActivityIndicator color={theme.colors.primary} />
            ) : (
              <Pressable
                style={({ pressed }) => [
                  styles.primaryButton,
                  styles.selfStart,
                  working ? styles.buttonDisabled : null,
                  pressed ? styles.pressed : null,
                ]}
                onPress={() => createInvitation()}
                disabled={working}
                accessibilityRole="button"
                accessibilityState={{ disabled: working }}
                accessibilityLabel="Create pairing link"
              >
                <Text style={styles.primaryButtonLabel}>Create pairing link</Text>
              </Pressable>
            )}
          </InvitationBoundary>
        </View>
      </SettingsGroup>

      <SettingsGroup title="Connected">
        {loading && devices.length === 0 ? (
          <SettingsPanel>
            <ActivityIndicator color={theme.colors.primary} />
          </SettingsPanel>
        ) : (
          <SettingsListPanel>
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onRename={(label) => rename(device, label)}
                onRemove={() => revoke(device)}
              />
            ))}
          </SettingsListPanel>
        )}
        <Text style={styles.groupFootnote}>
          Tap a name to rename it. Removing signs the device or browser out immediately; it needs a
          new pairing link to come back.
        </Text>
      </SettingsGroup>
    </SettingsScaffold>
  );
}

function DeviceRow({
  device,
  onRename,
  onRemove,
}: {
  device: PairedDevice;
  onRename: (label: string) => RenameOutcome;
  onRemove: () => void;
}): ReactElement {
  const { theme } = useUnistyles();
  const stored = device.label ?? '';
  const [draft, setDraft] = useState(stored);
  const [focused, setFocused] = useState(false);
  const submitted = useRef<string | null>(null);
  // A reload after a rename, or another device renaming this one, replaces the
  // stored name under a field the operator is not currently typing in. Keying
  // the draft to the stored value adopts that rather than pinning a stale one.
  const [adopted, setAdopted] = useState(stored);
  if (adopted !== stored) {
    setAdopted(stored);
    const hasNewerSubmission = submitted.current !== null && submitted.current !== stored;
    if (!focused && !hasNewerSubmission) setDraft(stored);
    if (submitted.current === stored) submitted.current = null;
  }
  const activity = deviceActivityLabel(device);
  const icon = iconForDevice(device.label);
  const kind = icon === 'globe' ? 'Web Browser' : 'App';
  return (
    <View style={styles.navRow}>
      <View style={styles.navRowIcon}>
        <Icon name={icon} size={18} color={theme.colors.primary} />
      </View>
      <View style={styles.navRowBody}>
        <View style={styles.deviceNameRow}>
          <TextInput
            style={styles.deviceNameInput}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            // A draft that trims to nothing, or to the name already stored, commits
            // nothing — so put the field back rather than leave a blank or a
            // padded copy standing in as the row's apparent name.
            onBlur={() => {
              setFocused(false);
              const next = draft.trim();
              submitted.current = onRename(draft) === 'noop' ? null : next;
              if (next === '' || next === stored) setDraft(stored);
            }}
            placeholder="Verity device"
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            maxLength={100}
            accessibilityLabel={`Rename ${stored === '' ? 'paired device' : stored}`}
          />
          {device.isCurrent ? <StatusPill quiet intent="ready" label="This device" /> : null}
        </View>
        <Text style={styles.navRowSubtitle}>
          {activity !== undefined ? `${kind} · ${activity}` : kind}
        </Text>
      </View>
      {device.isCurrent ? null : (
        <View style={styles.navRowTrailing}>
          <Pressable
            style={({ pressed }) => [styles.quietDangerButton, pressed ? styles.pressed : null]}
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${device.label ?? 'paired device'}`}
          >
            <Text style={styles.dangerButtonLabel}>Remove</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function CopyField({
  label,
  value,
  mono = false,
  action,
  icon,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  value: string;
  mono?: boolean;
  action: string;
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
}): ReactElement {
  const { theme } = useUnistyles();
  return (
    <View style={styles.copyField}>
      <Text style={styles.copyFieldLabel}>{label}</Text>
      <View style={styles.copyFieldBox}>
        <Text style={[styles.copyFieldValue, mono ? styles.monoText : null]} numberOfLines={1}>
          {value}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.copyFieldButton, pressed ? styles.pressed : null]}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <Icon name={icon} size={14} color={theme.colors.primary} />
          <Text style={styles.copyFieldButtonLabel}>{action}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Keeps a failure to draw the pairing link inside the card. Without it a render
 * error here is fatal to the whole app on iOS; with it the operator sees the
 * message and can try a fresh link.
 */
class InvitationBoundary extends Component<
  { onReset: () => void; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(caught: unknown): { error: string } {
    return { error: caught instanceof Error ? caught.message : String(caught) };
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <View style={styles.invitationHint}>
        <Text style={styles.footnote}>Could not show the pairing link: {this.state.error}</Text>
        <Pressable
          onPress={() => {
            this.setState({ error: null });
            this.props.onReset();
          }}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <Text style={styles.linkText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
