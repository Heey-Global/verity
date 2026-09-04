// Onboarding step 0: server URL (#320). The FIRST step — a distributable Verity
// build ships without a hardcoded server, so the operator enters the control-plane
// address here (a LAN IP or Tailscale name). The address is validated with a live
// GET /onboarding/status, persisted on the device, and only THEN does the wizard
// advance — the app can't do anything useful without a reachable server.
//
// Advance is gated on a successful connection test: a bad address must not be
// persisted and must not let the operator move on to a dead flow.
import {
  VerityClient,
  normalizeServerUrl,
  resumeStep,
  type OnboardingStatus,
} from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getAuthToken } from '../../lib/authToken';
import { getVerityBaseUrl, setVerityBaseUrl } from '../../lib/client';
import { parsePairingUri, type VerityPairingPayload } from '../../lib/pairing';
import { establishPairing, verifyAndSaveDirectEndpoint } from '../../lib/pairingSession';
import { getServerProfile } from '../../lib/serverProfile';

function onboardingRoute(status: OnboardingStatus): string {
  return status.complete ? '/' : `/onboarding/${resumeStep(status)}`;
}

function unlockRoute(returnTo: string): string {
  return `/unlock-device?returnTo=${encodeURIComponent(returnTo)}`;
}

type TestState =
  { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; message: string };

