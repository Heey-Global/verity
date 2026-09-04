// The first-run entry point explains how to install Verity, then pairs through the
// installer's QR or copyable pairing code. Manual addresses remain a recovery
// control for an already-paired server, where its pinned identity can be verified.
import { normalizeServerUrl, resumeStep, type OnboardingStatus } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
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
import { getVerityBaseUrl } from '../../lib/client';
import { parsePairingUri, type VerityPairingPayload } from '../../lib/pairing';
import { establishPairing, verifyAndSaveDirectEndpoint } from '../../lib/pairingSession';

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
  const [scannerOpen, setScannerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const mounted = useRef(true);
  const pairingInFlight = useRef(false);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const canSubmit = url.trim().length > 0 && test.kind !== 'testing';

  const runTest = () => {
    if (!canSubmit) return;
    // Normalize via the single shared normalizer (scheme default + trailing-slash
    // strip) so the probe hits exactly what will be persisted. `null` only for an
    // empty input, already excluded by `canSubmit`.
    const probeUrl = normalizeServerUrl(url);
    if (probeUrl === null) return;
    setTest({ kind: 'testing' });
    void verifyAndSaveDirectEndpoint(probeUrl)
      .then((status) => {
        if (!mounted.current) return;
        setTest({ kind: 'ok' });
        router.replace('/');
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

  const openScanner = () => {
    void (async () => {
      const permission =
        cameraPermission?.granted === true ? cameraPermission : await requestCameraPermission();
      if (!mounted.current) return;
      if (permission.granted) setScannerOpen(true);
      else
        setTest({
          kind: 'error',
          message: 'Camera access is required to scan the installer pairing code.',
        });
    })();
  };

  const connectPairing = (pairing: VerityPairingPayload) => {
    if (pairingInFlight.current) return;
    pairingInFlight.current = true;
    setScannerOpen(false);
    setTest({ kind: 'testing' });
    void establishPairing(pairing, pairing.suggestedUrl)
      .then((status) => {
        if (!mounted.current) return;
        setTest({ kind: 'ok' });
        const target = onboardingRoute(status);
        if (status.masterPasswordSet && getAuthToken(pairing.suggestedUrl) === null)
          router.replace(unlockRoute(target));
        else router.replace(target);
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        pairingInFlight.current = false;
        setTest({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not pair with this server.',
        });
      });
  };

  const pastePairingCode = () => {
    void Clipboard.getStringAsync()
      .then((value) => {
        if (!mounted.current) return;
        connectPairing(parsePairingUri(value));
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setTest({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Invalid pairing code.',
        });
      });
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.eyebrow}>{isReconfigure ? 'Verity connection' : 'Secure pairing'}</Text>
        <Text style={styles.title} accessibilityRole="header">
          {isReconfigure ? 'Change server address' : 'Connect your server'}
        </Text>
        <Text style={styles.lead}>
          {isReconfigure
            ? 'Enter another address for your paired Verity server. Its identity will be verified before the address is saved.'
            : 'Verity runs on your own Linux server. Install it there first; the installer will show a QR code that securely connects this app.'}
        </Text>

        {!isReconfigure ? (
          <>
            <View style={[styles.card, styles.infoCard]}>
              <Text style={styles.stepLabel}>Step 1</Text>
              <Text style={styles.cardTitle}>Install Verity on your server</Text>
              <Text style={styles.hint}>Run this on an x86-64 Linux host with Docker:</Text>
              <View style={styles.commandRow}>
                <Text style={styles.command} selectable>
                  curl -fsSL https://verity.build/install.sh | bash
                </Text>
                <Pressable
                  style={({ pressed }) => [styles.copyButton, pressed ? styles.pressed : null]}
                  onPress={() =>
                    void Clipboard.setStringAsync(
                      'curl -fsSL https://verity.build/install.sh | bash',
                    ).then(() => setCopied(true))
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Copy install command"
                >
                  <Text style={styles.copyButtonLabel}>{copied ? 'Copied' : 'Copy'}</Text>
                </Pressable>
              </View>
              <Text style={styles.hint}>
                The installer finishes by showing a QR code and a copyable pairing code.
              </Text>
            </View>

            <View style={[styles.card, styles.actionCard]}>
              <Text style={styles.stepLabel}>Step 2</Text>
              <Text style={styles.cardTitle}>Pair this device</Text>
              <Text style={styles.hint}>
                Keep the installer QR code visible, then scan it with this device.
              </Text>

              {test.kind === 'error' ? (
                <Text style={styles.error} accessibilityRole="alert">
                  {test.message}
                </Text>
              ) : null}

              <Pressable
                style={({ pressed }) => [
                  styles.primaryButton,
                  testing ? styles.buttonDisabled : null,
                  pressed ? styles.pressed : null,
                ]}
                onPress={openScanner}
                disabled={testing}
                accessibilityRole="button"
                accessibilityLabel="Scan QR code"
              >
                {testing ? (
                  <ActivityIndicator size="small" color={theme.colors.background} />
                ) : null}
                <Text style={styles.primaryButtonLabel}>
                  {testing ? 'Connecting…' : 'Scan QR code'}
                </Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.cancel, pressed ? styles.pressed : null]}
                onPress={pastePairingCode}
                accessibilityRole="button"
                accessibilityLabel="Paste pairing code"
              >
                <Text style={styles.cancelLabel}>Paste pairing code instead</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <View style={styles.card}>
            <>
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
                {testing ? (
                  <ActivityIndicator size="small" color={theme.colors.background} />
                ) : null}
                <Text style={styles.primaryButtonLabel}>
                  {testing ? 'Connecting…' : 'Test connection'}
                </Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.cancel, pressed ? styles.pressed : null]}
                onPress={() => router.back()}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.cancelLabel}>Cancel</Text>
              </Pressable>
            </>
          </View>
        )}
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
                connectPairing(parsePairingUri(data));
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
  infoCard: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  actionCard: {
    borderColor: theme.colors.accent,
  },
  stepLabel: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  cardTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '800',
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
  commandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  command: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  copyButton: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
  },
  copyButtonLabel: {
    color: theme.colors.accent,
    fontSize: theme.text.sm,
    fontWeight: '800',
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
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
