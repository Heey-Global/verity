// The first-run entry point explains how to install Verity, then pairs through the
// installer's QR or copyable pairing code. Manual addresses remain a recovery
// control for an already-paired server, where its pinned identity can be verified.
import {
  isCoreOnboardingComplete,
  normalizeServerUrl,
  resumeStep,
  type OnboardingStatus,
} from '@verity/mobile';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Updates from 'expo-updates';
import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getAuthToken } from '../../lib/authToken';
import { getVerityBaseUrl } from '../../lib/client';
import { KEYBOARD_BOTTOM_OFFSET } from '../../lib/keyboardOffsets';
import { parsePairingUri, type VerityPairingPayload } from '../../lib/pairing';
import { establishPairing, verifyAndSaveDirectEndpoint } from '../../lib/pairingSession';
import { describeBuild, runningReleaseVersion } from '../../lib/buildInfo';
import { Button } from '../../components/ui';

function onboardingRoute(status: OnboardingStatus): string {
  return isCoreOnboardingComplete(status) ? '/' : `/onboarding/${resumeStep(status)}`;
}

function unlockRoute(returnTo: string): string {
  return `/unlock-device?returnTo=${encodeURIComponent(returnTo)}`;
}

function secureDeviceRoute(returnTo: string): string {
  return `/secure-device?returnTo=${encodeURIComponent(returnTo)}`;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string; technicalDetails?: string };

function safeDiagnosticText(value: unknown, sensitiveValues: string[] = []): string | undefined {
  const text = Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').join('\n')
    : value;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const withoutKnownSecrets = sensitiveValues
    .filter((secret) => secret.length > 0)
    .reduce((sanitized, secret) => sanitized.split(secret).join('[redacted]'), text);
  return withoutKnownSecrets
    .replace(/\bhttps?:\/\/[^\s)]+/gi, (raw) => {
      try {
        const parsed = new URL(raw.replace(/[.,;:]$/, ''));
        return `${parsed.protocol}//${parsed.host}/[path redacted]`;
      } catch {
        return '[URL redacted]';
      }
    })
    .replace(/\bverity(?:-pair)?:\/\/[^\s)]+/gi, '[pairing URI redacted]')
    .replace(
      /"(authorization|cookie|set-cookie|x-api-key|[a-z0-9_-]*(?:token|secret|code)[a-z0-9_-]*)"\s*:\s*"(?:\\.|[^"\\])*"/gi,
      '"$1":"[redacted]"',
    )
    .replace(
      /'(authorization|cookie|set-cookie|x-api-key|[a-z0-9_-]*(?:token|secret|code)[a-z0-9_-]*)'\s*:\s*'(?:\\.|[^'\\])*'/gi,
      "'$1':'[redacted]'",
    )
    .replace(/\b(authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\n]+/gi, '$1: [redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(
      /\b([a-z0-9_-]*(?:token|secret|code)[a-z0-9_-]*)\s*[:=]\s*[^\s,;]+/gi,
      '$1: [redacted]',
    )
    .replace(/\/(?:Users|home|var|private|tmp)\/[^\s:)]+/g, '/[path redacted]')
    .replace(/\s*\(at ExpoModulesCore\/[^)]*\)\.?$/i, '')
    .slice(0, 2_000);
}

function pairingTechnicalDetails(error: unknown, pairing: VerityPairingPayload): string {
  const nativeError =
    typeof error === 'object' && error !== null
      ? (error as Partial<Error> & { code?: unknown; nativeStackIOS?: unknown })
      : {};
  return JSON.stringify(
    {
      release: runningReleaseVersion(Application.nativeApplicationVersion),
      nativeVersion: Application.nativeApplicationVersion ?? 'unknown',
      nativeBuild: Application.nativeBuildVersion ?? 'unknown',
      bundleCommit: describeBuild().text,
      runtimeVersion: Updates.runtimeVersion ?? 'unknown',
      updateId: Updates.updateId ?? (Updates.isEmbeddedLaunch ? 'embedded' : 'unknown'),
      platform: Platform.OS,
      osVersion: String(Platform.Version),
      serverOrigin: new URL(pairing.suggestedUrl).origin,
      serverId: pairing.serverId,
      tlsPin: `${pairing.tlsPin.slice(0, 18)}…`,
      errorName: safeDiagnosticText(nativeError.name) ?? typeof error,
      errorCode: safeDiagnosticText(nativeError.code) ?? 'unknown',
      errorMessage:
        safeDiagnosticText(nativeError.message ?? String(error), [
          pairing.pairingCode,
          pairing.identityKey,
        ]) ?? 'unknown',
      nativeStack:
        safeDiagnosticText(nativeError.nativeStackIOS, [
          pairing.pairingCode,
          pairing.identityKey,
        ]) ?? 'unavailable',
    },
    null,
    2,
  );
}

function pairingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const pinnedFailure = /Pinned TLS verification failed \[([^\]]+)\]/i.exec(message)?.[1];
  if (pinnedFailure !== undefined) {
    return `Could not establish a secure connection to this server. TLS diagnostic: ${pinnedFailure}`;
  }
  if (/TLS|SSL|certificate|secure connection/i.test(message)) {
    return 'Could not establish a secure connection to this server. Open technical details below for the TLS diagnostic.';
  }
  if (/timed?\s*out|timeout|network request failed|could not connect/i.test(message)) {
    return 'Could not reach the server address in this pairing code. Make sure this phone can reach the selected IP address or DNS name, then create a new pairing code.';
  }
  return error instanceof Error ? error.message : 'Could not pair with this server.';
}

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
  const [detailsVisible, setDetailsVisible] = useState(false);
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
    setDetailsVisible(false);
    setScannerOpen(false);
    setTest({ kind: 'testing' });
    void establishPairing(pairing, pairing.suggestedUrl)
      .then((status) => {
        if (!mounted.current) return;
        setTest({ kind: 'ok' });
        const target = onboardingRoute(status);
        if (status.masterPasswordSet && getAuthToken(pairing.suggestedUrl) === null) {
          router.replace(unlockRoute(target));
          return;
        }
        // Pairing into an already-configured server skips the wizard entirely, and
        // with it the only Face ID opt-in this app offers. Ask here instead, or the
        // device reaches its next cold start with no way to unlock itself. A device
        // still heading into the wizard gets asked by its master-password step.
        if (isCoreOnboardingComplete(status)) {
          router.replace(secureDeviceRoute(target));
          return;
        }
        router.replace(target);
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        pairingInFlight.current = false;
        setTest({
          kind: 'error',
          message: pairingErrorMessage(error),
          technicalDetails: pairingTechnicalDetails(error, pairing),
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
    <View style={styles.root}>
      {/*
        The address and pairing-code fields sit well down the page, so padding
        the frame is not enough — the scroll view has to bring the focused one
        up itself. Scrolling also covers the manual-address field that only
        appears on the reconfigure path, below the fold on a phone.
      */}
      <KeyboardAwareScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24 }]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={KEYBOARD_BOTTOM_OFFSET}
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
              <Text style={styles.hint}>Run this on your Linux machine with Docker installed:</Text>
              <View style={styles.commandRow}>
                <Text style={styles.command} selectable>
                  curl -fsSL https://verity.build/install.sh | bash
                </Text>
                <Button
                  label={copied ? 'Copied' : 'Copy'}
                  accessibilityLabel="Copy install command"
                  icon={copied ? 'check' : 'copy'}
                  variant="secondary"
                  size="compact"
                  onPress={() =>
                    void Clipboard.setStringAsync(
                      'curl -fsSL https://verity.build/install.sh | bash',
                    ).then(() => setCopied(true))
                  }
                />
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
                <>
                  <Text style={styles.error} accessibilityRole="alert">
                    {test.message}
                  </Text>
                  {test.technicalDetails ? (
                    <>
                      <View style={styles.inline}>
                        <Button
                          label={
                            detailsVisible ? 'Hide technical details' : 'Show technical details'
                          }
                          accessibilityLabel="Toggle technical pairing details"
                          variant="text"
                          size="compact"
                          onPress={() => setDetailsVisible((visible) => !visible)}
                        />
                      </View>
                      {detailsVisible ? (
                        <Text selectable style={styles.diagnosticDetails}>
                          {test.technicalDetails}
                        </Text>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}

              <Button
                label="Scan QR code"
                icon="maximize"
                loading={testing}
                onPress={openScanner}
                fullWidth
              />

              <Button
                label="Paste pairing code instead"
                accessibilityLabel="Paste pairing code"
                variant="text"
                onPress={pastePairingCode}
              />
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

              <Button
                label="Test connection"
                loading={testing}
                disabled={!canSubmit}
                onPress={runTest}
                fullWidth
              />

              <Button label="Cancel" variant="text" onPress={() => router.back()} />
            </>
          </View>
        )}
      </KeyboardAwareScrollView>
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
            <Button label="Cancel" variant="secondary" onPress={() => setScannerOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    gap: theme.spacing.md,
    justifyContent: 'flex-start',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: 160,
  },
  eyebrow: {
    ...theme.typography.label,
    color: theme.colors.text,
  },
  title: {
    ...theme.typography.display,
    color: theme.colors.text,
  },
  lead: {
    ...theme.typography.body,
    color: theme.colors.textMuted,
  },
  card: {
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  infoCard: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  actionCard: {
    borderColor: theme.colors.border,
  },
  stepLabel: {
    ...theme.typography.label,
    color: theme.colors.text,
  },
  cardTitle: {
    ...theme.typography.title,
    color: theme.colors.text,
  },
  // A text button keeps the width of its label instead of spanning the column.
  inline: { flexDirection: 'row' },
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
    ...theme.typography.row,
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
  },
  scannerFrame: {
    width: 260,
    height: 260,
    borderWidth: 3,
    borderColor: '#ffffff',
    borderRadius: theme.radius.lg,
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  command: {
    ...theme.typography.code,
    flex: 1,
    color: theme.colors.text,
  },
  hint: {
    ...theme.typography.subtitle,
    color: theme.colors.textMuted,
  },
  label: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.textMuted,
  },
  input: {
    fontFamily: theme.typography.body.fontFamily,
    fontSize: theme.typography.body.fontSize,
    minHeight: 44,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  error: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.attention,
  },
  diagnosticDetails: {
    ...theme.typography.code,
    color: theme.colors.textMuted,
  },
  connected: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    color: theme.colors.success,
  },
}));