export default function OnboardingServerUrl() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  // `reconfigure` = launched from Settings to fix/change an already-saved address
  // (the recovery path for a wrong/unreachable URL), NOT the first-run wizard step.
  // On success we return home instead of advancing into the wizard, and we offer a
  // Cancel so an accidental entry isn't a trap.
  const { reconfigure } = useLocalSearchParams<{ reconfigure?: string }>();
  const isReconfigure = reconfigure === '1';
  // Prefill with the current base URL (env default or a previously-set value) so a
  // reconfigure starts from the existing address rather than a blank field.
  const [url, setUrl] = useState(getVerityBaseUrl() ?? '');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [pairing, setPairing] = useState<VerityPairingPayload | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const canSubmit = url.trim().length > 0 && test.kind !== 'testing';

  const loadPairingCode = (raw: string) => {
    const parsed = parsePairingUri(raw);
    setPairing(parsed);
    setUrl(parsed.suggestedUrl);
    setTest({ kind: 'idle' });
  };

  const runTest = () => {
    if (!canSubmit) return;
    // Normalize via the single shared normalizer (scheme default + trailing-slash
    // strip) so the probe hits exactly what will be persisted. `null` only for an
    // empty input, already excluded by `canSubmit`.
    const probeUrl = normalizeServerUrl(url);
    if (probeUrl === null) return;
    setTest({ kind: 'testing' });
    // QR pairing uses the native pinned transport for every request. A manually
    // entered public/Uplink endpoint uses the platform trust store.
    const existingProfile = getServerProfile();
    const statusPromise = pairing
      ? establishPairing(pairing, probeUrl)
      : existingProfile
        ? verifyAndSaveDirectEndpoint(probeUrl)
        : new VerityClient({ baseUrl: probeUrl }).fetchOnboardingStatus();
    void statusPromise
      .then((status) => {
        // Reachable AND it parsed as a Verity onboarding-status payload → persist
        // the normalized URL, then advance. (`setVerityBaseUrl` re-normalizes; same
        // input → same result.)
        return pairing || existingProfile ? status : setVerityBaseUrl(probeUrl).then(() => status);
      })
      .then((status) => {
        if (!mounted.current) return;
        setTest({ kind: 'ok' });
        // Reconfigure (from Settings) → back home. First-run/preflight → route
        // from the server's actual setup state, so an interrupted onboarding flow
        // resumes at the first incomplete step instead of falling through to home.
        const target = onboardingRoute(status);
        if (isReconfigure) {
          router.replace('/');
        } else if (status.masterPasswordSet && getAuthToken(probeUrl) === null) {
          router.replace(unlockRoute(target));
        } else {
          router.replace(target);
        }
      })
      .catch((caught: unknown) => {
        if (!mounted.current) return;
        // Distinguish "couldn't reach it at all" from "reached something that isn't
        // a Verity server" (a non-2xx or a schema-parse failure lands here too).
        const message =
          caught instanceof TypeError
            ? 'Could not reach that address. Check the URL and that the server is running.'
            : 'Reached the address, but it does not look like a Verity API server. Use the API port, not the Metro port.';
        setTest({ kind: 'error', message });
      });
  };

  const testing = test.kind === 'testing';

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.eyebrow}>Verity connection</Text>
        <Text style={styles.title} accessibilityRole="header">
          Connect your server
        </Text>
        <Text style={styles.lead}>
          Enter the Verity server this device should control. If it is already set up, you will
          unlock this device next. If it is fresh, setup starts after the connection succeeds.
        </Text>

        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [styles.scanButton, pressed ? styles.pressed : null]}
            onPress={() => {
              void (async () => {
                const permission =
                  cameraPermission?.granted === true
                    ? cameraPermission
                    : await requestCameraPermission();
                if (!mounted.current) return;
                if (permission.granted) setScannerOpen(true);
                else
                  setTest({
                    kind: 'error',
                    message: 'Camera access is required to scan the installer pairing code.',
                  });
              })();
            }}
            accessibilityRole="button"
            accessibilityLabel="Scan secure pairing code"
          >
            <Text style={styles.scanButtonLabel}>Scan secure pairing code</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.scanButton, pressed ? styles.pressed : null]}
            onPress={() => {
              void Clipboard.getStringAsync()
                .then((code) => {
                  if (!mounted.current) return;
                  loadPairingCode(code);
                })
                .catch((error: unknown) => {
                  if (!mounted.current) return;
                  setTest({
                    kind: 'error',
                    message:
                      error instanceof Error ? error.message : 'Invalid secure pairing code.',
                  });
                });
            }}
            accessibilityRole="button"
            accessibilityLabel="Paste secure pairing code"
          >
            <Text style={styles.scanButtonLabel}>Paste secure pairing code</Text>
          </Pressable>

          {pairing !== null ? (
            <Text style={styles.connected} accessibilityRole="alert">
              Pairing code loaded. You may adjust the address; Verity will still verify the same
              server identity.
            </Text>
          ) : null}
          <View style={styles.field}>
            <Text style={styles.label}>Verity server address</Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={(next) => {
                setUrl(next);
                // Editing invalidates a prior test result.
                if (test.kind !== 'idle') setTest({ kind: 'idle' });
              }}
              placeholder="verity.tailnet.ts.net:8082"
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="url"
              inputMode="url"
              returnKeyType="go"
              onSubmitEditing={runTest}
              accessibilityLabel="Server address"
            />
          </View>

          {test.kind === 'error' ? (
            <Text style={styles.error} accessibilityRole="alert">
              {test.message}
            </Text>
          ) : null}

          {test.kind === 'ok' ? (
            <Text style={styles.connected} accessibilityRole="alert">
              Connected
            </Text>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              !canSubmit ? styles.buttonDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={runTest}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Test connection"
          >
            {testing ? <ActivityIndicator size="small" color={theme.colors.background} /> : null}
            <Text style={styles.primaryButtonLabel}>
              {testing ? 'Testing…' : 'Test connection'}
            </Text>
          </Pressable>

          {isReconfigure ? (
            <Pressable
              style={({ pressed }) => [styles.cancel, pressed ? styles.pressed : null]}
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
      <Modal
        visible={scannerOpen}
        animationType="slide"
        onRequestClose={() => setScannerOpen(false)}
      >
        <View style={styles.scannerRoot}>
          <CameraView
            style={styles.scannerCamera}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              try {
                loadPairingCode(data);
                setScannerOpen(false);
              } catch (error) {
                setScannerOpen(false);
                setTest({
                  kind: 'error',
                  message: error instanceof Error ? error.message : 'Invalid pairing code.',
                });
              }
            }}
          />
          <View style={styles.scannerOverlay} pointerEvents="box-none">
            <Text style={styles.scannerTitle}>Scan the code shown by verity-install</Text>
            <View style={styles.scannerFrame} />
            <Pressable
              style={({ pressed }) => [styles.cancelScanner, pressed ? styles.pressed : null]}
              onPress={() => setScannerOpen(false)}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonLabel}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flexGrow: 1,
    gap: theme.spacing.lg,
    justifyContent: 'flex-start',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 160,
  },
  eyebrow: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.xl,
    fontWeight: '800',
  },
  lead: {
    color: theme.colors.textMuted,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  scanButton: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
  },
  scanButtonLabel: {
    color: theme.colors.accent,
    fontSize: theme.text.sm,
    fontWeight: '800',
  },
  scannerRoot: { flex: 1, backgroundColor: '#000' },
  scannerCamera: { flex: 1 },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 80,
    paddingBottom: 56,
  },
  scannerTitle: {
    color: '#fff',
    fontSize: theme.text.md,
    fontWeight: '800',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
  },
  scannerFrame: {
    width: 260,
    height: 260,
    borderWidth: 3,
    borderColor: theme.colors.accent,
    borderRadius: theme.radius.lg,
  },
  cancelScanner: {
    minWidth: 160,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.accent,
  },
  field: {
    gap: theme.spacing.xs,
  },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  input: {
    minHeight: 48,
    color: theme.colors.text,
    fontSize: theme.text.md,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  error: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  connected: {
    color: theme.colors.tone.done,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  primaryButton: {
    minHeight: 48,
    flexDirection: 'row',
    gap: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  primaryButtonLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  cancel: {
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
  },
  cancelLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.62,
  },
}));
