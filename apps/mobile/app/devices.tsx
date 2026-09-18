// Devices: the paired phones, tablets and Macs that hold a bearer token for
// this server, plus the pairing code that adds one more.
//
// Reached from Settings and dressed in the same chrome as the screens under
// /settings: the scaffold, grouped sections and list rows all come from
// SettingsChrome, so this route does not drift into a look of its own. Errors
// go through the shared settings store for the same reason — one banner, one
// Retry, wherever the operator happens to be standing.
import type { PairedDevice, VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from 'react-native';
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
import { getServerProfile } from '../lib/serverProfile';
import { setVeritySettingsError } from '../lib/settingsStore';

/** Pick the row glyph from the label the device reported when it paired. */
function iconForDevice(label: string | null): IconName {
  if (label === null) return 'smartphone';
  if (/ipad|tablet/iu.test(label)) return 'tablet';
  if (/mac|desktop|laptop/iu.test(label)) return 'monitor';
  return 'smartphone';
}

type RenameOutcome = 'submitted' | 'pending' | 'noop';

export default function DevicesScreen() {
  const client = useMemo(() => createVerityClient(), []);
  if (!client) {
    return (
      <SettingsMessage
        title="Not connected"
        subtitle="Configure your Verity server address in setup to manage paired devices."
        screenTitle="Devices"
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
  } | null>(null);
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

  const createInvitation = (): void => {
    const profile = getServerProfile();
    const direct =
      profile?.endpoints.find(
        (endpoint) =>
          endpoint.url === profile.activeUrl && endpoint.transport === 'direct' && endpoint.tlsPin,
      ) ??
      profile?.endpoints.find((endpoint) => endpoint.transport === 'direct' && endpoint.tlsPin);
    if (profile === null || profile === undefined || direct?.tlsPin === undefined) {
      setVeritySettingsError('A directly paired server profile is required to add another device.');
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
          link: createPairingUri({
            version: 1,
            kind: 'device',
            serverId: profile.serverId,
            identityKey: profile.identityKey,
            tlsPin: direct.tlsPin!,
            pairingCode: invitation.code,
            suggestedUrl: direct.url,
            expiresAt: invitation.expiresAt,
          }),
          expiresAt,
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

  return (
    <SettingsScaffold title="Devices" detail onRetry={load}>
      <SettingsGroup
        title="Add a device"
        description="Pair another phone, tablet, or the iPad app on a Mac. Each device receives its own revocable access token."
      >
        <SettingsPanel>
          {pairingInvitation ? (
            <>
              <View style={styles.qrFrame}>
                <QRCode
                  value={pairingInvitation.link}
                  size={220}
                  backgroundColor="#ffffff"
                  color="#000000"
                />
              </View>
              <Text style={styles.footnote}>
                This code expires after five minutes and works once.
              </Text>
              <Pressable
                style={({ pressed }) => [styles.reproButton, pressed ? styles.pressed : null]}
                onPress={() => void Clipboard.setStringAsync(pairingInvitation.link)}
                accessibilityRole="button"
                accessibilityLabel="Copy pairing link"
              >
                <Text style={styles.reproButtonLabel}>Copy pairing link</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              styles.selfStart,
              working ? styles.buttonDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={createInvitation}
            disabled={working}
            accessibilityRole="button"
            accessibilityState={{ disabled: working }}
            accessibilityLabel="Pair another device"
          >
            {working ? <ActivityIndicator size="small" color={theme.colors.onPrimary} /> : null}
            <Text style={styles.primaryButtonLabel}>
              {pairingInvitation ? 'Create a new code' : 'Pair another device'}
            </Text>
          </Pressable>
        </SettingsPanel>
      </SettingsGroup>

      <SettingsGroup
        title="Paired devices"
        description="A device is named by the platform it paired from, so several can arrive with the same name. Tap a name to change it."
      >
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
  return (
    <View style={styles.navRow}>
      <View style={styles.navRowIcon}>
        <Icon name={iconForDevice(device.label)} size={18} color={theme.colors.primary} />
      </View>
      <View style={styles.navRowBody}>
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
        {activity !== undefined ? <Text style={styles.navRowSubtitle}>{activity}</Text> : null}
      </View>
      <View style={styles.navRowTrailing}>
        {device.isCurrent ? (
          <StatusPill quiet intent="ready" label="This device" />
        ) : (
          <Pressable
            style={({ pressed }) => [styles.dangerButton, pressed ? styles.pressed : null]}
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${device.label ?? 'paired device'}`}
          >
            <Text style={styles.dangerButtonLabel}>Remove</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
